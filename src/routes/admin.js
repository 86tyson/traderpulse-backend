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
const logger = require('../services/logger');

const router = express.Router();

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

module.exports = router;
