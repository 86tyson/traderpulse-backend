'use strict';

require('./setup');
const sim = require('../src/services/paperSimulator');

describe('paperSimulator.probabilityOfWin', () => {
  test('clamps to 0..1 and applies linear formula', () => {
    expect(sim.probabilityOfWin(0)).toBeCloseTo(sim.BASE_WIN_RATE);
    expect(sim.probabilityOfWin(1)).toBeCloseTo(sim.BASE_WIN_RATE + sim.CONFIDENCE_SLOPE);
    expect(sim.probabilityOfWin(0.5)).toBeCloseTo(sim.BASE_WIN_RATE + 0.5 * sim.CONFIDENCE_SLOPE);
    expect(sim.probabilityOfWin(-1)).toBeCloseTo(sim.BASE_WIN_RATE);
    expect(sim.probabilityOfWin(2)).toBeCloseTo(sim.BASE_WIN_RATE + sim.CONFIDENCE_SLOPE);
    expect(sim.probabilityOfWin(NaN)).toBeCloseTo(sim.BASE_WIN_RATE);
  });

  test('higher confidence -> higher p_win', () => {
    expect(sim.probabilityOfWin(0.9)).toBeGreaterThan(sim.probabilityOfWin(0.3));
  });
});

describe('paperSimulator.deriveEntryPrice', () => {
  test('round-trips: entry computed from (stop, target, R) is consistent', () => {
    // Buy: entry 60000, stop 59100, target 62160 -> R = 2.4
    const entry = sim.deriveEntryPrice(59100, 62160, 2.4);
    expect(entry).toBeCloseTo(60000, 5);
  });

  test('symmetric for sell side: same formula', () => {
    // Sell: entry 60000, stop 60900, target 57840 -> R = 2.4
    const entry = sim.deriveEntryPrice(60900, 57840, 2.4);
    expect(entry).toBeCloseTo(60000, 5);
  });
});

describe('paperSimulator.resolveOutcome', () => {
  const buyReq = {
    side: 'buy',
    stopLoss: 59100,
    profitTarget: 62160,
    riskReward: 2.4,
    suggestedAmountUsd: 10,
    confidenceScore: 0.7,
  };

  test('always wins when rng() returns 0', () => {
    const r = sim.resolveOutcome(buyReq, () => 0);
    expect(r.outcome).toBe('win');
    expect(r.exitPrice).toBe(buyReq.profitTarget);
    expect(r.pnlUsd).toBeGreaterThan(0);
  });

  test('always loses when rng() returns 0.999', () => {
    const r = sim.resolveOutcome(buyReq, () => 0.999);
    expect(r.outcome).toBe('loss');
    expect(r.exitPrice).toBe(buyReq.stopLoss);
    expect(r.pnlUsd).toBeLessThan(0);
  });

  test('realized R:R on a win matches planned riskReward (within rounding)', () => {
    const win = sim.resolveOutcome(buyReq, () => 0);
    const loss = sim.resolveOutcome(buyReq, () => 0.999);
    const realizedRR = Math.abs(win.pnlUsd / loss.pnlUsd);
    expect(realizedRR).toBeCloseTo(buyReq.riskReward, 1);
  });

  test('sell side flips P/L sign relative to price move', () => {
    const sellReq = { ...buyReq, side: 'sell', stopLoss: 60900, profitTarget: 57840 };
    const win = sim.resolveOutcome(sellReq, () => 0);
    const loss = sim.resolveOutcome(sellReq, () => 0.999);
    expect(win.pnlUsd).toBeGreaterThan(0);
    expect(loss.pnlUsd).toBeLessThan(0);
  });

  test('over many iterations, win frequency tracks p_win', () => {
    const N = 5000;
    let wins = 0;
    for (let i = 0; i < N; i++) {
      if (sim.resolveOutcome(buyReq).outcome === 'win') wins += 1;
    }
    const observed = wins / N;
    const expected = sim.probabilityOfWin(buyReq.confidenceScore);
    // 5k samples: SE ~ sqrt(0.55*0.45/5000) ~ 0.007. Allow 0.03 slack.
    expect(Math.abs(observed - expected)).toBeLessThan(0.03);
  });
});
