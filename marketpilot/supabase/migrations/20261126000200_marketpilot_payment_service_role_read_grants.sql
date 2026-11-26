begin;

grant select on table public.marketpilot_transactions to service_role;
grant select on table public.marketpilot_wallets to service_role;

commit;
