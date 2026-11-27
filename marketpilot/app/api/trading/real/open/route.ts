import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getMarketPilotTickDigit, VOLATILITY_SYMBOLS, type MarketTick } from '@/lib/market-data';
import { getSimulatedContractPayout } from '@/lib/practice';
import { isSameOriginRequest } from '@/lib/request-origin';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'This trade request is not allowed.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'A valid simulated trade is required.' }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'A valid simulated trade is required.' }, { status: 400 });
  }

  const symbol = VOLATILITY_SYMBOLS.find((item) => item.symbol === body.symbol);
  const contractType = typeof body.contractType === 'string' ? body.contractType : '';
  const hasDigitBarrier = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(contractType);
  const barrier = body.barrier;
  const barrierValue = typeof barrier === 'number' ? barrier : null;
  const duration = body.duration;
  const stake = body.stake;
  const entryPrice = body.entryPrice;
  const entryPipSize = body.entryPipSize;
  const entryEpoch = body.entryEpoch;
  const supportedContract = [
    'DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD',
    'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT',
  ].includes(contractType);
  const validBarrier = hasDigitBarrier
    ? barrierValue !== null &&
      Number.isInteger(barrierValue) &&
      barrierValue >= (contractType === 'DIGITUNDER' ? 1 : 0) &&
      barrierValue <= (contractType === 'DIGITOVER' ? 8 : 9)
    : barrier === null;

  if (
    !symbol ||
    !supportedContract ||
    !validBarrier ||
    typeof duration !== 'number' ||
    !Number.isInteger(duration) ||
    duration < (contractType === 'CALL' || contractType === 'PUT' ? 10 : 1) ||
    duration > (contractType === 'CALL' || contractType === 'PUT' ? 30 : 15) ||
    typeof stake !== 'number' ||
    !Number.isFinite(stake) ||
    stake < 0.35 ||
    Math.round(stake * 100) !== stake * 100 ||
    typeof entryPrice !== 'number' ||
    !Number.isFinite(entryPrice) ||
    entryPrice < 1 ||
    entryPrice > 1_000_000_000 ||
    typeof entryPipSize !== 'number' ||
    !Number.isFinite(entryPipSize) ||
    entryPipSize <= 0 ||
    entryPipSize > 0.01 ||
    typeof entryEpoch !== 'number' ||
    !Number.isInteger(entryEpoch)
  ) {
    return NextResponse.json({ error: 'The simulated trade details are invalid.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Sign in to place a Real wallet trade.' }, { status: 401 });
  }

  const entryTick: MarketTick = {
    symbol: symbol.symbol,
    quote: entryPrice,
    pipSize: entryPipSize,
    epoch: entryEpoch,
  };
  const quotedPayout = getSimulatedContractPayout(
    contractType,
    hasDigitBarrier ? barrierValue : null,
    stake,
  );
  if (quotedPayout === null || !Number.isFinite(quotedPayout) || quotedPayout < stake) {
    return NextResponse.json({ error: 'A simulated payout is not available for this contract.' }, { status: 400 });
  }

  const tradeId = randomUUID();
  const entryDigit = getMarketPilotTickDigit(entryTick);
  try {
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.rpc('marketpilot_open_real_simulated_trade', {
      p_user_id: user.id,
      p_trade_id: tradeId,
      p_symbol: symbol.symbol,
      p_contract_type: contractType,
      p_barrier: hasDigitBarrier ? barrierValue : null,
      p_duration: duration,
      p_stake: stake,
      p_quoted_payout: quotedPayout,
      p_entry_price: entryTick.quote,
      p_entry_pip_size: entryTick.pipSize,
      p_entry_digit: entryDigit,
      p_entry_epoch: entryTick.epoch,
    });
    if (error) {
      if (error.message.includes('Insufficient wallet balance')) {
        return NextResponse.json({ error: 'The selected wallet does not have enough balance for this stake.' }, { status: 409 });
      }
      console.error('Real simulated trade could not be opened.', error.message);
      if (error.code === 'PGRST202' || error.code === '42883') {
        return NextResponse.json({
          error: 'Real simulated trading is not configured in Supabase. Apply migration 20261126000300_marketpilot_real_simulated_trades.sql.',
        }, { status: 503 });
      }
      if (error.code === '42501') {
        return NextResponse.json({
          error: 'Real simulated-trading database permissions are not configured. Check the server-only Supabase key and migration.',
        }, { status: 503 });
      }
      return NextResponse.json({ error: 'The Real wallet could not open this simulated trade.' }, { status: 503 });
    }

    const balance = Number(data);
    if (!Number.isFinite(balance) || balance < 0) {
      throw new Error('The database returned an invalid Real wallet balance.');
    }
    return NextResponse.json({
      tradeId,
      balance,
      askPrice: stake,
      payout: quotedPayout,
      entryPrice: entryTick.quote,
      entryPipSize: entryTick.pipSize,
      entryDigit,
      entryEpoch: entryTick.epoch,
    });
  } catch (error) {
    console.error('Real simulated trade route failed.', error);
    return NextResponse.json({ error: 'The Real wallet trade could not be opened. Try again.' }, { status: 503 });
  }
}
