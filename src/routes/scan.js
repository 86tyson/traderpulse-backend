'use strict';

/**
 * GET /scan
 *
 * Pulls live BTC-USD and ETH-USD candles from Binance public API, builds a
 * MarketSnapshot from each, runs evaluateMarket(), and returns the resulting
 * ScanResult per symbol. No order placement — recommendation generation only.
 *
 * Cached for 60 seconds in-memory to keep the strategy decision stable across
 * UI refreshes and to avoid hammering the upstream API.
 */

const express = require('express');
const { fetchCoinbaseCandles, MarketDataError } = require('../services/marketDataClient');
const { buildSnapshot } = require('../services/snapshotBuilder');
const { evaluateMarket } = require('../services/strategy');
const tradingMode = require('../services/tradingMode');
const recommendationQueue = require('../services/recommendationQueue');
const { config } = require('../config');
const logger = require('../services/logger');

const router = express.Router();

// Pair declaration: backend symbol (used by API contract + Binance fetcher)
// vs Lovable symbol (used inside MarketSnapshot/Recommendation, "BTC"/"ETH").
const SYMBOLS = [
  { backend: 'BTC-USD', lovable: 'BTC' },
  { backend: 'ETH-USD', lovable: 'ETH' },
];
const DEFAULT_TIMEFRAME = '1h';
const NUM_BARS = 100; // 50-period MA needs 50; extra buffer for ATR/swing-pivot lookbacks

// Simple in-process cache. Multiple users hitting the same scan within 60 seconds
// see the same recommendation, which is the right behavior — the strategy hasn't
// re-evaluated; only the UI re-rendered.
const CACHE_TTL_MS = 60_000;
let cache = { ts: 0, payload: null };

router.get('/', async (req, res, next) => {
  const timeframe = (req.query.timeframe || DEFAULT_TIMEFRAME).toString();

  // Cache key includes timeframe so different requests don't collide.
  if (cache.payload && cache.payload.timeframe === timeframe && Date.now() - cache.ts < CACHE_TTL_MS) {
    return res.json({ ...cache.payload, cached: true });
  }

  try {
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
    // We only enqueue recommendations whose symbol is in the LIVE allow-list
    // (currently ETH-USD only) AND when tradingMode is 'assisted'. Paused
    // mode produces scan results for display but does NOT queue anything.
    // The enqueue function is idempotent on recommendation_id, so a second
    // /scan call with the same cached recommendation is a no-op.
    let queuedCount = 0;
    const { mode: currentMode } = tradingMode.getMode();
    if (currentMode === 'assisted' && config.liveTradingEnabled) {
      for (const r of results) {
        const rec = r.recommendation;
        if (!rec) continue;
        // Recommendation symbols come from the strategy as 'BTC' / 'ETH'.
        // Live allow-list uses 'BTC-USD' / 'ETH-USD'. Map before checking.
        const liveSymbol = `${rec.symbol}-USD`;
        if (!config.liveAllowedSymbols.includes(liveSymbol)) continue;
        // Normalize the recommendation shape for the queue: it expects the
        // backend symbol (e.g. ETH-USD) and a `side`.
        const enqueued = recommendationQueue.enqueueRecommendation({
          ...rec,
          symbol: liveSymbol,
        });
        if (enqueued) queuedCount += 1;
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
        timeframe,
        symbols: SYMBOLS.map((s) => s.backend),
        recommendations: results.filter((r) => r.recommendation).length,
        skipped: results.filter((r) => !r.recommendation).length,
        tradingMode: currentMode,
        queued: queuedCount,
      },
      'scan completed',
    );

    return res.json(payload);
  } catch (err) {
    logger.error({ err: err && err.message }, 'scan failed');
    if (err instanceof MarketDataError) {
      return res.status(502).json({
        ok: false,
        code: 'MARKET_DATA_UNAVAILABLE',
        reason: err.message,
      });
    }
    return next(err);
  }
});

module.exports = router;
