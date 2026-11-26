import {
  DERIV_PUBLIC_WS_URL,
  normalizePipSize,
  type MarketTick,
} from '@/lib/market-data';

type DerivResponse = Record<string, unknown> & {
  req_id?: number;
  error?: { code?: string; message?: string };
};

async function requestDeriv(payload: Record<string, unknown>): Promise<DerivResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(DERIV_PUBLIC_WS_URL);
    const timeout = setTimeout(() => {
      finish(new Error('Deriv did not return market data before the request timed out.'));
    }, 10_000);

    const finish = (error?: Error, response?: DerivResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else if (response) resolve(response);
      else reject(new Error('Deriv returned an empty market-data response.'));
    };

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ ...payload, req_id: 1 }));
      } catch {
        finish(new Error('Could not send the market-data request to Deriv.'));
      }
    }, { once: true });

    socket.addEventListener('message', (event) => {
      let response: DerivResponse;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        response = parsed as DerivResponse;
      } catch {
        finish(new Error('Deriv returned malformed market data.'));
        return;
      }
      if (response.req_id !== 1) return;
      if (response.error) {
        const detail = [response.error.code, response.error.message]
          .filter((value): value is string => typeof value === 'string')
          .join(': ');
        finish(new Error(detail || 'Deriv rejected the market-data request.'));
        return;
      }
      finish(undefined, response);
    });

    socket.addEventListener('error', () => {
      finish(new Error('Could not connect to Deriv public market data.'));
    }, { once: true });

    socket.addEventListener('close', () => {
      if (!settled) finish(new Error('Deriv closed the market-data connection unexpectedly.'));
    }, { once: true });
  });
}

export async function getDerivTickHistory(
  symbol: string,
  options: { count: number; start?: number },
): Promise<MarketTick[]> {
  const response = await requestDeriv({
    ticks_history: symbol,
    count: options.count,
    ...(options.start === undefined ? {} : { start: options.start }),
    end: 'latest',
    style: 'ticks',
    adjust_start_time: 1,
  });
  const history = response.history as { prices?: unknown; times?: unknown } | undefined;
  const pipSize = normalizePipSize(response.pip_size);
  if (
    !Array.isArray(history?.prices) ||
    !Array.isArray(history.times) ||
    pipSize === null ||
    pipSize <= 0
  ) {
    throw new Error('Deriv did not return valid tick history.');
  }

  const prices: unknown[] = history.prices;
  const times: unknown[] = history.times;
  return prices.flatMap((quote, index) => {
    const epoch = times[index];
    if (
      typeof quote !== 'number' ||
      !Number.isFinite(quote) ||
      typeof epoch !== 'number' ||
      !Number.isInteger(epoch)
    ) return [];
    return [{ symbol, quote, epoch, pipSize }];
  });
}
