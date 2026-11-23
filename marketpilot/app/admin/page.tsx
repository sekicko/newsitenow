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
): AdminDashboardData {
  if (!isRecord(value) || !Array.isArray(value.users) || !Array.isArray(paymentTransactions)) {
    throw new Error('The administrator report returned invalid data.');
  }

  const { totalUsers, activeUsers, dormantUsers, totalRealBalance } = value;
  if (
    !isFiniteNumber(totalUsers) || totalUsers < 0 ||
    !isFiniteNumber(activeUsers) || activeUsers < 0 ||
    !isFiniteNumber(dormantUsers) || dormantUsers < 0 ||
    !isFiniteNumber(totalRealBalance) || totalRealBalance < 0 ||
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

  const users: AdminDashboardData['users'] = value.users.map((row: unknown) => {
    if (!isRecord(row)) throw new Error('The administrator report returned an invalid user.');
    const { username, email, phone, activityStatus, realBalance } = row;
    if (
      typeof username !== 'string' ||
      typeof email !== 'string' ||
      (phone !== null && typeof phone !== 'string') ||
      (activityStatus !== 'Active' && activityStatus !== 'Dormant') ||
      !isFiniteNumber(realBalance) || realBalance < 0
    ) {
      throw new Error('The administrator report returned an invalid user.');
    }
    return { username, email, phone, activityStatus, realBalance };
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
      (status !== 'pending' && status !== 'completed' && status !== 'declined') ||
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

  const [statsResult, marketRateResult, depositsTodayResult, paymentRateResult, paymentTransactionsResult] = await Promise.all([
    supabase.rpc('marketpilot_admin_dashboard_stats'),
    supabase.rpc('marketpilot_admin_get_market_real_win_rate'),
    supabase.rpc('marketpilot_admin_deposits_today'),
    supabase.rpc('marketpilot_get_kes_per_usd'),
    supabase.rpc('marketpilot_admin_list_transactions'),
  ]);
  if (statsResult.error) throw new Error(`Could not load administrator reports: ${statsResult.error.message}`);
  if (marketRateResult.error) throw new Error(`Could not load historical market win rate: ${marketRateResult.error.message}`);
  if (depositsTodayResult.error) throw new Error(`Could not load today's deposits: ${depositsTodayResult.error.message}`);
  if (paymentRateResult.error) throw new Error(`Could not load the payment exchange rate: ${paymentRateResult.error.message}`);
  if (paymentTransactionsResult.error) throw new Error(`Could not load payment transactions: ${paymentTransactionsResult.error.message}`);
  const dashboardData = parseAdminDashboardData(
    statsResult.data,
    marketRateResult.data,
    depositsTodayResult.data,
    paymentRateResult.data,
    paymentTransactionsResult.data,
  );

  return (
    <AdminDashboard
      data={dashboardData}
      adminEmail={user.email ?? ''}
    />
  );
}
