# MarketPilot

MarketPilot is a standalone Demo trading dashboard in this workspace. The main project remains unchanged.

## Run locally

Use Node.js 20.9 or newer:

```bash
cd marketpilot
npm install
npm run dev
```

The app connects directly from the browser to Deriv's public WebSocket endpoint (`wss://api.derivws.com/trading/v1/options/ws/public`). To use a registered app URL, set `DERIV_WS_URL` in `.env.local` (see `.env.example`).

Market symbols, live ticks, tick history, supported contracts, price proposals, and market exit prices/digits come from Deriv. Demo outcomes are settled against actual market exits. When Deriv cannot supply data or a proposal, the dashboard reports that state and does not substitute generated prices or payouts. No contract is submitted or purchased.

The market picker is restricted to the ten continuous volatility indices (`R_10`, `R_25`, `R_50`, `R_75`, `R_100`, `1HZ10V`, `1HZ25V`, `1HZ50V`, `1HZ75V`, and `1HZ100V`) and lists only symbols returned by Deriv. The TradingView Lightweight Charts view can switch between an area line of actual ticks and actual provider OHLC candlesticks. Its 1m, 5m, 15m, 30m, and 1h controls request the selected interval's historical data; the candlestick view uses that interval as its candle granularity. The default interval is 1m.

## Account setup

MarketPilot uses Supabase Auth for email/password accounts and the `marketpilot_profiles` table for account details. Copy `.env.example` to `.env.local` and set:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY` (server only; required for phone-number sign-in, not email/password signup; never expose or commit this key)

Apply the migrations in `supabase/migrations/` to the Supabase project in timestamp order, including `20261123191000_marketpilot_tick_duration_limits.sql`, `20261123192000_marketpilot_remove_simulated_outcomes.sql`, `20261123201500_marketpilot_fixed_digit_over_under_payouts.sql`, and `20261123203000_marketpilot_profile_settings.sql`. The first final migration disables synthetic outcomes, hides old synthetic trades from the app, and converts any still-open synthetic trades to market-based settlement while preserving stored history and wallet balances. The fixed-payout migration makes digit Over/Under payouts proportional to stake for barriers 1–8. The profile settings migration synchronizes full-name and username edits from Supabase Auth metadata to the MarketPilot profile table. In Supabase Auth URL configuration, allow `http://localhost:3000/auth/callback` and add your production callback URL before deployment. Configure email delivery/SMTP and email confirmation in Supabase Auth to enable account confirmations and password-reset links.

Signed-in users can change their full name and username from Settings and request a password reset email. Phone numbers are not editable in Settings because they are used for sign-in.

To grant administrator access, first create the account, then add its email or Auth user ID to `public.marketpilot_admins` in the Supabase SQL Editor. For example, use `insert into public.marketpilot_admins (email) values (lower('admin@example.com'));` or `insert into public.marketpilot_admins (user_id) values ('AUTH-USER-UUID');`. Admin records cannot be changed by app users. Admins are redirected to `/admin` after signing in; the server page and reporting RPC both verify the admin allowlist.

The admin report defines active accounts as having signed in within 30 days. It shows current real-wallet balances and historical market-based results for the real wallet. Deposits are labeled “Not tracked” until a deposit ledger is implemented.

Registration requires a full name, display username, email, country, phone, password confirmation, and agreement to the Terms and Conditions. Display usernames may be shared. Email and phone sign-in use the same account; phone sign-in resolves the email server-side and does not disclose account lookup results. Password resets are delivered by email.

The profile migration creates profile rows from Supabase Auth users, enforces unique email and phone values, allows shared display usernames, and restricts profile reads with row-level security. The wallet migration creates separate USD Real and Demo wallets for every existing and newly registered user (Real starts at $0.00; Demo starts at $10,000.00). Cashier lets signed-in users view and select either balance; Demo can be reset to $10,000.00. Demo trades require sign-in, reserve the Demo wallet's stake at entry, and settle from market exit data. Previously synthetic trade records are retained in storage but hidden from app history; wallet balances are not recalculated. Real-money deposits and live orders are not supported. The phone sign-in route uses the server-only Supabase secret key for a private profile lookup; the key is never sent to the browser. Do not deploy until all required migrations and Supabase redirect/email settings are configured.
