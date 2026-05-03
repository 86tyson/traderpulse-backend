'use strict';

// strategyMode — admin-controlled selection of which scanner strategy the
// bot loop runs. Distinct from `tradingMode` (paused/assisted/auto) and
// from the per-trade `riskMode` (paper sizing preference, frontend-only).
//
// Two modes for now:
//   'default'           — the locked 1H pullback scanner (services/strategy.js
//                         evaluateMarket). Existing behavior; what the bot
//                         loop has been running since Phase 4 shipped.
//   'soloway_playbook'  — confluence-support pullback strategy. Stricter
//                         filters, 2:1 R:R minimum, ETH-USD only for live
//                         recommendations, BTC-USD watchlist-only,
//                         everything else blocked.
//
// HARD GUARANTEES:
//   - Changing strategy mode does NOT bypass any existing safety gate. The
//     liveRiskManager still runs on every order. Manual approval is still
//     required. Auto trading is still NOT_IMPLEMENTED.
//   - The mode value is persisted in `system_settings` (same table as
//     tradingMode). Audit-logged via mode_change_log on every change.
//   - 'soloway_playbook' produces RECOMMENDATIONS only. The bot loop never
//     places orders. Admin must still click Approve in the dashboard.

const systemSettings = require('./systemSettings');
const db = require('../db');
const logger = require('./logger');

const VALID_MODES = ['default', 'soloway_playbook'];
const SETTING_KEY = 'strategy_mode';
const DEFAULT_MODE_ON_FRESH_DB = 'default';

const insertChangeStmt = db.prepare(`
  INSERT INTO mode_change_log (from_mode, to_mode, actor, reason)
  VALUES (?, ?, ?, ?)
`);

/**
 * Returns the current strategy mode. Auto-initializes to 'default' on a
 * fresh DB the first time it's called.
 */
function getMode() {
  const row = systemSettings.get(SETTING_KEY);
  if (row && VALID_MODES.includes(row.value)) {
    return { mode: row.value, updatedAt: row.updatedAt };
  }
  systemSettings.set(SETTING_KEY, DEFAULT_MODE_ON_FRESH_DB);
  insertChangeStmt.run(
    null,
    `strategy:${DEFAULT_MODE_ON_FRESH_DB}`,
    'system',
    'fresh DB initialized to default strategy',
  );
  logger.info(
    { event: 'admin.strategy.init', defaultMode: DEFAULT_MODE_ON_FRESH_DB },
    `strategyMode initialized to ${DEFAULT_MODE_ON_FRESH_DB} on fresh DB`,
  );
  const reread = systemSettings.get(SETTING_KEY);
  return { mode: reread.value, updatedAt: reread.updatedAt };
}

function getStatus() {
  const { mode, updatedAt } = getMode();
  return {
    mode,
    updatedAt,
    availableModes: VALID_MODES,
    descriptions: {
      default:
        'Locked 1H pullback scanner. The strategy that has been running since Phase 4. ' +
        'BTC-USD and ETH-USD evaluated; only ETH-USD recommendations are queued for live approval.',
      soloway_playbook:
        'Confluence-support pullback strategy. Stricter filters, ≥2:1 risk/reward minimum, ' +
        'no weekend entries (Sat 00:00 → Sun 18:00 PT), enforces all existing caps. ' +
        'ETH-USD only for live; BTC-USD watchlist-only.',
    },
  };
}

/**
 * setMode validates + persists. Returns { ok: true } on success, or
 * { ok: false, code, reason } on failure. Never throws.
 *
 * Note: there are NO env-level ceilings to enforce here yet. Both modes
 * are recommendation-producers, not order placers — neither one bypasses
 * the existing live-trading safety pipeline.
 */
function setMode(newMode, opts = {}) {
  const actor = opts.actor || 'admin';
  const reason = opts.reason || null;

  if (!VALID_MODES.includes(newMode)) {
    logger.warn(
      { event: 'admin.strategy.change.reject', code: 'INVALID_MODE', requested: newMode, actor },
      'setStrategyMode rejected: invalid mode',
    );
    return {
      ok: false,
      code: 'INVALID_MODE',
      reason: `mode must be one of ${VALID_MODES.join(', ')}; got '${newMode}'`,
    };
  }

  const { mode: oldMode } = getMode();
  if (oldMode === newMode) {
    return { ok: true, mode: newMode, unchanged: true };
  }

  const updated = systemSettings.set(SETTING_KEY, newMode);
  insertChangeStmt.run(
    `strategy:${oldMode}`,
    `strategy:${newMode}`,
    actor,
    reason,
  );
  logger.info(
    {
      event: 'admin.strategy.change',
      fromMode: oldMode,
      toMode: newMode,
      actor,
      reason,
    },
    `strategyMode changed: ${oldMode} → ${newMode}`,
  );
  return { ok: true, mode: newMode, updatedAt: updated.updatedAt };
}

module.exports = {
  VALID_MODES,
  DEFAULT_MODE_ON_FRESH_DB,
  getMode,
  getStatus,
  setMode,
};
