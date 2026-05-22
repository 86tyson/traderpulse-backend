'use strict';

// notifier — operator push-notification dispatcher.
//
// Routes through Pushover (https://pushover.net). Pushover was chosen
// over SMS because the operator and the recipients are the same person,
// which obviates the A2P 10DLC compliance overhead and avoids entangling
// personal trading alerts with the operator's separate business identity
// (Tyson Insulation S-Corp) registered on the legacy Twilio account.
//
// Interface is intentionally identical to the legacy smsAlerts module so
// callers (scanner.js, autoTrader.js, admin routes) port with a single-
// import swap:
//
//   sendPendingApprovalAlert(rec)  → Promise<{sent, reason?, results}>
//   getStatus()                    → snapshot for /admin/notify/status
//
// Quiet-hours: NONE here. Pushover's mobile app has its own Quiet Hours
// setting (Settings → Quiet Hours) per device. We always submit; the
// app decides local delivery suppression. This is the right boundary —
// every recipient is also the configurator.
//
// Pushover API: https://pushover.net/api
//
// Request shape (POST application/x-www-form-urlencoded):
//   token=<APP_TOKEN>
//   user=<USER_KEY>                  recipient (one per request)
//   message=<body>                   ≤ 1024 chars
//   title=<optional>
//   priority=<-2..2, default 0>
//   sound=<optional>                 e.g. 'pushover' (default), 'cashregister', 'siren'
//   url=<optional>                   deep-link
//   url_title=<optional>             link label
//
// Response shape:
//   { status: 1, request: <uuid> }                  — success
//   { status: 0, errors: [...], request: <uuid> }   — failure (HTTP 4xx)
//   { status: 1, info: "no active devices..." }    — creds valid, no device registered

const { config } = require('../config');
const logger = require('./logger');

const PUSHOVER_API_URL = 'https://api.pushover.net/1/messages.json';
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 1024;

function isReady() {
  if (!config.pushoverEnabled) {
    return { ok: false, reason: 'PUSHOVER_ENABLED is false' };
  }
  if (!config.pushoverAppToken) {
    return { ok: false, reason: 'PUSHOVER_APP_TOKEN missing' };
  }
  if (!config.pushoverUserKey) {
    return { ok: false, reason: 'PUSHOVER_USER_KEY missing' };
  }
  return { ok: true };
}

