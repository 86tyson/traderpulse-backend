'use strict';

// /live — Phase 3 micro live testing routes.
//
// All routes here require the bearer token (mounted under the global auth
// middleware). The actual order-placement endpoint is gated by:
//   - Zod body validation (rejects malformed payloads at the edge)
//   - liveRiskManager (kill switch, caps, dedupe, daily loss, one-position-max)
//   - robinhoodClient (defence-in-depth — refuses if liveTradingEnabled is false)
//   - REQUIRE_APPROVAL=true (config-validated at boot)
//
// Read-only endpoints (account/holdings/quote/products/orders) are useful for
// the frontend dashboard and for the verify-before-going-live checklist —
// they fetch info from Robinhood without placing an order.

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const { config } = require('../config');
const { validateBody, liveApproveSchema, liveCloseSchema } = require('../middleware/validate');
const liveRiskManager = require('../services/liveRiskManager');
const tradeLogger = require('../services/tradeLogger');
const robinhood = require('../services/robinhoodClient');
const { pollUntilTerminal } = require('../services/orderPoller');
const { decideClose } = require('../services/closeDecision');
const { reconcileAll } = require('../services/reconciler');
const { isManualApprovalRequired } = require('../services/autoTradingGate');
const logger = require('../services/logger');
const db = require('../db');

const router = express.Router();

// ----- Rate limit -----
// /live/* is more expensive than other routes (RH calls + DB writes), but the
// cap must accommodate the dashboard's panels: LivePanel polls /live/status
// every 30s and RobinhoodPanel polls /live/status + /live/account +
// /live/holdings + /live/quote/ETH-USD every 60s — ~6-7 calls/min just from
// idle UI activity. 60/min leaves comfortable headroom for manual curl calls
// during testing without ever risking RH itself (RH has its own server-side
// limits which this cap is well below).
//
// NOTE: this is an API-traffic limit, not a financial risk control. The
// real-money guardrails (kill switch, $ caps, allow-list, approval) live
// elsewhere and are unaffected by this number.
const liveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'RATE_LIMITED',
    reason: 'Too many live requests in the last minute.',
  },
});
router.use(liveLimiter);

// ----- Helpers -----

function todaysLiveLossUsd() {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(simulated_pnl_usd), 0) AS loss
       FROM trades
       WHERE date(created_at) = date('now')
         AND mode = 'live'
         AND simulated_pnl_usd IS NOT NULL
         AND simulated_pnl_usd < 0`,
    )
    .get();
  return Math.abs(row.loss || 0);
}

function openLiveCount() {
  // Only BUY rows count as open positions; sell rows are exits.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
        WHERE mode = 'live' AND status = 'executed' AND side = 'buy' AND outcome IS NULL`,
    )
    .get();
  return row.n || 0;
}

// ----- GET /live/status (cheap, DB only) -----
//
// Cheap server-state snapshot for the dashboard. Does NOT call Robinhood.
// Surfaces the kill-switch state, caps, and current capacity so the frontend
// can render the live panel correctly without burning RH rate-limit quota.
router.get('/status', (_req, res) => {
  return res.json({
    ok: true,
    liveTradingEnabled: config.liveTradingEnabled,
    autoTradingEnabled: config.autoTradingEnabled,
    botEnabled: config.botEnabled,
    paperMode: config.paperMode,
    requireApproval: config.requireApproval,
    // Derived: true when manual approval is the ONLY way an order can be
    // placed right now. Computed via the same helper a future bot loop
    // would use, so the dashboard can never disagree with reality.
    manualApprovalRequired: isManualApprovalRequired(config),
    robinhoodConnected: !!(config.robinhoodApiKey && config.robinhoodPrivateKey),
    caps: {
      maxOrderUsd: config.liveMaxOrderUsd,
      dailyLossCapUsd: config.liveDailyLossCapUsd,
      allowedSymbols: config.liveAllowedSymbols,
    },
    today: {
      liveRealizedLossUsd: todaysLiveLossUsd(),
      openLivePositions: openLiveCount(),
    },
  });
});

// ----- Read-only Robinhood passthroughs (gated only by credentials) -----

