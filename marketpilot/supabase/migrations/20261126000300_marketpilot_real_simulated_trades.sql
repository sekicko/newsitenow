begin;

alter table public.marketpilot_practice_trades
  drop constraint if exists marketpilot_practice_trades_outcome_source_check;

alter table public.marketpilot_practice_trades
  add constraint marketpilot_practice_trades_outcome_source_check
  check (
    outcome_source = 'market_data'
    or (outcome_source = 'local_simulation' and account_type = 'real')
    or (outcome_source = 'test_simulation' and status in ('won', 'lost'))
  );

create or replace function public.marketpilot_settle_demo_practice_trade(
  p_trade_id text,
  p_account_type text,
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
begin
  if p_account_type is distinct from 'demo' then
    raise exception 'This settlement endpoint is only for the Demo wallet' using errcode = '42501';
  end if;

  return public.marketpilot_settle_practice_trade(
    p_trade_id,
    p_account_type,
    p_exit_price,
    p_exit_pip_size,
    p_exit_digit,
    p_exit_epoch
  );
end;
$$;

revoke all on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint)
  from public, anon, authenticated;
revoke all on function public.marketpilot_settle_demo_practice_trade(text, text, numeric, numeric, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.marketpilot_settle_demo_practice_trade(text, text, numeric, numeric, integer, bigint)
  to authenticated;

create or replace function public.marketpilot_open_real_simulated_trade(
  p_user_id uuid,
  p_trade_id text,
  p_symbol text,
  p_contract_type text,
  p_barrier integer,
  p_duration integer,
  p_stake numeric,
  p_quoted_payout numeric,
  p_entry_price numeric,
  p_entry_pip_size numeric,
  p_entry_digit integer,
  p_entry_epoch bigint
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_balance numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role is required' using errcode = '42501';
  end if;
  if p_user_id is null
    or p_trade_id is null or length(p_trade_id) < 1 or length(p_trade_id) > 100
    or p_symbol is null
    or p_symbol not in ('R_10', 'R_25', 'R_50', 'R_75', 'R_100', '1HZ10V', '1HZ25V', '1HZ50V', '1HZ75V', '1HZ100V')
    or p_contract_type is null
    or p_contract_type not in ('DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT')
    or p_duration is null
    or (p_contract_type in ('CALL', 'PUT') and p_duration not between 10 and 30)
    or (p_contract_type in ('DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF') and p_duration not between 1 and 15)
    or p_stake is null or p_stake < 0.35 or p_stake <> pg_catalog.round(p_stake, 2)
    or p_quoted_payout is null or p_quoted_payout < p_stake
    or p_entry_price is null or p_entry_price not between 1 and 1000000000
    or p_entry_pip_size is null or p_entry_pip_size <= 0 or p_entry_pip_size > 0.01
    or p_entry_digit is null or p_entry_digit not between 0 and 9
    or p_entry_epoch is null
    or (
      p_contract_type in ('DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF')
      and (p_barrier is null or p_barrier not between 0 and 9)
    )
    or (p_contract_type = 'DIGITOVER' and p_barrier not between 0 and 8)
    or (p_contract_type = 'DIGITUNDER' and p_barrier not between 1 and 9)
    or (
      p_contract_type in ('DIGITEVEN', 'DIGITODD', 'CALL', 'PUT')
      and p_barrier is not null
    ) then
    raise exception 'Invalid simulated trade details' using errcode = '22023';
  end if;

  update public.marketpilot_wallets
  set balance = balance - p_stake,
      updated_at = pg_catalog.now()
  where user_id = p_user_id
    and account_type = 'real'
    and balance >= p_stake
  returning balance into updated_balance;

  if updated_balance is null then
    raise exception 'Insufficient wallet balance' using errcode = 'P0001';
  end if;

  insert into public.marketpilot_practice_trades (
    id,
    user_id,
    account_type,
    symbol,
    contract_type,
    barrier,
    duration,
    stake,
    quoted_payout,
    entry_price,
    entry_pip_size,
    entry_digit,
    entry_epoch,
    outcome_source
  ) values (
    p_trade_id,
    p_user_id,
    'real',
    p_symbol,
    p_contract_type,
    p_barrier,
    p_duration,
    p_stake,
    p_quoted_payout,
    p_entry_price,
    p_entry_pip_size,
    p_entry_digit,
    p_entry_epoch,
    'local_simulation'
  );

  return updated_balance;
end;
$$;

revoke all on function public.marketpilot_open_real_simulated_trade(uuid, text, text, text, integer, integer, numeric, numeric, numeric, numeric, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.marketpilot_open_real_simulated_trade(uuid, text, text, text, integer, integer, numeric, numeric, numeric, numeric, integer, bigint)
  to service_role;

create or replace function public.marketpilot_settle_real_simulated_trade(
  p_user_id uuid,
  p_trade_id text,
  p_exit_digit integer,
  p_exit_direction integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  trade_row public.marketpilot_practice_trades%rowtype;
  v_did_win boolean;
  v_exit_price numeric;
  v_settled_payout numeric;
  v_updated_balance numeric;
  v_exit_epoch bigint;
  v_precision integer;
  v_price_step numeric;
  v_price_quantum numeric;
  v_price_base numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role is required' using errcode = '42501';
  end if;
  if p_user_id is null
    or p_trade_id is null or length(p_trade_id) < 1 or length(p_trade_id) > 100
    or p_exit_digit is null or p_exit_digit not between 0 and 9
    or p_exit_direction is null
    or p_exit_direction not in (-1, 1) then
    raise exception 'Invalid simulated trade settlement details' using errcode = '22023';
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
    raise exception 'Real simulated trade was not found' using errcode = 'P0002';
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

  if trade_row.created_at + pg_catalog.make_interval(secs => trade_row.duration) > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('status', 'open');
  end if;

  v_precision := greatest(
    0,
    least(10, pg_catalog.round(-pg_catalog.log(trade_row.entry_pip_size) / pg_catalog.ln(10))::integer)
  );
  v_price_step := 1 / pg_catalog.power(10::numeric, v_precision);
  v_price_quantum := v_price_step * 10;
  v_price_base := pg_catalog.floor(trade_row.entry_price / v_price_quantum) * v_price_quantum;
  v_exit_price :=
    v_price_base
    + (p_exit_direction * v_price_quantum)
    + (p_exit_digit * v_price_step);
  v_exit_epoch := pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now()))::bigint;
  v_did_win := case trade_row.contract_type
    when 'DIGITOVER' then p_exit_digit > trade_row.barrier
    when 'DIGITUNDER' then p_exit_digit < trade_row.barrier
    when 'DIGITEVEN' then p_exit_digit % 2 = 0
    when 'DIGITODD' then p_exit_digit % 2 = 1
    when 'DIGITMATCH' then p_exit_digit = trade_row.barrier
    when 'DIGITDIFF' then p_exit_digit <> trade_row.barrier
    when 'CALL' then p_exit_direction > 0
    when 'PUT' then p_exit_direction < 0
    else false
  end;
  v_settled_payout := case when v_did_win then trade_row.quoted_payout else 0 end;

  update public.marketpilot_practice_trades as trade
  set status = case when v_did_win then 'won' else 'lost' end,
      elapsed = trade.duration,
      exit_price = v_exit_price,
      exit_pip_size = trade.entry_pip_size,
      exit_digit = p_exit_digit,
      exit_epoch = v_exit_epoch,
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
    'exitPrice', v_exit_price,
    'exitPipSize', trade_row.entry_pip_size,
    'exitDigit', p_exit_digit,
    'exitEpoch', v_exit_epoch,
    'outcomeSource', 'local_simulation'
  );
end;
$$;

revoke all on function public.marketpilot_settle_real_simulated_trade(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.marketpilot_settle_real_simulated_trade(uuid, text, integer, integer)
  to service_role;

commit;
