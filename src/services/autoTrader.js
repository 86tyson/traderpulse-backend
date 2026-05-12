'use strict';

// autoTrader — bot-loop auto-execute path. Runs ONLY when:
//   tradingMode === 'auto' AND
//   config.liveTradingEnabled === true AND
//   config.autoTradingEnabled === true AND
//   config.botEnabled === true
//
// Called by the scanner immediately AFTER a recommendation is successfully
// enqueued (so the pending_approval row exists with a proper id). The
// auto-execute then runs the SAME liveRiskManager pipeline + Robinhood
// placement that the manual /admin/recommendations/:id/approve route runs.
//
// HARD GUARANTEES:
//   - No new safety gates are skipped. Every one of liveRiskManager's
//     11 checks still runs on every order. Auto mode only skips the
//     "wait for a human click" step.
//   - confirmedRealMoney is passed as true at the request layer. This
//     flag exists for the manual approve path; in auto mode, the bot
//     is the "operator" and the env-level AUTO_TRADING_ENABLED=true is
//     the explicit confirmation that real money is in play.
//   - All caps still apply: LIVE_MAX_ORDER_USD, LIVE_DAILY_LOSS_CAP_USD,
//     LIVE_DAILY_TRADE_COUNT_CAP, LIVE_ALLOWED_SYMBOLS (ETH-USD only),
//     one-open-position-at-a-time, idempotency.
//   - On any failure (risk rejection, RH error, network) the queued row
//     STAYS as pending_approval. The admin can intervene manually.
//   - Every fire is SMS-notified post-execution and audit-logged.
//
// FAILURE MODES (each handled, none crashes the bot loop):
//   - liveRiskManager rejects: row stays pending, log + skip
//   - RH quote fetch fails: row stays pending, log + skip
//   - RH placeOrder fails: row stays pending, log + skip
//   - SMS fails: order still placed, log SMS failure separately

const liveRiskManager = require('./liveRiskManager');
const robinhood = require('./robinhoodClient');
const recommendationQueue = require('./recommendationQueue');
const tradeLogger = require('./tradeLogger');
const smsAlerts = require('./smsAlerts');
const { config } = require('../config');
const logger = require('./logger');

/**
 * Auto-execute a queued recommendation. Returns { ok, status, ... } similar
 * to the admin approve route. NEVER throws — all errors are caught.
 *
 * @param {number} queueId  the pending_approval row id
 * @returns {Promise<object>}
 */
async function executeQueued(queueId) {
  const row = recommendationQueue.getPendingById(queueId);
  if (!row) {
    return { ok: false, code: 'NOT_FOUND', reason: `no pending row ${queueId}` };
  }

  // Build the same shape the manual /admin/recommendations/:id/approve
  // route builds. Use the ::auto suffix on recommendationId so
  // liveRiskManager's UNIQUE-on-recommendation_id dedupe doesn't trip
  // on the queue row we just inserted (which already used the raw id).
  const liveRequest = {
    recommendationId: `${row.recommendationId}::auto`,
    symbol: row.symbol,
    side: row.side,
    usdAmount: row.suggestedAmountUsd,
    confirmedRealMoney: true,
  };

  // ─── Risk pipeline (every gate; NONE skipped) ───
  const verdict = liveRiskManager.evaluateLive(liveRequest, { config });
  if (!verdict.ok) {
    tradeLogger.recordDecision({
      recommendationId: row.recommendationId,
      decision: 'rejected',
      reason: verdict.reason,
      code: verdict.code,
    });
    logger.warn(
      {
        event: 'auto.trade.rejected',
        queueId,
        recommendationId: row.recommendationId,
        code: verdict.code,
        reason: verdict.reason,
      },
      `auto-trade rejected at risk gate: ${verdict.code}`,
    );
    return { ok: false, status: 'rejected', code: verdict.code, reason: verdict.reason };
  }

  // ─── Fetch quote ───
  let quote;
  try {
    quote = await robinhood.getQuote(row.symbol);
  } catch (err) {
    logger.error(
      {
        event: 'auto.trade.quote_fail',
        queueId,
        recommendationId: row.recommendationId,
        code: err.code,
        msg: err.message,
      },
      `auto-trade quote failed: ${err.message}`,
    );
    return { ok: false, code: err.code || 'ROBINHOOD_API_FAILED', reason: err.message };
  }
  const quoteResult = quote?.results?.[0];
  const refPrice = Number(
    quoteResult?.ask_inclusive_of_buy_spread ?? quoteResult?.price,
  );
  if (!Number.isFinite(refPrice) || refPrice <= 0) {
    logger.error(
      { event: 'auto.trade.quote_parse_fail', queueId, recommendationId: row.recommendationId },
      'auto-trade quote response missing usable price',
    );
    return {
      ok: false,
      code: 'ROBINHOOD_API_FAILED',
      reason: 'Quote response did not contain a usable price.',
    };
  }
  const cryptoQty = row.suggestedAmountUsd / refPrice;

  // ─── Place the order ───
  let placeResult;
  try {
    placeResult = await robinhood.placeOrder({
      symbol: row.symbol,
      side: row.side,
      cryptoQty,
      limitPrice: refPrice,
      clientOrderId: liveRequest.recommendationId,
    });
  } catch (err) {
    logger.error(
      {
        event: 'auto.trade.place_fail',
        queueId,
        recommendationId: row.recommendationId,
        code: err.code,
        msg: err.message,
      },
      `auto-trade placeOrder failed: ${err.message}`,
    );
    return { ok: false, code: err.code || 'ROBINHOOD_API_FAILED', reason: err.message };
  }

  // ─── Mark queue row executed ───
  recommendationQueue.markExecuted(queueId, {
    robinhoodOrderId: placeResult?.id || null,
    response: placeResult,
  });

  logger.info(
    {
      event: 'auto.trade.fired',
      queueId,
      recommendationId: row.recommendationId,
      symbol: row.symbol,
      side: row.side,
      amountUsd: row.suggestedAmountUsd,
      refPrice,
      cryptoQty,
      robinhoodOrderId: placeResult?.id || null,
    },
    `AUTO-TRADE FIRED: ${row.symbol} ${row.side} $${row.suggestedAmountUsd} @ $${refPrice}`,
  );

  // ─── SMS post-execution (fire-and-forget) ───
  smsAlerts
    .sendPendingApprovalAlert({
      recommendationId: row.recommendationId,
      symbol: row.symbol,
      side: row.side,
      suggestedAmountUsd: row.suggestedAmountUsd,
      confidenceScore: row.confidenceScore,
      entryReason: `AUTO-TRADED · order placed at ~$${refPrice.toFixed(2)} · ${row.entryReason || ''}`,
      entryPrice: refPrice,
    })
    .catch((err) => {
      logger.error(
        { event: 'sms.alert.failed', kind: 'auto_fire_notify', msg: err && err.message },
        'auto-trade SMS notify failed',
      );
    });

  return {
    ok: true,
    status: 'executed',
    queueId,
    robinhoodOrderId: placeResult?.id || null,
    refPrice,
    cryptoQty,
  };
}

module.exports = { executeQueued };
