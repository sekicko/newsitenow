import { NextResponse, type NextRequest } from 'next/server';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { assertMegaPayConfigured, initiateMegaPayStk, MegaPayRejectedError } from '@/lib/megapay';
import { assertSupabaseAdminConfigured, getSupabaseAdminClient } from '@/lib/supabase/admin';
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
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 500) {
    return NextResponse.json({ error: 'Deposit amount must be between $1.00 and $500.00.' }, { status: 400 });
  }
  const phoneInput = isRecord(body) ? body.phone : null;
  const phone = typeof phoneInput === 'string' ? parsePhoneNumberFromString(phoneInput.trim()) : undefined;
  if (!phone?.isValid()) {
    return NextResponse.json({ error: 'Enter a valid phone number in international format, including its +country code.' }, { status: 400 });
  }

  try {
    assertMegaPayConfigured();
  } catch {
    return NextResponse.json({
      error: 'Deposits are temporarily unavailable. Please try again later.',
    }, { status: 503 });
  }

  const supabase = await createSupabaseServerClient();
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: 'Sign in to make a deposit.' }, { status: 401 });
  }

  try {
    assertSupabaseAdminConfigured();
  } catch {
    return NextResponse.json({
      error: 'Deposits are temporarily unavailable. Please try again later.',
    }, { status: 503 });
  }

  const { data: depositData, error: createError } = await supabase.rpc('marketpilot_create_deposit', {
    p_amount_usd: amountUsd,
    p_phone_e164: phone.number,
  });
  if (createError) {
    console.error('Deposit record could not be created.', createError.message);
    return NextResponse.json({ error: 'The deposit could not be started. Please try again.' }, { status: 400 });
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
        status: 'pending',
        message: 'Your payment is awaiting confirmation. Check the transaction status before trying again.',
        transactionId: depositData.id,
      }, { status: 202 });
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
      console.error('Deposit initiation needs confirmation.', error.message);
      if (error.requestId) {
        try {
          const admin = getSupabaseAdminClient();
          const { error: attachError } = await admin.rpc('marketpilot_payment_attach_request', {
            p_transaction_id: depositData.id,
            p_request_id: error.requestId,
          });
          if (attachError) {
            console.error('Pending deposit request could not be linked.', attachError.message);
          }
        } catch (attachError) {
          console.error('Pending deposit request could not be linked.', attachError);
        }
      }
      return NextResponse.json({
        status: 'pending',
        message: 'Your payment is awaiting confirmation. Check the transaction status before trying again.',
        transactionId: depositData.id,
        amountUsd: depositData.amountUsd,
        amountKes: depositData.amountKes,
        kesPerUsd: depositData.kesPerUsd,
      }, { status: 202 });
    }

    console.error('MegaPay STK Push initiation failed.', error);
    return NextResponse.json({
      status: 'pending',
      message: 'Your payment is awaiting confirmation. Check the transaction status before trying again.',
      transactionId: depositData.id,
      amountUsd: depositData.amountUsd,
      amountKes: depositData.amountKes,
      kesPerUsd: depositData.kesPerUsd,
    }, { status: 202 });
  }
}
