'use strict';

// Unit tests for src/services/closeDecision.js — pure-function classifier
// for sell-poll outcomes. No DB, no network, no time.

const { decideClose } = require('../src/services/closeDecision');

// Convenience builders for the inputs.
function buy({ qty = 0.005, avg = 2280 } = {}) {
  return {
    state: 'filled',
    filled_asset_quantity: String(qty),
    average_price: String(avg),
  };
}
function pollOk(state, { qty, avg } = {}) {
  return {
    timedOut: false,
    state,
    pollCount: 1,
    elapsedMs: 100,
    order: {
      state,
      filled_asset_quantity: qty == null ? '0' : String(qty),
      average_price: avg == null ? null : String(avg),
    },
  };
}
function pollTimeout(stateInOrder, { qty = 0, avg } = {}) {
  return {
    timedOut: true,
    state: stateInOrder,
    pollCount: 30,
    elapsedMs: 60000,
    order: {
      state: stateInOrder,
      filled_asset_quantity: String(qty),
      average_price: avg == null ? null : String(avg),
    },
  };
}

describe('decideClose — full close (action=closed)', () => {
  test('uses ACTUAL avg fill price (not the limit) for realized P/L', () => {
    const decision = decideClose({
      buyOrder: buy({ qty: 0.005, avg: 2280 }),
      // Buy was at 2280; sell limit was 2230 (bid - 0.5%); but RH actually
      // filled the sell at 2245 — better than the limit. Realized P/L must
      // be based on 2245, not 2230.
      sellPollResult: pollOk('filled', { qty: 0.005, avg: 2245 }),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('closed');
    expect(decision.sellAvgPrice).toBe(2245);
    expect(decision.realizedPnlUsd).toBe(
      Number(((2245 - 2280) * 0.005).toFixed(4)),
    );
    expect(decision.buyOutcome).toBe('loss');
  });

  test('classifies positive P/L as a win', () => {
    const decision = decideClose({
      buyOrder: buy({ qty: 0.01, avg: 2200 }),
      sellPollResult: pollOk('filled', { qty: 0.01, avg: 2300 }),
      sellLimitPrice: 2280,
    });
    expect(decision.action).toBe('closed');
    expect(decision.realizedPnlUsd).toBeCloseTo(1.0, 5);
    expect(decision.buyOutcome).toBe('win');
  });
});

describe('decideClose — rejected / failed / cancelled (no fill, buy stays open)', () => {
  test('rejected → action=rejected, no PnL fields', () => {
    const decision = decideClose({
      buyOrder: buy(),
      sellPollResult: pollOk('rejected', { qty: 0 }),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('rejected');
    expect(decision.realizedPnlUsd).toBeUndefined();
    expect(decision.buyOutcome).toBeUndefined();
    expect(decision.reason).toMatch(/rejected/i);
  });

  test('failed → action=failed', () => {
    const decision = decideClose({
      buyOrder: buy(),
      sellPollResult: pollOk('failed'),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('failed');
  });

  test('canceled → action=cancelled', () => {
    const decision = decideClose({
      buyOrder: buy(),
      sellPollResult: pollOk('canceled'),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('cancelled');
  });
});

describe('decideClose — timeout (poll never reached terminal)', () => {
  test('clean timeout (no fill) → action=timeout, buy stays open', () => {
    const decision = decideClose({
      buyOrder: buy({ qty: 0.005, avg: 2280 }),
      sellPollResult: pollTimeout('open', { qty: 0 }),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('timeout');
    expect(decision.realizedPnlUsd).toBeUndefined();
    expect(decision.reason).toMatch(/poll deadline/i);
  });

  test('timeout WITH some fill → action=partial (treat partial-on-timeout as partial)', () => {
    const decision = decideClose({
      buyOrder: buy({ qty: 0.005, avg: 2280 }),
      sellPollResult: pollTimeout('partially_filled', { qty: 0.002, avg: 2245 }),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('partial');
    expect(decision.sellFilledQty).toBe(0.002);
    expect(decision.partialPnlUsd).toBeCloseTo((2245 - 2280) * 0.002, 5);
  });
});

describe('decideClose — partial-fill safety (state=filled but qty/data incomplete)', () => {
  test('state=filled but qty mismatch → action=partial (defensive)', () => {
    const decision = decideClose({
      buyOrder: buy({ qty: 0.005, avg: 2280 }),
      sellPollResult: pollOk('filled', { qty: 0.003, avg: 2245 }),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('partial');
    expect(decision.sellFilledQty).toBe(0.003);
    expect(decision.reason).toMatch(/PARTIAL/i);
  });

  test('state=filled but avg_price missing → action=partial (defensive)', () => {
    const decision = decideClose({
      buyOrder: buy({ qty: 0.005, avg: 2280 }),
      sellPollResult: pollOk('filled', { qty: 0.005, avg: undefined }),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('partial');
    expect(decision.sellAvgPrice).toBeNull();
    expect(decision.partialPnlUsd).toBeNull();
  });

  test('state=filled, qty matches within 0.1% tolerance → action=closed', () => {
    // 0.0999% short still counts as a full fill.
    const decision = decideClose({
      buyOrder: buy({ qty: 0.005, avg: 2280 }),
      sellPollResult: pollOk('filled', { qty: 0.005 * 0.9995, avg: 2245 }),
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('closed');
  });
});

describe('decideClose — defence against unexpected non-terminal results', () => {
  test('non-terminal state without timedOut flag → falls back to timeout', () => {
    // Shouldn't happen given how the poller is structured, but the function
    // must not crash or silently treat as success.
    const decision = decideClose({
      buyOrder: buy(),
      sellPollResult: { timedOut: false, state: 'open', order: { state: 'open' } },
      sellLimitPrice: 2230,
    });
    expect(decision.action).toBe('timeout');
  });
});
