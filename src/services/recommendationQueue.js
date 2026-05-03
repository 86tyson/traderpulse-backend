'use strict';

// recommendationQueue — assisted-mode pending recommendations.
//
// When a scan runs while tradingMode='assisted' and produces a
// recommendation, we persist it as a row in `trades` with:
//   status      = 'pending_approval'
//   mode        = 'live'   (this row WILL become a live order if approved)
//   proposed_at = now()
//   executed_at = null
//
// The admin UI reads this queue, shows each pending row, and the operator
// either:
//   - Approves → /admin/recommendations/:id/approve runs the existing
//                /live/approve risk pipeline + RH order placement, then
//                flips the row's status to 'executed' (or 'rejected' if a
//                gate fails).
//   - Declines → status flips to 'rejected', a row is added to `decisions`
//                for audit.
//
// Idempotency: the existing UNIQUE constraint on `recommendation_id`
// prevents the same scan output from being queued twice. A second insert
// attempt fails fast with SQLITE_CONSTRAINT and we treat it as a no-op.

const db = require('../db');
const logger = require('./logger');

const insertPendingStmt = db.prepare(`
  INSERT INTO trades (
    recommendation_id, symbol, side, suggested_amount_usd, confidence_score,
    entry_reason, stop_loss, profit_target, invalidation_level, risk_reward,
    status, mode, raw_request_json, proposed_at
  ) VALUES (
    @recommendation_id, @symbol, @side, @suggested_amount_usd, @confidence_score,
    @entry_reason, @stop_loss, @profit_target, @invalidation_level, @risk_reward,
    'pending_approval', 'live', @raw_request_json, datetime('now')
  )
`);

const listPendingStmt = db.prepare(`
  SELECT id, recommendation_id, symbol, side, suggested_amount_usd,
         confidence_score, entry_reason, stop_loss, profit_target,
         invalidation_level, risk_reward, raw_request_json,
         proposed_at, created_at
  FROM trades
  WHERE status = 'pending_approval'
  ORDER BY id DESC
  LIMIT ?
`);

const countPendingStmt = db.prepare(`
  SELECT COUNT(*) AS n
  FROM trades
  WHERE status = 'pending_approval'
`);

const getByIdStmt = db.prepare(`
  SELECT id, recommendation_id, symbol, side, suggested_amount_usd,
         confidence_score, entry_reason, stop_loss, profit_target,
         invalidation_level, risk_reward, status, mode, raw_request_json,
         proposed_at, created_at, executed_at
  FROM trades
  WHERE id = ? AND status = 'pending_approval'
`);

const markRejectedStmt = db.prepare(`
  UPDATE trades
  SET status = 'rejected'
  WHERE id = @id AND status = 'pending_approval'
`);

const markExecutedStmt = db.prepare(`
  UPDATE trades
  SET status = 'executed',
      robinhood_order_id = @robinhood_order_id,
      raw_response_json = @raw_response_json,
      executed_at = datetime('now')
  WHERE id = @id AND status = 'pending_approval'
`);

/**
 * Insert a pending-approval row. Returns the new row's id, or null if a
 * row with the same recommendation_id already exists (idempotent).
 *
 * @param {object} rec  matches the Recommendation shape produced by the
 *   strategy evaluator: { id, symbol, side, amountUsd, confidenceScore,
 *   entryReason, stopLoss, profitTarget, invalidationLevel, riskReward }
 */
function enqueueRecommendation(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (!rec.id || !rec.symbol || !rec.side) return null;

  const row = {
    recommendation_id: rec.id,
    symbol: rec.symbol,
    side: rec.side,
    suggested_amount_usd: Number(rec.amountUsd ?? rec.suggestedAmountUsd ?? 0),
    confidence_score: Number(rec.confidenceScore ?? 0),
    entry_reason: rec.entryReason ?? null,
    stop_loss: rec.stopLoss != null ? Number(rec.stopLoss) : null,
    profit_target: rec.profitTarget != null ? Number(rec.profitTarget) : null,
    invalidation_level: rec.invalidationLevel != null ? Number(rec.invalidationLevel) : null,
    risk_reward: rec.riskReward != null ? Number(rec.riskReward) : null,
    raw_request_json: JSON.stringify(rec),
  };

  try {
    const result = insertPendingStmt.run(row);
    logger.info(
      {
        event: 'admin.recommendation.queued',
        id: result.lastInsertRowid,
        recommendationId: rec.id,
        symbol: rec.symbol,
        side: rec.side,
        amountUsd: row.suggested_amount_usd,
      },
      `recommendation queued for approval: ${rec.symbol} ${rec.side}`,
    );
    return result.lastInsertRowid;
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      // Already queued — treat as no-op. This is the expected path when
      // /scan is hit twice within the cache window with the same rec.
      logger.debug?.(
        {
          event: 'admin.recommendation.queue.duplicate',
          recommendationId: rec.id,
        },
        'recommendation already queued; skipping duplicate',
      );
      return null;
    }
    logger.error(
      {
        event: 'admin.recommendation.queue.fail',
        recommendationId: rec.id,
        msg: err.message,
      },
      `failed to queue recommendation: ${err.message}`,
    );
    return null;
  }
}

function listPending(limit = 50) {
  const n = Math.min(Math.max(1, Math.floor(limit) || 50), 500);
  const rows = listPendingStmt.all(n);
  return rows.map(rowToView);
}

// Cheap COUNT(*) for the STAY-OUT "pending approval already exists" rule.
// Used by the Soloway evaluator to avoid stacking up un-actioned recs.
function hasPending() {
  return (countPendingStmt.get().n || 0) > 0;
}

function getPendingById(id) {
  const row = getByIdStmt.get(Number(id));
  if (!row) return null;
  return rowToView(row);
}

function decline(id) {
  const result = markRejectedStmt.run({ id: Number(id) });
  return result.changes > 0;
}

function markExecuted(id, { robinhoodOrderId, response }) {
  const result = markExecutedStmt.run({
    id: Number(id),
    robinhood_order_id: robinhoodOrderId || null,
    raw_response_json: response ? JSON.stringify(response) : null,
  });
  return result.changes > 0;
}

function rowToView(row) {
  let raw = null;
  try {
    raw = row.raw_request_json ? JSON.parse(row.raw_request_json) : null;
  } catch {
    raw = null;
  }
  return {
    id: row.id,
    recommendationId: row.recommendation_id,
    symbol: row.symbol,
    side: row.side,
    suggestedAmountUsd: row.suggested_amount_usd,
    confidenceScore: row.confidence_score,
    entryReason: row.entry_reason,
    stopLoss: row.stop_loss,
    profitTarget: row.profit_target,
    invalidationLevel: row.invalidation_level,
    riskReward: row.risk_reward,
    status: row.status,
    mode: row.mode,
    proposedAt: row.proposed_at,
    createdAt: row.created_at,
    executedAt: row.executed_at,
    raw,
  };
}

module.exports = {
  enqueueRecommendation,
  listPending,
  hasPending,
  getPendingById,
  decline,
  markExecuted,
};
