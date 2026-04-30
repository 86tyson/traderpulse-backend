'use strict';

// Reconciliation: sync local trade rows with actual Robinhood order state.
//
// Two layers:
//   1. `decideReconcileAction(localTrade, rhOrder)` — PURE function. Given a
//      single local row and the matching RH order shape, returns a discrim-
//      inated decision describing what to do. No DB, no network, no time.
//   2. `reconcileAll({ getOrderById?, db? })` — orchestrator. Reads all
//      `mode='live'` rows with a `robinhood_order_id`, fetches each from RH
//      (sequentially — gentle on RH), pairs sells to their buys, applies
//      DB updates per the decision, returns a summary. Fully test-injectable.
//
// SAFETY:
//   - Read-only against Robinhood (only `getOrderById`; no order placement).
//   - Does NOT require LIVE_TRADING_ENABLED (no orders are created).
//   - Will never invent fills — every update path requires concrete RH data.
//   - Partial fills NEVER mark the buy fully closed; warnings are surfaced.
//   - All updates are idempotent: re-running reconcile yields the same
//     terminal state.

const dbDefault = require('../db');
const robinhood = require('./robinhoodClient');
const logger = require('./logger');

const round4 = (n) => {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e4) / 1e4;
};

// Allow ≥99.9% of requested qty as "fully filled" (defensive against trailing-
// digit rounding inside RH's response). Same threshold as closeDecision.
const FILL_QTY_TOLERANCE = 0.001;

// ============================================================================
// Pure decision
// ============================================================================
/**
 * @param {object} args
 * @param {object} args.localTrade  - row from `trades` (must include side, outcome, recommendation_id)
 * @param {object} args.rhOrder     - response from RH `getOrderById` (shape: { state, filled_asset_quantity, average_price, updated_at, ... })
 * @returns {object} decision with `action`, `updates` (sql), `reason`, optional `warning`, optional `sellAvgPrice`/`sellFilledQty` for sell-induced closes.
 */
