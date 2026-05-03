'use strict';

/**
 * GET /scan
 *
 * Thin wrapper around services/scanner.js so the bot loop and HTTP callers
 * share identical behavior. See services/scanner.js for the actual logic.
 */

const express = require('express');
const { runScan, MarketDataError } = require('../services/scanner');
const logger = require('../services/logger');

const router = express.Router();

const DEFAULT_TIMEFRAME = '1h';

router.get('/', async (req, res, next) => {
  const timeframe = (req.query.timeframe || DEFAULT_TIMEFRAME).toString();
  try {
    const payload = await runScan({ timeframe, source: 'manual' });
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
