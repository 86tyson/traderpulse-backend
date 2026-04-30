// src/lib/trading/fundingCompressionStrategy.ts
//
// Funding-Regime Compression Breakout (long-only). Locked rules:
//
//   1. Funding regime filter: at the post-funding 1h close, cum7d (sum of last
//      21 funding rates) is in the bottom 10th percentile of the trailing
//      90-day cum7d distribution. (Identical metric / threshold to the prior
//      funding strategy.)
//   2. Compression bar T (1h): T's range (high - low) is strictly less than
//      every range in the window T-6 .. T-1 (NR7 — Crabel-canonical).
//   3. Breakout confirmation: close[T+1] > high[T].
//   4. Spot regime gate: latest completed daily close > daily MA(50).
//   5. Entry: at the close of T+1.
//   6. Exit (delegated to simulator's staged-r-trail mode):
//        - initial stop = low of T
//        - BE at +1R, prior-bar-low trail at +2R
//        - 48-bar time stop
//        - no fixed profit target
//
// Ablation: passing { useFundingFilter: false } drops only the funding filter.
// Compression + breakout + regime gate + exits are unchanged. This is gate 5.
//
// All thresholds locked. No tunables. No CLI overrides on the locked rules.

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
const NR_WINDOW = 7;
const PERCENTILE_BOTTOM_THRESHOLD = 0.10;
const ROLLING_WINDOW_SAMPLES = 270;
const MIN_WINDOW_SAMPLES = Math.floor(ROLLING_WINDOW_SAMPLES * 0.8);
const STALE_FUNDING_THRESHOLD_MS = 9 * 60 * 60 * 1000;
const DAILY_MA_PERIOD = 50;
const DEFAULT_AMOUNT = 25;

const TIME_STOP_BARS = 48;
const BE_PROMOTE_AT_R = 1;
const TRAIL_FROM_R = 2;

const DAILY_LOOKBACK_BUFFER_DAYS = 60;

// Bars-per-day for supported timeframes. The strategy's RULES are timeframe-
// agnostic (NR7, breakout above bar T's high, daily-MA50 regime, staged-r-trail
// exits) — only the conversion between bar count and "one day" depends on
// timeframe. The 48-bar time stop is bar-count, not time-based, so its
// realised duration scales with timeframe (48 4h bars = 8 days; 48 1d = 48 days).
const BARS_PER_DAY: Record<Timeframe, number> = {
  "5m":  288,
  "15m": 96,
  "1h":  24,
  "4h":  6,
  "1d":  1,
};
// Per-timeframe minimum bar count to consider a daily bucket "complete enough"
// for use in the MA50 calculation. Tolerates a small number of missing bars
// for data with gaps.
const MIN_BARS_PER_DAY: Record<Timeframe, number> = {
  "5m":  240,  // 288 expected, allow ~83% completeness
  "15m": 80,   // 96 expected
  "1h":  20,   // 24 expected
  "4h":  5,    // 6 expected
  "1d":  1,    // 1 expected (each candle IS one day)
};

// =====================================================================
// Public API
// =====================================================================

export interface FundingCompressionParams {
  /** When false, run the ablation variant: skip the funding filter only.
   *  Compression + breakout + regime gate + exits remain unchanged. */
  useFundingFilter?: boolean;
  /** Override individual ExitPlan fields. Used by the exit-structure study —
   *  ENTRY rules are unchanged. Each field, if provided, overrides the locked
   *  default. Pass `bePromoteAtR: undefined` (i.e. `null` from CLI) to disable
   *  the BE step; same for `timeStopBars`. */
  exitOverrides?: {
    mode?: "staged-r-trail" | "staged-r-trail-partial";
    bePromoteAtR?: number | null;
    trailFromR?: number;
    timeStopBars?: number | null;
    partialExitAtR?: number;
    partialExitFraction?: number;
  };
}

export type FundingCompressionResult =
  | ScanResult
  | { snapshot: null; recommendation: null; skipReasons: string[] };

