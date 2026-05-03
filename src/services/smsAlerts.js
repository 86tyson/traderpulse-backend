'use strict';

// smsAlerts — Twilio SMS notifications for new pending-approval queue rows.
//
// SAFETY / DESIGN:
//   - One-way SMS only. NO inbound webhook handler, NO reply parsing, NO
//     "text APPROVE to confirm" path. The admin dashboard is the sole
//     approval surface. SMS is purely a notification.
//   - Fire-and-forget from the caller's perspective: this module never
//     throws. All errors are caught and logged via pino. A Twilio outage
//     cannot crash the bot loop or fail a scan.
//   - Secrets (Twilio account SID + auth token) live in env only and are
//     redacted by the pino redaction config in services/logger.js.
//   - Idempotency is the CALLER's responsibility — this module just sends.
//     scanner.js only calls sendPendingApprovalAlert when
//     recommendationQueue.enqueueRecommendation returns a non-null id
//     (i.e. the row was actually inserted, not deduped).
//   - When SMS_ALERTS_ENABLED is false OR any Twilio field is missing,
//     sendPendingApprovalAlert returns immediately with a logged
//     sms.alert.skipped entry. No network call.
//
// We use direct https POST to Twilio's REST API rather than the official
// `twilio` npm package — keeps the dependency surface small (we only need
// one endpoint) and means no extra package to audit. Node 20+'s built-in
// fetch handles HTTP Basic auth + form-encoded body cleanly.

const { config } = require('../config');
const logger = require('./logger');

const TWILIO_HOSTS = {
  base: 'https://api.twilio.com/2010-04-01',
};
const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 320; // 2 SMS segments. Twilio splits beyond.
const ADMIN_DASHBOARD_URL = 'https://admin.traderpulseai.com';

/**
 * Internal: check whether SMS is configured AND enabled. Returns
 * { ok: true } or { ok: false, reason } with reason being a SAFE string
 * (no secret values).
 *
 * ADMIN_ALERT_PHONE is REQUIRED (the primary recipient).
 * ADMIN_ALERT_PHONE_2 is OPTIONAL (a second recipient that gets the same
 * SMS in parallel). Missing _2 is normal and not a config error.
 */
function isReady() {
  if (!config.smsAlertsEnabled) {
    return { ok: false, reason: 'SMS_ALERTS_ENABLED=false' };
  }
  const missing = [];
  if (!config.twilioAccountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!config.twilioAuthToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!config.twilioFromNumber) missing.push('TWILIO_FROM_NUMBER');
  if (!config.adminAlertPhone) missing.push('ADMIN_ALERT_PHONE');
  if (missing.length > 0) {
    return { ok: false, reason: `missing twilio config: ${missing.join(',')}` };
  }
  return { ok: true };
}

/**
 * Internal: normalize the configured quiet-hours window. Bad values
 * (non-integer, out of 0..23 range) silently fall back to the safe
 * defaults of 8..23 — never crash on a misconfigured env var.
 */
function getWindow() {
  const start = Number.isInteger(config.smsStartHour) &&
    config.smsStartHour >= 0 && config.smsStartHour <= 23
    ? config.smsStartHour : 8;
  const end = Number.isInteger(config.smsEndHour) &&
    config.smsEndHour >= 0 && config.smsEndHour <= 23
    ? config.smsEndHour : 23;
  return { start, end };
}

/**
 * Internal: is the supplied hour (0..23) inside the allowed window?
 * Handles overnight wraparound when start > end (e.g. start=22, end=6
 * means allowed = {22, 23, 0, 1, 2, 3, 4, 5, 6}).
 */
function hourInWindow(hour, start, end) {
  if (start <= end) return hour >= start && hour <= end;
  // Wraparound — allowed = {start..23} ∪ {0..end}
  return hour >= start || hour <= end;
}

/**
 * Internal: check whether NOW (server local time) is inside the quiet-
 * hours allow window. Returns { ok: true } or
 * { ok: false, reason: 'quiet_hours' }.
 *
 * Uses server local time intentionally — Railway's containers run UTC,
 * so the operator should set start/end relative to that. Documented in
 * .env.example.
 */
