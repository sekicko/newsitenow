# MarketPilot

MarketPilot is a standalone practice dashboard in this workspace. The main project remains unchanged.

## Run locally

Use Node.js 20.9 or newer:

```bash
cd marketpilot
npm install
npm run dev
```

The app connects directly from the browser to Deriv's public WebSocket endpoint (`wss://api.derivws.com/trading/v1/options/ws/public`). To use a registered app URL, set `DERIV_WS_URL` in `.env.local` (see `.env.example`).

Market symbols, live ticks, tick history, supported contracts, price proposals, and displayed exit prices/digits come from Deriv. When Deriv cannot supply data or a proposal, the dashboard reports that state and does not substitute generated prices or payouts. Practice outcomes can use configurable synthetic test odds, which are clearly labeled and do not alter the displayed market exit data. No contract is submitted or purchased.

The market picker is restricted to the ten continuous volatility indices (`R_10`, `R_25`, `R_50`, `R_75`, `R_100`, `1HZ10V`, `1HZ25V`, `1HZ50V`, `1HZ75V`, and `1HZ100V`) and lists only symbols returned by Deriv. The TradingView Lightweight Charts view can switch between an area line of actual ticks and actual provider OHLC candlesticks. Its 1m, 5m, 15m, 30m, and 1h controls request the selected interval's historical data; the candlestick view uses that interval as its candle granularity. The default interval is 1m.

## Account setup

MarketPilot uses Supabase Auth for email/password accounts and the `marketpilot_profiles` table for account details. Copy `.env.example` to `.env.local` and set:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY` (server only; never expose or commit this key)

Apply `supabase/migrations/20261121230000_marketpilot_accounts.sql`, `supabase/migrations/20261122011500_marketpilot_wallets.sql`, `supabase/migrations/20261122130500_marketpilot_reset_demo_wallet.sql`, `supabase/migrations/20261122141500_marketpilot_admin_dashboard.sql`, and `supabase/migrations/20261122143000_marketpilot_test_outcome_rates.sql` to the Supabase project. The reset migration adds an authenticated operation for restoring the signed-in user's Demo wallet to $10,000.00. In Supabase Auth URL configuration, allow `http://localhost:3000/auth/callback` and add your production callback URL before deployment. Configure email delivery/SMTP and email confirmation in Supabase Auth to enable account confirmations and password-reset links.

To grant administrator access, first create the account, then add its email or Auth user ID to `public.marketpilot_admins` in the Supabase SQL Editor. For example, use `insert into public.marketpilot_admins (email) values (lower('admin@example.com'));` or `insert into public.marketpilot_admins (user_id) values ('AUTH-USER-UUID');`. Admin records cannot be changed by app users. Admins are redirected to `/admin` after signing in; the server page and reporting RPC both verify the admin allowlist.

The admin report defines active accounts as having signed in within 30 days. It shows current real-wallet balances and historical market-based results for the real wallet. Deposits are labeled “Not tracked” until a deposit ledger is implemented. Admins can set the demo test win chance from 0–100%; the real-account test chance is its complement. The default is 75% demo / 25% real. These are per-trade probabilities for synthetic practice outcomes, not guaranteed long-run percentages; the configured rate is recorded when each practice trade opens. Real-account practice trading remains disabled, so the real-account test chance is not currently used for new trades.

Registration requires a display username, email, country, phone, password confirmation, and agreement to the Terms and Conditions. Display usernames may be shared. Email and phone sign-in use the same account; phone sign-in resolves the email server-side and does not disclose account lookup results. Password resets are delivered by email.

The profile migration creates profile rows from Supabase Auth users, enforces unique email and phone values, allows shared display usernames, and restricts profile reads with row-level security. The wallet migration creates separate USD Real and Demo wallets for every existing and newly registered user (Real starts at $0.00; Demo starts at $10,000.00). Cashier lets signed-in users view and select either balance; Demo can be reset to $10,000.00. Practice trades require sign-in, reserve the selected wallet's stake at entry, and persist their results per user. Synthetic outcomes are marked in trade history; actual market exit prices and digits remain unchanged. Real-money deposits and live orders are not supported. The phone sign-in route uses the server-only Supabase secret key for a private profile lookup; the key is never sent to the browser. Do not deploy until all required migrations and Supabase redirect/email settings are configured.
