'use strict';

const express = require('express');
const { config } = require('../config');
const robinhood = require('../services/robinhoodClient');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  if (config.paperMode) {
    return res.json({
      ok: true,
      mode: 'paper',
      account: {
        cashUsd: 1000,
        equityUsd: 1000,
        buyingPowerUsd: 1000,
      },
      holdings: [
        { symbol: 'BTC-USD', quantity: 0, avgCostUsd: 0, marketValueUsd: 0 },
        { symbol: 'ETH-USD', quantity: 0, avgCostUsd: 0, marketValueUsd: 0 },
      ],
      note: 'Paper-mode mock data. Live data requires Robinhood Crypto API integration.',
    });
  }

  // Live mode: not implemented yet. The stub throws NotImplementedError -> 501.
  try {
    const account = await robinhood.getAccount();
    return res.json({ ok: true, mode: 'live', account });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
