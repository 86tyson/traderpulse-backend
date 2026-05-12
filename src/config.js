'use strict';

require('dotenv').config();

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected numeric env var, got: ${value}`);
  }
  return n;
}

// Lenient int-in-range parser. Used for non-critical env vars where a
// typo should fall back to the default rather than crash boot. Examples:
// SMS quiet-hours window (notifications only, not safety-critical).
function intInRange(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function list(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  port: num(process.env.PORT, 3001),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  // CORS allow-list. Comma-separated origins in FRONTEND_URL.
  // Examples:
  //   FRONTEND_URL=http://localhost:8080
  //   FRONTEND_URL=https://www.traderpulseai.com,https://traderpulseai.com
  // Vercel preview origins can be matched via VERCEL_PREVIEW_REGEX
  // (e.g. ^https:\/\/fehrertrader-[a-z0-9-]+\.vercel\.app$). Leave unset
  // to disable preview matching.
  allowedOrigins: list(process.env.FRONTEND_URL, ['http://localhost:5173']),
  vercelPreviewRegex: process.env.VERCEL_PREVIEW_REGEX || '',
  // Kept for backwards-compat with anything that still reads `frontendUrl`
  // (startup logs, etc.). It's the first allowed origin; if you have a
  // single origin this is identical to FRONTEND_URL.
  frontendUrl: list(process.env.FRONTEND_URL, ['http://localhost:5173'])[0],
  backendApiKey: process.env.BACKEND_API_KEY || '',

  // ----- Admin dashboard session auth -----
  // ADMIN_DASHBOARD_PASSWORD: the password an operator types into the
  // admin dashboard login form. Server-side only; NEVER exposed to the
  // frontend in any form. Compared in constant time at /admin/login.
  // SESSION_SECRET: the HMAC key that signs admin session cookies. A long
  // random hex string. Rotating it invalidates every issued admin session
  // immediately.
  adminDashboardPassword: process.env.ADMIN_DASHBOARD_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',

  botEnabled: bool(process.env.BOT_ENABLED, false),
  paperMode: bool(process.env.PAPER_MODE, true),
  requireApproval: bool(process.env.REQUIRE_APPROVAL, true),

  maxTradeUsd: num(process.env.MAX_TRADE_USD, 25),
  maxDailyLossUsd: num(process.env.MAX_DAILY_LOSS_USD, 50),
  allowedSymbols: list(process.env.ALLOWED_SYMBOLS, ['BTC-USD', 'ETH-USD']),
  minConfidence: num(process.env.MIN_CONFIDENCE, 0.5),

  robinhoodApiKey: process.env.ROBINHOOD_API_KEY || '',
  robinhoodPrivateKey: process.env.ROBINHOOD_PRIVATE_KEY || '',

  // ----- Phase 3: micro live testing -----
  // The HARD kill switch. Until this is `true`, no live order can ever be
  // placed by the backend, regardless of any other flag. Checked twice — once
  // in the live-risk pipeline, once again inside the Robinhood client itself.
  liveTradingEnabled: bool(process.env.LIVE_TRADING_ENABLED, false),

  // Independent flag for AUTOMATED order placement (no human-in-the-loop).
  // Default: FALSE. When false, all live orders require manual approval via
  // POST /live/approve. When true, a future bot-loop is permitted to call
  // /live/approve without an interactive confirmation. There is currently NO
  // bot execution loop in this codebase — this flag is wired through config /
  // status / UI only. Boot will refuse if `AUTO_TRADING_ENABLED=true` while
  // `LIVE_TRADING_ENABLED=false` (auto trading without the kill switch on
  // would be incoherent).
  autoTradingEnabled: bool(process.env.AUTO_TRADING_ENABLED, false),

  // Per-order cap on live USD notional. Defaults to $10. Hard-enforced —
  // orders above this are rejected with AMOUNT_OUT_OF_RANGE before they
  // reach the Robinhood API.
  liveMaxOrderUsd: num(process.env.LIVE_MAX_ORDER_USD, 10),

  // Daily realized-loss cap for LIVE trades only (does not include paper).
  // Once today's live realized losses meet or exceed this, no new live
  // orders are accepted until tomorrow.
  liveDailyLossCapUsd: num(process.env.LIVE_DAILY_LOSS_CAP_USD, 10),

  // Hard cap on the number of LIVE buy orders accepted per UTC calendar
  // day. Counted from the `trades` table where mode='live' and status in
  // ('executed', 'pending_approval'). Defaults to 5. Phase 3 / Assisted
  // mode uses this as a guardrail against runaway scanning behavior — even
  // if the scanner keeps proposing trades, no more than this many per day
  // can reach Robinhood.
  liveDailyTradeCountCap: num(process.env.LIVE_DAILY_TRADE_COUNT_CAP, 5),

  // Bot loop scan interval in MINUTES. The loop only runs when ALL of:
  //   BOT_ENABLED=true, LIVE_TRADING_ENABLED=true, tradingMode='assisted'.
  // Lower bound: 5 minutes (faster ticks would hammer the upstream
  // market-data API and burn rate limits). Default: 60 minutes — matches
  // the strategy's 1H candle granularity. Set to 0 (or unset) to disable
  // the loop entirely; manual /scan triggers always work regardless.
  botLoopIntervalMin: num(process.env.BOT_LOOP_INTERVAL_MIN, 60),

  // ----- Twilio SMS alerts (optional) -----
  // When SMS_ALERTS_ENABLED=true AND all four Twilio fields are present, the
  // backend sends a one-way SMS to ADMIN_ALERT_PHONE every time a NEW
  // pending-approval row is queued (manual scan or bot loop). Existing
  // recommendations don't re-trigger — duplicate idempotency is gated at
  // the queue layer. SMS NEVER approves trades; the dashboard is still the
  // only approval surface. If any field is missing or SMS_ALERTS_ENABLED
  // is false, alerts are skipped silently (logged as sms.alert.skipped) —
  // never fatal to the scan or bot loop.
  smsAlertsEnabled: bool(process.env.SMS_ALERTS_ENABLED, false),
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER || '',
  adminAlertPhone: process.env.ADMIN_ALERT_PHONE || '',
  // Optional second recipient. If present, the same SMS is sent to both
  // numbers in parallel; one number erroring does not block the other.
  // Leave blank to send to ADMIN_ALERT_PHONE only.
  adminAlertPhone2: process.env.ADMIN_ALERT_PHONE_2 || '',

  // Quiet hours — SMS only sent when SMS_START_HOUR <= currentHour <=
  // SMS_END_HOUR (inclusive on both ends), in the SERVER's local time.
  // Defaults to 8–23 (8 AM through 11 PM). Overnight wraparound is
  // supported: if start > end (e.g. start=22, end=6) the allowed window
  // wraps midnight. Outside the window, sends are skipped with
  // sms.alert.skipped reason='quiet_hours' and never reach Twilio.
  // Uses the LENIENT parser — bad input (typo, out of 0..23) falls back
  // to the default rather than crashing boot. SMS is notification-only,
  // not safety-critical; a typo here should not take down trading.
  smsStartHour: intInRange(process.env.SMS_START_HOUR, 0, 23, 8),
  smsEndHour: intInRange(process.env.SMS_END_HOUR, 0, 23, 23),

  // Allow-list for LIVE orders. Defaults to ETH-USD only. INDEPENDENT of
  // `allowedSymbols` (which governs paper) — live trading is intentionally
  // narrower than paper trading during Phase 3.
  liveAllowedSymbols: list(process.env.LIVE_ALLOWED_SYMBOLS, ['ETH-USD']),

  dataDir: process.env.DATA_DIR || './data',
};

function validateOrExit() {
  const errors = [];

  if (!config.backendApiKey || config.backendApiKey.length < 16) {
    errors.push(
      'BACKEND_API_KEY is required and must be at least 16 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }

  // Admin session auth — both must be set together. We do not allow an
  // unconfigured ADMIN_DASHBOARD_PASSWORD to silently disable login (the
  // route would 401 every attempt, which is fine, but it usually indicates
  // a misconfigured deploy).
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    errors.push(
      'SESSION_SECRET is required and must be at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (!config.adminDashboardPassword || config.adminDashboardPassword.length < 12) {
    errors.push(
      'ADMIN_DASHBOARD_PASSWORD is required and must be at least 12 characters. ' +
        'This is the password the admin dashboard login form accepts. ' +
        'Pick something high-entropy; it gates live trading.',
    );
  }

  if (config.botEnabled && !config.paperMode) {
    if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
      errors.push(
        'PAPER_MODE=false requires ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY to be set. ' +
          'Refusing to start in live mode without credentials.',
      );
    }
  }

  if (config.maxTradeUsd <= 0) {
    errors.push('MAX_TRADE_USD must be a positive number.');
  }

  if (config.maxDailyLossUsd <= 0) {
    errors.push('MAX_DAILY_LOSS_USD must be a positive number.');
  }

  if (config.allowedSymbols.length === 0) {
    errors.push('ALLOWED_SYMBOLS must contain at least one symbol.');
  }

  // ----- Phase 3 boot guards -----
  // If live trading is enabled, refuse to start without valid Robinhood
  // credentials AND a sane risk envelope. The kill switch must be intentional.
  if (config.liveTradingEnabled) {
    if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
      errors.push(
        'LIVE_TRADING_ENABLED=true requires both ROBINHOOD_API_KEY and ' +
          'ROBINHOOD_PRIVATE_KEY to be set. Refusing to start.',
      );
    }
    if (!Number.isFinite(config.liveMaxOrderUsd) || config.liveMaxOrderUsd <= 0) {
      errors.push('LIVE_MAX_ORDER_USD must be a positive number.');
    }
    if (config.liveMaxOrderUsd > 25) {
      errors.push(
        `LIVE_MAX_ORDER_USD (${config.liveMaxOrderUsd}) is above the Phase-3 ceiling of $25. ` +
          'Refusing to start — manual code change required to raise this.',
      );
    }
    if (
      !Number.isFinite(config.liveDailyLossCapUsd) ||
      config.liveDailyLossCapUsd <= 0
    ) {
      errors.push('LIVE_DAILY_LOSS_CAP_USD must be a positive number.');
    }
    if (config.liveAllowedSymbols.length === 0) {
      errors.push('LIVE_ALLOWED_SYMBOLS must contain at least one symbol.');
    }
    // Phase 3 explicitly: ETH only.
    const nonEth = config.liveAllowedSymbols.filter((s) => s !== 'ETH-USD');
    if (nonEth.length > 0) {
      errors.push(
        `LIVE_ALLOWED_SYMBOLS contains non-ETH entries (${nonEth.join(', ')}). ` +
          'Phase 3 is ETH-only. Refusing to start.',
      );
    }
    // Manual approval is required UNLESS AUTO_TRADING_ENABLED is also true.
    // Auto-execution is permitted when ALL of the following hold:
    //   LIVE_TRADING_ENABLED=true (kill switch)
    //   BOT_ENABLED=true (bot subsystem allowed)
    //   AUTO_TRADING_ENABLED=true (auto path permitted)
    //   REQUIRE_APPROVAL=false (admin has explicitly disabled manual gate)
    // Without AUTO_TRADING_ENABLED, REQUIRE_APPROVAL must remain true so the
    // dashboard's manual-approve flow is the only path orders can be placed.
    if (!config.requireApproval && !config.autoTradingEnabled) {
      errors.push(
        'LIVE_TRADING_ENABLED=true with REQUIRE_APPROVAL=false also requires ' +
          'AUTO_TRADING_ENABLED=true. Otherwise no path can place orders.',
      );
    }
  }

  // ----- Auto-trading boot guard -----
  // AUTO_TRADING_ENABLED has no meaning unless LIVE_TRADING_ENABLED is also
  // on. Refusing to boot in this state forces operators to flip them in the
  // correct order (kill switch first, then auto-trading), and prevents a
  // confusing "auto on but no live possible" state.
  if (config.autoTradingEnabled && !config.liveTradingEnabled) {
    errors.push(
      'AUTO_TRADING_ENABLED=true requires LIVE_TRADING_ENABLED=true. ' +
        'Auto trading without the kill switch on is incoherent. Refusing to start.',
    );
  }
  // Auto trading also needs BOT_ENABLED=true for any future loop to act.
  if (config.autoTradingEnabled && !config.botEnabled) {
    errors.push(
      'AUTO_TRADING_ENABLED=true requires BOT_ENABLED=true. ' +
        'Refusing to start.',
    );
  }

  // Bot loop interval: 0 disables the loop entirely (and is a valid
  // configuration). Anything explicitly set in (0, 5) is too aggressive
  // for the upstream market-data API and is rejected at boot.
  if (
    Number.isFinite(config.botLoopIntervalMin) &&
    config.botLoopIntervalMin > 0 &&
    config.botLoopIntervalMin < 5
  ) {
    errors.push(
      `BOT_LOOP_INTERVAL_MIN (${config.botLoopIntervalMin}) is below the ` +
        'minimum of 5 minutes. Set it to 0 to disable the loop, or ≥5 to enable.',
    );
  }

  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`[config] ${e}`);
    }
    process.exit(1);
  }
}

module.exports = { config, validateOrExit };
