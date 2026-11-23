begin;

drop function public.marketpilot_create_deposit(numeric);

create function public.marketpilot_create_deposit(
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
  if p_amount_usd is null or p_amount_usd not between 1 and 500 then
    raise exception 'Deposit amount must be between $1.00 and $500.00' using errcode = '22023';
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

commit;
