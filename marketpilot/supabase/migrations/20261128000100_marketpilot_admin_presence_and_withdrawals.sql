begin;

alter table public.marketpilot_profiles
  add column if not exists last_seen_at timestamptz;

create or replace function public.marketpilot_record_activity()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  update public.marketpilot_profiles
  set last_seen_at = pg_catalog.now()
  where id = auth.uid();
  if not found then
    raise exception 'MarketPilot profile was not found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.marketpilot_record_activity() from public, anon;
grant execute on function public.marketpilot_record_activity() to authenticated;

create or replace function public.marketpilot_admin_dashboard_stats()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  today_start_epoch bigint := pg_catalog.date_part(
    'epoch',
    pg_catalog.date_trunc('day', pg_catalog.now() at time zone 'UTC') at time zone 'UTC'
  )::bigint;
begin
  if not public.marketpilot_is_admin() then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'totalUsers',
      (select pg_catalog.count(*) from auth.users),
    'activeUsers',
      (
        select pg_catalog.count(*)
        from public.marketpilot_profiles
        where last_seen_at >= pg_catalog.now() - interval '90 seconds'
      ),
    'dormantUsers',
      (
        select pg_catalog.count(*) from auth.users
      ) - (
        select pg_catalog.count(*)
        from public.marketpilot_profiles
        where last_seen_at >= pg_catalog.now() - interval '90 seconds'
      ),
    'depositsToday', null,
    'realLossesToday',
      coalesce((
        select pg_catalog.sum(-trade.profit)
        from public.marketpilot_practice_trades as trade
        where trade.account_type = 'real'
          and trade.status = 'lost'
          and trade.profit is not null
          and trade.exit_epoch >= today_start_epoch
      ), 0),
    'totalRealBalance',
      coalesce((
        select pg_catalog.sum(wallet.balance)
        from public.marketpilot_wallets as wallet
        where wallet.account_type = 'real'
      ), 0),
    'totalWithdrawn',
      coalesce((
        select pg_catalog.sum(transaction_row.amount_usd)
        from public.marketpilot_transactions as transaction_row
        where transaction_row.transaction_type = 'withdrawal'
          and transaction_row.status = 'completed'
      ), 0),
    'realWinRate',
      (
        select pg_catalog.round(
          100.0 * pg_catalog.count(*) filter (where trade.status = 'won')
          / nullif(pg_catalog.count(*), 0),
          1
        )
        from public.marketpilot_practice_trades as trade
        where trade.account_type = 'real'
          and trade.status in ('won', 'lost')
      ),
    'users',
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'username', coalesce(profile.display_name, 'Unknown'),
            'email', coalesce(user_account.email, ''),
            'phone', profile.phone_e164,
            'activityStatus',
              case
                when profile.last_seen_at >= pg_catalog.now() - interval '90 seconds'
                  then 'Active'
                else 'Offline'
              end,
            'lastSeenAt', profile.last_seen_at,
            'lastLoginAt', user_account.last_sign_in_at,
            'realBalance', coalesce(wallet.balance, 0)
          )
          order by user_account.created_at desc
        )
        from auth.users as user_account
        left join public.marketpilot_profiles as profile
          on profile.id = user_account.id
        left join public.marketpilot_wallets as wallet
          on wallet.user_id = user_account.id
          and wallet.account_type = 'real'
      ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.marketpilot_admin_dashboard_stats() from public, anon, authenticated;
grant execute on function public.marketpilot_admin_dashboard_stats() to authenticated;

notify pgrst, 'reload schema';

commit;
