'use strict';

// Tests for src/services/reconciler.js. Two layers:
//   1. decideReconcileAction — pure function, no DB / network
//   2. reconcileAll          — orchestrator, runs against the real test DB
//      (in-memory) with a mocked getOrderById

const { decideReconcileAction, reconcileAll } = require('../src/services/reconciler');
const db = require('../src/db');
const tradeLogger = require('../src/services/tradeLogger');

beforeEach(() => {
  db.exec('DELETE FROM trades; DELETE FROM decisions;');
});

// ----- pure-function helpers -----
function buyRow(overrides = {}) {
  return {
    id: 1,
    side: 'buy',
    outcome: null,
    recommendation_id: 'rec-buy-1',
    robinhood_order_id: 'rh-buy-1',
    entry_price: null,
    filled_quantity: null,
    ...overrides,
  };
}
function sellRow(overrides = {}) {
  return {
    id: 2,
    side: 'sell',
    outcome: null,
    recommendation_id: 'close-of-rec-buy-1',
    robinhood_order_id: 'rh-sell-1',
    entry_price: null,
    filled_quantity: null,
    ...overrides,
  };
}
function rh(state, { qty = 0, avg = null, updated = '2026-04-30T19:00:00Z' } = {}) {
  return {
    id: 'x',
    state,
    filled_asset_quantity: String(qty),
    average_price: avg == null ? null : String(avg),
    updated_at: updated,
  };
}

// ============================================================================
// Pure decision tests
// ============================================================================

describe('decideReconcileAction — buy rows', () => {
  test('open buy + RH filled → mark-buy-filled with entry/qty/timestamp', () => {
    const d = decideReconcileAction({
      localTrade: buyRow(),
      rhOrder: rh('filled', { qty: 0.005, avg: 2280 }),
    });
    expect(d.action).toBe('mark-buy-filled');
    expect(d.updates.entry_price).toBe(2280);
    expect(d.updates.filled_quantity).toBe(0.005);
    expect(d.updates.fill_timestamp).toBeTruthy();
  });

  test('already-reconciled buy (entry_price + filled_quantity match RH) → noop', () => {
    const d = decideReconcileAction({
      localTrade: buyRow({ entry_price: 2280, filled_quantity: 0.005 }),
      rhOrder: rh('filled', { qty: 0.005, avg: 2280 }),
    });
    expect(d.action).toBe('noop');
    expect(d.reason).toMatch(/already reconciled/i);
  });

  test('settled buy (outcome=win) + RH filled → noop', () => {
    const d = decideReconcileAction({
      localTrade: buyRow({ outcome: 'win' }),
      rhOrder: rh('filled', { qty: 0.005, avg: 2280 }),
    });
    expect(d.action).toBe('noop');
    expect(d.reason).toMatch(/already settled/i);
  });

  test('open buy + RH canceled → mark-buy-cancelled', () => {
    const d = decideReconcileAction({
      localTrade: buyRow(),
      rhOrder: rh('canceled'),
    });
    expect(d.action).toBe('mark-buy-cancelled');
    expect(d.updates.outcome).toBe('cancelled');
  });

  test('open buy + RH rejected → mark-buy-rejected', () => {
    const d = decideReconcileAction({
      localTrade: buyRow(),
      rhOrder: rh('rejected'),
    });
    expect(d.action).toBe('mark-buy-rejected');
    expect(d.updates.outcome).toBe('rejected');
  });

  test('open buy + RH failed → mark-buy-failed', () => {
    const d = decideReconcileAction({
      localTrade: buyRow(),
      rhOrder: rh('failed'),
    });
    expect(d.action).toBe('mark-buy-failed');
    expect(d.updates.outcome).toBe('failed');
  });

  test('open buy + RH partially_filled → mark-buy-partial with warning', () => {
    const d = decideReconcileAction({
      localTrade: buyRow(),
      rhOrder: rh('partially_filled', { qty: 0.002, avg: 2280 }),
    });
    expect(d.action).toBe('mark-buy-partial');
    expect(d.warning).toBe(true);
    expect(d.updates.filled_quantity).toBe(0.002);
  });

  test('open buy + RH open → noop "still pending"', () => {
    const d = decideReconcileAction({
      localTrade: buyRow(),
      rhOrder: rh('open'),
    });
    expect(d.action).toBe('noop');
    expect(d.reason).toMatch(/still pending/i);
  });
});

