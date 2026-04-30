// src/lib/trading/fundingStrategy.ts
//
// Funding-Rate Reversion (long-only). Locked rules — see proposal:
//
//   1. Funding source: OKX BTC-USDT-SWAP / ETH-USDT-SWAP perpetual funding rates
//      (Binance and Bybit are US-blocked; OKX is the working substitute with the
//       same 8-hour cycle and >0.9 historical correlation to Binance funding).
//   2. cum7d = sum of the most recent 21 funding rates (= 7 trading days).
//   3. Rolling distribution = cum7d at every funding event in the trailing
//      90 days (= 270 samples).
//   4. Trigger: at the close of the 1h candle that closes immediately AFTER
//      a funding settlement (close-time UTC hour ∈ {1, 9, 17}), if cum7d is
//      in the bottom 10 % of its trailing 90-day distribution.
//   5. Regime gate: latest completed daily close > daily MA(50).
//   6. Entry: at the close of that 1h candle.
//   7. Initial stop: entry − 2 × ATR(14, daily).
//   8. Exit (whichever fires first):
//        - 2R-trailing: from +2R, stop trails the prior bar's low.
//        - Funding-rate normalization: cum7d returns to >= 50th percentile of
//          its 90-day distribution at any subsequent post-funding 1h close.
//        - 72-bar time stop.
//        - Initial / trailing stop hit.
//   9. No fixed profit target.
//
// All thresholds locked. No tunables. No CLI overrides.

import { buildSnapshot, type Candle, type Timeframe } from "./snapshotBuilder";
import type { ScanResult } from "./strategy";
import type { AssetSymbol, Confidence, ExitPlan, Recommendation } from "./types";
import {
  type FundingContext,
  lastFundingIdxBefore,
  rollingPercentile,
} from "../../data/fundingRates";

// =====================================================================
// Constants — locked
// =====================================================================
const PERCENTILE_BOTTOM_THRESHOLD = 0.10; // bottom 10 %
const ROLLING_WINDOW_SAMPLES = 270;        // 90 days × 3 events/day
const MIN_WINDOW_SAMPLES = Math.floor(ROLLING_WINDOW_SAMPLES * 0.8);
const DAILY_MA_PERIOD = 50;
const ATR_PERIOD_DAILY = 14;
const ATR_MULT_FOR_STOP = 2;
const TIME_STOP_BARS = 72;
const TRAIL_FROM_R = 2;
const DEFAULT_AMOUNT = 25;

// Coinbase 1h candle timestamps are bar-OPEN times. The close happens 1h later.
// First 1h close after each 8h funding event sits at UTC hours 1, 9, 17.
const FUNDING_ALIGNED_CLOSE_HOURS = new Set<number>([1, 9, 17]);

const DAILY_LOOKBACK_BUFFER_DAYS = 60;
const RECENT_H1_FOR_DAILY = DAILY_LOOKBACK_BUFFER_DAYS * 24;

export type FundingStrategyParams = Record<string, never>; // strategy is parameter-locked

export type FundingEvaluateResult =
  | ScanResult
  | { snapshot: null; recommendation: null; skipReasons: string[] };

