import 'server-only';

import { getMegaPayTransactionStatus } from '@/lib/megapay';
import type { PaymentAdminClient } from '@/lib/supabase/payment-admin-database';

type PendingDeposit = {
  id: string;
  user_id: string;
  status: string;
  amount_kes: number | string;
  megapay_request_id: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export async function verifyAndSettleMegaPayDeposit(
  admin: PaymentAdminClient,
  transaction: PendingDeposit,
): Promise<{ status: 'pending' | 'completed' | 'declined'; balance?: number }> {
  if (transaction.status !== 'pending') {
    return { status: transaction.status === 'completed' ? 'completed' : 'declined' };
  }
  if (!transaction.megapay_request_id) return { status: 'pending' };

  const result = await getMegaPayTransactionStatus(transaction.megapay_request_id);
  const providerStatus = typeof result.TransactionStatus === 'string'
    ? result.TransactionStatus.trim().toLowerCase()
    : '';

  if (providerStatus === 'completed') {
    const amountKes = numberValue(result.TransactionAmount);
    const transactionCode = result.TransactionCode;
    const providerTransactionId = result.TransactionID;
    const receipt = result.TransactionReceipt;
    const phone = result.Msisdn;
    const reference = result.TransactionReference;
    if (
      amountKes === null ||
      (transactionCode !== '0' && transactionCode !== 0) ||
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
    const { error } = await admin.rpc('marketpilot_payment_mark_deposit_declined', {
      p_transaction_id: transaction.id,
      p_reason: description,
    });
    if (error) throw new Error(`Failed payment could not be recorded: ${error.message}`);
    return { status: 'declined' };
  }

  return { status: 'pending' };
}
