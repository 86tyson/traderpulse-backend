'use strict';

// /ai — read-only AI assistant for account/trade questions.
//
// SAFETY:
//   - Bearer-auth via global middleware (same as every other protected route).
//   - Rate-limited (20/min) to prevent runaway LLM bills.
//   - This route NEVER calls /live/approve, /live/close, robinhoodClient.placeOrder,
//     or any other write endpoint. The only outbound calls are read-only RH
//     fetches (account/holdings/quote/orders) plus a local DB read (trades).
//   - The AI receives an explicit cherry-picked context — keys/secrets cannot
//     reach the model.
//   - A trade-intent regex gate refuses prompts before any LLM round trip.

const express = require('express');
const rateLimit = require('express-rate-limit');

const { config } = require('../config');
const { validateBody, aiChatSchema } = require('../middleware/validate');
const robinhood = require('../services/robinhoodClient');
const { askAi, buildAiContext } = require('../services/aiAssistant');
const logger = require('../services/logger');
const db = require('../db');

const router = express.Router();

// Tighter than /live (60/min) — each call may hit the LLM provider.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'RATE_LIMITED',
    reason: 'Too many AI requests in the last minute.',
  },
});
router.use(aiLimiter);

// ----- Helpers -----

async function safeFetch(label, fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    logger.warn(
      { event: `ai.${label}.fail`, code: err.code, msg: err.message },
      `ai context fetch failed (${label})`,
    );
    return { ok: false, error: err.message };
  }
}

function readLocalTrades() {
  // Last 50 trades; the AI context builder will further trim to 10. We pull
  // 50 so the route handler can also surface aggregate counts.
  return db
    .prepare(
      `SELECT id, recommendation_id, symbol, side, status, mode, outcome,
              simulated_pnl_usd, entry_price, exit_price, filled_quantity,
              created_at, exit_timestamp
         FROM trades
        ORDER BY id DESC
        LIMIT 50`,
    )
    .all();
}

function liveStatusSummary() {
  // Same shape as GET /live/status — built locally without an HTTP hop.
  const lossRow = db
    .prepare(
      `SELECT COALESCE(SUM(simulated_pnl_usd), 0) AS loss
         FROM trades
        WHERE date(created_at) = date('now')
          AND mode = 'live'
          AND simulated_pnl_usd IS NOT NULL
          AND simulated_pnl_usd < 0`,
    )
    .get();
  const openRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
        WHERE mode='live' AND status='executed' AND side='buy' AND outcome IS NULL`,
    )
    .get();
  return {
    paperMode: config.paperMode,
    botEnabled: config.botEnabled,
    requireApproval: config.requireApproval,
    liveTradingEnabled: config.liveTradingEnabled,
    robinhoodConnected: !!(config.robinhoodApiKey && config.robinhoodPrivateKey),
    caps: {
      maxOrderUsd: config.liveMaxOrderUsd,
      dailyLossCapUsd: config.liveDailyLossCapUsd,
      allowedSymbols: config.liveAllowedSymbols,
    },
    today: {
      liveRealizedLossUsd: Math.abs(lossRow.loss || 0),
      openLivePositions: openRow.n || 0,
    },
  };
}

// ----- POST /ai/account-chat -----

router.post('/account-chat', validateBody(aiChatSchema), async (req, res) => {
  const { message } = req.validBody;
  const startedAt = Date.now();

  // Build the AI context. We READ from RH where credentials exist, and from
  // the local DB. We never WRITE anything anywhere as part of this handler.
  const liveStatus = liveStatusSummary();

  // Robinhood reads run in parallel; partial failures do not block the call.
  // (E.g. if RH is unreachable, we still answer using local data.)
  const rhConnected = liveStatus.robinhoodConnected;
  const [accountRes, holdingsRes, quoteRes, ordersRes] = await Promise.all([
    rhConnected ? safeFetch('account', () => robinhood.getAccount()) : Promise.resolve({ ok: false, error: 'RH not configured' }),
    rhConnected ? safeFetch('holdings', () => robinhood.getHoldings()) : Promise.resolve({ ok: false, error: 'RH not configured' }),
    rhConnected ? safeFetch('quote', () => robinhood.getQuote('ETH-USD')) : Promise.resolve({ ok: false, error: 'RH not configured' }),
    rhConnected ? safeFetch('orders', () => robinhood.getOrders()) : Promise.resolve({ ok: false, error: 'RH not configured' }),
  ]);

  let trades = [];
  try {
    trades = readLocalTrades();
  } catch (err) {
    logger.warn(
      { event: 'ai.local_trades.fail', msg: err.message },
      'reading local trades failed',
    );
  }

  const context = buildAiContext({
    liveStatus,
    account: accountRes.ok ? accountRes.data : null,
    holdings: holdingsRes.ok ? holdingsRes.data : null,
    quote: quoteRes.ok ? quoteRes.data : null,
    orders: ordersRes.ok ? ordersRes.data : null,
    trades,
  });

  // Pino-safe logging — no message contents (privacy), no context body, no
  // credentials. Just sizes.
  logger.info(
    {
      event: 'ai.account-chat.start',
      msgLen: message.length,
      contextKeys: Object.keys(context),
      tradesCount: trades.length,
      rhFetches: {
        account: accountRes.ok,
        holdings: holdingsRes.ok,
        quote: quoteRes.ok,
        orders: ordersRes.ok,
      },
    },
    'ai chat request',
  );

  let result;
  try {
    result = await askAi({ userMessage: message, context });
  } catch (err) {
    logger.error(
      { event: 'ai.account-chat.fail', msg: err.message },
      `ai chat failed: ${err.message}`,
    );
    return res.status(500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      reason:
        'Account assistant is temporarily unavailable. Read-only dashboard data is still accessible.',
    });
  }

  const durationMs = Date.now() - startedAt;
  logger.info(
    {
      event: 'ai.account-chat.complete',
      source: result.source,
      answerLen: result.answer.length,
      durationMs,
    },
    'ai chat complete',
  );

  return res.json({
    ok: true,
    answer: result.answer,
    source: result.source,
    durationMs,
    contextKeys: Object.keys(context),
    rhFetches: {
      account: accountRes.ok,
      holdings: holdingsRes.ok,
      quote: quoteRes.ok,
      orders: ordersRes.ok,
    },
  });
});

module.exports = router;
