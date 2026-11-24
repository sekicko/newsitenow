begin;

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
  if p_amount_usd is null or p_amount_usd < 1 then
    raise exception 'Withdrawal amount must be at least $1.00' using errcode = '22023';
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

create or replace function public.marketpilot_create_withdrawal(p_amount_usd numeric)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  current_phone text;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select profile.phone_e164
  into current_phone
  from public.marketpilot_profiles as profile
  where profile.id = current_user_id;

  if current_phone is null then
    raise exception 'A valid phone number is required for M-Pesa withdrawals' using errcode = 'P0001';
  end if;

  return public.marketpilot_create_withdrawal(p_amount_usd, current_phone);
end;
$$;

revoke all on function public.marketpilot_create_withdrawal(numeric) from public, anon;
grant execute on function public.marketpilot_create_withdrawal(numeric) to authenticated;

notify pgrst, 'reload schema';

commit;
