'use client';

import { useState, type FormEvent } from 'react';
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

export type AdminPaymentTransaction = {
  id: string;
  username: string;
  email: string;
  type: 'deposit' | 'withdrawal';
  status: 'pending' | 'completed' | 'declined';
  amountUsd: number;
  amountKes: number;
  phone: string;
  reference: string;
  megapayReceipt: string | null;
  adminReceipt: string | null;
  approved: boolean;
  createdAt: string;
};

export type AdminDashboardData = {
  totalUsers: number;
  activeUsers: number;
  dormantUsers: number;
  depositsToday: number | null;
  totalRealBalance: number;
  realWinRate: number | null;
  kesPerUsd: number | null;
  transactions: AdminPaymentTransaction[];
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
  const [kesRate, setKesRate] = useState(data.kesPerUsd?.toString() ?? '');
  const [savingRate, setSavingRate] = useState(false);
  const [processingTransactionId, setProcessingTransactionId] = useState('');
  const [withdrawalReceipts, setWithdrawalReceipts] = useState<Record<string, string>>({});

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

  const saveExchangeRate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rate = Number(kesRate);
    if (!Number.isFinite(rate) || rate <= 0 || savingRate) {
      setActionError('Enter a valid KES per USD exchange rate.');
      return;
    }

    setSavingRate(true);
    setActionError('');
    try {
      const { error } = await getSupabaseBrowserClient().rpc('marketpilot_admin_set_kes_per_usd', {
        p_rate: rate,
      });
      if (error) throw error;
      setKesRate(rate.toString());
      router.refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSavingRate(false);
    }
  };

  const processWithdrawal = async (
    transactionId: string,
    action: 'approve' | 'complete' | 'decline',
  ) => {
    if (processingTransactionId) return;
    setProcessingTransactionId(transactionId);
    setActionError('');
    try {
      const { error } = await getSupabaseBrowserClient().rpc('marketpilot_admin_process_withdrawal', {
        p_transaction_id: transactionId,
        p_action: action,
        p_admin_receipt: action === 'complete' ? withdrawalReceipts[transactionId]?.trim() ?? null : null,
      });
      if (error) throw error;
      router.refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setProcessingTransactionId('');
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
          <p className="admin-card-note">Completed deposits are recorded in USD. Daily figures use UTC.</p>
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

      <section className="admin-card admin-payments">
        <div className="admin-list-heading">
          <div>
            <p className="eyebrow">REAL ACCOUNT PAYMENTS</p>
            <h2>Exchange rate and payment requests</h2>
          </div>
        </div>
        <form className="admin-rate-form" onSubmit={(event) => void saveExchangeRate(event)}>
          <label>
            KES per USD
            <input
              type="number"
              min="0.01"
              max="1000000"
              step="0.000001"
              value={kesRate}
              onChange={(event) => setKesRate(event.target.value)}
              required
            />
          </label>
          <button type="submit" className="admin-button" disabled={savingRate}>
            {savingRate ? 'Saving…' : 'Save rate'}
          </button>
          <span>
            {data.kesPerUsd
              ? `Current: KES ${data.kesPerUsd.toLocaleString('en-US')} = $1.00`
              : 'Set the rate to enable deposits and withdrawals.'}
          </span>
        </form>

        <div className="admin-table-scroll" tabIndex={0} aria-label="Recent deposits and withdrawals">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Type</th>
                <th scope="col">USD</th>
                <th scope="col">KES</th>
                <th scope="col">M-Pesa number</th>
                <th scope="col">Status</th>
                <th scope="col">Receipt / actions</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.length ? data.transactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td>{transaction.username}<br /><small>{transaction.email}</small></td>
                  <td>{transaction.type}</td>
                  <td>{money(transaction.amountUsd)}</td>
                  <td>KES {transaction.amountKes.toLocaleString('en-KE')}</td>
                  <td>{transaction.phone}</td>
                  <td><span className={`admin-payment-status is-${transaction.status}`}>{transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)}</span></td>
                  <td>
                    {transaction.type === 'deposit' ? (
                      transaction.megapayReceipt ?? transaction.reference
                    ) : transaction.status !== 'pending' ? (
                      transaction.adminReceipt ?? transaction.reference
                    ) : (
                      <div className="admin-payment-actions">
                        {transaction.approved ? (
                          <>
                            <input
                              aria-label={`M-Pesa receipt for ${transaction.username}`}
                              placeholder="M-Pesa receipt"
                              value={withdrawalReceipts[transaction.id] ?? ''}
                              onChange={(event) => setWithdrawalReceipts((current) => ({
                                ...current,
                                [transaction.id]: event.target.value,
                              }))}
                            />
                            <button
                              type="button"
                              className="admin-button"
                              onClick={() => void processWithdrawal(transaction.id, 'complete')}
                              disabled={processingTransactionId !== '' || !(withdrawalReceipts[transaction.id] ?? '').trim()}
                            >
                              Mark paid
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="admin-button"
                            onClick={() => void processWithdrawal(transaction.id, 'approve')}
                            disabled={processingTransactionId !== ''}
                          >
                            Approve
                          </button>
                        )}
                        <button
                          type="button"
                          className="admin-button admin-button--danger"
                          onClick={() => void processWithdrawal(transaction.id, 'decline')}
                          disabled={processingTransactionId !== ''}
                        >
                          Decline
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )) : (
                <tr><td className="admin-empty" colSpan={7}>No payment transactions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
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