function rhRouteHandler(name, fn) {
  return async (_req, res, next) => {
    if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
      return res.status(412).json({
        ok: false,
        code: 'ROBINHOOD_KEYS_MISSING',
        reason:
          'Robinhood credentials are not configured. Set ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY.',
      });
    }
    try {
      const data = await fn();
      logger.info({ event: `live.${name}.ok` }, `live ${name} ok`);
      return res.json({ ok: true, data });
    } catch (err) {
      // Surface RH auth errors as 502 so the frontend renders a sensible message.
      logger.warn(
        { event: `live.${name}.fail`, code: err.code, msg: err.message },
        `live ${name} failed`,
      );
      if (err.code === 'ROBINHOOD_AUTH_FAILED') {
        return res.status(502).json({
          ok: false,
          code: 'ROBINHOOD_AUTH_FAILED',
          reason: err.message,
          httpStatus: err.httpStatus ?? undefined,
          responseBody: err.responseBody ?? undefined,
        });
      }
      return next(err);
    }
  };
}

router.get('/account', rhRouteHandler('account', () => robinhood.getAccount()));
router.get('/holdings', rhRouteHandler('holdings', () => robinhood.getHoldings()));
router.get('/products', rhRouteHandler('products', () => robinhood.getProducts()));
router.get('/orders', rhRouteHandler('orders', () => robinhood.getOrders()));

// Single-order lookup. Useful for verifying the dry-run limit order really
// landed in Robinhood's order book before you cancel it.
router.get('/orders/:id', async (req, res, next) => {
  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    return res.status(412).json({
      ok: false,
      code: 'ROBINHOOD_KEYS_MISSING',
      reason:
        'Robinhood credentials are not configured. Set ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY.',
    });
  }
  try {
    const data = await robinhood.getOrderById(req.params.id);
    return res.json({ ok: true, data });
  } catch (err) {
    if (err.code === 'ROBINHOOD_AUTH_FAILED') {
      return res.status(502).json({
        ok: false,
        code: 'ROBINHOOD_AUTH_FAILED',
        reason: err.message,
        httpStatus: err.httpStatus ?? undefined,
        responseBody: err.responseBody ?? undefined,
      });
    }
    return next(err);
  }
});
router.get('/quote/:symbol', async (req, res, next) => {
  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    return res.status(412).json({
      ok: false,
      code: 'ROBINHOOD_KEYS_MISSING',
      reason:
        'Robinhood credentials are not configured. Set ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY.',
    });
  }
  try {
    const data = await robinhood.getQuote(req.params.symbol);
    return res.json({ ok: true, data });
  } catch (err) {
    if (err.code === 'ROBINHOOD_AUTH_FAILED') {
      return res.status(502).json({
        ok: false,
        code: 'ROBINHOOD_AUTH_FAILED',
        reason: err.message,
      });
    }
    return next(err);
  }
});

