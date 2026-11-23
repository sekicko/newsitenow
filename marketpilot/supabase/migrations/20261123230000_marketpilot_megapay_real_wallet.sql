begin;

create table public.marketpilot_payment_settings (
  id boolean primary key default true check (id),
  kes_per_usd numeric(18, 6) not null check (kes_per_usd between 0.01 and 1000000),
  updated_at timestamptz not null default pg_catalog.now(),
  updated_by uuid references auth.users (id)
);

alter table public.marketpilot_payment_settings enable row level security;
revoke all on public.marketpilot_payment_settings from public, anon, authenticated;

create table public.marketpilot_transactions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  account_type text not null default 'real' check (account_type = 'real'),
  transaction_type text not null check (transaction_type in ('deposit', 'withdrawal')),
  status text not null default 'pending' check (status in ('pending', 'completed', 'declined')),
  amount_usd numeric(18, 2) not null check (amount_usd > 0),
  amount_kes numeric(18, 0) not null check (amount_kes > 0),
  kes_per_usd numeric(18, 6) not null check (kes_per_usd > 0),
  phone_e164 text not null check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  reference text not null unique,
  megapay_request_id text unique,
  megapay_transaction_id text unique,
  megapay_receipt text,
  admin_receipt text,
  failure_reason text,
  admin_approved_at timestamptz,
  admin_approved_by uuid references auth.users (id),
  completed_at timestamptz,
  completed_by uuid references auth.users (id),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create index marketpilot_transactions_user_created_idx
  on public.marketpilot_transactions (user_id, created_at desc);
create index marketpilot_transactions_status_created_idx
  on public.marketpilot_transactions (status, created_at desc);

alter table public.marketpilot_transactions enable row level security;
revoke all on public.marketpilot_transactions from public, anon, authenticated;
grant select on public.marketpilot_transactions to authenticated;

create policy "Users can read their own MarketPilot transactions"
  on public.marketpilot_transactions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.marketpilot_get_kes_per_usd()
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select settings.kes_per_usd
  from public.marketpilot_payment_settings as settings
  where settings.id;
$$;

revoke all on function public.marketpilot_get_kes_per_usd() from public, anon;
grant execute on function public.marketpilot_get_kes_per_usd() to authenticated;

create or replace function public.marketpilot_admin_set_kes_per_usd(p_rate numeric)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_user_id uuid := auth.uid();
begin
  if not public.marketpilot_is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if p_rate is null or p_rate not between 0.01 and 1000000 then
    raise exception 'KES per USD rate must be between 0.01 and 1,000,000' using errcode = '22023';
  end if;

  insert into public.marketpilot_payment_settings (id, kes_per_usd, updated_at, updated_by)
  values (true, p_rate, pg_catalog.now(), admin_user_id)
  on conflict (id) do update
  set kes_per_usd = excluded.kes_per_usd,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by;

  return p_rate;
end;
$$;

revoke all on function public.marketpilot_admin_set_kes_per_usd(numeric) from public, anon, authenticated;
grant execute on function public.marketpilot_admin_set_kes_per_usd(numeric) to authenticated;

create or replace function public.marketpilot_create_deposit(p_amount_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_phone text;
  current_rate numeric;
  requested_usd numeric;
  requested_kes numeric;
  credited_usd numeric;
  transaction_id uuid;
  transaction_reference text;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_amount_usd is null or p_amount_usd < 1 then
    raise exception 'Deposit amount must be at least $1.00' using errcode = '22023';
  end if;

  select settings.kes_per_usd
  into current_rate
  from public.marketpilot_payment_settings as settings
  where settings.id;
  if current_rate is null then
    raise exception 'Deposits are not available until an administrator sets the KES/USD rate' using errcode = 'P0001';
  end if;

  select profile.phone_e164
  into current_phone
  from public.marketpilot_profiles as profile
  where profile.id = current_user_id;
  if current_phone is null then
    raise exception 'A valid phone number is required to make an M-Pesa deposit' using errcode = 'P0001';
  end if;

  requested_usd := pg_catalog.round(p_amount_usd, 2);
  requested_kes := pg_catalog.round(requested_usd * current_rate, 0);
  if requested_kes < 1 then
    raise exception 'Deposit amount is below the minimum M-Pesa amount' using errcode = '22023';
  end if;
  if requested_kes > 999999999999999999 then
    raise exception 'Deposit amount exceeds the supported M-Pesa transaction limit' using errcode = '22023';
  end if;
  credited_usd := pg_catalog.round(requested_kes / current_rate, 2);
  if credited_usd > 9999999999999999.99 then
    raise exception 'Deposit amount exceeds the supported wallet limit' using errcode = '22023';
  end if;
  transaction_reference := 'MP-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');

  insert into public.marketpilot_transactions (
    user_id,
    transaction_type,
    amount_usd,
    amount_kes,
    kes_per_usd,
    phone_e164,
    reference
  ) values (
    current_user_id,
    'deposit',
    credited_usd,
    requested_kes,
    current_rate,
    current_phone,
    transaction_reference
  )
  returning id into transaction_id;

  return pg_catalog.jsonb_build_object(
    'id', transaction_id,
    'reference', transaction_reference,
    'amountUsd', credited_usd,
    'amountKes', requested_kes,
    'kesPerUsd', current_rate,
    'phone', current_phone
  );
