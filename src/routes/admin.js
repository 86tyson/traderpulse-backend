'use strict';

// /admin/* — session-cookie auth for the admin dashboard.
//
// FLOW:
//   1. Admin frontend POSTs { password } to /admin/login.
//   2. Backend constant-time-compares against ADMIN_DASHBOARD_PASSWORD env.
//   3. On match: HMAC-signs a short payload {iat, exp} with SESSION_SECRET
//      and sets it as an HttpOnly cookie. Cookie is Secure+SameSite=None in
//      production (cross-site Vercel→Railway), Lax in dev (same-site
//      localhost). HttpOnly means the bundle JS cannot read the cookie.
//   4. Browser sends the cookie automatically with every subsequent
//      same-eTLD+1 request that includes credentials: 'include'.
//   5. /admin/me re-checks the cookie and reports authentication state.
//      The frontend uses this to render either the dashboard or the
//      login form on initial load.
//   6. /admin/logout clears the cookie.
//
// SECURITY:
//   - The cookie carries no user data; just iat/exp + signature. Forging it
//     requires knowledge of SESSION_SECRET (which lives only in Railway env).
//   - Login is rate-limited (5 attempts / 15 min / IP) to slow brute force.
//   - Password is constant-time-compared; timing attacks won't help.
//   - We never echo the password back, never log it, never include it in
//     errors.

const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  cookieOptions,
  verifyPassword,
} = require('../services/adminSession');
const tradingMode = require('../services/tradingMode');
const strategyMode = require('../services/strategyMode');
const recommendationQueue = require('../services/recommendationQueue');
const liveRiskManager = require('../services/liveRiskManager');
const robinhood = require('../services/robinhoodClient');
const tradeLogger = require('../services/tradeLogger');
const botLoop = require('../services/botLoop');
const notifier = require('../services/notifier');
const { config } = require('../config');
const logger = require('../services/logger');

const router = express.Router();

// requireAdminSession — middleware that gates downstream /admin/* routes
// behind a valid session cookie. Login/logout/me are intentionally public
// (login obviously can't require auth; me reports state for both authed
// and unauthed callers; logout is idempotent and always 200).
function requireAdminSession(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = verifySessionToken(token);
  if (!payload) {
    return res.status(401).json({
      ok: false,
      code: 'UNAUTHENTICATED',
      reason: 'Admin session required.',
    });
  }
  req.adminSession = payload;
  next();
}

// Strict limiter just for /admin/login — 5 attempts per 15 minutes per IP.
// Anything getting throttled here is almost certainly automated.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    code: 'RATE_LIMITED',
    reason: 'Too many login attempts. Try again in 15 minutes.',
  },
});

// POST /admin/login  { password: string }
router.post('/login', loginLimiter, (req, res) => {
  const supplied = req.body?.password;
  if (typeof supplied !== 'string' || supplied.length === 0) {
    return res
      .status(400)
      .json({ ok: false, code: 'INVALID_BODY', reason: 'password required' });
  }

  if (!verifyPassword(supplied)) {
    // Log without the supplied value. The IP is informative enough.
    logger.warn(
      { event: 'admin.login.fail', ip: req.ip },
      'admin login failed',
    );
    return res
      .status(401)
      .json({ ok: false, code: 'UNAUTHENTICATED', reason: 'Invalid password' });
  }

  let token;
  try {
    token = createSessionToken();
  } catch (err) {
    logger.error(
      { event: 'admin.login.config_fail', msg: err.message },
      'admin session token creation failed',
    );
    return res.status(500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      reason: 'Session subsystem misconfigured.',
    });
  }

  res.cookie(COOKIE_NAME, token, cookieOptions());
  logger.info({ event: 'admin.login.ok', ip: req.ip }, 'admin login ok');
  return res.json({ ok: true, authenticated: true });
});

// POST /admin/logout — idempotent; clears cookie regardless of current state.
router.post('/logout', (req, res) => {
  res.cookie(COOKIE_NAME, '', cookieOptions({ clear: true }));
  logger.info({ event: 'admin.logout', ip: req.ip }, 'admin logout');
  return res.json({ ok: true });
});

