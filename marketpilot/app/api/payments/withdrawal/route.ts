import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabase/server';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'This payment request is not allowed.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Enter a valid withdrawal amount.' }, { status: 400 });
  }
  const amountUsd = isRecord(body) ? body.amountUsd : null;
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 1) {
    return NextResponse.json({ error: 'Withdrawal amount must be at least $1.00.' }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Sign in to request a withdrawal.' }, { status: 401 });
  }

  const { data, error } = await supabase.rpc('marketpilot_create_withdrawal', {
    p_amount_usd: amountUsd,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!isRecord(data) || typeof data.balance !== 'number') {
    return NextResponse.json({ error: 'The withdrawal request returned an invalid result.' }, { status: 500 });
  }

  return NextResponse.json({
    transactionId: data.id,
    status: 'pending',
    balance: data.balance,
    amountUsd: data.amountUsd,
    amountKes: data.amountKes,
    kesPerUsd: data.kesPerUsd,
  });
}
