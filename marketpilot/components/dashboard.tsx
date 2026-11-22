'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  Activity,
  BarChart3,
  ChevronDown,
  Clock3,
  Menu,
  Moon,
  Sun,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { AuthControls } from '@/components/auth/auth-controls';
import { PriceChart } from '@/components/price-chart';
import { useMarketData } from '@/hooks/use-market-data';
import {
  CONTRACT_LABELS,
  CONTRACT_TYPES,
  getLastDigit,
  parseContractDuration,
  precisionFromPip,
  type AvailableContract,
  type MarketTick,
  type PracticeKind,
} from '@/lib/deriv-client';
import { type PracticeTrade, contractWon } from '@/lib/practice';
import { getSupabaseBrowserClient } from '@/lib/supabase/browser';
import type { User } from '@supabase/supabase-js';
import type { WalletAccount, WalletBalances } from '@/lib/wallets';

const kindLabels: Record<PracticeKind, string> = {
  'over-under': 'Over / Under',
  'even-odd': 'Even / Odd',
  'matches-differs': 'Matches / Differs',
  'rise-fall': 'Rise / Fall',
};

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

function storedNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
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
  if (
    duration === null ||
    stake === null ||
    quotedPayout === null ||
    entryPrice === null ||
    entryPipSize === null ||
    entryDigit === null ||
    entryEpoch === null ||
    elapsed === null ||
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

function displayDuration(contract: AvailableContract | undefined) {
  const min = contract ? parseContractDuration(contract.min_contract_duration) : null;
  const max = contract ? parseContractDuration(contract.max_contract_duration) : null;
  return {
    min: min?.amount ?? 1,
    max: max?.amount ?? 10,
    unit: min?.unit ?? 't',
    minText: contract?.min_contract_duration ?? '—',
    maxText: contract?.max_contract_duration ?? '—',
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
  const [digit, setDigit] = useState(3);
  const [duration, setDuration] = useState(5);
  const [stake, setStake] = useState(1);
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
  const [openingTrade, setOpeningTrade] = useState(false);
  const [trades, setTrades] = useState<PracticeTrade[]>([]);
  const [digitExitHighlight, setDigitExitHighlight] = useState<DigitExitHighlight | null>(null);
  const [activeTradeView, setActiveTradeView] = useState<TradeHistoryView>('all');
  const [marketMenuOpen, setMarketMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobilePage, setMobilePage] = useState<'hub' | 'history'>('hub');
  const tradeCounter = useRef(0);
  const openingTradeRef = useRef(false);
  const settlingTradeIdsRef = useRef(new Set<string>());
  const digitExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDigitExitHighlight = useCallback(() => {
    if (digitExitTimerRef.current !== null) clearTimeout(digitExitTimerRef.current);
    digitExitTimerRef.current = null;
    setDigitExitHighlight(null);
  }, []);
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

  const selectedMarket = market.symbols.find((item) => item.symbol === market.selectedSymbol);
  const latestLiveTick = [...market.liveTicks].reverse().find((tick) => tick.symbol === market.selectedSymbol) ?? null;
  const latestHistoricalTick = market.chartTicks.at(-1) ?? null;
  const currentTick = latestLiveTick ?? latestHistoricalTick;
  const precision = precisionFromPip(currentTick?.pipSize ?? selectedMarket?.pipSize ?? 0.01);
  const formattedPrice = currentTick ? currentTick.quote.toFixed(precision) : null;
  const pricePrefix = formattedPrice && precision > 0 ? formattedPrice.slice(0, -1) : formattedPrice ?? '—';
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
  const durationLimits = displayDuration(contractInfo);
  const safeDuration = Math.max(durationLimits.min, Math.min(Math.round(duration), durationLimits.max));
  const alternativeContractType = contractTypes.find((type) => type !== selectedContractType) ?? null;
  const alternativeContractInfo = tickContracts.find((contract) => contract.contract_type === alternativeContractType);
  const alternativeDurationLimits = displayDuration(alternativeContractInfo);
  const alternativeSafeDuration = Math.max(
    alternativeDurationLimits.min,
    Math.min(Math.round(duration), alternativeDurationLimits.max),
  );
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
    if (!availableChoices.length) return;
    if (!availableChoices.includes(contractType)) setContractType(availableChoices[0]);
  }, [availableChoices, contractType]);

  useEffect(() => {
    setDuration((value) => Math.max(durationLimits.min, Math.min(Math.round(value), durationLimits.max)));
  }, [durationLimits.min, durationLimits.max]);

  useEffect(() => {
    if (
      market.connectionState !== 'connected' ||
      !market.selectedSymbol ||
      !marketOpen ||
      !availableChoices.includes(selectedContractType) ||
      !Number.isFinite(stake) ||
      stake <= 0
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
        amount: stake,
        basis: 'stake',
        contract_type: selectedContractType,
        currency: WALLET_CURRENCY,
        duration: safeDuration,
        duration_unit: durationLimits.unit,
        underlying_symbol: market.selectedSymbol,
      };
      if (['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(selectedContractType)) {
        request.barrier = String(digit);
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
        setQuote({
          askPrice: proposal.ask_price,
          payout: proposal.payout,
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
    durationLimits.unit,
    market.connectionState,
    marketOpen,
    market.request,
    market.selectedSymbol,
    safeDuration,
    selectedContractType,
    stake,
  ]);

  useEffect(() => {
    if (
      !alternativeContractType ||
      !availableChoices.includes(alternativeContractType) ||
      market.connectionState !== 'connected' ||
      !market.selectedSymbol ||
      !marketOpen ||
      !Number.isFinite(stake) ||
      stake <= 0
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
        amount: stake,
        basis: 'stake',
        contract_type: alternativeContractType,
        currency: WALLET_CURRENCY,
        duration: alternativeSafeDuration,
        duration_unit: alternativeDurationLimits.unit,
        underlying_symbol: market.selectedSymbol,
      };
      if (['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(alternativeContractType)) {
        request.barrier = String(digit);
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
        setAlternativeQuote({
          askPrice: proposal.ask_price,
          payout: proposal.payout,
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
    market.connectionState,
    marketOpen,
    market.request,
    market.selectedSymbol,
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
      const won = contractWon(trade.contractType, trade.entryPrice, exitTick.quote, exitTick, trade.barrier);
      const payout = won ? trade.quotedPayout : 0;
      const settleTrade = async () => {
        try {
          const { data, error } = await getSupabaseBrowserClient().rpc('marketpilot_settle_practice_trade', {
            p_trade_id: trade.id,
            p_account_type: trade.accountType,
            p_exit_price: exitTick.quote,
            p_exit_pip_size: exitTick.pipSize,
            p_exit_digit: getLastDigit(exitTick),
            p_exit_epoch: exitTick.epoch,
          });
          if (error) throw error;
          const balance = storedNumber(data);
          if (balance === null || balance < 0) throw new Error('The wallet returned an invalid balance.');
          if (authUserIdRef.current === userId) {
            setWalletBalances((current) => current
              ? { ...current, [trade.accountType]: balance }
              : current);
            setTrades((current) => current.map((item) => item.id === trade.id ? {
              ...item,
              elapsed: trade.duration,
              status: won ? 'Won' : 'Lost',
              exitPrice: exitTick.quote,
              exitPipSize: exitTick.pipSize,
              exitDigit: getLastDigit(exitTick),
              exitEpoch: exitTick.epoch,
              payout,
              profit: payout - trade.stake,
            } : item));
            if (trade.contractType.startsWith('DIGIT')) {
              showDigitExitHighlight({
                tradeId: trade.id,
                symbol: trade.symbol,
                digit: getLastDigit(exitTick),
                outcome: won ? 'win' : 'loss',
              });
            }
            setTradeActionError('');
          }
        } catch {
          if (authUserIdRef.current === userId) {
            setTradeActionError('Trade settlement could not be saved. It will retry on the next market tick.');
          }
        } finally {
          settlingTradeIdsRef.current.delete(settlementKey);
        }
      };
      void settleTrade();
    }
  }, [authUser?.id, market.tickEvents, showDigitExitHighlight, trades]);

  const chooseKind = (nextKind: PracticeKind) => {
    setKind(nextKind);
    setContractType(contractDefaults[nextKind]);
  };

  const startPractice = async (type = selectedContractType, tradeQuote = quote) => {
    const tradeContract = tickContracts.find((contract) => contract.contract_type === type);
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
      openingTradeRef.current
    ) return;
    const tradeDurationLimits = displayDuration(tradeContract);
    const tradeDuration = Math.max(tradeDurationLimits.min, Math.min(Math.round(duration), tradeDurationLimits.max));
    const hasDigitBarrier = ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type);
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
        p_barrier: hasDigitBarrier ? digit : null,
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
        contractLabel: `${typeLabel}${hasDigitBarrier ? ` ${digit}` : ''}`,
        barrier: hasDigitBarrier ? digit : null,
        duration: tradeDuration,
        durationUnit: tradeDurationLimits.unit,
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

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 601px)');
    const resetMobilePage = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setMobilePage('hub');
        setMobileMenuOpen(false);
      }
    };
    desktop.addEventListener('change', resetMobilePage);
    return () => desktop.removeEventListener('change', resetMobilePage);
  }, []);

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
  const formatProfit = (amount: number) => `${amount >= 0 ? '+' : '-'}${formatMoney(amount)}`;
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
        const loading = type === selectedContractType
          ? quoteLoading
          : type === alternativeContractType && alternativeQuoteLoading;
        const error = type === selectedContractType
          ? quoteError
          : type === alternativeContractType
            ? alternativeQuoteError
            : '';
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
          !latestLiveTick ||
          !marketOpen ||
          !authUser ||
          !walletBalances ||
          walletLoading ||
          !!walletError ||
          activeWallet !== 'demo' ||
          insufficientBalance ||
          openingTrade;
        const unavailableText = !supported
          ? 'Not available for this market'
          : !marketOpen
            ? 'Market closed'
            : !latestLiveTick
              ? 'Waiting for a live tick'
              : !authUser
                ? 'Sign in to use a wallet'
                : walletLoading
                  ? 'Loading wallet…'
                  : walletError
                    ? 'Wallet unavailable'
                    : activeWallet === 'real'
                      ? 'Real wallet is read-only for now'
                    : insufficientBalance
                        ? 'Insufficient balance'
                        : openingTrade
                          ? 'Opening demo trade…'
              : loading
                ? 'Loading proposal…'
                : error || 'Proposal unavailable';

        return (
          <button
            key={type}
            className={`contract-action-button ${positive ? 'is-positive' : 'is-negative'}`}
            type="button"
            onClick={() => startPractice(type, actionQuote)}
            disabled={disabled}
            title={disabled ? error || unavailableText : `Start ${actionLabel} demo trade`}
            aria-label={actionQuote
              ? `${actionLabel}. Payout ${formatMoney(actionQuote.payout)}, including ${formatMoney(actionQuote.askPrice)} stake and ${formatProfit(actionQuote.payout - actionQuote.askPrice)} profit.`
              : `${actionLabel}. ${unavailableText}.`}
          >
            <span className="contract-action-name">{actionLabel}</span>
            {actionQuote ? (
              <>
                <strong className="contract-action-payout">{formatMoney(actionQuote.payout)}</strong>
                <small>
                  Payout · {actionDuration} {actionDurationUnit} · {formatMoney(actionQuote.askPrice)} stake · {formatProfit(actionQuote.payout - actionQuote.askPrice)} profit
                </small>
              </>
            ) : (
              <small>{unavailableText}</small>
            )}
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
          <a className="nav-link active" href="#market">Traders Hub</a>
          <a className="nav-link" href="#statistics">Markets</a>
          <a className="nav-link" href="#trade">Trade</a>
        </nav>
        <nav className="mobile-contract-nav" aria-label="Choose contract type">
          {(Object.keys(kindLabels) as PracticeKind[]).map((item) => (
            <button
              key={item}
              type="button"
              className={kind === item ? 'selected' : ''}
              onClick={() => {
                chooseKind(item);
                setMobilePage('hub');
              }}
              aria-pressed={kind === item}
            >
              {kindLabels[item]}
            </button>
          ))}
        </nav>
        <div className="header-actions">
          <AuthControls
            onUserChange={onAuthUserChange}
            balances={walletBalances}
            activeWallet={activeWallet}
            walletLoading={walletLoading}
            walletError={walletError}
            onWalletChange={setActiveWallet}
          />
          <button
            type="button"
            className="icon-button theme-toggle"
            onClick={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {themeIcon}
          </button>
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
              <button
                type="button"
                className={mobilePage === 'history' ? 'selected' : ''}
                onClick={() => {
                  setMobilePage('history');
                  setMobileMenuOpen(false);
                }}
              >
                Trade History
              </button>
            </nav>
          </aside>
        </div>
      )}

      {mobilePage === 'history' && (
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

      <div className={`page-content${mobilePage === 'history' ? ' is-mobile-history-hidden' : ''}`}>
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
                      <strong className={latestLiveTick ? '' : 'historical-price'}>{pricePrefix}</strong>
                    </div>
                    <div className="price-last-digit">
                      <span className="price-label">LAST DIGIT</span>
                      <strong className="last-digit-box">{activeDigit ?? '—'}</strong>
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
              <section className="digit-distribution-panel" id="statistics">
                <div className="section-heading">
                  <h2>Digit distribution</h2>
                </div>
                <div
                  className="digit-distribution"
                  role="img"
                  aria-label={activeDigit === null
                    ? 'Digit distribution from zero to nine. Waiting for market data.'
                    : `Digit distribution from zero to nine. Active last digit: ${activeDigit}.${activeDigitTrade ? ' An open digit demo trade highlights the live digit in blue.' : selectedDigitExitHighlight ? ` The ${selectedDigitExitHighlight.outcome} trade exit digit ${selectedDigitExitHighlight.digit} is highlighted temporarily.` : ''}`}
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
                      onChange={(event) => {
                        const value = event.target.value === '' ? 0 : Number(event.target.value);
                        setDigit(Number.isFinite(value) ? Math.max(0, Math.min(9, Math.round(value))) : 3);
                      }}
                    />
                  </div>
                )}
                <div className="form-field">
                  <label htmlFor="duration">Duration</label>
                  <div className="input-suffix">
                    <input
                      id="duration"
                      type="number"
                      min={durationLimits.min}
                      max={durationLimits.max}
                      step="1"
                      value={safeDuration}
                      onChange={(event) => setDuration(Number(event.target.value))}
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
                      onChange={(event) => setStake(Number(event.target.value))}
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
      {mobilePage === 'hub' && renderContractActions('floating')}
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
          <><span className="trade-status open"><i /> Open · {trade.elapsed}/{trade.duration}</span><small>Demo trade</small></>
        ) : (
          <>
            <span className={`trade-status ${trade.status.toLowerCase()}`}>{trade.status === 'Won' ? 'Won' : 'Lost'}</span>
            <strong className={(trade.profit ?? 0) > 0 ? 'positive' : (trade.profit ?? 0) < 0 ? 'negative' : ''}>
              {(trade.profit ?? 0) > 0 ? '+' : ''}{(trade.profit ?? 0).toFixed(2)} {currency}
            </strong>
            <small>
              Exit {trade.exitPrice?.toFixed(exitPrecision) ?? '—'} · digit {trade.exitDigit ?? '—'} · {trade.exitEpoch ? `${localTime(trade.exitEpoch)} UTC` : ''}
            </small>
          </>
        )}
      </div>
    </article>
  );
}
