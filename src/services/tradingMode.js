'use strict';

// tradingMode — admin-controlled runtime trading mode.
//
// Three modes:
//   'paused'   — bot does not evaluate or trade; manual approval still works
//                via /live/approve. Useful as an emergency "stop the bot"
//                switch without touching env vars or redeploying.
//   'assisted' — bot evaluates on each /scan call and writes any
//                recommendations to the pending-approval queue. Admin must
//                manually approve each one before /live/approve runs and an
//                order is placed. **Default on a fresh DB.**
//   'auto'     — RESERVED. Not implemented in this codebase yet. setMode('auto')
//                returns NOT_IMPLEMENTED. The mode value is reserved in the
//                schema so future work doesn't have to migrate it in.
//
// THREE LAYERS OF SAFETY (ordered from most to least restrictive):
//
//   1. Env-level CEILINGS (immutable at runtime, set on Railway):
//        LIVE_TRADING_ENABLED   — must be true for any live order
//        AUTO_TRADING_ENABLED   — must be true to even allow setMode('auto')
//        BOT_ENABLED            — required for an automated execution loop
//      None of these can be flipped from the UI. They are the floor.
//
//   2. Persisted runtime mode (this module). Admin flips via UI. Stored in
//      `system_settings.trading_mode`. Survives restarts.
//
//   3. Per-order risk pipeline (`liveRiskManager.evaluateLive`). Runs on
//      every order regardless of mode. Cannot be bypassed.
//
// setMode rejects any transition that would violate (1). E.g.:
//   - setMode('assisted') fails if LIVE_TRADING_ENABLED=false (no live orders
//     possible — assisted has nothing useful to do).
//   - setMode('auto') fails ALWAYS in current build (NOT_IMPLEMENTED).

const systemSettings = require('./systemSettings');
const { config } = require('../config');
const db = require('../db');
const logger = require('./logger');

const VALID_MODES = ['paused', 'assisted', 'auto'];
const SETTING_KEY = 'trading_mode';
const DEFAULT_MODE_ON_FRESH_DB = 'assisted';

const insertModeChangeStmt = db.prepare(`
  INSERT INTO mode_change_log (from_mode, to_mode, actor, reason)
  VALUES (?, ?, ?, ?)
`);
const recentChangesStmt = db.prepare(`
  SELECT from_mode AS fromMode, to_mode AS toMode, actor, reason, created_at AS createdAt
  FROM mode_change_log
  ORDER BY id DESC
  LIMIT ?
`);

/**
 * Returns the current trading mode. Auto-initializes to the default on a
 * fresh DB the first time it's called, so callers never see a missing-row
 * state.
 */
function getMode() {
  const row = systemSettings.get(SETTING_KEY);
  if (row && VALID_MODES.includes(row.value)) {
    return { mode: row.value, updatedAt: row.updatedAt };
  }
  // Either no row, or the stored value is corrupt/legacy. Initialize to default.
  systemSettings.set(SETTING_KEY, DEFAULT_MODE_ON_FRESH_DB);
  insertModeChangeStmt.run(
    null,
    DEFAULT_MODE_ON_FRESH_DB,
    'system',
    'fresh DB initialized to default mode',
  );
  logger.info(
    { event: 'admin.mode.init', defaultMode: DEFAULT_MODE_ON_FRESH_DB },
    `tradingMode initialized to ${DEFAULT_MODE_ON_FRESH_DB} on fresh DB`,
  );
  const reread = systemSettings.get(SETTING_KEY);
  return { mode: reread.value, updatedAt: reread.updatedAt };
}

/**
 * Build the response shape returned by GET /admin/mode. Always includes
 * the env ceilings so the UI can show "auto is locked because ..." messages.
 */
function getModeStatus() {
  const { mode, updatedAt } = getMode();
  const ceilings = {
    liveTradingEnabled: !!config.liveTradingEnabled,
    autoTradingEnabled: !!config.autoTradingEnabled,
    botEnabled: !!config.botEnabled,
    requireApproval: !!config.requireApproval,
    robinhoodConnected: !!(config.robinhoodApiKey && config.robinhoodPrivateKey),
  };
  const lockedModes = {};
  if (!ceilings.liveTradingEnabled) {
    lockedModes.assisted =
      'LIVE_TRADING_ENABLED=false on the backend. The kill switch must be on for the assisted queue to do anything useful.';
  }
  // Auto trading is selectable when all env ceilings are on.
  if (!ceilings.liveTradingEnabled || !ceilings.autoTradingEnabled || !ceilings.botEnabled) {
    const missing = [];
    if (!ceilings.liveTradingEnabled) missing.push('LIVE_TRADING_ENABLED');
    if (!ceilings.autoTradingEnabled) missing.push('AUTO_TRADING_ENABLED');
    if (!ceilings.botEnabled) missing.push('BOT_ENABLED');
    lockedModes.auto =
      `Auto trading requires ${missing.join(' + ')}=true on the backend. ` +
      'Set the env var(s) on Railway and redeploy to unlock.';
  }

  return {
    mode,
    updatedAt,
    ceilings,
    availableModes: VALID_MODES,
    lockedModes,
  };
}