// ----- POST /live/approve  (the gate) -----
//
// FLOW:
//   1. Zod-validate the body (already includes confirmedRealMoney === true).
//   2. liveRiskManager runs every gate; rejection logs to `decisions` and
//      returns 400 with a stable error code.
//   3. Convert USD notional to crypto quantity at the live ask + 0.5% buffer
//      (default order type is `limit`).
//   4. Call robinhoodClient.placeOrder.
//   5. Persist the trade in `trades` with mode='live'.
//
// Every step logs (with credential redaction) so the audit trail is complete
// regardless of which gate trips.
router.post('/approve', validateBody(liveApproveSchema), async (req, res) => {
  const body = req.validBody;
  const orderType = body.orderType ?? 'limit';

  // ----- Stage 1: liveRiskManager -----
  const verdict = liveRiskManager.evaluateLive(body, { config });
  if (!verdict.ok) {
    tradeLogger.recordDecision({
      recommendationId: body.recommendationId,
      decision: 'rejected',
      reason: verdict.reason,
      code: verdict.code,
    });
    logger.warn(
      {
        event: 'live.rejected',
        code: verdict.code,
        recommendationId: body.recommendationId,
      },
      `live rejected: ${verdict.code}`,
    );
    return res.status(400).json({
      ok: false,
      status: 'rejected',
      code: verdict.code,
      reason: verdict.reason,
    });
  }

  // ----- Stage 2: fetch live quote and compute crypto quantity -----
  let quote;
  try {
    quote = await robinhood.getQuote(body.symbol);
  } catch (err) {
    logger.error(
      { event: 'live.quote.fail', code: err.code, recommendationId: body.recommendationId },
      `live quote failed: ${err.message}`,
    );
    tradeLogger.recordDecision({
      recommendationId: body.recommendationId,
      decision: 'rejected',
      reason: `Quote fetch failed: ${err.message}`,
      code: err.code || 'ROBINHOOD_API_FAILED',
    });
    return res.status(502).json({
      ok: false,
      status: 'rejected',
      code: err.code || 'ROBINHOOD_API_FAILED',
      reason: `Could not fetch live quote: ${err.message}`,
    });
  }

  // RH best_bid_ask response (verified against live API on 2026-04-30):
  //   { results: [{ symbol, price, bid_inclusive_of_sell_spread,
  //     ask_inclusive_of_buy_spread, sell_spread, buy_spread, timestamp }] }
  // Older shape `bid_price`/`ask_price` is also accepted as a fallback so we
  // keep working if RH reverts the schema.
  const result = (quote && quote.results && quote.results[0]) || quote || {};
  const askPrice = Number(
    result.ask_inclusive_of_buy_spread ??
      result.ask_price ??
      result.ask ??
      NaN,
  );
  const bidPrice = Number(
    result.bid_inclusive_of_sell_spread ??
      result.bid_price ??
      result.bid ??
      NaN,
  );
  const referencePrice = body.side === 'buy' ? askPrice : bidPrice;

  if (!Number.isFinite(referencePrice) || referencePrice <= 0) {
    logger.error(
      { event: 'live.quote.parse_fail', recommendationId: body.recommendationId },
      'could not parse RH quote response',
    );
    return res.status(502).json({
      ok: false,
      status: 'rejected',
      code: 'ROBINHOOD_API_FAILED',
      reason:
        'Could not parse Robinhood quote response (missing bid/ask). Refusing to place order on bad data.',
    });
  }

  // Limit-price strategy:
  //   - If body.limitPrice is provided, use it verbatim (rounded to 2 dp).
  //     This is the path used by the Phase-3 dry-run (price far from market
  //     so the order does NOT fill). Caller takes responsibility for the
  //     price; this is intentional because a "fillable" auto-buffer would
  //     defeat the purpose of a non-fillable test.
  //   - Otherwise (the eventual "real" live order), compute a fillable
  //     limit walking past the touch by 0.5%.
  const LIMIT_BUFFER = 0.005;
  const limitPrice =
    orderType === 'limit'
      ? body.limitPrice != null
        ? Number(body.limitPrice.toFixed(2))
        : body.side === 'buy'
          ? Number((referencePrice * (1 + LIMIT_BUFFER)).toFixed(2))
          : Number((referencePrice * (1 - LIMIT_BUFFER)).toFixed(2))
      : null;
  const limitPriceWasOverridden = body.limitPrice != null;

  // Compute asset quantity from USD notional. Round to 6 decimals (ETH is 18-
  // decimal native but RH typically requires <= 8 here). Refuse to place if
  // the rounded quantity is essentially zero.
  const priceUsedForSizing = orderType === 'limit' ? limitPrice : referencePrice;
  const assetQuantity = Number((body.usdAmount / priceUsedForSizing).toFixed(6));
  if (!Number.isFinite(assetQuantity) || assetQuantity <= 0) {
    return res.status(400).json({
      ok: false,
      status: 'rejected',
      code: 'AMOUNT_OUT_OF_RANGE',
      reason: 'Computed asset quantity is zero after precision rounding.',
    });
  }

  // ----- Stage 3: place the order via Robinhood -----
  const clientOrderId = crypto.randomUUID();
  let order;
  try {
    order = await robinhood.placeOrder({
      clientOrderId,
      symbol: body.symbol,
      side: body.side,
      orderType,
      assetQuantity,
      limitPrice: orderType === 'limit' ? limitPrice : undefined,
      timeInForce: 'gtc',
    });
  } catch (err) {
    logger.error(
      {
        event: 'live.placeOrder.fail',
        code: err.code,
        httpStatus: err.httpStatus ?? null,
        responseBody: err.responseBody ?? null,
        recommendationId: body.recommendationId,
      },
      `live placeOrder failed: ${err.message}`,
    );
    tradeLogger.recordDecision({
      recommendationId: body.recommendationId,
      decision: 'rejected',
      reason: `Robinhood rejected order: ${err.message}`,
      code: err.code || 'ROBINHOOD_API_FAILED',
    });
    // Surface httpStatus + responseBody so the operator can see exactly what
    // Robinhood said. Critical for diagnosing 401-vs-403 (signing vs perm).
    return res.status(502).json({
      ok: false,
      status: 'rejected',
      code: err.code || 'ROBINHOOD_API_FAILED',
      reason: err.message,
      httpStatus: err.httpStatus ?? undefined,
      responseBody: err.responseBody ?? undefined,
    });
  }

  // ----- Stage 4: persist as a live trade -----
  // Fit the live request into the existing `trades` schema. The fields that
  // are paper-specific (entryReason, stopLoss, profitTarget, invalidation,
  // riskReward, confidenceScore) are filled with sentinel values that mark
  // the row as a live order rather than a paper rec. The full live payload
  // is preserved in raw_request_json.
  const tradeRow = {
    recommendationId: body.recommendationId,
    symbol: body.symbol,
    side: body.side,
    suggestedAmountUsd: body.usdAmount,
    confidenceScore: 1.0, // not applicable to manual live; sentinel
    entryReason:
      body.note?.trim() ||
      `MICRO LIVE: $${body.usdAmount} ${body.symbol} ${body.side} (orderType=${orderType})`,
    stopLoss: 0,
    profitTarget: 0,
    invalidationLevel: 0,
    riskReward: 1,
  };
  const tradeId = tradeLogger.recordTrade({
    request: tradeRow,
    status: 'executed',
    mode: 'live',
    response: {
      ...order,
      _ourSizing: {
        clientOrderId,
        orderType,
        assetQuantity,
        limitPrice,
        referencePrice,
        bufferPct: LIMIT_BUFFER,
        confirmedRealMoney: body.confirmedRealMoney,
      },
    },
    robinhoodOrderId:
      (order && (order.id || order.order_id)) || clientOrderId,
  });

  logger.warn(
    {
      event: 'live.placed',
      tradeId,
      recommendationId: body.recommendationId,
      symbol: body.symbol,
      side: body.side,
      usdAmount: body.usdAmount,
      orderType,
      assetQuantity,
      limitPrice,
      limitPriceWasOverridden,
      clientOrderId,
    },
    limitPriceWasOverridden ? 'LIVE order placed (custom limit price)' : 'LIVE order placed',
  );

  return res.json({
    ok: true,
    status: 'placed',
    mode: 'live',
    tradeId,
    recommendationId: body.recommendationId,
    order,
    sizing: {
      clientOrderId,
      orderType,
      assetQuantity,
      limitPrice,
      limitPriceWasOverridden,
      referencePrice,
    },
  });
});