function checkWindow(now = new Date()) {
  const { start, end } = getWindow();
  const hour = now.getHours();
  if (hourInWindow(hour, start, end)) return { ok: true };
  return {
    ok: false,
    reason: 'quiet_hours',
    detail: `current hour ${hour} outside allowed window ${start}..${end}`,
  };
}

/**
 * Internal: build the deduped list of recipient phone numbers from
 * config. Always includes ADMIN_ALERT_PHONE; appends ADMIN_ALERT_PHONE_2
 * if non-empty AND distinct. Trimmed; dupes removed (case-insensitive
 * after trim — phone strings shouldn't differ by case but defensive).
 */
function getRecipients() {
  const out = [];
  const seen = new Set();
  for (const p of [config.adminAlertPhone, config.adminAlertPhone2]) {
    if (typeof p !== 'string') continue;
    const trimmed = p.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Build the SMS body. Bounded to MAX_BODY_CHARS (~2 segments).
 * Includes only safe fields — never echoes credentials or the queue's
 * internal raw_request_json blob.
 */
function buildBody(rec) {
  const sym = rec?.symbol || 'UNKNOWN';
  const side = (rec?.side || '?').toUpperCase();
  const usd = Number(rec?.suggestedAmountUsd ?? rec?.amountUsd);
  const usdStr = Number.isFinite(usd) ? `$${usd.toFixed(2)}` : null;
  const conf = Number(rec?.confidenceScore);
  const confStr = Number.isFinite(conf) ? `${(conf * 100).toFixed(0)}%` : null;
  const refPrice = Number(
    rec?.entryPrice ?? rec?.refPrice ?? rec?.markPrice,
  );
  const priceStr = Number.isFinite(refPrice) ? `~$${refPrice.toFixed(2)}` : null;
  const reason = typeof rec?.entryReason === 'string'
    ? rec.entryReason.slice(0, 80)
    : null;

  const lines = ['Trader Pulse AI: pending approval'];
  const meta = [`${sym} ${side}`, usdStr, priceStr, confStr ? `conf ${confStr}` : null]
    .filter(Boolean)
    .join(' · ');
  lines.push(meta);
  if (reason) lines.push(reason);
  lines.push(ADMIN_DASHBOARD_URL);

  let body = lines.join('\n');
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS - 3) + '...';
  }
  return body;
}

/**
 * Internal: send the SMS body to ONE recipient via Twilio. NEVER throws.
 * Returns a per-recipient result object. Logs sms.alert.sent or
 * sms.alert.failed with the masked phone for context.
 *
 * Per-recipient errors are isolated — one number's network failure
 * cannot affect another number's send.
 */
async function sendOne(toPhone, body, rec) {
  const url = `${TWILIO_HOSTS.base}/Accounts/${config.twilioAccountSid}/Messages.json`;
  const auth = Buffer.from(
    `${config.twilioAccountSid}:${config.twilioAuthToken}`,
    'utf8',
  ).toString('base64');
  const form = new URLSearchParams({
    To: toPhone,
    From: config.twilioFromNumber,
    Body: body,
  });
  const toMasked = maskPhone(toPhone);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    logger.error(
      {
        event: 'sms.alert.failed',
        recommendationId: rec?.recommendationId,
        symbol: rec?.symbol,
        side: rec?.side,
        toMasked,
        msg: err && err.message ? err.message : String(err),
        kind: 'network',
      },
      `sms alert network error to ${toMasked}`,
    );
    return { to: toMasked, sent: false, reason: 'network' };
  }

  if (!res.ok) {
    let detail = null;
    try {
      const j = await res.json();
      detail = j?.message || j?.code || null;
    } catch {
      // ignore — error body unparsable
    }
    logger.error(
      {
        event: 'sms.alert.failed',
        recommendationId: rec?.recommendationId,
        symbol: rec?.symbol,
        side: rec?.side,
        toMasked,
        httpStatus: res.status,
        twilioMessage: detail,
        kind: 'twilio_error',
      },
      `sms alert failed to ${toMasked}: HTTP ${res.status} ${detail || ''}`,
    );
    return { to: toMasked, sent: false, reason: `twilio_http_${res.status}` };
  }

  let sid = null;
  try {
    const j = await res.json();
    sid = j?.sid || null;
  } catch {
    // fine — message accepted but body unparsable
  }
  logger.info(
    {
      event: 'sms.alert.sent',
      recommendationId: rec?.recommendationId,
      symbol: rec?.symbol,
      side: rec?.side,
      toMasked,
      twilioSid: sid,
      bodyLen: body.length,
    },
    `sms alert sent to ${toMasked}`,
  );
  return { to: toMasked, sent: true, twilioSid: sid };
}

