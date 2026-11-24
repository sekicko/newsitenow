import 'server-only';

type MegaPayCredentials = {
  apiKey: string;
  email: string;
};

export class MegaPayRejectedError extends Error {
  constructor(message: string, readonly requestId: string | null = null) {
    super(message);
  }
}

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

function getRequestId(result: Record<string, unknown>): string | null {
  const requestId = [result.transaction_request_id, result.checkout_id]
    .find((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200);
  return requestId ?? null;
}

function getTransactionStatusResponse(result: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['data', 'transaction', 'result']) {
    const nested = result[key];
    if (isRecord(nested)) return nested;
  }
  return result;
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
    const requestId = endpoint === 'initiatestk' ? getRequestId(result) : null;
    if (endpoint === 'initiatestk') throw new MegaPayRejectedError(message, requestId);
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

  const requestId = getRequestId(result);
  if (!requestId) {
    const message = typeof result.massage === 'string'
      ? result.massage
      : 'The payment request did not return a confirmation reference.';
    throw new MegaPayRejectedError(message);
  }

  const initiationStatus = typeof result.status === 'string' ? result.status.trim().toLowerCase() : '';
  if (
    result.success !== '200' &&
    result.success !== 200 &&
    initiationStatus !== 'success' &&
    initiationStatus !== 'successful'
  ) {
    const message = typeof result.massage === 'string'
      ? result.massage
      : 'The payment request needs status confirmation.';
    throw new MegaPayRejectedError(message, requestId);
  }

  return { requestId };
}

export async function getMegaPayTransactionStatus(requestId: string) {
  const credentials = getCredentials();
  const result = await postMegaPay('transactionstatus', {
    api_key: credentials.apiKey,
    email: credentials.email,
    transaction_request_id: requestId,
  });
  return getTransactionStatusResponse(result);
}
