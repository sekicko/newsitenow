import { NextResponse, type NextRequest } from 'next/server';
import { getDerivTickHistory } from '@/lib/deriv-market-server';
import { getMarketPilotTickDigit, VOLATILITY_SYMBOLS, type MarketTick } from '@/lib/market-data';
import { isSameOriginRequest } from '@/lib/request-origin';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'This trade request is not allowed.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'A valid trade ID is required.' }, { status: 400 });
  }
  const tradeId = isRecord(body) ? body.tradeId : null;
  if (typeof tradeId !== 'string' || tradeId.length < 1 || tradeId.length > 100) {
    return NextResponse.json({ error: 'A valid trade ID is required.' }, { status: 400 });
  }
  const requestedSymbol = isRecord(body) && typeof body.symbol === 'string'
    ? VOLATILITY_SYMBOLS.find(({ symbol }) => symbol === body.symbol)
    : undefined;
  const requestedEntryEpoch = finiteNumber(isRecord(body) ? body.entryEpoch : null);

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Sign in to settle this Real wallet trade.' }, { status: 401 });
  }
  if (!requestedSymbol || requestedEntryEpoch === null || !Number.isInteger(requestedEntryEpoch)) {
    return NextResponse.json({ error: 'The saved trade symbol and entry tick are required.' }, { status: 400 });
  }

  try {
    const admin = getSupabaseAdminClient();
    const tickHistoryPromise = getDerivTickHistory(
      requestedSymbol.symbol,
      { count: 1_000, start: requestedEntryEpoch },
    ).then(
      (ticks) => ({ ticks }),
      (error: unknown) => ({ error }),
    );
    const { data: trade, error: tradeError } = await admin
      .from('marketpilot_practice_trades')
      .select('symbol, duration, entry_price, entry_pip_size, entry_epoch, status, exit_price, exit_pip_size, exit_digit, exit_epoch, payout, profit, outcome_source')
      .eq('user_id', user.id)
      .eq('id', tradeId)
      .eq('account_type', 'real')
      .maybeSingle();
    if (tradeError) throw tradeError;
    if (!trade) return NextResponse.json({ error: 'This Real wallet trade was not found.' }, { status: 404 });

    if (trade.status !== 'open') {
      const { data: wallet, error: walletError } = await admin
        .from('marketpilot_wallets')
        .select('balance')
        .eq('user_id', user.id)
        .eq('account_type', 'real')
        .maybeSingle();
      if (walletError) throw walletError;
      const balance = finiteNumber(wallet?.balance);
      if (balance === null) throw new Error('The Real wallet balance is unavailable.');
      return NextResponse.json({
        status: trade.status,
        balance,
        payout: finiteNumber(trade.payout) ?? 0,
        profit: finiteNumber(trade.profit) ?? 0,
        exitPrice: finiteNumber(trade.exit_price),
        exitPipSize: finiteNumber(trade.exit_pip_size),
        exitDigit: finiteNumber(trade.exit_digit),
        exitEpoch: finiteNumber(trade.exit_epoch),
        outcomeSource: trade.outcome_source,
      });
    }

    const entryPrice = finiteNumber(trade.entry_price);
    const entryPipSize = finiteNumber(trade.entry_pip_size);
    const entryEpoch = finiteNumber(trade.entry_epoch);
    const duration = finiteNumber(trade.duration);
    if (
      typeof trade.symbol !== 'string' ||
      entryPrice === null ||
      entryPipSize === null ||
      entryEpoch === null ||
      duration === null ||
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 30
    ) {
      throw new Error('The saved Real trade has invalid entry details.');
    }
    if (trade.symbol !== requestedSymbol.symbol || entryEpoch !== requestedEntryEpoch) {
      return NextResponse.json({ error: 'The submitted trade entry does not match the saved trade.' }, { status: 409 });
    }
    const tickHistory = await tickHistoryPromise;
    if ('error' in tickHistory) throw tickHistory.error;
    const { ticks } = tickHistory;

    const submittedExitTick = isRecord(body) && isRecord(body.exitTick) ? body.exitTick : null;
    const submittedExitPrice = finiteNumber(submittedExitTick?.quote);
    const submittedExitPipSize = finiteNumber(submittedExitTick?.pipSize);
    const submittedExitEpoch = finiteNumber(submittedExitTick?.epoch);
    if (
      submittedExitPrice === null ||
      submittedExitPipSize === null ||
      submittedExitEpoch === null ||
      !Number.isInteger(submittedExitEpoch)
    ) {
      return NextResponse.json({ error: 'The exact Deriv expiry tick is required to settle this trade.' }, { status: 400 });
    }

    let entryIndex = -1;
    ticks.forEach((tick, index) => {
      if (
        tick.epoch === entryEpoch &&
        tick.quote === entryPrice &&
        tick.pipSize === entryPipSize
      ) entryIndex = index;
    });
    if (entryIndex < 0) {
      throw new Error('Deriv history could not verify this trade’s entry price.');
    }
    const exitTick: MarketTick | undefined = ticks[entryIndex + duration];
    if (!exitTick) return NextResponse.json({ status: 'open' });
    if (
      exitTick.quote !== submittedExitPrice ||
      exitTick.pipSize !== submittedExitPipSize ||
      exitTick.epoch !== submittedExitEpoch
    ) {
      return NextResponse.json({
        error: 'The browser expiry tick does not match the exact tick at this trade duration. The trade has not been settled.',
      }, { status: 409 });
    }

    const { data, error } = await admin.rpc('marketpilot_settle_real_market_trade', {
      p_user_id: user.id,
      p_trade_id: tradeId,
      p_exit_price: submittedExitPrice,
      p_exit_pip_size: submittedExitPipSize,
      p_exit_digit: getMarketPilotTickDigit(exitTick),
      p_exit_epoch: submittedExitEpoch,
    });
    if (error) {
      console.error('Real market trade could not be settled.', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      if (error.code === 'PGRST202' || error.code === '42883') {
        return NextResponse.json({
          error: 'Real wallet settlement is not configured in Supabase. Apply migration 20261126000400_marketpilot_real_market_settlement.sql.',
        }, { status: 503 });
      }
      if (error.code === '42501') {
        return NextResponse.json({
          error: 'Real trade history is not readable by the server role. Apply migration 20261126000600_marketpilot_real_trade_read_grant.sql.',
        }, { status: 503 });
      }
      if (error.code === '22023') {
        return NextResponse.json({
          error: 'The Deriv exit price failed settlement validation. Apply migration 20261126000500_marketpilot_real_market_settlement_precision.sql, then retry.',
        }, { status: 503 });
      }
      return NextResponse.json({ error: 'The Real wallet trade could not be settled. It will retry automatically.' }, { status: 503 });
    }
    if (!isRecord(data) || (data.status !== 'open' && data.status !== 'won' && data.status !== 'lost')) {
      throw new Error('The database returned an invalid Real wallet settlement.');
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error('Real market-trade settlement route failed.', error);
    return NextResponse.json({
      error: error instanceof Error
        ? error.message
        : 'The Real wallet trade could not be settled. It will retry automatically.',
    }, { status: 503 });
  }
}
