import { getLastDigit, type MarketCandle, type MarketTick } from './deriv-client';
import type { WalletAccount } from './wallets';

export type PracticeTrade = {
  id: string;
  accountType: WalletAccount;
  symbol: string;
  contractType: string;
  contractLabel: string;
  barrier: number | null;
  duration: number;
  durationUnit: string;
  stake: number;
  quotedPayout: number;
  entryPrice: number;
  entryPipSize: number;
  entryDigit: number;
  entryEpoch: number;
  entrySerial: number;
  elapsed: number;
  status: 'Open' | 'Won' | 'Lost';
  exitPrice?: number;
  exitPipSize?: number;
  exitDigit?: number;
  exitEpoch?: number;
  payout?: number;
  profit?: number;
};

const DIGIT_OVER_UNDER_PROFIT_AT_ONE_USD: Record<number, number> = {
  1: 0.22,
  2: 0.38,
  3: 0.61,
  4: 0.91,
  5: 1.32,
  6: 2.11,
  7: 3.36,
  8: 7.21,
};

export function getFixedDigitOverUnderPayout(
  contractType: string,
  barrier: number | null,
  stake: number,
): number | null {
  if (!Number.isInteger(barrier) || barrier === null) return null;

  const profitBarrier = contractType === 'DIGITOVER'
    ? barrier
    : contractType === 'DIGITUNDER'
      ? 9 - barrier
      : null;

  if (profitBarrier === null) return null;
  const profitAtOneUsd = DIGIT_OVER_UNDER_PROFIT_AT_ONE_USD[profitBarrier];
  if (profitAtOneUsd === undefined) return null;

  return Number((stake * (1 + profitAtOneUsd)).toFixed(2));
}

export function contractWon(
  contractType: string,
  entryPrice: number,
  exitPrice: number,
  exitTick: MarketTick,
  barrier: number | null,
): boolean {
  switch (contractType) {
    case 'DIGITOVER':
      return barrier !== null && getLastDigit(exitTick) > barrier;
    case 'DIGITUNDER':
      return barrier !== null && getLastDigit(exitTick) < barrier;
    case 'DIGITEVEN':
      return getLastDigit(exitTick) % 2 === 0;
    case 'DIGITODD':
      return getLastDigit(exitTick) % 2 === 1;
    case 'DIGITMATCH':
      return barrier !== null && getLastDigit(exitTick) === barrier;
    case 'DIGITDIFF':
      return barrier !== null && getLastDigit(exitTick) !== barrier;
    case 'CALL':
      return exitPrice > entryPrice;
    case 'PUT':
      return exitPrice < entryPrice;
    default:
      return false;
  }
}

export function calculateStatistics(ticks: MarketTick[], matchDigit: number, overThreshold: number) {
  const digits = ticks.map(getLastDigit);
  const total = digits.length;
  const frequencies = Array.from({ length: 10 }, (_, digit) => digits.filter((value) => value === digit).length);
  const percentage = (count: number) => total ? (count / total) * 100 : null;
  const overCount = digits.filter((digit) => digit > overThreshold).length;
  const underCount = digits.filter((digit) => digit < overThreshold).length;
  const matchesCount = digits.filter((digit) => digit === matchDigit).length;

  return {
    total,
    frequencies,
    evenPercent: percentage(digits.filter((digit) => digit % 2 === 0).length),
    oddPercent: percentage(digits.filter((digit) => digit % 2 === 1).length),
    overPercent: percentage(overCount),
    underPercent: percentage(underCount),
    overCount,
    underCount,
    matchesCount,
    differsCount: total - matchesCount,
    matchPercent: percentage(matchesCount),
    differsPercent: percentage(total - matchesCount),
  };
}

export function mergeTicks(
  history: MarketTick[],
  live: MarketTick[],
  symbol: string,
  minimumEpoch = 0,
): MarketTick[] {
  const byEpoch = new Map<number, MarketTick>();
  for (const tick of [...history, ...live]) {
    if (tick.symbol === symbol && tick.epoch >= minimumEpoch) byEpoch.set(tick.epoch, tick);
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

export function mergeCandles(
  history: MarketCandle[],
  live: MarketTick[],
  symbol: string,
  granularity: number,
  minimumEpoch = 0,
): MarketCandle[] {
  const byEpoch = new Map<number, MarketCandle>();
  for (const candle of history) {
    if (candle.symbol === symbol) byEpoch.set(candle.epoch, candle);
  }

  for (const tick of live) {
    if (tick.symbol !== symbol || tick.epoch < minimumEpoch) continue;
    const epoch = Math.floor(tick.epoch / granularity) * granularity;
    const candle = byEpoch.get(epoch);
    byEpoch.set(epoch, candle
      ? {
          ...candle,
          high: Math.max(candle.high, tick.quote),
          low: Math.min(candle.low, tick.quote),
          close: tick.quote,
        }
      : {
          symbol,
          epoch,
          open: tick.quote,
          high: tick.quote,
          low: tick.quote,
          close: tick.quote,
          pipSize: tick.pipSize,
        });
  }

  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}
