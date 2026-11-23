import 'server-only';

import { createClient } from '@supabase/supabase-js';
import type { PaymentAdminClient, PaymentAdminDatabase } from '@/lib/supabase/payment-admin-database';

let adminClient: PaymentAdminClient | null = null;

export function getSupabaseAdminClient(): PaymentAdminClient {
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey) {
    throw new Error('Server-side Supabase services are not configured.');
  }

  adminClient ??= createClient<PaymentAdminDatabase>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminClient;
}
