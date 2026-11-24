import 'server-only';

import { getMegaPayTransactionStatus } from '@/lib/megapay';
import type { PaymentAdminClient } from '@/lib/supabase/payment-admin-database';

type PendingDeposit = {
  id: string;
  user_id: string;
  status: string;
  amount_kes: number | string;
  megapay_request_id: string | null;
  created_at: string;
};

const DEPOSIT_CONFIRMATION_TIMEOUT_MS = 2 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function markDepositFailed(
  admin: PaymentAdminClient,
  transactionId: string,
  reason: string,
): Promise<{ status: 'completed' | 'failed' }> {
  const { error } = await admin.rpc('marketpilot_payment_mark_deposit_failed', {
    p_transaction_id: transactionId,
    p_reason: reason,
  });
  if (error) throw new Error(`Deposit could not be marked failed: ${error.message}`);

  const { data, error: lookupError } = await admin
    .from('marketpilot_transactions')
    .select('status')
    .eq('id', transactionId)
    .maybeSingle();
  if (lookupError) throw new Error(`Deposit status could not be loaded: ${lookupError.message}`);
  if (data?.status === 'completed') return { status: 'completed' };
  if (data?.status !== 'failed') throw new Error('Failed deposit did not reach a final status.');
  return { status: 'failed' };
}

export async function verifyAndSettleMegaPayDeposit(
  admin: PaymentAdminClient,
  transaction: PendingDeposit,
): Promise<{ status: 'pending' | 'completed' | 'failed'; balance?: number }> {
  if (transaction.status !== 'pending') {
    return { status: transaction.status === 'completed' ? 'completed' : 'failed' };
  }
  const createdAt = Date.parse(transaction.created_at);
  if (!Number.isFinite(createdAt)) throw new Error('Deposit creation time is invalid.');
  const timedOut = Date.now() - createdAt >= DEPOSIT_CONFIRMATION_TIMEOUT_MS;
  if (!transaction.megapay_request_id) {
    return timedOut
      ? markDepositFailed(admin, transaction.id, 'Deposit confirmation timed out after two minutes.')
      : { status: 'pending' };
  }

  let result: Awaited<ReturnType<typeof getMegaPayTransactionStatus>>;
  try {
    result = await getMegaPayTransactionStatus(transaction.megapay_request_id);
  } catch (error) {
    if (!timedOut) throw error;
    console.error('Deposit status could not be confirmed before its timeout.', error);
    return markDepositFailed(admin, transaction.id, 'Deposit confirmation timed out after two minutes.');
  }
  const rawStatus = result.TransactionStatus ?? result.transaction_status ?? result.status;
  const providerStatus = typeof rawStatus === 'string'
    ? rawStatus.trim().toLowerCase()
    : '';
  const transactionCode = result.TransactionCode ?? result.transaction_code;

  const hasCompletedStatus = ['completed', 'complete', 'success', 'successful'].includes(providerStatus);
  const hasSuccessfulTransactionCode = transactionCode === '0' || transactionCode === 0;
  const hasTransactionId = typeof (result.TransactionID ?? result.transaction_id) === 'string';
  const isExplicitlyPending = ['pending', 'processing', 'initiated', 'queued', 'in progress'].includes(providerStatus);
  if (
    hasCompletedStatus ||
    (!isExplicitlyPending && hasSuccessfulTransactionCode && hasTransactionId)
  ) {
    const amountKes = numberValue(result.TransactionAmount ?? result.transaction_amount);
    const providerTransactionId = result.TransactionID ?? result.transaction_id;
    const receipt = result.TransactionReceipt ?? result.transaction_receipt;
    const phone = result.Msisdn ?? result.msisdn;
    const reference = result.TransactionReference ?? result.transaction_reference;
    if (
      amountKes === null ||
      (!hasCompletedStatus && !hasSuccessfulTransactionCode) ||
      typeof providerTransactionId !== 'string' ||
      providerTransactionId.trim().length < 1 ||
      providerTransactionId.length > 200 ||
      typeof phone !== 'string' ||
      phone.trim().length < 1 ||
      typeof reference !== 'string' ||
      reference.trim().length < 1
    ) {
      throw new Error('MegaPay completion response is missing verified transaction details.');
    }

    const { data, error } = await admin.rpc('marketpilot_payment_complete_deposit', {
      p_request_id: transaction.megapay_request_id,
      p_provider_transaction_id: providerTransactionId,
      p_receipt: typeof receipt === 'string' ? receipt : null,
      p_amount_kes: amountKes,
      p_msisdn: phone,
      p_reference: reference,
    });
    if (error) throw new Error(`Deposit could not be credited: ${error.message}`);
    if (!isRecord(data) || data.status !== 'completed') {
      throw new Error('Deposit settlement returned an invalid result.');
    }
    const balance = numberValue(data.balance);
    return balance === null
      ? { status: 'completed' }
      : { status: 'completed', balance };
  }

  if (['failed', 'cancelled', 'canceled', 'declined', 'expired'].includes(providerStatus)) {
    const description = typeof result.ResultDesc === 'string'
      ? result.ResultDesc
      : `MegaPay marked this payment ${providerStatus}.`;
    return markDepositFailed(admin, transaction.id, description);
  }

  return timedOut
    ? markDepositFailed(admin, transaction.id, 'Deposit confirmation timed out after two minutes.')
    : { status: 'pending' };
}
