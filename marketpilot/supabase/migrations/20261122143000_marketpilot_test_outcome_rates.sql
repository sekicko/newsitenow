create table if not exists public.marketpilot_test_settings (
  id boolean primary key default true check (id),
  demo_win_rate integer not null check (demo_win_rate between 0 and 100),
  updated_at timestamptz not null default pg_catalog.now()
);

insert into public.marketpilot_test_settings (id, demo_win_rate)
values (true, 75)
on conflict (id) do nothing;

alter table public.marketpilot_test_settings enable row level security;
revoke all on public.marketpilot_test_settings from public, anon, authenticated;

alter table public.marketpilot_practice_trades
  add column if not exists outcome_source text not null default 'market_data'
    check (outcome_source in ('market_data', 'test_simulation')),
  add column if not exists test_win_probability integer
    check (test_win_probability between 0 and 100);

create table if not exists public.marketpilot_test_trade_outcomes (
  user_id uuid not null references auth.users (id) on delete cascade,
  trade_id text not null,
  account_type text not null check (account_type in ('real', 'demo')),
  did_win boolean not null,
  primary key (user_id, trade_id, account_type)
);

alter table public.marketpilot_test_trade_outcomes enable row level security;
revoke all on public.marketpilot_test_trade_outcomes from public, anon, authenticated;

create or replace function public.marketpilot_assign_test_outcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  demo_rate integer;
  selected_rate integer;
begin
  select demo_win_rate
  into demo_rate
  from public.marketpilot_test_settings
  where id;

  if demo_rate is null then
    raise exception 'Test outcome settings are unavailable' using errcode = 'P0001';
  end if;

  selected_rate := case
    when new.account_type = 'demo' then demo_rate
    else 100 - demo_rate
  end;
  new.outcome_source := 'test_simulation';
  new.test_win_probability := selected_rate;

  insert into public.marketpilot_test_trade_outcomes (
    user_id,
    trade_id,
    account_type,
    did_win
  ) values (
    new.user_id,
    new.id,
    new.account_type,
    pg_catalog.random() * 100 < selected_rate
  );

  return new;
end;
$$;

revoke all on function public.marketpilot_assign_test_outcome() from public, anon, authenticated;

drop trigger if exists marketpilot_assign_test_outcome_before_insert
  on public.marketpilot_practice_trades;
create trigger marketpilot_assign_test_outcome_before_insert
  before insert on public.marketpilot_practice_trades
  for each row execute procedure public.marketpilot_assign_test_outcome();

create or replace function public.marketpilot_admin_get_demo_test_win_rate()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  configured_rate integer;
begin
  if not public.marketpilot_is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  select demo_win_rate
  into configured_rate
  from public.marketpilot_test_settings
  where id;

  if configured_rate is null then
    raise exception 'Test outcome settings are unavailable' using errcode = 'P0001';
  end if;

  return configured_rate;
end;
$$;

revoke all on function public.marketpilot_admin_get_demo_test_win_rate() from public, anon, authenticated;
grant execute on function public.marketpilot_admin_get_demo_test_win_rate() to authenticated;

create or replace function public.marketpilot_admin_set_demo_test_win_rate(p_demo_win_rate integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.marketpilot_is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if p_demo_win_rate is null or p_demo_win_rate not between 0 and 100 then
    raise exception 'Demo test win rate must be between 0 and 100' using errcode = '22023';
  end if;

  insert into public.marketpilot_test_settings (id, demo_win_rate, updated_at)
  values (true, p_demo_win_rate, pg_catalog.now())
  on conflict (id) do update
  set demo_win_rate = excluded.demo_win_rate,
      updated_at = excluded.updated_at;

  return p_demo_win_rate;
end;
$$;

revoke all on function public.marketpilot_admin_set_demo_test_win_rate(integer) from public, anon, authenticated;
grant execute on function public.marketpilot_admin_set_demo_test_win_rate(integer) to authenticated;

create or replace function public.marketpilot_admin_get_market_real_win_rate()
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.marketpilot_is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  return (
    select pg_catalog.round(
      100.0 * pg_catalog.count(*) filter (where trade.status = 'won')
      / nullif(pg_catalog.count(*), 0),
      1
    )
    from public.marketpilot_practice_trades as trade
    where trade.account_type = 'real'
      and trade.outcome_source = 'market_data'
      and trade.status in ('won', 'lost')
  );
end;
$$;

revoke all on function public.marketpilot_admin_get_market_real_win_rate() from public, anon, authenticated;
grant execute on function public.marketpilot_admin_get_market_real_win_rate() to authenticated;

drop function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint);

create function public.marketpilot_settle_practice_trade(
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
  did_win boolean;
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
    select did_win
    into did_win
    from public.marketpilot_test_trade_outcomes
    where user_id = current_user_id
      and trade_id = p_trade_id
      and account_type = p_account_type;

    if not found then
      raise exception 'Test outcome was not found' using errcode = 'P0001';
    end if;
  else
    did_win := case practice_trade.contract_type
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

  settled_payout := case when did_win then practice_trade.quoted_payout else 0 end;

  update public.marketpilot_practice_trades
  set status = case when did_win then 'won' else 'lost' end,
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
    'status', case when did_win then 'won' else 'lost' end,
    'payout', settled_payout,
    'profit', settled_payout - practice_trade.stake,
    'outcomeSource', practice_trade.outcome_source,
    'testWinProbability', practice_trade.test_win_probability
  );
end;
$$;

revoke all on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) from public, anon, authenticated;
grant execute on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) to authenticated;
