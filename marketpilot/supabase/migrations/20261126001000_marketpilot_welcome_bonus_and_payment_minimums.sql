begin;

alter table public.marketpilot_transactions
  add column welcome_bonus_usd numeric(18, 2) not null default 0
  constraint marketpilot_transactions_welcome_bonus_nonnegative check (welcome_bonus_usd >= 0);

comment on column public.marketpilot_transactions.welcome_bonus_usd
  is 'First-deposit welcome bonus credited with this deposit, in USD.';

create or replace function public.marketpilot_create_deposit(
  p_amount_usd numeric,
  p_phone_e164 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
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
  if p_amount_usd is null or p_amount_usd not between 5 and 500 then
    raise exception 'Deposit amount must be between $5.00 and $500.00' using errcode = '22023';
  end if;
  if p_phone_e164 is null or p_phone_e164 !~ '^[+][1-9][0-9]{7,14}$' then
    raise exception 'A valid international phone number is required for an M-Pesa deposit' using errcode = '22023';
  end if;

  select settings.kes_per_usd
  into current_rate
  from public.marketpilot_payment_settings as settings
  where settings.id;
  if current_rate is null then
    raise exception 'Deposits are not available until an administrator sets the KES/USD rate' using errcode = 'P0001';
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
    p_phone_e164,
    transaction_reference
  )
  returning id into transaction_id;

  return pg_catalog.jsonb_build_object(
    'id', transaction_id,
    'reference', transaction_reference,
    'amountUsd', credited_usd,
    'amountKes', requested_kes,
    'kesPerUsd', current_rate,
    'phone', p_phone_e164
  );
end;
$$;

revoke all on function public.marketpilot_create_deposit(numeric, text) from public, anon;
grant execute on function public.marketpilot_create_deposit(numeric, text) to authenticated;

create or replace function public.marketpilot_create_withdrawal(
  p_amount_usd numeric,
  p_phone_e164 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
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
  if p_amount_usd is null or p_amount_usd < 20 then
    raise exception 'Withdrawal amount must be at least $20.00' using errcode = '22023';
  end if;
  if p_phone_e164 is null or p_phone_e164 !~ '^[+][1-9][0-9]{7,14}$' then
    raise exception 'A valid international phone number is required for M-Pesa withdrawals' using errcode = '22023';
  end if;

  select settings.kes_per_usd
  into current_rate
  from public.marketpilot_payment_settings as settings
  where settings.id;
  if current_rate is null then
    raise exception 'Withdrawals are not available until an administrator sets the KES/USD rate' using errcode = 'P0001';
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
  if requested_usd < 20 then
    raise exception 'Withdrawal amount must be at least $20.00' using errcode = '22023';
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
    p_phone_e164,
    transaction_reference
  )
  returning id into transaction_id;

  return pg_catalog.jsonb_build_object(
    'id', transaction_id,
    'reference', transaction_reference,
    'amountUsd', requested_usd,
    'amountKes', withdrawal_kes,
    'kesPerUsd', current_rate,
    'balance', current_balance - requested_usd
  );
end;
$$;

revoke all on function public.marketpilot_create_withdrawal(numeric, text) from public, anon;
grant execute on function public.marketpilot_create_withdrawal(numeric, text) to authenticated;

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
  v_welcome_bonus numeric := 0;
  v_has_prior_deposit boolean;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Service access is required' using errcode = '42501';
  end if;
  if p_provider_transaction_id is null or p_amount_kes is null or p_msisdn is null or p_reference is null then
    raise exception 'MegaPay did not return all required transaction details' using errcode = '22023';
  end if;

  select transaction_row.*
  into v_transaction
  from public.marketpilot_transactions as transaction_row
  where transaction_row.transaction_type = 'deposit'
    and transaction_row.reference = p_reference
    and (
      (p_request_id is not null and transaction_row.megapay_request_id = p_request_id)
      or
      (p_request_id is null and transaction_row.megapay_request_id is null)
    )
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

    return pg_catalog.jsonb_build_object(
      'status', 'completed',
      'balance', v_balance,
      'welcomeBonusUsd', v_transaction.welcome_bonus_usd
    );
  end if;
  if v_transaction.status <> 'pending' then
    raise exception 'MegaPay deposit is no longer pending' using errcode = 'P0001';
  end if;

  if p_amount_kes <> v_transaction.amount_kes
    or pg_catalog.regexp_replace(p_msisdn, '[^0-9]', '', 'g')
      <> pg_catalog.regexp_replace(v_transaction.phone_e164, '[^0-9]', '', 'g') then
    raise exception 'MegaPay transaction details do not match the pending deposit' using errcode = '22023';
  end if;

  select wallet.balance
  into v_balance
  from public.marketpilot_wallets as wallet
  where wallet.user_id = v_transaction.user_id
    and wallet.account_type = 'real'
  for update;
  if v_balance is null then
    raise exception 'Real wallet was not found during deposit settlement' using errcode = 'P0001';
  end if;

  select exists (
    select 1
    from public.marketpilot_transactions as prior_transaction
    where prior_transaction.user_id = v_transaction.user_id
      and prior_transaction.transaction_type = 'deposit'
      and prior_transaction.status = 'completed'
      and prior_transaction.id <> v_transaction.id
  )
  into v_has_prior_deposit;
  if not v_has_prior_deposit then
    v_welcome_bonus := pg_catalog.round(v_transaction.amount_usd * 0.5, 2);
  end if;

  update public.marketpilot_wallets as wallet
  set balance = wallet.balance + v_transaction.amount_usd + v_welcome_bonus,
      updated_at = pg_catalog.now()
  where wallet.user_id = v_transaction.user_id
    and wallet.account_type = 'real'
  returning wallet.balance into v_balance;
  if v_balance is null then
    raise exception 'Real wallet was not found during deposit settlement' using errcode = 'P0001';
  end if;

  update public.marketpilot_transactions
  set status = 'completed',
      welcome_bonus_usd = v_welcome_bonus,
      megapay_transaction_id = p_provider_transaction_id,
      megapay_receipt = nullif(pg_catalog.btrim(p_receipt), ''),
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = v_transaction.id;

  return pg_catalog.jsonb_build_object(
    'status', 'completed',
    'balance', v_balance,
    'welcomeBonusUsd', v_welcome_bonus
  );
end;
$$;

revoke all on function public.marketpilot_payment_complete_deposit(text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.marketpilot_payment_complete_deposit(text, text, text, numeric, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