function decideReconcileAction({ localTrade, rhOrder }) {
  const side = localTrade.side;
  const localOutcome = localTrade.outcome ?? null;
  const rhState = rhOrder?.state ?? null;
  const filledQty = Number(rhOrder?.filled_asset_quantity ?? 0);
  const avgPriceRaw = Number(rhOrder?.average_price ?? NaN);
  const validAvg = Number.isFinite(avgPriceRaw) && avgPriceRaw > 0;
  const fillTime = rhOrder?.updated_at || null;

  const settled = (o) =>
    o === 'win' || o === 'loss' || o === 'breakeven' || o === 'cancelled' ||
    o === 'rejected' || o === 'failed' || o === 'closed';

  if (!rhOrder || !rhState) {
    return { action: 'noop', reason: 'no Robinhood order data — skipped' };
  }

  // ===== BUY rows =====
  if (side === 'buy') {
    if (settled(localOutcome)) {
      return { action: 'noop', reason: `buy already settled locally (${localOutcome})` };
    }

    if (rhState === 'filled' && validAvg && filledQty > 0) {
      // Idempotent: if entry_price + filled_quantity already match, noop.
      const localEntry = Number(localTrade.entry_price);
      const localFilled = Number(localTrade.filled_quantity);
      const entryMatches =
        Number.isFinite(localEntry) &&
        Math.abs(localEntry - avgPriceRaw) < 1e-6;
      const qtyMatches =
        Number.isFinite(localFilled) &&
        Math.abs(localFilled - filledQty) < 1e-9;
      if (entryMatches && qtyMatches) {
        return {
          action: 'noop',
          reason: 'buy already reconciled (entry_price + filled_quantity match)',
        };
      }
      return {
        action: 'mark-buy-filled',
        updates: {
          entry_price: avgPriceRaw,
          filled_quantity: filledQty,
          fill_timestamp: fillTime || new Date().toISOString(),
        },
        reason: 'buy filled at RH; recorded fill data (still open, awaiting close)',
      };
    }
    if (rhState === 'canceled' || rhState === 'cancelled') {
      return {
        action: 'mark-buy-cancelled',
        updates: { outcome: 'cancelled', simulated_pnl_usd: 0 },
        reason: 'buy was cancelled at Robinhood',
      };
    }
    if (rhState === 'rejected') {
      return {
        action: 'mark-buy-rejected',
        updates: { outcome: 'rejected', simulated_pnl_usd: 0 },
        reason: 'buy was rejected at Robinhood',
      };
    }
    if (rhState === 'failed') {
      return {
        action: 'mark-buy-failed',
        updates: { outcome: 'failed', simulated_pnl_usd: 0 },
        reason: 'buy failed at Robinhood',
      };
    }
    if (rhState === 'partially_filled') {
      return {
        action: 'mark-buy-partial',
        updates: {
          entry_price: validAvg ? avgPriceRaw : null,
          filled_quantity: filledQty,
        },
        warning: true,
        reason:
          `buy is PARTIALLY filled (${filledQty} so far) — manual review needed before close`,
      };
    }
    if (rhState === 'open' || rhState === 'queued') {
      return { action: 'noop', reason: `buy still pending at RH (${rhState})` };
    }
    return { action: 'noop', reason: `unknown RH state for buy: "${rhState}"` };
  }

  // ===== SELL rows =====
  if (side === 'sell') {
    // Truly settled — no further reconciliation possible.
    if (
      localOutcome === 'closed' ||
      localOutcome === 'rejected' ||
      localOutcome === 'cancelled' ||
      localOutcome === 'failed'
    ) {
      return { action: 'noop', reason: `sell already settled locally (${localOutcome})` };
    }

    // In-flight states the orchestrator can recover from:
    //   - outcome=null     → never updated by any prior path
    //   - outcome=timeout  → poller deadline hit; sell may have filled later
    //   - outcome=partial  → some filled; might be fully filled now
    //   - outcome=pending  → defensive (legacy)
    const isInFlight =
      localOutcome === null ||
      localOutcome === undefined ||
      localOutcome === 'timeout' ||
      localOutcome === 'partial' ||
      localOutcome === 'pending';

    if (isInFlight) {
      if (rhState === 'filled' && validAvg && filledQty > 0) {
        return {
          action: 'close-buy-from-sell',
          // The orchestrator looks up the paired buy and computes P/L.
          sellUpdates: {
            outcome: 'closed',
            simulated_pnl_usd: 0,
            exit_price: avgPriceRaw,
            exit_timestamp: fillTime || new Date().toISOString(),
            filled_quantity: filledQty,
          },
          sellAvgPrice: avgPriceRaw,
          sellFilledQty: filledQty,
          fillTime,
          reason:
            localOutcome === 'timeout' || localOutcome === 'partial'
              ? `previously-${localOutcome} sell now fully filled at RH; retroactively closing buy`
              : 'sell filled at RH; retroactively closing buy',
        };
      }
      if (rhState === 'canceled' || rhState === 'cancelled') {
        return {
          action: 'mark-sell-cancelled',
          updates: { outcome: 'cancelled', simulated_pnl_usd: 0 },
          reason: 'sell cancelled at RH; buy stays OPEN',
        };
      }
      if (rhState === 'rejected') {
        return {
          action: 'mark-sell-rejected',
          updates: { outcome: 'rejected', simulated_pnl_usd: 0 },
          reason: 'sell rejected at RH; buy stays OPEN',
        };
      }
      if (rhState === 'failed') {
        return {
          action: 'mark-sell-failed',
          updates: { outcome: 'failed', simulated_pnl_usd: 0 },
          reason: 'sell failed at RH; buy stays OPEN',
        };
      }
      if (rhState === 'partially_filled') {
        return {
          action: 'mark-sell-partial',
          updates: {
            outcome: 'partial',
            filled_quantity: filledQty,
            exit_price: validAvg ? avgPriceRaw : null,
          },
          warning: true,
          reason:
            `sell PARTIALLY filled (${filledQty}) — buy stays OPEN, manual review needed`,
        };
      }
      if (rhState === 'open' || rhState === 'queued') {
        return { action: 'noop', reason: `sell still pending at RH (${rhState})` };
      }
      return { action: 'noop', reason: `unknown RH state for sell: "${rhState}"` };
    }

    return { action: 'noop', reason: `sell in unrecognized local outcome: ${localOutcome}` };
  }

  return { action: 'noop', reason: `unrecognized side "${side}"` };
}

