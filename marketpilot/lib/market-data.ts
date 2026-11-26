export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type DerivMessage = Record<string, unknown> & {
  msg_type?: string;
  req_id?: number;
};

type PendingRequest = {
  resolve: (message: DerivMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export const DERIV_PUBLIC_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

export class DerivPublicClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(message: DerivMessage) => void>();
  private requestId = 0;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly onState: (state: ConnectionState) => void) {
    this.connect();
  }

  listen(listener: (message: DerivMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(payload: Record<string, unknown>): Promise<DerivMessage> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Deriv market data is not connected.'));
    }

    const reqId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('Deriv market data did not respond before the request timed out.'));
      }, 12_000);

      this.pending.set(reqId, { resolve, reject, timeout });
      try {
        this.socket?.send(JSON.stringify({ ...payload, req_id: reqId }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(reqId);
        reject(error instanceof Error ? error : new Error('Unable to request Deriv market data.'));
      }
    });
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.retryTimer = null;
    this.pingTimer = null;
    this.rejectPending(new Error('Deriv market data client was closed.'));
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.onState('disconnected');
  }

  private connect(): void {
    if (this.stopped) return;
    this.onState(this.retryCount ? 'reconnecting' : 'connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(DERIV_PUBLIC_WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.retryCount = 0;
      this.onState('connected');
      this.pingTimer = setInterval(() => {
        const activeSocket = this.socket;
        if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
        void this.request({ ping: 1 }).catch(() => {
          if (this.socket === activeSocket) activeSocket.close();
        });
      }, 45_000);
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      if (this.socket !== socket) return;
      let message: DerivMessage;
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        message = parsed as DerivMessage;
      } catch {
        return;
      }

      if (typeof message.req_id === 'number') {
        const request = this.pending.get(message.req_id);
        if (request) {
          clearTimeout(request.timeout);
          this.pending.delete(message.req_id);
          if (message.error && typeof message.error === 'object') {
            const error = message.error as { message?: unknown; code?: unknown };
            const detail = [error.code, error.message]
              .filter((value): value is string => typeof value === 'string')
              .join(': ');
            request.reject(new Error(detail || 'Deriv returned a market-data error.'));
          } else {
            request.resolve(message);
          }
        }
      }

      this.listeners.forEach((listener) => listener(message));
    };

    socket.onerror = () => {
      if (this.socket === socket && !this.stopped) socket.close();
    };

    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.rejectPending(new Error('The Deriv market-data connection was interrupted.'));
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.onState('reconnecting');
    const delay = Math.min(1_000 * 2 ** this.retryCount, 20_000);
    this.retryCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private rejectPending(error: Error): void {
    this.pending.forEach((request) => {
      clearTimeout(request.timeout);
      request.reject(error);
    });
    this.pending.clear();
  }
}

export type MarketSymbol = {
  symbol: string;
  name: string;
  market: string;
  submarket: string;
  pipSize: number;
  exchangeOpen: boolean;
  suspended: boolean;
};

export type MarketTick = {
  symbol: string;
  quote: number;
  epoch: number;
  pipSize: number;
};

export type MarketCandle = {
  symbol: string;
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
  pipSize: number;
};

export type ChartStyle = 'area' | 'candlestick';

export type AvailableContract = {
  contract_type: string;
  contract_category: string;
  expiry_type: string;
  min_contract_duration: string;
  max_contract_duration: string;
  sentiment: string;
  barriers: number;
  last_digit_range?: number[];
};

export const VOLATILITY_SYMBOLS = [
  { symbol: 'R_10', name: 'Volatility 10 Index' },
  { symbol: 'R_25', name: 'Volatility 25 Index' },
  { symbol: 'R_50', name: 'Volatility 50 Index' },
  { symbol: 'R_75', name: 'Volatility 75 Index' },
  { symbol: 'R_100', name: 'Volatility 100 Index' },
  { symbol: '1HZ10V', name: 'Volatility 10 (1s) Index' },
  { symbol: '1HZ25V', name: 'Volatility 25 (1s) Index' },
  { symbol: '1HZ50V', name: 'Volatility 50 (1s) Index' },
  { symbol: '1HZ75V', name: 'Volatility 75 (1s) Index' },
  { symbol: '1HZ100V', name: 'Volatility 100 (1s) Index' },
] as const;

