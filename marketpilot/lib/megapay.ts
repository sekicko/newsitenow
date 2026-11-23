import 'server-only';

type MegaPayCredentials = {
  apiKey: string;
  email: string;
};

export class MegaPayRejectedError extends Error {}

function getCredentials(): MegaPayCredentials {
  const apiKey = process.env.MEGAPAY_API_KEY?.trim();
  const email = process.env.MEGAPAY_ACCOUNT_EMAIL?.trim();
  if (!apiKey || !email) {
    throw new Error('MegaPay is not configured on the server.');
  }
  return { apiKey, email };
}

export function assertMegaPayConfigured(): void {
  getCredentials();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function postMegaPay(
  endpoint: 'initiatestk' | 'transactionstatus',
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`https://megapay.co.ke/backend/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    cache: 'no-store',
  });

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('MegaPay returned an invalid response.');
  }
  if (!isRecord(result)) throw new Error('MegaPay returned an invalid response.');
  if (!response.ok) {
    const message = typeof result.message === 'string'
      ? result.message
      : typeof result.massage === 'string'
        ? result.massage
        : 'MegaPay could not process the request.';
    throw new Error(message);
  }
  return result;
}

export async function initiateMegaPayStk(input: {
  amountKes: number;
  phone: string;
  reference: string;
}): Promise<{ requestId: string }> {
  const credentials = getCredentials();
  const result = await postMegaPay('initiatestk', {
    api_key: credentials.apiKey,
    email: credentials.email,
    amount: String(input.amountKes),
    msisdn: input.phone.replace(/^\+/, ''),
    reference: input.reference,
  });

  const requestId = result.transaction_request_id;
  if (
    (result.success !== '200' && result.success !== 200) ||
    typeof requestId !== 'string' ||
    requestId.length < 1 ||
    requestId.length > 200
  ) {
    const message = typeof result.massage === 'string'
      ? result.massage
      : 'MegaPay did not accept the M-Pesa payment request.';
    throw new MegaPayRejectedError(message);
  }

  return { requestId };
}

export async function getMegaPayTransactionStatus(requestId: string) {
  const credentials = getCredentials();
  return postMegaPay('transactionstatus', {
    api_key: credentials.apiKey,
    email: credentials.email,
    transaction_request_id: requestId,
  });
}
