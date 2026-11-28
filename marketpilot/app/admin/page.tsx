import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import {
  AdminDashboard,
  type AdminDashboardData,
  type AdminPaymentTransaction,
} from '@/components/admin/admin-dashboard';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseAdminDashboardData(
  value: unknown,
  marketRealWinRate: unknown,
  depositsToday: unknown,
  paymentRate: unknown,
  paymentTransactions: unknown,
  userIds: unknown,
  depositShares: unknown,
): AdminDashboardData {
  if (
    !isRecord(value) ||
    !Array.isArray(value.users) ||
    !Array.isArray(paymentTransactions) ||
    !Array.isArray(userIds) ||
    !isRecord(depositShares)
  ) {
    throw new Error('The administrator report returned invalid data.');
  }

  const { totalUsers, activeUsers, dormantUsers, totalRealBalance, totalWithdrawn } = value;
  const { ownerShareUsd, devShareUsd } = depositShares;
  if (
    !isFiniteNumber(totalUsers) || totalUsers < 0 ||
    !isFiniteNumber(activeUsers) || activeUsers < 0 ||
    !isFiniteNumber(dormantUsers) || dormantUsers < 0 ||
    !isFiniteNumber(totalRealBalance) || totalRealBalance < 0 ||
    !isFiniteNumber(totalWithdrawn) || totalWithdrawn < 0 ||
    !isFiniteNumber(ownerShareUsd) || ownerShareUsd < 0 ||
    !isFiniteNumber(devShareUsd) || devShareUsd < 0 ||
    (depositsToday !== null && (!isFiniteNumber(depositsToday) || depositsToday < 0)) ||
    (marketRealWinRate !== null &&
      (!isFiniteNumber(marketRealWinRate) || marketRealWinRate < 0 || marketRealWinRate > 100))
  ) {
    throw new Error('The administrator report returned invalid metrics.');
  }
  if (
    (paymentRate !== null && (!isFiniteNumber(paymentRate) || paymentRate <= 0))
  ) {
    throw new Error('The administrator payment rate is invalid.');
  }

  const userIdsByEmail = new Map<string, string>();
  for (const row of userIds) {
    if (
      !isRecord(row) ||
      typeof row.email !== 'string' ||
      typeof row.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.id)
    ) {
      throw new Error('The administrator report returned invalid user identifiers.');
    }
    userIdsByEmail.set(row.email.toLowerCase(), row.id);
  }

  const users: AdminDashboardData['users'] = value.users.map((row: unknown) => {
    if (!isRecord(row)) throw new Error('The administrator report returned an invalid user.');
    const { username, email, phone, activityStatus, lastSeenAt, lastLoginAt, realBalance } = row;
    const id = typeof email === 'string' ? userIdsByEmail.get(email.toLowerCase()) : undefined;
    if (
      typeof id !== 'string' ||
      typeof username !== 'string' ||
      typeof email !== 'string' ||
      (phone !== null && typeof phone !== 'string') ||
      (activityStatus !== 'Active' && activityStatus !== 'Offline') ||
      (lastSeenAt !== null && (typeof lastSeenAt !== 'string' || !Number.isFinite(Date.parse(lastSeenAt)))) ||
      (lastLoginAt !== null && (typeof lastLoginAt !== 'string' || !Number.isFinite(Date.parse(lastLoginAt)))) ||
      !isFiniteNumber(realBalance) || realBalance < 0
    ) {
      throw new Error('The administrator report returned an invalid user.');
    }
    return { id, username, email, phone, activityStatus, lastSeenAt, lastLoginAt, realBalance };
  });

  const transactions: AdminPaymentTransaction[] = paymentTransactions.map((row: unknown) => {
    if (!isRecord(row)) throw new Error('The administrator report returned an invalid payment.');
    const {
      id,
      username,
      email,
      type,
      status,
      amountUsd,
      amountKes,
      phone,
      reference,
      megapayReceipt,
      adminReceipt,
      approved,
      createdAt,
    } = row;
    if (
      typeof id !== 'string' ||
      typeof username !== 'string' ||
      typeof email !== 'string' ||
      (type !== 'deposit' && type !== 'withdrawal') ||
      (status !== 'pending' && status !== 'completed' && status !== 'declined' && status !== 'failed') ||
      !isFiniteNumber(amountUsd) || amountUsd <= 0 ||
      !isFiniteNumber(amountKes) || amountKes <= 0 ||
      typeof phone !== 'string' ||
      typeof reference !== 'string' ||
      (megapayReceipt !== null && typeof megapayReceipt !== 'string') ||
      (adminReceipt !== null && typeof adminReceipt !== 'string') ||
      typeof approved !== 'boolean' ||
      typeof createdAt !== 'string'
    ) {
      throw new Error('The administrator report returned an invalid payment.');
    }
    return {
      id,
      username,
      email,
      type,
      status,
      amountUsd,
      amountKes,
      phone,
      reference,
      megapayReceipt,
      adminReceipt,
      approved,
      createdAt,
    };
  });

  return {
    totalUsers,
    activeUsers,
    dormantUsers,
    depositsToday,
    totalRealBalance,
    totalWithdrawn,
    ownerShareUsd,
    devShareUsd,
    realWinRate: marketRealWinRate,
    kesPerUsd: paymentRate,
    transactions,
    users,
  };
}

