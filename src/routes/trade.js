'use strict';

const express = require('express');
const { config } = require('../config');
const { validateBody, tradeApproveSchema, tradeDeclineSchema } = require('../middleware/validate');
const riskManager = require('../services/riskManager');
const { applyRiskMode } = require('../services/riskModeAdjuster');
const tradeLogger = require('../services/tradeLogger');
const robinhood = require('../services/robinhoodClient');
const paperSimulator = require('../services/paperSimulator');
const logger = require('../services/logger');

const router = express.Router();

router.post('/approve', validateBody(tradeApproveSchema), async (req, res, next) => {
  // Strip riskMode out of the request shape before passing to riskManager
  // (the validator allowed it as an optional field, but the rest of the
  // pipeline doesn't know about it). Keep the original amount for audit.
  const { riskMode: rawRiskMode, ...request } = req.validBody;
  const requestedAmountUsd = request.suggestedAmountUsd;

  // Risk-mode adjustments are PAPER-ONLY. The adjuster itself enforces this
  // (returns no-op when paperMode !== true) — this is defence-in-depth so a
  // future refactor can't accidentally let it touch live size. Live orders
  // go through /live/approve which has a separate strict schema that
  // rejects `riskMode` at validation.
  const adjustment = applyRiskMode({
    request,
    config,
    riskMode: rawRiskMode,
  });
  const evalCtx = { config: { ...config, minConfidence: adjustment.minConfidence } };
  request.suggestedAmountUsd = adjustment.suggestedAmountUsd;

  if (rawRiskMode && rawRiskMode !== 'standard' && !config.paperMode) {
    // Should never trip — adjuster already returned no-op — but log it
    // loudly so a config-mismatch is visible in pino.
    logger.warn(
      {
        event: 'riskMode.live_ignored',
        riskMode: rawRiskMode,
        recommendationId: request.recommendationId,
      },
      'riskMode ignored — non-paper request',
    );
  }

  const verdict = riskManager.evaluate(request, evalCtx);

  if (!verdict.ok) {
    tradeLogger.recordDecision({
      recommendationId: request.recommendationId,
      decision: 'rejected',
      reason: verdict.reason,
      code: verdict.code,
    });
    return res.status(400).json({
      ok: false,
      status: 'rejected',
      code: verdict.code,
      reason: verdict.reason,
      riskMode: adjustment.riskMode,
    });
  }

  if (config.paperMode) {
    const close = paperSimulator.resolveOutcome(request);
    const id = tradeLogger.recordTrade({
      request,
      status: 'simulated',
      mode: 'paper',
      response: {
        simulated: true,
        ...close,
        // Audit trail of the risk-mode application.
        riskMode: adjustment.riskMode,
        riskModeApplied: adjustment.applied,
        requestedAmountUsd,
        effectiveAmountUsd: request.suggestedAmountUsd,
        effectiveMinConfidence: adjustment.minConfidence,
      },
    });
    tradeLogger.closeTrade(id, close);
    const realizedRR =
      close.outcome === 'win'
        ? Number(request.riskReward)
        : -1;
    return res.json({
      ok: true,
      status: 'simulated',
      mode: 'paper',
      tradeId: id,
      recommendationId: request.recommendationId,
      outcome: close.outcome,
      exitPrice: close.exitPrice,
      entryPrice: Number(close.entryPrice.toFixed(8)),
      pnlUsd: close.pnlUsd,
      realizedRR,
      riskMode: adjustment.riskMode,
      effectiveAmountUsd: request.suggestedAmountUsd,
      message: `Trade simulated and closed in paper mode (${close.outcome}).`,
    });
  }

  // Legacy live path (only reachable if PAPER_MODE=false on this endpoint;
  // current Phase 3 live trading goes through /live/approve). riskMode has
  // already been neutralized by the adjuster in this branch.
  try {
    const order = await robinhood.placeOrder(request.symbol, request.side, request.suggestedAmountUsd);
    const id = tradeLogger.recordTrade({
      request,
      status: 'executed',
      mode: 'live',
      response: order,
      robinhoodOrderId: order && order.id,
    });
    return res.json({
      ok: true,
      status: 'executed',
      mode: 'live',
      tradeId: id,
      recommendationId: request.recommendationId,
      order,
    });
  } catch (err) {
    logger.error({ err, recommendationId: request.recommendationId }, 'live order failed');
    return next(err);
  }
});

router.post('/decline', validateBody(tradeDeclineSchema), (req, res) => {
  const { recommendationId, reason } = req.validBody;
  tradeLogger.recordDecision({
    recommendationId,
    decision: 'declined',
    reason,
    code: null,
  });
  return res.json({ ok: true, status: 'declined', recommendationId });
});

module.exports = router;