// ----- POST /live/orders/:id/cancel -----
//
// Cancels an open Robinhood order by Robinhood-assigned id. Required before
// any fill-able live order so the dry-run cleanup path is functional.
//
// Side effects on success:
//   - Calls robinhood.cancelOrder(id) (Robinhood is the source of truth).
//   - If a local trade row exists for this order, mark it cancelled so the
//     "one open live position max" gate clears and a fresh order can be
//     placed afterwards. Local DB is bookkeeping only — RH is authoritative.
//
// Gates:
//   - LIVE_TRADING_ENABLED is checked inside robinhood.cancelOrder itself
//     (defence-in-depth — prevents stray API calls when the kill switch is off).
//   - We also check it here so we can emit a stable error code without
//     making any network call.
router.post('/orders/:id/cancel', async (req, res, next) => {
  if (!config.liveTradingEnabled) {
    return res.status(400).json({
      ok: false,
      code: 'LIVE_TRADING_DISABLED',
      reason: 'LIVE_TRADING_ENABLED is false; refusing to call Robinhood cancel.',
    });
  }
  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    return res.status(412).json({
      ok: false,
      code: 'ROBINHOOD_KEYS_MISSING',
      reason: 'Robinhood credentials are not configured.',
    });
  }

  const orderId = req.params.id;
  let cancelResp;
  try {
    cancelResp = await robinhood.cancelOrder(orderId);
  } catch (err) {
    logger.error(
      { event: 'live.cancel.fail', code: err.code, orderId },
      `live cancel failed: ${err.message}`,
    );
    if (err.code === 'ROBINHOOD_AUTH_FAILED') {
      return res.status(502).json({
        ok: false,
        code: 'ROBINHOOD_AUTH_FAILED',
        reason: err.message,
        httpStatus: err.httpStatus ?? undefined,
        responseBody: err.responseBody ?? undefined,
      });
    }
    return next(err);
  }

  // Best-effort local bookkeeping. If we can't find a row for this orderId,
  // that's fine — the user might have placed it outside our backend.
  let localTradeId = null;
  try {
    const row = db
      .prepare(`SELECT id FROM trades WHERE robinhood_order_id = ?`)
      .get(orderId);
    if (row) {
      db.prepare(
        `UPDATE trades
            SET outcome = 'cancelled',
                simulated_pnl_usd = COALESCE(simulated_pnl_usd, 0),
                exit_timestamp = datetime('now')
          WHERE id = ?`,
      ).run(row.id);
      localTradeId = row.id;
    }
  } catch (err) {
    logger.warn(
      { event: 'live.cancel.bookkeeping_fail', orderId, msg: err.message },
      'cancel succeeded on RH but local bookkeeping update failed',
    );
  }

  logger.warn(
    { event: 'live.cancel.ok', orderId, localTradeId },
    'LIVE order cancelled',
  );

  return res.json({
    ok: true,
    status: 'cancelled',
    orderId,
    localTradeId,
    response: cancelResp,
  });
});

