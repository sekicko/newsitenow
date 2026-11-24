import { NextResponse, type NextRequest } from 'next/server';
import { verifyAndSettleMegaPayDeposit } from '@/lib/payments-server';
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
  const reference = isRecord(body) ? body.TransactionReference : null;
  if (typeof reference !== 'string' || reference.length > 200) {
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
  try {
    const result = await verifyAndSettleMegaPayDeposit(admin, transaction);
    return NextResponse.json({ status: result.status });
  } catch (verificationError) {
    console.error('MegaPay callback verification failed.', verificationError);
    return NextResponse.json({ error: 'Callback verification failed.' }, { status: 503 });
  }
}
