'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Activity,
  BarChart3,
  ChevronDown,
  Clock3,
  History,
  LogOut,
  Menu,
  Moon,
  RotateCcw,
  Settings,
  Sun,
  Wifi,
  WifiOff,
  Wallet,
  X,
} from 'lucide-react';
import { AuthControls } from '@/components/auth/auth-controls';
import { PriceChart } from '@/components/price-chart';
import { AccountSettings } from '@/components/settings/account-settings';
import { useMarketData } from '@/hooks/use-market-data';
import {
  CONTRACT_LABELS,
  CONTRACT_TYPES,
  VOLATILITY_SYMBOLS,
  getLastDigit,
  parseContractDuration,
  precisionFromPip,
  type AvailableContract,
  type MarketTick,
  type PracticeKind,
} from '@/lib/deriv-client';
import { getFixedContractPayout, type PracticeTrade } from '@/lib/practice';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { User } from '@supabase/supabase-js';
import type { WalletAccount, WalletBalances } from '@/lib/wallets';

const kindLabels: Record<PracticeKind, string> = {
  'over-under': 'Over / Under',
  'even-odd': 'Even / Odd',
  'matches-differs': 'Matches / Differs',
  'rise-fall': 'Rise / Fall',
};

type DashboardPage = 'hub' | 'cashier' | 'history' | 'settings';
const sidebarItems = [
  { page: 'hub', label: 'Traders Hub', icon: Activity },
  { page: 'cashier', label: 'Cashier', icon: Wallet },
  { page: 'history', label: 'Trade History', icon: History },
  { page: 'settings', label: 'Settings', icon: Settings },
] as const satisfies readonly { page: DashboardPage; label: string; icon: typeof Activity }[];

const contractDefaults: Record<PracticeKind, string> = {
  'over-under': 'DIGITOVER',
  'even-odd': 'DIGITEVEN',
  'matches-differs': 'DIGITMATCH',
  'rise-fall': 'CALL',
};

const WALLET_CURRENCY = 'USD';
type PracticeQuote = { askPrice: number; payout: number };
type TradeHistoryView = 'all' | 'open' | 'closed';
type DigitExitHighlight = {
  tradeId: string;
  symbol: string;
  digit: number;
  outcome: 'win' | 'loss';
};

type CashierTransaction = {
  id: string;
  accountType: WalletAccount;
  type: 'deposit' | 'withdrawal';
  status: 'completed' | 'pending' | 'declined' | 'failed';
  amount: number;
  createdAt: string;
};

function storedNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadCashierTransactions(userId: string): Promise<CashierTransaction[]> {
  const { data, error } = await getSupabaseBrowserClient()
    .from('marketpilot_transactions')
    .select('id,transaction_type,status,amount_usd,created_at')
    .eq('user_id', userId)
    .eq('account_type', 'real')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;

  return (data ?? []).flatMap((row) => {
    const amount = storedNumber(row.amount_usd);
    if (
      typeof row.id !== 'string' ||
      (row.transaction_type !== 'deposit' && row.transaction_type !== 'withdrawal') ||
      (row.status !== 'completed' && row.status !== 'pending' && row.status !== 'declined' && row.status !== 'failed') ||
      amount === null ||
      typeof row.created_at !== 'string'
    ) return [];
    return [{
      id: row.id,
      accountType: 'real',
      type: row.transaction_type,
      status: row.status,
      amount,
      createdAt: row.created_at,
    }];
  });
}

function parseStoredTrade(value: unknown, entrySerial: number): PracticeTrade | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    (row.account_type !== 'real' && row.account_type !== 'demo') ||
    typeof row.symbol !== 'string' ||
    typeof row.contract_type !== 'string' ||
    !Object.prototype.hasOwnProperty.call(CONTRACT_LABELS, row.contract_type) ||
    (row.status !== 'open' && row.status !== 'won' && row.status !== 'lost')
  ) return null;

  const duration = storedNumber(row.duration);
  const stake = storedNumber(row.stake);
  const quotedPayout = storedNumber(row.quoted_payout);
  const entryPrice = storedNumber(row.entry_price);
  const entryPipSize = storedNumber(row.entry_pip_size);
  const entryDigit = storedNumber(row.entry_digit);
  const entryEpoch = storedNumber(row.entry_epoch);
  const elapsed = storedNumber(row.elapsed);
  const outcomeSource = row.outcome_source ?? 'market_data';
  if (
    duration === null ||
    stake === null ||
    quotedPayout === null ||
    entryPrice === null ||
    entryPipSize === null ||
    entryDigit === null ||
    entryEpoch === null ||
    elapsed === null ||
    outcomeSource !== 'market_data' ||
    typeof row.duration_unit !== 'string'
  ) return null;

  const barrier = row.barrier === null ? null : storedNumber(row.barrier);
  const exitPrice = row.exit_price === null ? null : storedNumber(row.exit_price);
  const exitPipSize = row.exit_pip_size === null ? null : storedNumber(row.exit_pip_size);
  const exitDigit = row.exit_digit === null ? null : storedNumber(row.exit_digit);
  const exitEpoch = row.exit_epoch === null ? null : storedNumber(row.exit_epoch);
  const payout = storedNumber(row.payout);
  const profit = row.profit === null ? null : storedNumber(row.profit);
  if (
    (row.barrier !== null && barrier === null) ||
    (row.exit_price !== null && exitPrice === null) ||
    (row.exit_pip_size !== null && exitPipSize === null) ||
    (row.exit_digit !== null && exitDigit === null) ||
    (row.exit_epoch !== null && exitEpoch === null) ||
    payout === null ||
    (row.profit !== null && profit === null)
  ) return null;

  const contractLabel = CONTRACT_LABELS[row.contract_type];
  return {
    id: row.id,
    accountType: row.account_type,
    symbol: row.symbol,
    contractType: row.contract_type,
    contractLabel: `${contractLabel}${barrier === null ? '' : ` ${barrier}`}`,
    barrier,
    duration,
    durationUnit: row.duration_unit,
    stake,
    quotedPayout,
    entryPrice,
    entryPipSize,
    entryDigit,
    entryEpoch,
    entrySerial,
    elapsed: Math.min(elapsed, duration),
    status: row.status === 'open' ? 'Open' : row.status === 'won' ? 'Won' : 'Lost',
    ...(exitPrice === null ? {} : { exitPrice }),
    ...(exitPipSize === null ? {} : { exitPipSize }),
    ...(exitDigit === null ? {} : { exitDigit }),
    ...(exitEpoch === null ? {} : { exitEpoch }),
    payout,
    ...(profit === null ? {} : { profit }),
  };
}