describe('decideReconcileAction — sell rows', () => {
  test('in-flight sell (outcome=null) + RH filled → close-buy-from-sell', () => {
    const d = decideReconcileAction({
      localTrade: sellRow(),
      rhOrder: rh('filled', { qty: 0.005, avg: 2300 }),
    });
    expect(d.action).toBe('close-buy-from-sell');
    expect(d.sellAvgPrice).toBe(2300);
    expect(d.sellFilledQty).toBe(0.005);
  });

  test('timed-out sell + RH NOW filled → close-buy-from-sell (timeout recovery)', () => {
    const d = decideReconcileAction({
      localTrade: sellRow({ outcome: 'timeout' }),
      rhOrder: rh('filled', { qty: 0.005, avg: 2300 }),
    });
    expect(d.action).toBe('close-buy-from-sell');
    expect(d.reason).toMatch(/previously-timeout/i);
  });

  test('partially-marked sell + RH NOW filled → close-buy-from-sell', () => {
    const d = decideReconcileAction({
      localTrade: sellRow({ outcome: 'partial' }),
      rhOrder: rh('filled', { qty: 0.005, avg: 2300 }),
    });
    expect(d.action).toBe('close-buy-from-sell');
    expect(d.reason).toMatch(/previously-partial/i);
  });

  test('settled sell (outcome=closed) + RH filled → noop (already reconciled)', () => {
    const d = decideReconcileAction({
      localTrade: sellRow({ outcome: 'closed' }),
      rhOrder: rh('filled', { qty: 0.005, avg: 2300 }),
    });
    expect(d.action).toBe('noop');
  });

  test('in-flight sell + RH rejected → mark-sell-rejected (buy stays open)', () => {
    const d = decideReconcileAction({
      localTrade: sellRow(),
      rhOrder: rh('rejected'),
    });
    expect(d.action).toBe('mark-sell-rejected');
    expect(d.updates.outcome).toBe('rejected');
    expect(d.reason).toMatch(/buy stays OPEN/i);
  });

  test('in-flight sell + RH cancelled → mark-sell-cancelled', () => {
    const d = decideReconcileAction({
      localTrade: sellRow(),
      rhOrder: rh('cancelled'),
    });
    expect(d.action).toBe('mark-sell-cancelled');
  });

  test('in-flight sell + RH partially_filled → mark-sell-partial with warning', () => {
    const d = decideReconcileAction({
      localTrade: sellRow(),
      rhOrder: rh('partially_filled', { qty: 0.002, avg: 2300 }),
    });
    expect(d.action).toBe('mark-sell-partial');
    expect(d.warning).toBe(true);
    expect(d.updates.outcome).toBe('partial');
  });

  test('in-flight sell + RH open → noop "still pending"', () => {
    const d = decideReconcileAction({
      localTrade: sellRow(),
      rhOrder: rh('open'),
    });
    expect(d.action).toBe('noop');
  });
});

describe('decideReconcileAction — defensive', () => {
  test('missing RH order → noop', () => {
    const d = decideReconcileAction({
      localTrade: buyRow(),
      rhOrder: null,
    });
    expect(d.action).toBe('noop');
  });

  test('unknown side → noop', () => {
    const d = decideReconcileAction({
      localTrade: { ...buyRow(), side: 'something_weird' },
      rhOrder: rh('filled', { qty: 0.005, avg: 2280 }),
    });
    expect(d.action).toBe('noop');
  });
});

// ============================================================================
// Orchestrator tests (real test-DB; mocked RH client)
// ============================================================================