function getUserKeys() {
  const out = [];
  const seen = new Set();
  for (const k of [config.pushoverUserKey, config.pushoverUserKey2]) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function maskKey(k) {
  if (!k || typeof k !== 'string') return null;
  if (k.length <= 6) return '***';
  return `${k.slice(0, 3)}***${k.slice(-3)}`;
}

function buildBody(rec) {
  const sym = rec?.symbol || 'UNKNOWN';
  const side = (rec?.side || '?').toUpperCase();
  const usd = Number(rec?.suggestedAmountUsd ?? rec?.amountUsd);
  const usdStr = Number.isFinite(usd) ? `$${usd.toFixed(2)}` : null;
  const conf = Number(rec?.confidenceScore);
  const confStr = Number.isFinite(conf) ? `${(conf * 100).toFixed(0)}%` : null;
  const refPrice = Number(rec?.entryPrice ?? rec?.refPrice ?? rec?.markPrice);
  const priceStr = Number.isFinite(refPrice) ? `~$${refPrice.toFixed(2)}` : null;
  const reason = typeof rec?.entryReason === 'string'
    ? rec.entryReason.slice(0, 240)
    : null;
  const parts = [
    `${sym} ${side}`,
    usdStr,
    confStr ? `conf ${confStr}` : null,
    priceStr,
    reason,
  ].filter(Boolean);
  // Middle-dot (·) is preserved in Pushover (UTF-8 native, no SMS segment
  // tax). Reads cleaner than hyphens for the multi-field info layout.
  return parts.join(' · ').slice(0, MAX_BODY_CHARS);
}

function buildTitle(rec) {
  const reason = typeof rec?.entryReason === 'string' ? rec.entryReason : '';
  // autoTrader prefixes its post-execution rec with "AUTO-TRADED · ...".
  // Pre-execution / pending-approval messages have no such prefix.
  if (reason.startsWith('AUTO-TRADED')) {
    return 'Trader Pulse — AUTO trade fired';
  }
  return 'Trader Pulse — pending approval';
}

function chooseSoundAndPriority(rec) {
  const reason = typeof rec?.entryReason === 'string' ? rec.entryReason : '';
  // AUTO-trades: priority 1 (high) + 'cashregister' sound — distinct from
  // pending approvals so the operator can audibly tell them apart without
  // reading the screen.
  if (reason.startsWith('AUTO-TRADED')) {
    return { priority: 1, sound: 'cashregister' };
  }
  // Pending approvals: priority 1 + default sound. Wants attention but
  // doesn't override quiet hours / Do-Not-Disturb (would need priority 2,
  // which requires acknowledgement and is too noisy for routine signals).
  return { priority: 1, sound: 'pushover' };
}

async function sendOne(userKey, body, title, priority, sound) {
  const params = new URLSearchParams();
  params.set('token', config.pushoverAppToken);
  params.set('user', userKey);
  params.set('message', body);
  params.set('title', title);
  params.set('priority', String(priority));
  if (sound) params.set('sound', sound);
  params.set('url', 'https://admin.traderpulseai.com');
  params.set('url_title', 'Open Trader Pulse');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(PUSHOVER_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: ctrl.signal,
    });
    let json = {};
    try { json = await res.json(); } catch (_) { /* non-JSON body */ }
    const apiOk = res.ok && json && json.status === 1;
    if (!apiOk) {
      return {
        user: maskKey(userKey),
        sent: false,
        reason: (json.errors && json.errors.join('; ')) || `HTTP ${res.status}`,
        httpStatus: res.status,
      };
    }
    // status:1 + info "no active devices" means credentials are valid but
    // no phone is registered. Surface as a non-fatal warning, not success.
    if (json.info) {
      return {
        user: maskKey(userKey),
        sent: false,
        reason: json.info,
        warning: true,
        request: json.request || null,
      };
    }
    return {
      user: maskKey(userKey),
      sent: true,
      request: json.request || null,
    };
  } catch (err) {
    return {
      user: maskKey(userKey),
      sent: false,
      reason: (err && err.message) || String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Send a notification for a queued (Assisted) or just-executed (Auto)
 * recommendation. NEVER throws — all errors are caught and surfaced in
 * the per-recipient `results` array. Return shape matches the legacy
 * smsAlerts module so callers do not need to be rewritten.
 *
 * @param {object} rec — recommendation row. Shape matches what scanner.js
 *   and autoTrader.js already construct:
 *   { recommendationId, symbol, side, suggestedAmountUsd, confidenceScore,
 *     entryReason, entryPrice }
 */
async function sendPendingApprovalAlert(rec) {
  const ready = isReady();
  if (!ready.ok) {
    logger.info(
      { event: 'notify.skipped', reason: ready.reason },
      `notify skipped: ${ready.reason}`,
    );
    return { sent: false, reason: ready.reason, results: [] };
  }
  const keys = getUserKeys();
  if (keys.length === 0) {
    return { sent: false, reason: 'no recipients configured', results: [] };
  }

  const body = buildBody(rec);
  const title = buildTitle(rec);
  const { priority, sound } = chooseSoundAndPriority(rec);

  const settled = await Promise.allSettled(
    keys.map((k) => sendOne(k, body, title, priority, sound)),
  );
  const results = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          user: maskKey(keys[i]),
          sent: false,
          reason: 'unhandled_exception',
        },
  );
  const anySent = results.some((r) => r.sent);
  if (anySent) {
    logger.info(
      { event: 'notify.sent', okCount: results.filter((r) => r.sent).length, results },
      'notify sent',
    );
  } else {
    logger.warn(
      { event: 'notify.failed', count: results.length, results },
      'no notify recipients succeeded',
    );
  }
  return { sent: anySent, results };
}

/**
 * Read-only status for the admin UI. Never echoes secrets — both the
 * App Token and User Keys are masked. Does NOT make a network call.
 */
function getStatus() {
  const ready = isReady();
  return {
    provider: 'pushover',
    enabled: !!config.pushoverEnabled,
    configured: ready.ok,
    skipReason: ready.ok ? null : ready.reason,
    appTokenMasked: maskKey(config.pushoverAppToken),
    userKeysMasked: getUserKeys().map(maskKey),
    userKeyCount: getUserKeys().length,
  };
}

module.exports = { sendPendingApprovalAlert, getStatus };
