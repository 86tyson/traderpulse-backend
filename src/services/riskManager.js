'use strict';

const db = require('../db');

const REQUIRED_FIELDS = [
  'recommendationId',
  'symbol',
  'side',
  'suggestedAmountUsd',
  'confidenceScore',
  'entryReason',
  'stopLoss',
  'profitTarget',
  'invalidationLevel',
  'riskReward',
];

function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Evaluate a trade-approve request against every risk gate.
 * Short-circuits on the first failure. Order matters — we check kill switches
 * (BOT_ENABLED, missing fields, allowed symbols) before more expensive checks.
 */
function evaluate(req, ctx) {
  if (!ctx.config.botEnabled) {
    return fail('BOT_DISABLED', 'BOT_ENABLED is false. No trades will be processed.');
  }

  for (const f of REQUIRED_FIELDS) {
    const v = req[f];
    if (v === undefined || v === null || v === '') {
      return fail('MISSING_FIELDS', `Missing required field: ${f}`);
    }
  }

  if (req.side !== 'buy' && req.side !== 'sell') {
    return fail('INVALID_SIDE', `side must be 'buy' or 'sell', got '${req.side}'`);
  }

  if (!ctx.config.allowedSymbols.includes(req.symbol)) {
    return fail(
      'SYMBOL_NOT_ALLOWED',
      `Symbol '${req.symbol}' is not in ALLOWED_SYMBOLS (${ctx.config.allowedSymbols.join(', ')})`,
    );
  }

  if (
    !Number.isFinite(req.suggestedAmountUsd) ||
    req.suggestedAmountUsd <= 0 ||
    req.suggestedAmountUsd > ctx.config.maxTradeUsd
  ) {
    return fail(
      'AMOUNT_OUT_OF_RANGE',
      `suggestedAmountUsd must be > 0 and <= MAX_TRADE_USD (${ctx.config.maxTradeUsd}). Got ${req.suggestedAmountUsd}.`,
    );
  }

  if (
    !Number.isFinite(req.stopLoss) ||
    !Number.isFinite(req.profitTarget) ||
    !Number.isFinite(req.riskReward) ||
    req.riskReward <= 0
  ) {
    return fail(
      'RISK_FIELDS_INVALID',
      'stopLoss, profitTarget must be finite numbers and riskReward must be > 0',
    );
  }

  if (!Number.isFinite(req.confidenceScore) || req.confidenceScore < ctx.config.minConfidence) {
    return fail(
      'CONFIDENCE_TOO_LOW',
      `confidenceScore (${req.confidenceScore}) is below MIN_CONFIDENCE (${ctx.config.minConfidence})`,
    );
  }

  const todaysLossRow = db
    .prepare(
      `SELECT COALESCE(SUM(simulated_pnl_usd), 0) AS loss
       FROM trades
       WHERE date(created_at) = date('now')
         AND simulated_pnl_usd IS NOT NULL
         AND simulated_pnl_usd < 0`,
    )
    .get();
  const lossUsd = Math.abs(todaysLossRow.loss || 0);
  if (lossUsd >= ctx.config.maxDailyLossUsd) {
    return fail(
      'DAILY_LOSS_CAP_HIT',
      `Today's realized losses ($${lossUsd.toFixed(2)}) >= MAX_DAILY_LOSS_USD ($${ctx.config.maxDailyLossUsd}). No new trades today.`,
    );
  }

  const dup = db
    .prepare('SELECT 1 FROM trades WHERE recommendation_id = ?')
    .get(req.recommendationId);
  if (dup) {
    return fail(
      'DUPLICATE_RECOMMENDATION',
      `recommendationId '${req.recommendationId}' has already been processed`,
    );
  }

  return { ok: true };
}

module.exports = { evaluate, REQUIRED_FIELDS };