function localTime(epoch: number): string {
  return new Date(epoch * 1_000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

type SettlementResult = {
  balance: number;
  status: 'won' | 'lost';
  payout: number;
  profit: number;
};

function parseSettlementResult(value: unknown): SettlementResult | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const balance = storedNumber(row.balance);
  const payout = storedNumber(row.payout);
  const profit = storedNumber(row.profit);
  if (
    balance === null ||
    payout === null ||
    profit === null ||
    (row.status !== 'won' && row.status !== 'lost') ||
    row.outcomeSource !== 'market_data'
  ) return null;
  return {
    balance,
    status: row.status,
    payout,
    profit,
  };
}

function parsePersistedSettlement(value: unknown, balance: number, entrySerial: number): SettlementResult | null {
  const trade = parseStoredTrade(value, entrySerial);
  if (
    !trade ||
    trade.status === 'Open' ||
    trade.exitPrice === undefined ||
    trade.exitPipSize === undefined ||
    trade.exitDigit === undefined ||
    trade.exitEpoch === undefined ||
    trade.payout === undefined ||
    trade.profit === undefined ||
    balance < 0
  ) return null;

  return {
    balance,
    status: trade.status === 'Won' ? 'won' : 'lost',
    payout: trade.payout,
    profit: trade.profit,
  };
}

function supportsTickDuration(contract: AvailableContract): boolean {
  return contract.expiry_type === 'tick' &&
    parseContractDuration(contract.min_contract_duration)?.unit === 't' &&
    parseContractDuration(contract.max_contract_duration)?.unit === 't';
}

function marketLabel(market: string): string {
  return market.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

type TradeHistoryPanelProps = {
  id?: string;
  activeWallet: WalletAccount;
  activeTradeView: TradeHistoryView;
  historyError: string;
  walletTrades: PracticeTrade[];
  visibleTrades: PracticeTrade[];
  totalProfit: number;
  onTradeViewChange: (view: TradeHistoryView) => void;
};

function TradeHistoryPanel({
  id = 'history',
  activeWallet,
  activeTradeView,
  historyError,
  walletTrades,
  visibleTrades,
  totalProfit,
  onTradeViewChange,
}: TradeHistoryPanelProps) {
  const openTrades = walletTrades.filter((trade) => trade.status === 'Open');
  const settledTrades = walletTrades.filter((trade) => trade.status !== 'Open');

  return (
    <section className="panel history-panel" id={id}>
      <div className="section-heading history-heading">
        <div>
          <p className="eyebrow">YOUR SESSION</p>
          <h2>Trade history · {activeWallet === 'real' ? 'Real' : 'Demo'}</h2>
        </div>
        <div className="history-summary">
          <span>{walletTrades.length} trades</span>
          <strong className={totalProfit > 0 ? 'positive' : totalProfit < 0 ? 'negative' : ''}>
            {totalProfit > 0 ? '+' : ''}{totalProfit.toFixed(2)} USD
          </strong>
        </div>
      </div>
      <div className="history-tabs">
        {(['all', 'open', 'closed'] as const).map((view) => (
          <button
            key={view}
            type="button"
            className={activeTradeView === view ? 'selected' : ''}
            onClick={() => onTradeViewChange(view)}
          >
            {view === 'all' ? 'All trades' : view === 'open' ? 'Open' : 'Settled'}
            <span>{view === 'all' ? walletTrades.length : view === 'open' ? openTrades.length : settledTrades.length}</span>
          </button>
        ))}
      </div>
      {historyError && <p className="trade-action-error" role="status">{historyError}</p>}
      {visibleTrades.length ? (
        <div className="trade-list">
          {visibleTrades.map((trade) => <TradeRow key={trade.id} trade={trade} currency="USD" />)}
        </div>
      ) : (
        <div className="empty-history">
          <span className="empty-icon"><BarChart3 size={17} /></span>
          <span>No trades yet</span>
          <small>Your completed and open trades will appear here.</small>
        </div>
      )}
    </section>
  );
}

export function MarketPilotDashboard() {
  const market = useMarketData();
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [kind, setKind] = useState<PracticeKind>('over-under');
  const [contractType, setContractType] = useState(contractDefaults['over-under']);
  const [digit, setDigit] = useState('3');
  const [duration, setDuration] = useState('5');
  const [stake, setStake] = useState('1');
  const [quote, setQuote] = useState<PracticeQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [alternativeQuote, setAlternativeQuote] = useState<PracticeQuote | null>(null);
  const [alternativeQuoteLoading, setAlternativeQuoteLoading] = useState(false);
  const [alternativeQuoteError, setAlternativeQuoteError] = useState('');
  const [walletBalances, setWalletBalances] = useState<WalletBalances | null>(null);
  const [activeWallet, setActiveWallet] = useState<WalletAccount>('demo');
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [tradeActionError, setTradeActionError] = useState('');
  const [cashierError, setCashierError] = useState('');
  const [cashierMessage, setCashierMessage] = useState('');
  const [cashierResetting, setCashierResetting] = useState(false);
  const [cashierTransactions, setCashierTransactions] = useState<CashierTransaction[]>([]);
  const [cashierTransactionsOwner, setCashierTransactionsOwner] = useState<string | null>(null);
  const [cashierTransactionsLoading, setCashierTransactionsLoading] = useState(false);
  const [cashierDepositSuccess, setCashierDepositSuccess] = useState<{ transactionId: string; amount: number } | null>(null);
  const [cashierDepositConfirmation, setCashierDepositConfirmation] = useState<'pending' | 'failed' | null>(null);
  const [cashierTrackedDepositId, setCashierTrackedDepositId] = useState<string | null>(null);
  const [cashierDepositCheckError, setCashierDepositCheckError] = useState('');
  const [cashierKesPerUsd, setCashierKesPerUsd] = useState<number | null>(null);
  const [cashierPaymentMode, setCashierPaymentMode] = useState<'deposit' | 'withdrawal' | null>(null);
  const [cashierPaymentAmount, setCashierPaymentAmount] = useState('10');
  const [cashierPaymentPhone, setCashierPaymentPhone] = useState('');
  const [cashierPaymentPhoneLoading, setCashierPaymentPhoneLoading] = useState(false);
  const [cashierPaymentBusy, setCashierPaymentBusy] = useState(false);
  const [cashierMarketTrends, setCashierMarketTrends] = useState<Record<string, number[]>>({});
  const [sidebarError, setSidebarError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [openingTrade, setOpeningTrade] = useState(false);
  const [trades, setTrades] = useState<PracticeTrade[]>([]);
  const [digitExitHighlight, setDigitExitHighlight] = useState<DigitExitHighlight | null>(null);
  const [activeTradeView, setActiveTradeView] = useState<TradeHistoryView>('all');
  const [marketMenuOpen, setMarketMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState<DashboardPage>('hub');
  const tradeCounter = useRef(0);
  const openingTradeRef = useRef(false);
  const settlingTradeIdsRef = useRef(new Set<string>());
  const cashierStatusChecksRef = useRef(new Set<string>());
  const cashierBalanceRefreshesRef = useRef(new Set<string>());
  const cashierStatusBatchRef = useRef(0);
  const digitExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDigitExitHighlight = useCallback(() => {
    if (digitExitTimerRef.current !== null) clearTimeout(digitExitTimerRef.current);
    digitExitTimerRef.current = null;
    setDigitExitHighlight(null);
  }, []);
  const changeActiveWallet = useCallback((wallet: WalletAccount) => {
    setActiveWallet(wallet);
    setTradeActionError('');
    setCashierError('');
    setCashierMessage('');
    setActiveTradeView('all');
    clearDigitExitHighlight();
  }, [clearDigitExitHighlight]);
  const showDigitExitHighlight = useCallback((highlight: DigitExitHighlight) => {
    if (digitExitTimerRef.current !== null) clearTimeout(digitExitTimerRef.current);
    setDigitExitHighlight(highlight);
    digitExitTimerRef.current = setTimeout(() => {
      setDigitExitHighlight((current) => current?.tradeId === highlight.tradeId ? null : current);
      digitExitTimerRef.current = null;
    }, 2_000);
  }, []);
  const authUserIdRef = useRef(authUser?.id);
  authUserIdRef.current = authUser?.id;
  const tickSerialRef = useRef(market.tickSerial);
  tickSerialRef.current = market.tickSerial;
  const marketSelectorRef = useRef<HTMLDivElement>(null);
  const marketSelectorButtonRef = useRef<HTMLButtonElement>(null);
  const marketOptionsRef = useRef<HTMLDivElement>(null);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMenuCloseRef = useRef<HTMLButtonElement>(null);
  const onAuthUserChange = useCallback((user: User | null) => setAuthUser(user), []);

  useEffect(() => {
    setCashierDepositSuccess(null);
    setCashierDepositConfirmation(null);
    setCashierTrackedDepositId(null);
    setCashierDepositCheckError('');
  }, [authUser?.id]);

  useEffect(() => {
    if (!cashierTrackedDepositId || cashierTransactionsOwner !== authUser?.id) return;
    const transaction = cashierTransactions.find((item) => item.id === cashierTrackedDepositId);
    if (!transaction || transaction.type !== 'deposit') return;

    if (transaction.status === 'completed') {
      setCashierDepositConfirmation(null);
      setCashierDepositSuccess({ transactionId: transaction.id, amount: transaction.amount });
      setCashierDepositCheckError('');
    } else if (transaction.status === 'failed' || transaction.status === 'declined') {
      setCashierDepositSuccess(null);
      setCashierDepositConfirmation('failed');
    }
  }, [authUser?.id, cashierTrackedDepositId, cashierTransactions, cashierTransactionsOwner]);

  useEffect(() => {
    if (!authUser?.id || !cashierTrackedDepositId || cashierTransactionsOwner !== authUser.id) return;
    const transaction = cashierTransactions.find((item) => item.id === cashierTrackedDepositId);
    if (
      transaction?.type !== 'deposit' ||
      transaction.status !== 'completed' ||
      cashierBalanceRefreshesRef.current.has(transaction.id)
    ) return;

    const userId = authUser.id;
    cashierBalanceRefreshesRef.current.add(transaction.id);
    let active = true;
    const refreshBalance = async () => {
      try {
        const { data, error } = await getSupabaseBrowserClient()
          .from('marketpilot_wallets')
          .select('balance')
          .eq('user_id', userId)
          .eq('account_type', 'real')
          .maybeSingle();
        if (!active) return;
        if (error) throw error;
        const balance = data ? storedNumber(data.balance) : null;
        if (balance === null || balance < 0) throw new Error('Real wallet balance returned an invalid value.');
        setWalletBalances((current) => current ? { ...current, real: balance } : current);
      } catch (error) {
        cashierBalanceRefreshesRef.current.delete(transaction.id);
        if (active && authUserIdRef.current === userId) {
          setCashierError(error instanceof Error ? error.message : 'Real wallet balance could not be refreshed.');
        }
      }
    };
    void refreshBalance();

    return () => {
      active = false;
    };
  }, [authUser?.id, cashierTrackedDepositId, cashierTransactions, cashierTransactionsOwner]);

  useEffect(() => {
    if (
      cashierPaymentMode !== 'deposit' ||
      (!cashierDepositSuccess && cashierDepositConfirmation !== 'failed')
    ) return;
    const timeoutId = window.setTimeout(() => {
      setCashierPaymentMode(null);
      setCashierDepositSuccess(null);
      setCashierDepositConfirmation(null);
      setCashierTrackedDepositId(null);
    }, 3_000);
    return () => window.clearTimeout(timeoutId);
  }, [cashierDepositConfirmation, cashierDepositSuccess, cashierPaymentMode]);

  const selectedMarket = market.symbols.find((item) => item.symbol === market.selectedSymbol);
  const latestLiveTick = [...market.liveTicks].reverse().find((tick) => tick.symbol === market.selectedSymbol) ?? null;
  const latestHistoricalTick = market.chartTicks.at(-1) ?? null;
  const currentTick = latestLiveTick ?? latestHistoricalTick;
  const precision = precisionFromPip(currentTick?.pipSize ?? selectedMarket?.pipSize ?? 0.01);
  const formattedPrice = currentTick ? currentTick.quote.toFixed(precision) : null;
  const pricePrefix = formattedPrice?.slice(0, -1) ?? '';
  const priceLastDigit = formattedPrice?.at(-1);
  const contractTypes = CONTRACT_TYPES[kind];
  const tickContracts = useMemo(
    () => market.contracts.filter(supportsTickDuration),
    [market.contracts],
  );
  const availableChoices = useMemo(
    () => contractTypes.filter((type) => tickContracts.some((contract) => contract.contract_type === type)),
    [contractTypes, tickContracts],
  );
  const selectedContractType = availableChoices.includes(contractType)
    ? contractType
    : availableChoices[0] ?? contractType;
  const contractInfo = tickContracts.find((contract) => contract.contract_type === selectedContractType);
  const durationLimits = kind === 'rise-fall'
    ? { min: 10, max: 30, unit: 't' }
    : { min: 1, max: 15, unit: 't' };
  const digitValue = Number(digit);
  const digitIsValid = digit.trim() !== '' && Number.isInteger(digitValue) && digitValue >= 0 && digitValue <= 9;
  const digitError = digit.trim() === '' || digitIsValid
    ? ''
    : 'Digit must be between 0 and 9.';
  const durationValue = Number(duration);
  const durationError = duration.trim() === ''
    ? ''
    : !Number.isInteger(durationValue)
      ? 'Duration must be a whole number of ticks.'
      : durationValue < durationLimits.min || durationValue > durationLimits.max
        ? `Duration for ${kindLabels[kind]} must be between ${durationLimits.min} and ${durationLimits.max} ticks.`
        : '';
  const durationIsValid = duration.trim() !== '' && durationError === '';
  const stakeValue = Number(stake);
  const stakeIsValid = stake.trim() !== '' && Number.isFinite(stakeValue) && stakeValue > 0;
  const safeDuration = durationIsValid ? durationValue : durationLimits.min;
  const alternativeContractType = contractTypes.find((type) => type !== selectedContractType) ?? null;
  const alternativeDurationLimits = durationLimits;
  const alternativeSafeDuration = safeDuration;
  const marketOpen = !!selectedMarket?.exchangeOpen && !selectedMarket.suspended;
  const activeWalletBalance = walletBalances?.[activeWallet] ?? 0;
  const activeDigit = currentTick ? getLastDigit(currentTick) : null;
  const activeDigitTrade = trades.find((trade) =>
    trade.status === 'Open' &&
    trade.symbol === market.selectedSymbol &&
    trade.contractType.startsWith('DIGIT'),
  );
  const selectedDigitExitHighlight = digitExitHighlight?.symbol === market.selectedSymbol
    ? digitExitHighlight
    : null;
  const digitExitDescription = selectedDigitExitHighlight
    ? ` The ${selectedDigitExitHighlight.outcome} trade exit digit ${selectedDigitExitHighlight.digit} is highlighted temporarily.`
    : '';
  const pointerDigit = activeDigitTrade ? activeDigit : selectedDigitExitHighlight?.digit ?? activeDigit;
  const digitPercentages = useMemo(() => {
    const ticksBeforeLatest = market.chartTicks.slice(0, -1).slice(-1_000);
    const counts = Array.from({ length: 10 }, () => 0);
    for (const tick of ticksBeforeLatest) counts[getLastDigit(tick)] += 1;
    return counts.map((count) => ticksBeforeLatest.length
      ? (count / ticksBeforeLatest.length) * 100
      : null);
  }, [market.chartTicks]);
  const knownDigitPercentages = digitPercentages.filter((percentage): percentage is number => percentage !== null);
  const highestDigitPercentage = knownDigitPercentages.length ? Math.max(...knownDigitPercentages) : null;
  const lowestDigitPercentage = knownDigitPercentages.length ? Math.min(...knownDigitPercentages) : null;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (market.connectionState !== 'connected') return;
    const latestTrends = market.tickEvents.reduce<Record<string, number[]>>((current, { tick }) => {
      const prices = current[tick.symbol] ?? [];
      current[tick.symbol] = [...prices, tick.quote].slice(-30);
      return current;
    }, {});
    if (!Object.keys(latestTrends).length) return;
    setCashierMarketTrends((current) => ({ ...current, ...latestTrends }));
  }, [market.connectionState, market.tickEvents]);

  useEffect(() => {
    if (currentPage !== 'cashier' || market.connectionState !== 'connected') return;
    let cancelled = false;
    const subscriptionIds = new Map<string, string>();

    void Promise.all(VOLATILITY_SYMBOLS.map(async (symbol) => {
      try {
        const response = await market.request({
          ticks_history: symbol.symbol,
          count: 30,
          end: 'latest',
          style: 'ticks',
        });
        const history = response.history as { prices?: unknown } | undefined;
        if (!Array.isArray(history?.prices)) return [symbol.symbol, [] as number[]] as const;
        const prices = history.prices.filter((price): price is number => typeof price === 'number').slice(-30);
        return [symbol.symbol, prices] as const;
      } catch {
        return [symbol.symbol, [] as number[]] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setCashierMarketTrends((current) => {
        const next = { ...current };
        entries.forEach(([symbol, prices]) => {
          if (prices.length) next[symbol] = prices;
        });
        return next;
      });
    });

    VOLATILITY_SYMBOLS.forEach((symbol) => {
      void market.request({ ticks: symbol.symbol, subscribe: 1 }).then((response) => {
        const subscription = response.subscription as { id?: unknown } | undefined;
        if (typeof subscription?.id !== 'string' || cancelled) {
          if (typeof subscription?.id === 'string') {
            void market.request({ forget: subscription.id }).catch(() => undefined);
          }
          return;
        }
        subscriptionIds.set(symbol.symbol, subscription.id);
      }).catch(() => undefined);
    });

    return () => {
      cancelled = true;
      subscriptionIds.forEach((subscriptionId) => {
        void market.request({ forget: subscriptionId }).catch(() => undefined);
      });
    };
  }, [currentPage, market.connectionState, market.request]);

  useEffect(() => () => {
    if (digitExitTimerRef.current !== null) clearTimeout(digitExitTimerRef.current);
  }, []);

  useEffect(() => {
    let active = true;
    clearDigitExitHighlight();
    setActiveWallet('demo');
    setWalletBalances(null);
    setWalletError('');
    setHistoryError('');
    setTradeActionError('');
    setOpeningTrade(false);
    openingTradeRef.current = false;
    settlingTradeIdsRef.current.clear();
    setTrades([]);

    if (!authUser) {
      setWalletLoading(false);
      return () => {
        active = false;
      };
    }

    setWalletLoading(true);
    const loadAccountData = async () => {
      try {
        const supabase = getSupabaseBrowserClient();
        const [walletResult, tradeResult] = await Promise.all([
          supabase
            .from('marketpilot_wallets')
            .select('account_type,balance')
            .eq('user_id', authUser.id),
          supabase
            .from('marketpilot_practice_trades')
            .select('*')
            .eq('user_id', authUser.id)
            .order('created_at', { ascending: false })
            .limit(100),
        ]);
        if (!active) return;
        if (walletResult.error) throw walletResult.error;

        const balances: Partial<WalletBalances> = {};
        for (const row of walletResult.data ?? []) {
          const accountType: unknown = row.account_type;
          if (accountType !== 'real' && accountType !== 'demo') continue;
          const value = storedNumber(row.balance);
          if (value === null || value < 0) throw new Error('Invalid wallet balance.');
          balances[accountType] = value;
        }
        if (balances.real === undefined || balances.demo === undefined) {
          throw new Error('Wallet balances have not been initialized.');
        }
        setWalletBalances({ real: balances.real, demo: balances.demo });
        setWalletLoading(false);

        if (tradeResult.error) {
          setHistoryError('Trade history could not be loaded.');
          return;
        }
        const savedTrades = (tradeResult.data ?? []).map((row) => parseStoredTrade(row, tickSerialRef.current));
        if (savedTrades.some((trade) => trade === null)) {
          setHistoryError('Some saved trades could not be loaded.');
          return;
        }
        setTrades(savedTrades.filter((trade): trade is PracticeTrade => trade !== null));
      } catch {
        if (!active) return;
        setWalletError('Wallets are unavailable. Apply the MarketPilot wallet migration and reload.');
        setWalletLoading(false);
      }
    };

    void loadAccountData();
    return () => {
      active = false;
    };
  }, [authUser?.id, clearDigitExitHighlight]);

  useEffect(() => {
    if (!authUser?.id || currentPage !== 'cashier') {
      if (!authUser?.id) {
        setCashierTransactions([]);
        setCashierTransactionsOwner(null);
        setCashierKesPerUsd(null);
        setCashierDepositSuccess(null);
      }
      setCashierTransactionsLoading(false);
      return;
    }

    let active = true;
    setCashierTransactionsLoading(true);
    const supabase = getSupabaseBrowserClient();
    void Promise.all([
      loadCashierTransactions(authUser.id),
      supabase.rpc('marketpilot_get_kes_per_usd'),
    ]).then(([transactions, rateResult]) => {
      if (!active) return;
      if (rateResult.error) throw rateResult.error;
      const rate = storedNumber(rateResult.data);
      setCashierTransactions(transactions);
      setCashierTransactionsOwner(authUser.id);
      setCashierKesPerUsd(rate !== null && rate > 0 ? rate : null);
      setCashierError('');
    }).catch((error: unknown) => {
      if (!active) return;
      setCashierError(error instanceof Error ? error.message : 'Cashier information could not be loaded.');
    }).finally(() => {
      if (active) setCashierTransactionsLoading(false);
    });

    return () => {
      active = false;
    };
  }, [authUser?.id, currentPage]);

  useEffect(() => {
    if (!cashierPaymentMode) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !cashierPaymentBusy) setCashierPaymentMode(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [cashierPaymentBusy, cashierPaymentMode]);

  useEffect(() => {
    if (!cashierPaymentMode || !authUser?.id) {
      setCashierPaymentPhoneLoading(false);
      return;
    }

    let active = true;
    setCashierPaymentPhoneLoading(true);
    const loadPhone = async () => {
      try {
        const { data, error } = await getSupabaseBrowserClient()
          .from('marketpilot_profiles')
          .select('phone_e164')
          .eq('id', authUser.id)
          .maybeSingle();
        if (!active) return;
        if (error) throw error;
        if (typeof data?.phone_e164 !== 'string') {
          throw new Error('A phone number is not available on your account.');
        }
        setCashierPaymentPhone(data.phone_e164);
      } catch (error) {
        if (active) {
          setCashierPaymentPhone('');
          setCashierError(error instanceof Error ? error.message : 'Your account phone number could not be loaded.');
        }
      } finally {
        if (active) setCashierPaymentPhoneLoading(false);
      }
    };
    void loadPhone();

    return () => {
      active = false;
    };
  }, [authUser?.id, cashierPaymentMode]);

  const hasPendingCashierDeposit = cashierTransactionsOwner === authUser?.id &&
    cashierTransactions.some((transaction) => transaction.type === 'deposit' && transaction.status === 'pending');

  useEffect(() => {
    if (!authUser?.id || currentPage !== 'cashier') return;
    const userId = authUser.id;
    const intervalId = window.setInterval(() => {
      void loadCashierTransactions(userId).then((transactions) => {
        if (authUserIdRef.current === userId) {
          setCashierTransactions(transactions);
          setCashierTransactionsOwner(userId);
        }
      }).catch((error: unknown) => {
        if (authUserIdRef.current === userId) {
          setCashierError(error instanceof Error ? error.message : 'Transaction history could not be refreshed.');
        }
      });
    }, hasPendingCashierDeposit ? 5_000 : 20_000);
    return () => window.clearInterval(intervalId);
  }, [authUser?.id, currentPage, hasPendingCashierDeposit]);

  const pendingDepositIds = cashierTransactionsOwner === authUser?.id
    ? cashierTransactions
      .filter((transaction) => transaction.type === 'deposit' && transaction.status === 'pending')
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .map((transaction) => transaction.id)
      .join(',')
    : '';

  useEffect(() => {
    if (!authUser?.id || !pendingDepositIds) return;
    const userId = authUser.id;
    const transactionIds = pendingDepositIds.split(',');
    cashierStatusBatchRef.current = 0;
    const checkPendingDeposits = async () => {
      const start = cashierStatusBatchRef.current % transactionIds.length;
      const batch = Array.from({ length: Math.min(5, transactionIds.length) }, (_, index) =>
        transactionIds[(start + index) % transactionIds.length],
      );
      cashierStatusBatchRef.current = (start + batch.length) % transactionIds.length;
      await Promise.all(batch.map(async (transactionId) => {
        if (cashierStatusChecksRef.current.has(transactionId)) return;
        cashierStatusChecksRef.current.add(transactionId);
        try {
          const response = await fetch('/api/payments/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transactionId }),
            cache: 'no-store',
          });
          const result: unknown = await response.json();
          if (authUserIdRef.current !== userId) return;
          if (!response.ok || !result || typeof result !== 'object') {
            setCashierDepositCheckError('Deposit confirmation is temporarily unavailable. Retrying automatically.');
            return;
          }
          const resultRecord = result as Record<string, unknown>;
          const status = resultRecord.status;
          setCashierDepositCheckError('');
          if (status !== 'completed' && status !== 'failed') return;
          setCashierTransactions((current) => current.map((transaction) =>
            transaction.id === transactionId ? { ...transaction, status } : transaction,
          ));
          if (status === 'completed') {
            setCashierDepositConfirmation(null);
            const balance = storedNumber(resultRecord.balance);
            if (balance !== null && authUserIdRef.current === userId) {
              setWalletBalances((current) => current ? { ...current, real: balance } : current);
            }
            const amount = storedNumber(resultRecord.amountUsd);
            if (amount !== null && amount > 0) {
              setCashierDepositSuccess({ transactionId, amount });
            }
          } else {
            setCashierDepositConfirmation('failed');
          }
        } catch {
          if (authUserIdRef.current === userId) {
            setCashierDepositCheckError('Deposit confirmation is temporarily unavailable. Retrying automatically.');
          }
        } finally {
          cashierStatusChecksRef.current.delete(transactionId);
        }
      }));
    };

    void checkPendingDeposits();
    const intervalId = window.setInterval(() => void checkPendingDeposits(), 3_000);
    return () => window.clearInterval(intervalId);
  }, [authUser?.id, pendingDepositIds]);

  useEffect(() => {
    if (!availableChoices.length) return;
    if (!availableChoices.includes(contractType)) setContractType(availableChoices[0]);
  }, [availableChoices, contractType]);

  useEffect(() => {
    if (
      market.connectionState !== 'connected' ||
      !market.selectedSymbol ||
      !marketOpen ||
      !availableChoices.includes(selectedContractType) ||
      !stakeIsValid ||
      !durationIsValid ||
      (['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(selectedContractType) && !digitIsValid)
    ) {
      setQuote(null);
      setQuoteLoading(false);
      setQuoteError('');
      return;
    }

    let cancelled = false;
    setQuote(null);
    setQuoteError('');
    setQuoteLoading(true);
    const timer = setTimeout(() => {
      const request: Record<string, unknown> = {
        proposal: 1,
        amount: stakeValue,
        basis: 'stake',
        contract_type: selectedContractType,
        currency: WALLET_CURRENCY,
        duration: safeDuration,
        duration_unit: durationLimits.unit,
        underlying_symbol: market.selectedSymbol,
      };
      if (['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(selectedContractType)) {
        request.barrier = String(digitValue);
      }

      market.request(request).then((response) => {
        if (cancelled) return;
        const proposal = response.proposal as Record<string, unknown> | undefined;
        if (
          !proposal ||
          typeof proposal.ask_price !== 'number' ||
          typeof proposal.payout !== 'number'
        ) {
          setQuoteError('Market data did not return a complete price proposal.');
          return;
        }
        const fixedPayout = getFixedContractPayout(
          selectedContractType,
          digitIsValid ? digitValue : null,
          proposal.ask_price,
        );
        setQuote({
          askPrice: proposal.ask_price,
          payout: fixedPayout ?? proposal.payout,
        });
      }).catch((error: unknown) => {
        if (!cancelled) {
          setQuoteError(error instanceof Error ? error.message : 'A price proposal is not available for these conditions.');
        }
      }).finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    availableChoices,
    digit,
    digitIsValid,
    durationLimits.unit,
    duration,
    durationIsValid,
    market.connectionState,
    marketOpen,
    market.request,
    market.selectedSymbol,
    safeDuration,
    selectedContractType,
    stakeIsValid,
    stakeValue,
    stake,
  ]);

  useEffect(() => {
    if (
      !alternativeContractType ||
      !availableChoices.includes(alternativeContractType) ||
      market.connectionState !== 'connected' ||
      !market.selectedSymbol ||
      !marketOpen ||
      !stakeIsValid ||
      !durationIsValid ||
      (alternativeContractType !== null &&
        ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(alternativeContractType) &&
        !digitIsValid)
    ) {
      setAlternativeQuote(null);
      setAlternativeQuoteLoading(false);
      setAlternativeQuoteError('');
      return;
    }

    let cancelled = false;
    setAlternativeQuote(null);
    setAlternativeQuoteError('');
    setAlternativeQuoteLoading(true);
    const timer = setTimeout(() => {
      const request: Record<string, unknown> = {
        proposal: 1,
        amount: stakeValue,
        basis: 'stake',
        contract_type: alternativeContractType,
        currency: WALLET_CURRENCY,
        duration: alternativeSafeDuration,
        duration_unit: alternativeDurationLimits.unit,
        underlying_symbol: market.selectedSymbol,
      };
      if (['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(alternativeContractType)) {
        request.barrier = String(digitValue);
      }

      market.request(request).then((response) => {
        if (cancelled) return;
        const proposal = response.proposal as Record<string, unknown> | undefined;
        if (
          !proposal ||
          typeof proposal.ask_price !== 'number' ||
          typeof proposal.payout !== 'number'
        ) {
          setAlternativeQuoteError('Market data did not return a complete price proposal.');
          return;
        }
        const fixedPayout = getFixedContractPayout(
          alternativeContractType,
          digitIsValid ? digitValue : null,
          proposal.ask_price,
        );
        setAlternativeQuote({
          askPrice: proposal.ask_price,
          payout: fixedPayout ?? proposal.payout,
        });
      }).catch((error: unknown) => {
        if (!cancelled) {
          setAlternativeQuoteError(error instanceof Error ? error.message : 'A price proposal is not available for these conditions.');
        }
      }).finally(() => {
        if (!cancelled) setAlternativeQuoteLoading(false);
      });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    alternativeContractType,
    alternativeDurationLimits.unit,
    alternativeSafeDuration,
    availableChoices,
    digit,
    digitIsValid,
    duration,
    durationIsValid,
    market.connectionState,
    marketOpen,
    market.request,
    market.selectedSymbol,
    stakeIsValid,
    stakeValue,
    stake,
  ]);

  useEffect(() => {
    if (!market.tickEvents.length) return;
    setTrades((previous) => previous.map((trade) => {
      if (trade.status !== 'Open') return trade;
      const ticksAfterEntry = market.tickEvents.filter(({ serial, tick }) => (
        serial > trade.entrySerial &&
        tick.symbol === trade.symbol &&
        tick.epoch >= trade.entryEpoch
      ));
      const elapsed = Math.min(ticksAfterEntry.length, trade.duration);
      if (!elapsed || elapsed === trade.elapsed) return trade;
      return { ...trade, elapsed };
    }));
  }, [market.tickEvents]);

  useEffect(() => {
    if (!authUser || !market.tickEvents.length) return;
    for (const trade of trades) {
      const settlementKey = `${authUser.id}:${trade.id}`;
      if (
        trade.status !== 'Open' ||
        trade.elapsed < trade.duration ||
        settlingTradeIdsRef.current.has(settlementKey)
      ) continue;

      const ticksAfterEntry = market.tickEvents.filter(({ serial, tick }) => (
        serial > trade.entrySerial &&
        tick.symbol === trade.symbol &&
        tick.epoch >= trade.entryEpoch
      ));
      const exitTick = ticksAfterEntry[trade.duration - 1]?.tick;
      if (!exitTick) continue;

      const userId = authUser.id;
      settlingTradeIdsRef.current.add(settlementKey);
      const settleTrade = async () => {
        try {
          const supabase = getSupabaseBrowserClient();
          const { data, error } = await supabase.rpc('marketpilot_settle_practice_trade', {
            p_trade_id: trade.id,
            p_account_type: trade.accountType,
            p_exit_price: exitTick.quote,
            p_exit_pip_size: exitTick.pipSize,
            p_exit_digit: getLastDigit(exitTick),
            p_exit_epoch: exitTick.epoch,
          });
          if (error) throw new Error(`Supabase could not settle this Demo trade: ${error.message}`);
          let settlement = parseSettlementResult(data);
          if (!settlement) {
            const result = data && typeof data === 'object' && !Array.isArray(data)
              ? data as Record<string, unknown>
              : null;
            if (
              result?.outcomeSource === 'test_simulation' &&
              (result.status === 'won' || result.status === 'lost')
            ) {
              const balance = storedNumber(result.balance);
              if (balance === null || balance < 0) {
                throw new Error('The database returned an invalid wallet balance for a legacy simulated trade.');
              }
              if (authUserIdRef.current === userId) {
                setWalletBalances((current) => current
                  ? { ...current, [trade.accountType]: balance }
                  : current);
                setTrades((current) => current.filter((item) => item.id !== trade.id));
                setTradeActionError('');
              }
              return;
            }

            const balance = storedNumber(result?.balance ?? data);
            if (balance === null || balance < 0) {
              throw new Error(
                'Supabase returned no valid wallet balance for this settlement. Confirm migration 20261123192000_marketpilot_remove_simulated_outcomes.sql was applied to the project configured in this app.',
              );
            }
            const { data: savedTrade, error: readError } = await supabase
              .from('marketpilot_practice_trades')
              .select('*')
              .eq('user_id', userId)
              .eq('id', trade.id)
              .eq('account_type', trade.accountType)
              .maybeSingle();
            if (readError) {
              throw new Error(`The trade balance was updated, but its saved result could not be loaded: ${readError.message}`);
            }
            settlement = parsePersistedSettlement(savedTrade, balance, trade.entrySerial);
          }
          if (!settlement || settlement.balance < 0) {
            throw new Error('The database returned a balance but did not save a completed trade result.');
          }
          if (authUserIdRef.current === userId) {
            setWalletBalances((current) => current
              ? { ...current, [trade.accountType]: settlement.balance }
              : current);
            setTrades((current) => current.map((item) => item.id === trade.id ? {
              ...item,
              elapsed: trade.duration,
              status: settlement.status === 'won' ? 'Won' : 'Lost',
              exitPrice: exitTick.quote,
              exitPipSize: exitTick.pipSize,
              exitDigit: getLastDigit(exitTick),
              exitEpoch: exitTick.epoch,
              payout: settlement.payout,
              profit: settlement.profit,
            } : item));
            if (trade.accountType === activeWallet && trade.contractType.startsWith('DIGIT')) {
              showDigitExitHighlight({
                tradeId: trade.id,
                symbol: trade.symbol,
                digit: getLastDigit(exitTick),
                outcome: settlement.status === 'won' ? 'win' : 'loss',
              });
            }
            if (trade.accountType === activeWallet) setTradeActionError('');
          }
        } catch (error) {
          console.error('MarketPilot Demo trade settlement failed.', error);
          if (authUserIdRef.current === userId && trade.accountType === activeWallet) {
            setTradeActionError(
              error instanceof Error
                ? error.message
                : 'Trade settlement failed. Check the browser console for details.',
            );
          }
        } finally {
          settlingTradeIdsRef.current.delete(settlementKey);
        }
      };
      void settleTrade();
    }
  }, [activeWallet, authUser?.id, market.tickEvents, showDigitExitHighlight, trades]);

  const chooseKind = (nextKind: PracticeKind) => {
    setKind(nextKind);
    setContractType(contractDefaults[nextKind]);
    const minDuration = nextKind === 'rise-fall' ? 10 : 1;
    const maxDuration = nextKind === 'rise-fall' ? 30 : 15;
    const currentDuration = Number(duration);
    if (
      !Number.isInteger(currentDuration) ||
      currentDuration < minDuration ||
      currentDuration > maxDuration
    ) {
      setDuration(String(minDuration));
    }
  };

  const resetDemoWallet = async () => {
    if (!authUser || !walletBalances || walletLoading || walletError || cashierResetting) return;

    const userId = authUser.id;
    setCashierResetting(true);
    setCashierError('');
    setCashierMessage('');
    try {
      const { data, error } = await getSupabaseBrowserClient().rpc('marketpilot_reset_demo_wallet');
      if (error) throw error;
      const balance = storedNumber(data);
      if (balance !== 10000) throw new Error('The wallet returned an unexpected reset balance.');
      if (authUserIdRef.current !== userId) return;
      setWalletBalances((current) => current ? { ...current, demo: balance } : current);
      setCashierMessage('Demo balance reset to $10,000.00.');
    } catch (error) {
      if (authUserIdRef.current === userId) {
        setCashierError(error instanceof Error ? error.message : 'The demo balance could not be reset.');
      }
    } finally {
      setCashierResetting(false);
    }
  };

  const submitCashierPayment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!authUser || activeWallet !== 'real' || !cashierPaymentMode || cashierPaymentBusy) return;

    const amountUsd = Number(cashierPaymentAmount);
    if (!Number.isFinite(amountUsd) || amountUsd < 1 || (cashierPaymentMode === 'deposit' && amountUsd > 500)) {
      setCashierError(cashierPaymentMode === 'deposit'
        ? 'Enter a deposit amount between $1.00 and $500.00.'
        : 'Enter an amount of at least $1.00.');
      return;
    }
    if (cashierPaymentMode === 'deposit' && !cashierPaymentPhone.trim()) {
      setCashierError('Enter the phone number for the payment prompt.');
      return;
    }
    if (cashierPaymentMode === 'withdrawal' && !cashierPaymentPhone.trim()) {
      setCashierError('Enter the phone number that will receive the withdrawal.');
      return;
    }

    const userId = authUser.id;
    const mode = cashierPaymentMode;
    setCashierPaymentBusy(true);
    setCashierError('');
    setCashierMessage('');
    try {
      const response = await fetch(`/api/payments/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountUsd,
          phone: cashierPaymentPhone.trim(),
        }),
      });
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object') {
        throw new Error('The payment service returned an invalid response.');
      }
      const resultRecord = result as Record<string, unknown>;
      const transactionId = resultRecord.transactionId;
      const pendingDeposit = mode === 'deposit' &&
        typeof transactionId === 'string' &&
        resultRecord.status === 'pending';
      if (!response.ok && !pendingDeposit) {
        throw new Error(typeof resultRecord.error === 'string'
          ? resultRecord.error
          : 'The payment request could not be completed.');
      }

      if (typeof transactionId !== 'string') {
        throw new Error('The payment service did not return a transaction reference.');
      }

      if (mode === 'deposit' && resultRecord.status === 'pending') {
        const pendingAmount = storedNumber(resultRecord.amountUsd) ?? amountUsd;
        setCashierTransactions((current) => current.some((transaction) => transaction.id === transactionId)
          ? current
          : [...current, {
            id: transactionId,
            accountType: 'real',
            type: 'deposit',
            status: 'pending',
            amount: pendingAmount,
            createdAt: new Date().toISOString(),
          }]);
        setCashierTransactionsOwner(userId);
      }

      const rate = storedNumber(resultRecord.kesPerUsd);
      if (rate !== null && rate > 0) setCashierKesPerUsd(rate);
      const balance = storedNumber(resultRecord.balance);
      if (mode === 'withdrawal' && balance !== null && authUserIdRef.current === userId) {
        setWalletBalances((current) => current ? { ...current, real: balance } : current);
      }

      if (mode === 'deposit') {
        setCashierTrackedDepositId(transactionId);
        setCashierDepositConfirmation('pending');
      } else {
        setCashierPaymentMode(null);
      }
      setCashierMessage(mode === 'deposit'
        ? ''
        : 'Withdrawal requested. The amount is reserved while an administrator processes it.');
      try {
        const transactions = await loadCashierTransactions(userId);
        if (authUserIdRef.current === userId) {
          setCashierTransactions(transactions);
          setCashierTransactionsOwner(userId);
        }
      } catch {
        setCashierError('The request was accepted, but transaction history could not be refreshed.');
      }
    } catch (error) {
      setCashierError(error instanceof Error ? error.message : 'The payment request could not be completed.');
    } finally {
      setCashierPaymentBusy(false);
    }
  };

  const signOut = async () => {
    if (!authUser || signingOut) return;

    const userId = authUser.id;
    setSigningOut(true);
    setSidebarError('');
    try {
      const { error } = await getSupabaseBrowserClient().auth.signOut();
      if (error) throw error;
      if (authUserIdRef.current === userId) {
        setAuthUser(null);
        setCurrentPage('hub');
        setMobileMenuOpen(false);
      }
    } catch (error) {
      if (authUserIdRef.current === userId) {
        setSidebarError(error instanceof Error ? error.message : 'Sign out could not be completed.');
      }
    } finally {
      setSigningOut(false);
    }
  };

  const startPractice = async (type = selectedContractType, tradeQuote = quote) => {
    const tradeContract = tickContracts.find((contract) => contract.contract_type === type);
    const hasDigitBarrier = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type);
    if (
      !latestLiveTick ||
      !tradeQuote ||
      !marketOpen ||
      !selectedMarket ||
      !tradeContract ||
      !availableChoices.includes(type) ||
      !authUser ||
      !walletBalances ||
      walletLoading ||
      walletError ||
      activeWallet !== 'demo' ||
      tradeQuote.askPrice > activeWalletBalance ||
      !stakeIsValid ||
      !durationIsValid ||
      (hasDigitBarrier && !digitIsValid) ||
      openingTradeRef.current
    ) return;
    const tradeDuration = durationValue;
    tradeCounter.current += 1;
    const tradeId = `${Date.now()}-${tradeCounter.current}`;
    const typeLabel = CONTRACT_LABELS[type];
    openingTradeRef.current = true;
    setOpeningTrade(true);
    setTradeActionError('');
    const userId = authUser.id;
    try {
      const { data, error } = await getSupabaseBrowserClient().rpc('marketpilot_open_practice_trade', {
        p_trade_id: tradeId,
        p_account_type: activeWallet,
        p_symbol: selectedMarket.symbol,
        p_contract_type: type,
        p_barrier: hasDigitBarrier ? digitValue : null,
        p_duration: tradeDuration,
        p_stake: tradeQuote.askPrice,
        p_quoted_payout: tradeQuote.payout,
        p_entry_price: latestLiveTick.quote,
        p_entry_pip_size: latestLiveTick.pipSize,
        p_entry_digit: getLastDigit(latestLiveTick),
        p_entry_epoch: latestLiveTick.epoch,
      });
      if (error) {
        if (error.message.includes('Insufficient wallet balance')) {
          throw new Error('The selected wallet does not have enough balance for this stake.');
        }
        throw new Error('The wallet could not open this demo trade. Check the wallet migration and try again.');
      }
      if (authUserIdRef.current !== userId) return;
      const balance = storedNumber(data);
      if (balance === null || balance < 0) throw new Error('The wallet returned an invalid balance.');
      setWalletBalances((current) => current ? { ...current, [activeWallet]: balance } : current);
      setContractType(type);
      if (type.startsWith('DIGIT')) clearDigitExitHighlight();
      setTrades((previous) => [{
        id: tradeId,
        accountType: activeWallet,
        symbol: selectedMarket.symbol,
        contractType: type,
        contractLabel: `${typeLabel}${hasDigitBarrier ? ` ${digitValue}` : ''}`,
        barrier: hasDigitBarrier ? digitValue : null,
        duration: tradeDuration,
        durationUnit: durationLimits.unit,
        stake: tradeQuote.askPrice,
        quotedPayout: tradeQuote.payout,
        entryPrice: latestLiveTick.quote,
        entryPipSize: latestLiveTick.pipSize,
        entryDigit: getLastDigit(latestLiveTick),
        entryEpoch: latestLiveTick.epoch,
        entrySerial: market.tickSerial,
        elapsed: 0,
        status: 'Open' as const,
      }, ...previous].slice(0, 100));
    } catch (error) {
      if (authUserIdRef.current === userId) {
        setTradeActionError(error instanceof Error ? error.message : 'The demo trade could not be opened.');
      }
    } finally {
      openingTradeRef.current = false;
      setOpeningTrade(false);
    }
  };

  const groupedSymbols = useMemo(() => {
    const groups = new Map<string, typeof market.symbols>();
    for (const symbol of market.symbols) {
      const group = marketLabel(symbol.market);
      groups.set(group, [...(groups.get(group) ?? []), symbol]);
    }
    return [...groups.entries()];
  }, [market.symbols]);

  useEffect(() => {
    if (!marketMenuOpen) return;
    const options = marketOptionsRef.current?.querySelectorAll<HTMLButtonElement>('.market-option') ?? [];
    const selected = Array.from(options).find((option) => option.getAttribute('aria-checked') === 'true');
    (selected ?? options[0])?.focus();

    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !marketSelectorRef.current?.contains(event.target)) {
        setMarketMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [marketMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    mobileMenuCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false);
        mobileMenuButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mobileMenuOpen]);

  const handleMarketOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const options = Array.from(marketOptionsRef.current?.querySelectorAll<HTMLButtonElement>('.market-option') ?? []);
    const currentIndex = options.indexOf(event.currentTarget);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = options.length - 1;
    if (event.key === 'Escape') {
      event.preventDefault();
      setMarketMenuOpen(false);
      marketSelectorButtonRef.current?.focus();
      return;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      options[nextIndex]?.focus();
    }
  };

  const walletTrades = trades.filter((trade) => trade.accountType === activeWallet);
  const visibleTrades = walletTrades.filter((trade) => {
    if (activeTradeView === 'open') return trade.status === 'Open';
    if (activeTradeView === 'closed') return trade.status !== 'Open';
    return true;
  });
  const totalProfit = walletTrades.reduce((total, trade) => total + (trade.profit ?? 0), 0);
  const themeIcon = theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />;
  const formatMoney = (amount: number) => `$${Math.abs(amount).toFixed(2)}`;
  const formatBalance = (amount: number) => `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const formatProfit = (amount: number) => `${amount >= 0 ? '+' : '-'}${formatMoney(amount)}`;
  const visibleCashierTransactions = cashierTransactionsOwner === authUser?.id
    ? cashierTransactions.filter((transaction) => transaction.accountType === activeWallet)
    : [];
  const cashierWalletIsDemo = activeWallet === 'demo';
  const cashierWalletLabel = cashierWalletIsDemo ? 'Demo account' : 'Real account';
  const cashierBalanceText = !authUser
    ? 'Sign in to view'
    : walletLoading
      ? 'Loading balance…'
      : walletError
        ? 'Unavailable'
        : walletBalances
          ? formatBalance(walletBalances[activeWallet])
          : 'Unavailable';
  const renderContractActions = (placement: 'inline' | 'floating') => (
    <div
      className={`contract-action-pair contract-action-pair--${placement}`}
      role="group"
      aria-label={`${kindLabels[kind]} demo trade actions`}
    >
      {contractTypes.map((type) => {
        const supported = availableChoices.includes(type);
        const actionQuote = type === selectedContractType
          ? quote
          : type === alternativeContractType
            ? alternativeQuote
            : null;
        const positive = ['DIGITOVER', 'DIGITEVEN', 'DIGITMATCH', 'CALL'].includes(type);
        const hasDigitBarrier = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type);
        const actionLabel = `${CONTRACT_LABELS[type]}${hasDigitBarrier ? ` ${digit}` : ''}`;
        const actionDuration = type === selectedContractType ? safeDuration : alternativeSafeDuration;
        const actionDurationUnit = type === selectedContractType
          ? durationLimits.unit
          : alternativeDurationLimits.unit;
        const insufficientBalance = !!actionQuote && !!walletBalances &&
          actionQuote.askPrice > walletBalances[activeWallet];
        const disabled = !supported ||
          !actionQuote ||
          !stakeIsValid ||
          !durationIsValid ||
          (hasDigitBarrier && !digitIsValid) ||
          !latestLiveTick ||
          !marketOpen ||
          !authUser ||
          !walletBalances ||
          walletLoading ||
          !!walletError ||
          activeWallet !== 'demo' ||
          insufficientBalance ||
          openingTrade;

        return (
          <button
            key={type}
            className={`contract-action-button ${positive ? 'is-positive' : 'is-negative'}`}
            type="button"
            onClick={() => startPractice(type, actionQuote)}
            disabled={disabled}
            title={`Start ${actionLabel} demo trade`}
            aria-label={actionQuote
              ? `${actionLabel}. Payout ${formatMoney(actionQuote.payout)}, including ${formatMoney(actionQuote.askPrice)} stake and ${formatProfit(actionQuote.payout - actionQuote.askPrice)} profit.`
              : `${actionLabel}.`}
          >
            <span className="contract-action-name">{actionLabel}</span>
            {actionQuote ? (
              <strong className="contract-action-payout">Payout: {formatMoney(actionQuote.payout)}</strong>
            ) : null}
          </button>
        );
      })}
    </div>
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <button
            ref={mobileMenuButtonRef}
            type="button"
            className="mobile-menu-toggle"
            onClick={() => setMobileMenuOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-navigation"
          >
            <Menu size={18} />
          </button>
          <a className="brand-link" href="#" aria-label="MarketPilot dashboard">
            <span className="brand-mark"><Activity size={20} strokeWidth={2.2} /></span>
            <span className="brand-copy">
              <strong>MarketPilot</strong>
            </span>
          </a>
        </div>
        <nav className="main-nav" aria-label="Main navigation">
          <button
            type="button"
            className={`nav-link${currentPage === 'hub' ? ' active' : ''}`}
            onClick={() => setCurrentPage('hub')}
          >
            Traders Hub
          </button>
          <a className="nav-link" href="#statistics" onClick={() => setCurrentPage('hub')}>Markets</a>
          <a className="nav-link" href="#trade" onClick={() => setCurrentPage('hub')}>Trade</a>
          <button
            type="button"
            className={`nav-link${currentPage === 'cashier' ? ' active' : ''}`}
            onClick={() => setCurrentPage('cashier')}
          >
            Cashier
          </button>
          {authUser && (
            <button
              type="button"
              className={`nav-link${currentPage === 'settings' ? ' active' : ''}`}
              onClick={() => setCurrentPage('settings')}
            >
              Settings
            </button>
          )}
        </nav>
        {currentPage === 'hub' && (
          <nav className="mobile-contract-nav" aria-label="Choose contract type">
            {(Object.keys(kindLabels) as PracticeKind[]).map((item) => (
              <button
                key={item}
                type="button"
                className={kind === item ? 'selected' : ''}
                onClick={() => {
                  chooseKind(item);
                  setCurrentPage('hub');
                }}
                aria-pressed={kind === item}
              >
                {kindLabels[item]}
              </button>
            ))}
          </nav>
        )}
        <div className="header-actions">
          <AuthControls
            onUserChange={onAuthUserChange}
            balances={walletBalances}
            activeWallet={activeWallet}
            walletLoading={walletLoading}
            walletError={walletError}
            onWalletChange={changeActiveWallet}
          />
          <div className={`connection-pill ${market.connectionState}`}>
            {market.connectionState === 'connected' ? <Wifi size={14} /> : <WifiOff size={14} />}
            <span>{market.connectionState === 'connected' ? 'Market data live' : market.connectionState}</span>
          </div>
        </div>
      </header>
      {mobileMenuOpen && (
        <div className="mobile-menu-layer">
          <button
            type="button"
            className="mobile-menu-backdrop"
            aria-label="Close navigation menu"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="mobile-sidebar" id="mobile-navigation" aria-label="Site navigation">
            <div className="mobile-sidebar-heading">
              <strong>Navigation</strong>
              <button
                ref={mobileMenuCloseRef}
                type="button"
                className="icon-button"
                aria-label="Close navigation menu"
                onClick={() => setMobileMenuOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <nav className="mobile-sidebar-links" aria-label="Main navigation">
              {sidebarItems
                .filter(({ page }) => page !== 'settings' || !!authUser)
                .map(({ page, label, icon: Icon }) => (
                <button
                  key={page}
                  type="button"
                  className={currentPage === page ? 'selected' : ''}
                  aria-current={currentPage === page ? 'page' : undefined}
                  onClick={() => {
                    setCurrentPage(page);
                    setMobileMenuOpen(false);
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <div className="mobile-sidebar-footer">
              <button
                type="button"
                className="mobile-sidebar-action"
                onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
                aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              >
                {themeIcon}
                <span>{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
              </button>
              {authUser && (
                <button
                  type="button"
                  className="mobile-sidebar-action sign-out-action"
                  onClick={() => void signOut()}
                  disabled={signingOut}
                >
                  <LogOut size={16} aria-hidden="true" />
                  <span>{signingOut ? 'Signing out…' : 'Sign out'}</span>
                </button>
              )}
              {sidebarError && <p className="mobile-sidebar-error" role="alert">{sidebarError}</p>}
            </div>
          </aside>
        </div>
      )}

      {currentPage === 'history' && (
        <div className="mobile-history-page">
          <TradeHistoryPanel
            id="mobile-trade-history"
            activeWallet={activeWallet}
            activeTradeView={activeTradeView}
            historyError={historyError}
            walletTrades={walletTrades}
            visibleTrades={visibleTrades}
            totalProfit={totalProfit}
            onTradeViewChange={setActiveTradeView}
          />
        </div>
      )}

      {currentPage === 'settings' && (
        <div className="account-settings-page">
          {authUser ? (
            <AccountSettings user={authUser} />
          ) : (
            <section className="account-settings-card" aria-label="Account settings">
              <p className="eyebrow">YOUR ACCOUNT</p>
              <h1>Settings</h1>
              <p>Sign in to manage your account settings.</p>
            </section>
          )}
        </div>
      )}

      {currentPage === 'cashier' && (
        <section className="page-content cashier-page" aria-labelledby="cashier-title">
          <div className="page-heading cashier-heading">
            <div>
              <p className="eyebrow">ACCOUNT MANAGEMENT</p>
              <h1 id="cashier-title">My Wallet</h1>
            </div>
          </div>
          {!authUser && (
            <p className="cashier-message" role="status">Sign in to view your account balance.</p>
          )}
          {walletError && <p className="cashier-message cashier-message--error" role="alert">{walletError}</p>}
          {cashierError && <p className="cashier-message cashier-message--error" role="alert">{cashierError}</p>}
          {cashierMessage && <p className="cashier-message cashier-message--success" role="status">{cashierMessage}</p>}
          <div className="cashier-wallet-grid" role="group" aria-label="Active account balance">
            <article
              className={`cashier-wallet-card is-active${cashierWalletIsDemo ? ' cashier-wallet-card--demo' : ' cashier-wallet-card--real'}`}
            >
              <div className="cashier-wallet-heading">
                <span className={`cashier-wallet-badge${cashierWalletIsDemo ? ' is-demo' : ' is-real'}`}>
                  {cashierWalletIsDemo ? 'DEMO' : 'REAL'}
                </span>
                <span className="cashier-active-label">ACTIVE</span>
              </div>
              <span className="cashier-wallet-title">{cashierWalletLabel}</span>
              <div className="cashier-wallet-row">
                <strong className="cashier-wallet-balance">{cashierBalanceText}</strong>
                {cashierWalletIsDemo && (
                  <button
                    type="button"
                    className="cashier-reset-button"
                    onClick={() => void resetDemoWallet()}
                    disabled={!authUser || !walletBalances || walletLoading || !!walletError || cashierResetting}
                  >
                    <RotateCcw size={15} aria-hidden="true" />
                    {cashierResetting ? 'Resetting balance…' : 'Reset demo balance'}
                  </button>
                )}
                {!cashierWalletIsDemo && (
                  <div className="cashier-real-actions" role="group" aria-label="Real account actions">
                    <button
                      type="button"
                      className="cashier-action-button"
                      onClick={() => {
                        setCashierError('');
                        setCashierMessage('');
                        setCashierDepositSuccess(null);
                        setCashierDepositConfirmation(null);
                        setCashierTrackedDepositId(null);
                        setCashierPaymentMode('deposit');
                      }}
                      disabled={!authUser || cashierPaymentBusy}
                    >
                      Deposit
                    </button>
                    <button
                      type="button"
                      className="cashier-action-button"
                      onClick={() => {
                        setCashierError('');
                        setCashierMessage('');
                        setCashierDepositSuccess(null);
                        setCashierDepositConfirmation(null);
                        setCashierPaymentMode('withdrawal');
                      }}
                      disabled={!authUser || cashierPaymentBusy}
                    >
                      Withdraw
                    </button>
                  </div>
                )}
              </div>
            </article>
          </div>
          {cashierWalletIsDemo && (
            <aside className="cashier-info-card">
              <span className="cashier-info-icon"><Wallet size={19} aria-hidden="true" /></span>
              <p>Demo funds are virtual and can be reset to $10,000.00 at any time. Open Demo trades remain active after a reset, and their results can change the balance later. Real-account deposits and withdrawals are available when payments are configured; live trading is not available yet.</p>
            </aside>
          )}
          {!cashierWalletIsDemo && cashierPaymentMode && (
            <div className="cashier-payment-overlay">
              <button
                type="button"
                className="cashier-payment-backdrop"
                aria-label="Close payment dialog"
                onClick={() => {
                  if (!cashierPaymentBusy) setCashierPaymentMode(null);
                }}
              />
                {cashierPaymentMode === 'deposit' && (cashierDepositConfirmation || cashierDepositSuccess) ? (
                  <section
                    className={`cashier-payment-form cashier-deposit-confirmation${cashierDepositSuccess ? ' is-success' : cashierDepositConfirmation === 'failed' ? ' is-failed' : ' is-pending'}`}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="cashier-deposit-confirmation-title"
                    aria-live="assertive"
                  >
                    <div className="cashier-payment-heading">
                      <strong id="cashier-deposit-confirmation-title">Deposit confirmation</strong>
                      <button
                        type="button"
                        className="cashier-payment-close"
                        onClick={() => setCashierPaymentMode(null)}
                        aria-label="Close deposit confirmation"
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                    </div>
                    {cashierDepositSuccess ? (
                      <article className="cashier-deposit-notice is-success">
                        <div className="cashier-deposit-success-mark" aria-hidden="true">✓</div>
                        <div>
                          <strong>Success</strong>
                          <p>Funds added to your real trading wallet</p>
                          <b>{formatMoney(cashierDepositSuccess.amount)} USD credited</b>
                        </div>
                      </article>
                    ) : cashierDepositConfirmation === 'failed' ? (
                      <article className="cashier-deposit-notice is-failed">
                        <div className="cashier-deposit-failure-mark" aria-hidden="true">!</div>
                        <div>
                          <strong>Failed</strong>
                          <p>The deposit was not confirmed. No funds were added to your real trading wallet.</p>
                        </div>
                      </article>
                    ) : (
                      <article className="cashier-deposit-notice is-pending">
                        <span className="cashier-deposit-spinner" aria-hidden="true" />
                        <div>
                          <strong>Waiting for confirmation…</strong>
                          <p>We’re checking your deposit. Your real balance will update as soon as it is confirmed.</p>
                          {cashierDepositCheckError && <p role="status">{cashierDepositCheckError}</p>}
                          <b>{formatMoney(Number(cashierPaymentAmount))} USD</b>
                        </div>
                      </article>
                    )}
                  </section>
                ) : (
                <form
                className="cashier-payment-form"
                role="dialog"
                aria-modal="true"
                aria-labelledby="cashier-payment-title"
                onSubmit={(event) => void submitCashierPayment(event)}
              >
                <div className="cashier-payment-heading">
                  <strong id="cashier-payment-title">{cashierPaymentMode === 'deposit' ? 'Deposit with M-Pesa' : 'Request a withdrawal'}</strong>
                  <button
                    type="button"
                    className="cashier-payment-close"
                    onClick={() => setCashierPaymentMode(null)}
                    disabled={cashierPaymentBusy}
                    aria-label="Close payment form"
                  >
                    <X size={15} aria-hidden="true" />
                  </button>
                </div>
                <label className="cashier-payment-field">
                  Amount (USD)
                  <input
                    type="number"
                    min="1"
                    max={cashierPaymentMode === 'deposit' ? '500' : undefined}
                    step="0.01"
                    inputMode="decimal"
                    value={cashierPaymentAmount}
                    onChange={(event) => setCashierPaymentAmount(event.target.value)}
                    disabled={cashierPaymentBusy}
                    required
                  />
                </label>
                {cashierPaymentMode === 'deposit' && (
                  <div className="cashier-amount-quick-picks" role="group" aria-label="Choose a deposit amount">
                    {[5, 10, 20, 50, 100, 200, 500].map((amount) => (
                      <button
                        key={amount}
                        type="button"
                        className={Number(cashierPaymentAmount) === amount ? 'is-selected' : ''}
                        onClick={() => setCashierPaymentAmount(String(amount))}
                        disabled={cashierPaymentBusy}
                      >
                        ${amount}
                      </button>
                    ))}
                  </div>
                )}
                <label className="cashier-payment-field">
                  M-Pesa phone number receiving {cashierPaymentMode === 'deposit' ? 'the prompt' : 'the withdrawal'}
                  <input
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    value={cashierPaymentPhone}
                    onChange={(event) => setCashierPaymentPhone(event.target.value)}
                    disabled={cashierPaymentBusy || cashierPaymentPhoneLoading}
                    placeholder={cashierPaymentPhoneLoading ? 'Loading account phone…' : '+254…'}
                    required
                  />
                  <small>Prefilled from your account phone. Edit it to use a different number.</small>
                </label>
                <p className="cashier-payment-conversion">
                  {cashierKesPerUsd
                    ? `Approx. KES ${Math.round((Number(cashierPaymentAmount) || 0) * cashierKesPerUsd).toLocaleString('en-KE')} at KES ${cashierKesPerUsd.toLocaleString('en-US')} per USD.`
                    : 'KES/USD rate is not available yet. An administrator must set it before payments can be processed.'}
                </p>
                <p className="cashier-payment-note">
                  {cashierPaymentMode === 'deposit'
                    ? 'A payment prompt will be sent to the phone number entered above. Your USD balance is credited after payment confirmation.'
                    : 'The USD amount is reserved immediately. An administrator must approve your request and send the KES amount to this phone number.'}
                </p>
                <div className="cashier-payment-actions">
                  <button
                    type="submit"
                    className="cashier-action-button"
                    disabled={cashierPaymentBusy || !authUser || cashierPaymentPhoneLoading}
                  >
                    {cashierPaymentBusy
                      ? 'Processing…'
                      : cashierPaymentMode === 'deposit'
                        ? 'Send STK'
                        : 'Request withdrawal'}
                  </button>
                  <button
                    type="button"
                    className="admin-button"
                    onClick={() => setCashierPaymentMode(null)}
                    disabled={cashierPaymentBusy}
                  >
                    Cancel
                  </button>
                </div>
              </form>
              )}
            </div>
          )}
          <section
            className="cashier-transaction-section"
            aria-label={cashierWalletIsDemo ? 'Market volatility list' : 'Transaction history'}
          >
            {!cashierWalletIsDemo && (
              <div className="cashier-section-heading">
                <h2 id="transaction-history-title">Transaction history</h2>
              </div>
            )}
            {cashierTransactionsLoading && !cashierTransactions.length ? (
              <p className="cashier-message" role="status">Loading transactions…</p>
            ) : visibleCashierTransactions.length ? (
              <div className="cashier-transaction-list">
                {visibleCashierTransactions
                  .map((transaction) => (
                    <article className="cashier-transaction-row" key={transaction.id}>
                      <div>
                        <strong>{transaction.type === 'deposit' ? 'Deposit' : 'Withdrawal'}</strong>
                        <span>{localTime(Number.isFinite(Date.parse(transaction.createdAt)) ? Date.parse(transaction.createdAt) / 1000 : 0)} UTC</span>
                      </div>
                      <strong className="cashier-transaction-amount">
                        {transaction.type === 'deposit' ? '+' : '-'}{formatMoney(transaction.amount)}
                      </strong>
                      {transaction.type === 'deposit' && transaction.status === 'pending' ? (
                        <span className="cashier-transaction-status is-processing">Awaiting confirmation</span>
                      ) : (
                        <span className={`cashier-transaction-status is-${transaction.status}${transaction.status === 'completed' ? ` is-${transaction.type}` : ''}`}>
                          {transaction.status.charAt(0).toUpperCase() + transaction.status.slice(1)}
                        </span>
                      )}
                    </article>
                  ))}
              </div>
            ) : (
              <div className="cashier-market-list">
                {VOLATILITY_SYMBOLS.map((symbol) => {
                  const liveSymbol = market.symbols.find((item) => item.symbol === symbol.symbol);
                  const marketOpen = !!liveSymbol?.exchangeOpen && !liveSymbol.suspended;
                  const trend = cashierMarketTrends[symbol.symbol] ?? [];
                  const trendMin = trend.length ? Math.min(...trend) : 0;
                  const trendMax = trend.length ? Math.max(...trend) : 0;
                  const trendRange = trendMax - trendMin;
                  const trendCoordinates = trend.map((quote, index) => {
                    const x = trend.length === 1 ? 0 : index * (56 / (trend.length - 1));
                    const y = trendRange === 0 ? 14 : 26 - ((quote - trendMin) / trendRange) * 24;
                    return { x, y };
                  });
                  const trendPath = trendCoordinates.length >= 2
                    ? trendCoordinates.slice(0, -1).reduce((path, point, index) => {
                      const previous = trendCoordinates[Math.max(0, index - 1)];
                      const next = trendCoordinates[index + 1];
                      const following = trendCoordinates[Math.min(trendCoordinates.length - 1, index + 2)];
                      const controlOneX = point.x + (next.x - previous.x) / 6;
                      const controlOneY = point.y + (next.y - previous.y) / 6;
                      const controlTwoX = next.x - (following.x - point.x) / 6;
                      const controlTwoY = next.y - (following.y - point.y) / 6;
                      return `${path} C ${controlOneX},${controlOneY} ${controlTwoX},${controlTwoY} ${next.x},${next.y}`;
                    }, `M ${trendCoordinates[0].x},${trendCoordinates[0].y}`)
                    : '';
                  const isBullish = trend.length >= 2
                    ? trend.at(-1)! >= trend[0]
                    : true;
                  return (
                    <article className="cashier-market-row" key={symbol.symbol}>
                      <div className="cashier-market-info">
                        <span className="cashier-market-icon"><BarChart3 size={15} aria-hidden="true" /></span>
                        <div>
                          <strong>{symbol.name}</strong>
                          <span>{symbol.symbol}</span>
                        </div>
                      </div>
                      <svg
                        className={`cashier-market-trend ${isBullish ? 'is-bullish' : 'is-bearish'}`}
                        viewBox="0 0 56 28"
                        role="img"
                        aria-label={`${symbol.name} ${trend.length ? (isBullish ? 'bullish' : 'bearish') : 'trend'} trend`}
                      >
                        {trendPath && <path d={trendPath} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
                      </svg>
                      <span className={`cashier-market-status ${marketOpen ? 'is-open' : 'is-closed'}`}>
                        {marketOpen ? 'Market open' : 'Market closed'}
                      </span>
                      <button
                        type="button"
                        className="cashier-trade-button"
                        onClick={() => {
                          market.setSelectedSymbol(symbol.symbol);
                          setCurrentPage('hub');
                        }}
                      >
                        Trade
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </section>
      )}

      <div className={`page-content${currentPage !== 'hub' ? ' is-inactive-page' : ''}`}>
        <div className="mobile-page-heading">Traders Hub</div>
        {(market.connectionState !== 'connected' || market.error) && (
          <div className="connection-alert" role="status">
            <WifiOff size={17} />
            <div>
              <strong>{market.connectionState === 'connected' ? 'Market data issue' : 'Market data connection unavailable'}</strong>
              <span>
                {market.error || 'Connecting to live market data. Prices and statistics are not simulated.'}
              </span>
            </div>
          </div>
        )}

        <div className="workspace-grid">
          <div className="primary-column">
            <section className="panel market-panel" id="market">
              <div className="market-summary">
                <div
                  className={`market-select-wrap${marketMenuOpen ? ' is-open' : ''}`}
                  ref={marketSelectorRef}
                  onBlur={(event) => {
                    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                      setMarketMenuOpen(false);
                    }
                  }}
                >
                  <label htmlFor="market-select">
                    Volatility index
                    <span className={`market-status ${marketOpen ? 'open' : 'closed'}`}>
                      <i />
                      {selectedMarket
                        ? marketOpen ? 'Market open' : selectedMarket.suspended ? 'Trading suspended' : 'Market closed'
                        : 'Awaiting market'}
                    </span>
                  </label>
                  <div className="select-control">
                    <BarChart3 size={16} />
                    <button
                      ref={marketSelectorButtonRef}
                      type="button"
                      id="market-select"
                      className="market-select-button"
                      aria-haspopup="menu"
                      aria-expanded={marketMenuOpen}
                      aria-controls="market-options"
                      aria-label="Select active market"
                      disabled={!market.symbols.length}
                      onClick={() => setMarketMenuOpen((open) => !open)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setMarketMenuOpen(true);
                        }
                      }}
                    >
                      <span className="market-select-value">
                        {selectedMarket ? `${selectedMarket.name} · ${selectedMarket.symbol}` : 'Select a market'}
                      </span>
                      <ChevronDown size={15} className={`select-chevron${marketMenuOpen ? ' is-open' : ''}`} />
                    </button>
                  </div>
                  {marketMenuOpen && (
                    <div className="market-options" id="market-options" ref={marketOptionsRef} role="menu" aria-label="Available volatility markets">
                      {groupedSymbols.map(([group, symbols]) => (
                        <div className="market-option-group" key={group} role="group" aria-label={group}>
                          <span className="market-option-heading">{group}</span>
                          {symbols.map((symbol) => (
                            <button
                              className={`market-option${market.selectedSymbol === symbol.symbol ? ' selected' : ''}`}
                              key={symbol.symbol}
                              type="button"
                              role="menuitemradio"
                              aria-checked={market.selectedSymbol === symbol.symbol}
                              onClick={() => {
                                market.setSelectedSymbol(symbol.symbol);
                                setMarketMenuOpen(false);
                                marketSelectorButtonRef.current?.focus();
                              }}
                              onKeyDown={handleMarketOptionKeyDown}
                            >
                              {symbol.name} · {symbol.symbol}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="price-summary">
                  <div className="price-readout">
                    <div className="price-main">
                      <span className="price-label">{latestLiveTick ? 'LIVE PRICE' : 'LATEST AVAILABLE PRICE'}</span>
                      <strong className={latestLiveTick ? '' : 'historical-price'}>
                        {formattedPrice ? <>{pricePrefix}<span className="price-last-digit-highlight">{priceLastDigit}</span></> : '—'}
                      </strong>
                    </div>
                  </div>
                  <span className="tick-time">
                    {currentTick ? <><Clock3 size={12} /> {localTime(currentTick.epoch)} UTC</> : 'Awaiting provider data'}
                  </span>
                </div>
              </div>

              <div className="chart-section">
                <div className="chart-heading">
                  <div className="interval-picker" aria-label="Historical chart interval">
                    {(['1m', '5m', '15m', '30m', '1h'] as const).map((range) => (
                      <button
                        key={range}
                        type="button"
                        className={market.interval === range ? 'selected' : ''}
                        onClick={() => market.setInterval(range)}
                        aria-pressed={market.interval === range}
                      >
                        {range}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="chart-style-toggle"
                    onClick={() => market.setChartStyle(market.chartStyle === 'area' ? 'candlestick' : 'area')}
                    aria-label={`Switch to ${market.chartStyle === 'area' ? 'candlestick' : 'area line'} chart`}
                  >
                    {market.chartStyle === 'area' ? 'Candlesticks' : 'Area line'}
                  </button>
                </div>
                <PriceChart
                  symbol={market.selectedSymbol}
                  interval={market.interval}
                  ticks={market.chartTicks}
                  candles={market.chartCandles}
                  chartStyle={market.chartStyle}
                  loading={market.chartLoading}
                  theme={theme}
                />
              </div>
              {kind !== 'rise-fall' && (
                <section className="digit-distribution-panel" id="statistics">
                <div className="section-heading">
                  <h2>Digit distribution</h2>
                </div>
                <div
                  className="digit-distribution"
                  role="img"
                  aria-label={activeDigit === null
                    ? 'Digit distribution from zero to nine. Waiting for market data.'
                    : `Digit distribution from zero to nine. Active last digit: ${activeDigit}.${activeDigitTrade ? ' An open Demo trade highlights the live digit in blue.' : digitExitDescription}`}
                >
                  <div className="digit-distribution-track">
                    {Array.from({ length: 10 }, (_, value) => {
                      const percentage = digitPercentages[value];
                      const isHighest = percentage !== null && percentage === highestDigitPercentage;
                      const isLowest = percentage !== null &&
                        percentage === lowestDigitPercentage &&
                        lowestDigitPercentage !== highestDigitPercentage;
                      const isLiveTradeDigit = !!activeDigitTrade && value === activeDigit;
                      const isExitTradeDigit = !activeDigitTrade &&
                        selectedDigitExitHighlight?.digit === value;
                      return (
                        <div className="digit-item" key={value}>
                        <span className="digit-percentage">
                          {percentage === null ? '—' : `${percentage.toFixed(1)}%`}
                        </span>
                        <span
                          className={`digit-circle${isHighest ? ' is-highest' : ''}${isLowest ? ' is-lowest' : ''}${isLiveTradeDigit ? ' is-contract-active' : ''}${isExitTradeDigit ? ` is-exit-${selectedDigitExitHighlight?.outcome}` : ''}`}
                        >
                          {value}
                        </span>
                        </div>
                      );
                    })}
                    {pointerDigit !== null && (
                      <span
                        className={`digit-pointer${activeDigitTrade ? ' is-practice-active' : ''}${!activeDigitTrade && selectedDigitExitHighlight ? ` is-exit-${selectedDigitExitHighlight.outcome}` : ''}`}
                        style={{ left: `${((pointerDigit + 0.5) / 10) * 100}%` }}
                      />
                    )}
                  </div>
                </div>
                </section>
              )}
            </section>

            <TradeHistoryPanel
              activeWallet={activeWallet}
              activeTradeView={activeTradeView}
              historyError={historyError}
              walletTrades={walletTrades}
              visibleTrades={visibleTrades}
              totalProfit={totalProfit}
              onTradeViewChange={setActiveTradeView}
            />
          </div>

          <aside className="side-column" id="trade">
            <section className="panel practice-panel">
              <div className="practice-panel-header">
                <div>
                  <h2>Place a trade</h2>
                </div>
                <span className="practice-icon"><Activity size={17} /></span>
              </div>

              <div className="form-field">
                <label>Contract type</label>
                <div className="contract-tabs">
                  {(Object.keys(kindLabels) as PracticeKind[]).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={kind === item ? 'selected' : ''}
                      onClick={() => chooseKind(item)}
                      title={kindLabels[item]}
                    >
                      {kindLabels[item]}
                    </button>
                  ))}
                </div>
              </div>

              <div className={`control-row ${['over-under', 'matches-differs'].includes(kind) ? 'control-row--three' : ''}`}>
                {['over-under', 'matches-differs'].includes(kind) && (
                  <div className="form-field">
                    <label htmlFor="prediction-digit">Prediction Digit</label>
                    <input
                      id="prediction-digit"
                      className="prediction-digit-input"
                      type="number"
                      min="0"
                      max="9"
                      step="1"
                      value={digit}
                      aria-invalid={digitError !== ''}
                      aria-describedby={digitError ? 'prediction-digit-error' : undefined}
                      onChange={(event) => setDigit(event.target.value)}
                    />
                    {digitError && <p id="prediction-digit-error" className="trade-action-error" role="alert">{digitError}</p>}
                  </div>
                )}
                <div className="form-field">
                  <label htmlFor="duration">Duration</label>
                  <div className="input-suffix">
                    <input
                      id="duration"
                      type="number"
                      step="1"
                      value={duration}
                      aria-invalid={durationError !== ''}
                      onChange={(event) => setDuration(event.target.value)}
                      disabled={!contractInfo}
                    />
                    <span>{durationLimits.unit}</span>
                  </div>
                </div>
                <div className="form-field">
                  <label htmlFor="stake">Stake</label>
                  <div className="input-prefix">
                    <span>$</span>
                    <input
                      id="stake"
                      type="number"
                      min="0.35"
                      step="0.01"
                      value={stake}
                      onChange={(event) => setStake(event.target.value)}
                    />
                  </div>
                </div>
              </div>

              {renderContractActions('inline')}
              {tradeActionError && <p className="trade-action-error" role="status">{tradeActionError}</p>}
              {trades.some((trade) => trade.accountType === activeWallet && trade.status === 'Open' && trade.symbol === market.selectedSymbol) && (
                <div className="open-trade-note">
                  <span className="loading-dot" />
                  {trades.filter((trade) => trade.accountType === activeWallet && trade.status === 'Open' && trade.symbol === market.selectedSymbol).length} open demo trade(s) monitoring incoming ticks
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
      {currentPage === 'hub' && renderContractActions('floating')}
    </main>
  );
}

function TradeRow({ trade, currency }: { trade: PracticeTrade; currency: string }) {
  const isOpen = trade.status === 'Open';
  const entryPrecision = precisionFromPip(trade.entryPipSize);
  const exitPrecision = precisionFromPip(trade.exitPipSize ?? trade.entryPipSize);
  return (
    <article className="trade-row">
      <div className="trade-symbol-icon"><Activity size={15} /></div>
      <div className="trade-info">
        <strong>{trade.symbol}<span>{trade.contractLabel}</span><span>{trade.accountType === 'demo' ? 'DEMO' : 'REAL'}</span></strong>
        <small>
          {trade.duration}{trade.durationUnit} · Entry {trade.entryPrice.toFixed(entryPrecision)} · digit {trade.entryDigit} · {localTime(trade.entryEpoch)} UTC
        </small>
      </div>
      <div className="trade-result">
        {isOpen ? (
          <>
            <span className="trade-status open"><i /> Open · {trade.elapsed}/{trade.duration}</span>
          </>
        ) : (
          <>
            <span className={`trade-status ${trade.status.toLowerCase()}`}>{trade.status === 'Won' ? 'Won' : 'Lost'}</span>
            <strong className={(trade.profit ?? 0) > 0 ? 'positive' : (trade.profit ?? 0) < 0 ? 'negative' : ''}>
              {(trade.profit ?? 0) > 0 ? '+' : ''}{(trade.profit ?? 0).toFixed(2)} {currency}
            </strong>
            <small>
              Actual market exit {trade.exitPrice?.toFixed(exitPrecision) ?? '—'} · digit {trade.exitDigit ?? '—'} · {trade.exitEpoch ? `${localTime(trade.exitEpoch)} UTC` : ''}
            </small>
          </>
        )}
      </div>
    </article>
  );
}
