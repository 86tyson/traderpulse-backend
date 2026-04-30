// src/lib/trading/momentumStrategy.ts
//
// Momentum breakout strategy. LONG-only.
//
// Entry conditions (ALL must hold):
//   1. close > MA50
//   2. MA50 has risen over the last SLOPE_LOOKBACK bars (positive slope)
//   3. close > the highest high of the prior BREAKOUT_LOOKBACK bars (the breakout)
//   4. current bar volume > SMA(volume, VOLUME_LOOKBACK)
//
// Stop:
//   entry - ATR(ATR_PERIOD) * ATR_MULTIPLIER  (initial)
//
// Exit (preferred): trailing ATR stop, ratcheted by the simulator each bar via
//   stop = max(stop, close - ATR * ATR_MULTIPLIER)
//   The simulator reads `exitPlan: { mode: "trailing-atr", atrMultiplier }` on
//   the recommendation. profitTarget is set to a far-out cap (10R) so trailing
//   is the binding exit in nearly all cases.
//
// No fixed % stops/targets, no support/resistance derivation, no pullback rules.
// Snapshot is reused for ScanResult shape compatibility but not consulted —
// momentum reads the candle array directly to compute its own indicators.

import { buildSnapshot, type Candle, type Timeframe } from "./snapshotBuilder";
import type { ScanResult } from "./strategy";
import type { AssetSymbol, Confidence, ExitPlan, Recommendation } from "./types";

// =====================================================================
// Conventions — tuning surface
// =====================================================================

const MA_PERIOD = 50;                 // matches Lovable strategy's "50-period MA"
const SLOPE_LOOKBACK = 10;            // bars used to determine MA50 slope
const BREAKOUT_LOOKBACK = 20;         // N-bar high
const VOLUME_LOOKBACK = 20;
const ATR_PERIOD = 14;
const ATR_MULTIPLIER = 1.5;
const TARGET_R_CAP = 10;              // far-out target so trailing stop is the actual exit
const DEFAULT_AMOUNT = 25;            // $ per trade, matches existing strategy

export interface MomentumParams {
  breakoutLookback?: number;
  atrMultiplier?: number;
  slopeLookback?: number;
  volumeLookback?: number;
}

// =====================================================================
// Public API
// =====================================================================