// ============================================================================
// POST /live/close — close-out the single open live position.
//
// Hardened for production: places the sell, then POLLS the order until it
// reaches a terminal state. Updates the local DB based on the ACTUAL fill —
// not the estimated limit price.
//
// Flow:
//   1. Validate body (confirmedRealMoney must be true).
//   2. Verify kill switch is on and creds are present.
//   3. Find THE open BUY in the local DB (mode=live, status=executed,
//      side=buy, outcome IS NULL). Return NO_OPEN_POSITION if none.
//   4. Refuse if any prior sell row is still pending/partial/timeout for
//      this position (CLOSE_IN_PROGRESS) — manual reconciliation required.
//   5. Fetch the BUY from RH and confirm state=filled. Refuse with
//      BUY_NOT_FILLED if not.
//   6. Quote → sell-limit price (bid × (1 - 0.005)).
//   7. Place the SELL limit at the buy's filled quantity.
//   8. Persist the sell row immediately with outcome=NULL (still pending).
//   9. POLL the sell until terminal (≤60s, 2s interval).
//  10. decideClose() classifies the result. Branch:
//        - "closed"     → use REAL avg fill price + filled qty; update buy +
//                         sell rows; clear position gate.
//        - "rejected" / "failed" / "cancelled"
//                       → mark sell row with that outcome; LEAVE BUY ROW
//                         UNCHANGED (position still open). Return error.
//        - "partial"    → mark sell 'partial' with partial fill data; LEAVE
//                         BUY ROW UNCHANGED. Return warning. CLOSE_IN_PROGRESS
//                         will block subsequent close attempts until manual
//                         reconciliation.
//        - "timeout"    → mark sell 'timeout'; LEAVE BUY ROW UNCHANGED.
//                         Return error advising manual check.
// ============================================================================
router.post('/close', validateBody(liveCloseSchema), async (req, res) => {
  const body = req.validBody;

  // ----- Stage 1: kill switch + creds -----
  if (!config.liveTradingEnabled) {
    return res.status(400).json({
      ok: false,
      status: 'rejected',
      code: 'LIVE_TRADING_DISABLED',
      reason: 'LIVE_TRADING_ENABLED is false; refusing to close a live position.',
    });
  }
  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    return res.status(412).json({
      ok: false,
      code: 'ROBINHOOD_KEYS_MISSING',
      reason: 'Robinhood credentials are not configured.',
    });
  }

  // ----- Stage 2: find the open BUY position -----
  const openTrade = db
    .prepare(
      `SELECT id, recommendation_id, robinhood_order_id, suggested_amount_usd, symbol
         FROM trades
        WHERE mode = 'live'
          AND status = 'executed'
          AND side = 'buy'
          AND outcome IS NULL
        ORDER BY id DESC
        LIMIT 1`,
    )
    .get();
  if (!openTrade) {
    return res.status(400).json({
      ok: false,
      status: 'rejected',
      code: 'NO_OPEN_POSITION',
      reason: 'No open live position to close.',
    });
  }
  if (openTrade.symbol !== 'ETH-USD') {
    return res.status(400).json({
      ok: false,
      status: 'rejected',
      code: 'SYMBOL_NOT_ALLOWED_LIVE',
      reason: `Open position is ${openTrade.symbol}; Phase 3 close-out is ETH-USD only.`,
    });
  }

  // ----- Stage 3: refuse if a previous close attempt is unresolved -----
  // A pending, partially-filled, or timed-out sell row from an earlier close
  // attempt for THIS buy means manual reconciliation is needed before any
  // new sell.
  const inProgressSell = db
    .prepare(
      `SELECT id, outcome, robinhood_order_id
         FROM trades
        WHERE mode = 'live'
          AND side = 'sell'
          AND recommendation_id = ?
          AND (outcome IS NULL OR outcome IN ('pending', 'partial', 'timeout'))`,
    )
    .get(`close-of-${openTrade.recommendation_id}`);
  if (inProgressSell) {
    return res.status(409).json({
      ok: false,
      status: 'rejected',
      code: 'CLOSE_IN_PROGRESS',
      reason:
        `A previous close attempt for buy #${openTrade.id} is unresolved ` +
        `(sell trade #${inProgressSell.id}, outcome=${inProgressSell.outcome ?? 'null'}). ` +
        `Inspect /live/orders/${inProgressSell.robinhood_order_id} and reconcile manually before retrying.`,
      pendingSellTradeId: inProgressSell.id,
      pendingSellOrderId: inProgressSell.robinhood_order_id,
    });
  }

  // ----- Stage 4: pull the BUY from RH; require state=filled -----
  let buyOrder;
  try {
    buyOrder = await robinhood.getOrderById(openTrade.robinhood_order_id);
  } catch (err) {
    logger.error(
      { event: 'live.close.lookup_fail', code: err.code, recommendationId: openTrade.recommendation_id },
      `live close lookup failed: ${err.message}`,
    );
    return res.status(502).json({
      ok: false,
      status: 'rejected',
      code: err.code || 'ROBINHOOD_API_FAILED',
      reason: `Could not fetch the buy order from Robinhood: ${err.message}`,
      httpStatus: err.httpStatus ?? undefined,
      responseBody: err.responseBody ?? undefined,
    });
  }
  const buyQty = Number(buyOrder?.filled_asset_quantity ?? 0);
  if (buyOrder?.state !== 'filled' || !Number.isFinite(buyQty) || buyQty <= 0) {
    return res.status(400).json({
      ok: false,
      status: 'rejected',
      code: 'BUY_NOT_FILLED',
      reason: `Buy order state is "${buyOrder?.state}" (filled_qty=${buyQty}). Refusing to close until the buy is fully filled.`,
      buyOrder,
    });
  }

  // ----- Stage 5: quote and sell-limit price -----
  let quote;
  try {
    quote = await robinhood.getQuote('ETH-USD');
  } catch (err) {
    return res.status(502).json({
      ok: false,
      status: 'rejected',
      code: err.code || 'ROBINHOOD_API_FAILED',
      reason: `Quote fetch failed: ${err.message}`,
    });
  }
  const qresult = (quote && quote.results && quote.results[0]) || quote || {};
  const bidPrice = Number(
    qresult.bid_inclusive_of_sell_spread ??
      qresult.bid_price ??
      qresult.bid ??
      NaN,
  );
  if (!Number.isFinite(bidPrice) || bidPrice <= 0) {
    return res.status(502).json({
      ok: false,
      status: 'rejected',
      code: 'ROBINHOOD_API_FAILED',
      reason: 'Could not parse Robinhood quote (missing bid). Refusing to close on bad data.',
    });
  }
  const SELL_BUFFER = 0.005;
  const sellLimitPrice = Number((bidPrice * (1 - SELL_BUFFER)).toFixed(2));

  // ----- Stage 6: place the SELL -----
  const clientOrderId = crypto.randomUUID();
  let sellOrderInitial;
  try {
    sellOrderInitial = await robinhood.placeOrder({
      clientOrderId,
      symbol: 'ETH-USD',
      side: 'sell',
      orderType: 'limit',
      assetQuantity: buyQty,
      limitPrice: sellLimitPrice,
      timeInForce: 'gtc',
    });
  } catch (err) {
    logger.error(
      {
        event: 'live.close.placeOrder_fail',
        code: err.code,
        httpStatus: err.httpStatus ?? null,
        responseBody: err.responseBody ?? null,
        recommendationId: openTrade.recommendation_id,
      },
      `live close placeOrder failed: ${err.message}`,
    );
    return res.status(502).json({
      ok: false,
      status: 'rejected',
      code: err.code || 'ROBINHOOD_API_FAILED',
      reason: err.message,
      httpStatus: err.httpStatus ?? undefined,
      responseBody: err.responseBody ?? undefined,
    });
  }
  const sellRhOrderId =
    (sellOrderInitial && (sellOrderInitial.id || sellOrderInitial.order_id)) || clientOrderId;

  // ----- Stage 7: persist the sell row immediately (outcome=null, pending) -----
  const closeRecId = `close-of-${openTrade.recommendation_id}`;
  const sellNotionalUsd = Number((buyQty * sellLimitPrice).toFixed(4));
  const sellTradeId = tradeLogger.recordTrade({
    request: {
      recommendationId: closeRecId,
      symbol: 'ETH-USD',
      side: 'sell',
      suggestedAmountUsd: sellNotionalUsd,
      confidenceScore: 1.0,
      entryReason:
        body.note?.trim() ||
        `CLOSE-OUT of trade #${openTrade.id} (RH buy order ${openTrade.robinhood_order_id})`,
      stopLoss: 0,
      profitTarget: 0,
      invalidationLevel: 0,
      riskReward: 1,
    },
    status: 'executed',
    mode: 'live',
    response: {
      ...sellOrderInitial,
      _ourSizing: {
        clientOrderId,
        orderType: 'limit',
        assetQuantity: buyQty,
        limitPrice: sellLimitPrice,
        bidReference: bidPrice,
        bufferPct: SELL_BUFFER,
        confirmedRealMoney: body.confirmedRealMoney,
        closeOfTradeId: openTrade.id,
        closeOfRobinhoodOrderId: openTrade.robinhood_order_id,
      },
    },
    robinhoodOrderId: sellRhOrderId,
  });

  // ----- Stage 8: poll the sell until terminal -----
  // Default poll: 2s interval, 60s deadline. Tests can override via the
  // exported pollUntilTerminal which accepts dependency injection.
  const sellPollResult = await pollUntilTerminal(sellRhOrderId, {
    intervalMs: 2000,
    maxWaitMs: 60000,
  });

  // ----- Stage 9: classify and apply DB updates per branch -----
  const decision = decideClose({
    buyOrder,
    sellPollResult,
    sellLimitPrice,
  });

  // Persist the final sell-order RH response in raw_response_json for audit.
  const updateSellRowFinal = db.prepare(
    `UPDATE trades
        SET outcome = ?,
            simulated_pnl_usd = ?,
            exit_price = ?,
            exit_timestamp = datetime('now'),
            raw_response_json = ?
      WHERE id = ?`,
  );
  const sellOrderFinalJson = JSON.stringify({
    ...sellPollResult.order,
    _pollMeta: {
      pollCount: sellPollResult.pollCount,
      elapsedMs: sellPollResult.elapsedMs,
      timedOut: sellPollResult.timedOut,
    },
  });

  if (decision.action === 'closed') {
    // Real-fill bookkeeping. Both rows are settled.
    updateSellRowFinal.run(
      'closed',
      0,
      decision.sellAvgPrice,
      sellOrderFinalJson,
      sellTradeId,
    );
    db.prepare(
      `UPDATE trades
          SET outcome = ?,
              simulated_pnl_usd = ?,
              exit_price = ?,
              exit_timestamp = datetime('now'),
              raw_response_json = ?
        WHERE id = ?`,
    ).run(
      decision.buyOutcome,
      decision.realizedPnlUsd,
      decision.sellAvgPrice,
      sellOrderFinalJson,
      openTrade.id,
    );

    logger.warn(
      {
        event: 'live.closed',
        buyTradeId: openTrade.id,
        sellTradeId,
        buyQty: decision.buyQty,
        buyAvgPrice: decision.buyAvgPrice,
        sellAvgPrice: decision.sellAvgPrice,
        sellFilledQty: decision.sellFilledQty,
        realizedPnlUsd: decision.realizedPnlUsd,
        buyOutcome: decision.buyOutcome,
        sellOrderId: sellRhOrderId,
        pollCount: sellPollResult.pollCount,
        elapsedMs: sellPollResult.elapsedMs,
      },
      'LIVE position closed (real-fill P/L)',
    );

    return res.json({
      ok: true,
      status: 'closed',
      mode: 'live',
      buyTradeId: openTrade.id,
      sellTradeId,
      sellOrderFinal: sellPollResult.order,
      fill: {
        buyAvgPrice: decision.buyAvgPrice,
        buyQty: decision.buyQty,
        sellAvgPrice: decision.sellAvgPrice,
        sellFilledQty: decision.sellFilledQty,
        sellLimitPrice,
        realizedPnlUsd: decision.realizedPnlUsd,
        buyOutcome: decision.buyOutcome,
      },
      poll: {
        pollCount: sellPollResult.pollCount,
        elapsedMs: sellPollResult.elapsedMs,
      },
    });
  }

  if (decision.action === 'partial') {
    updateSellRowFinal.run(
      'partial',
      decision.partialPnlUsd ?? 0,
      decision.sellAvgPrice,
      sellOrderFinalJson,
      sellTradeId,
    );
    logger.warn(
      {
        event: 'live.close.partial',
        buyTradeId: openTrade.id,
        sellTradeId,
        sellFilledQty: decision.sellFilledQty,
        buyQty: decision.buyQty,
        sellAvgPrice: decision.sellAvgPrice,
        partialPnlUsd: decision.partialPnlUsd,
      },
      'LIVE close partially filled',
    );
    return res.status(409).json({
      ok: false,
      status: 'partial',
      code: 'SELL_PARTIAL',
      reason: decision.reason,
      buyTradeId: openTrade.id,
      sellTradeId,
      sellOrderFinal: sellPollResult.order,
      fill: {
        buyAvgPrice: decision.buyAvgPrice,
        buyQty: decision.buyQty,
        sellFilledQty: decision.sellFilledQty,
        sellAvgPrice: decision.sellAvgPrice,
        partialPnlUsd: decision.partialPnlUsd,
      },
      note:
        'Position is partially closed at Robinhood. The buy row REMAINS OPEN ' +
        'in our books. Reconcile manually — check the holdings endpoint and ' +
        'the original buy/sell orders before retrying close.',
    });
  }

  if (decision.action === 'timeout') {
    updateSellRowFinal.run(
      'timeout',
      0,
      null,
      sellOrderFinalJson,
      sellTradeId,
    );
    logger.warn(
      {
        event: 'live.close.timeout',
        buyTradeId: openTrade.id,
        sellTradeId,
        sellState: decision.sellState,
        sellOrderId: sellRhOrderId,
      },
      'LIVE close timed out — sell may still be live at RH',
    );
    return res.status(504).json({
      ok: false,
      status: 'pending',
      code: 'SELL_TIMEOUT',
      reason: decision.reason,
      buyTradeId: openTrade.id,
      sellTradeId,
      sellOrderId: sellRhOrderId,
      sellOrderFinal: sellPollResult.order,
      currentState: decision.sellState,
      note:
        `Sell may still close. Check GET /live/orders/${sellRhOrderId} ` +
        `manually. Buy row REMAINS OPEN until reconciled.`,
    });
  }

  // rejected / failed / cancelled
  updateSellRowFinal.run(
    decision.action, // 'rejected' | 'failed' | 'cancelled'
    0,
    null,
    sellOrderFinalJson,
    sellTradeId,
  );
  logger.warn(
    {
      event: 'live.close.refused',
      buyTradeId: openTrade.id,
      sellTradeId,
      action: decision.action,
      sellState: decision.sellState,
    },
    `LIVE close ${decision.action} by Robinhood`,
  );
  return res.status(502).json({
    ok: false,
    status: decision.action,
    code: `SELL_${decision.action.toUpperCase()}`,
    reason: decision.reason,
    buyTradeId: openTrade.id,
    sellTradeId,
    sellOrderFinal: sellPollResult.order,
    note: 'Sell did not fill. Buy row REMAINS OPEN. openLivePositions unchanged.',
  });
});

