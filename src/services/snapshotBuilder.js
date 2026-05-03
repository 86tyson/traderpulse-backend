'use strict';

/**
 * Pure deterministic builder: candles -> MarketSnapshot.
 *
 * CommonJS port of the Lovable frontend's src/lib/trading/snapshotBuilder.ts.
 * Logic must stay identical to the frontend version. If you change tuning
 * constants here, mirror them in the frontend file.
 */

// =====================================================================
// Conventions — tuning surface (mirror src/lib/trading/snapshotBuilder.ts)
// =====================================================================

const RECENT_HIGH_LOOKBACK = 20;
const MA_PERIOD = 50;

const TREND_SLOPE_LOOKBACK = 20;

const ATR_PERIOD = 14;
const VOLATILITY_PERCENTILE_LOOKBACK = 100;
const VOLATILITY_LOWER_QUANTILE = 0.33;
const VOLATILITY_UPPER_QUANTILE = 0.67;

// RSI period (Soloway Playbook §06 rank-5, BLK-03, STAY-OUT)
const RSI_PERIOD = 14;
// How many bars back to scan for divergence-eligible swing highs.
// 30 1H bars ≈ 1.25 days — long enough to catch a recent HH/LH pair
// without picking up old structure that's no longer relevant.
const DIVERGENCE_LOOKBACK = 30;

const VOLUME_AVG_PERIOD = 20;
const VOLUME_STRONG_RATIO = 1.5;
const VOLUME_WEAK_RATIO = 0.7;

const SWING_PIVOT_BARS = 3;
const SR_LOOKBACK = 50;

const BARS_PER_DAY = {
  '5m': 288,
  '15m': 96,
  '1h': 24,
  '4h': 6,
  '1d': 1,
};

// =====================================================================
// Public API
// =====================================================================

