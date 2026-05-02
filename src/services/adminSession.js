'use strict';

// Admin session — stateless HMAC-signed cookie.
//
// The cookie payload is a small JSON blob ({iat, exp}) base64url-encoded,
// followed by a "." separator, followed by the base64url-encoded HMAC-SHA256
// signature of the payload using SESSION_SECRET. No DB lookups, no state on
// the server — verification is a single HMAC compare.
//
// Defense:
//   - HMAC ensures the cookie cannot be forged without SESSION_SECRET.
//   - Expiry inside the signed payload (not just Max-Age) means a stolen
//     cookie can't be replayed past `exp` even if the browser ignores
//     Max-Age.
//   - Constant-time compare on the signature.
//
// Rotating SESSION_SECRET invalidates all existing sessions immediately.
//
// Cookies are HttpOnly + Secure(prod) + SameSite=None(prod) / Lax(dev).
// Path is "/" so any /admin/* or /live/* request carries the cookie.

const crypto = require('crypto');
const { config } = require('../config');

const COOKIE_NAME = 'tpai_admin';
// 8 hours — short enough that a leaked cookie has limited useful life,
// long enough to avoid logging admins out mid-session.
const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    str.length + ((4 - (str.length % 4)) % 4),
    '=',
  );
  return Buffer.from(padded, 'base64');
}

function sign(payloadStr, secret) {
  return crypto.createHmac('sha256', secret).update(payloadStr).digest();
}

// Issue a fresh signed session cookie value.
function createSessionToken({ ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!config.sessionSecret) {
    throw new Error(
      'SESSION_SECRET is not configured; refusing to issue admin session.',
    );
  }
  const now = Date.now();
  const payload = { iat: now, exp: now + ttlMs };
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = b64urlEncode(payloadStr);
  const sig = sign(payloadB64, config.sessionSecret);
  return `${payloadB64}.${b64urlEncode(sig)}`;
}

// Verify a cookie value. Returns the parsed payload on success, null otherwise.
// Never throws on malformed input — treats every failure mode as "not authed."
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  if (!config.sessionSecret) return null;

  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (!payloadB64 || !sigB64) return null;

  let providedSig;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return null;
  }

  const expectedSig = sign(payloadB64, config.sessionSecret);
  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(providedSig, expectedSig)
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return null;
  }
  if (Date.now() >= payload.exp) return null;
  return payload;
}

// Cookie attributes appropriate for the runtime.
//   - production (NODE_ENV=production): SameSite=None + Secure
//     so that admin.traderpulseai.com (Vercel) can include the cookie on
//     cross-site requests to web-production-27b6e.up.railway.app.
//   - other (dev/test): SameSite=Lax + non-secure so localhost:8080 →
//     localhost:3001 works without HTTPS in dev.
//
// HttpOnly is always on. JS in the bundle never touches the cookie.
function cookieOptions({ ttlMs = DEFAULT_TTL_MS, clear = false } = {}) {
  const isProd = config.nodeEnv === 'production';
  const opts = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  };
  if (clear) {
    opts.maxAge = 0;
    opts.expires = new Date(0);
  } else {
    opts.maxAge = ttlMs;
  }
  return opts;
}

// Constant-time password compare. Empty configured password always fails.
function verifyPassword(supplied) {
  const expected = config.adminDashboardPassword || '';
  if (!expected) return false;
  if (typeof supplied !== 'string') return false;
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_MS,
  createSessionToken,
  verifySessionToken,
  cookieOptions,
  verifyPassword,
};
