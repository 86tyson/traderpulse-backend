// src/lib/trading/snapshotBuilder.ts
//
// Pure deterministic builder: candles -> MarketSnapshot.
// Consumed by evaluateMarket() in strategy.ts. No randomness, no I/O, no mocks.
//
// All discretionary rules (S/R derivation, trend classification, volatility
// banding, volume banding) are isolated as named constants in the "Conventions"
// block below. Tune in one place; do not scatter rule changes across the file.

import type {
  AssetSymbol,
  MarketCondition,
  MarketSnapshot,
  Quality,
  TrendStatus,
} from "./types";

// =====================================================================
// Conventions — tuning surface
// =====================================================================

/** Lookback for `recentHigh` / `pullbackPct`. The strategy filter is `pullbackPct >= 3`,
 *  so this window defines what "recent" means. */
const RECENT_HIGH_LOOKBACK = 20;

/** The strategy explicitly references the 50-period MA. Do not change. */
const MA_PERIOD = 50;

// ---- Trend classification ----
// TODO: tune slope window or replace with a different trend rule (ADX, structure-based, etc.).
//   UPTREND   = close > ma50  AND  ma50 has risen over the last TREND_SLOPE_LOOKBACK bars
//   DOWNTREND = close < ma50  AND  ma50 has fallen over that span
//   SIDEWAYS  = otherwise
const TREND_SLOPE_LOOKBACK = 20;

// ---- Volatility classification (ATR percentile) ----
// TODO: tune ATR period or quantile thresholds.
//   STRONG = ATR(14) is in the top tier of the recent window
//   OK     = mid tier
//   WEAK   = bottom tier
const ATR_PERIOD = 14;
const VOLATILITY_PERCENTILE_LOOKBACK = 100;
const VOLATILITY_LOWER_QUANTILE = 0.33;
const VOLATILITY_UPPER_QUANTILE = 0.67;

// ---- Volume classification ----
// TODO: tune VOLUME_AVG_PERIOD and ratios; crypto volume is noisy.
//   STRONG = currentVol > VOLUME_STRONG_RATIO * SMA(volume, VOLUME_AVG_PERIOD)
//   WEAK   = currentVol < VOLUME_WEAK_RATIO   * SMA(volume, VOLUME_AVG_PERIOD)
//   OK     = otherwise
const VOLUME_AVG_PERIOD = 20;
const VOLUME_STRONG_RATIO = 1.5;
const VOLUME_WEAK_RATIO   = 0.7;

// ---- Support / Resistance derivation ----
// TODO: replace with a different S/R model (volume profile, round numbers,
// multi-timeframe levels) if the pivot rule proves too noisy.
//   support    = most recent confirmed swing low  in the last SR_LOOKBACK bars
//   resistance = most recent confirmed swing high in the last SR_LOOKBACK bars
//   A swing low is a bar whose `low` is strictly less than the lows of the
//   SWING_PIVOT_BARS bars on each side. Symmetric for swing high.
//   Fallback: min(low) / max(high) over SR_LOOKBACK if no pivot is found.
const SWING_PIVOT_BARS = 3;
const SR_LOOKBACK = 50;

// =====================================================================
// Types
// =====================================================================

