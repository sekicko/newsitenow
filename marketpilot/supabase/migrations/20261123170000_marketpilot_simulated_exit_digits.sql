alter table public.marketpilot_practice_trades
  add column if not exists simulated_exit_price numeric(24, 12),
  add column if not exists simulated_exit_digit integer
    check (simulated_exit_digit between 0 and 9);

create or replace function public.marketpilot_settle_practice_trade(
  p_trade_id text,
  p_account_type text,
  p_exit_price numeric,
  p_exit_pip_size numeric,
  p_exit_digit integer,
  p_exit_epoch bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_trade public.marketpilot_practice_trades%rowtype;
  v_won boolean;
  v_payout numeric;
  v_balance numeric;
  v_simulated_exit_price numeric;
  v_simulated_exit_digit integer;
  v_price_precision integer;
begin
  if v_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if p_trade_id is null or length(p_trade_id) < 1 or length(p_trade_id) > 100
    or p_account_type is null or p_account_type not in ('real', 'demo')
    or p_exit_price is null or p_exit_pip_size is null or p_exit_pip_size <= 0
    or p_exit_digit is null or p_exit_digit not between 0 and 9
    or p_exit_epoch is null then
    raise exception 'Invalid practice settlement details' using errcode = '22023';
  end if;

  select trade.*
  into v_trade
  from public.marketpilot_practice_trades as trade
  where trade.user_id = v_user_id
    and trade.id = p_trade_id
    and trade.account_type = p_account_type
  for update;

  if not found then
    raise exception 'Practice trade was not found' using errcode = 'P0002';
  end if;

  if v_trade.status <> 'open' then
    select wallet.balance
    into v_balance
    from public.marketpilot_wallets as wallet
    where wallet.user_id = v_user_id
      and wallet.account_type = p_account_type;

    if v_balance is null then
      raise exception 'Wallet was not found' using errcode = 'P0001';
    end if;

    return pg_catalog.jsonb_build_object(
      'balance', v_balance,
      'status', v_trade.status,
      'payout', v_trade.payout,
      'profit', v_trade.profit,
      'outcomeSource', v_trade.outcome_source,
      'testWinProbability', v_trade.test_win_probability,
      'simulatedExitPrice', v_trade.simulated_exit_price,
      'simulatedExitDigit', v_trade.simulated_exit_digit
    );
  end if;

  if p_exit_epoch < v_trade.entry_epoch then
    raise exception 'Exit tick must not precede the entry tick' using errcode = '22023';
  end if;

  if v_trade.outcome_source = 'test_simulation' then
    select outcome.did_win
    into v_won
    from public.marketpilot_test_trade_outcomes as outcome
    where outcome.user_id = v_user_id
      and outcome.trade_id = p_trade_id
      and outcome.account_type = p_account_type;

    if not found then
      raise exception 'Test outcome was not found' using errcode = 'P0001';
    end if;

    if v_trade.contract_type in ('DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF')
      and (v_trade.barrier is null or v_trade.barrier not between 0 and 9) then
      raise exception 'A valid digit barrier is required for this contract' using errcode = '22023';
    end if;

    if (v_trade.contract_type = 'DIGITOVER' and v_trade.barrier = 9)
      or (v_trade.contract_type = 'DIGITUNDER' and v_trade.barrier = 0) then
      v_won := false;
    end if;

    case v_trade.contract_type
      when 'DIGITOVER' then
        v_simulated_exit_digit := p_exit_digit;
        if v_won and v_simulated_exit_digit <= v_trade.barrier then
          v_simulated_exit_digit := v_trade.barrier + 1;
        elsif not v_won and v_simulated_exit_digit > v_trade.barrier then
          v_simulated_exit_digit := v_trade.barrier;
        end if;
      when 'DIGITUNDER' then
        v_simulated_exit_digit := p_exit_digit;
        if v_won and v_simulated_exit_digit >= v_trade.barrier then
          v_simulated_exit_digit := v_trade.barrier - 1;
        elsif not v_won and v_simulated_exit_digit < v_trade.barrier then
          v_simulated_exit_digit := v_trade.barrier;
        end if;
      when 'DIGITEVEN' then
        v_simulated_exit_digit := p_exit_digit;
        if v_simulated_exit_digit % 2 <> (case when v_won then 0 else 1 end) then
          v_simulated_exit_digit := case
            when v_simulated_exit_digit < 9 then v_simulated_exit_digit + 1
            else v_simulated_exit_digit - 1
          end;
        end if;
      when 'DIGITODD' then
        v_simulated_exit_digit := p_exit_digit;
        if v_simulated_exit_digit % 2 <> (case when v_won then 1 else 0 end) then
          v_simulated_exit_digit := case
            when v_simulated_exit_digit < 9 then v_simulated_exit_digit + 1
            else v_simulated_exit_digit - 1
          end;
        end if;
      when 'DIGITMATCH' then
        v_simulated_exit_digit := p_exit_digit;
        if v_won then
          v_simulated_exit_digit := v_trade.barrier;
        elsif v_simulated_exit_digit = v_trade.barrier then
          v_simulated_exit_digit := case when v_trade.barrier = 0 then 1 else 0 end;
        end if;
      when 'DIGITDIFF' then
        v_simulated_exit_digit := p_exit_digit;
        if v_won and v_simulated_exit_digit = v_trade.barrier then
          v_simulated_exit_digit := case when v_trade.barrier = 0 then 1 else 0 end;
        elsif not v_won and v_simulated_exit_digit <> v_trade.barrier then
          v_simulated_exit_digit := v_trade.barrier;
        end if;
      when 'CALL' then
        if (v_won and p_exit_price <= v_trade.entry_price)
          or (not v_won and p_exit_price > v_trade.entry_price) then
          v_simulated_exit_price := case
            when v_won then v_trade.entry_price + p_exit_pip_size
            else case
              when v_trade.entry_price - p_exit_pip_size > v_trade.entry_price / 2
                then v_trade.entry_price - p_exit_pip_size
              else v_trade.entry_price / 2
            end
          end;
        else
          v_simulated_exit_price := p_exit_price;
        end if;
      when 'PUT' then
        if (v_won and p_exit_price >= v_trade.entry_price)
          or (not v_won and p_exit_price < v_trade.entry_price) then
          v_simulated_exit_price := case
            when v_won then case
              when v_trade.entry_price - p_exit_pip_size > v_trade.entry_price / 2
                then v_trade.entry_price - p_exit_pip_size
              else v_trade.entry_price / 2
            end
            else v_trade.entry_price + p_exit_pip_size
          end;
        else
          v_simulated_exit_price := p_exit_price;
        end if;
      else
        raise exception 'Unsupported trade contract type' using errcode = '22023';
    end case;

    if v_trade.contract_type in ('CALL', 'PUT') then
      if p_exit_pip_size >= 1 and p_exit_pip_size = pg_catalog.trunc(p_exit_pip_size) then
        v_price_precision := case
          when p_exit_pip_size::integer > 10 then 10
          else p_exit_pip_size::integer
        end;
      else
        v_price_precision := pg_catalog.round(-pg_catalog.log(10::numeric, p_exit_pip_size))::integer;
        v_price_precision := case
          when v_price_precision < 0 then 0
          when v_price_precision > 10 then 10
          else v_price_precision
        end;
      end if;
      v_simulated_exit_digit := pg_catalog.mod(
        pg_catalog.abs(
          pg_catalog.trunc(
            pg_catalog.round(v_simulated_exit_price, v_price_precision)
            * pg_catalog.power(10::numeric, v_price_precision)
          )::bigint
        ),
        10
      )::integer;
    end if;
  else
    v_won := case v_trade.contract_type
      when 'DIGITOVER' then p_exit_digit > v_trade.barrier
      when 'DIGITUNDER' then p_exit_digit < v_trade.barrier
      when 'DIGITEVEN' then p_exit_digit % 2 = 0
      when 'DIGITODD' then p_exit_digit % 2 = 1
      when 'DIGITMATCH' then p_exit_digit = v_trade.barrier
      when 'DIGITDIFF' then p_exit_digit <> v_trade.barrier
      when 'CALL' then p_exit_price > v_trade.entry_price
      when 'PUT' then p_exit_price < v_trade.entry_price
      else false
    end;
  end if;

  v_payout := case when v_won then v_trade.quoted_payout else 0 end;

  update public.marketpilot_practice_trades as trade
  set status = case when v_won then 'won' else 'lost' end,
      elapsed = trade.duration,
      exit_price = p_exit_price,
      exit_pip_size = p_exit_pip_size,
      exit_digit = p_exit_digit,
      exit_epoch = p_exit_epoch,
      simulated_exit_price = v_simulated_exit_price,
      simulated_exit_digit = v_simulated_exit_digit,
      payout = v_payout,
      profit = v_payout - trade.stake
  where trade.user_id = v_user_id
    and trade.id = p_trade_id
    and trade.account_type = p_account_type;

  update public.marketpilot_wallets as wallet
  set balance = wallet.balance + v_payout,
      updated_at = pg_catalog.now()
  where wallet.user_id = v_user_id
    and wallet.account_type = p_account_type
  returning wallet.balance into v_balance;

  if v_balance is null then
    raise exception 'Wallet settlement failed' using errcode = 'P0001';
  end if;

  delete from public.marketpilot_test_trade_outcomes as outcome
  where outcome.user_id = v_user_id
    and outcome.trade_id = p_trade_id
    and outcome.account_type = p_account_type;

  return pg_catalog.jsonb_build_object(
    'balance', v_balance,
    'status', case when v_won then 'won' else 'lost' end,
    'payout', v_payout,
    'profit', v_payout - v_trade.stake,
    'outcomeSource', v_trade.outcome_source,
    'testWinProbability', v_trade.test_win_probability,
    'simulatedExitPrice', v_simulated_exit_price,
    'simulatedExitDigit', v_simulated_exit_digit
  );
end;
$$;

revoke all on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) from public, anon, authenticated;
grant execute on function public.marketpilot_settle_practice_trade(text, text, numeric, numeric, integer, bigint) to authenticated;