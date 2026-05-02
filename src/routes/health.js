'use strict';

const express = require('express');
const { config } = require('../config');
const { isManualApprovalRequired } = require('../services/autoTradingGate');

const router = express.Router();

router.get('/', (_req, res) => {
  // robinhoodConnected: are the API key + private key both present in env.
  // Mirrors the same boolean exposed at /api/public/status.
  const robinhoodConnected = !!(
    config.robinhoodApiKey && config.robinhoodPrivateKey
  );

  res.json({
    ok: true,
    server: 'running',
    paperMode: config.paperMode,
    botEnabled: config.botEnabled,
    liveTradingEnabled: config.liveTradingEnabled,
    autoTradingEnabled: config.autoTradingEnabled,
    manualApprovalRequired: isManualApprovalRequired(config),
    robinhoodConnected,
    allowedSymbols: config.allowedSymbols,
    liveAllowedSymbols: config.liveAllowedSymbols,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
