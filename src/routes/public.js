'use strict';

const express = require('express');
const { config } = require('../config');
const db = require('../db');
const { isManualApprovalRequired } = require('../services/autoTradingGate');

const router = express.Router();

// GET /api/public/status
router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    paperMode: config.paperMode,
    botEnabled: config.botEnabled,
    liveTradingEnabled: config.liveTradingEnabled,
    autoTradingEnabled: config.autoTradingEnabled,
    manualApprovalRequired: isManualApprovalRequired(config),
    allowedSymbols: config.allowedSymbols,
    liveAllowedSymbols: config.liveAllowedSymbols,
    timestamp: new Date().toISOString(),
  });
});

// GET /api/public/performance
router.get('/performance', (_req, res) => {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'win'  THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END) AS losses,
         AVG(CASE WHEN outcome = 'win'  THEN simulated_pnl_usd END) AS avg_win,
         AVG(CASE WHEN outcome = 'loss' THEN simulated_pnl_usd END) AS avg_loss,
         COALESCE(SUM(simulated_pnl_usd), 0) AS net_pnl
       FROM trades
       WHERE status IN ('simulated', 'executed')
         AND outcome IN ('win', 'loss')`,
    )
    .get();

  const weekly = db
    .prepare(
      `SELECT COALESCE(SUM(simulated_pnl_usd), 0) AS weekly_pnl
       FROM trades
       WHERE status IN ('simulated', 'executed')
         AND outcome IN ('win', 'loss')
         AND created_at >= datetime('now', '-7 days')`,
    )
    .get();

  const total = totals.total || 0;
  const wins = totals.wins || 0;
  const losses = totals.losses || 0;
  const winRate = total > 0 ? wins / total : null;

  const avgWin = totals.avg_win;
  const avgLoss = totals.avg_loss;
  const realizedRR =
    avgWin != null && avgLoss != null && avgLoss !== 0
      ? Math.abs(avgWin / avgLoss)
      : null;

  res.json({
    ok: true,
    totalTrades: total,
    wins,
    losses,
    winRate,
    avgWinUsd: avgWin,
    avgLossUsd: avgLoss,
    realizedRR,
    netPnlUsd: totals.net_pnl,
    weeklyPnlUsd: weekly.weekly_pnl,
  });
});

// GET /api/public/trades
router.get('/trades', (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), 500)
      : 100;

  const rows = db
    .prepare(
      `SELECT id, symbol, side, suggested_amount_usd, confidence_score,
              entry_reason, stop_loss, profit_target, risk_reward,
              status, mode, simulated_pnl_usd,
              strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at,
              executed_at, exit_price, exit_timestamp, outcome
       FROM trades
       WHERE status IN ('simulated', 'executed')
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(limit);

  res.json({ ok: true, count: rows.length, trades: rows });
});

module.exports = router;