export type PracticeKind = 'over-under' | 'even-odd' | 'matches-differs' | 'rise-fall';

export const CONTRACT_TYPES: Record<PracticeKind, string[]> = {
  'over-under': ['DIGITOVER', 'DIGITUNDER'],
  'even-odd': ['DIGITEVEN', 'DIGITODD'],
  'matches-differs': ['DIGITMATCH', 'DIGITDIFF'],
  'rise-fall': ['CALL', 'PUT'],
};

export const CONTRACT_LABELS: Record<string, string> = {
  DIGITOVER: 'Over',
  DIGITUNDER: 'Under',
  DIGITEVEN: 'Even',
  DIGITODD: 'Odd',
  DIGITMATCH: 'Matches',
  DIGITDIFF: 'Differs',
  CALL: 'Rise',
  PUT: 'Fall',
};

export function normalizePipSize(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) return null;
  return Number.isInteger(value) ? 10 ** -value : value;
}

export function normalizeSymbols(value: unknown): MarketSymbol[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const pipSize = normalizePipSize(row.pip_size);
    if (
      typeof row.underlying_symbol !== 'string' ||
      typeof row.underlying_symbol_name !== 'string' ||
      typeof row.market !== 'string' ||
      typeof row.submarket !== 'string' ||
      pipSize === null ||
      pipSize <= 0
    ) return [];
    return [{
      symbol: row.underlying_symbol,
      name: row.underlying_symbol_name,
      market: row.market,
      submarket: row.submarket,
      pipSize,
      exchangeOpen: row.exchange_is_open === 1,
      suspended: row.is_trading_suspended === 1,
    }];
  });
}

export function normalizeTick(value: unknown): MarketTick | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const pipSize = normalizePipSize(row.pip_size);
  if (
    typeof row.symbol !== 'string' ||
    typeof row.quote !== 'number' ||
    !Number.isFinite(row.quote) ||
    typeof row.epoch !== 'number' ||
    !Number.isInteger(row.epoch) ||
    pipSize === null ||
    pipSize <= 0
  ) return null;
  return {
    symbol: row.symbol,
    quote: row.quote,
    epoch: row.epoch,
    pipSize,
  };
}

export function normalizeContracts(value: unknown): AvailableContract[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const available = (value as { available?: unknown }).available;
  if (!Array.isArray(available)) return [];
  return available.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.contract_type !== 'string' ||
      typeof row.contract_category !== 'string' ||
      typeof row.expiry_type !== 'string' ||
      typeof row.min_contract_duration !== 'string' ||
      typeof row.max_contract_duration !== 'string'
    ) return [];
    return [{
      contract_type: row.contract_type,
      contract_category: row.contract_category,
      expiry_type: row.expiry_type,
      min_contract_duration: row.min_contract_duration,
      max_contract_duration: row.max_contract_duration,
      sentiment: typeof row.sentiment === 'string' ? row.sentiment : '',
      barriers: typeof row.barriers === 'number' ? row.barriers : 0,
    }];
  });
}

export function precisionFromPip(pipSize: number): number {
  if (Number.isInteger(pipSize) && pipSize >= 1) return Math.min(pipSize, 10);
  if (pipSize > 0 && pipSize < 1) return Math.min(Math.max(0, Math.round(-Math.log10(pipSize))), 10);
  return 2;
}

export function getLastDigit(tick: MarketTick): number {
  const precision = precisionFromPip(tick.pipSize);
  const formatted = tick.quote.toFixed(precision);
  return Number(formatted.at(-1));
}

export function getMarketPilotTickDigit(tick: MarketTick): number {
  const precision = precisionFromPip(tick.pipSize);
  const identity = `${tick.symbol}|${tick.epoch}|${tick.quote.toFixed(precision)}|${tick.pipSize}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) % 10;
}

export function parseContractDuration(value: string): { amount: number; unit: string } | null {
  const match = /^(\d+)\s*([tsmhd])$/i.exec(value.trim());
  if (!match) return null;
  return { amount: Number(match[1]), unit: match[2].toLowerCase() };
}
