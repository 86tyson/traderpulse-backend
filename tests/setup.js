'use strict';

// Test env: matters before config.js loads.
process.env.NODE_ENV = 'test';
process.env.BACKEND_API_KEY = 'test-bearer-token-1234567890abcdef';
process.env.FRONTEND_URL = 'http://localhost:5173';
process.env.BOT_ENABLED = 'true';
process.env.PAPER_MODE = 'true';
process.env.MAX_TRADE_USD = '25';
process.env.MAX_DAILY_LOSS_USD = '50';
process.env.ALLOWED_SYMBOLS = 'BTC-USD,ETH-USD';
process.env.MIN_CONFIDENCE = '0.5';
process.env.LOG_LEVEL = 'silent';

const validRequest = (overrides = {}) => ({
  recommendationId: `rec-${Math.random().toString(36).slice(2, 10)}`,
  symbol: 'BTC-USD',
  side: 'buy',
  suggestedAmountUsd: 10,
  confidenceScore: 0.7,
  entryReason: 'breakout',
  stopLoss: 60000,
  profitTarget: 65000,
  invalidationLevel: 59500,
  riskReward: 2,
  ...overrides,
});

module.exports = { validRequest };
