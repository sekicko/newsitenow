'use client';

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

let browserClient: SupabaseClient | null = null;

export function getSupabaseBrowserClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) {
    throw new Error('Account services are not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.');
  }
  browserClient ??= createBrowserClient(url, publishableKey);
  return browserClient;
}
