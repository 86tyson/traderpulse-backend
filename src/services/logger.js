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
      '*.auth_token',
      '*.authToken',
      '*.twilio_auth_token',
      '*.twilioAuthToken',
      '*.twilio_account_sid',
      '*.twilioAccountSid',
      'BACKEND_API_KEY',
      'ROBINHOOD_API_KEY',
      'ROBINHOOD_PRIVATE_KEY',
      'TWILIO_AUTH_TOKEN',
      'TWILIO_ACCOUNT_SID',
      'ADMIN_DASHBOARD_PASSWORD',
      'SESSION_SECRET',
    ],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
