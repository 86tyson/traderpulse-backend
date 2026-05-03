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
const tradingMode = require('./tradingMode');
const recommendationQueue = require('./recommendationQueue');
const smsAlerts = require('./smsAlerts');
const { config } = require('../config');
const logger = require('./logger');

const SYMBOLS = [
  { backend: 'BTC-USD', lovable: 'BTC' },
  { backend: 'ETH-USD', lovable: 'ETH' },
];
const DEFAULT_TIMEFRAME = '1h';
const NUM_BARS = 100;
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

  const results = [];
  for (const s of SYMBOLS) {
    const candles = await fetchCoinbaseCandles(s.backend, timeframe, NUM_BARS);
    const snapshot = buildSnapshot(candles, s.lovable, timeframe);
    const evalResult = evaluateMarket(snapshot);
    results.push({
      snapshot: evalResult.snapshot,
      recommendation: evalResult.recommendation,
      skipReasons: evalResult.skipReasons,
      skippedConfidence: evalResult.skippedConfidence,
    });
  }

  // ----- Assisted mode: persist recommendations to the approval queue. -----
  // Only enqueue recommendations whose mapped live symbol is in the
  // LIVE_ALLOWED_SYMBOLS list (currently ETH-USD only) AND tradingMode is
  // 'assisted'. enqueueRecommendation is idempotent on recommendation_id.
  //
  // SMS ALERT: when (and only when) enqueueRecommendation returns a
  // non-null id (i.e. a NEW row was actually inserted, not a duplicate
  // hit on the UNIQUE constraint), fire one notification SMS via
  // smsAlerts. The send is non-blocking — we don't await — so a Twilio
  // outage cannot delay scan responses or pause the bot loop. smsAlerts
  // never throws and never approves a trade; it's purely a notification.
  let queuedCount = 0;
  const { mode: currentMode } = tradingMode.getMode();
  if (currentMode === 'assisted' && config.liveTradingEnabled) {
    for (const r of results) {
      const rec = r.recommendation;
      if (!rec) continue;
      const liveSymbol = `${rec.symbol}-USD`;
      if (!config.liveAllowedSymbols.includes(liveSymbol)) continue;
      const normalized = { ...rec, symbol: liveSymbol };
      const enqueued = recommendationQueue.enqueueRecommendation(normalized);
      if (enqueued) {
        queuedCount += 1;
        // Fire-and-forget. Errors handled inside smsAlerts; never block.
        // If SMS_ALERTS_ENABLED=false or Twilio config missing, this is a
        // cheap no-op that just logs sms.alert.skipped.
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
          // Defensive: smsAlerts already swallows errors internally,
          // but in case future changes throw, never let it bubble out
          // of scan/loop.
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
