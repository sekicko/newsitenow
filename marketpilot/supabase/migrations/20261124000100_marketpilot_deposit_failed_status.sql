begin;

alter table public.marketpilot_transactions
  drop constraint if exists marketpilot_transactions_status_check;

update public.marketpilot_transactions
set status = 'failed',
    updated_at = pg_catalog.now()
where transaction_type = 'deposit'
  and status = 'declined';

alter table public.marketpilot_transactions
  add constraint marketpilot_transactions_status_check
  check (
    (transaction_type = 'deposit' and status in ('pending', 'completed', 'failed'))
    or
    (transaction_type = 'withdrawal' and status in ('pending', 'completed', 'declined'))
  );

create or replace function public.marketpilot_payment_mark_deposit_failed(
  p_transaction_id uuid,
  p_reason text
)
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
  set status = 'failed',
      failure_reason = pg_catalog.left(
        coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'Deposit confirmation failed.'),
        500
      ),
      updated_at = pg_catalog.now()
  where id = p_transaction_id
    and transaction_type = 'deposit'
    and status = 'pending';
end;
$$;

create or replace function public.marketpilot_payment_mark_deposit_declined(
  p_transaction_id uuid,
  p_reason text
)
returns void
language sql
security definer
set search_path = ''
as $$
  select public.marketpilot_payment_mark_deposit_failed(p_transaction_id, p_reason);
$$;

revoke all on function public.marketpilot_payment_mark_deposit_declined(uuid, text) from public, anon, authenticated;
grant execute on function public.marketpilot_payment_mark_deposit_declined(uuid, text) to service_role;
revoke all on function public.marketpilot_payment_mark_deposit_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.marketpilot_payment_mark_deposit_failed(uuid, text) to service_role;

commit;