export function evaluateMomentum(
  candles: Candle[],
  symbol: AssetSymbol,
  timeframe: Timeframe,
  params: MomentumParams = {},
): ScanResult | { snapshot: null; recommendation: null; skipReasons: string[] } {
  const breakoutLookback = params.breakoutLookback ?? BREAKOUT_LOOKBACK;
  const atrMultiplier = params.atrMultiplier ?? ATR_MULTIPLIER;
  const slopeLookback = params.slopeLookback ?? SLOPE_LOOKBACK;
  const volumeLookback = params.volumeLookback ?? VOLUME_LOOKBACK;

  // Need enough bars for MA50, slope lookback, breakout window, ATR, volume.
  const minBars = Math.max(MA_PERIOD + slopeLookback, breakoutLookback + 1, ATR_PERIOD + 1, volumeLookback + 1);
  if (!Array.isArray(candles) || candles.length < minBars) {
    return {
      snapshot: null,
      recommendation: null,
      skipReasons: [`Not enough candles (need >= ${minBars})`],
    };
  }

  const last = candles[candles.length - 1];
  const price = last.close;

  // ---- Indicators (computed directly from candles) ----
  const closes = candles.map((c) => c.close);
  const ma50Now = sma(closes.slice(-MA_PERIOD));
  const ma50Then = sma(closes.slice(-MA_PERIOD - slopeLookback, -slopeLookback));
  const slopeAbsolute = ma50Now - ma50Then;
  const slopePct = ma50Then > 0 ? (slopeAbsolute / ma50Then) * 100 : 0;

  // Prior N-bar high — explicitly EXCLUDES the current bar.
  const priorN = candles.slice(-(breakoutLookback + 1), -1);
  const priorHigh = Math.max(...priorN.map((c) => c.high));

  // Volume average — also excludes current bar so we compare apples to history.
  const priorV = candles.slice(-(volumeLookback + 1), -1);
  const avgVolume = priorV.reduce((a, c) => a + c.volume, 0) / priorV.length;
  const volRatio = avgVolume > 0 ? last.volume / avgVolume : 0;

  // ATR(14)
  const atrSeries = rollingATR(candles, ATR_PERIOD);
  const atrNow = atrSeries[atrSeries.length - 1];
  const atrPriorAvg = sma(atrSeries.slice(-ATR_PERIOD - 1, -1).filter(Number.isFinite));
  const atrExpanding = Number.isFinite(atrNow) && Number.isFinite(atrPriorAvg) && atrNow > atrPriorAvg;

  // Build a snapshot for ScanResult shape compatibility (consumers may want it).
  // The momentum strategy does not read any of its derived bucket fields.
  const snapshot = buildSnapshot(candles, symbol, timeframe);

  // ---- Filter checks ----
  const reasons: string[] = [];
  const aboveMA = price > ma50Now;
  const slopePositive = slopeAbsolute > 0;
  const breakout = price > priorHigh;
  const volumeAboveAvg = last.volume > avgVolume;

  if (!aboveMA) {
    reasons.push(`Price ${fmt(price, symbol)} not above MA50 ${fmt(ma50Now, symbol)}`);
  }
  if (!slopePositive) {
    reasons.push(`MA50 slope not positive (${slopePct.toFixed(2)}% over last ${slopeLookback} bars)`);
  }
  if (!breakout) {
    reasons.push(
      `No breakout: close ${fmt(price, symbol)} <= prior ${breakoutLookback}-bar high ${fmt(priorHigh, symbol)}`,
    );
  }
  if (!volumeAboveAvg) {
    reasons.push(`Volume ${last.volume.toFixed(2)} not above ${volumeLookback}-bar avg ${avgVolume.toFixed(2)}`);
  }

  if (reasons.length > 0) {
    return { snapshot, recommendation: null, skipReasons: reasons };
  }

  if (!Number.isFinite(atrNow) || atrNow <= 0) {
    return {
      snapshot,
      recommendation: null,
      skipReasons: [`ATR(${ATR_PERIOD}) is not yet valid (got ${atrNow})`],
    };
  }

  // ---- Stop, target, R ----
  const initialStop = price - atrNow * atrMultiplier;
  const riskUsd = price - initialStop; // > 0 by construction (atrNow > 0)
  const targetCap = price + riskUsd * TARGET_R_CAP;
  const decimals = symbol === "BTC" ? 0 : 2;

  // ---- Confidence (0-4 score) ----
  let score = 0;
  // Strong breakout: >1% above prior N-bar high
  const breakoutMagnitude = (price - priorHigh) / priorHigh;
  if (breakoutMagnitude >= 0.01) score += 1;
  // Volume surge: 1.5x+ avg
  if (volRatio >= 1.5) score += 1;
  // Volatility expansion: ATR rising
  if (atrExpanding) score += 1;
  // Strong trend: MA50 has risen at least 1% over the slope window
  if (slopePct >= 1) score += 1;

  let confidence: Confidence = "MEDIUM";
  if (score >= 3) confidence = "HIGH";

  const exitPlan: ExitPlan = { mode: "trailing-atr", atrMultiplier };

  const rec: Recommendation = {
    id: cryptoId(),
    symbol,
    side: "BUY",
    amountUsd: DEFAULT_AMOUNT,
    entry: round(price, decimals),
    stopLoss: round(initialStop, decimals),
    profitTarget: round(targetCap, decimals),
    invalidation: round(priorHigh, decimals), // breakout level — if revisited, breakout failed
    riskRewardRatio: 2.0,                      // minimum target — trailing may exit higher
    confidence,
    reasoning:
      `${symbol} broke above its ${breakoutLookback}-bar high (${fmt(priorHigh, symbol)}) ` +
      `with volume ${volRatio.toFixed(2)}x average on a rising 50-MA ` +
      `(slope +${slopePct.toFixed(2)}% over ${slopeLookback} bars).`,
    srNotes:
      `Breakout: ${fmt(priorHigh, symbol)} | ` +
      `ATR(${ATR_PERIOD}): ${atrNow.toFixed(decimals)} | ` +
      `Trailing stop: close - ${atrMultiplier} * ATR | ` +
      `50-MA: ${fmt(ma50Now, symbol)}`,
    marketSummary:
      `Momentum breakout setup (long). Initial stop ATR-based; trailing stop ratchets ` +
      `up each bar. Target acts as a ${TARGET_R_CAP}R far-cap; exit is determined by trailing.`,
    createdAt: Date.now(),
    exitPlan,
  };

  return { snapshot, recommendation: rec, skipReasons: [] };
}

// =====================================================================
// Helpers (private to this module)
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

function round(n: number, d = 2): number {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function fmt(n: number, sym: AssetSymbol): string {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: sym === "BTC" ? 0 : 2,
    maximumFractionDigits: sym === "BTC" ? 0 : 2,
  })}`;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10);
}