export default async function AdminPage() {
  await connection();
  if (!process.env.SUPABASE_URL?.trim() || !process.env.SUPABASE_PUBLISHABLE_KEY?.trim()) {
    redirect('/');
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError && userError.name !== 'AuthSessionMissingError') {
    throw new Error(`Could not verify the current user: ${userError.message}`);
  }
  if (!user) redirect('/');

  const { data: isAdmin, error: roleError } = await supabase.rpc('marketpilot_is_admin');
  if (roleError) throw new Error(`Could not verify administrator access: ${roleError.message}`);
  if (!isAdmin) redirect('/');

  const [
    statsResult,
    marketRateResult,
    depositsTodayResult,
    paymentRateResult,
    paymentTransactionsResult,
    userIdsResult,
    depositSharesResult,
  ] = await Promise.all([
    supabase.rpc('marketpilot_admin_dashboard_stats'),
    supabase.rpc('marketpilot_admin_get_market_real_win_rate'),
    supabase.rpc('marketpilot_admin_deposits_today'),
    supabase.rpc('marketpilot_get_kes_per_usd'),
    supabase.rpc('marketpilot_admin_list_transactions'),
    supabase.rpc('marketpilot_admin_list_user_ids'),
    supabase.rpc('marketpilot_admin_get_deposit_shares'),
  ]);
  if (statsResult.error) throw new Error(`Could not load administrator reports: ${statsResult.error.message}`);
  if (marketRateResult.error) throw new Error(`Could not load historical market win rate: ${marketRateResult.error.message}`);
  if (depositsTodayResult.error) throw new Error(`Could not load today's deposits: ${depositsTodayResult.error.message}`);
  if (paymentRateResult.error) throw new Error(`Could not load the payment exchange rate: ${paymentRateResult.error.message}`);
  if (paymentTransactionsResult.error) throw new Error(`Could not load payment transactions: ${paymentTransactionsResult.error.message}`);
  if (userIdsResult.error) throw new Error(`Could not load administrator user identifiers: ${userIdsResult.error.message}`);
  if (depositSharesResult.error) throw new Error(`Could not load deposit share totals: ${depositSharesResult.error.message}`);
  const dashboardData = parseAdminDashboardData(
    statsResult.data,
    marketRateResult.data,
    depositsTodayResult.data,
    paymentRateResult.data,
    paymentTransactionsResult.data,
    userIdsResult.data,
    depositSharesResult.data,
  );

  return (
    <AdminDashboard
      data={dashboardData}
      adminEmail={user.email ?? ''}
    />
  );
}