// GET /admin/me — returns the current auth state. Always 200 so the frontend
// can render conditionally without dealing with throws on initial load.
router.get('/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  const payload = verifySessionToken(token);
  if (!payload) {
    return res.json({ ok: true, authenticated: false });
  }
  return res.json({
    ok: true,
    authenticated: true,
    expiresAt: new Date(payload.exp).toISOString(),
    issuedAt: new Date(payload.iat).toISOString(),
  });
});

// ----- Trading mode (admin-controlled runtime switch) -----
// All routes below are session-protected. Bearer tokens are NOT accepted
// for mode changes — operators with bearer creds (curl/scripts) must use
// the env vars on Railway as the mode-changing mechanism, not these
// runtime-mutable routes. Cookie-only ensures every change has a logged-in
// admin attached.

// GET /admin/mode — current mode + env ceilings + capability flags.
router.get('/mode', requireAdminSession, (_req, res) => {
  return res.json({ ok: true, ...tradingMode.getModeStatus() });
});

// POST /admin/mode  { mode: 'paused' | 'assisted' | 'auto', reason?: string }
// Mode 'auto' is rejected with NOT_IMPLEMENTED in this build. Mode change
// failures are reported with a stable code; the frontend translates these.
router.post('/mode', requireAdminSession, (req, res) => {
  const { mode, reason } = req.body || {};
  if (typeof mode !== 'string') {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_BODY',
      reason: "body must include { mode: 'paused' | 'assisted' | 'auto' }",
    });
  }
  const result = tradingMode.setMode(mode, {
    actor: `admin-session:${req.adminSession.iat}`,
    reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
  });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.json({ ok: true, ...tradingMode.getModeStatus(), unchanged: !!result.unchanged });
});

// GET /admin/mode/log?limit=N — recent mode changes (audit trail).
router.get('/mode/log', requireAdminSession, (req, res) => {
  const limit = Number(req.query.limit) || 20;
  return res.json({ ok: true, changes: tradingMode.recentChanges(limit) });
});

// ----- Strategy mode (which strategy the bot loop runs) -----
// Distinct from `tradingMode` (paused/assisted/auto). Two modes available:
//   'default'           — locked 1H pullback scanner (existing behavior)
//   'soloway_playbook'  — confluence-support pullback with stricter rules
// Both produce recommendations only — no order placement bypass exists.
// All admin routes here are session-protected.

router.get('/strategy-mode', requireAdminSession, (_req, res) => {
  return res.json({ ok: true, ...strategyMode.getStatus() });
});

router.post('/strategy-mode', requireAdminSession, (req, res) => {
  const { mode, reason } = req.body || {};
  if (typeof mode !== 'string') {
    return res.status(400).json({
      ok: false,
      code: 'INVALID_BODY',
      reason: "body must include { mode: 'default' | 'soloway_playbook' }",
    });
  }
  const result = strategyMode.setMode(mode, {
    actor: `admin-session:${req.adminSession.iat}`,
    reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
  });
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.json({ ok: true, ...strategyMode.getStatus(), unchanged: !!result.unchanged });
});

// GET /admin/bot-loop — runtime status of the scheduled scan-and-queue loop.
// Read-only; loop is started by server.js at boot and configured purely via
// env (BOT_LOOP_INTERVAL_MIN, BOT_ENABLED, LIVE_TRADING_ENABLED) plus the
// runtime tradingMode. There is intentionally NO POST endpoint to start /
// stop the loop from the UI — that would let a compromised admin session
// turn the bot on; env-only ensures the loop's existence is a deploy
// decision, not a session-level decision.
router.get('/bot-loop', requireAdminSession, (_req, res) => {
  return res.json({ ok: true, ...botLoop.getStatus() });
});

// ----- Operator notifications: status + manual test -----
// As of 2026-05 we route through Pushover instead of Twilio SMS — see
// src/services/notifier.js. The /sms/* paths are kept as ALIASES for the
// /notify/* paths so any existing DevTools console snippets or scripts
// don't 404. Both paths return the same payloads.

