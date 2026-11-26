begin;

create or replace function public.marketpilot_settle_real_market_trade(
  p_user_id uuid,
  p_trade_id text,
  p_exit_price numeric,
  p_exit_pip_size numeric,
  p_exit_digit integer,
  p_exit_epoch bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  trade_row public.marketpilot_practice_trades%rowtype;
  v_did_win boolean;
  v_settled_payout numeric;
  v_updated_balance numeric;
  v_precision integer;
  v_expected_digit integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role is required' using errcode = '42501';
  end if;
  if p_user_id is null
    or p_trade_id is null or length(p_trade_id) < 1 or length(p_trade_id) > 100
    or p_exit_price is null or p_exit_price not between 1 and 1000000000
    or p_exit_pip_size is null or p_exit_pip_size <= 0 or p_exit_pip_size > 0.01
    or p_exit_digit is null or p_exit_digit not between 0 and 9
    or p_exit_epoch is null then
    raise exception 'Invalid market trade settlement details' using errcode = '22023';
  end if;

  select trade.*
  into trade_row
  from public.marketpilot_practice_trades as trade
  where trade.user_id = p_user_id
    and trade.id = p_trade_id
    and trade.account_type = 'real'
    and trade.outcome_source = 'local_simulation'
  for update;

  if not found then
    raise exception 'Real market trade was not found' using errcode = 'P0002';
  end if;

  select wallet.balance
  into v_updated_balance
  from public.marketpilot_wallets as wallet
  where wallet.user_id = p_user_id
    and wallet.account_type = 'real';

  if v_updated_balance is null then
    raise exception 'Real wallet was not found' using errcode = 'P0001';
  end if;

  if trade_row.status <> 'open' then
    return pg_catalog.jsonb_build_object(
      'balance', v_updated_balance,
      'status', trade_row.status,
      'payout', trade_row.payout,
      'profit', trade_row.profit,
      'exitPrice', trade_row.exit_price,
      'exitPipSize', trade_row.exit_pip_size,
      'exitDigit', trade_row.exit_digit,
      'exitEpoch', trade_row.exit_epoch,
      'outcomeSource', trade_row.outcome_source
    );
  end if;

  if p_exit_epoch < trade_row.entry_epoch
    or p_exit_pip_size <> trade_row.entry_pip_size then
    raise exception 'Exit tick does not match the saved market precision or time' using errcode = '22023';
  end if;

  v_precision := greatest(
    0,
    least(10, pg_catalog.round(-pg_catalog.ln(p_exit_pip_size) / pg_catalog.ln(10))::integer)
  );
  v_expected_digit := pg_catalog.mod(
    pg_catalog.round(p_exit_price * pg_catalog.power(10::numeric, v_precision))::bigint,
    10
  )::integer;
  if p_exit_digit <> v_expected_digit then
    raise exception 'Exit digit does not match the market price' using errcode = '22023';
  end if;

  v_did_win := case trade_row.contract_type
    when 'DIGITOVER' then p_exit_digit > trade_row.barrier
    when 'DIGITUNDER' then p_exit_digit < trade_row.barrier
    when 'DIGITEVEN' then p_exit_digit % 2 = 0
    when 'DIGITODD' then p_exit_digit % 2 = 1
    when 'DIGITMATCH' then p_exit_digit = trade_row.barrier
    when 'DIGITDIFF' then p_exit_digit <> trade_row.barrier
    when 'CALL' then p_exit_price > trade_row.entry_price
    when 'PUT' then p_exit_price < trade_row.entry_price
    else false
  end;
  v_settled_payout := case when v_did_win then trade_row.quoted_payout else 0 end;

  update public.marketpilot_practice_trades as trade
  set status = case when v_did_win then 'won' else 'lost' end,
      elapsed = trade.duration,
      exit_price = p_exit_price,
      exit_pip_size = p_exit_pip_size,
      exit_digit = p_exit_digit,
      exit_epoch = p_exit_epoch,
      payout = v_settled_payout,
      profit = v_settled_payout - trade.stake,
      outcome_source = 'local_simulation'
  where trade.user_id = p_user_id
    and trade.id = p_trade_id
    and trade.account_type = 'real';

  update public.marketpilot_wallets as wallet
  set balance = wallet.balance + v_settled_payout,
      updated_at = pg_catalog.now()
  where wallet.user_id = p_user_id
    and wallet.account_type = 'real'
  returning wallet.balance into v_updated_balance;

  if v_updated_balance is null then
    raise exception 'Real wallet settlement failed' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'balance', v_updated_balance,
    'status', case when v_did_win then 'won' else 'lost' end,
    'payout', v_settled_payout,
    'profit', v_settled_payout - trade_row.stake,
    'exitPrice', p_exit_price,
    'exitPipSize', p_exit_pip_size,
    'exitDigit', p_exit_digit,
    'exitEpoch', p_exit_epoch,
    'outcomeSource', 'local_simulation'
  );
end;
$$;

revoke all on function public.marketpilot_settle_real_market_trade(uuid, text, numeric, numeric, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.marketpilot_settle_real_market_trade(uuid, text, numeric, numeric, integer, bigint)
  to service_role;

drop function if exists public.marketpilot_settle_real_simulated_trade(uuid, text, integer, integer);

commit;
