'use strict';

const db = require('../db');
const logger = require('./logger');

const insertTrade = db.prepare(`
  INSERT INTO trades (
    recommendation_id, symbol, side, suggested_amount_usd, confidence_score,
    entry_reason, stop_loss, profit_target, invalidation_level, risk_reward,
    status, mode, simulated_pnl_usd, robinhood_order_id,
    raw_request_json, raw_response_json, executed_at
  ) VALUES (
    @recommendation_id, @symbol, @side, @suggested_amount_usd, @confidence_score,
    @entry_reason, @stop_loss, @profit_target, @invalidation_level, @risk_reward,
    @status, @mode, @simulated_pnl_usd, @robinhood_order_id,
    @raw_request_json, @raw_response_json, @executed_at
  )
`);

const insertDecision = db.prepare(`
  INSERT INTO decisions (recommendation_id, decision, reason, code)
  VALUES (?, ?, ?, ?)
`);

const updateClose = db.prepare(`
  UPDATE trades
  SET outcome = @outcome,
      exit_price = @exit_price,
      exit_timestamp = @exit_timestamp,
      simulated_pnl_usd = @pnl_usd
  WHERE id = @id
`);

function recordTrade({ request, status, mode, response, robinhoodOrderId }) {
  const row = {
    recommendation_id: request.recommendationId,
    symbol: request.symbol,
    side: request.side,
    suggested_amount_usd: request.suggestedAmountUsd,
    confidence_score: request.confidenceScore,
    entry_reason: request.entryReason,
    stop_loss: request.stopLoss,
    profit_target: request.profitTarget,
    invalidation_level: request.invalidationLevel,
    risk_reward: request.riskReward,
    status,
    mode,
    simulated_pnl_usd: null,
    robinhood_order_id: robinhoodOrderId || null,
    raw_request_json: JSON.stringify(request),
    raw_response_json: response ? JSON.stringify(response) : null,
    executed_at: status === 'executed' ? new Date().toISOString() : null,
  };
  const result = insertTrade.run(row);
  logger.info(
    {
      event: 'trade.recorded',
      id: result.lastInsertRowid,
      recommendationId: request.recommendationId,
      symbol: request.symbol,
      side: request.side,
      amountUsd: request.suggestedAmountUsd,
      status,
      mode,
    },
    `trade ${status} (${mode})`,
  );
  return result.lastInsertRowid;
}

function closeTrade(tradeId, { outcome, exitPrice, pnlUsd }) {
  updateClose.run({
    id: tradeId,
    outcome,
    exit_price: exitPrice,
    exit_timestamp: new Date().toISOString(),
    pnl_usd: pnlUsd,
  });
  logger.info(
    {
      event: 'trade.closed',
      tradeId,
      outcome,
      pnlUsd,
      exitPrice,
    },
    `trade ${tradeId} closed: ${outcome} (${pnlUsd >= 0 ? '+' : ''}${pnlUsd})`,
  );
}

function recordDecision({ recommendationId, decision, reason, code }) {
  insertDecision.run(recommendationId, decision, reason, code || null);
  logger.info(
    {
      event: `decision.${decision}`,
      recommendationId,
      reason,
      code: code || null,
    },
    `recommendation ${decision}: ${code || reason}`,
  );
}

module.exports = { recordTrade, closeTrade, recordDecision };