function notifyStatusHandler(_req, res) {
  return res.json({ ok: true, ...notifier.getStatus() });
}

async function notifyTestHandler(_req, res) {
  const fakeRec = {
    recommendationId: `TEST-${Date.now()}`,
    symbol: 'ETH-USD',
    side: 'buy',
    suggestedAmountUsd: 10,
    confidenceScore: 0.99,
    entryReason: 'TEST ALERT — ignore. Manual /admin/notify/test invocation.',
    entryPrice: 0,
  };
  try {
    const result = await notifier.sendPendingApprovalAlert(fakeRec);
    logger.info(
      { event: 'notify.test.invoked', sent: result.sent, reason: result.reason || null },
      `notify test invoked: sent=${result.sent}`,
    );
    return res.json({ ok: true, ...result });
  } catch (err) {
    // sendPendingApprovalAlert is documented to never throw, but belt-and-
    // suspenders for future refactors.
    logger.error(
      { event: 'notify.test.error', msg: err && err.message },
      'notify test threw unexpectedly',
    );
    return res
      .status(500)
      .json({ ok: false, code: 'NOTIFY_TEST_FAILED', reason: err && err.message });
  }
}

// Canonical paths.
router.get('/notify/status', requireAdminSession, notifyStatusHandler);
router.post('/notify/test', requireAdminSession, notifyTestHandler);
// Legacy aliases — same handlers, kept for any cached frontend / console
// snippets pointing at /admin/sms/*.
router.get('/sms/status', requireAdminSession, notifyStatusHandler);
router.post('/sms/test', requireAdminSession, notifyTestHandler);

// ----- Pending recommendation queue -----
// Bot-proposed trades waiting for admin approval. Populated by /scan when
// tradingMode='assisted'. Emptied via /:id/approve (places a real order)
// or /:id/decline (audit-only rejection).

// GET /admin/recommendations?limit=N — list pending rows.
router.get('/recommendations', requireAdminSession, (req, res) => {
  const limit = Number(req.query.limit) || 50;
  return res.json({ ok: true, recommendations: recommendationQueue.listPending(limit) });
});

// POST /admin/recommendations/:id/decline  { reason?: string }
// Marks the row 'rejected' and writes a decision row. Idempotent — declining
// a non-pending row returns NOT_FOUND so the UI can surface it.
router.post('/recommendations/:id/decline', requireAdminSession, (req, res) => {
  const id = Number(req.params.id);
  const reason =
    typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : 'admin declined';

  const row = recommendationQueue.getPendingById(id);
  if (!row) {
    return res.status(404).json({
      ok: false,
      code: 'NOT_FOUND',
      reason: `No pending recommendation with id ${id}`,
    });
  }

  const ok = recommendationQueue.decline(id);
  if (!ok) {
    // Race: someone else just transitioned it. Treat as not found.
    return res.status(409).json({
      ok: false,
      code: 'CONFLICT',
      reason: 'Recommendation is no longer pending.',
    });
  }
  tradeLogger.recordDecision({
    recommendationId: row.recommendationId,
    decision: 'declined',
    reason,
    code: null,
  });
  logger.info(
    {
      event: 'admin.recommendation.declined',
      id,
      recommendationId: row.recommendationId,
      actor: `admin-session:${req.adminSession.iat}`,
    },
    'recommendation declined',
  );
  return res.json({ ok: true, id, status: 'rejected' });
});