function buildSnapshot(candles, symbol, timeframe) {
  if (!Array.isArray(candles) || candles.length < MA_PERIOD) {
    throw new Error(
      `snapshotBuilder: need at least ${MA_PERIOD} candles, got ${candles ? candles.length : 0}`,
    );
  }
  if (symbol !== 'BTC' && symbol !== 'ETH') {
    throw new Error(`snapshotBuilder: unsupported symbol "${symbol}"`);
  }
  if (!Object.prototype.hasOwnProperty.call(BARS_PER_DAY, timeframe)) {
    throw new Error(`snapshotBuilder: unsupported timeframe "${timeframe}"`);
  }

  const last = candles[candles.length - 1];
  const price = last.close;

  const ma50 = sma(candles.slice(-MA_PERIOD).map((c) => c.close));

  const recentSlice = candles.slice(-RECENT_HIGH_LOOKBACK);
  const recentHigh = Math.max(...recentSlice.map((c) => c.high));
  const pullbackPct = recentHigh > 0 ? ((recentHigh - price) / recentHigh) * 100 : 0;

  const barsBack = BARS_PER_DAY[timeframe];
  const refIdx = Math.max(0, candles.length - 1 - barsBack);
  const refClose = candles[refIdx].close;
  const change24h = refClose > 0 ? ((price - refClose) / refClose) * 100 : 0;

  const srSlice = candles.slice(-SR_LOOKBACK);
  const support = mostRecentSwingLow(srSlice) ?? Math.min(...srSlice.map((c) => c.low));
  const resistance = mostRecentSwingHigh(srSlice) ?? Math.max(...srSlice.map((c) => c.high));

  const trend = classifyTrend(candles, ma50);
  const volatility = classifyVolatility(candles);
  const volume = classifyVolume(candles);

  const condition =
    trend === 'SIDEWAYS' ? 'CHOPPY'
    : volume === 'WEAK' ? 'LOW_VOLUME'
    : volatility === 'WEAK' ? 'LOW_VOLATILITY'
    : 'FAVORABLE';

  // ----- ATR series + current value + rolling median (Soloway Playbook) -----
  // Used by:
  //   - BLK-02: current ATR vs median (3× = too volatile, 0.25× = dead market)
  //   - PRE-04: 0.5×ATR confluence proximity
  //   - STP-01: 0.5×ATR stop buffer
  //   - STAY-OUT: ATR/price ratio chop check, 2×ATR white-space check
  // The Soloway spec calls for a 30-day median 1H ATR (≈720 bars). We use
  // the available window of ATR readings (~100 bars at the current
  // NUM_BARS=200 fetch). This is a recent-regime proxy; flagged in comments
  // and Phase B will widen the fetch.
  const atrSeries = rollingATR(candles, ATR_PERIOD);
  const atrNow = atrSeries[atrSeries.length - 1];
  const atrFinite = atrSeries.filter(Number.isFinite);
  const atrMedian = atrFinite.length > 0 ? median(atrFinite) : NaN;

  // ----- RSI(14) series + current value (Soloway Playbook §06, BLK-03) -----
  // Wilder's smoothing — the original RSI formulation, matches what most
  // trading platforms display by default.
  const rsiSeries = rollingRSI(candles, RSI_PERIOD);
  const rsiNow = rsiSeries[rsiSeries.length - 1];

  // ----- Recent swing highs paired with their RSI (BLK-03 divergence) -----
  // Each entry: { idx, price, rsi }. Most recent first. Used to detect
  // negative divergence (price HH while RSI LH) on the last two swing highs.
  const recentSwingHighsWithRsi = collectSwingHighs(
    candles,
    rsiSeries,
    DIVERGENCE_LOOKBACK,
  );

  const r = (n) => round(n, symbol === 'BTC' ? 0 : 2);

  return {
    symbol,
    price: r(price),
    change24h: round(change24h, 2),
    ma50: r(ma50),
    recentHigh: r(recentHigh),
    support: r(support),
    resistance: r(resistance),
    trend,
    volatility,
    volume,
    condition,
    pullbackPct: round(pullbackPct, 2),
    // Phase-A additions for Soloway evaluator
    atr: Number.isFinite(atrNow) ? round(atrNow, symbol === 'BTC' ? 2 : 4) : null,
    atrMedian: Number.isFinite(atrMedian)
      ? round(atrMedian, symbol === 'BTC' ? 2 : 4)
      : null,
    rsi: Number.isFinite(rsiNow) ? round(rsiNow, 2) : null,
    recentSwingHighsRsi: recentSwingHighsWithRsi.map((s) => ({
      price: r(s.price),
      rsi: Number.isFinite(s.rsi) ? round(s.rsi, 2) : null,
    })),
  };
}

// =====================================================================
// Helpers
// =====================================================================

