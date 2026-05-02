'use strict';

// Auth middleware for protected routes.
//
// Accepts EITHER:
//   1. A valid `Authorization: Bearer <BACKEND_API_KEY>` header (legacy /
//      machine clients / curl). This is how the local-dev frontend talks
//      to the local backend, and how scripts/cron/CI can hit the API.
//   2. A valid `tpai_admin` session cookie issued by /admin/login. This
//      is how the deployed admin frontend talks to Railway — no static
//      bearer token in the bundle.
//
// Either is sufficient. The handler does NOT require both.
//
// CRITICAL: the session-cookie path means /live/*, /trade/*, /scan, /ai/*
// are reachable to any browser holding a valid admin cookie — i.e. any
// browser that has POSTed a correct ADMIN_DASHBOARD_PASSWORD to /admin/login
// in the last 8 hours. The cookie is HttpOnly + Secure(prod) + SameSite=None
// so it cannot be read by JS and is sent only over HTTPS.
//
// `bearerAuth` is kept as the export name for backwards compatibility with
// the rest of the codebase that imports it.

const crypto = require('crypto');
const { config } = require('../config');
const {
  COOKIE_NAME,
  verifySessionToken,
} = require('../services/adminSession');

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Try the bearer-token path. Returns one of:
//   { ok: true }            — header present, token valid
//   { ok: false, reason }   — header present but token invalid
//   { ok: false, missing }  — no header at all (caller should try cookie)
function tryBearer(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return { ok: false, missing: true };
  const token = match[1].trim();
  if (!config.backendApiKey) {
    return { ok: false, reason: 'Backend not configured for bearer auth' };
  }
  if (!timingSafeEqualStr(token, config.backendApiKey)) {
    return { ok: false, reason: 'Invalid Bearer token' };
  }
  return { ok: true };
}

// Try the session-cookie path. cookie-parser must be mounted before this
// runs, otherwise req.cookies is undefined and we report missing.
function trySessionCookie(req) {
  const cookies = req.cookies || {};
  const token = cookies[COOKIE_NAME];
  if (!token) return { ok: false, missing: true };
  const payload = verifySessionToken(token);
  if (!payload) return { ok: false, reason: 'Invalid or expired session' };
  req.adminSession = payload;
  return { ok: true };
}

function bearerAuth(req, res, next) {
  const bearerResult = tryBearer(req);
  if (bearerResult.ok) return next();

  const cookieResult = trySessionCookie(req);
  if (cookieResult.ok) return next();

  // Neither method authenticated. Pick the most actionable error message:
  //   - if a bearer header was provided but invalid, surface that
  //   - if a cookie was provided but invalid/expired, surface that
  //   - else "Missing Bearer token" for backwards-compat with existing
  //     frontend describeError() handling
  let reason = 'Missing Bearer token';
  if (!bearerResult.missing) reason = bearerResult.reason;
  else if (!cookieResult.missing) reason = cookieResult.reason;

  return res
    .status(401)
    .json({ ok: false, code: 'UNAUTHENTICATED', reason });
}

module.exports = { bearerAuth };
