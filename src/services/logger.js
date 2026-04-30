'use strict';

const pino = require('pino');
const { config } = require('../config');

const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      '*.api_key',
      '*.apiKey',
      '*.private_key',
      '*.privateKey',
      '*.authorization',
      '*.bearer',
      'BACKEND_API_KEY',
      'ROBINHOOD_API_KEY',
      'ROBINHOOD_PRIVATE_KEY',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