/**
 * setMode validates the transition against env ceilings and writes the new
 * value. Returns { ok, mode } on success or { ok:false, code, reason } on
 * failure. NEVER throws on caller-recoverable errors — return shape is the
 * single source of truth.
 *
 * Audit log: every successful change AND every rejected attempt is logged
 * via pino. Successful changes additionally append a row to
 * mode_change_log.
 *
 * @param {string} newMode  one of VALID_MODES
 * @param {object} opts
 * @param {string} [opts.actor]  free-form identifier (e.g. session iat)
 * @param {string} [opts.reason] free-form note
 */
function setMode(newMode, opts = {}) {
  const actor = opts.actor || 'admin';
  const reason = opts.reason || null;

  if (!VALID_MODES.includes(newMode)) {
    logger.warn(
      { event: 'admin.mode.change.reject', code: 'INVALID_MODE', requested: newMode, actor },
      'setMode rejected: invalid mode',
    );
    return {
      ok: false,
      code: 'INVALID_MODE',
      reason: `mode must be one of ${VALID_MODES.join(', ')}; got '${newMode}'`,
    };
  }

  // Auto trading — permitted ONLY when all env-ceiling gates are on.
  // The env vars must be set on Railway (not just the runtime mode), so
  // turning auto on requires a redeploy/manual ceiling flip in addition
  // to the UI click. Defense in depth.
  if (newMode === 'auto') {
    if (!config.liveTradingEnabled) {
      logger.warn(
        { event: 'admin.mode.change.reject', code: 'LIVE_TRADING_DISABLED', requested: newMode, actor },
        'setMode auto rejected: live trading off',
      );
      return {
        ok: false,
        code: 'LIVE_TRADING_DISABLED',
        reason:
          'Cannot enable auto mode while LIVE_TRADING_ENABLED=false on the backend. ' +
          'Set the env var on Railway and redeploy first.',
      };
    }
    if (!config.autoTradingEnabled) {
      logger.warn(
        { event: 'admin.mode.change.reject', code: 'AUTO_TRADING_DISABLED', requested: newMode, actor },
        'setMode auto rejected: AUTO_TRADING_ENABLED=false at env layer',
      );
      return {
        ok: false,
        code: 'AUTO_TRADING_DISABLED',
        reason:
          'Cannot enable auto mode while AUTO_TRADING_ENABLED=false on the backend. ' +
          'Set the env var on Railway and redeploy first — auto is gated at the env ceiling.',
      };
    }
    if (!config.botEnabled) {
      logger.warn(
        { event: 'admin.mode.change.reject', code: 'BOT_DISABLED', requested: newMode, actor },
        'setMode auto rejected: BOT_ENABLED=false at env layer',
      );
      return {
        ok: false,
        code: 'BOT_DISABLED',
        reason:
          'Cannot enable auto mode while BOT_ENABLED=false on the backend.',
      };
    }
    // All env gates pass. Allow the runtime flip.
  }

  // Env-ceiling enforcement: assisted requires the live kill switch to be on.
  if (newMode === 'assisted' && !config.liveTradingEnabled) {
    logger.warn(
      { event: 'admin.mode.change.reject', code: 'LIVE_TRADING_DISABLED', requested: newMode, actor },
      'setMode rejected: live trading disabled at backend',
    );
    return {
      ok: false,
      code: 'LIVE_TRADING_DISABLED',
      reason:
        'Cannot enable assisted mode while LIVE_TRADING_ENABLED=false on the backend. ' +
        'Set the env var on Railway and redeploy first.',
    };
  }

  // Paused is always allowed — it's the safest possible state.

  const { mode: oldMode } = getMode();
  if (oldMode === newMode) {
    // No-op: don't write a duplicate audit row. Return success so the UI
    // doesn't error on benign re-clicks.
    return { ok: true, mode: newMode, updatedAt: new Date().toISOString(), unchanged: true };
  }

  const updated = systemSettings.set(SETTING_KEY, newMode);
  insertModeChangeStmt.run(oldMode, newMode, actor, reason);
  logger.info(
    {
      event: 'admin.mode.change',
      fromMode: oldMode,
      toMode: newMode,
      actor,
      reason,
    },
    `tradingMode changed: ${oldMode} → ${newMode}`,
  );

  return { ok: true, mode: newMode, updatedAt: updated.updatedAt };
}

function recentChanges(limit = 20) {
  const n = Math.min(Math.max(1, Math.floor(limit) || 20), 100);
  return recentChangesStmt.all(n);
}

module.exports = {
  VALID_MODES,
  DEFAULT_MODE_ON_FRESH_DB,
  getMode,
  getModeStatus,
  setMode,
  recentChanges,
};
