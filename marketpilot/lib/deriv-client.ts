export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type DerivMessage = Record<string, unknown> & { msg_type?: string; req_id?: number };

type PendingRequest = {
  resolve: (message: DerivMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const DEFAULT_WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';

export function getDerivWsUrl(): string {
  return process.env.NEXT_PUBLIC_DERIV_WS_URL?.trim() || DEFAULT_WS_URL;
}

export class DerivClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(message: DerivMessage) => void>();
  private requestId = 0;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private state: ConnectionState = 'connecting';

  constructor(
    private readonly url: string,
    private readonly onState: (state: ConnectionState) => void,
  ) {
    this.connect();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  listen(listener: (message: DerivMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(payload: Record<string, unknown>): Promise<DerivMessage> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Market data is not connected.'));
    }

    const reqId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error('Market data did not respond before the request timed out.'));
      }, 15_000);

      this.pending.set(reqId, { resolve, reject, timeout });
      try {
        this.socket?.send(JSON.stringify({ ...payload, req_id: reqId }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(reqId);
        reject(error instanceof Error ? error : new Error('Unable to send market data request.'));
      }
    });
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.rejectPending(new Error('Market data connection closed.'));
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.setState('disconnected');
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.retryCount ? 'reconnecting' : 'connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) return;
      this.retryCount = 0;
      this.setState('connected');
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      if (this.socket !== socket) return;
      let message: DerivMessage;
      try {
        message = JSON.parse(event.data) as DerivMessage;
      } catch {
        return;
      }

      const reqId = message.req_id;
      if (typeof reqId === 'number') {
        const request = this.pending.get(reqId);
        if (request) {
          clearTimeout(request.timeout);
          this.pending.delete(reqId);
          if (message.error && typeof message.error === 'object') {
            const error = message.error as { message?: unknown; code?: unknown };
            const detail = [error.code, error.message]
              .filter((value): value is string => typeof value === 'string')
              .join(': ')
              .replace(/\bderiv\b/gi, 'market data provider');
            request.reject(new Error(detail || 'The market data provider returned an API error.'));
          } else {
            request.resolve(message);
          }
        }
      }

      this.listeners.forEach((listener) => listener(message));
    };

    socket.onclose = () => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null;
      this.rejectPending(new Error('Market data connection was interrupted.'));
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.setState('reconnecting');
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

  private setState(state: ConnectionState): void {
    this.state = state;
    this.onState(state);
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

export function normalizeSymbols(value: unknown): MarketSymbol[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    if (typeof row.underlying_symbol !== 'string') return [];
    return [{
      symbol: row.underlying_symbol,
      name: typeof row.underlying_symbol_name === 'string' ? row.underlying_symbol_name : row.underlying_symbol,
      market: typeof row.market === 'string' ? row.market : 'Other',
      submarket: typeof row.submarket === 'string' ? row.submarket : '',
      pipSize: typeof row.pip_size === 'number' ? row.pip_size : 0.01,
      exchangeOpen: row.exchange_is_open === 1,
      suspended: row.is_trading_suspended === 1,
    }];
  });
}

export function normalizeTick(value: unknown): MarketTick | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.symbol !== 'string' ||
    typeof row.quote !== 'number' ||
    typeof row.epoch !== 'number'
  ) return null;
  return {
    symbol: row.symbol,
    quote: row.quote,
    epoch: row.epoch,
    pipSize: typeof row.pip_size === 'number' ? row.pip_size : 0.01,
  };
}

export function normalizeContracts(value: unknown): AvailableContract[] {
  if (!value || typeof value !== 'object') return [];
  const available = (value as { available?: unknown }).available;
  if (!Array.isArray(available)) return [];
  return available.filter((item): item is AvailableContract => (
    !!item &&
    typeof item === 'object' &&
    typeof (item as AvailableContract).contract_type === 'string'
  ));
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

export function parseContractDuration(value: string): { amount: number; unit: string } | null {
  const match = /^(\d+)\s*([tsmhd])$/i.exec(value.trim());
  if (!match) return null;
  return { amount: Number(match[1]), unit: match[2].toLowerCase() };
}
