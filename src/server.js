'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { config, validateOrExit } = require('./config');
const logger = require('./services/logger');
const { bearerAuth } = require('./middleware/auth');
const { errorHandler } = require('./middleware/errorHandler');

const healthRoutes = require('./routes/health');
const publicRoutes = require('./routes/public');
const accountRoutes = require('./routes/account');
const tradeRoutes = require('./routes/trade');
const tradesRoutes = require('./routes/trades');
const performanceRoutes = require('./routes/performance');
const weeklyReportRoutes = require('./routes/weeklyReport');
const scanRoutes = require('./routes/scan');
const forwardRoutes = require('./routes/forward');
const liveRoutes = require('./routes/live');
const aiRoutes = require('./routes/ai');
const publicApiRoutes = require('./routes/publicApi');

function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  // CORS: allow any origin in config.allowedOrigins (comma-separated
  // FRONTEND_URL env), plus any origin matching VERCEL_PREVIEW_REGEX if set.
  // Same-origin / curl / server-to-server requests have no Origin header
  // and are allowed through (CORS only matters for browser cross-origin).
  let previewRegex = null;
  if (config.vercelPreviewRegex) {
    try {
      previewRegex = new RegExp(config.vercelPreviewRegex);
    } catch (e) {
      logger.warn(
        { err: e.message, pattern: config.vercelPreviewRegex },
        'Invalid VERCEL_PREVIEW_REGEX; preview origins will be rejected.',
      );
    }
  }
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (config.allowedOrigins.includes(origin)) return cb(null, true);
        if (previewRegex && previewRegex.test(origin)) return cb(null, true);
        return cb(new Error(`CORS: origin not allowed: ${origin}`));
      },
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  // Public routes (no auth required) — MUST be before bearerAuth
  app.use('/health', healthRoutes);
  app.use('/api/public', publicRoutes);

  // Public read-only API (no auth). Mirrors the Railway public deployment
  // so the frontend can hit identical paths against either backend.
  app.use('/api/public', publicApiRoutes);

  // Everything below requires the shared bearer token.
  app.use(bearerAuth);

  const tradeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, code: 'RATE_LIMITED', reason: 'Too many trade requests' },
  });

  // Scan is rate-limited the same way as /trade since it hits an upstream
  // public market-data API on each cache miss.
  const scanLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, code: 'RATE_LIMITED', reason: 'Too many scan requests' },
  });

  app.use('/account', accountRoutes);
  app.use('/trade', tradeLimiter, tradeRoutes);
  app.use('/trades', tradesRoutes);
  app.use('/performance', performanceRoutes);
  app.use('/weekly-report', weeklyReportRoutes);
  app.use('/scan', scanLimiter, scanRoutes);
  app.use('/forward', forwardRoutes);
  app.use('/live', liveRoutes);
  app.use('/ai', aiRoutes);

  // 404 handler (at the very end)
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: 'Not found' });
  });

  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  validateOrExit();
  const app = buildApp();
  // ----- Robinhood credential diagnostic (non-secret) -----
  // Logs ONLY presence/absence + format hint. Never the actual values.
  // pino's redaction config in services/logger.js also blocks them as a
  // second line of defence in case anything tries to log them by mistake.
  const rhKey = String(config.robinhoodApiKey || '');
  const rhPriv = String(config.robinhoodPrivateKey || '').trim();
  const robinhoodCredsPresent = !!(rhKey && rhPriv);
  const robinhoodPrivateKeyFormat = !rhPriv
    ? 'missing'
    : rhPriv.startsWith('-----BEGIN')
    ? 'pem'
    : 'base64-or-other';
  // Lengths are useful for diagnosing truncated env vars (e.g. a multi-line
  // PEM that got chopped to one line in a deploy UI). Length alone is not
  // sufficient to recover or guess the secret.
  const robinhoodApiKeyLen = rhKey.length;
  const robinhoodPrivateKeyLen = rhPriv.length;

  app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        nodeEnv: config.nodeEnv,
        paperMode: config.paperMode,
        botEnabled: config.botEnabled,
        liveTradingEnabled: config.liveTradingEnabled,
        autoTradingEnabled: config.autoTradingEnabled,
        liveAllowedSymbols: config.liveAllowedSymbols,
        liveMaxOrderUsd: config.liveMaxOrderUsd,
        liveDailyLossCapUsd: config.liveDailyLossCapUsd,
        allowedSymbols: config.allowedSymbols,
        allowedOrigins: config.allowedOrigins,
        vercelPreviewRegex: config.vercelPreviewRegex || null,
        robinhoodCredsPresent,
        robinhoodPrivateKeyFormat,
        robinhoodApiKeyLen,
        robinhoodPrivateKeyLen,
      },
      `crypto-trading-backend listening on :${config.port}`,
    );
  });
}

module.exports = { buildApp };
