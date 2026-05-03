'use strict';

// liveRiskManager — validation pipeline for LIVE order requests.
//
// This is INTENTIONALLY a separate module from `riskManager.js` (which
// validates paper-mode trades). Live orders have stricter rules and the
// failure modes ("placed a real order I shouldn't have") are not the same
// shape as paper failures. Don't merge these.
//
// The pipeline short-circuits on the first failure. Order matters — kill
// switches and config checks come BEFORE database lookups, both for cost
// and so a misconfiguration cannot ever reach an order placement.

const db = require('../db');

const REQUIRED_FIELDS = [
  'recommendationId', // idempotency key, deduped against `trades`
  'symbol',
  'side',
  'usdAmount',
  'confirmedRealMoney', // explicit second-confirmation flag from the UI
];

function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * @param {object} req
 * @param {string} req.recommendationId
 * @param {string} req.symbol
 * @param {"buy"|"sell"} req.side
 * @param {number} req.usdAmount
 * @param {boolean} req.confirmedRealMoney  - MUST be true; UI renders a
 *   second checkbox the user has to tick before this can be sent.
 * @param {object} ctx
 * @param {object} ctx.config  - the loaded config object
 */
function evaluateLive(req, ctx) {
  const { config } = ctx;

  // ─── 1. HARD KILL SWITCH ────────────────────────────────────────────
  if (!config.liveTradingEnabled) {
    return fail(
      'LIVE_TRADING_DISABLED',
      'LIVE_TRADING_ENABLED is false. Set it to true and restart the backend ' +
        'to enable live orders. This is the global kill switch.',
    );
  }

  // ─── 2. CREDENTIAL PRESENCE ─────────────────────────────────────────
  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    return fail(
      'ROBINHOOD_KEYS_MISSING',
      'Robinhood credentials are not configured. Set ROBINHOOD_API_KEY and ' +
        'ROBINHOOD_PRIVATE_KEY before enabling live trading.',
    );
  }

  // ─── 3. PAYLOAD COMPLETENESS ────────────────────────────────────────
  for (const f of REQUIRED_FIELDS) {
    const v = req[f];
    if (v === undefined || v === null || v === '') {
      return fail('MISSING_FIELDS', `Missing required field: ${f}`);
    }
  }

  // ─── 4. EXPLICIT REAL-MONEY CONFIRMATION ────────────────────────────
  // The frontend renders a checkbox the user must tick before the button
  // becomes clickable; the server insists on seeing the boolean true.
  if (req.confirmedRealMoney !== true) {
    return fail(
      'CONFIRMATION_MISSING',
      'Order rejected: confirmedRealMoney must be exactly true. ' +
        'The user must explicitly acknowledge this is a real-money order.',
    );
  }

  // ─── 5. SIDE WHITE-LIST ─────────────────────────────────────────────
  if (req.side !== 'buy' && req.side !== 'sell') {
    return fail('INVALID_SIDE', `side must be 'buy' or 'sell', got '${req.side}'`);
  }

  // ─── 6. SYMBOL ALLOW-LIST (Phase-3 narrow: ETH-USD only) ────────────
  if (!config.liveAllowedSymbols.includes(req.symbol)) {
    return fail(
      'SYMBOL_NOT_ALLOWED_LIVE',
      `Symbol '${req.symbol}' is not in LIVE_ALLOWED_SYMBOLS ` +
        `(${config.liveAllowedSymbols.join(', ')}). Phase 3 is ETH-only.`,
    );
  }

  // ─── 7. USD-NOTIONAL CAP ────────────────────────────────────────────
  if (
    !Number.isFinite(req.usdAmount) ||
    req.usdAmount <= 0 ||
    req.usdAmount > config.liveMaxOrderUsd
  ) {
    return fail(
      'AMOUNT_OUT_OF_RANGE',
      `usdAmount must be > 0 and <= LIVE_MAX_ORDER_USD ($${config.liveMaxOrderUsd}). ` +
        `Got $${req.usdAmount}.`,
    );
  }

  // ─── 8. DAILY LIVE LOSS CAP ─────────────────────────────────────────
  // Sums today's realized PnL across LIVE trades only. Paper losses do not
  // count against this cap.
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
  const lossUsd = Math.abs(lossRow.loss || 0);
  if (lossUsd >= config.liveDailyLossCapUsd) {
    return fail(
      'DAILY_LOSS_CAP_HIT',
      `Today's live realized losses ($${lossUsd.toFixed(2)}) >= ` +
        `LIVE_DAILY_LOSS_CAP_USD ($${config.liveDailyLossCapUsd}). ` +
        'No new live orders today.',
    );
  }

  // ─── 9. DAILY LIVE TRADE COUNT CAP ──────────────────────────────────
  // Hard cap on the number of live BUY orders that can hit Robinhood in a
  // single UTC calendar day. Counted across executed and pending_approval
  // rows so a flood of bot proposals can't sneak past by sitting in the
  // queue and then being approved en masse.
  if (req.side === 'buy') {
    const countRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM trades
          WHERE mode = 'live'
            AND side = 'buy'
            AND status IN ('executed', 'pending_approval')
            AND date(created_at) = date('now')`,
      )
      .get();
    const todayCount = countRow.n || 0;
    if (todayCount >= config.liveDailyTradeCountCap) {
      return fail(
        'DAILY_TRADE_COUNT_CAP_HIT',
        `Today's live BUY count (${todayCount}) >= LIVE_DAILY_TRADE_COUNT_CAP ` +
          `(${config.liveDailyTradeCountCap}). No more live orders today. ` +
          'This cap counts both executed and pending_approval rows.',
      );
    }
  }

  // ─── 10. ONE OPEN LIVE POSITION MAX ─────────────────────────────────
  // Only BUY rows count as open positions. SELL rows are exits — a pending
  // or partial sell has its own outcome bookkeeping and must not be confused
  // with the position state.
  const openRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
        WHERE mode = 'live'
          AND status = 'executed'
          AND side = 'buy'
          AND outcome IS NULL`,
    )
    .get();
  if ((openRow.n || 0) >= 1) {
    return fail(
      'OPEN_POSITION_EXISTS',
      'There is already an open live position. Phase 3 enforces a one-at-a-time ' +
        'limit. Close the existing position before placing another live order.',
    );
  }

  // ─── 10. IDEMPOTENCY: dedupe by recommendationId ────────────────────
  const dup = db
    .prepare('SELECT 1 FROM trades WHERE recommendation_id = ?')
    .get(req.recommendationId);
  if (dup) {
    return fail(
      'DUPLICATE_RECOMMENDATION',
      `recommendationId '${req.recommendationId}' has already been processed. ` +
        'Generate a fresh id before retrying.',
    );
  }

  return { ok: true };
}

module.exports = { evaluateLive, REQUIRED_FIELDS };