end;
$$;

revoke all on function public.marketpilot_create_deposit(numeric) from public, anon;
grant execute on function public.marketpilot_create_deposit(numeric) to authenticated;

create or replace function public.marketpilot_create_withdrawal(p_amount_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_phone text;
  current_rate numeric;
  current_balance numeric;
  requested_usd numeric;
  withdrawal_kes numeric;
  transaction_id uuid;
  transaction_reference text;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_amount_usd is null or p_amount_usd < 1 then
    raise exception 'Withdrawal amount must be at least $1.00' using errcode = '22023';
  end if;

  select settings.kes_per_usd
  into current_rate
  from public.marketpilot_payment_settings as settings
  where settings.id;
  if current_rate is null then
    raise exception 'Withdrawals are not available until an administrator sets the KES/USD rate' using errcode = 'P0001';
  end if;

  select profile.phone_e164
  into current_phone
  from public.marketpilot_profiles as profile
  where profile.id = current_user_id;
  if current_phone is null then
    raise exception 'A valid phone number is required for M-Pesa withdrawals' using errcode = 'P0001';
  end if;

  select wallet.balance
  into current_balance
  from public.marketpilot_wallets as wallet
  where wallet.user_id = current_user_id
    and wallet.account_type = 'real'
  for update;
  if current_balance is null then
    raise exception 'Real wallet was not found' using errcode = 'P0001';
  end if;
  requested_usd := pg_catalog.round(p_amount_usd, 2);
  if requested_usd < 1 then
    raise exception 'Withdrawal amount must be at least $1.00' using errcode = '22023';
  end if;
  if current_balance < requested_usd then
    raise exception 'Insufficient Real wallet balance' using errcode = 'P0001';
  end if;

  withdrawal_kes := pg_catalog.round(requested_usd * current_rate, 0);
  if withdrawal_kes < 1 then
    raise exception 'Withdrawal amount is below the minimum M-Pesa amount' using errcode = '22023';
  end if;
  if requested_usd > 9999999999999999.99 or withdrawal_kes > 999999999999999999 then
    raise exception 'Withdrawal amount exceeds the supported transaction limit' using errcode = '22023';
  end if;

  update public.marketpilot_wallets as wallet
  set balance = wallet.balance - requested_usd,
      updated_at = pg_catalog.now()
  where wallet.user_id = current_user_id
    and wallet.account_type = 'real';

  transaction_reference := 'MW-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  insert into public.marketpilot_transactions (
    user_id,
    transaction_type,
    amount_usd,
    amount_kes,
    kes_per_usd,
    phone_e164,
    reference
  ) values (
    current_user_id,
    'withdrawal',
    requested_usd,
    withdrawal_kes,
    current_rate,
    current_phone,
    transaction_reference
  )
  returning id into transaction_id;

  return pg_catalog.jsonb_build_object(
    'id', transaction_id,
    'reference', transaction_reference,
    'amountUsd',     requested_usd,
    'amountKes', withdrawal_kes,
    'kesPerUsd', current_rate,
    'balance', current_balance - requested_usd
  );
end;
$$;

revoke all on function public.marketpilot_create_withdrawal(numeric) from public, anon;
grant execute on function public.marketpilot_create_withdrawal(numeric) to authenticated;

