import { NextResponse, type NextRequest } from 'next/server';
import { verifyAndSettleMegaPayDeposit } from '@/lib/payments-server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'This payment request is not allowed.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'A valid transaction ID is required.' }, { status: 400 });
  }
  const transactionId = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).transactionId
    : null;
  if (typeof transactionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(transactionId)) {
    return NextResponse.json({ error: 'A valid transaction ID is required.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) return NextResponse.json({ error: 'Sign in to check this payment.' }, { status: 401 });

  const admin = getSupabaseAdminClient();
  const { data: transaction, error: transactionError } = await admin
    .from('marketpilot_transactions')
    .select('id,user_id,status,transaction_type,amount_kes,megapay_request_id')
    .eq('id', transactionId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (transactionError) {
    console.error('MarketPilot payment lookup failed.', transactionError.message);
    return NextResponse.json({ error: 'Payment status is temporarily unavailable.' }, { status: 503 });
  }
  if (!transaction || transaction.transaction_type !== 'deposit') {
    return NextResponse.json({ error: 'Deposit was not found.' }, { status: 404 });
  }

  try {
    const result = await verifyAndSettleMegaPayDeposit(admin, transaction);
    if (result.status !== 'completed') return NextResponse.json(result);
    let balance = result.balance;
    if (balance === undefined) {
      const { data: wallet, error: walletError } = await admin
        .from('marketpilot_wallets')
        .select('balance')
        .eq('user_id', user.id)
        .eq('account_type', 'real')
        .maybeSingle();
      if (walletError) throw new Error(`Real wallet balance could not be loaded: ${walletError.message}`);
      const parsedBalance = wallet ? Number(wallet.balance) : NaN;
      if (!Number.isFinite(parsedBalance) || parsedBalance < 0) {
        throw new Error('Real wallet balance returned an invalid value.');
      }
      balance = parsedBalance;
    }
    return NextResponse.json({ ...result, ...(balance === undefined ? {} : { balance }) });
  } catch (error) {
    console.error('MegaPay payment verification failed.', error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Payment verification is temporarily unavailable.',
    }, { status: 502 });
  }
}
