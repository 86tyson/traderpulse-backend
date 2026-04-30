'use strict';

// Auto-trading gate: pure helpers around the AUTO_TRADING_ENABLED flag.
//
// IMPORTANT: this codebase does NOT currently have a bot execution loop.
// Nothing in production calls `canAutoTradeNow`. The helpers exist so that:
//   - tests can verify the gating logic in isolation
//   - the dashboard can derive `manualApprovalRequired` consistently with
//     the same rule the future bot loop would use
//   - if/when an auto-execution loop is added, it has a single
//     authoritative function to call before any order placement
//
// The gate is intentionally STATIC (config-only). Per-order risk gates
// (daily loss cap, open position max, symbol allow-list, USD amount)
// remain in `liveRiskManager.evaluateLive` and must ALSO pass — they are
// not duplicated here. A future auto loop must call BOTH.

/**
 * Derive whether a manual approval click is the only way an order can be
 * placed right now.
 *
 *   liveTradingEnabled=false → manualApprovalRequired=false (no live orders
 *                              can happen at all; manual or otherwise)
 *   liveTradingEnabled=true + autoTradingEnabled=false → TRUE
 *   liveTradingEnabled=true + autoTradingEnabled=true  → FALSE (auto loop
 *                              could run; manual is still possible but no
 *                              longer the only path)
 */
function isManualApprovalRequired(config) {
  if (!config) return false;
  return !!(config.liveTradingEnabled && !config.autoTradingEnabled);
}

/**
 * Static config-level check for auto trading. Returns { ok, reason }.
 *
 * If `ok: true`, a future bot-execution loop is permitted to proceed to
 * the per-order risk pipeline (`liveRiskManager.evaluateLive`). If the
 * order-level gates pass there, then and only then may an order be placed.
 *
 * If `ok: false`, the loop must refuse without ever calling Robinhood.
 */
function canAutoTradeNow(ctx) {
  const config = ctx?.config;
  if (!config) return fail('CONFIG_MISSING', 'config object missing');

  if (!config.liveTradingEnabled) {
    return fail(
      'LIVE_TRADING_DISABLED',
      'LIVE_TRADING_ENABLED is false; live orders are blocked at the kill switch.',
    );
  }
  if (!config.autoTradingEnabled) {
    return fail(
      'AUTO_TRADING_DISABLED',
      'AUTO_TRADING_ENABLED is false; only manual approval can place orders.',
    );
  }
  if (!config.botEnabled) {
    return fail(
      'BOT_DISABLED',
      'BOT_ENABLED is false; auto execution requires the bot to be enabled.',
    );
  }
  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    return fail(
      'ROBINHOOD_KEYS_MISSING',
      'Robinhood credentials are not configured.',
    );
  }
  return { ok: true };
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

module.exports = { isManualApprovalRequired, canAutoTradeNow };
