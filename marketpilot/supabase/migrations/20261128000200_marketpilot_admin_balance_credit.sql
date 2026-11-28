begin;

create or replace function public.marketpilot_admin_credit_user_balance(
  p_user_id uuid,
  p_amount_usd numeric,
  p_credit_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin_id uuid := auth.uid();
  v_amount_usd numeric;
  v_amount_kes numeric;
  v_kes_per_usd numeric;
  v_phone text;
  v_balance numeric;
  v_reference text;
  v_existing public.marketpilot_transactions%rowtype;
  v_transaction_id uuid;
begin
  if not public.marketpilot_is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if p_user_id is null or p_credit_id is null or p_amount_usd is null or p_amount_usd <= 0 then
    raise exception 'Enter a positive balance credit amount' using errcode = '22023';
  end if;

  v_amount_usd := pg_catalog.round(p_amount_usd, 2);
  if v_amount_usd <= 0 or v_amount_usd > 9999999999999999.99 then
    raise exception 'Balance credit amount is outside the supported range' using errcode = '22023';
  end if;
  v_reference := 'ADMIN-' || p_credit_id::text;

  select transaction_row.*
  into v_existing
  from public.marketpilot_transactions as transaction_row
  where transaction_row.reference = v_reference;
  if found then
    if v_existing.user_id <> p_user_id
      or v_existing.transaction_type <> 'deposit'
      or v_existing.amount_usd <> v_amount_usd
      or v_existing.admin_receipt <> 'Admin balance credit' then
      raise exception 'Balance credit reference has already been used' using errcode = '23505';
    end if;
    select wallet.balance
    into v_balance
    from public.marketpilot_wallets as wallet
    where wallet.user_id = p_user_id
      and wallet.account_type = 'real';
    return pg_catalog.jsonb_build_object(
      'balance', v_balance,
      'amountUsd', v_existing.amount_usd,
      'transactionId', v_existing.id
    );
  end if;

  select profile.phone_e164
  into v_phone
  from public.marketpilot_profiles as profile
  where profile.id = p_user_id;
  if not found then
    raise exception 'The selected user profile was not found' using errcode = 'P0002';
  end if;

  select settings.kes_per_usd
  into v_kes_per_usd
  from public.marketpilot_payment_settings as settings
  where settings.id;
  if v_kes_per_usd is null then
    raise exception 'Set the KES per USD exchange rate before issuing balance credits' using errcode = 'P0001';
  end if;

  v_amount_kes := pg_catalog.round(v_amount_usd * v_kes_per_usd, 0);
  if v_amount_kes < 1 or v_amount_kes > 999999999999999999 then
    raise exception 'Balance credit is outside the supported KES transaction range' using errcode = '22023';
  end if;

  select wallet.balance
  into v_balance
  from public.marketpilot_wallets as wallet
  where wallet.user_id = p_user_id
    and wallet.account_type = 'real'
  for update;
  if v_balance is null then
    raise exception 'The selected user Real wallet was not found' using errcode = 'P0002';
  end if;

  update public.marketpilot_wallets as wallet
  set balance = wallet.balance + v_amount_usd,
      updated_at = pg_catalog.now()
  where wallet.user_id = p_user_id
    and wallet.account_type = 'real'
  returning wallet.balance into v_balance;

  insert into public.marketpilot_transactions (
    user_id,
    transaction_type,
    status,
    amount_usd,
    amount_kes,
    kes_per_usd,
    phone_e164,
    reference,
    admin_receipt,
    completed_at,
    completed_by
  ) values (
    p_user_id,
    'deposit',
    'completed',
    v_amount_usd,
    v_amount_kes,
    v_kes_per_usd,
    v_phone,
    v_reference,
    'Admin balance credit',
    pg_catalog.now(),
    v_admin_id
  )
  returning id into v_transaction_id;

  return pg_catalog.jsonb_build_object(
    'balance', v_balance,
    'amountUsd', v_amount_usd,
    'transactionId', v_transaction_id
  );
end;
$$;

revoke all on function public.marketpilot_admin_credit_user_balance(uuid, numeric, uuid) from public, anon, authenticated;
grant execute on function public.marketpilot_admin_credit_user_balance(uuid, numeric, uuid) to authenticated;

create or replace function public.marketpilot_admin_list_user_ids()
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
        'email', pg_catalog.lower(coalesce(user_account.email, '')),
        'id', user_account.id
      )
    )
    from auth.users as user_account
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.marketpilot_admin_list_user_ids() from public, anon, authenticated;
grant execute on function public.marketpilot_admin_list_user_ids() to authenticated;

notify pgrst, 'reload schema';

commit;
