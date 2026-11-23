import { NextResponse, type NextRequest } from 'next/server';
import { assertMegaPayConfigured, initiateMegaPayStk, MegaPayRejectedError } from '@/lib/megapay';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';
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
    return NextResponse.json({ error: 'Enter a valid deposit amount.' }, { status: 400 });
  }
  const amountUsd = isRecord(body) ? body.amountUsd : null;
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 1) {
    return NextResponse.json({ error: 'Deposit amount must be at least $1.00.' }, { status: 400 });
  }

  try {
    assertMegaPayConfigured();
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'MegaPay is not configured on the server.',
    }, { status: 503 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Sign in to make a deposit.' }, { status: 401 });
  }

  const { data: depositData, error: createError } = await supabase.rpc('marketpilot_create_deposit', {
    p_amount_usd: amountUsd,
  });
  if (createError) {
    return NextResponse.json({ error: createError.message }, { status: 400 });
  }
  if (
    !isRecord(depositData) ||
    typeof depositData.id !== 'string' ||
    typeof depositData.reference !== 'string' ||
    typeof depositData.amountKes !== 'number' ||
    typeof depositData.amountUsd !== 'number' ||
    typeof depositData.phone !== 'string'
  ) {
    return NextResponse.json({ error: 'The deposit request could not be prepared.' }, { status: 500 });
  }

  try {
    const { requestId } = await initiateMegaPayStk({
      amountKes: depositData.amountKes,
      phone: depositData.phone,
      reference: depositData.reference,
    });
    const admin = getSupabaseAdminClient();
    const { error: attachError } = await admin.rpc('marketpilot_payment_attach_request', {
      p_transaction_id: depositData.id,
      p_request_id: requestId,
    });
    if (attachError) {
      console.error('MegaPay request could not be attached to its pending deposit.', attachError.message);
      return NextResponse.json({
        error: 'M-Pesa was prompted, but the request could not be linked to your deposit. Please contact support before retrying.',
        transactionId: depositData.id,
      }, { status: 502 });
    }

    return NextResponse.json({
      transactionId: depositData.id,
      status: 'pending',
      amountUsd: depositData.amountUsd,
      amountKes: depositData.amountKes,
      kesPerUsd: depositData.kesPerUsd,
    });
  } catch (error) {
    if (error instanceof MegaPayRejectedError) {
      try {
        const admin = getSupabaseAdminClient();
        const { error: declineError } = await admin.rpc('marketpilot_payment_mark_deposit_declined', {
          p_transaction_id: depositData.id,
          p_reason: error.message,
        });
        if (declineError) {
          console.error('Rejected MegaPay request could not be recorded.', declineError.message);
          return NextResponse.json({
            error: 'MegaPay rejected the request, but the transaction status could not be saved. Please contact support.',
            transactionId: depositData.id,
          }, { status: 502 });
        }
      } catch (declineError) {
        console.error('Rejected MegaPay request could not be recorded.', declineError);
        return NextResponse.json({
          error: 'MegaPay rejected the request, but the transaction status could not be saved. Please contact support.',
          transactionId: depositData.id,
        }, { status: 502 });
      }
      return NextResponse.json({
        error: error.message,
        transactionId: depositData.id,
      }, { status: 422 });
    }

    console.error('MegaPay STK Push initiation failed.', error);
    return NextResponse.json({
      error: error instanceof Error
        ? `MegaPay could not confirm the STK request: ${error.message}`
        : 'MegaPay could not confirm the STK request.',
      transactionId: depositData.id,
    }, { status: 502 });
  }
}
