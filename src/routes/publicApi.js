'use strict';

// /api/public/* — read-only routes that bypass the bearer-auth middleware.
//
// Mounted BEFORE `bearerAuth` in server.js. No Authorization header is
// required to hit any of these routes. They are safe to expose because:
//   - Robinhood credentials are never echoed back (they're never in the
//     response body — see the explicit cherry-picking below).
//   - No order placement, no DB writes, no trading-action paths.
//   - Auth-protected order placement / approval / AI / scan still gate
//     normally on `bearerAuth` further down the middleware chain.
//
// LOCAL vs PRODUCTION shape difference:
//   - The Railway public deploy returns a minimal flag-only payload (no
//     account, no caps, no today.*). That's intentional for a public
//     dashboard: anyone visiting the deployed URL shouldn't see your
//     position state or RH credential health.
//   - This LOCAL implementation returns the richer shape — robinhoodConnected,
//     caps, and today.* — so the local frontend can decide whether to render
//     the live-trading UI. The frontend's `getLiveStatus` adapter reads any
//     fields that are present and falls back to safe defaults for missing ones,
//     so both shapes coexist cleanly.

const express = require('express');
const { config } = require('../config');
const { isManualApprovalRequired } = require('../services/autoTradingGate');
const db = require('../db');

const router = express.Router();

function liveLossToday() {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(simulated_pnl_usd), 0) AS loss
         FROM trades
        WHERE date(created_at) = date('now')
          AND mode = 'live'
          AND simulated_pnl_usd IS NOT NULL
          AND simulated_pnl_usd < 0`,
    )
    .get();
  return Math.abs(row.loss || 0);
}

function openLivePositions() {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
        WHERE mode = 'live' AND status = 'executed' AND side = 'buy' AND outcome IS NULL`,
    )
    .get();
  return row.n || 0;
}

// ----- GET /api/public/status -----
router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    paperMode: config.paperMode,
    botEnabled: config.botEnabled,
    liveTradingEnabled: config.liveTradingEnabled,
    autoTradingEnabled: config.autoTradingEnabled,
    requireApproval: config.requireApproval,
    manualApprovalRequired: isManualApprovalRequired(config),
    robinhoodConnected: !!(config.robinhoodApiKey && config.robinhoodPrivateKey),
    allowedSymbols: config.allowedSymbols,
    liveAllowedSymbols: config.liveAllowedSymbols,
    caps: {
      maxOrderUsd: config.liveMaxOrderUsd,
      dailyLossCapUsd: config.liveDailyLossCapUsd,
      allowedSymbols: config.liveAllowedSymbols,
    },
    today: {
      openLivePositions: openLivePositions(),
      liveRealizedLossUsd: liveLossToday(),
    },
    timestamp: new Date().toISOString(),
  });
});

// ----- GET /api/public/performance -----
router.get('/performance', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT outcome, simulated_pnl_usd
         FROM trades
        WHERE outcome IN ('win', 'loss')`,
    )
    .all();

  const wins = rows.filter((r) => r.outcome === 'win').length;
  const losses = rows.filter((r) => r.outcome === 'loss').length;
  const total = rows.length;
  const winRate = total > 0 ? wins / total : null;
  const winsArr = rows.filter(
    (r) => r.outcome === 'win' && r.simulated_pnl_usd != null,
  );
  const lossesArr = rows.filter(
    (r) => r.outcome === 'loss' && r.simulated_pnl_usd != null,
  );
  const avgWinUsd =
    winsArr.length > 0
      ? winsArr.reduce((a, r) => a + r.simulated_pnl_usd, 0) / winsArr.length
      : null;
  const avgLossUsd =
    lossesArr.length > 0
      ? lossesArr.reduce((a, r) => a + r.simulated_pnl_usd, 0) /
        lossesArr.length
      : null;
  const netPnlUsd = rows.reduce((a, r) => a + (r.simulated_pnl_usd || 0), 0);

  const weeklyRow = db
    .prepare(
      `SELECT COALESCE(SUM(simulated_pnl_usd), 0) AS pnl
         FROM trades
        WHERE simulated_pnl_usd IS NOT NULL
          AND created_at >= datetime('now', '-7 days')`,
    )
    .get();

  res.json({
    ok: true,
    totalTrades: total,
    wins,
    losses,
    winRate,
    avgWinUsd,
    avgLossUsd,
    realizedRR: null,
    netPnlUsd: Math.round(netPnlUsd * 1e4) / 1e4,
    weeklyPnlUsd: Math.round((weeklyRow.pnl || 0) * 1e4) / 1e4,
  });
});

// ----- GET /api/public/trades -----
// Last 50 trades. Note: we exclude `raw_request_json` and `raw_response_json`
// (which contain RH order details / client_order_ids that aren't credentials
// but aren't appropriate for a public list).
router.get('/trades', (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, recommendation_id, symbol, side, suggested_amount_usd,
              confidence_score, status, mode, simulated_pnl_usd, robinhood_order_id,
              created_at, executed_at, exit_price, exit_timestamp, outcome,
              entry_price, filled_quantity, fill_timestamp
         FROM trades
        ORDER BY id DESC
        LIMIT 50`,
    )
    .all();
  res.json({ ok: true, count: rows.length, trades: rows });
});

module.exports = router;
