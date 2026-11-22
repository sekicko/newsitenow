'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, RefreshCw, ShieldCheck, Users, Wallet } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

type AdminUser = {
  username: string;
  email: string;
  phone: string | null;
  activityStatus: 'Active' | 'Dormant';
  realBalance: number;
};

export type AdminDashboardData = {
  totalUsers: number;
  activeUsers: number;
  dormantUsers: number;
  depositsToday: number | null;
  realLossesToday: number;
  totalRealBalance: number;
  realWinRate: number | null;
  testDemoWinRate: number;
  users: AdminUser[];
};

const money = (amount: number) => `$${amount.toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The request could not be completed. Please try again.';
}

export function AdminDashboard({
  data,
  adminEmail,
}: {
  data: AdminDashboardData;
  adminEmail: string;
}) {
  const router = useRouter();
  const [actionError, setActionError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [demoWinRateText, setDemoWinRateText] = useState(String(data.testDemoWinRate));
  const [savedDemoWinRate, setSavedDemoWinRate] = useState(data.testDemoWinRate);
  const [rateMessage, setRateMessage] = useState('');
  const [rateError, setRateError] = useState('');
  const [savingRate, setSavingRate] = useState(false);
  const parsedDemoRate = demoWinRateText.trim() === '' ? NaN : Number(demoWinRateText);
  const displayedDemoRate = Number.isInteger(parsedDemoRate) && parsedDemoRate >= 0 && parsedDemoRate <= 100
    ? parsedDemoRate
    : savedDemoWinRate;

  useEffect(() => {
    setDemoWinRateText(String(data.testDemoWinRate));
    setSavedDemoWinRate(data.testDemoWinRate);
  }, [data.testDemoWinRate]);

  const signOut = async () => {
    setSigningOut(true);
    setActionError('');
    try {
      const { error } = await getSupabaseBrowserClient().auth.signOut();
      if (error) throw error;
      window.location.assign('/');
    } catch (error) {
      setActionError(errorMessage(error));
      setSigningOut(false);
    }
  };

  const saveDemoWinRate = async () => {
    if (!Number.isInteger(parsedDemoRate) || parsedDemoRate < 0 || parsedDemoRate > 100) {
      setRateError('Enter a whole-number test win chance from 0 to 100.');
      setRateMessage('');
      return;
    }

    setSavingRate(true);
    setRateError('');
    setRateMessage('');
    try {
      const { data: savedRate, error } = await getSupabaseBrowserClient().rpc(
        'marketpilot_admin_set_demo_test_win_rate',
        { p_demo_win_rate: parsedDemoRate },
      );
      if (error) throw error;
      const confirmedRate = typeof savedRate === 'number' ? savedRate : Number(savedRate);
      if (!Number.isInteger(confirmedRate) || confirmedRate < 0 || confirmedRate > 100) {
        throw new Error('The saved test win chance was invalid.');
      }
      setSavedDemoWinRate(confirmedRate);
      setDemoWinRateText(String(confirmedRate));
      setRateMessage('Test win chances saved for new practice trades.');
    } catch (error) {
      setRateError(errorMessage(error));
    } finally {
      setSavingRate(false);
    }
  };

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div className="admin-brand">
          <span className="admin-brand-icon"><ShieldCheck size={19} /></span>
          <div>
            <p className="eyebrow">MARKETPILOT · ADMIN</p>
            <h1>Administrator dashboard</h1>
          </div>
        </div>
        <div className="admin-header-actions">
          <span className="admin-email">{adminEmail}</span>
          <button type="button" className="admin-button" onClick={() => router.refresh()}>
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
          <button type="button" className="admin-button admin-button--secondary" onClick={() => void signOut()} disabled={signingOut}>
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      {actionError && <p className="admin-error" role="alert">{actionError}</p>}

      <section className="admin-metrics" aria-label="Platform reports">
        <article className="admin-card admin-user-metric">
          <div className="admin-card-title">
            <span className="admin-card-icon"><Users size={17} /></span>
            <h2>Total users</h2>
          </div>
          <strong className="admin-card-total">{data.totalUsers.toLocaleString('en-US')}</strong>
          <div className="admin-user-statuses">
            <span className="admin-status admin-status--active"><i />{data.activeUsers.toLocaleString('en-US')} active</span>
            <span className="admin-status admin-status--dormant"><i />{data.dormantUsers.toLocaleString('en-US')} dormant</span>
          </div>
          <p className="admin-card-note">Active means signed in within the last 30 days.</p>
        </article>

        <article className="admin-card">
          <div className="admin-card-title">
            <span className="admin-card-icon"><Wallet size={17} /></span>
            <h2>Traders volume</h2>
          </div>
          <div className="admin-volume-grid">
            <div>
              <span>Deposits today · real</span>
              <strong>{data.depositsToday === null ? 'Not tracked' : money(data.depositsToday)}</strong>
            </div>
            <div>
              <span>Real-account practice losses today</span>
              <strong>{money(data.realLossesToday)}</strong>
            </div>
            <div className="admin-volume-balance">
              <span>Current real wallet balance</span>
              <strong>{money(data.totalRealBalance)}</strong>
            </div>
          </div>
          <p className="admin-card-note">Deposit activity is not recorded yet. Daily figures use UTC.</p>
        </article>

        <article className="admin-card">
          <div className="admin-card-title">
            <span className="admin-card-icon"><Activity size={17} /></span>
            <h2>Test win-rate settings</h2>
          </div>
          <label className="admin-rate-label" htmlFor="demo-test-win-rate">Demo test win chance</label>
          <div className="admin-rate-control">
            <input
              id="demo-test-win-rate"
              type="number"
              min="0"
              max="100"
              step="1"
              value={demoWinRateText}
              onChange={(event) => {
                setDemoWinRateText(event.target.value);
                setRateError('');
                setRateMessage('');
              }}
            />
            <span>%</span>
          </div>
          <p className="admin-rate-complement">Real-account test chance: <strong>{100 - displayedDemoRate}%</strong></p>
          <button type="button" className="admin-save-rate" onClick={() => void saveDemoWinRate()} disabled={savingRate}>
            {savingRate ? 'Saving…' : 'Save test chances'}
          </button>
          {rateError && <p className="admin-rate-feedback is-error" role="alert">{rateError}</p>}
          {rateMessage && <p className="admin-rate-feedback" role="status">{rateMessage}</p>}
          <p className="admin-card-note">
            Per-trade synthetic test odds for new practice trades; rates are not guaranteed long-run quotas. Market prices and actual exits are unchanged. Real-account trading is disabled.
          </p>
          <p className="admin-card-note">
            Historical market-based real-account win rate: {data.realWinRate === null ? '—' : `${data.realWinRate.toFixed(1)}%`}
          </p>
        </article>
      </section>

      <section className="admin-card admin-user-list">
        <div className="admin-list-heading">
          <div>
            <p className="eyebrow">ACCOUNT DIRECTORY</p>
            <h2>All users <span>{data.totalUsers.toLocaleString('en-US')}</span></h2>
          </div>
        </div>
        <div className="admin-table-scroll" tabIndex={0} aria-label="Scrollable list of all users">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Email</th>
                <th scope="col">Phone</th>
                <th scope="col">Activity</th>
                <th scope="col">Real balance</th>
              </tr>
            </thead>
            <tbody>
              {data.users.length ? data.users.map((user) => (
                <tr key={user.email}>
                  <td>@{user.username}</td>
                  <td>{user.email}</td>
                  <td>{user.phone ?? '—'}</td>
                  <td>
                    <span className={`admin-status admin-status--${user.activityStatus.toLowerCase()}`}>
                      <i />{user.activityStatus}
                    </span>
                  </td>
                  <td>{money(user.realBalance)}</td>
                </tr>
              )) : (
                <tr><td className="admin-empty" colSpan={5}>No users found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
