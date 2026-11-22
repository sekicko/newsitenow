create table if not exists public.marketpilot_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 120),
  display_name text not null check (display_name ~ '^[A-Za-z0-9_]{3,24}$'),
  email text not null,
  phone_e164 text not null check (phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  terms_accepted_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists marketpilot_profiles_display_name_unique
  on public.marketpilot_profiles (lower(display_name));

create unique index if not exists marketpilot_profiles_email_unique
  on public.marketpilot_profiles (lower(email));

create unique index if not exists marketpilot_profiles_phone_unique
  on public.marketpilot_profiles (phone_e164);

alter table public.marketpilot_profiles enable row level security;

revoke all on public.marketpilot_profiles from anon, authenticated;
grant select on public.marketpilot_profiles to authenticated;

drop policy if exists "Users can read their own MarketPilot profile"
  on public.marketpilot_profiles;
create policy "Users can read their own MarketPilot profile"
  on public.marketpilot_profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

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
    or profile_full_name is null
    or profile_display_name is null
    or profile_phone is null
    or profile_terms_accepted_at is null then
    raise exception 'MarketPilot account details are incomplete';
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
    profile_full_name,
    profile_display_name,
    lower(btrim(new.email)),
    profile_phone,
    profile_terms_accepted_at
  );

  return new;
end;
$$;

revoke all on function public.handle_marketpilot_user_created() from public, anon, authenticated;

drop trigger if exists on_marketpilot_auth_user_created on auth.users;
create trigger on_marketpilot_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_marketpilot_user_created();
