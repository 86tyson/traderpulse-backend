#!/usr/bin/env node
'use strict';

// scripts/reconcileLiveFills.js
//
// CLI wrapper around services/reconciler.js. Run from the repo root:
//   node scripts/reconcileLiveFills.js
//
// Behavior is byte-identical to POST /live/reconcile — same orchestrator,
// same decision logic, same DB updates. Useful for:
//   - Cron-driven reconciliation
//   - Recovering after a backend crash without needing the HTTP server up
//   - One-off manual cleanup after a stuck order
//
// READ-ONLY against Robinhood. No orders placed. Does NOT require
// LIVE_TRADING_ENABLED.

const { config, validateOrExit } = require('../src/config');
const { reconcileAll } = require('../src/services/reconciler');

async function main() {
  // Soft-validate config — we need RH creds, but we don't need
  // LIVE_TRADING_ENABLED.
  validateOrExit();

  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    console.error(
      '[reconcile] ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY must be set in .env.',
    );
    process.exit(1);
  }

  console.log('Reconciliation: read-only against Robinhood, no orders placed.');
  console.log('-----------------------------------------------------------------');

  let summary;
  try {
    summary = await reconcileAll();
  } catch (err) {
    console.error('[reconcile] FAILED:', err.message);
    process.exit(2);
  }

  // Pretty-print summary.
  console.log('');
  console.log('Summary:');
  console.log(`  Orders checked:      ${summary.ordersChecked}`);
  console.log(`  Rows updated:        ${summary.rowsUpdated}`);
  console.log(`  Filled found:        ${summary.filledFound}`);
  console.log(`  Cancelled found:     ${summary.cancelledFound}`);
  console.log(`  Rejected/failed:     ${summary.rejectedFound}`);
  console.log(`  Partial fills:       ${summary.partialFound}`);
  console.log(`  Warnings:            ${summary.warnings.length}`);

  if (summary.actions.length > 0) {
    console.log('');
    console.log('Actions:');
    for (const a of summary.actions) {
      console.log(`  row #${a.rowId}: ${a.action} — ${a.reason}`);
    }
  }

  if (summary.warnings.length > 0) {
    console.log('');
    console.log('⚠ Warnings (manual review may be needed):');
    for (const w of summary.warnings) {
      console.log(`  • ${w}`);
    }
  }

  // Exit non-zero if any warnings — useful for cron alerting.
  process.exit(summary.warnings.length > 0 ? 3 : 0);
}

main().catch((err) => {
  console.error('[reconcile] uncaught error:', err);
  process.exit(99);
});
