'use strict';

// botLoop — periodic scan-and-queue runner for Assisted mode.
//
// HARD GUARANTEES:
//   - Only ONE interval per Node process. Calling start() twice is a no-op.
//   - Each tick is gated by THREE conditions (re-checked every tick):
//       1. config.botEnabled (env BOT_ENABLED=true)
//       2. config.liveTradingEnabled (env LIVE_TRADING_ENABLED=true)
//       3. tradingMode.getMode() === 'assisted' (admin-controlled runtime)
//     If any is false, the tick is skipped (logged) and no scan runs.
//   - The loop NEVER calls /live/approve, /live/close, /trade/*, or
//     /live/reconcile. Its only side effect is calling scanner.runScan(),
//     which (when gates pass) writes pending_approval rows to the DB.
//   - Admin must still click Approve in the UI for any order to reach
//     Robinhood. The loop is a producer, not an executor.
//   - In-flight ticks are tracked; a new tick that fires while one is still
//     running is skipped (logged) so we never run two scans in parallel.
//
// LIFE-CYCLE:
//   - server.js calls start() once after app.listen(), only inside the
//     `if (require.main === module)` block — i.e. real server processes,
//     never the test suite (which uses buildApp() directly via supertest).
//   - There is no stop() needed for production: the loop dies with the
//     process. A stop() helper exists for tests/debugging.

const { runScan } = require('./scanner');
const tradingMode = require('./tradingMode');
const { config } = require('../config');
const logger = require('./logger');

let intervalHandle = null;
let intervalMin = 0;
let tickInFlight = false;
let lastTick = null; // { startedAt, finishedAt, status, queued?, error? }

const SCAN_TIMEFRAME = '1h';

/**
 * Start the bot loop. Idempotent: a second call is a no-op + warns.
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMin]  Override config.botLoopIntervalMin.
 *   Useful for tests; production always passes nothing and reads config.
 */
function start(opts = {}) {
  if (intervalHandle) {
    logger.warn(
      { event: 'bot.loop.start.duplicate' },
      'botLoop.start called twice; ignoring',
    );
    return { started: false, reason: 'already running' };
  }

  const requestedMin =
    Number.isFinite(opts.intervalMin) ? opts.intervalMin : config.botLoopIntervalMin;

  // 0 (or any non-positive value) means "loop disabled" — distinct from
  // "loop allowed but env ceilings are off." No interval is scheduled.
  if (!Number.isFinite(requestedMin) || requestedMin <= 0) {
    logger.info(
      { event: 'bot.loop.start.disabled', botLoopIntervalMin: requestedMin },
      'botLoop disabled (BOT_LOOP_INTERVAL_MIN is 0 or unset)',
    );
    return { started: false, reason: 'interval disabled' };
  }

  intervalMin = requestedMin;
  const intervalMs = intervalMin * 60 * 1000;

  // Fire immediately on the next event-loop tick so operators see activity
  // without waiting an hour. setImmediate (not setTimeout(0)) so the listen()
  // callback finishes printing first.
  setImmediate(() => {
    void tick();
  });
  intervalHandle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep the Node process alive just because of this interval.
  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  logger.info(
    {
      event: 'bot.loop.start',
      intervalMin,
      gateChecks: {
        botEnabled: !!config.botEnabled,
        liveTradingEnabled: !!config.liveTradingEnabled,
      },
    },
    `botLoop started (every ${intervalMin}m)`,
  );
  return { started: true, intervalMin };
}

/**
 * Single tick: re-check gates, run scan if all pass, log result.
 * Never throws — all errors are caught and logged.
 */
async function tick() {
  if (tickInFlight) {
    logger.warn(
      { event: 'bot.loop.skip', reason: 'previous tick still in flight' },
      'botLoop tick skipped: previous tick still running',
    );
    return;
  }

  // Gate 1: env-level bot kill switch
  if (!config.botEnabled) {
    lastTick = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'skipped',
      reason: 'BOT_ENABLED=false',
    };
    logger.info(
      { event: 'bot.loop.skip', reason: 'BOT_ENABLED=false' },
      'botLoop tick skipped: bot kill switch off',
    );
    return;
  }

  // Gate 2: env-level live kill switch
  if (!config.liveTradingEnabled) {
    lastTick = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'skipped',
      reason: 'LIVE_TRADING_ENABLED=false',
    };
    logger.info(
      { event: 'bot.loop.skip', reason: 'LIVE_TRADING_ENABLED=false' },
      'botLoop tick skipped: live kill switch off',
    );
    return;
  }

  // Gate 3: runtime trading mode
  const { mode } = tradingMode.getMode();
  if (mode !== 'assisted') {
    lastTick = {
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: 'skipped',
      reason: `tradingMode='${mode}' (need 'assisted')`,
    };
    logger.info(
      { event: 'bot.loop.skip', reason: `tradingMode='${mode}'` },
      `botLoop tick skipped: tradingMode is ${mode}, not assisted`,
    );
    return;
  }

  // All gates pass: run the scan.
  tickInFlight = true;
  const startedAt = new Date().toISOString();
  try {
    // bypassCache=true so the loop always evaluates fresh data, independent
    // of whatever the manual /scan route has cached.
    const result = await runScan({
      timeframe: SCAN_TIMEFRAME,
      bypassCache: true,
      source: 'bot-loop',
    });
    const finishedAt = new Date().toISOString();
    lastTick = {
      startedAt,
      finishedAt,
      status: 'ok',
      queued: result.queued,
      recommendationsFound: result.results.filter((r) => r.recommendation).length,
    };
    logger.info(
      {
        event: 'bot.loop.tick',
        startedAt,
        finishedAt,
        queued: result.queued,
        recommendationsFound: lastTick.recommendationsFound,
        intervalMin,
      },
      `botLoop tick complete: queued=${result.queued}`,
    );
  } catch (err) {
    const finishedAt = new Date().toISOString();
    lastTick = {
      startedAt,
      finishedAt,
      status: 'error',
      error: err && err.message ? err.message : String(err),
    };
    logger.error(
      {
        event: 'bot.loop.error',
        startedAt,
        finishedAt,
        msg: lastTick.error,
        code: err?.code,
      },
      `botLoop tick failed: ${lastTick.error}`,
    );
    // Swallow — the next interval will retry. We do not crash the process.
  } finally {
    tickInFlight = false;
  }
}

function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    intervalMin = 0;
    logger.info({ event: 'bot.loop.stop' }, 'botLoop stopped');
  }
}

/**
 * Status snapshot for the admin UI.
 */
function getStatus() {
  const { mode } = tradingMode.getMode();
  const gates = {
    botEnabled: !!config.botEnabled,
    liveTradingEnabled: !!config.liveTradingEnabled,
    tradingMode: mode,
    tradingModeOk: mode === 'assisted',
  };
  const wouldRunIfTicked =
    !!intervalHandle && gates.botEnabled && gates.liveTradingEnabled && gates.tradingModeOk;
  return {
    running: !!intervalHandle,
    intervalMin,
    tickInFlight,
    lastTick,
    gates,
    wouldRunIfTicked,
  };
}

module.exports = { start, stop, tick, getStatus };
