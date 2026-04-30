'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { config, validateOrExit } = require('./config');
const logger = require('./services/logger');
const { bearerAuth } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const healthRoutes = require('./routes/health');
const accountRoutes = require('./routes/account');
const tradeRoutes = require('./routes/trade');
const tradesRoutes = require('./routes/trades');
const performanceRoutes = require('./routes/performance');
const weeklyReportRoutes = require('./routes/weeklyReport');
const scanRoutes = require('./routes/scan');
const forwardRoutes = require('./routes/forward');
const liveRoutes = require('./routes/live');
const aiRoutes = require('./routes/ai');

function buildApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: config.frontendUrl,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  // Public health check (no auth) so uptime monitors can hit it.
  app.use('/health', healthRoutes);

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

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  validateOrExit();
  const app = buildApp();
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
        frontendUrl: config.frontendUrl,
      },
      `crypto-trading-backend listening on :${config.port}`,
    );
  });
}

module.exports = { buildApp };