export function evaluateFundingCompression(
  candles: Candle[],
  symbol: AssetSymbol,
  timeframe: Timeframe,
  funding: FundingContext | null,
  params: FundingCompressionParams = {},
): FundingCompressionResult {
  const useFundingFilter = params.useFundingFilter !== false;

  if (timeframe !== "1h" && timeframe !== "4h" && timeframe !== "1d") {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Funding-compression strategy supports 1h, 4h, or 1d (got ${timeframe})`],
    };
  }
  if (useFundingFilter && timeframe !== "1h") {
    // The 8-hour funding-cycle alignment is only meaningful at 1h; on 4h or 1d
    // the bar timestamps don't line up with funding settlements. Refuse rather
    // than silently degrading.
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [
        `Funding filter requires 1h timeframe (8-hour cycle alignment); got ${timeframe}. ` +
        `Pass --disable-funding-filter to run the ablation variant on this timeframe.`,
      ],
    };
  }

  const barsPerDay = BARS_PER_DAY[timeframe];
  const minBarsPerDay = MIN_BARS_PER_DAY[timeframe];
  const recentBarsForDaily = DAILY_LOOKBACK_BUFFER_DAYS * barsPerDay;

  // Need DAILY_MA_PERIOD complete daily buckets plus NR window plus buffer.
  const minBarsRequired = DAILY_MA_PERIOD * barsPerDay + NR_WINDOW + 5;
  if (!Array.isArray(candles) || candles.length < minBarsRequired) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Not enough candles (need >= ${minBarsRequired} on ${timeframe})`],
    };
  }

  // T+1 = the most recent candle (the breakout candidate).
  // T = the bar before it (NR7 candidate).
  const lastIdx = candles.length - 1;
  const tIdx = lastIdx - 1;
  const compressionStart = tIdx - (NR_WINDOW - 1);
  if (compressionStart < 0) {
    return { snapshot: null, recommendation: null, skipReasons: ["Not enough history for NR7 window"] };
  }

  const T = candles[tIdx];
  const Tp1 = candles[lastIdx];

  const reasons: string[] = [];

  // ----- Compression: T's range strictly < each of T-1..T-6 ranges -----
  const tRange = T.high - T.low;
  let isNr7 = true;
  let failedAt = -1;
  for (let k = 1; k < NR_WINDOW; k++) {
    const otherRange = candles[tIdx - k].high - candles[tIdx - k].low;
    if (!(tRange < otherRange)) {
      isNr7 = false;
      failedAt = k;
      break;
    }
  }
  if (!isNr7) {
    reasons.push(
      `Bar T not NR${NR_WINDOW}: range ${tRange.toFixed(4)} not strictly < range[T-${failedAt}] (${
        (candles[tIdx - failedAt].high - candles[tIdx - failedAt].low).toFixed(4)
      })`,
    );
  }

  // ----- Breakout: close[T+1] > high[T] -----
  if (!(Tp1.close > T.high)) {
    reasons.push(`No breakout: close[T+1] ${Tp1.close} <= high[T] ${T.high}`);
  }

  // Snapshot for ScanResult shape compatibility (informational only).
  const snapshot = buildSnapshot(candles, symbol, timeframe);

  // Short-circuit on compression/breakout failures (cheap checks first).
  if (reasons.length > 0) {
    return { snapshot, recommendation: null, skipReasons: reasons };
  }

  // ----- Funding regime filter (skipped in ablation) -----
  let cum7dInfo:
    | {
        cum7dNow: number;
        p10: number;
        p50: number;
        percentile: number;
      }
    | null = null;

  if (useFundingFilter) {
    if (!funding) {
      return {
        snapshot,
        recommendation: null,
        skipReasons: ["useFundingFilter=true but no funding context provided to strategy"],
      };
    }
    const closeMs = Tp1.timestamp + 60 * 60 * 1000;
    const fundingIdx = lastFundingIdxBefore(funding.events, closeMs);
    if (fundingIdx < 0) {
      return {
        snapshot,
        recommendation: null,
        skipReasons: [`No funding events before ${new Date(closeMs).toISOString()}`],
      };
    }
    const lastFundingTs = funding.events[fundingIdx].timestamp;
    if (closeMs - lastFundingTs > STALE_FUNDING_THRESHOLD_MS) {
      return {
        snapshot,
        recommendation: null,
        skipReasons: [
          `Stale funding data: last event ${new Date(lastFundingTs).toISOString()} is more than 9h before bar close ${new Date(closeMs).toISOString()}`,
        ],
      };
    }
    const cum7dNow = funding.cum7dSeries[fundingIdx];
    if (!Number.isFinite(cum7dNow)) {
      return {
        snapshot,
        recommendation: null,
        skipReasons: [`cum7d not yet defined at funding idx ${fundingIdx} (warmup)`],
      };
    }
    const pctile = rollingPercentile(funding.cum7dSeries, fundingIdx, ROLLING_WINDOW_SAMPLES, MIN_WINDOW_SAMPLES);
    if (!pctile) {
      return {
        snapshot,
        recommendation: null,
        skipReasons: [`90-day rolling window incomplete (need >= ${MIN_WINDOW_SAMPLES} samples)`],
      };
    }
    if (pctile.p > PERCENTILE_BOTTOM_THRESHOLD) {
      return {
        snapshot,
        recommendation: null,
        skipReasons: [
          `Funding not in regime: cum7d percentile ${(pctile.p * 100).toFixed(1)}% > ${(PERCENTILE_BOTTOM_THRESHOLD * 100).toFixed(0)}% threshold`,
        ],
      };
    }
    const p10 = pctile.sortedAscending[Math.floor(pctile.sortedAscending.length * 0.10)];
    const p50 = pctile.sortedAscending[Math.floor(pctile.sortedAscending.length * 0.50)];
    cum7dInfo = { cum7dNow, p10, p50, percentile: pctile.p };
  }

  // ----- Spot regime gate: daily close > daily MA50 -----
  const recentForDaily = candles.slice(-recentBarsForDaily);
  const dailyAgg = aggregateToDaily(recentForDaily);
  const currentDayKey = new Date(Tp1.timestamp).toISOString().slice(0, 10);
  const completedDays = dailyAgg.filter((d) => d.day < currentDayKey && d.bars >= minBarsPerDay);
  if (completedDays.length < DAILY_MA_PERIOD) {
    return {
      snapshot,
      recommendation: null,
      skipReasons: [`Need ${DAILY_MA_PERIOD}+ completed daily bars before T+1 (got ${completedDays.length})`],
    };
  }
  const last50Daily = completedDays.slice(-DAILY_MA_PERIOD);
  const dailyMa50 = last50Daily.reduce((a, d) => a + d.close, 0) / DAILY_MA_PERIOD;
  const lastDailyClose = completedDays[completedDays.length - 1].close;
  if (lastDailyClose <= dailyMa50) {
    return {
      snapshot,
      recommendation: null,
      skipReasons: [
        `Regime fail: latest daily close ${lastDailyClose.toFixed(2)} <= daily MA50 ${dailyMa50.toFixed(2)}`,
      ],
    };
  }

  // ----- Build recommendation -----
  const decimals = symbol === "BTC" ? 0 : 2;
  const entry = Tp1.close;
  const initialStop = T.low;
  if (initialStop >= entry || initialStop <= 0) {
    return {
      snapshot,
      recommendation: null,
      skipReasons: [`Invalid stop geometry: stop=${initialStop} entry=${entry}`],
    };
  }
  const R = entry - initialStop;
  const farTargetCap = entry + R * 10;

  // Confidence: HIGH iff (a) funding filter is on AND cum7d is in bottom 5%
  // (more extreme tail), MEDIUM otherwise. In ablation this collapses to MEDIUM.
  let confidence: Confidence = "MEDIUM";
  if (useFundingFilter && cum7dInfo) {
    const fiveP = funding!.cum7dSeries; // narrowed by check above
    void fiveP;
    if (cum7dInfo.percentile <= 0.05) confidence = "HIGH";
  }

  // Locked-default exit plan. Overrides apply only via params.exitOverrides
  // (used by the exit-structure study). Entry rules are unaffected.
  const ov = params.exitOverrides;
  const exitPlan: ExitPlan = {
    mode: ov?.mode ?? "staged-r-trail",
    // Use `in` checks so an explicit `null` from CLI parsing means "drop this step".
    bePromoteAtR: ov && "bePromoteAtR" in ov
      ? (ov.bePromoteAtR ?? undefined)
      : BE_PROMOTE_AT_R,
    trailFromR: ov?.trailFromR ?? TRAIL_FROM_R,
    timeStopBars: ov && "timeStopBars" in ov
      ? (ov.timeStopBars ?? undefined)
      : TIME_STOP_BARS,
    partialExitAtR: ov?.partialExitAtR,
    partialExitFraction: ov?.partialExitFraction,
  };

  const reasoning = useFundingFilter && cum7dInfo
    ? `${symbol} NR${NR_WINDOW} compression breakout in crowded-shorts regime. ` +
      `cum7d ${(cum7dInfo.cum7dNow * 100).toFixed(4)}% (bottom ${(cum7dInfo.percentile * 100).toFixed(1)}% ` +
      `of trailing 90d). Daily close > MA50.`
    : `${symbol} NR${NR_WINDOW} compression breakout (ablation: funding filter disabled). ` +
      `Daily close > MA50.`;

  const srNotes = cum7dInfo
    ? `cum7d: ${(cum7dInfo.cum7dNow * 100).toFixed(4)}% | p10: ${(cum7dInfo.p10 * 100).toFixed(4)}% | ` +
      `p50: ${(cum7dInfo.p50 * 100).toFixed(4)}% | T.low: ${T.low.toFixed(decimals)} | ` +
      `T.high: ${T.high.toFixed(decimals)} | T range: ${(T.high - T.low).toFixed(decimals)} | ` +
      `daily MA50: ${dailyMa50.toFixed(decimals)}`
    : `T.low: ${T.low.toFixed(decimals)} | T.high: ${T.high.toFixed(decimals)} | ` +
      `T range: ${(T.high - T.low).toFixed(decimals)} | daily MA50: ${dailyMa50.toFixed(decimals)}`;

  const rec: Recommendation = {
    id: cryptoId(),
    symbol,
    side: "BUY",
    amountUsd: DEFAULT_AMOUNT,
    entry: round(entry, decimals),
    stopLoss: round(initialStop, decimals),
    profitTarget: round(farTargetCap, decimals),
    invalidation: round(initialStop, decimals),
    riskRewardRatio: 2.0, // headline; staged-r-trail is the binding exit
    confidence,
    reasoning,
    srNotes,
    marketSummary:
      `Funding-regime compression breakout (long). Stop = low of NR${NR_WINDOW} bar. ` +
      `BE at +${BE_PROMOTE_AT_R}R; prior-bar-low trail from +${TRAIL_FROM_R}R; ` +
      `${TIME_STOP_BARS}-bar time stop.`,
    createdAt: Date.now(),
    exitPlan,
  };

  return { snapshot, recommendation: rec, skipReasons: [] };
}

// =====================================================================
// Helpers (duplicated from capitulationStrategy / fundingStrategy for module isolation)
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

function round(n: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}
