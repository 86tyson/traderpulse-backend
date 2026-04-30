'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, recommendation_id, symbol, side, entry_reason, simulated_pnl_usd, status, mode,
              outcome, exit_price, exit_timestamp,
              strftime('%Y-%m-%dT%H:%M:%SZ', created_at) AS created_at
       FROM trades
       WHERE created_at >= datetime('now', '-7 days')
         AND status IN ('simulated', 'executed')
         AND outcome IN ('win', 'loss')
       ORDER BY id DESC`,
    )
    .all();

  let wins = 0;
  let losses = 0;
  let net = 0;
  let best = null;
  let worst = null;
  for (const r of rows) {
    const pnl = r.simulated_pnl_usd;
    if (pnl == null) continue;
    net += pnl;
    if (pnl > 0) wins += 1;
    if (pnl < 0) losses += 1;
    if (!best || pnl > best.simulated_pnl_usd) best = r;
    if (!worst || pnl < worst.simulated_pnl_usd) worst = r;
  }

  res.json({
    ok: true,
    period: 'last_7_days',
    totalTrades: rows.length,
    wins,
    losses,
    netPnlUsd: net,
    bestSetup: best
      ? { recommendationId: best.recommendation_id, entryReason: best.entry_reason, pnlUsd: best.simulated_pnl_usd }
      : null,
    worstSetup: worst
      ? { recommendationId: worst.recommendation_id, entryReason: worst.entry_reason, pnlUsd: worst.simulated_pnl_usd }
      : null,
    notes: 'Setups are grouped by entryReason. P&L only reflects trades with simulated_pnl_usd recorded.',
  });
});

module.exports = router;
