'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type CandlestickData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { ChartStyle, MarketCandle, MarketTick } from '@/lib/deriv-client';
import { precisionFromPip } from '@/lib/deriv-client';

type Props = {
  symbol: string;
  interval: string;
  ticks: MarketTick[];
  candles: MarketCandle[];
  chartStyle: ChartStyle;
  loading: boolean;
  theme: 'dark' | 'light';
};

export function PriceChart({ symbol, interval, ticks, candles, chartStyle, loading, theme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaSeriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const fittedViewRef = useRef<{ chart: IChartApi; key: string; count: number } | null>(null);
  const [hover, setHover] = useState<{
    time: Time;
    value?: number;
    open?: number;
    high?: number;
    low?: number;
    close?: number;
  } | null>(null);
  const latestTick = ticks.at(-1);
  const latestCandle = candles.at(-1);
  const latestPrice = chartStyle === 'candlestick' ? latestCandle?.close : latestTick?.quote;
  const precision = precisionFromPip(latestTick?.pipSize ?? latestCandle?.pipSize ?? 0.01);
  const firstPrice = chartStyle === 'candlestick' ? candles[0]?.open : ticks[0]?.quote;
  const trendUp = latestPrice !== undefined && firstPrice !== undefined && latestPrice >= firstPrice;
  const lineColor = trendUp ? '#38bdf8' : '#f26a72';

  useEffect(() => {
    if (!containerRef.current) return;
    const dark = theme === 'dark';
    const container = containerRef.current;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: dark ? '#111827' : '#ffffff' },
        textColor: dark ? '#8794a8' : '#687588',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: dark ? 'rgba(137, 153, 175, .08)' : 'rgba(50, 67, 87, .08)' },
        horzLines: { color: dark ? 'rgba(137, 153, 175, .08)' : 'rgba(50, 67, 87, .08)' },
      },
      rightPriceScale: {
        borderColor: dark ? '#293344' : '#e5e9ef',
        autoScale: true,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: dark ? '#293344' : '#e5e9ef',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 4,
        rightOffsetPixels: 112,
        barSpacing: 8,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: dark ? '#77849a' : '#8794a8', labelBackgroundColor: '#2463eb' },
        horzLine: { color: dark ? '#77849a' : '#8794a8', labelBackgroundColor: '#2463eb' },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      localization: {
        timeFormatter: (time: Time) => {
          const epoch = typeof time === 'number' ? time : 0;
          return new Date(epoch * 1_000).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
        },
      },
    });
    const areaSeries = chartStyle === 'area'
      ? chart.addSeries(AreaSeries, {
          lineColor,
          topColor: trendUp ? 'rgba(56, 189, 248, .25)' : 'rgba(242, 106, 114, .25)',
          bottomColor: trendUp ? 'rgba(56, 189, 248, .08)' : 'rgba(242, 106, 114, .08)',
          lineWidth: 2,
          priceLineVisible: true,
          lastValueVisible: true,
          priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
          crosshairMarkerVisible: true,
          crosshairMarkerRadius: 4,
        })
      : null;
    const candleSeries = chartStyle === 'candlestick'
      ? chart.addSeries(CandlestickSeries, {
          upColor: '#16a36a',
          downColor: '#e34b58',
          borderVisible: false,
          wickUpColor: '#16a36a',
          wickDownColor: '#e34b58',
          priceLineVisible: true,
          lastValueVisible: true,
          priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
        })
      : null;
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHover(null);
        return;
      }
      if (areaSeries) {
        const data = param.seriesData.get(areaSeries) as AreaData<Time> | undefined;
        if (typeof data?.value === 'number') {
          setHover({ time: param.time, value: data.value });
          return;
        }
      }
      if (candleSeries) {
        const data = param.seriesData.get(candleSeries) as CandlestickData<Time> | undefined;
        if (typeof data?.close === 'number') {
          setHover({ time: param.time, open: data.open, high: data.high, low: data.low, close: data.close });
          return;
        }
      }
      setHover(null);
    });
    chartRef.current = chart;
    areaSeriesRef.current = areaSeries;
    candleSeriesRef.current = candleSeries;

    let pinchStart: { distanceY: number; from: number; to: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        pinchStart = null;
        return;
      }

      const activeSeries = areaSeries ?? candleSeries;
      const range = activeSeries?.priceScale().getVisibleRange();
      if (!range) {
        pinchStart = null;
        return;
      }

      pinchStart = {
        distanceY: Math.abs(event.touches[0].clientY - event.touches[1].clientY),
        from: range.from,
        to: range.to,
      };
    };
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinchStart || pinchStart.distanceY < 1) return;

      const distanceY = Math.abs(event.touches[0].clientY - event.touches[1].clientY);
      const zoom = Math.min(8, Math.max(0.125, distanceY / pinchStart.distanceY));
      const middle = (pinchStart.from + pinchStart.to) / 2;
      const halfRange = (pinchStart.to - pinchStart.from) / (2 * zoom);
      if (!Number.isFinite(halfRange) || halfRange <= 0) return;

      event.preventDefault();
      const activeSeries = areaSeries ?? candleSeries;
      if (!activeSeries) return;
      const priceScale = activeSeries.priceScale();
      priceScale.setAutoScale(false);
      priceScale.setVisibleRange({ from: middle - halfRange, to: middle + halfRange });
    };
    const onTouchEnd = () => {
      pinchStart = null;
    };
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: false });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    container.addEventListener('touchcancel', onTouchEnd, { passive: true });

    const resizeObserver = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      if (width <= 0) return;
      chart.applyOptions({
        layout: { fontSize: width < 420 ? 9 : width < 760 ? 10 : 11 },
        rightPriceScale: {
          minimumWidth: width < 420 ? 44 : width < 760 ? 52 : 60,
          autoScale: true,
          scaleMargins: { top: 0.12, bottom: 0.12 },
        },
        timeScale: {
          secondsVisible: width >= 520,
          barSpacing: width < 420 ? 4 : width < 760 ? 6 : 8,
          rightOffsetPixels: Math.min(112, Math.max(48, width * 0.18)),
        },
      });
      chart.timeScale().fitContent();
    });
    resizeObserver.observe(containerRef.current);
    return () => {
      resizeObserver.disconnect();
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      chart.remove();
      chartRef.current = null;
      areaSeriesRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [theme, chartStyle, precision]);

  useEffect(() => {
    areaSeriesRef.current?.applyOptions({
      lineColor,
      topColor: trendUp ? 'rgba(56, 189, 248, .25)' : 'rgba(242, 106, 114, .25)',
      bottomColor: trendUp ? 'rgba(56, 189, 248, .08)' : 'rgba(242, 106, 114, .08)',
    });
  }, [lineColor, trendUp]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const byEpoch = new Map<number, MarketTick>();
    for (const tick of ticks) byEpoch.set(tick.epoch, tick);
    const tickData: AreaData<UTCTimestamp>[] = [...byEpoch.values()]
      .sort((a, b) => a.epoch - b.epoch)
      .map((tick) => ({ time: tick.epoch as UTCTimestamp, value: tick.quote }));
    if (areaSeriesRef.current) areaSeriesRef.current.setData(tickData);

    const candleData: CandlestickData<UTCTimestamp>[] = candles
      .map((candle) => ({
        time: candle.epoch as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      }))
      .sort((a, b) => Number(a.time) - Number(b.time));
    if (candleSeriesRef.current) candleSeriesRef.current.setData(candleData);

    const dataCount = chartStyle === 'candlestick' ? candleData.length : tickData.length;
    const viewKey = `${symbol}:${interval}:${chartStyle}`;
    const previousView = fittedViewRef.current;
    const viewChanged = previousView === null || previousView.chart !== chart || previousView.key !== viewKey;
    const historyChanged = previousView !== null && (
      dataCount > previousView.count * 2 ||
      dataCount < previousView.count / 2
    );
    if (dataCount && (viewChanged || historyChanged)) {
      (areaSeriesRef.current ?? candleSeriesRef.current)?.priceScale().setAutoScale(true);
      chart.timeScale().fitContent();
    } else {
      const timeScale = chart.timeScale();
      const rightOffsetPixels = timeScale.options().rightOffsetPixels;
      if (rightOffsetPixels === undefined) {
        timeScale.scrollToRealTime();
      } else {
        timeScale.applyOptions({ rightOffsetPixels });
      }
    }
    if (dataCount) fittedViewRef.current = { chart, key: viewKey, count: dataCount };
  }, [ticks, candles, symbol, interval, chartStyle]);

  return (
    <div className="chart-wrap">
      <div className="chart-hover">
        {hover ? (
          <>
            <span>{new Date(Number(hover.time) * 1_000).toLocaleString()}</span>
            {hover.open !== undefined ? (
              <strong>O {hover.open.toFixed(precision)} · H {hover.high?.toFixed(precision)} · L {hover.low?.toFixed(precision)} · C {hover.close?.toFixed(precision)}</strong>
            ) : (
              <strong>{hover.value?.toFixed(precision)}</strong>
            )}
          </>
        ) : latestPrice !== undefined ? (
          <>
            <span>
              {chartStyle === 'candlestick' ? 'Latest candle' : 'Latest tick'} ·{' '}
              {new Date((latestCandle?.epoch ?? latestTick?.epoch ?? 0) * 1_000).toLocaleTimeString()}
            </span>
            <strong>{latestPrice.toFixed(precision)}</strong>
          </>
        ) : (
          <span>Waiting for genuine {chartStyle === 'candlestick' ? 'candle' : 'market'} data…</span>
        )}
      </div>
      <div
        ref={containerRef}
        className="chart-canvas"
        aria-label={chartStyle === 'candlestick' ? 'Live market candlestick chart' : 'Live market area line graph'}
      />
      {(chartStyle === 'candlestick' ? candles.length === 0 : ticks.length === 0) && (
        <div className="chart-empty">
          <span className={`empty-dot${loading ? ' is-loading' : ''}`} />
          <p>{loading ? 'Loading selected market history…' : 'No historical market data is available for this view.'}</p>
        </div>
      )}
    </div>
  );
}
