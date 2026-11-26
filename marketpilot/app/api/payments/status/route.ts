import { NextResponse, type NextRequest } from 'next/server';
import { verifyAndSettleMegaPayDeposit } from '@/lib/payments-server';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  let transactionId: string | null = null;
  try {
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
    const parsedTransactionId = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).transactionId
      : null;
    if (typeof parsedTransactionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsedTransactionId)) {
      return NextResponse.json({ error: 'A valid transaction ID is required.' }, { status: 400 });
    }
    transactionId = parsedTransactionId;

    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) return NextResponse.json({ error: 'Sign in to check this payment.' }, { status: 401 });

    const admin = getSupabaseAdminClient();
    const { data: transaction, error: transactionError } = await admin
      .from('marketpilot_transactions')
      .select('id,user_id,status,transaction_type,amount_kes,amount_usd,megapay_request_id,reference,created_at')
      .eq('id', transactionId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (transactionError) {
      console.error('MarketPilot payment lookup failed.', transactionError.message);
      if (transactionError.code === '42501') {
        return NextResponse.json({
          error: 'Supabase is missing server read access for payment transactions. Apply the MarketPilot payment service-role read-grants migration.',
        }, { status: 503 });
      }
      return NextResponse.json({ error: 'Payment status is temporarily unavailable.' }, { status: 503 });
    }
    if (!transaction || transaction.transaction_type !== 'deposit') {
      return NextResponse.json({ error: 'Deposit was not found.' }, { status: 404 });
    }

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
    return NextResponse.json({
      ...result,
      amountUsd: Number(transaction.amount_usd),
      ...(balance === undefined ? {} : { balance }),
    });
  } catch (error) {
    console.error('Deposit status route failed.', { transactionId, error });
    const configurationError = error instanceof Error && (
      error.message === 'SUPABASE_URL is missing from this deployment environment.' ||
      error.message === 'Set SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY for server-side Supabase services.'
    );
    return NextResponse.json(
      {
        error: configurationError && error instanceof Error
          ? error.message
          : 'Deposit confirmation is temporarily unavailable. The app will retry automatically.',
      },
      { status: 503 },
    );
  }
}