export function evaluateFunding(
  candles: Candle[],
  symbol: AssetSymbol,
  timeframe: Timeframe,
  funding: FundingContext,
  _params: FundingStrategyParams = {} as FundingStrategyParams,
): FundingEvaluateResult {
  if (timeframe !== "1h") {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Funding strategy is defined for 1h candles only (got ${timeframe})`],
    };
  }
  // Need MA50 daily (1200 H1) + ATR(14, daily) (336 H1 already inside) + some buffer.
  const minH1Bars = DAILY_MA_PERIOD * 24 + 50;
  if (!Array.isArray(candles) || candles.length < minH1Bars) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Not enough candles (need >= ${minH1Bars})`],
    };
  }

  const last = candles[candles.length - 1];
  const closeMs = last.timestamp + 60 * 60 * 1000;
  const closeUtcHour = new Date(closeMs).getUTCHours();
  if (!FUNDING_ALIGNED_CLOSE_HOURS.has(closeUtcHour)) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Bar close at ${closeUtcHour}:00 UTC is not post-funding (need 1, 9, or 17)`],
    };
  }

  // ----- Funding signal: cum7d in bottom 10 % of trailing 90-day distribution -----
  // Use the most recent funding event STRICTLY BEFORE the close — the one that
  // settled at the bar's open (closeMs - 1h).
  const fundingIdx = lastFundingIdxBefore(funding.events, closeMs);
  if (fundingIdx < 0) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`No funding events before ${new Date(closeMs).toISOString()}`],
    };
  }
  // Stale-data guard: the most recent funding event must be no more than one
  // funding cycle (8h) + 1h tolerance behind the bar close. Otherwise we're
  // evaluating against stale data (e.g. funding archive ends mid-test).
  const lastFundingTs = funding.events[fundingIdx].timestamp;
  const STALE_THRESHOLD_MS = 9 * 60 * 60 * 1000;
  if (closeMs - lastFundingTs > STALE_THRESHOLD_MS) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [
        `Stale funding data: last event ${new Date(lastFundingTs).toISOString()} is more than 9h before bar close ${new Date(closeMs).toISOString()}`,
      ],
    };
  }
  const cum7dNow = funding.cum7dSeries[fundingIdx];
  if (!Number.isFinite(cum7dNow)) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`cum7d not yet defined at funding idx ${fundingIdx} (warmup)`],
    };
  }

  const pctile = rollingPercentile(funding.cum7dSeries, fundingIdx, ROLLING_WINDOW_SAMPLES, MIN_WINDOW_SAMPLES);
  if (!pctile) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`90-day rolling window incomplete (need >= ${MIN_WINDOW_SAMPLES} samples)`],
    };
  }

  const reasons: string[] = [];
  // Snapshot for ScanResult shape compatibility.
  const snapshot = buildSnapshot(candles, symbol, timeframe);

  if (pctile.p > PERCENTILE_BOTTOM_THRESHOLD) {
    reasons.push(
      `cum7d percentile ${(pctile.p * 100).toFixed(1)}% > ${(PERCENTILE_BOTTOM_THRESHOLD * 100).toFixed(0)}% threshold (cum7d=${cum7dNow.toFixed(6)}, p10=${pctile.sortedAscending[Math.floor(pctile.sortedAscending.length * 0.1)].toFixed(6)})`,
    );
  }

  // ----- Regime gate: spot daily close > spot daily MA50 -----
  const recentForDaily = candles.slice(-RECENT_H1_FOR_DAILY);
  const dailyAgg = aggregateToDaily(recentForDaily);
  const currentDay = new Date(closeMs).toISOString().slice(0, 10);
  const completedDays = dailyAgg.filter((d) => d.day < currentDay && d.bars >= 20);
  if (completedDays.length < DAILY_MA_PERIOD) {
    reasons.push(
      `Need ${DAILY_MA_PERIOD}+ completed daily bars before T+1 (got ${completedDays.length})`,
    );
    return { snapshot, recommendation: null, skipReasons: reasons };
  }
  const last50Daily = completedDays.slice(-DAILY_MA_PERIOD);
  const dailyMa50 = last50Daily.reduce((a, d) => a + d.close, 0) / DAILY_MA_PERIOD;
  const lastDailyClose = completedDays[completedDays.length - 1].close;
  if (lastDailyClose <= dailyMa50) {
    reasons.push(
      `Regime fail: latest daily close ${lastDailyClose.toFixed(2)} <= daily MA50 ${dailyMa50.toFixed(2)}`,
    );
  }

  if (reasons.length > 0) {
    return { snapshot, recommendation: null, skipReasons: reasons };
  }

  // ----- Build recommendation -----
  // Daily ATR(14) for stop placement.
  const dailyAtrSeries = rollingATR(
    completedDays.map((d) => ({
      timestamp: d.timestamp,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume,
    })),
    ATR_PERIOD_DAILY,
  );
  const dailyAtr = dailyAtrSeries[dailyAtrSeries.length - 1];
  if (!Number.isFinite(dailyAtr) || dailyAtr <= 0) {
    return {
      snapshot,
      recommendation: null,
      skipReasons: [`Daily ATR(14) invalid (${dailyAtr})`],
    };
  }

  const decimals = symbol === "BTC" ? 0 : 2;
  const entry = last.close;
  const initialStop = entry - dailyAtr * ATR_MULT_FOR_STOP;
  if (initialStop >= entry || initialStop <= 0) {
    return {
      snapshot,
      recommendation: null,
      skipReasons: [`Invalid stop geometry: stop=${initialStop} entry=${entry}`],
    };
  }
  const R = entry - initialStop;
  const farTargetCap = entry + R * 10;

  const p5 = pctile.sortedAscending[Math.floor(pctile.sortedAscending.length * 0.05)];
  const p10 = pctile.sortedAscending[Math.floor(pctile.sortedAscending.length * 0.10)];
  const p50 = pctile.sortedAscending[Math.floor(pctile.sortedAscending.length * 0.50)];
  const confidence: Confidence = cum7dNow <= p5 ? "HIGH" : "MEDIUM";

  const exitPlan: ExitPlan = {
    mode: "funding-reversion",
    trailFromR: TRAIL_FROM_R,
    timeStopBars: TIME_STOP_BARS,
  };

  const rec: Recommendation = {
    id: cryptoId(),
    symbol,
    side: "BUY",
    amountUsd: DEFAULT_AMOUNT,
    entry: round(entry, decimals),
    stopLoss: round(initialStop, decimals),
    profitTarget: round(farTargetCap, decimals),
    invalidation: round(initialStop, decimals),
    riskRewardRatio: 2.0, // headline; trailing/funding-normalization is the binding exit
    confidence,
    reasoning:
      `${symbol} funding-rate reversion long. cum7d (sum of last 21 funding events): ` +
      `${(cum7dNow * 100).toFixed(4)}% — bottom ${(pctile.p * 100).toFixed(1)}% of trailing 90d distribution.`,
    srNotes:
      `cum7d: ${(cum7dNow * 100).toFixed(4)}% | p5: ${(p5 * 100).toFixed(4)}% | ` +
      `p10: ${(p10 * 100).toFixed(4)}% | p50: ${(p50 * 100).toFixed(4)}% | ` +
      `daily ATR(14): ${dailyAtr.toFixed(decimals)} | ` +
      `daily MA50: ${dailyMa50.toFixed(decimals)} | latest daily close: ${lastDailyClose.toFixed(decimals)}`,
    marketSummary:
      `Funding-rate reversion (long). Stop = entry − 2 × daily ATR. ` +
      `Trail from +${TRAIL_FROM_R}R; ${TIME_STOP_BARS}-bar time stop; ` +
      `funding-normalization exit when cum7d returns to >=50th pctile.`,
    createdAt: Date.now(),
    exitPlan,
  };

  return { snapshot, recommendation: rec, skipReasons: [] };
}

// =====================================================================
// Helpers
// =====================================================================

interface DailyBar {
  day: string;
  bars: number;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function aggregateToDaily(h1Candles: Candle[]): DailyBar[] {
  if (h1Candles.length === 0) return [];
  const groups = new Map<string, Candle[]>();
  for (const c of h1Candles) {
    const day = new Date(c.timestamp).toISOString().slice(0, 10);
    let bucket = groups.get(day);
    if (!bucket) {
      bucket = [];
      groups.set(day, bucket);
    }
    bucket.push(c);
  }
  const sortedDays = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  return sortedDays.map(([day, hours]) => {
    const sorted = hours.slice().sort((a, b) => a.timestamp - b.timestamp);
    return {
      day,
      bars: sorted.length,
      timestamp: sorted[0].timestamp,
      open: sorted[0].open,
      high: Math.max(...sorted.map((h) => h.high)),
      low: Math.min(...sorted.map((h) => h.low)),
      close: sorted[sorted.length - 1].close,
      volume: sorted.reduce((a, c) => a + c.volume, 0),
    };
  });
}

function trueRange(curr: Candle, prev: Candle | undefined): number {
  const hl = curr.high - curr.low;
  if (!prev) return hl;
  return Math.max(hl, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
}

function rollingATR(candles: Candle[], period: number): number[] {
  const trs = candles.map((c, i) => trueRange(c, candles[i - 1]));
  const out: number[] = [];
  let runningSum = 0;
  for (let i = 0; i < trs.length; i++) {
    runningSum += trs[i];
    if (i + 1 < period) { out.push(NaN); continue; }
    if (i + 1 > period) runningSum -= trs[i - period];
    out.push(runningSum / period);
  }
  return out;
}

function round(n: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}
