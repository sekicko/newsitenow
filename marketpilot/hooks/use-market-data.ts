'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DerivPublicClient,
  normalizeContracts,
  normalizePipSize,
  normalizeSymbols,
  normalizeTick,
  VOLATILITY_SYMBOLS,
  type AvailableContract,
  type ChartStyle,
  type ConnectionState,
  type DerivMessage,
  type MarketCandle,
  type MarketSymbol,
  type MarketTick,
} from '@/lib/market-data';
import { mergeCandles, mergeTicks } from '@/lib/practice';

export type ChartInterval = '1m' | '5m' | '15m' | '30m' | '1h';
const intervalSeconds: Record<ChartInterval, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1_800,
  '1h': 3_600,
};
const chartHistoryPeriods = 100;
const supportedSymbols = new Set<string>(VOLATILITY_SYMBOLS.map(({ symbol }) => symbol));

export function useMarketData() {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [symbols, setSymbols] = useState<MarketSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [historyTicks, setHistoryTicks] = useState<MarketTick[]>([]);
  const [loadedTickHistoryKey, setLoadedTickHistoryKey] = useState('');
  const [historyCandles, setHistoryCandles] = useState<MarketCandle[]>([]);
  const [loadedCandleHistoryKey, setLoadedCandleHistoryKey] = useState('');
  const [liveTicks, setLiveTicks] = useState<MarketTick[]>([]);
  const [contracts, setContracts] = useState<AvailableContract[]>([]);
  const [interval, setInterval] = useState<ChartInterval>('1m');
  const [chartStyle, setChartStyle] = useState<ChartStyle>('area');
  const [error, setError] = useState('');
  const [tickSerial, setTickSerial] = useState(0);
  const [tickEvents, setTickEvents] = useState<Array<{ serial: number; tick: MarketTick }>>([]);
  const tickSerialRef = useRef(0);
  const tickEventsRef = useRef<Array<{ serial: number; tick: MarketTick }>>([]);
  const latestTickRef = useRef<MarketTick | null>(null);
  const clientRef = useRef<DerivPublicClient | null>(null);

  const onMessage = useCallback((message: DerivMessage) => {
    if (message.msg_type !== 'tick') return;
    const tick = normalizeTick(message.tick);
    if (!tick || !supportedSymbols.has(tick.symbol)) return;
    const serial = ++tickSerialRef.current;
    latestTickRef.current = tick;
    setTickSerial(serial);
    tickEventsRef.current = [...tickEventsRef.current.slice(-1_999), { serial, tick }];
    setTickEvents(tickEventsRef.current);
    setLiveTicks((current) => [...current.slice(-1_999), tick]);
  }, []);
  const getCurrentTickSerial = useCallback(() => tickSerialRef.current, []);
  const getTickSerial = useCallback((target: MarketTick) => (
    [...tickEventsRef.current].reverse().find(({ tick }) => (
      tick.symbol === target.symbol &&
      tick.epoch === target.epoch &&
      tick.quote === target.quote &&
      tick.pipSize === target.pipSize
    ))?.serial ?? tickSerialRef.current
  ), []);

  useEffect(() => {
    const client = new DerivPublicClient(setConnectionState);
    clientRef.current = client;
    const unsubscribe = client.listen(onMessage);
    return () => {
      unsubscribe();
      client.close();
      clientRef.current = null;
    };
  }, [onMessage]);

  const request = useCallback((payload: Record<string, unknown>) => {
    const client = clientRef.current;
    return client
      ? client.request(payload)
      : Promise.reject(new Error('Deriv market data is not connected.'));
  }, []);

  useEffect(() => {
    if (connectionState === 'connecting') {
      setError('Connecting to Deriv live market data…');
      return;
    }
    if (connectionState === 'reconnecting') {
      setError('Deriv market data disconnected. Reconnecting automatically…');
      return;
    }
    if (connectionState === 'disconnected') {
      setError('Deriv market data is disconnected.');
      return;
    }

    let cancelled = false;
    void request({ active_symbols: 'brief' }).then((response) => {
      if (cancelled) return;
      const activeSymbols = normalizeSymbols(response.active_symbols)
        .filter((symbol) => supportedSymbols.has(symbol.symbol));
      if (!activeSymbols.length) {
        setSymbols([]);
        setSelectedSymbol('');
        setError('Deriv did not return any of the supported volatility indices.');
        return;
      }

      setSymbols(activeSymbols);
      setSelectedSymbol((current) => (
        activeSymbols.some((symbol) => symbol.symbol === current)
          ? current
          : activeSymbols.find((symbol) => symbol.symbol === 'R_10')?.symbol ?? activeSymbols[0].symbol
      ));
      setError('');
    }).catch((requestError: unknown) => {
      if (!cancelled) {
        setError(requestError instanceof Error
          ? requestError.message
          : 'Unable to load active markets from Deriv.');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [connectionState, request]);

  useEffect(() => {
    if (connectionState !== 'connected' || !selectedSymbol) return;
    let cancelled = false;
    setContracts([]);
    void request({ contracts_for: selectedSymbol }).then((response) => {
      if (cancelled) return;
      const nextContracts = normalizeContracts(response.contracts_for);
      setContracts(nextContracts);
      if (!nextContracts.length) setError(`Deriv returned no contract conditions for ${selectedSymbol}.`);
    }).catch((requestError: unknown) => {
      if (!cancelled) {
        setError(requestError instanceof Error
          ? requestError.message
          : `Unable to load Deriv contract conditions for ${selectedSymbol}.`);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [connectionState, request, selectedSymbol]);

  useEffect(() => {
    if (connectionState !== 'connected' || !selectedSymbol) return;
    let cancelled = false;
    const historyKey = `${selectedSymbol}:${interval}`;
    const start = Math.max(
      0,
      Math.floor(Date.now() / 1_000) - intervalSeconds[interval] * chartHistoryPeriods,
    );
    setHistoryTicks([]);
    setLoadedTickHistoryKey('');
    void request({
      ticks_history: selectedSymbol,
      count: 1_000,
      start,
      end: 'latest',
      style: 'ticks',
      adjust_start_time: 1,
    }).then((response) => {
      if (cancelled) return;
      const history = response.history as { prices?: unknown; times?: unknown } | undefined;
      if (!Array.isArray(history?.prices) || !Array.isArray(history.times)) {
        throw new Error('Deriv did not return valid historical prices for this chart.');
      }
      const symbolPipSize = symbols.find((symbol) => symbol.symbol === selectedSymbol)?.pipSize ?? 0.01;
      const pipSize = normalizePipSize(response.pip_size) ?? symbolPipSize;
      const prices: unknown[] = history.prices;
      const times: unknown[] = history.times;
      const ticks = prices.flatMap((quote, index) => {
        const epoch = times[index];
        if (
          typeof quote !== 'number' ||
          !Number.isFinite(quote) ||
          typeof epoch !== 'number' ||
          !Number.isInteger(epoch)
        ) return [];
        return [{ symbol: selectedSymbol, quote, epoch, pipSize }];
      });
      if (!ticks.length) throw new Error('Deriv returned no usable historical prices for this chart.');
      setHistoryTicks(ticks);
      setLoadedTickHistoryKey(historyKey);
      setError('');
    }).catch((requestError: unknown) => {
      if (!cancelled) {
        setLoadedTickHistoryKey(historyKey);
        setError(requestError instanceof Error
          ? requestError.message
          : 'Unable to load Deriv chart history.');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [connectionState, interval, request, selectedSymbol, symbols]);

  useEffect(() => {
    if (chartStyle !== 'candlestick') {
      setHistoryCandles([]);
      setLoadedCandleHistoryKey('');
      return;
    }
    if (connectionState !== 'connected' || !selectedSymbol) return;

    let cancelled = false;
    const historyKey = `${selectedSymbol}:${interval}`;
    const granularity = intervalSeconds[interval];
    const start = Math.max(
      0,
      Math.floor(Date.now() / 1_000) - granularity * chartHistoryPeriods,
    );
    setHistoryCandles([]);
    setLoadedCandleHistoryKey('');
    void request({
      ticks_history: selectedSymbol,
      count: chartHistoryPeriods,
      start,
      end: 'latest',
      style: 'candles',
      granularity,
      adjust_start_time: 1,
    }).then((response) => {
      if (cancelled) return;
      if (!Array.isArray(response.candles)) {
        throw new Error('Deriv did not return valid historical candles for this chart.');
      }
      const pipSize = normalizePipSize(response.pip_size)
        ?? symbols.find((symbol) => symbol.symbol === selectedSymbol)?.pipSize
        ?? 0.01;
      const candles = response.candles.flatMap((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const candle = value as Record<string, unknown>;
        if (
          typeof candle.epoch !== 'number' ||
          !Number.isInteger(candle.epoch) ||
          typeof candle.open !== 'number' ||
          !Number.isFinite(candle.open) ||
          typeof candle.high !== 'number' ||
          !Number.isFinite(candle.high) ||
          typeof candle.low !== 'number' ||
          !Number.isFinite(candle.low) ||
          typeof candle.close !== 'number' ||
          !Number.isFinite(candle.close)
        ) return [];
        return [{
          symbol: selectedSymbol,
          epoch: candle.epoch,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          pipSize,
        }];
      });
      if (!candles.length) throw new Error('Deriv returned no usable historical candles for this chart.');
      setHistoryCandles(candles);
      setLoadedCandleHistoryKey(historyKey);
      setError('');
    }).catch((requestError: unknown) => {
      if (!cancelled) {
        setLoadedCandleHistoryKey(historyKey);
        setError(requestError instanceof Error
          ? requestError.message
          : 'Unable to load Deriv chart candles.');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chartStyle, connectionState, interval, request, selectedSymbol, symbols]);

  useEffect(() => {
    if (connectionState !== 'connected' || !symbols.length) return;
    let cancelled = false;
    let subscriptionId: string | null = null;
    void request({
      ticks: symbols.map((symbol) => symbol.symbol),
      subscribe: 1,
    }).then((response) => {
      const subscription = response.subscription as { id?: unknown } | undefined;
      if (typeof subscription?.id !== 'string') {
        if (!cancelled) setError('Deriv did not confirm the live price subscription.');
        return;
      }
      if (cancelled) {
        void request({ forget: subscription.id }).catch(() => undefined);
      } else {
        subscriptionId = subscription.id;
      }
    }).catch((requestError: unknown) => {
      if (!cancelled) {
        setError(requestError instanceof Error
          ? requestError.message
          : 'Unable to subscribe to Deriv live prices.');
      }
    });

    return () => {
      cancelled = true;
      if (subscriptionId) void request({ forget: subscriptionId }).catch(() => undefined);
    };
  }, [connectionState, request, symbols]);

  const latestLiveEpoch = [...liveTicks].reverse().find((tick) => tick.symbol === selectedSymbol)?.epoch
    ?? historyTicks.at(-1)?.epoch
    ?? Math.floor(Date.now() / 1_000);
  const windowStart = latestLiveEpoch - intervalSeconds[interval] * chartHistoryPeriods;
  const historyKey = `${selectedSymbol}:${interval}`;
  const hasTickHistory = historyTicks.some((tick) => tick.symbol === selectedSymbol);
  const hasCandleHistory = historyCandles.some((candle) => candle.symbol === selectedSymbol);
  const chartTicks = useMemo(
    () => loadedTickHistoryKey === historyKey && hasTickHistory
      ? mergeTicks(historyTicks, liveTicks, selectedSymbol, windowStart)
      : [],
    [hasTickHistory, historyKey, historyTicks, liveTicks, loadedTickHistoryKey, selectedSymbol, windowStart],
  );
  const chartCandles = useMemo(
    () => loadedCandleHistoryKey === historyKey && hasCandleHistory
      ? mergeCandles(
          historyCandles,
          liveTicks,
          selectedSymbol,
          intervalSeconds[interval],
          windowStart,
        )
      : [],
    [hasCandleHistory, historyCandles, historyKey, interval, liveTicks, loadedCandleHistoryKey, selectedSymbol, windowStart],
  );
  const chartLoading = chartStyle === 'candlestick'
    ? loadedCandleHistoryKey !== historyKey
    : loadedTickHistoryKey !== historyKey;

  return {
    connectionState,
    symbols,
    selectedSymbol,
    setSelectedSymbol,
    interval,
    setInterval,
    chartStyle,
    setChartStyle,
    historyTicks,
    liveTicks,
    chartTicks,
    chartCandles,
    chartLoading,
    contracts,
    error,
    setError,
    tickSerial,
    getCurrentTickSerial,
    getTickSerial,
    tickEvents,
    latestTick: latestTickRef.current,
  };
}
