'use strict';

/**
 * CommonJS port of the Lovable frontend's src/lib/trading/strategy.ts.
 * Logic must stay byte-for-byte identical to the frontend version. If you change
 * filter thresholds or scoring here, mirror them in the frontend file or
 * approve/decline flows will diverge from what the user sees in the UI.
 */

const REQUIRED_PULLBACK = 3; // %
const MIN_RR = 1.5;
const DEFAULT_AMOUNT = 25; // $

function evaluateMarket(snap) {
  const reasons = [];

  // Hard filters
  if (snap.condition === 'CHOPPY' || snap.trend === 'SIDEWAYS') reasons.push('Choppy / sideways market');
  if (snap.condition === 'LOW_VOLUME' || snap.volume === 'WEAK') reasons.push('Low volume');
  if (snap.condition === 'LOW_VOLATILITY' || snap.volatility === 'WEAK') reasons.push('Low volatility');

  // Buy-setup geometry
  const aboveMA = snap.price > snap.ma50;
  const cleanPullback = snap.pullbackPct >= REQUIRED_PULLBACK;
  const nearSupport = (snap.price - snap.support) / snap.price <= 0.02;
  const distToSupport = snap.price - snap.support; // risk
  const distToResistance = snap.resistance - snap.price; // reward
  const rr = distToSupport > 0 ? distToResistance / distToSupport : 0;

  if (!aboveMA) reasons.push('Price below 50-period MA');
  if (!cleanPullback) reasons.push(`Pullback only ${snap.pullbackPct}% (need >= ${REQUIRED_PULLBACK}%)`);
  if (!nearSupport) reasons.push('No clean support level nearby');
  if (rr < MIN_RR) reasons.push(`Weak risk/reward (${rr.toFixed(2)}:1)`);

  if (reasons.length > 0) {
    return { snapshot: snap, recommendation: null, skipReasons: reasons };
  }

  // Confidence scoring (0-6)
  let score = 0;
  if (snap.trend === 'UPTREND') score += 1;
  if (snap.volume === 'STRONG') score += 1;
  else if (snap.volume === 'OK') score += 0.5;
  if (snap.volatility === 'OK' || snap.volatility === 'STRONG') score += 1;
  if (snap.pullbackPct >= 4) score += 1;
  if (rr >= 2) score += 1;
  else if (rr >= 1.5) score += 0.5;
  if (nearSupport) score += 1;

  let confidence = 'LOW';
  if (score >= 4.5) confidence = 'HIGH';
  else if (score >= 3) confidence = 'MEDIUM';

  if (confidence === 'LOW') {
    return {
      snapshot: snap,
      recommendation: null,
      skipReasons: ['Low confidence score - setup logged as skipped'],
      skippedConfidence: 'LOW',
    };
  }

  const entry = snap.price;
  const stopLoss = round(entry * 0.98, snap.symbol === 'BTC' ? 0 : 2);
  const profitTarget = round(entry * 1.03, snap.symbol === 'BTC' ? 0 : 2);
  const invalidation = snap.support;

  const rec = {
    id: cryptoId(),
    symbol: snap.symbol,
    side: 'BUY',
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

function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

function fmt(n, sym) {
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: sym === 'BTC' ? 0 : 2,
    maximumFractionDigits: sym === 'BTC' ? 0 : 2,
  })}`;
}

function cryptoId() {
  return Math.random().toString(36).slice(2, 10);
}

module.exports = { evaluateMarket };