/**
 * Send the pending-approval SMS to EVERY configured recipient (currently
 * up to two: ADMIN_ALERT_PHONE plus optional ADMIN_ALERT_PHONE_2).
 * NEVER throws. Returns {sent, results:[per-recipient]} where `sent` is
 * true if at least one recipient succeeded.
 *
 * Per-recipient sends run in PARALLEL via Promise.allSettled so a single
 * recipient's network failure does not delay or block the other.
 *
 * @param {object} rec  the recommendation row that was just queued. Shape
 *   matches the row returned by recommendationQueue.getPendingById:
 *   { recommendationId, symbol, side, suggestedAmountUsd, confidenceScore,
 *     entryReason, ... }
 */
async function sendPendingApprovalAlert(rec) {
  const ready = isReady();
  if (!ready.ok) {
    logger.info(
      { event: 'sms.alert.skipped', reason: ready.reason },
      `sms alert skipped: ${ready.reason}`,
    );
    return { sent: false, reason: ready.reason, results: [] };
  }

  // Quiet-hours gate. Runs AFTER isReady() so the skip log clearly
  // distinguishes "config missing" from "outside the time window."
  // The recommendation row is already in the queue; the operator will
  // see it on the dashboard at next refresh — only the SMS is silenced.
  const window = checkWindow();
  if (!window.ok) {
    logger.info(
      {
        event: 'sms.alert.skipped',
        reason: window.reason,
        detail: window.detail,
        recommendationId: rec?.recommendationId,
        symbol: rec?.symbol,
      },
      `sms alert skipped: ${window.detail}`,
    );
    return { sent: false, reason: window.reason, results: [] };
  }

  const recipients = getRecipients();
  if (recipients.length === 0) {
    // Defensive: isReady already requires ADMIN_ALERT_PHONE, so this
    // branch shouldn't fire. Belt-and-suspenders for future refactors.
    logger.info(
      { event: 'sms.alert.skipped', reason: 'no recipients' },
      'sms alert skipped: no recipients configured',
    );
    return { sent: false, reason: 'no recipients', results: [] };
  }

  const body = buildBody(rec);

  // Promise.allSettled: even if one recipient throws (it shouldn't —
  // sendOne catches everything), the others still complete. allSettled
  // never rejects.
  const settled = await Promise.allSettled(
    recipients.map((to) => sendOne(to, body, rec)),
  );
  const results = settled.map((s, i) => {
    if (s.status === 'fulfilled') return s.value;
    // sendOne should never throw, but guard anyway.
    return {
      to: maskPhone(recipients[i]),
      sent: false,
      reason: 'unhandled_exception',
    };
  });

  const anySent = results.some((r) => r.sent);
  return { sent: anySent, results };
}

/**
 * Read-only status for /admin/* endpoints (or boot logging) — never echoes
 * any secret. Does NOT make a network call.
 */
function getStatus() {
  const ready = isReady();
  const window = getWindow();
  const inWindowNow = hourInWindow(new Date().getHours(), window.start, window.end);
  return {
    enabled: !!config.smsAlertsEnabled,
    configured: ready.ok,
    skipReason: ready.ok ? null : ready.reason,
    fromNumberMasked: maskPhone(config.twilioFromNumber),
    recipientsMasked: getRecipients().map(maskPhone),
    recipientCount: getRecipients().length,
    smsWindowStart: window.start,
    smsWindowEnd: window.end,
    inWindowNow,
  };
}

function maskPhone(p) {
  if (!p || typeof p !== 'string') return null;
  // Show country code prefix + last 2 digits, mask the middle.
  if (p.length <= 4) return '***';
  return `${p.slice(0, 2)}***${p.slice(-2)}`;
}

module.exports = { sendPendingApprovalAlert, getStatus };
