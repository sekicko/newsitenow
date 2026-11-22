create or replace function public.marketpilot_reset_demo_wallet()
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

  update public.marketpilot_wallets
  set balance = 10000, updated_at = pg_catalog.now()
  where user_id = current_user_id
    and account_type = 'demo'
  returning balance into updated_balance;

  if updated_balance is null then
    raise exception 'Demo wallet was not found' using errcode = 'P0001';
  end if;

  return updated_balance;
end;
$$;

revoke all on function public.marketpilot_reset_demo_wallet() from public, anon, authenticated;
grant execute on function public.marketpilot_reset_demo_wallet() to authenticated;