// ============================================================================
// POST /live/reconcile
//
// Sync local trade rows with actual Robinhood order state. READ-ONLY against
// Robinhood — no orders are placed. Does NOT require LIVE_TRADING_ENABLED:
// reconciliation is a recovery tool that must be available even when the
// kill switch is off (so a stuck row from a prior run can be cleaned up
// safely).
//
// Required state:
//   - Robinhood credentials configured (otherwise we have nothing to fetch).
//
// No body required. Bearer-auth applies via global middleware.
//
// Returns the full summary object from reconcileAll().
// ============================================================================
router.post('/reconcile', async (_req, res) => {
  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    return res.status(412).json({
      ok: false,
      code: 'ROBINHOOD_KEYS_MISSING',
      reason:
        'Robinhood credentials are not configured. Reconciliation requires read-only access to RH order state.',
    });
  }
  try {
    const summary = await reconcileAll();
    logger.info(
      {
        event: 'live.reconcile.complete',
        ordersChecked: summary.ordersChecked,
        rowsUpdated: summary.rowsUpdated,
        filledFound: summary.filledFound,
        cancelledFound: summary.cancelledFound,
        rejectedFound: summary.rejectedFound,
        partialFound: summary.partialFound,
        warningCount: summary.warnings.length,
      },
      'live reconcile complete',
    );
    return res.json({ ok: true, ...summary });
  } catch (err) {
    logger.error(
      { event: 'live.reconcile.fail', msg: err.message },
      `live reconcile failed: ${err.message}`,
    );
    return res.status(500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      reason: err.message,
    });
  }
});

module.exports = router;
