'use client';

import { useState } from 'react';
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
  totalRealBalance: number;
  realWinRate: number | null;
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
            <h2>Market-based win rate</h2>
          </div>
          <strong className="admin-card-total">{data.realWinRate === null ? '—' : `${data.realWinRate.toFixed(1)}%`}</strong>
          <p className="admin-card-note">
            Historical win rate from closed, market-settled Real-account trades.
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
