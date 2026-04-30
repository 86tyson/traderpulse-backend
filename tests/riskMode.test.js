'use strict';

// Tests for src/services/riskModeAdjuster.js — pure-function unit tests +
// safety invariants:
//   - Aggressive mode never exceeds maxTradeUsd.
//   - Live mode is a no-op (cannot increase live size, cannot bypass gates).
//   - Standard / no-mode is a true no-op.

const { applyRiskMode } = require('../src/services/riskModeAdjuster');

const baseRequest = () => ({
  recommendationId: 'rec-1',
  symbol: 'BTC-USD',
  side: 'buy',
  suggestedAmountUsd: 20,
  confidenceScore: 0.85,
  entryReason: 'test',
  stopLoss: 1,
  profitTarget: 1,
  invalidationLevel: 1,
  riskReward: 1.5,
});

const baseConfig = (overrides = {}) => ({
  paperMode: true,
  maxTradeUsd: 25,
  minConfidence: 0.5,
  ...overrides,
});

describe('applyRiskMode — paper mode', () => {
  test('standard is a no-op (preserves current behavior)', () => {
    const out = applyRiskMode({
      request: baseRequest(),
      config: baseConfig(),
      riskMode: 'standard',
    });
    expect(out.suggestedAmountUsd).toBe(20);
    expect(out.minConfidence).toBe(0.5);
    expect(out.applied).toBe(false);
    expect(out.riskMode).toBe('standard');
  });

  test('undefined / missing riskMode defaults to standard', () => {
    const out = applyRiskMode({
      request: baseRequest(),
      config: baseConfig(),
      riskMode: undefined,
    });
    expect(out.applied).toBe(false);
    expect(out.riskMode).toBe('standard');
  });

  test('conservative halves size and raises minConfidence to 0.85', () => {
    const out = applyRiskMode({
      request: baseRequest(),
      config: baseConfig(),
      riskMode: 'conservative',
    });
    expect(out.suggestedAmountUsd).toBe(10);
    expect(out.minConfidence).toBe(0.85);
    expect(out.applied).toBe(true);
  });

  test('conservative floor is $1 (cannot go to zero on a tiny request)', () => {
    const req = baseRequest();
    req.suggestedAmountUsd = 0.5;
    const out = applyRiskMode({
      request: req,
      config: baseConfig(),
      riskMode: 'conservative',
    });
    expect(out.suggestedAmountUsd).toBe(1);
  });

  test('aggressive doubles size and lowers minConfidence to 0.4', () => {
    const req = baseRequest();
    req.suggestedAmountUsd = 10;
    const out = applyRiskMode({
      request: req,
      config: baseConfig(),
      riskMode: 'aggressive',
    });
    expect(out.suggestedAmountUsd).toBe(20);
    expect(out.minConfidence).toBe(0.4);
    expect(out.applied).toBe(true);
  });

  test('aggressive size is CAPPED at config.maxTradeUsd (cannot exceed paper cap)', () => {
    const req = baseRequest();
    req.suggestedAmountUsd = 20;
    const out = applyRiskMode({
      request: req,
      config: baseConfig({ maxTradeUsd: 25 }),
      riskMode: 'aggressive',
    });
    // 20 × 2 = 40, capped at 25.
    expect(out.suggestedAmountUsd).toBe(25);
  });

  test('an invalid riskMode value falls back to standard (no error thrown)', () => {
    const out = applyRiskMode({
      request: baseRequest(),
      config: baseConfig(),
      // @ts-expect-error — testing runtime tolerance
      riskMode: 'YOLO_2X',
    });
    expect(out.applied).toBe(false);
    expect(out.riskMode).toBe('standard');
  });
});

describe('applyRiskMode — live mode SAFETY (must always no-op)', () => {
  test('paperMode=false + conservative → no change (live cannot be reduced)', () => {
    const out = applyRiskMode({
      request: baseRequest(),
      config: baseConfig({ paperMode: false }),
      riskMode: 'conservative',
    });
    expect(out.suggestedAmountUsd).toBe(20); // unchanged
    expect(out.minConfidence).toBe(0.5); // unchanged
    expect(out.applied).toBe(false);
    expect(out.reason).toMatch(/live mode/i);
  });

  test('paperMode=false + aggressive → CANNOT INCREASE LIVE SIZE', () => {
    const out = applyRiskMode({
      request: baseRequest(),
      config: baseConfig({ paperMode: false, maxTradeUsd: 25 }),
      riskMode: 'aggressive',
    });
    expect(out.suggestedAmountUsd).toBe(20); // unchanged — would have been 40 capped to 25 if paper
    expect(out.minConfidence).toBe(0.5); // unchanged
    expect(out.applied).toBe(false);
  });

  test('paperMode=false + standard → unchanged', () => {
    const out = applyRiskMode({
      request: baseRequest(),
      config: baseConfig({ paperMode: false }),
      riskMode: 'standard',
    });
    expect(out.suggestedAmountUsd).toBe(20);
    expect(out.applied).toBe(false);
  });

  test('paperMode missing entirely → treated as live (defensive)', () => {
    const out = applyRiskMode({
      request: baseRequest(),
      config: { maxTradeUsd: 25, minConfidence: 0.5 }, // no paperMode key
      riskMode: 'aggressive',
    });
    expect(out.suggestedAmountUsd).toBe(20);
    expect(out.applied).toBe(false);
  });
});