create or replace function public.marketpilot_payment_attach_request(p_transaction_id uuid, p_request_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service access is required' using errcode = '42501';
  end if;
  if p_transaction_id is null or p_request_id is null or length(p_request_id) not between 1 and 200 then
    raise exception 'Invalid MegaPay request details' using errcode = '22023';
  end if;

  update public.marketpilot_transactions
  set megapay_request_id = p_request_id,
      updated_at = pg_catalog.now()
  where id = p_transaction_id
    and transaction_type = 'deposit'
    and status = 'pending'
    and megapay_request_id is null;
  if not found then
    raise exception 'Pending deposit could not be linked to MegaPay' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.marketpilot_payment_attach_request(uuid, text) from public, anon, authenticated;
grant execute on function public.marketpilot_payment_attach_request(uuid, text) to service_role;

create or replace function public.marketpilot_payment_mark_deposit_declined(p_transaction_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service access is required' using errcode = '42501';
  end if;

  update public.marketpilot_transactions
  set status = 'declined',
      failure_reason = pg_catalog.left(coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'MegaPay did not complete the payment.'), 500),
      updated_at = pg_catalog.now()
  where id = p_transaction_id
    and transaction_type = 'deposit'
    and status = 'pending';
end;
$$;

revoke all on function public.marketpilot_payment_mark_deposit_declined(uuid, text) from public, anon, authenticated;
grant execute on function public.marketpilot_payment_mark_deposit_declined(uuid, text) to service_role;

create or replace function public.marketpilot_payment_complete_deposit(
  p_request_id text,
  p_provider_transaction_id text,
  p_receipt text,
  p_amount_kes numeric,
  p_msisdn text,
  p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transaction public.marketpilot_transactions%rowtype;
  v_balance numeric;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service access is required' using errcode = '42501';
  end if;
  if p_request_id is null or p_provider_transaction_id is null or p_amount_kes is null or p_msisdn is null or p_reference is null then
    raise exception 'MegaPay did not return all required transaction details' using errcode = '22023';
  end if;

  select transaction_row.*
  into v_transaction
  from public.marketpilot_transactions as transaction_row
  where transaction_row.megapay_request_id = p_request_id
    and transaction_row.transaction_type = 'deposit'
  for update;
  if not found then
    raise exception 'MegaPay deposit was not found' using errcode = 'P0002';
  end if;

  if v_transaction.status = 'completed' then
    select wallet.balance
    into v_balance
    from public.marketpilot_wallets as wallet
    where wallet.user_id = v_transaction.user_id
      and wallet.account_type = 'real';

    return pg_catalog.jsonb_build_object('status', 'completed', 'balance', v_balance);
  end if;
  if v_transaction.status <> 'pending' then
    raise exception 'MegaPay deposit is no longer pending' using errcode = 'P0001';
  end if;

  if p_amount_kes <> v_transaction.amount_kes
    or pg_catalog.regexp_replace(p_msisdn, '[^0-9]', '', 'g')
      <> pg_catalog.regexp_replace(v_transaction.phone_e164, '[^0-9]', '', 'g')
    or p_reference <> v_transaction.reference then
    raise exception 'MegaPay transaction details do not match the pending deposit' using errcode = '22023';
  end if;

  update public.marketpilot_wallets as wallet
  set balance = wallet.balance + v_transaction.amount_usd,
      updated_at = pg_catalog.now()
  where wallet.user_id = v_transaction.user_id
    and wallet.account_type = 'real'
  returning wallet.balance into v_balance;
  if v_balance is null then
    raise exception 'Real wallet was not found during deposit settlement' using errcode = 'P0001';
  end if;

  update public.marketpilot_transactions
  set status = 'completed',
      megapay_transaction_id = p_provider_transaction_id,
      megapay_receipt = nullif(pg_catalog.btrim(p_receipt), ''),
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = v_transaction.id;

  return pg_catalog.jsonb_build_object('status', 'completed', 'balance', v_balance);
end;
$$;

revoke all on function public.marketpilot_payment_complete_deposit(text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.marketpilot_payment_complete_deposit(text, text, text, numeric, text, text) to service_role;

create or replace function public.marketpilot_admin_process_withdrawal(
  p_transaction_id uuid,
  p_action text,
  p_admin_receipt text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_admin_id uuid := auth.uid();
  v_transaction public.marketpilot_transactions%rowtype;
begin
  if not public.marketpilot_is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if p_transaction_id is null or p_action not in ('approve', 'complete', 'decline') then
    raise exception 'Invalid withdrawal action' using errcode = '22023';
  end if;

  select transaction_row.*
  into v_transaction
  from public.marketpilot_transactions as transaction_row
  where transaction_row.id = p_transaction_id
  for update;
  if not found or v_transaction.transaction_type <> 'withdrawal' then
    raise exception 'Pending withdrawal was not found' using errcode = 'P0002';
  end if;
  if v_transaction.status <> 'pending' then
    raise exception 'Withdrawal is no longer pending' using errcode = 'P0001';
  end if;

  if p_action = 'approve' then
    if v_transaction.admin_approved_at is not null then
      raise exception 'Withdrawal has already been approved' using errcode = 'P0001';
    end if;
    update public.marketpilot_transactions
    set admin_approved_at = pg_catalog.now(),
        admin_approved_by = current_admin_id,
        updated_at = pg_catalog.now()
    where id = p_transaction_id;
  elsif p_action = 'complete' then
    if v_transaction.admin_approved_at is null then
      raise exception 'Approve the withdrawal before marking it paid' using errcode = 'P0001';
    end if;
    if p_admin_receipt is null or pg_catalog.char_length(pg_catalog.btrim(p_admin_receipt)) not between 1 and 200 then
      raise exception 'Enter the M-Pesa receipt or payment reference before marking this withdrawal paid' using errcode = '22023';
    end if;
    update public.marketpilot_transactions
    set status = 'completed',
        admin_receipt = pg_catalog.btrim(p_admin_receipt),
        completed_at = pg_catalog.now(),
        completed_by = current_admin_id,
        updated_at = pg_catalog.now()
    where id = p_transaction_id;
  else
    update public.marketpilot_wallets
    set balance = balance + v_transaction.amount_usd,
        updated_at = pg_catalog.now()
    where user_id = v_transaction.user_id
      and account_type = 'real';
    if not found then
      raise exception 'Real wallet was not found while declining withdrawal' using errcode = 'P0001';
    end if;
    update public.marketpilot_transactions
    set status = 'declined',
        completed_at = pg_catalog.now(),
        completed_by = current_admin_id,
        failure_reason = 'Withdrawal declined by administrator.',
        updated_at = pg_catalog.now()
    where id = p_transaction_id;
  end if;
end;
$$;

revoke all on function public.marketpilot_admin_process_withdrawal(uuid, text, text) from public, anon, authenticated;
grant execute on function public.marketpilot_admin_process_withdrawal(uuid, text, text) to authenticated;

create or replace function public.marketpilot_admin_list_transactions()
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

  return coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', transaction_row.id,
        'username', coalesce(profile.display_name, 'Unknown'),
        'email', coalesce(user_account.email, ''),
        'type', transaction_row.transaction_type,
        'status', transaction_row.status,
        'amountUsd', transaction_row.amount_usd,
        'amountKes', transaction_row.amount_kes,
        'kesPerUsd', transaction_row.kes_per_usd,
        'phone', transaction_row.phone_e164,
        'reference', transaction_row.reference,
        'megapayReceipt', transaction_row.megapay_receipt,
        'adminReceipt', transaction_row.admin_receipt,
        'approved', transaction_row.admin_approved_at is not null,
        'createdAt', transaction_row.created_at
      )
      order by transaction_row.created_at desc
    )
    from public.marketpilot_transactions as transaction_row
    join auth.users as user_account on user_account.id = transaction_row.user_id
    left join public.marketpilot_profiles as profile on profile.id = transaction_row.user_id
    where transaction_row.status = 'pending'
       or transaction_row.created_at >= pg_catalog.now() - interval '30 days'
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.marketpilot_admin_list_transactions() from public, anon, authenticated;
grant execute on function public.marketpilot_admin_list_transactions() to authenticated;

create or replace function public.marketpilot_admin_deposits_today()
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

  return coalesce((
    select pg_catalog.sum(transaction_row.amount_usd)
    from public.marketpilot_transactions as transaction_row
    where transaction_row.transaction_type = 'deposit'
      and transaction_row.status = 'completed'
      and transaction_row.completed_at >= (
        pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC') at time zone 'UTC'
      )
  ), 0);
end;
$$;

revoke all on function public.marketpilot_admin_deposits_today() from public, anon, authenticated;
grant execute on function public.marketpilot_admin_deposits_today() to authenticated;

commit;
