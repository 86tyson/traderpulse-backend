'use strict';

// scanner — single source of truth for the market-scan + queue-recommendations
// flow. Both the GET /scan route and the bot loop call into this. Extracting
// the logic here ensures both callers behave identically and the cache is
// shared across them.
//
// IMPORTANT: this module DOES NOT place orders. It only:
//   1. Pulls candles from the upstream market-data API
//   2. Runs the strategy evaluator
//   3. If tradingMode='assisted' AND LIVE_TRADING_ENABLED=true, persists any
//      generated recommendations to the pending-approval queue (idempotent
//      on recommendation_id)
//
// Order placement only happens later when an admin clicks Approve in the UI,
// which routes through liveRiskManager + robinhoodClient via /admin/recommendations/:id/approve.

const {
  fetchCoinbaseCandles,
  MarketDataError,
} = require('./marketDataClient');
const { buildSnapshot } = require('./snapshotBuilder');
const { evaluateMarket } = require('./strategy');
const { evaluateSoloway } = require('./solowayPlaybook');
const tradingMode = require('./tradingMode');
const strategyMode = require('./strategyMode');
const recommendationQueue = require('./recommendationQueue');
const autoTrader = require('./autoTrader');
const smsAlerts = require('./smsAlerts');
const { config } = require('../config');
const logger = require('./logger');

const SYMBOLS = [
  { backend: 'BTC-USD', lovable: 'BTC' },
  { backend: 'ETH-USD', lovable: 'ETH' },
];
const DEFAULT_TIMEFRAME = '1h';
// 200 1H bars ≈ 8 days. Enough buffer for:
//   - 50-period MA (needs 50)
//   - ATR(14) series + a meaningful rolling median (Soloway BLK-02)
//   - RSI(14) series + recent swing-high history (Soloway BLK-03 divergence)
//   - Pullback / swing detection
// The Soloway spec calls for a 30-day median 1H ATR (~720 bars). This is
// a recent-regime proxy; flagged in solowayPlaybook.js. Phase B will widen
// the upstream fetch with pagination.
const NUM_BARS = 200;
const CACHE_TTL_MS = 60_000;

let cache = { ts: 0, payload: null };

/**
 * Run a full scan: fetch candles, run strategy, optionally enqueue results.
 *
 * @param {object} [opts]
 * @param {string} [opts.timeframe='1h']  candle granularity passed to upstream
 * @param {boolean} [opts.bypassCache=false]  ignore the in-process cache.
 *   The bot loop uses bypassCache=true so each tick is a fresh evaluation.
 *   The /scan route uses cache so multiple UI refreshes within 60s share
 *   the same recommendation.
 * @param {string} [opts.source='manual']  'manual' (route) or 'bot-loop'.
 *   Logged for telemetry; doesn't affect behavior.
 *
 * @returns {Promise<object>} the same payload shape the /scan route returns.
 *   On upstream errors, throws (caller decides how to surface).
 */
