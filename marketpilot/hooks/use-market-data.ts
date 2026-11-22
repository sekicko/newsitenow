'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DerivClient,
  getDerivWsUrl,
  normalizeContracts,
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
} from '@/lib/deriv-client';
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
  const latestTickRef = useRef<MarketTick | null>(null);
  const clientRef = useRef<DerivClient | null>(null);

  const onMessage = useCallback((message: DerivMessage) => {
    if (message.msg_type !== 'tick') return;
    const tick = normalizeTick(message.tick);
    if (!tick) return;
    const serial = ++tickSerialRef.current;
    latestTickRef.current = tick;
    setTickSerial(serial);
    setTickEvents((current) => [...current.slice(-1_999), { serial, tick }]);
    setLiveTicks((current) => [...current.slice(-1_999), tick]);
  }, []);

  useEffect(() => {
    const client = new DerivClient(getDerivWsUrl(), setConnectionState);
    clientRef.current = client;
    const unsubscribe = client.listen(onMessage);
    return () => {
      unsubscribe();
      client.close();
      clientRef.current = null;
    };
  }, [onMessage]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || connectionState !== 'connected') return;
    client.request({ active_symbols: 'brief' }).then((response) => {
      const activeSymbols = normalizeSymbols(response.active_symbols);
      const activeByCode = new Map(activeSymbols.map((symbol) => [symbol.symbol, symbol]));
      const nextSymbols = VOLATILITY_SYMBOLS.flatMap((item) => {
        const providerSymbol = activeByCode.get(item.symbol);
        return providerSymbol ? [{ ...providerSymbol, name: item.name }] : [];
      });
      if (!nextSymbols.length) {
        setSymbols([]);
        setSelectedSymbol('');
        setError('Market data is not currently returning any of the ten supported volatility indices.');
        return;
      }
      setSymbols(nextSymbols);
      setSelectedSymbol((current) => {
        if (current && nextSymbols.some((symbol) => symbol.symbol === current)) return current;
        const defaultSymbol = nextSymbols.find((symbol) => symbol.symbol === 'R_10');
        return (nextSymbols.find((symbol) => symbol.exchangeOpen && !symbol.suspended) ?? defaultSymbol ?? nextSymbols[0]).symbol;
      });
      setError('');
    }).catch((requestError: unknown) => {
      setError(requestError instanceof Error ? requestError.message : 'Unable to load market symbols.');
    });
  }, [connectionState]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || connectionState !== 'connected' || !selectedSymbol) return;
    let cancelled = false;
    setLiveTicks([]);
    setContracts([]);
    client.request({ contracts_for: selectedSymbol }).then((response) => {
      if (!cancelled) setContracts(normalizeContracts(response.contracts_for));
    }).catch((requestError: unknown) => {
      if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Unable to load contract conditions.');
    });
    return () => {
      cancelled = true;
    };
  }, [connectionState, selectedSymbol]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || connectionState !== 'connected' || !selectedSymbol) return;
    let cancelled = false;
    const historyKey = `${selectedSymbol}:${interval}`;
    const start = Math.floor(Date.now() / 1_000) - intervalSeconds[interval] * chartHistoryPeriods;
    setHistoryTicks([]);
    setLoadedTickHistoryKey('');
    client.request({
      ticks_history: selectedSymbol,
      start,
      end: 'latest',
      style: 'ticks',
      adjust_start_time: 1,
    }).then((response) => {
      if (cancelled) return;
      const history = response.history as { prices?: unknown; times?: unknown } | undefined;
      if (!Array.isArray(history?.prices) || !Array.isArray(history.times)) {
        setHistoryTicks([]);
        setLoadedTickHistoryKey(historyKey);
        setError('No historical market ticks were returned for this interval.');
        return;
      }
      const prices: unknown[] = history.prices;
      const times: unknown[] = history.times;
      const price = response.pip_size;
      const pipSize = typeof price === 'number'
        ? price
        : symbols.find((symbol) => symbol.symbol === selectedSymbol)?.pipSize ?? 0.01;
      const ticks = prices.flatMap((quote, index) => {
        const epoch = times[index];
        if (typeof quote !== 'number' || typeof epoch !== 'number') return [];
        return [{ symbol: selectedSymbol, quote, epoch, pipSize }];
      });
      setHistoryTicks(ticks);
      setLoadedTickHistoryKey(historyKey);
      setError('');
    }).catch((requestError: unknown) => {
      if (!cancelled) {
        setLoadedTickHistoryKey(historyKey);
        setError(requestError instanceof Error ? requestError.message : 'Unable to load historical market data.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [connectionState, interval, selectedSymbol, symbols]);

  useEffect(() => {
    const client = clientRef.current;
    if (chartStyle !== 'candlestick') {
      setHistoryCandles([]);
      setLoadedCandleHistoryKey('');
      return;
    }
    if (!client || connectionState !== 'connected' || !selectedSymbol) return;

    let cancelled = false;
    const historyKey = `${selectedSymbol}:${interval}`;
    const granularity = intervalSeconds[interval];
    const start = Math.floor(Date.now() / 1_000) - granularity * chartHistoryPeriods;
    setHistoryCandles([]);
    setLoadedCandleHistoryKey('');
    client.request({
      ticks_history: selectedSymbol,
      start,
      end: 'latest',
      style: 'candles',
      granularity,
      adjust_start_time: 1,
    }).then((response) => {
      if (cancelled) return;
      if (!Array.isArray(response.candles)) {
        setHistoryCandles([]);
        setLoadedCandleHistoryKey(historyKey);
        setError('No historical market candles were returned for this interval.');
        return;
      }

      const responsePipSize = response.pip_size;
      const pipSize = typeof responsePipSize === 'number'
        ? responsePipSize
        : symbols.find((symbol) => symbol.symbol === selectedSymbol)?.pipSize ?? 0.01;
      const candles = (response.candles as unknown[]).flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const candle = value as Record<string, unknown>;
        if (
          typeof candle.epoch !== 'number' ||
          typeof candle.open !== 'number' ||
          typeof candle.high !== 'number' ||
          typeof candle.low !== 'number' ||
          typeof candle.close !== 'number'
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
      setHistoryCandles(candles);
      setLoadedCandleHistoryKey(historyKey);
      setError(candles.length ? '' : 'No historical market candles were returned for this interval.');
    }).catch((requestError: unknown) => {
      if (!cancelled) {
        setLoadedCandleHistoryKey(historyKey);
        setError(requestError instanceof Error ? requestError.message : 'Unable to load historical market candles.');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chartStyle, connectionState, interval, selectedSymbol, symbols]);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || connectionState !== 'connected' || !selectedSymbol) return;
    let cancelled = false;
    let subscriptionId: string | null = null;
    client.request({ ticks: selectedSymbol, subscribe: 1 }).then((response) => {
      const subscription = response.subscription as { id?: unknown } | undefined;
      if (typeof subscription?.id !== 'string') return;
      if (cancelled) {
        void client.request({ forget: subscription.id }).catch(() => undefined);
      } else {
        subscriptionId = subscription.id;
      }
    }).catch((requestError: unknown) => {
      if (!cancelled) setError(requestError instanceof Error ? requestError.message : 'Unable to subscribe to live ticks.');
    });
    return () => {
      cancelled = true;
      if (subscriptionId) void client.request({ forget: subscriptionId }).catch(() => undefined);
    };
  }, [connectionState, selectedSymbol]);

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
  const request = useCallback((payload: Record<string, unknown>) => {
    const client = clientRef.current;
    return client
      ? client.request(payload)
      : Promise.reject(new Error('Market data is not connected.'));
  }, []);

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
    tickEvents,
    latestTick: latestTickRef.current,
    request,
  };
}
