'use strict';

// Pure function that interprets a Robinhood sell-poll result and tells the
// route handler how to update the database and what response to send.
//
// Input: the original buy order (already filled), the poll result for the
// sell order, and the sell limit price we requested.
//
// Output: a discriminated decision object with an `action` field. The route
// uses the action to decide (a) which DB rows to update and how, and (b)
// what HTTP response shape to return.
//
// Action values:
//   - "closed"     → sell fully filled. Compute realized P/L from REAL fill
//                    avg_price and filled_asset_quantity. Update buy +
//                    sell rows; clear position gate.
//   - "partial"    → state was filled-but-quantity-mismatched, or any state
//                    with 0 < filled < requested. P/L on filled portion only.
//                    DO NOT clear the buy row's outcome (position partially
//                    open). Mark sell row 'partial'.
//   - "rejected"   → RH refused the sell. No fill, no P/L. Buy row UNCHANGED
//                    (position still open).
//   - "cancelled"  → sell was cancelled (rare in our flow but RH may return
//                    this if e.g. session-killed). Buy row UNCHANGED.
//   - "failed"     → system-level failure on RH side. Buy row UNCHANGED.
//   - "timeout"    → poll deadline reached without terminal state. Sell may
//                    still be live at RH. Buy row UNCHANGED. Mark sell
//                    'timeout' so a future close attempt is blocked until
//                    manual reconciliation.

const FILL_QTY_TOLERANCE = 0.001; // accept ≥ 99.9% as "fully filled"

/**
 * @param {object} args
 * @param {object} args.buyOrder         - the filled RH buy order
 * @param {object} args.sellPollResult   - return value of pollUntilTerminal
 * @param {number} args.sellLimitPrice   - the limit price we sent for the sell
 * @returns {object} decision
 */
function decideClose({ buyOrder, sellPollResult, sellLimitPrice }) {
  const buyQty = Number(buyOrder?.filled_asset_quantity ?? 0);
  const buyAvgPrice = Number(buyOrder?.average_price ?? 0);
  const sellOrder = sellPollResult?.order ?? null;
  const sellState = sellPollResult?.state ?? 'unknown';
  const sellFilledQty = Number(sellOrder?.filled_asset_quantity ?? 0);
  const sellAvgPriceParsed = Number(sellOrder?.average_price ?? NaN);
  const sellAvgPrice = Number.isFinite(sellAvgPriceParsed) && sellAvgPriceParsed > 0
    ? sellAvgPriceParsed
    : null;

  const baseFacts = {
    sellState,
    buyQty,
    buyAvgPrice,
    sellFilledQty,
    sellAvgPrice,
    sellLimitPrice,
  };

  // ----- Timeout (no terminal state seen within the deadline) -----
  // If quantity > 0 was filled before timeout, surface that as a partial.
  // If nothing filled, surface a clean timeout.
  if (sellPollResult?.timedOut) {
    if (sellFilledQty > 0 && sellAvgPrice != null) {
      return {
        action: 'partial',
        ...baseFacts,
        partialPnlUsd: round((sellAvgPrice - buyAvgPrice) * sellFilledQty),
        reason:
          `Sell partially filled (${sellFilledQty} of ${buyQty} ETH) before poll timeout.`,
      };
    }
    return {
      action: 'timeout',
      ...baseFacts,
      reason:
        `Sell did not reach a terminal state within the poll deadline. Current state: "${sellState}".`,
    };
  }

  // ----- Hard rejections -----
  if (sellState === 'rejected') {
    return {
      action: 'rejected',
      ...baseFacts,
      reason: 'Robinhood rejected the sell order.',
    };
  }
  if (sellState === 'failed') {
    return {
      action: 'failed',
      ...baseFacts,
      reason: 'Robinhood reported a system-level failure on the sell order.',
    };
  }
  if (sellState === 'canceled' || sellState === 'cancelled') {
    return {
      action: 'cancelled',
      ...baseFacts,
      reason: 'Sell order was cancelled before fully filling.',
    };
  }

  // ----- Filled (or claims to be) -----
  // Defensive: even if state === 'filled', verify the quantities and
  // require a usable avg_price. RH has been known to ship ambiguous shapes.
  if (sellState === 'filled') {
    const qtyOk = sellFilledQty >= buyQty * (1 - FILL_QTY_TOLERANCE);
    if (!qtyOk || sellAvgPrice == null) {
      return {
        action: 'partial',
        ...baseFacts,
        partialPnlUsd:
          sellAvgPrice != null
            ? round((sellAvgPrice - buyAvgPrice) * sellFilledQty)
            : null,
        reason:
          `Robinhood reports state=filled but fill data is incomplete ` +
          `(filled_qty=${sellFilledQty} of requested ${buyQty}, avg_price=${sellAvgPrice}). ` +
          `Treating as PARTIAL for safety.`,
      };
    }
    const realizedPnlUsd = round((sellAvgPrice - buyAvgPrice) * sellFilledQty);
    return {
      action: 'closed',
      ...baseFacts,
      realizedPnlUsd,
      buyOutcome: realizedPnlUsd >= 0 ? 'win' : 'loss',
      reason: 'Sell filled. Round-trip P/L computed from actual fills.',
    };
  }

  // ----- Anything else (open, queued, partially_filled with no timeout) -----
  // Shouldn't reach here from the poller (it returns timedOut for these
  // states). Guard defensively.
  return {
    action: 'timeout',
    ...baseFacts,
    reason:
      `Unexpected non-terminal state "${sellState}" without timeout flag. ` +
      `Treating as timeout for safety.`,
  };
}

function round(n, d = 4) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

module.exports = { decideClose, FILL_QTY_TOLERANCE };
