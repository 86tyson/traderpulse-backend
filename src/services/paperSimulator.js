'use strict';

/**
 * Paper-mode trade outcome simulator.
 *
 * Resolves an approved trade synchronously into a win or a loss, computes the
 * exit price and realized USD P/L. NOT a real-market simulator — outcomes are
 * probabilistic, driven only by the trade's confidence score. The point is to
 * give the evaluation framework actual closed-trade data to work with.
 *
 * To make the simulated environment harder or easier (e.g. to test whether
 * the evaluation framework correctly distinguishes good systems from bad
 * ones), tune BASE_WIN_RATE and CONFIDENCE_SLOPE below.
 */

// p_win = BASE + SLOPE * confidenceScore (clamped 0..1).
// Defaults: 40% wins at conf=0, 60% wins at conf=1.
const BASE_WIN_RATE = 0.40;
const CONFIDENCE_SLOPE = 0.20;

function probabilityOfWin(confidenceScore) {
  const c = Math.max(0, Math.min(1, Number(confidenceScore) || 0));
  return BASE_WIN_RATE + CONFIDENCE_SLOPE * c;
}

/**
 * Derive the entry price from stop, target, and planned R:R.
 * Solving R = (target - entry) / (entry - stop)  →  entry = (target + R*stop) / (1 + R).
 * The same formula works for buy (stop < entry < target) and sell (target < entry < stop).
 */
function deriveEntryPrice(stopLoss, profitTarget, riskReward) {
  return (profitTarget + riskReward * stopLoss) / (1 + riskReward);
}

/**
 * Resolve a trade request into a synthetic close.
 * `rng` is injectable for deterministic tests; defaults to Math.random.
 *
 * Returns: { outcome, exitPrice, pnlUsd, entryPrice, pWin }
 */
function resolveOutcome(request, rng = Math.random) {
  const { side, stopLoss, profitTarget, riskReward, suggestedAmountUsd, confidenceScore } = request;

  const entry = deriveEntryPrice(stopLoss, profitTarget, riskReward);
  if (!Number.isFinite(entry) || entry <= 0) {
    throw new Error(`paperSimulator: derived entry price is invalid (${entry})`);
  }

  const pWin = probabilityOfWin(confidenceScore);
  const isWin = rng() < pWin;
  const exitPrice = isWin ? profitTarget : stopLoss;

  // Notional P/L: (exit - entry)/entry * notional, sign-flipped for sells.
  const direction = side === 'buy' ? 1 : -1;
  const pctMove = (exitPrice - entry) / entry;
  const pnlUsd = Number((direction * pctMove * suggestedAmountUsd).toFixed(4));

  return {
    outcome: isWin ? 'win' : 'loss',
    exitPrice,
    pnlUsd,
    entryPrice: entry,
    pWin,
  };
}

module.exports = {
  BASE_WIN_RATE,
  CONFIDENCE_SLOPE,
  probabilityOfWin,
  deriveEntryPrice,
  resolveOutcome,
};
