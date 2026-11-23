begin;

create or replace function public.marketpilot_create_deposit(p_amount_usd numeric)
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
    raise exception 'A valid phone number is required to make an M-Pesa deposit' using errcode = 'P0001';
  end if;

  return public.marketpilot_create_deposit(p_amount_usd, current_phone);
end;
$$;

revoke all on function public.marketpilot_create_deposit(numeric) from public, anon;
grant execute on function public.marketpilot_create_deposit(numeric) to authenticated;

notify pgrst, 'reload schema';

commit;
