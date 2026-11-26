import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid MegaPay callback.' }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'Invalid payment callback.' }, { status: 400 });
  }
  const reference = body.TransactionReference;
  if (typeof reference !== 'string' || reference.length < 1 || reference.length > 200) {
    return NextResponse.json({ error: 'Callback transaction reference is missing.' }, { status: 400 });
  }

  const admin = getSupabaseAdminClient();
  const { data: transaction, error } = await admin
    .from('marketpilot_transactions')
    .select('id,user_id,status,transaction_type,amount_kes,megapay_request_id,reference,created_at')
    .eq('reference', reference)
    .maybeSingle();
  if (error) {
    console.error('MegaPay callback deposit lookup failed.', error.message);
    return NextResponse.json({ error: 'Callback could not be processed.' }, { status: 503 });
  }
  if (!transaction || transaction.transaction_type !== 'deposit') {
    return NextResponse.json({ error: 'Deposit was not found.' }, { status: 404 });
  }
  if (transaction.status === 'completed') {
    return NextResponse.json({ status: 'completed' });
  }
  if (transaction.status !== 'pending') {
    return NextResponse.json({ status: transaction.status });
  }
  if (!transaction.megapay_request_id) {
    console.error('Payment callback arrived before its request reference was saved.', transaction.id);
    return NextResponse.json({ error: 'Payment callback is being retried.' }, { status: 503 });
  }

  const rawResponseCode = body.ResponseCode;
  const responseCode = typeof rawResponseCode === 'number' && Number.isInteger(rawResponseCode)
    ? rawResponseCode
    : typeof rawResponseCode === 'string' && /^-?\d+$/.test(rawResponseCode.trim())
      ? Number(rawResponseCode)
      : null;
  if (responseCode === null) {
    return NextResponse.json({ error: 'Callback response code is missing or invalid.' }, { status: 400 });
  }
  if (responseCode !== 0) {
    const description = typeof body.ResponseDescription === 'string'
      ? body.ResponseDescription
      : `The payment provider reported an unsuccessful transaction (code ${responseCode}).`;
    const { error: declineError } = await admin.rpc('marketpilot_payment_mark_deposit_failed', {
      p_transaction_id: transaction.id,
      p_reason: description,
    });
    if (declineError) {
      console.error('Failed payment callback could not be recorded.', declineError.message);
      return NextResponse.json({ error: 'Payment callback could not be processed.' }, { status: 503 });
    }
    return NextResponse.json({ status: 'failed' });
  }

  const transactionId = body.TransactionID;
  const amountKesValue = body.TransactionAmount;
  const amountKes = typeof amountKesValue === 'number' || typeof amountKesValue === 'string'
    ? Number(amountKesValue)
    : NaN;
  const phone = body.Msisdn;
  if (
    typeof transactionId !== 'string' ||
    transactionId.length < 1 ||
    transactionId.length > 200 ||
    !Number.isFinite(amountKes) ||
    typeof phone !== 'string' ||
    phone.length < 1
  ) {
    console.error('Successful payment callback is missing transaction details.', transaction.id);
    return NextResponse.json({ error: 'Payment callback is missing transaction details.' }, { status: 400 });
  }

  const receipt = body.TransactionReceipt;
  if (receipt !== undefined && receipt !== null && typeof receipt !== 'string') {
    return NextResponse.json({ error: 'Payment callback receipt is invalid.' }, { status: 400 });
  }

  const { data: settlement, error: settlementError } = await admin.rpc('marketpilot_payment_complete_deposit', {
    p_request_id: transaction.megapay_request_id,
    p_provider_transaction_id: transactionId,
    p_receipt: typeof receipt === 'string' ? receipt : null,
    p_amount_kes: amountKes,
    p_msisdn: phone,
    p_reference: reference,
  });
  if (settlementError) {
    console.error('Payment callback settlement failed.', settlementError.message);
    return NextResponse.json({ error: 'Payment callback could not be verified.' }, { status: 503 });
  }
  if (!isRecord(settlement) || settlement.status !== 'completed') {
    console.error('Payment callback settlement returned an invalid result.', transaction.id);
    return NextResponse.json({ error: 'Payment callback settlement was invalid.' }, { status: 503 });
  }

  return NextResponse.json({ status: 'completed' });
}
