import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(request: NextRequest) {
  const url = process.env.SUPABASE_URL?.trim();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !secretKey) {
    return NextResponse.json({ error: 'Account availability checks are not configured.' }, { status: 503 });
  }

  let body: { phone?: unknown };
  try {
    body = await request.json() as { phone?: unknown };
  } catch {
    return NextResponse.json({ error: 'Invalid account details.' }, { status: 400 });
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!phone) {
    return NextResponse.json({ error: 'Invalid account details.' }, { status: 400 });
  }

  const admin = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const phoneResult = await admin
    .from('marketpilot_profiles')
    .select('id')
    .eq('phone_e164', phone)
    .limit(1);

  if (phoneResult.error) {
    console.error('MarketPilot account availability lookup failed.', phoneResult.error.message);
    return NextResponse.json({ error: 'Account availability could not be checked.' }, { status: 503 });
  }

  if (phoneResult.data.length) {
    return NextResponse.json({ available: false, field: 'phone' });
  }
  return NextResponse.json({ available: true });
}
