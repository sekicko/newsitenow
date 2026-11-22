import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { isAuthSessionMissingError } from '@supabase/supabase-js';
import { AdminDashboard, type AdminDashboardData } from '@/components/admin/admin-dashboard';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseAdminDashboardData(
  value: unknown,
  testDemoWinRate: unknown,
  marketRealWinRate: unknown,
): AdminDashboardData {
  if (!isRecord(value) || !Array.isArray(value.users)) {
    throw new Error('The administrator report returned invalid data.');
  }

  const { totalUsers, activeUsers, dormantUsers, realLossesToday, totalRealBalance } = value;
  const depositsToday = value.depositsToday;
  if (
    !isFiniteNumber(totalUsers) || totalUsers < 0 ||
    !isFiniteNumber(activeUsers) || activeUsers < 0 ||
    !isFiniteNumber(dormantUsers) || dormantUsers < 0 ||
    !isFiniteNumber(realLossesToday) || realLossesToday < 0 ||
    !isFiniteNumber(totalRealBalance) || totalRealBalance < 0 ||
    !isFiniteNumber(testDemoWinRate) || !Number.isInteger(testDemoWinRate) ||
    testDemoWinRate < 0 || testDemoWinRate > 100 ||
    (depositsToday !== null && (!isFiniteNumber(depositsToday) || depositsToday < 0)) ||
    (marketRealWinRate !== null &&
      (!isFiniteNumber(marketRealWinRate) || marketRealWinRate < 0 || marketRealWinRate > 100))
  ) {
    throw new Error('The administrator report returned invalid metrics.');
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

  return {
    totalUsers,
    activeUsers,
    dormantUsers,
    depositsToday,
    realLossesToday,
    totalRealBalance,
    realWinRate: marketRealWinRate,
    testDemoWinRate,
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
  if (userError && !isAuthSessionMissingError(userError)) {
    throw new Error(`Could not verify the current user: ${userError.message}`);
  }
  if (!user) redirect('/');

  const { data: isAdmin, error: roleError } = await supabase.rpc('marketpilot_is_admin');
  if (roleError) throw new Error(`Could not verify administrator access: ${roleError.message}`);
  if (!isAdmin) redirect('/');

  const [statsResult, testRateResult, marketRateResult] = await Promise.all([
    supabase.rpc('marketpilot_admin_dashboard_stats'),
    supabase.rpc('marketpilot_admin_get_demo_test_win_rate'),
    supabase.rpc('marketpilot_admin_get_market_real_win_rate'),
  ]);
  if (statsResult.error) throw new Error(`Could not load administrator reports: ${statsResult.error.message}`);
  if (testRateResult.error) throw new Error(`Could not load test outcome settings: ${testRateResult.error.message}`);
  if (marketRateResult.error) throw new Error(`Could not load historical market win rate: ${marketRateResult.error.message}`);
  const dashboardData = parseAdminDashboardData(
    statsResult.data,
    testRateResult.data,
    marketRateResult.data,
  );

  return (
    <AdminDashboard
      data={dashboardData}
      adminEmail={user.email ?? ''}
    />
  );
}
