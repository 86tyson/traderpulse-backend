// Verbatim copy of the Lovable frontend strategy — placed here so backtest imports resolve.
// Live behavior (the /scan route) uses the JS port in src/services/strategy.js, which is
// untouched. This TS file is only consumed by the backtest harness, where the optional
// `params` second arg allows controlled parameter-review experiments without forking
// the strategy. Defaults preserve the baseline (3 % pullback, 2 % near-support).

import type { Confidence, MarketSnapshot, Recommendation } from "./types";

export interface ScanResult {
  snapshot: MarketSnapshot;
  recommendation: Recommendation | null;
  skipReasons: string[];
  skippedConfidence?: Confidence;
}

export interface StrategyParams {
  /** Minimum pullback %, default 3. */
  pullbackMin?: number;
  /** Maximum (price - support)/price ratio for "near support", default 0.02. */
  nearSupportMax?: number;
}

const DEFAULT_PULLBACK_MIN = 3;       // %
const DEFAULT_NEAR_SUPPORT_MAX = 0.02; // 2%
const MIN_RR = 1.5;                    // unchanged — not a tunable in this review
const DEFAULT_AMOUNT = 25;             // $

export function evaluateMarket(snap: MarketSnapshot, params: StrategyParams = {}): ScanResult {
  const pullbackMin = params.pullbackMin ?? DEFAULT_PULLBACK_MIN;
  const nearSupportMax = params.nearSupportMax ?? DEFAULT_NEAR_SUPPORT_MAX;

  const reasons: string[] = [];

  // Hard filters (unchanged)
  if (snap.condition === "CHOPPY" || snap.trend === "SIDEWAYS") reasons.push("Choppy / sideways market");
  if (snap.condition === "LOW_VOLUME" || snap.volume === "WEAK") reasons.push("Low volume");
  if (snap.condition === "LOW_VOLATILITY" || snap.volatility === "WEAK") reasons.push("Low volatility");

  // Buy-setup geometry
  const aboveMA = snap.price > snap.ma50;
  const cleanPullback = snap.pullbackPct >= pullbackMin;
  const nearSupport = (snap.price - snap.support) / snap.price <= nearSupportMax;
  const distToSupport = snap.price - snap.support;        // risk
  const distToResistance = snap.resistance - snap.price;  // reward
  const rr = distToSupport > 0 ? distToResistance / distToSupport : 0;

  if (!aboveMA) reasons.push("Price below 50-period MA");
  if (!cleanPullback) reasons.push(`Pullback only ${snap.pullbackPct}% (need >= ${pullbackMin}%)`);
  if (!nearSupport) reasons.push("No clean support level nearby");
  if (rr < MIN_RR) reasons.push(`Weak risk/reward (${rr.toFixed(2)}:1)`);

  if (reasons.length > 0) {
    return { snapshot: snap, recommendation: null, skipReasons: reasons };
  }

  // Confidence scoring (0-6)
  let score = 0;
  if (snap.trend === "UPTREND") score += 1;
  if (snap.volume === "STRONG") score += 1; else if (snap.volume === "OK") score += 0.5;
  if (snap.volatility === "OK" || snap.volatility === "STRONG") score += 1;
  if (snap.pullbackPct >= 4) score += 1;
  if (rr >= 2) score += 1; else if (rr >= 1.5) score += 0.5;
  if (nearSupport) score += 1;

  let confidence: Confidence = "LOW";
  if (score >= 4.5) confidence = "HIGH";
  else if (score >= 3) confidence = "MEDIUM";

  if (confidence === "LOW") {
    return {
      snapshot: snap,
      recommendation: null,
      skipReasons: ["Low confidence score - setup logged as skipped"],
      skippedConfidence: "LOW",
    };
  }

  const entry = snap.price;
  const stopLoss = round(entry * 0.98, snap.symbol === "BTC" ? 0 : 2);
  const profitTarget = round(entry * 1.03, snap.symbol === "BTC" ? 0 : 2);
  const invalidation = snap.support;

  const rec: Recommendation = {
    id: cryptoId(),
    symbol: snap.symbol,
    side: "BUY",
    amountUsd: DEFAULT_AMOUNT,
    entry,
    stopLoss,
    profitTarget,
    invalidation,
    riskRewardRatio: round(rr, 2),
    confidence,
    reasoning: `${snap.symbol} is trading above its 50-period moving average and has pulled back ${snap.pullbackPct}% from the recent high near support at ${fmt(snap.support, snap.symbol)}.`,
    srNotes: `Support: ${fmt(snap.support, snap.symbol)} | Resistance: ${fmt(snap.resistance, snap.symbol)} | 50-MA: ${fmt(snap.ma50, snap.symbol)}`,
    marketSummary: `Trend ${snap.trend.toLowerCase()}, volume ${snap.volume.toLowerCase()}, volatility ${snap.volatility.toLowerCase()}. Conditions favorable.`,
    createdAt: Date.now(),
  };
  return { snapshot: snap, recommendation: rec, skipReasons: [] };
}

function round(n: number, d = 2) { const f = Math.pow(10, d); return Math.round(n * f) / f; }
function fmt(n: number, sym: "BTC" | "ETH") {
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: sym === "BTC" ? 0 : 2, maximumFractionDigits: sym === "BTC" ? 0 : 2 })}`;
}
function cryptoId() { return Math.random().toString(36).slice(2, 10); }
