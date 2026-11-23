import 'server-only';

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

function isReadOnlyServerComponentCookieError(error: unknown): boolean {
  return error instanceof Error &&
    error.message.startsWith('Cookies can only be modified in a Server Action or Route Handler');
}

export async function createSupabaseServerClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) {
    throw new Error('Supabase account services are not configured.');
  }

  const cookieStore = await cookies();
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch (error) {
          if (!isReadOnlyServerComponentCookieError(error)) throw error;
        }
      },
    },
  });
}
