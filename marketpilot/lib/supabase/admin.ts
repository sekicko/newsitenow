import 'server-only';

import { createClient } from '@supabase/supabase-js';
import type { PaymentAdminClient, PaymentAdminDatabase } from '@/lib/supabase/payment-admin-database';

let adminClient: PaymentAdminClient | null = null;

export function getSupabaseServerKey(): string | null {
  const key = process.env.SUPABASE_SECRET_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return key || null;
}

export function getSupabaseAdminClient(): PaymentAdminClient {
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = getSupabaseServerKey();
  if (!url || !secretKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY for server-side Supabase services.');
  }

  adminClient ??= createClient<PaymentAdminDatabase>(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return adminClient;
}

export function assertSupabaseAdminConfigured(): void {
  getSupabaseAdminClient();
}