export interface Candle {
  timestamp: number;        // unix ms — only the ordering is load-bearing
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d";

const BARS_PER_DAY: Record<Timeframe, number> = {
  "5m":  288,
  "15m": 96,
  "1h":  24,
  "4h":  6,
  "1d":  1,
};

// =====================================================================
// Public API
// =====================================================================

/**
 * Build a MarketSnapshot from a chronologically-ordered candle series.
 *
 * @param candles    Oldest first. Must contain at least MA_PERIOD bars.
 * @param symbol     Used only for rounding precision in the snapshot output.
 * @param timeframe  Used only to compute change24h (count of bars in 24h).
 *
 * Throws if there are fewer than MA_PERIOD candles. Never returns null —
 * skip-reason logic lives in evaluateMarket(), not here.
 */
export function buildSnapshot(
  candles: Candle[],
  symbol: AssetSymbol,
  timeframe: Timeframe,
): MarketSnapshot {
  if (!Array.isArray(candles) || candles.length < MA_PERIOD) {
    throw new Error(
      `snapshotBuilder: need at least ${MA_PERIOD} candles, got ${candles?.length ?? 0}`,
    );
  }

  const last = candles[candles.length - 1];
  const price = last.close;

  const ma50 = sma(candles.slice(-MA_PERIOD).map(c => c.close));

  const recentSlice = candles.slice(-RECENT_HIGH_LOOKBACK);
  const recentHigh  = Math.max(...recentSlice.map(c => c.high));
  const pullbackPct = recentHigh > 0 ? ((recentHigh - price) / recentHigh) * 100 : 0;

  const barsBack  = BARS_PER_DAY[timeframe];
  const refIdx    = Math.max(0, candles.length - 1 - barsBack);
  const refClose  = candles[refIdx].close;
  const change24h = refClose > 0 ? ((price - refClose) / refClose) * 100 : 0;

  const srSlice    = candles.slice(-SR_LOOKBACK);
  const support    = mostRecentSwingLow(srSlice)  ?? Math.min(...srSlice.map(c => c.low));
  const resistance = mostRecentSwingHigh(srSlice) ?? Math.max(...srSlice.map(c => c.high));

  const trend      = classifyTrend(candles, ma50);
  const volatility = classifyVolatility(candles);
  const volume     = classifyVolume(candles);

  // Composite condition mirrors the cascade in mockData.ts's default branch.
  const condition: MarketCondition =
    trend === "SIDEWAYS"  ? "CHOPPY"         :
    volume === "WEAK"     ? "LOW_VOLUME"     :
    volatility === "WEAK" ? "LOW_VOLATILITY" :
                            "FAVORABLE";

  const r = (n: number) => round(n, symbol === "BTC" ? 0 : 2);

  return {
    symbol,
    price:       r(price),
    change24h:   round(change24h, 2),
    ma50:        r(ma50),
    recentHigh:  r(recentHigh),
    support:     r(support),
    resistance:  r(resistance),
    trend,
    volatility,
    volume,
    condition,
    pullbackPct: round(pullbackPct, 2),
  };
}

// =====================================================================
// Helpers (no exports — intentionally private to this module)
// =====================================================================

function sma(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
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

function classifyTrend(candles: Candle[], ma50Now: number): TrendStatus {
  const close = candles[candles.length - 1].close;

  // Rolling MA50 series so we can read its slope (now vs N bars ago).
  const closes = candles.map(c => c.close);
  const series: number[] = [];
  let runningSum = 0;
  for (let i = 0; i < closes.length; i++) {
    runningSum += closes[i];
    if (i + 1 < MA_PERIOD) { series.push(NaN); continue; }
    if (i + 1 > MA_PERIOD) runningSum -= closes[i - MA_PERIOD];
    series.push(runningSum / MA_PERIOD);
  }

  const idxNow  = series.length - 1;
  const idxThen = idxNow - TREND_SLOPE_LOOKBACK;
  if (idxThen < 0 || Number.isNaN(series[idxThen])) {
    // Not enough history for slope — fall back to position vs MA only.
    if (close > ma50Now) return "UPTREND";
    if (close < ma50Now) return "DOWNTREND";
    return "SIDEWAYS";
  }

  const slope = series[idxNow] - series[idxThen];
  if (close > ma50Now && slope > 0) return "UPTREND";
  if (close < ma50Now && slope < 0) return "DOWNTREND";
  return "SIDEWAYS";
}

function classifyVolatility(candles: Candle[]): Quality {
  const atrSeries = rollingATR(candles, ATR_PERIOD);
  const atrNow = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(atrNow)) return "OK";

  const window = atrSeries.slice(-VOLATILITY_PERCENTILE_LOOKBACK).filter(Number.isFinite) as number[];
  if (window.length < 5) return "OK";
  const sorted = [...window].sort((a, b) => a - b);
  const lower = sorted[Math.floor((sorted.length - 1) * VOLATILITY_LOWER_QUANTILE)];
  const upper = sorted[Math.floor((sorted.length - 1) * VOLATILITY_UPPER_QUANTILE)];
  if (atrNow >= upper) return "STRONG";
  if (atrNow <= lower) return "WEAK";
  return "OK";
}

function classifyVolume(candles: Candle[]): Quality {
  const recent = candles.slice(-VOLUME_AVG_PERIOD);
  const volNow = recent[recent.length - 1].volume;
  const avg = sma(recent.map(c => c.volume));
  if (!Number.isFinite(avg) || avg <= 0) return "OK";
  const ratio = volNow / avg;
  if (ratio >= VOLUME_STRONG_RATIO) return "STRONG";
  if (ratio <= VOLUME_WEAK_RATIO)   return "WEAK";
  return "OK";
}

function mostRecentSwingLow(candles: Candle[]): number | null {
  const N = SWING_PIVOT_BARS;
  for (let i = candles.length - 1 - N; i >= N; i--) {
    const c = candles[i];
    let isPivot = true;
    for (let k = 1; k <= N && isPivot; k++) {
      if (candles[i - k].low <= c.low || candles[i + k].low <= c.low) isPivot = false;
    }
    if (isPivot) return c.low;
  }
  return null;
}

function mostRecentSwingHigh(candles: Candle[]): number | null {
  const N = SWING_PIVOT_BARS;
  for (let i = candles.length - 1 - N; i >= N; i--) {
    const c = candles[i];
    let isPivot = true;
    for (let k = 1; k <= N && isPivot; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high >= c.high) isPivot = false;
    }
    if (isPivot) return c.high;
  }
  return null;
}

function round(n: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
