'use strict';

const { validRequest } = require('./setup');
const { config } = require('../src/config');
const riskManager = require('../src/services/riskManager');
const db = require('../src/db');

beforeEach(() => {
  db.exec('DELETE FROM trades; DELETE FROM decisions;');
});

const ctx = () => ({ config });

describe('riskManager.evaluate', () => {
  test('valid request passes', () => {
    expect(riskManager.evaluate(validRequest(), ctx())).toEqual({ ok: true });
  });

  test('BOT_DISABLED when bot is off', () => {
    const customCtx = { config: { ...config, botEnabled: false } };
    const v = riskManager.evaluate(validRequest(), customCtx);
    expect(v.ok).toBe(false);
    expect(v.code).toBe('BOT_DISABLED');
  });

  test.each([
    'recommendationId',
    'symbol',
    'side',
    'suggestedAmountUsd',
    'confidenceScore',
    'entryReason',
    'stopLoss',
    'profitTarget',
    'invalidationLevel',
    'riskReward',
  ])('MISSING_FIELDS when %s is missing', (field) => {
    const req = validRequest();
    delete req[field];
    const v = riskManager.evaluate(req, ctx());
    expect(v.ok).toBe(false);
    expect(v.code).toBe('MISSING_FIELDS');
  });

  test('INVALID_SIDE for non-buy/sell', () => {
    const v = riskManager.evaluate(validRequest({ side: 'short' }), ctx());
    expect(v.code).toBe('INVALID_SIDE');
  });

  test('SYMBOL_NOT_ALLOWED for unlisted symbol', () => {
    const v = riskManager.evaluate(validRequest({ symbol: 'DOGE-USD' }), ctx());
    expect(v.code).toBe('SYMBOL_NOT_ALLOWED');
  });

  test('AMOUNT_OUT_OF_RANGE when amount > MAX_TRADE_USD', () => {
    const v = riskManager.evaluate(validRequest({ suggestedAmountUsd: 9999 }), ctx());
    expect(v.code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('AMOUNT_OUT_OF_RANGE when amount <= 0', () => {
    const v = riskManager.evaluate(validRequest({ suggestedAmountUsd: 0 }), ctx());
    expect(v.code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('RISK_FIELDS_INVALID when riskReward <= 0', () => {
    const v = riskManager.evaluate(validRequest({ riskReward: 0 }), ctx());
    expect(v.code).toBe('RISK_FIELDS_INVALID');
  });

  test('CONFIDENCE_TOO_LOW below MIN_CONFIDENCE', () => {
    const v = riskManager.evaluate(validRequest({ confidenceScore: 0.2 }), ctx());
    expect(v.code).toBe('CONFIDENCE_TOO_LOW');
  });

  test('DAILY_LOSS_CAP_HIT when today loss exceeds cap', () => {
    db.prepare(
      `INSERT INTO trades (recommendation_id, symbol, side, suggested_amount_usd, confidence_score,
                           status, mode, simulated_pnl_usd, raw_request_json)
       VALUES ('seed-loss', 'BTC-USD', 'buy', 10, 0.7, 'simulated', 'paper', -100, '{}')`,
    ).run();
    const v = riskManager.evaluate(validRequest(), ctx());
    expect(v.code).toBe('DAILY_LOSS_CAP_HIT');
  });

  test('DUPLICATE_RECOMMENDATION when recommendationId already used', () => {
    db.prepare(
      `INSERT INTO trades (recommendation_id, symbol, side, suggested_amount_usd, confidence_score,
                           status, mode, raw_request_json)
       VALUES ('rec-dup', 'BTC-USD', 'buy', 10, 0.7, 'simulated', 'paper', '{}')`,
    ).run();
    const v = riskManager.evaluate(validRequest({ recommendationId: 'rec-dup' }), ctx());
    expect(v.code).toBe('DUPLICATE_RECOMMENDATION');
  });
});
