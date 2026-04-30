// src/lib/trading/capitulationStrategy.ts
//
// Capitulation Reversion (long-only). Locked rules — see proposal:
//
//   1. Regime gate (daily): latest completed daily close > daily MA(50)
//   2. Trigger (1h bar T):  (close[T-1] - close[T]) > 2 * ATR(14, T-1)
//                            AND volume[T] > 2 * SMA(volume, 20)[T-1]
//   3. Confirmation:         close[T+1] > close[T]
//   4. Entry:                close of T+1
//   5. Initial stop:         low of T
//   6. Exit progression (handled by simulator via ExitPlan):
//        - at +1R unrealized -> stop = entry (breakeven)
//        - at +2R unrealized -> stop trails the prior bar's low
//        - 24-bar time stop regardless of P/L
//   7. No fixed profit target.
//
// All thresholds locked. No tunables. No CLI overrides.

import { buildSnapshot, type Candle, type Timeframe } from "./snapshotBuilder";
import type { ScanResult } from "./strategy";
import type { AssetSymbol, Confidence, ExitPlan, Recommendation } from "./types";

// =====================================================================
// Constants — locked per the strategy spec
// =====================================================================
const ATR_PERIOD = 14;
const VOLUME_LOOKBACK = 20;
const ATR_MULTIPLE_FOR_TRIGGER = 2;
const VOLUME_MULTIPLE_FOR_TRIGGER = 2;
const DAILY_MA_PERIOD = 50;
const TIME_STOP_BARS = 24;
const BE_PROMOTE_AT_R = 1;
const TRAIL_FROM_R = 2;
const DEFAULT_AMOUNT = 25;

// Cap the daily-aggregation work to a recent window. We need 50 completed
// daily bars; allow a buffer for partial days and any data gaps.
const DAILY_LOOKBACK_BUFFER_DAYS = 60;
const RECENT_H1_FOR_REGIME = DAILY_LOOKBACK_BUFFER_DAYS * 24;

// =====================================================================
// Public API
// =====================================================================

export type CapitulationParams = Record<string, never>; // intentionally empty — strategy is parameter-locked

