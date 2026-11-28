begin;

comment on column public.marketpilot_transactions.welcome_bonus_usd
  is '50% deposit bonus credited with this deposit, in USD.';

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
  v_deposit_bonus numeric := 0;
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

  v_deposit_bonus := pg_catalog.round(v_transaction.amount_usd * 0.5, 2);

  update public.marketpilot_wallets as wallet
  set balance = wallet.balance + v_transaction.amount_usd + v_deposit_bonus,
      updated_at = pg_catalog.now()
  where wallet.user_id = v_transaction.user_id
    and wallet.account_type = 'real'
  returning wallet.balance into v_balance;
  if v_balance is null then
    raise exception 'Real wallet was not found during deposit settlement' using errcode = 'P0001';
  end if;

  update public.marketpilot_transactions
  set status = 'completed',
      welcome_bonus_usd = v_deposit_bonus,
      megapay_transaction_id = p_provider_transaction_id,
      megapay_receipt = nullif(pg_catalog.btrim(p_receipt), ''),
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  where id = v_transaction.id;

  return pg_catalog.jsonb_build_object(
    'status', 'completed',
    'balance', v_balance,
    'welcomeBonusUsd', v_deposit_bonus
  );
end;
$$;

revoke all on function public.marketpilot_payment_complete_deposit(text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.marketpilot_payment_complete_deposit(text, text, text, numeric, text, text) to service_role;

notify pgrst, 'reload schema';

commit;
