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
  current_user_id uuid := auth.uid();
  practice_trade public.marketpilot_practice_trades%rowtype;
  settlement_won boolean;
  settled_payout numeric;
  updated_balance numeric;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_trade_id is null or length(p_trade_id) < 1 or length(p_trade_id) > 100
    or p_account_type is null or p_account_type not in ('real', 'demo')
    or p_exit_price is null or p_exit_pip_size is null or p_exit_pip_size <= 0
    or p_exit_digit is null or p_exit_digit not between 0 and 9
    or p_exit_epoch is null then
    raise exception 'Invalid practice settlement details' using errcode = '22023';
  end if;

  select *
  into practice_trade
  from public.marketpilot_practice_trades
  where user_id = current_user_id
    and id = p_trade_id
    and account_type = p_account_type
  for update;

  if not found then
    raise exception 'Practice trade was not found' using errcode = 'P0002';
  end if;

  if practice_trade.status <> 'open' then
    select balance
    into updated_balance
    from public.marketpilot_wallets
    where user_id = current_user_id
      and account_type = p_account_type;

    if updated_balance is null then
      raise exception 'Wallet was not found' using errcode = 'P0001';
    end if;

    return pg_catalog.jsonb_build_object(
      'balance', updated_balance,
      'status', practice_trade.status,
      'payout', practice_trade.payout,
      'profit', practice_trade.profit,
      'outcomeSource', practice_trade.outcome_source,
      'testWinProbability', practice_trade.test_win_probability
    );
  end if;

  if p_exit_epoch < practice_trade.entry_epoch then
    raise exception 'Exit tick must not precede the entry tick' using errcode = '22023';
  end if;

  if practice_trade.outcome_source = 'test_simulation' then
    select test_outcome.did_win
    into settlement_won
    from public.marketpilot_test_trade_outcomes as test_outcome
    where test_outcome.user_id = current_user_id
      and test_outcome.trade_id = p_trade_id
      and test_outcome.account_type = p_account_type;

    if not found then
      raise exception 'Test outcome was not found' using errcode = 'P0001';
    end if;
  else
    settlement_won := case practice_trade.contract_type
      when 'DIGITOVER' then p_exit_digit > practice_trade.barrier
      when 'DIGITUNDER' then p_exit_digit < practice_trade.barrier
      when 'DIGITEVEN' then p_exit_digit % 2 = 0
      when 'DIGITODD' then p_exit_digit % 2 = 1
      when 'DIGITMATCH' then p_exit_digit = practice_trade.barrier
      when 'DIGITDIFF' then p_exit_digit <> practice_trade.barrier
      when 'CALL' then p_exit_price > practice_trade.entry_price
      when 'PUT' then p_exit_price < practice_trade.entry_price
      else false
    end;
  end if;

  settled_payout := case when settlement_won then practice_trade.quoted_payout else 0 end;

  update public.marketpilot_practice_trades
  set status = case when settlement_won then 'won' else 'lost' end,
      elapsed = duration,
      exit_price = p_exit_price,
      exit_pip_size = p_exit_pip_size,
      exit_digit = p_exit_digit,
      exit_epoch = p_exit_epoch,
      payout = settled_payout,
      profit = settled_payout - stake
  where user_id = current_user_id
    and id = p_trade_id
    and account_type = p_account_type;

  update public.marketpilot_wallets
  set balance = balance + settled_payout,
      updated_at = pg_catalog.now()
  where user_id = current_user_id
    and account_type = p_account_type
  returning balance into updated_balance;

  if updated_balance is null then
    raise exception 'Wallet settlement failed' using errcode = 'P0001';
  end if;

  delete from public.marketpilot_test_trade_outcomes
  where user_id = current_user_id
    and trade_id = p_trade_id
    and account_type = p_account_type;

  return pg_catalog.jsonb_build_object(
    'balance', updated_balance,
    'status', case when settlement_won then 'won' else 'lost' end,
    'payout', settled_payout,
    'profit', settled_payout - practice_trade.stake,
    'outcomeSource', practice_trade.outcome_source,
    'testWinProbability', practice_trade.test_win_probability
  );
end;
$$;

revoke all on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) from public, anon, authenticated;
grant execute on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) to authenticated;
