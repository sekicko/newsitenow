'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, Clock3, RefreshCw, ShieldCheck, Users, Wallet } from 'lucide-react';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';

type AdminUser = {
  id: string;
  username: string;
  email: string;
  phone: string | null;
  activityStatus: 'Active' | 'Offline';
  lastSeenAt: string | null;
  lastLoginAt: string | null;
  realBalance: number;
};

export type AdminPaymentTransaction = {
  id: string;
  username: string;
  email: string;
  type: 'deposit' | 'withdrawal';
  status: 'pending' | 'completed' | 'declined' | 'failed';
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
  totalWithdrawn: number;
  ownerShareUsd: number;
  devShareUsd: number;
  realWinRate: number | null;
  kesPerUsd: number | null;
  transactions: AdminPaymentTransaction[];
  users: AdminUser[];
};

const money = (amount: number) => `$${amount.toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

function dateTime(value: string | null): string {
  if (!value) return 'Never';
  return `${new Date(value).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  })} UTC`;
}

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
  const [actionNotice, setActionNotice] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [kesRate, setKesRate] = useState(data.kesPerUsd?.toString() ?? '');
  const [savingRate, setSavingRate] = useState(false);
  const [processingTransactionId, setProcessingTransactionId] = useState('');
  const [withdrawalReceipts, setWithdrawalReceipts] = useState<Record<string, string>>({});
  const [balanceCreditAmounts, setBalanceCreditAmounts] = useState<Record<string, string>>({});
  const [creditingUserId, setCreditingUserId] = useState('');
  const [resettingShares, setResettingShares] = useState(false);
  const [showPendingWithdrawals, setShowPendingWithdrawals] = useState(false);
  const pendingWithdrawals = data.transactions.filter(
    (transaction) => transaction.type === 'withdrawal' && transaction.status === 'pending',
  );
  const visibleTransactions = data.transactions.filter(
    (transaction) => transaction.type !== 'withdrawal' || transaction.status !== 'pending',
  );

  useEffect(() => {
    const refreshVisibleDashboard = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const intervalId = window.setInterval(refreshVisibleDashboard, 30_000);
    document.addEventListener('visibilitychange', refreshVisibleDashboard);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refreshVisibleDashboard);
    };
  }, [router]);

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
    setActionNotice('');
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

  const creditUserBalance = async (
    event: FormEvent<HTMLFormElement>,
    user: AdminUser,
  ) => {
    event.preventDefault();
    const amountUsd = Number(balanceCreditAmounts[user.id]);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0 || creditingUserId) {
      setActionError('Enter a positive amount to add to the user balance.');
      return;
    }

    setCreditingUserId(user.id);
    setActionError('');
    setActionNotice('');
    try {
      const { error } = await getSupabaseBrowserClient().rpc('marketpilot_admin_credit_user_balance', {
        p_user_id: user.id,
        p_amount_usd: amountUsd,
        p_credit_id: crypto.randomUUID(),
      });
      if (error) throw error;
      setBalanceCreditAmounts((current) => ({ ...current, [user.id]: '' }));
      setActionNotice(`Added ${money(Math.round(amountUsd * 100) / 100)} to @${user.username}'s Real balance and recorded it as a completed deposit.`);
      router.refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setCreditingUserId('');
    }
  };

  const resetDepositShares = async () => {
    if (resettingShares) return;
    const confirmed = window.confirm(
      'Have both shares been paid out? This only resets the running totals; it does not transfer money. Reset both totals to $0.00?',
    );
    if (!confirmed) return;

    setResettingShares(true);
    setActionError('');
    setActionNotice('');
    try {
      const { error } = await getSupabaseBrowserClient().rpc('marketpilot_admin_reset_deposit_shares');
      if (error) throw error;
      setActionNotice('Owner and developer share totals were reset to $0.00. The reset was recorded.');
      router.refresh();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setResettingShares(false);
    }
  };

  const renderWithdrawalActions = (transaction: AdminPaymentTransaction) => (
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
  );

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
      {actionNotice && <p className="admin-success" role="status">{actionNotice}</p>}

      <section className="admin-metrics" aria-label="Platform reports">
        <article className="admin-card admin-user-metric">
          <div className="admin-card-title">
            <span className="admin-card-icon"><Users size={17} /></span>
            <h2>Total users</h2>
          </div>
          <strong className="admin-card-total">{data.totalUsers.toLocaleString('en-US')}</strong>
          <div className="admin-user-statuses">
            <span className="admin-status admin-status--active"><i />{data.activeUsers.toLocaleString('en-US')} active now</span>
            <span className="admin-status admin-status--offline"><i />{data.dormantUsers.toLocaleString('en-US')} offline</span>
          </div>
          <p className="admin-card-note">Active users sent a heartbeat within 90 seconds. This dashboard refreshes every 30 seconds.</p>
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
        <button
          type="button"
          className="admin-card admin-card-button"
          aria-expanded={showPendingWithdrawals}
          aria-controls="admin-pending-withdrawals"
          onClick={() => setShowPendingWithdrawals((visible) => !visible)}
        >
          <div className="admin-card-title">
            <span className="admin-card-icon"><Clock3 size={17} /></span>
            <h2>Pending withdrawals</h2>
          </div>
          <strong className="admin-card-total">{pendingWithdrawals.length.toLocaleString('en-US')}</strong>
          <p className="admin-card-note">
            {showPendingWithdrawals ? 'Hide pending withdrawal requests.' : 'Select to review pending withdrawal requests.'}
          </p>
        </button>
        <article className="admin-card">
          <div className="admin-card-title">
            <span className="admin-card-icon"><Wallet size={17} /></span>
            <h2>Total withdrawn</h2>
          </div>
          <strong className="admin-card-total">{money(data.totalWithdrawn)}</strong>
          <p className="admin-card-note">Completed withdrawals only · USD</p>
        </article>
      </section>

      <section className="admin-share-section" aria-labelledby="admin-share-heading">
        <div className="admin-list-heading">
          <div>
            <p className="eyebrow">COMPLETED DEPOSIT ALLOCATION</p>
            <h2 id="admin-share-heading">Deposit shares</h2>
          </div>
          <button
            type="button"
            className="admin-button"
            onClick={() => void resetDepositShares()}
            disabled={resettingShares || (data.ownerShareUsd === 0 && data.devShareUsd === 0)}
          >
            {resettingShares ? 'Resetting…' : 'Reset shares after settlement'}
          </button>
        </div>
        <div className="admin-metrics">
          <article className="admin-card">
            <div className="admin-card-title">
              <span className="admin-card-icon"><Wallet size={17} /></span>
              <h2>Owner Share · 60%</h2>
            </div>
            <strong className="admin-card-total">{money(data.ownerShareUsd)}</strong>
            <p className="admin-card-note">60% of verified completed deposit amounts, excluding deposit bonuses and admin credits.</p>
          </article>
          <article className="admin-card">
            <div className="admin-card-title">
              <span className="admin-card-icon"><Wallet size={17} /></span>
              <h2>Dev Share · 40%</h2>
            </div>
            <strong className="admin-card-total">{money(data.devShareUsd)}</strong>
            <p className="admin-card-note">40% of verified completed deposit amounts, excluding deposit bonuses and admin credits.</p>
          </article>
        </div>
        <p className="admin-card-note">
          Reset clears both running totals after payout; it does not make a payment. Each reset is recorded.
        </p>
      </section>

      {showPendingWithdrawals && (
        <section className="admin-card admin-pending-withdrawals" id="admin-pending-withdrawals">
          <div className="admin-list-heading">
            <div>
              <p className="eyebrow">AWAITING PROCESSING</p>
              <h2>Pending withdrawals <span>{pendingWithdrawals.length}</span></h2>
            </div>
          </div>
          <div className="admin-table-scroll" tabIndex={0} aria-label="Pending withdrawal requests">
            <table className="admin-table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">USD</th>
                  <th scope="col">KES</th>
                  <th scope="col">M-Pesa recipient</th>
                  <th scope="col">Requested</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pendingWithdrawals.length ? pendingWithdrawals.map((transaction) => (
                  <tr key={transaction.id}>
                    <td>{transaction.username}<br /><small>{transaction.email}</small></td>
                    <td>{money(transaction.amountUsd)}</td>
                    <td>KES {transaction.amountKes.toLocaleString('en-KE')}</td>
                    <td>{transaction.phone}</td>
                    <td>{dateTime(transaction.createdAt)}</td>
                    <td>{renderWithdrawalActions(transaction)}</td>
                  </tr>
                )) : (
                  <tr><td className="admin-empty" colSpan={6}>There are no pending withdrawals.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
                <th scope="col">M-Pesa recipient</th>
                <th scope="col">Status</th>
                <th scope="col">Receipt / actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleTransactions.length ? visibleTransactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td>{transaction.username}<br /><small>{transaction.email}</small></td>
                  <td>{transaction.type}</td>
                  <td>{money(transaction.amountUsd)}</td>
                  <td>KES {transaction.amountKes.toLocaleString('en-KE')}</td>
                  <td>{transaction.phone}</td>
                  <td>
                    <span className={`admin-payment-status is-${transaction.type === 'deposit' && transaction.status === 'pending' ? 'processing' : transaction.status}`}>
                      {transaction.type === 'deposit' && transaction.status === 'pending'
                        ? 'Awaiting confirmation'
                        : transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)}
                    </span>
                  </td>
                  <td>
                    {transaction.type === 'deposit' ? (
                      transaction.megapayReceipt ?? transaction.adminReceipt ?? transaction.reference
                    ) : transaction.status !== 'pending' ? (
                      transaction.adminReceipt ?? transaction.reference
                    ) : (
                      transaction.reference
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
                <th scope="col">Last seen</th>
                <th scope="col">Last login</th>
                <th scope="col">Real balance</th>
                <th scope="col">Add balance</th>
              </tr>
            </thead>
            <tbody>
              {data.users.length ? data.users.map((user) => (
                <tr key={user.id}>
                  <td>@{user.username}</td>
                  <td>{user.email}</td>
                  <td>{user.phone ?? '—'}</td>
                  <td>
                    <span className={`admin-status admin-status--${user.activityStatus.toLowerCase()}`}>
                      <i />{user.activityStatus}
                    </span>
                  </td>
                  <td>{dateTime(user.lastSeenAt)}</td>
                  <td>{dateTime(user.lastLoginAt)}</td>
                  <td>{money(user.realBalance)}</td>
                  <td>
                    <form
                      className="admin-balance-credit"
                      onSubmit={(event) => void creditUserBalance(event, user)}
                    >
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        inputMode="decimal"
                        aria-label={`Amount to add to @${user.username}'s Real balance in USD`}
                        placeholder="USD amount"
                        value={balanceCreditAmounts[user.id] ?? ''}
                        onChange={(event) => setBalanceCreditAmounts((current) => ({
                          ...current,
                          [user.id]: event.target.value,
                        }))}
                        required
                      />
                      <button
                        type="submit"
                        className="admin-button"
                        disabled={creditingUserId !== '' || !(balanceCreditAmounts[user.id] ?? '')}
                      >
                        {creditingUserId === user.id ? 'Saving…' : 'Add'}
                      </button>
                    </form>
                  </td>
                </tr>
              )) : (
                <tr><td className="admin-empty" colSpan={8}>No users found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