export function evaluateCapitulation(
  candles: Candle[],
  symbol: AssetSymbol,
  timeframe: Timeframe,
  _params: CapitulationParams = {} as CapitulationParams,
):
  | ScanResult
  | { snapshot: null; recommendation: null; skipReasons: string[] } {
  if (timeframe !== "1h") {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Capitulation strategy is defined for 1h candles only (got ${timeframe})`],
    };
  }

  // Need at least: 50 completed daily bars (1200 H1) + ATR(14) + volume SMA(20) warmup + T-1, T, T+1.
  const minH1Bars = DAILY_MA_PERIOD * 24 + Math.max(ATR_PERIOD, VOLUME_LOOKBACK) + 3;
  if (!Array.isArray(candles) || candles.length < minH1Bars) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Not enough candles (need >= ${minH1Bars})`],
    };
  }

  // Bar indexing for the trigger triple:
  //   T-1 = candles[lastIdx - 2]
  //   T   = candles[lastIdx - 1]   (the trigger bar)
  //   T+1 = candles[lastIdx]       (the confirmation bar — entry candidate)
  const lastIdx = candles.length - 1;
  const triggerIdx = lastIdx - 1;
  const tMinus1Idx = triggerIdx - 1;
  if (tMinus1Idx < 0) {
    return { snapshot: null, recommendation: null, skipReasons: ["Need T-1, T, T+1 history"] };
  }
  const Tm1 = candles[tMinus1Idx];
  const T = candles[triggerIdx];
  const Tp1 = candles[lastIdx];

  // ----- Regime gate (daily MA50, only completed daily bars before T+1's UTC date) -----
  const currentDayKey = new Date(Tp1.timestamp).toISOString().slice(0, 10);
  const recentForRegime = candles.slice(-RECENT_H1_FOR_REGIME);
  const dailyAgg = aggregateToDaily(recentForRegime);
  const completedDays = dailyAgg.filter((d) => d.day < currentDayKey && d.bars >= 20);
  if (completedDays.length < DAILY_MA_PERIOD) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Need ${DAILY_MA_PERIOD}+ completed daily bars before T+1 (got ${completedDays.length})`],
    };
  }
  const last50Daily = completedDays.slice(-DAILY_MA_PERIOD);
  const dailyMa50 = last50Daily.reduce((a, d) => a + d.close, 0) / DAILY_MA_PERIOD;
  const lastDailyClose = completedDays[completedDays.length - 1].close;

  const reasons: string[] = [];

  if (lastDailyClose <= dailyMa50) {
    reasons.push(
      `Regime fail: latest daily close ${lastDailyClose.toFixed(2)} <= daily MA50 ${dailyMa50.toFixed(2)}`,
    );
  }

  // ----- Capitulation trigger on bar T -----
  // ATR(14) at index (triggerIdx - 1) = ATR ending at T-1, NOT including T.
  const atrSeries = rollingATR(candles.slice(0, triggerIdx), ATR_PERIOD);
  const atrAtTm1 = atrSeries[atrSeries.length - 1];

  // Volume SMA(20) ending at T-1, NOT including T.
  const priorVolBars = candles.slice(triggerIdx - VOLUME_LOOKBACK, triggerIdx);
  const volSmaAtTm1 =
    priorVolBars.length === VOLUME_LOOKBACK
      ? priorVolBars.reduce((a, c) => a + c.volume, 0) / VOLUME_LOOKBACK
      : NaN;

  const closeDrop = Tm1.close - T.close;
  const triggerDropMet = Number.isFinite(atrAtTm1) && atrAtTm1 > 0 && closeDrop > ATR_MULTIPLE_FOR_TRIGGER * atrAtTm1;
  const triggerVolMet = Number.isFinite(volSmaAtTm1) && volSmaAtTm1 > 0 && T.volume > VOLUME_MULTIPLE_FOR_TRIGGER * volSmaAtTm1;

  if (!triggerDropMet) {
    reasons.push(
      `No capitulation drop: close[T-1] - close[T] = ${closeDrop.toFixed(4)} <= ${ATR_MULTIPLE_FOR_TRIGGER}*ATR(14) = ${(ATR_MULTIPLE_FOR_TRIGGER * (atrAtTm1 || 0)).toFixed(4)}`,
    );
  }
  if (!triggerVolMet) {
    reasons.push(
      `No volume surge: volume[T] = ${T.volume.toFixed(2)} <= ${VOLUME_MULTIPLE_FOR_TRIGGER}*SMA(volume,20) = ${(VOLUME_MULTIPLE_FOR_TRIGGER * (volSmaAtTm1 || 0)).toFixed(2)}`,
    );
  }

  // ----- Confirmation on bar T+1 -----
  if (!(Tp1.close > T.close)) {
    reasons.push(`No confirmation: close[T+1] ${Tp1.close.toFixed(4)} <= close[T] ${T.close.toFixed(4)}`);
  }

  // Build snapshot for ScanResult shape compatibility (informational only).
  const snapshot = buildSnapshot(candles, symbol, timeframe);

  if (reasons.length > 0) {
    return { snapshot, recommendation: null, skipReasons: reasons };
  }

  // ----- Build recommendation -----
  const decimals = symbol === "BTC" ? 0 : 2;
  const entry = Tp1.close;
  const initialStop = T.low;
  if (initialStop >= entry) {
    return {
      snapshot,
      recommendation: null,
      skipReasons: [`Invalid geometry: T.low ${initialStop} >= entry ${entry}`],
    };
  }
  const R = entry - initialStop;
  const farTargetCap = entry + R * 10; // far cap; staged trail is the binding exit

  // Confidence: HIGH if BOTH the drop and volume conditions are met emphatically (>= 3x rather than 2x).
  const dropRatio = atrAtTm1 > 0 ? closeDrop / atrAtTm1 : 0;
  const volRatio = volSmaAtTm1 > 0 ? T.volume / volSmaAtTm1 : 0;
  const confidence: Confidence = dropRatio >= 3 && volRatio >= 3 ? "HIGH" : "MEDIUM";

  const exitPlan: ExitPlan = {
    mode: "staged-r-trail",
    bePromoteAtR: BE_PROMOTE_AT_R,
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
    riskRewardRatio: 2.0, // headline number; trailing exit determines actual realized R
    confidence,
    reasoning:
      `${symbol} capitulation reversion long. Trigger drop ${dropRatio.toFixed(2)}x ATR(14) ` +
      `with volume ${volRatio.toFixed(2)}x SMA(20). Daily close > daily MA50. ` +
      `Confirmation bar closed above trigger close.`,
    srNotes:
      `Daily MA50: ${dailyMa50.toFixed(decimals)} | latest daily close: ${lastDailyClose.toFixed(decimals)} | ` +
      `ATR(14)@T-1: ${atrAtTm1.toFixed(decimals)} | trigger drop: ${closeDrop.toFixed(decimals)} | ` +
      `vol SMA(20)@T-1: ${volSmaAtTm1.toFixed(2)} | trigger vol: ${T.volume.toFixed(2)}`,
    marketSummary:
      `Capitulation reversion (long). Initial stop below trigger low. ` +
      `BE promote at +${BE_PROMOTE_AT_R}R; prior-bar-low trail from +${TRAIL_FROM_R}R; ` +
      `${TIME_STOP_BARS}-bar time stop.`,
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