// POST /admin/recommendations/:id/approve  { confirmedRealMoney: true }
// Wraps the existing /live/approve risk pipeline + RH placement. Re-uses
// every safety gate in liveRiskManager.evaluateLive — symbol allow-list,
// USD cap, daily loss cap, daily count cap, one-position-max, idempotency.
// On success, the row's status flips to 'executed' and the RH order id is
// recorded. On any gate failure, the row stays 'pending_approval' and the
// failure is reported via response code (admin can retry or decline).
router.post('/recommendations/:id/approve', requireAdminSession, async (req, res) => {
  const id = Number(req.params.id);
  const confirmedRealMoney = req.body?.confirmedRealMoney === true;

  const row = recommendationQueue.getPendingById(id);
  if (!row) {
    return res.status(404).json({
      ok: false,
      code: 'NOT_FOUND',
      reason: `No pending recommendation with id ${id}`,
    });
  }

  if (!confirmedRealMoney) {
    return res.status(400).json({
      ok: false,
      code: 'CONFIRMATION_MISSING',
      reason:
        'confirmedRealMoney must be exactly true. The admin must explicitly ' +
        'acknowledge this is a real-money order.',
    });
  }

  // Build the live-approve payload from the queued row. The recommendation_id
  // is already unique in `trades`, but liveRiskManager dedupes by it again,
  // which would now hit the queued row itself. Re-use a derived key to
  // bypass that check while keeping idempotency on subsequent retries.
  const liveRequest = {
    recommendationId: `${row.recommendationId}::approve`,
    symbol: row.symbol,
    side: row.side,
    usdAmount: row.suggestedAmountUsd,
    confirmedRealMoney: true,
  };

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
        event: 'admin.recommendation.approve.rejected',
        id,
        recommendationId: row.recommendationId,
        code: verdict.code,
        actor: `admin-session:${req.adminSession.iat}`,
      },
      `approve rejected at risk gate: ${verdict.code}`,
    );
    return res.status(400).json({
      ok: false,
      status: 'rejected',
      code: verdict.code,
      reason: verdict.reason,
    });
  }

  // Fetch quote to compute crypto qty. Same pattern as /live/approve.
  let quote;
  try {
    quote = await robinhood.getQuote(row.symbol);
  } catch (err) {
    logger.error(
      {
        event: 'admin.recommendation.approve.quote_fail',
        id,
        recommendationId: row.recommendationId,
        code: err.code,
      },
      `quote fetch failed: ${err.message}`,
    );
    return res.status(502).json({
      ok: false,
      code: err.code || 'ROBINHOOD_API_FAILED',
      reason: `Could not fetch live quote: ${err.message}`,
    });
  }

  const quoteResult = quote?.results?.[0];
  const refPrice = Number(quoteResult?.ask_inclusive_of_buy_spread ?? quoteResult?.price);
  if (!Number.isFinite(refPrice) || refPrice <= 0) {
    logger.error(
      {
        event: 'admin.recommendation.approve.quote_parse_fail',
        id,
        recommendationId: row.recommendationId,
      },
      'quote response missing usable price',
    );
    return res.status(502).json({
      ok: false,
      code: 'ROBINHOOD_API_FAILED',
      reason: 'Quote response did not contain a usable price.',
    });
  }
  const cryptoQty = row.suggestedAmountUsd / refPrice;

  // Place the order. robinhoodClient.placeOrder also re-checks the kill switch.
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
        event: 'admin.recommendation.approve.place_fail',
        id,
        recommendationId: row.recommendationId,
        code: err.code,
        msg: err.message,
      },
      `placeOrder failed: ${err.message}`,
    );
    return res.status(502).json({
      ok: false,
      code: err.code || 'ROBINHOOD_API_FAILED',
      reason: err.message,
    });
  }

  recommendationQueue.markExecuted(id, {
    robinhoodOrderId: placeResult?.id || null,
    response: placeResult,
  });
  logger.info(
    {
      event: 'admin.recommendation.approved',
      id,
      recommendationId: row.recommendationId,
      symbol: row.symbol,
      side: row.side,
      amountUsd: row.suggestedAmountUsd,
      robinhoodOrderId: placeResult?.id || null,
      actor: `admin-session:${req.adminSession.iat}`,
    },
    'recommendation approved + order placed',
  );

  return res.json({
    ok: true,
    id,
    status: 'executed',
    robinhoodOrderId: placeResult?.id || null,
    refPrice,
    cryptoQty,
  });
});

module.exports = router;
