update public.marketpilot_profiles
set
  full_name = coalesce(nullif(btrim(full_name), ''), 'Account'),
  display_name = coalesce(nullif(btrim(display_name), ''), 'user_' || substr(replace(id::text, '-', ''), 1, 19));

alter table public.marketpilot_profiles
  alter column full_name set not null,
  alter column display_name set not null;

create or replace function public.handle_marketpilot_user_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_full_name text;
  profile_display_name text;
  profile_phone text;
  profile_terms_accepted_at timestamptz;
begin
  profile_full_name := nullif(btrim(new.raw_user_meta_data ->> 'full_name'), '');
  profile_display_name := nullif(btrim(new.raw_user_meta_data ->> 'display_name'), '');
  profile_phone := nullif(btrim(new.raw_user_meta_data ->> 'phone_e164'), '');
  profile_terms_accepted_at :=
    nullif(new.raw_user_meta_data ->> 'terms_accepted_at', '')::timestamptz;

  if new.email is null
    or profile_display_name is null
    or profile_phone is null
    or profile_terms_accepted_at is null then
    raise exception 'MarketPilot account details are incomplete';
  end if;

  if profile_display_name !~ '^[A-Za-z0-9_]{3,24}$' then
    raise exception 'Invalid MarketPilot display name';
  end if;

  insert into public.marketpilot_profiles (
    id,
    full_name,
    display_name,
    email,
    phone_e164,
    terms_accepted_at
  ) values (
    new.id,
    coalesce(profile_full_name, 'Account'),
    profile_display_name,
    lower(btrim(new.email)),
    profile_phone,
    profile_terms_accepted_at
  );

  return new;
end;
$$;
