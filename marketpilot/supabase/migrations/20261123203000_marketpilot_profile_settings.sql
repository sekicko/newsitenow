create or replace function public.marketpilot_sync_profile_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_full_name text;
  profile_display_name text;
begin
  if new.raw_user_meta_data ? 'full_name'
    or new.raw_user_meta_data ? 'display_name' then
    profile_full_name := nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name'), '');
    profile_display_name := nullif(pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name'), '');

    if profile_full_name is null or pg_catalog.char_length(profile_full_name) not between 2 and 120 then
      raise exception 'Full name must be 2–120 characters' using errcode = '22023';
    end if;
    if profile_display_name is null or profile_display_name !~ '^[A-Za-z0-9_]{3,24}$' then
      raise exception 'Username must be 3–24 characters using letters, numbers, or underscores' using errcode = '22023';
    end if;

    update public.marketpilot_profiles
    set full_name = profile_full_name,
        display_name = profile_display_name
    where id = new.id;

    if not found then
      raise exception 'MarketPilot profile was not found' using errcode = 'P0002';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.marketpilot_sync_profile_settings() from public, anon, authenticated;

drop trigger if exists on_marketpilot_profile_settings_updated on auth.users;
create trigger on_marketpilot_profile_settings_updated
  after update of raw_user_meta_data on auth.users
  for each row execute procedure public.marketpilot_sync_profile_settings();
