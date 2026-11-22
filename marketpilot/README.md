# MarketPilot

MarketPilot is a standalone practice dashboard in this workspace. The main project remains unchanged.

## Run locally

Use Node.js 20.9 or newer:

```bash
cd marketpilot
npm install
npm run dev
```

The app connects directly from the browser to Deriv's public WebSocket endpoint (`wss://api.derivws.com/trading/v1/options/ws/public`). To use a registered app URL, set `NEXT_PUBLIC_DERIV_WS_URL` in `.env.local` (see `.env.example`).

Market symbols, live ticks, tick history, supported contracts, and price proposals all come from Deriv. When Deriv cannot supply data or a proposal, the dashboard reports that state and does not substitute generated prices or payouts. Practice contracts are simulated locally from incoming ticks; they do not submit or purchase a real contract.

The market picker is restricted to the ten continuous volatility indices (`R_10`, `R_25`, `R_50`, `R_75`, `R_100`, `1HZ10V`, `1HZ25V`, `1HZ50V`, `1HZ75V`, and `1HZ100V`) and lists only symbols returned by Deriv. The TradingView Lightweight Charts view can switch between an area line of actual ticks and actual provider OHLC candlesticks. Its 1m, 5m, 15m, 30m, and 1h controls request the selected interval's historical data; the candlestick view uses that interval as its candle granularity. The default interval is 1m.

## Account setup

MarketPilot uses Supabase Auth for email/password accounts and the `marketpilot_profiles` table for account details. Copy `.env.example` to `.env.local` and set:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY` (server only; never expose or commit this key)

Apply `supabase/migrations/20261121230000_marketpilot_accounts.sql` and `supabase/migrations/20261122011500_marketpilot_wallets.sql` to the Supabase project. In Supabase Auth URL configuration, allow `http://localhost:3000/auth/callback` and add your production callback URL before deployment. Configure email delivery/SMTP and email confirmation in Supabase Auth to enable account confirmations and password-reset links.

Registration requires full name, a unique username, email, country, phone, password confirmation, and agreement to the Terms and Conditions. The selected country calling code is included in the stored E.164 phone number. Email and phone sign-in use the same account; phone sign-in resolves the email server-side and does not disclose account lookup results. Password resets are delivered by email.

The profile migration creates profile rows from Supabase Auth users, enforces unique usernames and phone numbers, and restricts profile reads with row-level security. The wallet migration creates separate USD Real and Demo wallets for every existing and newly registered user (Real starts at $0.00; Demo starts at $10,000.00). Practice trades require sign-in, reserve the selected wallet's stake at entry, and return the quoted payout on a win; practice records and balances are persisted per user. Real-money deposits and live orders are not supported. The phone sign-in route uses the server-only Supabase secret key for a private profile lookup; the key is never sent to the browser. Do not deploy until both migrations and Supabase redirect/email settings are configured.