// ============================================================================
// Orchestrator
// ============================================================================
/**
 * @param {object} [opts]
 * @param {function} [opts.getOrderById] - dependency injection for tests
 * @param {object}   [opts.db]           - dependency injection for tests
 * @returns {Promise<{
 *   ordersChecked: number,
 *   rowsUpdated: number,
 *   filledFound: number,
 *   cancelledFound: number,
 *   rejectedFound: number,
 *   partialFound: number,
 *   warnings: string[],
 *   actions: Array<{ rowId: number, action: string, reason: string }>,
 * }>}
 */
async function reconcileAll(opts = {}) {
  const getOrderById = opts.getOrderById ?? robinhood.getOrderById;
  const db = opts.db ?? dbDefault;

  const rows = db
    .prepare(
      `SELECT id, recommendation_id, side, outcome, status, robinhood_order_id,
              simulated_pnl_usd, entry_price, filled_quantity, exit_price
         FROM trades
        WHERE mode = 'live' AND robinhood_order_id IS NOT NULL
        ORDER BY id ASC`,
    )
    .all();

  const summary = {
    ordersChecked: 0,
    rowsUpdated: 0,
    filledFound: 0,
    cancelledFound: 0,
    rejectedFound: 0,
    partialFound: 0,
    warnings: [],
    actions: [],
  };

  // ----- Pass 1: fetch all RH orders -----
  // Sequential keeps us gentle on RH's rate limits and matches our existing
  // request-per-call pattern. With at most a few dozen live trades for Phase 3,
  // this is fine. For larger scales, batch via Promise.all with concurrency.
  const rhMap = new Map();
  for (const row of rows) {
    summary.ordersChecked += 1;
    try {
      const order = await getOrderById(row.robinhood_order_id);
      rhMap.set(row.id, order);
    } catch (err) {
      summary.warnings.push(
        `row ${row.id} (${row.side}): RH fetch failed — ${err.message}`,
      );
      logger.warn(
        { event: 'reconcile.fetch_fail', rowId: row.id, msg: err.message },
        'reconcile fetch failed',
      );
    }
  }

  // ----- Pass 2a: compute decisions; identify buys that will be closed
  // -----              by a sell in this same pass (so we skip the redundant
  // -----              mark-buy-filled write — close-buy-from-sell already
  // -----              sets entry_price + filled_quantity on the buy row).
  const decisions = new Map();
  const buysClosedBySellInThisPass = new Set();
  for (const row of rows) {
    const rhOrder = rhMap.get(row.id);
    if (!rhOrder) continue;
    const d = decideReconcileAction({ localTrade: row, rhOrder });
    decisions.set(row.id, d);
    if (d.action === 'close-buy-from-sell') {
      const buyRecId = (row.recommendation_id || '').replace(/^close-of-/, '');
      const pairedBuy = rows.find(
        (r) => r.side === 'buy' && r.recommendation_id === buyRecId,
      );
      if (pairedBuy) buysClosedBySellInThisPass.add(pairedBuy.id);
    }
  }

  // ----- Pass 2b: apply updates -----
  for (const row of rows) {
    const rhOrder = rhMap.get(row.id);
    if (!rhOrder) continue; // already noted as a warning

    let decision = decisions.get(row.id);
    if (!decision) continue;

    // Subsume the redundant mark-buy-filled when a sell in this pass will
    // close this buy — the close path writes the same fill data + outcome
    // in a single statement.
    if (
      decision.action === 'mark-buy-filled' &&
      buysClosedBySellInThisPass.has(row.id)
    ) {
      decision = {
        action: 'noop',
        reason: 'buy will be closed by paired sell in this same pass',
      };
    }

    summary.actions.push({ rowId: row.id, action: decision.action, reason: decision.reason });
    if (decision.warning) {
      summary.warnings.push(`row ${row.id}: ${decision.reason}`);
    }
    if (decision.action === 'noop') continue;

    // Counter bookkeeping (used in summary).
    if (decision.action === 'mark-buy-filled') summary.filledFound += 1;
    if (decision.action === 'close-buy-from-sell') summary.filledFound += 1;
    if (decision.action.endsWith('-cancelled')) summary.cancelledFound += 1;
    if (
      decision.action.endsWith('-rejected') ||
      decision.action.endsWith('-failed')
    ) {
      summary.rejectedFound += 1;
    }
    if (decision.action.endsWith('-partial')) summary.partialFound += 1;

    try {
      if (decision.action === 'close-buy-from-sell') {
        // Find the paired BUY by stripping the "close-of-" prefix.
        const buyRecId = (row.recommendation_id || '').replace(/^close-of-/, '');
        if (!buyRecId || buyRecId === row.recommendation_id) {
          summary.warnings.push(
            `row ${row.id}: sell rec_id "${row.recommendation_id}" missing "close-of-" prefix; cannot pair`,
          );
          continue;
        }
        const buyRow = db
          .prepare(
            `SELECT id, robinhood_order_id, outcome, entry_price, filled_quantity
               FROM trades WHERE recommendation_id = ? AND side = 'buy'`,
          )
          .get(buyRecId);
        if (!buyRow) {
          summary.warnings.push(
            `row ${row.id}: no paired buy found for rec_id "${buyRecId}"`,
          );
          continue;
        }
        if (
          buyRow.outcome === 'win' ||
          buyRow.outcome === 'loss' ||
          buyRow.outcome === 'breakeven'
        ) {
          summary.warnings.push(
            `row ${row.id}: paired buy ${buyRow.id} already settled (${buyRow.outcome}); skipping`,
          );
          // Apply the sell-side update only — buy is already done.
          db.prepare(
            `UPDATE trades SET outcome=@outcome, simulated_pnl_usd=@simulated_pnl_usd,
                exit_price=@exit_price, exit_timestamp=@exit_timestamp, filled_quantity=@filled_quantity,
                raw_response_json=@raw
              WHERE id=@id`,
          ).run({
            ...decision.sellUpdates,
            raw: JSON.stringify({ ...rhOrder, _reconciledAt: new Date().toISOString() }),
            id: row.id,
          });
          summary.rowsUpdated += 1;
          continue;
        }

        // Source the BUY's actual fill data — prefer the freshly-fetched RH
        // order; fall back to whatever's in the local row (if reconciled
        // earlier). Refuse to compute P/L on missing data.
        const buyRhOrder = rhMap.get(buyRow.id);
        const buyAvgPrice =
          (buyRhOrder && Number(buyRhOrder.average_price)) ||
          Number(buyRow.entry_price);
        const buyFilledQty =
          (buyRhOrder && Number(buyRhOrder.filled_asset_quantity)) ||
          Number(buyRow.filled_quantity);
        const buyFillTime =
          (buyRhOrder && buyRhOrder.updated_at) || null;

        if (
          !Number.isFinite(buyAvgPrice) ||
          buyAvgPrice <= 0 ||
          !Number.isFinite(buyFilledQty) ||
          buyFilledQty <= 0
        ) {
          summary.warnings.push(
            `row ${row.id}: paired buy ${buyRow.id} fill data missing/invalid — cannot compute realized P/L`,
          );
          continue;
        }

        // Defensive: if sell qty < buy qty, treat as partial (NOT closed).
        if (decision.sellFilledQty < buyFilledQty * (1 - FILL_QTY_TOLERANCE)) {
          summary.warnings.push(
            `row ${row.id}: sell filled (${decision.sellFilledQty}) is less than buy filled (${buyFilledQty}) — marking as partial, NOT closing buy`,
          );
          db.prepare(
            `UPDATE trades SET outcome='partial', filled_quantity=?, exit_price=?, exit_timestamp=?, raw_response_json=?
              WHERE id=?`,
          ).run(
            decision.sellFilledQty,
            decision.sellAvgPrice,
            decision.fillTime || new Date().toISOString(),
            JSON.stringify({ ...rhOrder, _reconciledAt: new Date().toISOString() }),
            row.id,
          );
          summary.rowsUpdated += 1;
          summary.partialFound += 1;
          continue;
        }

        const closedQty = Math.min(buyFilledQty, decision.sellFilledQty);
        const realizedPnlUsd = round4(
          (decision.sellAvgPrice - buyAvgPrice) * closedQty,
        );
        const buyOutcome =
          realizedPnlUsd > 0 ? 'win' : realizedPnlUsd < 0 ? 'loss' : 'breakeven';

        // Update SELL row.
        db.prepare(
          `UPDATE trades SET outcome=@outcome, simulated_pnl_usd=@simulated_pnl_usd,
              exit_price=@exit_price, exit_timestamp=@exit_timestamp, filled_quantity=@filled_quantity,
              raw_response_json=@raw
            WHERE id=@id`,
        ).run({
          ...decision.sellUpdates,
          raw: JSON.stringify({ ...rhOrder, _reconciledAt: new Date().toISOString() }),
          id: row.id,
        });

        // Update BUY row with realized P/L + actual entry data.
        db.prepare(
          `UPDATE trades SET outcome=?, simulated_pnl_usd=?, exit_price=?, exit_timestamp=?,
              entry_price=?, filled_quantity=?, fill_timestamp=?
            WHERE id=?`,
        ).run(
          buyOutcome,
          realizedPnlUsd,
          decision.sellAvgPrice,
          decision.fillTime || new Date().toISOString(),
          buyAvgPrice,
          buyFilledQty,
          buyFillTime,
          buyRow.id,
        );
        summary.rowsUpdated += 2;

        logger.warn(
          {
            event: 'reconcile.closed',
            buyRowId: buyRow.id,
            sellRowId: row.id,
            buyAvgPrice,
            buyFilledQty,
            sellAvgPrice: decision.sellAvgPrice,
            sellFilledQty: decision.sellFilledQty,
            realizedPnlUsd,
            buyOutcome,
          },
          'Reconciled close: buy retroactively closed from sell fill',
        );
        continue;
      }

      // Standard single-row update path.
      const updates = decision.updates || {};
      const fieldNames = Object.keys(updates);
      if (fieldNames.length === 0) continue;
      const setClause = fieldNames.map((f) => `${f} = @${f}`).join(', ');
      // Also persist the latest RH response for audit.
      db.prepare(
        `UPDATE trades SET ${setClause}, raw_response_json = @raw WHERE id = @id`,
      ).run({
        ...updates,
        raw: JSON.stringify({ ...rhOrder, _reconciledAt: new Date().toISOString() }),
        id: row.id,
      });
      summary.rowsUpdated += 1;
    } catch (err) {
      summary.warnings.push(`row ${row.id}: update failed — ${err.message}`);
      logger.error(
        { event: 'reconcile.update_fail', rowId: row.id, msg: err.message },
        'reconcile update failed',
      );
    }
  }

  return summary;
}

module.exports = { decideReconcileAction, reconcileAll, FILL_QTY_TOLERANCE };