function insertLiveBuy({
  recId = 'rec-buy-1',
  rhOrderId = 'rh-buy-1',
  outcome = null,
  entryPrice = null,
  filledQty = null,
} = {}) {
  const id = tradeLogger.recordTrade({
    request: {
      recommendationId: recId,
      symbol: 'ETH-USD',
      side: 'buy',
      suggestedAmountUsd: 10,
      confidenceScore: 1.0,
      entryReason: 'test',
      stopLoss: 0,
      profitTarget: 0,
      invalidationLevel: 0,
      riskReward: 1,
    },
    status: 'executed',
    mode: 'live',
    response: {},
    robinhoodOrderId: rhOrderId,
  });
  if (outcome != null) {
    db.prepare(`UPDATE trades SET outcome=? WHERE id=?`).run(outcome, id);
  }
  if (entryPrice != null || filledQty != null) {
    db.prepare(
      `UPDATE trades SET entry_price=?, filled_quantity=? WHERE id=?`,
    ).run(entryPrice, filledQty, id);
  }
  return id;
}

function insertLiveSell({
  recId = 'close-of-rec-buy-1',
  rhOrderId = 'rh-sell-1',
  outcome = null,
} = {}) {
  const id = tradeLogger.recordTrade({
    request: {
      recommendationId: recId,
      symbol: 'ETH-USD',
      side: 'sell',
      suggestedAmountUsd: 10,
      confidenceScore: 1.0,
      entryReason: 'close-out test',
      stopLoss: 0,
      profitTarget: 0,
      invalidationLevel: 0,
      riskReward: 1,
    },
    status: 'executed',
    mode: 'live',
    response: {},
    robinhoodOrderId: rhOrderId,
  });
  if (outcome != null) {
    db.prepare(`UPDATE trades SET outcome=? WHERE id=?`).run(outcome, id);
  }
  return id;
}

describe('reconcileAll — filled buy', () => {
  test('writes entry_price + filled_quantity + fill_timestamp; counters increment', async () => {
    const buyId = insertLiveBuy();
    const getOrderById = jest.fn(async (id) => {
      if (id === 'rh-buy-1') return rh('filled', { qty: 0.0044, avg: 2276.51 });
      throw new Error(`unexpected id ${id}`);
    });

    const summary = await reconcileAll({ getOrderById, db });

    expect(summary.ordersChecked).toBe(1);
    expect(summary.rowsUpdated).toBe(1);
    expect(summary.filledFound).toBe(1);

    const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    expect(row.entry_price).toBeCloseTo(2276.51, 5);
    expect(row.filled_quantity).toBeCloseTo(0.0044, 8);
    expect(row.fill_timestamp).toBeTruthy();
    expect(row.outcome).toBeNull();
  });

  test('no-op when already reconciled (idempotent)', async () => {
    insertLiveBuy({ entryPrice: 2276.51, filledQty: 0.0044 });
    const getOrderById = jest.fn(async () =>
      rh('filled', { qty: 0.0044, avg: 2276.51 }),
    );
    const summary = await reconcileAll({ getOrderById, db });
    expect(summary.ordersChecked).toBe(1);
    expect(summary.rowsUpdated).toBe(0);
    expect(summary.actions[0].action).toBe('noop');
  });
});

