begin;

create table public.marketpilot_deposit_share_totals (
  id boolean primary key default true check (id),
  owner_share_usd numeric(18, 2) not null default 0 check (owner_share_usd >= 0),
  dev_share_usd numeric(18, 2) not null default 0 check (dev_share_usd >= 0),
  updated_at timestamptz not null default pg_catalog.now()
);

insert into public.marketpilot_deposit_share_totals (id)
values (true);

alter table public.marketpilot_deposit_share_totals enable row level security;
revoke all on public.marketpilot_deposit_share_totals from public, anon, authenticated;

create table public.marketpilot_deposit_share_entries (
  deposit_transaction_id uuid primary key
    references public.marketpilot_transactions (id) on delete restrict,
  deposit_amount_usd numeric(18, 2) not null check (deposit_amount_usd > 0),
  owner_share_usd numeric(18, 2) not null check (owner_share_usd >= 0),
  dev_share_usd numeric(18, 2) not null check (dev_share_usd >= 0),
  recorded_at timestamptz not null default pg_catalog.now()
);

alter table public.marketpilot_deposit_share_entries enable row level security;
revoke all on public.marketpilot_deposit_share_entries from public, anon, authenticated;

create table public.marketpilot_deposit_share_resets (
  id bigint generated always as identity primary key,
  owner_share_usd numeric(18, 2) not null check (owner_share_usd >= 0),
  dev_share_usd numeric(18, 2) not null check (dev_share_usd >= 0),
  reset_by uuid not null references auth.users (id),
  reset_at timestamptz not null default pg_catalog.now()
);

alter table public.marketpilot_deposit_share_resets enable row level security;
revoke all on public.marketpilot_deposit_share_resets from public, anon, authenticated;

create or replace function public.marketpilot_record_deposit_share()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_share numeric;
  v_dev_share numeric;
  v_recorded_transaction_id uuid;
begin
  if new.transaction_type <> 'deposit'
    or new.status <> 'completed'
    or new.megapay_transaction_id is null
    or old.status = 'completed' then
    return new;
  end if;

  v_owner_share := pg_catalog.round(new.amount_usd * 0.60, 2);
  v_dev_share := new.amount_usd - v_owner_share;

  insert into public.marketpilot_deposit_share_entries (
    deposit_transaction_id,
    deposit_amount_usd,
    owner_share_usd,
    dev_share_usd
  ) values (
    new.id,
    new.amount_usd,
    v_owner_share,
    v_dev_share
  )
  on conflict (deposit_transaction_id) do nothing
  returning deposit_transaction_id into v_recorded_transaction_id;

  if v_recorded_transaction_id is not null then
    update public.marketpilot_deposit_share_totals
    set owner_share_usd = owner_share_usd + v_owner_share,
        dev_share_usd = dev_share_usd + v_dev_share,
        updated_at = pg_catalog.now()
    where id;
  end if;

  return new;
end;
$$;

revoke all on function public.marketpilot_record_deposit_share() from public, anon, authenticated;

create trigger marketpilot_record_deposit_share_on_completion
  after update of status on public.marketpilot_transactions
  for each row
  when (
    old.status is distinct from new.status
    and new.status = 'completed'
    and new.transaction_type = 'deposit'
    and new.megapay_transaction_id is not null
  )
  execute function public.marketpilot_record_deposit_share();

create or replace function public.marketpilot_admin_get_deposit_shares()
returns jsonb
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
    select pg_catalog.jsonb_build_object(
      'ownerShareUsd', totals.owner_share_usd,
      'devShareUsd', totals.dev_share_usd
    )
    from public.marketpilot_deposit_share_totals as totals
    where totals.id
  );
end;
$$;

revoke all on function public.marketpilot_admin_get_deposit_shares() from public, anon, authenticated;
grant execute on function public.marketpilot_admin_get_deposit_shares() to authenticated;

create or replace function public.marketpilot_admin_reset_deposit_shares()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid := auth.uid();
  v_owner_share numeric;
  v_dev_share numeric;
begin
  if not public.marketpilot_is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  select totals.owner_share_usd, totals.dev_share_usd
  into v_owner_share, v_dev_share
  from public.marketpilot_deposit_share_totals as totals
  where totals.id
  for update;
  if not found then
    raise exception 'Deposit share totals were not initialized' using errcode = 'P0001';
  end if;

  insert into public.marketpilot_deposit_share_resets (
    owner_share_usd,
    dev_share_usd,
    reset_by
  ) values (
    v_owner_share,
    v_dev_share,
    v_admin_id
  );

  update public.marketpilot_deposit_share_totals
  set owner_share_usd = 0,
      dev_share_usd = 0,
      updated_at = pg_catalog.now()
  where id;

  return pg_catalog.jsonb_build_object(
    'ownerShareUsd', 0,
    'devShareUsd', 0
  );
end;
$$;

revoke all on function public.marketpilot_admin_reset_deposit_shares() from public, anon, authenticated;
grant execute on function public.marketpilot_admin_reset_deposit_shares() to authenticated;

notify pgrst, 'reload schema';

commit;
