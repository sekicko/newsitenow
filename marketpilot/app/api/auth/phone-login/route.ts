import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

const invalidCredentials = () =>
  NextResponse.json({ error: 'Phone number or password is incorrect.' }, { status: 401 });

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'This sign-in request is not allowed.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Enter a valid phone number and password.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Enter a valid phone number and password.' }, { status: 400 });
  }

  const { phone, password } = body as { phone?: unknown; password?: unknown };
  if (
    typeof phone !== 'string' ||
    !/^\+[1-9]\d{7,14}$/.test(phone) ||
    typeof password !== 'string' ||
    password.length < 1 ||
    password.length > 128
  ) {
    return invalidCredentials();
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !publishableKey || !secretKey) {
    return NextResponse.json({ error: 'Phone sign-in is not configured on this server.' }, { status: 503 });
  }

  const admin = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: profile, error: lookupError } = await admin
    .from('marketpilot_profiles')
    .select('email')
    .eq('phone_e164', phone)
    .maybeSingle();

  if (lookupError) {
    console.error('MarketPilot phone sign-in lookup failed.', lookupError.message);
    return NextResponse.json({ error: 'Phone sign-in is temporarily unavailable.' }, { status: 503 });
  }
  if (!profile || typeof profile.email !== 'string') return invalidCredentials();

  const supabase = await createSupabaseServerClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: profile.email,
    password,
  });
  if (signInError) return invalidCredentials();

  return NextResponse.json({ success: true });
}