async function runScan(opts = {}) {
  const timeframe = opts.timeframe || DEFAULT_TIMEFRAME;
  const bypassCache = !!opts.bypassCache;
  const source = opts.source || 'manual';

  if (
    !bypassCache &&
    cache.payload &&
    cache.payload.timeframe === timeframe &&
    Date.now() - cache.ts < CACHE_TTL_MS
  ) {
    return { ...cache.payload, cached: true };
  }

  // Read the admin-controlled strategy mode at the start of the scan.
  // Mode can be 'default' (existing 1H pullback evaluator) or
  // 'soloway_playbook' (confluence-support pullback with hard blocks).
  // Both produce recommendations only; neither places orders.
  const { mode: strategy } = strategyMode.getMode();

  const results = [];
  for (const s of SYMBOLS) {
    const candles = await fetchCoinbaseCandles(s.backend, timeframe, NUM_BARS);
    const snapshot = buildSnapshot(candles, s.lovable, timeframe);

    let evalResult;
    if (strategy === 'soloway_playbook') {
      // Soloway runs all its own filters. It accepts BTC and ETH for
      // signal generation, but the `liveAllowedSymbols` filter further
      // down still gates which signals get queued for live approval
      // (currently ETH-USD only — BTC-USD signals are watchlist-only).
      evalResult = evaluateSoloway(snapshot, { liveSymbol: s.backend });
    } else {
      evalResult = evaluateMarket(snapshot);
    }

    results.push({
      snapshot: evalResult.snapshot,
      recommendation: evalResult.recommendation,
      skipReasons: evalResult.skipReasons,
      skippedConfidence: evalResult.skippedConfidence,
      // Soloway extras (undefined for default strategy)
      setup: evalResult.setup || null,
      confidence: evalResult.confidence ?? null,
      atr: evalResult.atr ?? null,
      rsi: evalResult.rsi ?? null,
      confluenceCount: evalResult.confluenceCount ?? null,
    });

    // Per-symbol structured log per the spec's logging contract:
    //   { strategy, symbol, passed, confidence, skipReasons, atr, rsi, confluenceCount }
    logger.info(
      {
        event: 'scan.symbol.evaluated',
        strategy,
        symbol: s.backend,
        passed: !!evalResult.recommendation,
        confidence: evalResult.confidence ?? null,
        skipReasons: evalResult.skipReasons || null,
        atr: evalResult.atr ?? null,
        rsi: evalResult.rsi ?? null,
        confluenceCount: evalResult.confluenceCount ?? null,
      },
      `scan ${s.backend} under ${strategy}: ${
        evalResult.recommendation ? 'PASS' : 'WAIT'
      }`,
    );
  }

  // ----- Assisted / Auto mode: persist recommendations to the queue. -----
  // Only enqueue recommendations whose mapped live symbol is in the
  // LIVE_ALLOWED_SYMBOLS list (currently ETH-USD only) AND tradingMode is
  // 'assisted' OR 'auto'. enqueueRecommendation is idempotent on
  // recommendation_id.
  //
  // ASSISTED: SMS the operator. Wait for manual approve click.
  // AUTO:     SMS the operator (post-execution) AND immediately fire the
  //           recommendation through autoTrader.executeQueued → liveRiskManager
  //           → robinhood.placeOrder. All existing caps + gates still run.
  //
  // The send/execute is non-blocking — we don't await. Failures inside
  // autoTrader / smsAlerts never bubble out of the scan.
  let queuedCount = 0;
  let autoFiredCount = 0;
  const { mode: currentMode } = tradingMode.getMode();
  const queueEnabled =
    (currentMode === 'assisted' || currentMode === 'auto') && config.liveTradingEnabled;

  if (queueEnabled) {
    for (const r of results) {
      const rec = r.recommendation;
      if (!rec) continue;
      const liveSymbol = `${rec.symbol}-USD`;
      if (!config.liveAllowedSymbols.includes(liveSymbol)) continue;
      const normalized = { ...rec, symbol: liveSymbol };
      const enqueued = recommendationQueue.enqueueRecommendation(normalized);
      if (!enqueued) continue;
      queuedCount += 1;

      if (currentMode === 'auto') {
        // Auto mode: fire-and-forget execution. SMS will be sent
        // post-execution from inside autoTrader.executeQueued.
        autoFiredCount += 1;
        autoTrader
          .executeQueued(enqueued)
          .catch((err) => {
            logger.error(
              {
                event: 'auto.trade.unhandled',
                queueId: enqueued,
                recommendationId: rec.id,
                msg: err && err.message,
              },
              'auto-trade promise rejected unexpectedly',
            );
          });
      } else {
        // Assisted mode: SMS the operator that there's a pending row.
        const recForSms = {
          recommendationId: rec.id,
          symbol: liveSymbol,
          side: rec.side,
          suggestedAmountUsd: rec.amountUsd ?? rec.suggestedAmountUsd,
          confidenceScore: rec.confidenceScore,
          entryReason: rec.entryReason,
          entryPrice: rec.entryPrice,
        };
        smsAlerts.sendPendingApprovalAlert(recForSms).catch((err) => {
          logger.error(
            { event: 'sms.alert.failed', kind: 'unhandled', msg: err && err.message },
            'sms alert promise rejected unexpectedly',
          );
        });
      }
    }
  }

  const payload = {
    ok: true,
    timeframe,
    generatedAt: new Date().toISOString(),
    results,
    cached: false,
    tradingMode: currentMode,
    strategyMode: strategy,
    queued: queuedCount,
  };
  cache = { ts: Date.now(), payload };

  logger.info(
    {
      event: 'scan.completed',
      source,
      timeframe,
      symbols: SYMBOLS.map((s) => s.backend),
      recommendations: results.filter((r) => r.recommendation).length,
      skipped: results.filter((r) => !r.recommendation).length,
      tradingMode: currentMode,
      strategyMode: strategy,
      queued: queuedCount,
    },
    'scan completed',
  );

  return payload;
}

function getCacheStats() {
  return {
    cached: !!cache.payload,
    cachedAt: cache.payload ? new Date(cache.ts).toISOString() : null,
    cacheTimeframe: cache.payload?.timeframe || null,
    cacheTtlMs: CACHE_TTL_MS,
  };
}

module.exports = { runScan, getCacheStats, MarketDataError };
