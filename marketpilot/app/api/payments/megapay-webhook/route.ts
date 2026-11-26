import { NextResponse, type NextRequest } from 'next/server';
import { completeMegaPayDeposit } from '@/lib/payments-server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string' && value.trim().length > 0 && value.length <= 200) {
      return value.trim();
    }
  }
  return null;
}

function numberField(record: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = record[name];
    const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function codeField(record: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = record[name];
    if (value === undefined || value === null || value === '') continue;
    const code = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
    if (Number.isInteger(code)) return code;
  }
  return null;
}

function acknowledgement(status: 'received' | 'completed' | 'failed') {
  return NextResponse.json({ status }, { status: 200 });
}

function masked(value: string | null): string | null {
  return value ? `…${value.slice(-6)}` : null;
}

function logCallbackPayload(body: Record<string, unknown>) {
  console.info('MegaPay callback received.', {
    fields: Object.keys(body),
    responseCode: body.ResponseCode ?? body.response_code ?? null,
    transactionStatus: body.TransactionStatus ?? body.transaction_status ?? null,
    transactionReference: masked(stringField(body, ['TransactionReference', 'transaction_reference', 'reference'])),
    requestId: masked(stringField(body, ['transaction_request_id', 'TransactionRequestID', 'MerchantRequestID'])),
    hasReceipt: typeof (body.TransactionReceipt ?? body.MpesaReceiptNumber ?? body.mpesa_receipt_number) === 'string',
    hasPhone: typeof (body.Msisdn ?? body.msisdn) === 'string',
  });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    console.warn('MegaPay callback body was not valid JSON.');
    return acknowledgement('received');
  }
  if (!isRecord(body)) {
    console.warn('MegaPay callback body was not a JSON object.');
    return acknowledgement('received');
  }
  logCallbackPayload(body);

  const reference = stringField(body, ['TransactionReference', 'transaction_reference', 'reference']);
  const requestId = stringField(body, [
    'transaction_request_id',
    'TransactionRequestID',
    'MerchantRequestID',
  ]);
  if (!reference && !requestId) {
    console.warn('MegaPay callback did not contain a matching deposit identifier.');
    return acknowledgement('received');
  }

  try {
    const admin = getSupabaseAdminClient();
    const columns = 'id,user_id,status,transaction_type,amount_kes,megapay_request_id,reference';
    let transaction = null;
    if (reference) {
      const { data, error } = await admin
        .from('marketpilot_transactions')
        .select(columns)
        .eq('reference', reference)
        .maybeSingle();
      if (error) throw new Error(`MegaPay callback deposit lookup failed: ${error.message}`);
      transaction = data;
    }
    if (!transaction && requestId) {
      const { data, error } = await admin
        .from('marketpilot_transactions')
        .select(columns)
        .eq('megapay_request_id', requestId)
        .maybeSingle();
      if (error) throw new Error(`MegaPay callback request lookup failed: ${error.message}`);
      transaction = data;
    }
    if (!transaction || transaction.transaction_type !== 'deposit') {
      console.warn('MegaPay callback did not match a deposit.', {
        reference: masked(reference),
        requestId: masked(requestId),
      });
      return acknowledgement('received');
    }
    if (reference && reference !== transaction.reference) {
      console.warn('MegaPay callback reference did not match its stored deposit.', transaction.id);
      return acknowledgement('received');
    }
    if (transaction.status === 'completed') return acknowledgement('completed');
    if (transaction.status !== 'pending') return acknowledgement('failed');

    const responseCode = codeField(body, ['ResponseCode', 'response_code']);
    const providerStatus = stringField(body, ['TransactionStatus', 'transaction_status'])?.toLowerCase();
    const transactionCode = codeField(body, ['TransactionCode', 'transaction_code']);
    const successful = responseCode === 0 || (providerStatus === 'completed' && transactionCode === 0);

    if (responseCode !== null && responseCode !== 0) {
      const description = stringField(body, ['ResponseDescription', 'response_description'])
        ?? `MegaPay reported an unsuccessful transaction (code ${responseCode}).`;
      const { error } = await admin.rpc('marketpilot_payment_mark_deposit_failed', {
        p_transaction_id: transaction.id,
        p_reason: description,
      });
      if (error) throw new Error(`Failed payment callback could not be recorded: ${error.message}`);
      return acknowledgement('failed');
    }
    if (!successful) return acknowledgement('received');

    const providerTransactionId = stringField(body, ['TransactionID', 'transaction_id']);
    const amountKes = numberField(body, ['TransactionAmount', 'transaction_amount']);
    const phone = stringField(body, ['Msisdn', 'msisdn']);
    const receipt = stringField(body, [
      'TransactionReceipt',
      'MpesaReceiptNumber',
      'mpesa_receipt_number',
      'transaction_receipt',
    ]);
    if (!providerTransactionId || amountKes === null || !phone) {
      console.error('Successful MegaPay callback is missing settlement details.', {
        transactionId: transaction.id,
        fields: Object.keys(body),
      });
      return acknowledgement('received');
    }

    await completeMegaPayDeposit(admin, {
      requestId: transaction.megapay_request_id,
      reference: transaction.reference,
      providerTransactionId,
      receipt,
      amountKes,
      phone,
    });
    return acknowledgement('completed');
  } catch (error) {
    console.error('MegaPay callback could not be settled; status polling will retry.', error);
    return acknowledgement('received');
  }
}