function sma(xs) {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function trueRange(curr, prev) {
  const hl = curr.high - curr.low;
  if (!prev) return hl;
  return Math.max(hl, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
}

function rollingATR(candles, period) {
  const trs = candles.map((c, i) => trueRange(c, candles[i - 1]));
  const out = [];
  let runningSum = 0;
  for (let i = 0; i < trs.length; i++) {
    runningSum += trs[i];
    if (i + 1 < period) { out.push(NaN); continue; }
    if (i + 1 > period) runningSum -= trs[i - period];
    out.push(runningSum / period);
  }
  return out;
}

function classifyTrend(candles, ma50Now) {
  const close = candles[candles.length - 1].close;
  const closes = candles.map((c) => c.close);
  const series = [];
  let runningSum = 0;
  for (let i = 0; i < closes.length; i++) {
    runningSum += closes[i];
    if (i + 1 < MA_PERIOD) { series.push(NaN); continue; }
    if (i + 1 > MA_PERIOD) runningSum -= closes[i - MA_PERIOD];
    series.push(runningSum / MA_PERIOD);
  }
  const idxNow = series.length - 1;
  const idxThen = idxNow - TREND_SLOPE_LOOKBACK;
  if (idxThen < 0 || Number.isNaN(series[idxThen])) {
    if (close > ma50Now) return 'UPTREND';
    if (close < ma50Now) return 'DOWNTREND';
    return 'SIDEWAYS';
  }
  const slope = series[idxNow] - series[idxThen];
  if (close > ma50Now && slope > 0) return 'UPTREND';
  if (close < ma50Now && slope < 0) return 'DOWNTREND';
  return 'SIDEWAYS';
}

function classifyVolatility(candles) {
  const atrSeries = rollingATR(candles, ATR_PERIOD);
  const atrNow = atrSeries[atrSeries.length - 1];
  if (!Number.isFinite(atrNow)) return 'OK';

  const window = atrSeries.slice(-VOLATILITY_PERCENTILE_LOOKBACK).filter(Number.isFinite);
  if (window.length < 5) return 'OK';
  const sorted = [...window].sort((a, b) => a - b);
  const lower = sorted[Math.floor((sorted.length - 1) * VOLATILITY_LOWER_QUANTILE)];
  const upper = sorted[Math.floor((sorted.length - 1) * VOLATILITY_UPPER_QUANTILE)];
  if (atrNow >= upper) return 'STRONG';
  if (atrNow <= lower) return 'WEAK';
  return 'OK';
}

function classifyVolume(candles) {
  const recent = candles.slice(-VOLUME_AVG_PERIOD);
  const volNow = recent[recent.length - 1].volume;
  const avg = sma(recent.map((c) => c.volume));
  if (!Number.isFinite(avg) || avg <= 0) return 'OK';
  const ratio = volNow / avg;
  if (ratio >= VOLUME_STRONG_RATIO) return 'STRONG';
  if (ratio <= VOLUME_WEAK_RATIO) return 'WEAK';
  return 'OK';
}

function mostRecentSwingLow(candles) {
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

function mostRecentSwingHigh(candles) {
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

function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

// Median of a numeric array. Returns NaN for empty input. O(n log n).
function median(xs) {
  if (!xs || xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// Wilder's RSI(period). Returns an array same length as candles, with NaN
// for the first `period` bars. After the seed, each new bar uses the
// recursive smoothing:
//   avgGain_t = (avgGain_{t-1} * (period - 1) + gain_t) / period
//   avgLoss_t = (avgLoss_{t-1} * (period - 1) + loss_t) / period
//   RS = avgGain / avgLoss
//   RSI = 100 - 100 / (1 + RS)
// Standard formulation used by virtually all charting platforms.
function rollingRSI(candles, period) {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;

  // Initial seed: simple average of the first `period` gains/losses.
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = computeRsiFromAvgs(avgGain, avgLoss);

  // Wilder's smoothing for subsequent bars.
  for (let i = period + 1; i < n; i++) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = computeRsiFromAvgs(avgGain, avgLoss);
  }
  return out;
}

function computeRsiFromAvgs(avgGain, avgLoss) {
  if (avgLoss === 0) {
    // No down-moves in the window → RSI saturates at 100.
    return avgGain === 0 ? 50 : 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Collect swing highs (pivot highs) in the last `lookback` bars, paired
// with their RSI value at the same index. Returns up to MAX_SWINGS entries,
// most recent first. A "swing high" uses the same SWING_PIVOT_BARS rule
// as `mostRecentSwingHigh` for consistency.
function collectSwingHighs(candles, rsiSeries, lookback) {
  const N = SWING_PIVOT_BARS;
  const start = Math.max(N, candles.length - lookback);
  const out = [];
  const MAX_SWINGS = 5;
  for (let i = candles.length - 1 - N; i >= start; i--) {
    const c = candles[i];
    let isPivot = true;
    for (let k = 1; k <= N && isPivot; k++) {
      if (candles[i - k].high >= c.high || candles[i + k].high >= c.high) {
        isPivot = false;
      }
    }
    if (isPivot) {
      out.push({ idx: i, price: c.high, rsi: rsiSeries[i] });
      if (out.length >= MAX_SWINGS) break;
    }
  }
  return out;
}

module.exports = { buildSnapshot, MA_PERIOD, rollingRSI, median, collectSwingHighs };