describe('reconcileAll — filled sell retroactively closes buy', () => {
  test('updates BOTH rows; computes P/L from REAL fills; outcome based on sign', async () => {
    const buyId = insertLiveBuy({ recId: 'rec-buy-1', rhOrderId: 'rh-buy-1' });
    const sellId = insertLiveSell({
      recId: 'close-of-rec-buy-1',
      rhOrderId: 'rh-sell-1',
      outcome: 'timeout', // simulate prior poll timeout
    });

    const getOrderById = jest.fn(async (id) => {
      if (id === 'rh-buy-1') return rh('filled', { qty: 0.005, avg: 2280 });
      if (id === 'rh-sell-1') return rh('filled', { qty: 0.005, avg: 2300 }); // sold higher → win
      throw new Error('unexpected ' + id);
    });

    const summary = await reconcileAll({ getOrderById, db });

    expect(summary.ordersChecked).toBe(2);
    expect(summary.rowsUpdated).toBe(2);
    expect(summary.filledFound).toBe(1); // close-buy-from-sell counts once
    expect(summary.warnings).toEqual([]);

    const buyRow = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    const sellR = db.prepare('SELECT * FROM trades WHERE id = ?').get(sellId);

    // Buy retroactively closed with realized P/L = (2300 − 2280) × 0.005 = 0.10
    expect(buyRow.outcome).toBe('win');
    expect(buyRow.simulated_pnl_usd).toBeCloseTo(0.1, 5);
    expect(buyRow.exit_price).toBe(2300);
    expect(buyRow.entry_price).toBe(2280);
    expect(buyRow.filled_quantity).toBeCloseTo(0.005, 8);

    // Sell row marked 'closed' with the actual sell avg as exit_price.
    expect(sellR.outcome).toBe('closed');
    expect(sellR.exit_price).toBe(2300);
    expect(sellR.filled_quantity).toBeCloseTo(0.005, 8);
  });

  test('losing close: sell avg < buy avg → outcome=loss with negative P/L', async () => {
    const buyId = insertLiveBuy({ recId: 'rec-buy-2', rhOrderId: 'rh-buy-2' });
    insertLiveSell({
      recId: 'close-of-rec-buy-2',
      rhOrderId: 'rh-sell-2',
    });
    const getOrderById = jest.fn(async (id) => {
      if (id === 'rh-buy-2') return rh('filled', { qty: 0.005, avg: 2280 });
      if (id === 'rh-sell-2') return rh('filled', { qty: 0.005, avg: 2260 });
      throw new Error('unexpected ' + id);
    });
    await reconcileAll({ getOrderById, db });
    const buy = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    expect(buy.outcome).toBe('loss');
    expect(buy.simulated_pnl_usd).toBeCloseTo(-0.1, 5);
  });

  test('flat close: sell avg == buy avg → outcome=breakeven', async () => {
    const buyId = insertLiveBuy({ recId: 'rec-buy-3', rhOrderId: 'rh-buy-3' });
    insertLiveSell({
      recId: 'close-of-rec-buy-3',
      rhOrderId: 'rh-sell-3',
    });
    const getOrderById = jest.fn(async (id) => {
      if (id === 'rh-buy-3') return rh('filled', { qty: 0.005, avg: 2280 });
      if (id === 'rh-sell-3') return rh('filled', { qty: 0.005, avg: 2280 });
      throw new Error('unexpected ' + id);
    });
    await reconcileAll({ getOrderById, db });
    const buy = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    expect(buy.outcome).toBe('breakeven');
    expect(buy.simulated_pnl_usd).toBe(0);
  });
});

describe('reconcileAll — cancelled / rejected', () => {
  test('cancelled buy → outcome=cancelled, slot cleared', async () => {
    const buyId = insertLiveBuy();
    const getOrderById = jest.fn(async () => rh('canceled'));
    const summary = await reconcileAll({ getOrderById, db });
    expect(summary.cancelledFound).toBe(1);
    const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    expect(row.outcome).toBe('cancelled');
  });

  test('rejected sell → outcome=rejected, paired buy stays OPEN', async () => {
    const buyId = insertLiveBuy({ recId: 'rec-buy-4', rhOrderId: 'rh-buy-4' });
    const sellId = insertLiveSell({
      recId: 'close-of-rec-buy-4',
      rhOrderId: 'rh-sell-4',
    });
    const getOrderById = jest.fn(async (id) => {
      if (id === 'rh-buy-4') return rh('filled', { qty: 0.005, avg: 2280 });
      if (id === 'rh-sell-4') return rh('rejected');
      throw new Error('unexpected ' + id);
    });
    const summary = await reconcileAll({ getOrderById, db });
    expect(summary.rejectedFound).toBe(1);
    const buy = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    const sell = db.prepare('SELECT * FROM trades WHERE id = ?').get(sellId);
    expect(buy.outcome).toBeNull(); // STILL OPEN
    expect(sell.outcome).toBe('rejected');
  });
});

