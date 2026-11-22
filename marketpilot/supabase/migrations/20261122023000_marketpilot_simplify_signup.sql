create table if not exists public.marketpilot_wallets (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_type text not null check (account_type in ('real', 'demo')),
  balance numeric(18, 2) not null check (balance >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, account_type)
);

create table if not exists public.marketpilot_practice_trades (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  account_type text not null check (account_type in ('real', 'demo')),
  symbol text not null,
  contract_type text not null check (
    contract_type in ('DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT')
  ),
  barrier integer check (barrier between 0 and 9),
  duration integer not null check (duration between 1 and 10),
  duration_unit text not null default 't' check (duration_unit = 't'),
  stake numeric(18, 2) not null check (stake > 0),
  quoted_payout numeric(18, 2) not null check (quoted_payout >= 0),
  entry_price numeric(24, 12) not null,
  entry_pip_size numeric(24, 12) not null check (entry_pip_size > 0),
  entry_digit integer not null check (entry_digit between 0 and 9),
  entry_epoch bigint not null,
  elapsed integer not null default 0 check (elapsed between 0 and duration),
  status text not null default 'open' check (status in ('open', 'won', 'lost')),
  exit_price numeric(24, 12),
  exit_pip_size numeric(24, 12),
  exit_digit integer check (exit_digit between 0 and 9),
  exit_epoch bigint,
  payout numeric(18, 2) not null default 0 check (payout >= 0),
  profit numeric(18, 2),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.marketpilot_wallets enable row level security;
alter table public.marketpilot_practice_trades enable row level security;

revoke all on public.marketpilot_wallets from anon, authenticated;
revoke all on public.marketpilot_practice_trades from anon, authenticated;
grant select on public.marketpilot_wallets to authenticated;
grant select on public.marketpilot_practice_trades to authenticated;

drop policy if exists "Users can read their own MarketPilot wallets"
  on public.marketpilot_wallets;
create policy "Users can read their own MarketPilot wallets"
  on public.marketpilot_wallets
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can read their own MarketPilot practice trades"
  on public.marketpilot_practice_trades;
create policy "Users can read their own MarketPilot practice trades"
  on public.marketpilot_practice_trades
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.handle_marketpilot_wallets_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.marketpilot_wallets (user_id, account_type, balance)
  values
    (new.id, 'real', 0),
    (new.id, 'demo', 10000)
  on conflict (user_id, account_type) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_marketpilot_wallets_created() from public, anon, authenticated;

drop trigger if exists on_marketpilot_wallets_user_created on auth.users;
create trigger on_marketpilot_wallets_user_created
  after insert on auth.users
  for each row execute procedure public.handle_marketpilot_wallets_created();

insert into public.marketpilot_wallets (user_id, account_type, balance)
select users.id, accounts.account_type, accounts.balance
from auth.users as users
cross join (
  values ('real'::text, 0::numeric), ('demo'::text, 10000::numeric)
) as accounts(account_type, balance)
on conflict (user_id, account_type) do nothing;

create or replace function public.marketpilot_open_practice_trade(
  p_trade_id text,
  p_account_type text,
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
  current_user_id uuid := auth.uid();
  updated_balance numeric;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_account_type = 'real' then
    raise exception 'Real wallet trading is not enabled' using errcode = '42501';
  end if;
  if p_trade_id is null or length(p_trade_id) < 1 or length(p_trade_id) > 100
    or p_account_type not in ('real', 'demo')
    or p_symbol is null or length(p_symbol) < 1
    or p_contract_type not in ('DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT')
    or p_duration not between 1 and 10
    or p_stake is null or p_stake <= 0
    or p_quoted_payout is null or p_quoted_payout < 0
    or p_entry_price is null or p_entry_pip_size is null or p_entry_pip_size <= 0
    or p_entry_digit not between 0 and 9
    or p_entry_epoch is null then
    raise exception 'Invalid practice trade details' using errcode = '22023';
  end if;

  update public.marketpilot_wallets
  set balance = balance - p_stake, updated_at = pg_catalog.now()
  where user_id = current_user_id
    and account_type = p_account_type
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
    entry_epoch
  ) values (
    p_trade_id,
    current_user_id,
    p_account_type,
    p_symbol,
    p_contract_type,
    p_barrier,
    p_duration,
    p_stake,
    p_quoted_payout,
    p_entry_price,
    p_entry_pip_size,
    p_entry_digit,
    p_entry_epoch
  );

  return updated_balance;
end;
$$;

create or replace function public.marketpilot_settle_practice_trade(
  p_trade_id text,
  p_account_type text,
  p_exit_price numeric,
  p_exit_pip_size numeric,
  p_exit_digit integer,
  p_exit_epoch bigint
)
returns numeric
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
  if p_trade_id is null or p_account_type not in ('real', 'demo')
    or p_exit_price is null or p_exit_pip_size is null or p_exit_pip_size <= 0
    or p_exit_digit not between 0 and 9 or p_exit_epoch is null then
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
    where user_id = current_user_id and account_type = p_account_type;
    return updated_balance;
  end if;

  if p_exit_epoch < practice_trade.entry_epoch then
    raise exception 'Exit tick must not precede the entry tick' using errcode = '22023';
  end if;

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
  where user_id = current_user_id and id = p_trade_id;

  update public.marketpilot_wallets
  set balance = balance + settled_payout, updated_at = pg_catalog.now()
  where user_id = current_user_id and account_type = p_account_type
  returning balance into updated_balance;

  if updated_balance is null then
    raise exception 'Wallet settlement failed' using errcode = 'P0001';
  end if;

  return updated_balance;
end;
$$;

revoke all on function public.marketpilot_open_practice_trade(text, text, text, text, integer, integer, numeric, numeric, numeric, numeric, integer, bigint) from public, anon, authenticated;
revoke all on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) from public, anon, authenticated;
grant execute on function public.marketpilot_open_practice_trade(text, text, text, text, integer, integer, numeric, numeric, numeric, numeric, integer, bigint) to authenticated;
grant execute on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) to authenticated;
