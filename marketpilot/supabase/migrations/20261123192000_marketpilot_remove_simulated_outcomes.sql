begin;

drop trigger if exists marketpilot_assign_test_outcome_before_insert
  on public.marketpilot_practice_trades;

update public.marketpilot_practice_trades
set outcome_source = 'market_data',
    test_win_probability = null,
    simulated_exit_price = null,
    simulated_exit_digit = null
where status = 'open'
  and outcome_source = 'test_simulation';

delete from public.marketpilot_test_trade_outcomes;

create or replace function public.marketpilot_settle_practice_trade(
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
declare
  v_user_id uuid := auth.uid();
  v_trade public.marketpilot_practice_trades%rowtype;
  v_won boolean;
  v_payout numeric;
  v_balance numeric;
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_trade_id is null or length(p_trade_id) < 1 or length(p_trade_id) > 100
    or p_account_type is null or p_account_type not in ('real', 'demo')
    or p_exit_price is null or p_exit_pip_size is null or p_exit_pip_size <= 0
    or p_exit_digit is null or p_exit_digit not between 0 and 9
    or p_exit_epoch is null then
    raise exception 'Invalid practice settlement details' using errcode = '22023';
  end if;

  select trade.*
  into v_trade
  from public.marketpilot_practice_trades as trade
  where trade.user_id = v_user_id
    and trade.id = p_trade_id
    and trade.account_type = p_account_type
  for update;

  if not found then
    raise exception 'Practice trade was not found' using errcode = 'P0002';
  end if;

  if v_trade.status <> 'open' then
    select wallet.balance
    into v_balance
    from public.marketpilot_wallets as wallet
    where wallet.user_id = v_user_id
      and wallet.account_type = p_account_type;

    if v_balance is null then
      raise exception 'Wallet was not found' using errcode = 'P0001';
    end if;

    return pg_catalog.jsonb_build_object(
      'balance', v_balance,
      'status', v_trade.status,
      'payout', v_trade.payout,
      'profit', v_trade.profit,
      'outcomeSource', v_trade.outcome_source
    );
  end if;

  if p_exit_epoch < v_trade.entry_epoch then
    raise exception 'Exit tick must not precede the entry tick' using errcode = '22023';
  end if;
  if v_trade.contract_type in ('DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF')
    and (v_trade.barrier is null or v_trade.barrier not between 0 and 9) then
    raise exception 'A valid digit barrier is required for this contract' using errcode = '22023';
  end if;

  v_won := case v_trade.contract_type
    when 'DIGITOVER' then p_exit_digit > v_trade.barrier
    when 'DIGITUNDER' then p_exit_digit < v_trade.barrier
    when 'DIGITEVEN' then p_exit_digit % 2 = 0
    when 'DIGITODD' then p_exit_digit % 2 = 1
    when 'DIGITMATCH' then p_exit_digit = v_trade.barrier
    when 'DIGITDIFF' then p_exit_digit <> v_trade.barrier
    when 'CALL' then p_exit_price > v_trade.entry_price
    when 'PUT' then p_exit_price < v_trade.entry_price
    else false
  end;
  v_payout := case when v_won then v_trade.quoted_payout else 0 end;

  update public.marketpilot_practice_trades as trade
  set status = case when v_won then 'won' else 'lost' end,
      elapsed = trade.duration,
      exit_price = p_exit_price,
      exit_pip_size = p_exit_pip_size,
      exit_digit = p_exit_digit,
      exit_epoch = p_exit_epoch,
      outcome_source = 'market_data',
      test_win_probability = null,
      simulated_exit_price = null,
      simulated_exit_digit = null,
      payout = v_payout,
      profit = v_payout - trade.stake
  where trade.user_id = v_user_id
    and trade.id = p_trade_id
    and trade.account_type = p_account_type;

  update public.marketpilot_wallets as wallet
  set balance = wallet.balance + v_payout,
      updated_at = pg_catalog.now()
  where wallet.user_id = v_user_id
    and wallet.account_type = p_account_type
  returning wallet.balance into v_balance;

  if v_balance is null then
    raise exception 'Wallet settlement failed' using errcode = 'P0001';
  end if;

  return pg_catalog.jsonb_build_object(
    'balance', v_balance,
    'status', case when v_won then 'won' else 'lost' end,
    'payout', v_payout,
    'profit', v_payout - v_trade.stake,
    'outcomeSource', 'market_data'
  );
end;
$$;

revoke all on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) from public, anon, authenticated;
grant execute on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) to authenticated;

drop function if exists public.marketpilot_admin_get_demo_test_win_rate();
drop function if exists public.marketpilot_admin_set_demo_test_win_rate(integer);
drop function if exists public.marketpilot_assign_test_outcome();
drop table if exists public.marketpilot_test_trade_outcomes;
drop table if exists public.marketpilot_test_settings;

alter table public.marketpilot_practice_trades
  drop constraint if exists marketpilot_practice_trades_outcome_source_check;

alter table public.marketpilot_practice_trades
  add constraint marketpilot_practice_trades_outcome_source_check
  check (
    outcome_source = 'market_data'
    or (outcome_source = 'test_simulation' and status in ('won', 'lost'))
  );

commit;
