'use strict';

// Public read-only endpoints for the Vite React frontend dashboard.
//
// These routes are mounted at /api/public BEFORE the global bearerAuth
// middleware, so they are accessible without a BACKEND_API_KEY token.
//
// IMPORTANT: Only safe, read-only data is exposed here. No trade placement,
// approval, execution, bot control, live-trading flags, or secrets.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const db = require('../db');
const robinhood = require('../services/robinhoodClient');

const router = express.Router();

const LATEST_FORWARD_PATH = path.join(config.dataDir, 'forward', 'latest.json');

// GET /api/public/account
// Returns paper-mode account data (mock). In live mode returns the live
// account summary. No secrets or credentials are included in the response.
router.get('/account', async (_req, res, next) => {
  if (config.paperMode) {
    return res.json({
      ok: true,
      mode: 'paper',
      account: {
        cashUsd: 1000,
        equityUsd: 1000,
        buyingPowerUsd: 1000,
      },
      holdings: [
        { symbol: 'BTC-USD', quantity: 0, avgCostUsd: 0, marketValueUsd: 0 },
        { symbol: 'ETH-USD', quantity: 0, avgCostUsd: 0, marketValueUsd: 0 },
      ],
      note: 'Paper-mode mock data. Live data requires Robinhood Crypto API integration.',
    });
  }

  try {
    const account = await robinhood.getAccount();
    return res.json({ ok: true, mode: 'live', account });
  } catch (err) {
    return next(err);
  }
});

// GET /api/public/performance
// Returns aggregate performance metrics derived from the trades table.
// All data is computed from closed (win/loss) trades only.
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

// GET /api/public/forward-feed
// Serves the most recent forward-validation snapshot written to disk by the
// forwardValidationEth1d runner. Read-only — no strategy logic is executed.
router.get('/forward-feed', (_req, res) => {
  if (!fs.existsSync(LATEST_FORWARD_PATH)) {
    return res.status(404).json({
      ok: false,
      code: 'NOT_FOUND',
      reason:
        'Forward-validation snapshot not generated yet. Run `npx tsx scripts/forwardValidationEth1d.ts` to produce it.',
    });
  }

  let raw;
  try {
    raw = fs.readFileSync(LATEST_FORWARD_PATH, 'utf8');
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      reason: `Could not read forward-validation snapshot: ${err.message}`,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      code: 'INTERNAL_ERROR',
      reason: `Forward-validation snapshot is malformed JSON: ${err.message}`,
    });
  }

  return res.json({ ok: true, ...parsed });
});

// GET /api/public/weekly-report
// Returns a 7-day trade summary: win/loss counts, net PnL, best and worst
// setups. Derived entirely from the local trades table — no external calls.
router.get('/weekly-report', (_req, res) => {
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
