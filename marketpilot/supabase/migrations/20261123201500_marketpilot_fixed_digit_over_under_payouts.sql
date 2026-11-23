begin;

create or replace function public.marketpilot_open_practice_trade(
  p_trade_id text,
  p_account_type text,
  p_symbol text,
  p_contract_type text,
  p_barrier integer,
  p_duration integer,
  p_stake numeric,
  p_quoted_payout numeric,
  p_entry_price numeric,
  p_entry_pip_size numeric,
  p_entry_digit integer,
  p_entry_epoch bigint
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := auth.uid();
  updated_balance numeric;
  quoted_payout numeric;
  fixed_profit numeric;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_account_type = 'real' then
    raise exception 'Real wallet trading is not enabled' using errcode = '42501';
  end if;
  if p_trade_id is null or length(p_trade_id) < 1 or length(p_trade_id) > 100
    or p_account_type not in ('real', 'demo')
    or p_symbol is null or length(p_symbol) < 1
    or p_contract_type is null
    or p_contract_type not in ('DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF', 'CALL', 'PUT')
    or p_duration is null
    or (p_contract_type in ('CALL', 'PUT') and p_duration not between 10 and 30)
    or (p_contract_type in ('DIGITOVER', 'DIGITUNDER', 'DIGITEVEN', 'DIGITODD', 'DIGITMATCH', 'DIGITDIFF') and p_duration not between 1 and 15)
    or p_stake is null or p_stake <= 0
    or p_quoted_payout is null or p_quoted_payout < 0
    or p_entry_price is null or p_entry_pip_size is null or p_entry_pip_size <= 0
    or p_entry_digit not between 0 and 9
    or p_entry_epoch is null then
    raise exception 'Invalid practice trade details' using errcode = '22023';
  end if;

  quoted_payout := p_quoted_payout;
  fixed_profit := case
    when p_contract_type = 'DIGITOVER' then case p_barrier
      when 1 then 0.22
      when 2 then 0.38
      when 3 then 0.61
      when 4 then 0.91
      when 5 then 1.32
      when 6 then 2.11
      when 7 then 3.36
      when 8 then 7.21
      else null
    end
    when p_contract_type = 'DIGITUNDER' then case p_barrier
      when 8 then 0.22
      when 7 then 0.38
      when 6 then 0.61
      when 5 then 0.91
      when 4 then 1.32
      when 3 then 2.11
      when 2 then 3.36
      when 1 then 7.21
      else null
    end
    else null
  end;

  if fixed_profit is not null then
    quoted_payout := pg_catalog.round(p_stake * (1 + fixed_profit), 2);
  end if;

  update public.marketpilot_wallets
  set balance = balance - p_stake, updated_at = pg_catalog.now()
  where user_id = current_user_id
    and account_type = p_account_type
    and balance >= p_stake
  returning balance into updated_balance;

  if updated_balance is null then
    raise exception 'Insufficient wallet balance' using errcode = 'P0001';
  end if;

  insert into public.marketpilot_practice_trades (
    id,
    user_id,
    account_type,
    symbol,
    contract_type,
    barrier,
    duration,
    stake,
    quoted_payout,
    entry_price,
    entry_pip_size,
    entry_digit,
    entry_epoch
  ) values (
    p_trade_id,
    current_user_id,
    p_account_type,
    p_symbol,
    p_contract_type,
    p_barrier,
    p_duration,
    p_stake,
    quoted_payout,
    p_entry_price,
    p_entry_pip_size,
    p_entry_digit,
    p_entry_epoch
  );

  return updated_balance;
end;
$$;

revoke all on function public.marketpilot_open_practice_trade(text, text, text, text, integer, integer, numeric, numeric, numeric, numeric, integer, bigint) from public, anon, authenticated;
grant execute on function public.marketpilot_open_practice_trade(text, text, text, text, integer, integer, numeric, numeric, numeric, numeric, integer, bigint) to authenticated;

commit;