describe('reconcileAll — partial fills', () => {
  test('partial buy → mark partial; warning surfaced; outcome NOT closed', async () => {
    const buyId = insertLiveBuy();
    const getOrderById = jest.fn(async () =>
      rh('partially_filled', { qty: 0.002, avg: 2280 }),
    );
    const summary = await reconcileAll({ getOrderById, db });
    expect(summary.partialFound).toBe(1);
    expect(summary.warnings.length).toBeGreaterThan(0);
    const row = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    expect(row.outcome).toBeNull(); // NOT closed
    expect(row.filled_quantity).toBeCloseTo(0.002, 8);
  });

  test('partial sell → outcome=partial; buy stays OPEN; warning', async () => {
    const buyId = insertLiveBuy({ recId: 'rec-buy-5', rhOrderId: 'rh-buy-5' });
    const sellId = insertLiveSell({
      recId: 'close-of-rec-buy-5',
      rhOrderId: 'rh-sell-5',
    });
    const getOrderById = jest.fn(async (id) => {
      if (id === 'rh-buy-5') return rh('filled', { qty: 0.005, avg: 2280 });
      if (id === 'rh-sell-5')
        return rh('partially_filled', { qty: 0.002, avg: 2270 });
      throw new Error('unexpected ' + id);
    });
    const summary = await reconcileAll({ getOrderById, db });
    expect(summary.partialFound).toBe(1);
    expect(summary.warnings.length).toBeGreaterThan(0);
    const buy = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    const sell = db.prepare('SELECT * FROM trades WHERE id = ?').get(sellId);
    expect(buy.outcome).toBeNull();
    expect(sell.outcome).toBe('partial');
    expect(sell.filled_quantity).toBeCloseTo(0.002, 8);
  });

  test('sell qty < buy qty (defensive partial) → marks partial, NOT closes buy', async () => {
    // RH says sell is "filled" but the quantity is short of what we bought.
    // The orchestrator must protect against this by treating it as partial.
    const buyId = insertLiveBuy({ recId: 'rec-buy-6', rhOrderId: 'rh-buy-6' });
    const sellId = insertLiveSell({
      recId: 'close-of-rec-buy-6',
      rhOrderId: 'rh-sell-6',
    });
    const getOrderById = jest.fn(async (id) => {
      if (id === 'rh-buy-6') return rh('filled', { qty: 0.005, avg: 2280 });
      // RH claims filled but only filled half the quantity — defensive guard.
      if (id === 'rh-sell-6') return rh('filled', { qty: 0.0025, avg: 2300 });
      throw new Error('unexpected ' + id);
    });
    const summary = await reconcileAll({ getOrderById, db });
    expect(summary.partialFound).toBe(1);
    expect(summary.warnings.length).toBeGreaterThan(0);
    const buy = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyId);
    const sell = db.prepare('SELECT * FROM trades WHERE id = ?').get(sellId);
    expect(buy.outcome).toBeNull(); // NOT closed
    expect(sell.outcome).toBe('partial');
  });
});

describe('reconcileAll — fetch failures', () => {
  test('a transient fetch error becomes a warning, others still process', async () => {
    insertLiveBuy({ recId: 'rec-buy-A', rhOrderId: 'rh-buy-A' });
    const buyBId = insertLiveBuy({ recId: 'rec-buy-B', rhOrderId: 'rh-buy-B' });
    const getOrderById = jest.fn(async (id) => {
      if (id === 'rh-buy-A') throw new Error('transient blip');
      if (id === 'rh-buy-B') return rh('filled', { qty: 0.005, avg: 2280 });
      throw new Error('unexpected ' + id);
    });
    const summary = await reconcileAll({ getOrderById, db });
    expect(summary.warnings.length).toBeGreaterThan(0);
    expect(summary.warnings.some((w) => /RH fetch failed/.test(w))).toBe(true);
    // Row B still got reconciled.
    const rowB = db.prepare('SELECT * FROM trades WHERE id = ?').get(buyBId);
    expect(rowB.entry_price).toBe(2280);
  });
});
