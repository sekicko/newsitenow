import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { MarketPilotDashboard } from '@/components/dashboard';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export default async function HomePage() {
  await connection();

  if (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_PUBLISHABLE_KEY?.trim()) {
    const supabase = await createSupabaseServerClient();
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError) throw new Error(`Could not verify the current user: ${userError.message}`);

    if (user) {
      const { data: isAdmin, error: roleError } = await supabase.rpc('marketpilot_is_admin');
      if (roleError) throw new Error(`Could not verify administrator access: ${roleError.message}`);
      if (isAdmin) redirect('/admin');
    }
  }

  return <MarketPilotDashboard />;
}
