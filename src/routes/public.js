'use strict';

const express = require('express');
const db = require('../db');
const { config } = require('../config');
const { isManualApprovalRequired } = require('../services/autoTradingGate');

const router = express.Router();

// GET /api/public/status — bot status flags (read-only, no secrets)
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

// GET /api/public/performance — aggregate P&L stats (read-only)
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

  const openCount = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM trades
       WHERE status IN ('simulated', 'executed')
         AND outcome IS NULL`,
    )
    .get().n;

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
    openOrUnsettled: openCount,
    winRate,
    avgWinUsd: avgWin,
    avgLossUsd: avgLoss,
    realizedRR,
    netPnlUsd: totals.net_pnl,
    weeklyPnlUsd: weekly.weekly_pnl,
    note: 'Includes closed (win/loss) trades only. Open trades are surfaced via openOrUnsettled.',
  });
});

// GET /api/public/trades — recent trade list (read-only, no account secrets)
router.get('/trades', (req, res) => {
  const ALLOWED_STATUS = new Set(['simulated', 'executed', 'rejected']);
  const ALLOWED_MODE = new Set(['paper', 'live']);

  const limitRaw = Number(req.query.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;

  const filters = [];
  const params = [];
  if (req.query.status && ALLOWED_STATUS.has(String(req.query.status))) {
    filters.push('status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.mode && ALLOWED_MODE.has(String(req.query.mode))) {
    filters.push('mode = ?');
    params.push(String(req.query.mode));
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT id, symbol, side, suggested_amount_usd, confidence_score,
              entry_reason, stop_loss, profit_target, risk_reward,
              status, mode, simulated_pnl_usd,
              strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at,
              executed_at, exit_price, exit_timestamp, outcome
       FROM trades
       ${where}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(...params, limit);

  res.json({ ok: true, count: rows.length, trades: rows });
});

module.exports = router;
