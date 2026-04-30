'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (_req, res) => {
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

  // Realized R:R, computed off mean win and mean (absolute) loss.
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

module.exports = router;
