'use strict';

// Phase 3: liveRiskManager validation pipeline.
//
// Every gate has a dedicated test. The default config we test against has
// liveTradingEnabled=true so the rest of the pipeline can be exercised; the
// kill-switch test explicitly flips it off.

const { config } = require('../src/config');
const liveRiskManager = require('../src/services/liveRiskManager');
const tradeLogger = require('../src/services/tradeLogger');
const db = require('../src/db');

beforeEach(() => {
  db.exec('DELETE FROM trades; DELETE FROM decisions;');
});

function validLiveReq(overrides = {}) {
  return {
    recommendationId: 'rec-' + Math.random().toString(36).slice(2, 10),
    symbol: 'ETH-USD',
    side: 'buy',
    usdAmount: 10,
    confirmedRealMoney: true,
    ...overrides,
  };
}

function liveCtx(overrides = {}) {
  return {
    config: {
      ...config,
      liveTradingEnabled: true,
      robinhoodApiKey: 'test-key',
      robinhoodPrivateKey: 'test-private',
      liveMaxOrderUsd: 10,
      liveDailyLossCapUsd: 10,
      liveAllowedSymbols: ['ETH-USD'],
      ...overrides,
    },
  };
}

describe('liveRiskManager.evaluateLive', () => {
  test('valid request passes when all gates are clear', () => {
    const v = liveRiskManager.evaluateLive(validLiveReq(), liveCtx());
    expect(v).toEqual({ ok: true });
  });

  test('LIVE_TRADING_DISABLED when kill switch is off', () => {
    const v = liveRiskManager.evaluateLive(
      validLiveReq(),
      liveCtx({ liveTradingEnabled: false }),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('LIVE_TRADING_DISABLED');
  });

  test('ROBINHOOD_KEYS_MISSING when api key is empty', () => {
    const v = liveRiskManager.evaluateLive(
      validLiveReq(),
      liveCtx({ robinhoodApiKey: '' }),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('ROBINHOOD_KEYS_MISSING');
  });

  test('ROBINHOOD_KEYS_MISSING when private key is empty', () => {
    const v = liveRiskManager.evaluateLive(
      validLiveReq(),
      liveCtx({ robinhoodPrivateKey: '' }),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('ROBINHOOD_KEYS_MISSING');
  });

  test.each([
    'recommendationId',
    'symbol',
    'side',
    'usdAmount',
    'confirmedRealMoney',
  ])('MISSING_FIELDS when %s is missing', (field) => {
    const req = validLiveReq();
    delete req[field];
    const v = liveRiskManager.evaluateLive(req, liveCtx());
    expect(v.ok).toBe(false);
    expect(v.code).toBe('MISSING_FIELDS');
  });

  test('CONFIRMATION_MISSING when confirmedRealMoney is false', () => {
    const v = liveRiskManager.evaluateLive(
      validLiveReq({ confirmedRealMoney: false }),
      liveCtx(),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('CONFIRMATION_MISSING');
  });

  test('INVALID_SIDE for non buy/sell value', () => {
    const v = liveRiskManager.evaluateLive(
      validLiveReq({ side: 'long' }),
      liveCtx(),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('INVALID_SIDE');
  });

  test('SYMBOL_NOT_ALLOWED_LIVE for BTC (Phase 3 is ETH-only)', () => {
    const v = liveRiskManager.evaluateLive(
      validLiveReq({ symbol: 'BTC-USD' }),
      liveCtx(),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('SYMBOL_NOT_ALLOWED_LIVE');
  });

  test('AMOUNT_OUT_OF_RANGE when amount > LIVE_MAX_ORDER_USD', () => {
    const v = liveRiskManager.evaluateLive(
      validLiveReq({ usdAmount: 25 }),
      liveCtx({ liveMaxOrderUsd: 10 }),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('AMOUNT_OUT_OF_RANGE when amount <= 0', () => {
    const v = liveRiskManager.evaluateLive(
      validLiveReq({ usdAmount: 0 }),
      liveCtx(),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('DAILY_LOSS_CAP_HIT when today\'s live losses meet the cap', () => {
    // Insert a synthetic live loss for today.
    tradeLogger.recordTrade({
      request: {
        recommendationId: 'lossy-1',
        symbol: 'ETH-USD',
        side: 'buy',
        suggestedAmountUsd: 10,
        confidenceScore: 1,
        entryReason: 'test',
        stopLoss: 0,
        profitTarget: 0,
        invalidationLevel: 0,
        riskReward: 1,
      },
      status: 'executed',
      mode: 'live',
      response: {},
    });
    db.prepare(
      `UPDATE trades SET simulated_pnl_usd = -10, outcome = 'loss', exit_timestamp = datetime('now')
        WHERE recommendation_id = 'lossy-1'`,
    ).run();

    const v = liveRiskManager.evaluateLive(validLiveReq(), liveCtx());
    expect(v.ok).toBe(false);
    expect(v.code).toBe('DAILY_LOSS_CAP_HIT');
  });

  test('paper losses do NOT count against the live daily loss cap', () => {
    tradeLogger.recordTrade({
      request: {
        recommendationId: 'paper-loss-1',
        symbol: 'ETH-USD',
        side: 'buy',
        suggestedAmountUsd: 25,
        confidenceScore: 0.8,
        entryReason: 'paper test',
        stopLoss: 0,
        profitTarget: 0,
        invalidationLevel: 0,
        riskReward: 1,
      },
      status: 'simulated',
      mode: 'paper',
      response: {},
    });
    db.prepare(
      `UPDATE trades SET simulated_pnl_usd = -50 WHERE recommendation_id = 'paper-loss-1'`,
    ).run();

    const v = liveRiskManager.evaluateLive(validLiveReq(), liveCtx());
    expect(v).toEqual({ ok: true });
  });

  test('OPEN_POSITION_EXISTS when an open live trade is on the books', () => {
    tradeLogger.recordTrade({
      request: {
        recommendationId: 'open-live-1',
        symbol: 'ETH-USD',
        side: 'buy',
        suggestedAmountUsd: 10,
        confidenceScore: 1,
        entryReason: 'test',
        stopLoss: 0,
        profitTarget: 0,
        invalidationLevel: 0,
        riskReward: 1,
      },
      status: 'executed',
      mode: 'live',
      response: {},
    });
    // Leave outcome NULL — that's how we model "open".
    const v = liveRiskManager.evaluateLive(validLiveReq(), liveCtx());
    expect(v.ok).toBe(false);
    expect(v.code).toBe('OPEN_POSITION_EXISTS');
  });

  test('DUPLICATE_RECOMMENDATION when recommendationId is reused', () => {
    tradeLogger.recordTrade({
      request: {
        recommendationId: 'dup-1',
        symbol: 'ETH-USD',
        side: 'buy',
        suggestedAmountUsd: 10,
        confidenceScore: 1,
        entryReason: 'test',
        stopLoss: 0,
        profitTarget: 0,
        invalidationLevel: 0,
        riskReward: 1,
      },
      status: 'executed',
      mode: 'live',
      response: {},
    });
    // Mark the existing one as closed-loss so it does not also trip
    // OPEN_POSITION_EXISTS — we want to assert the dedupe gate specifically.
    db.prepare(
      `UPDATE trades SET outcome = 'loss', simulated_pnl_usd = -1
        WHERE recommendation_id = 'dup-1'`,
    ).run();

    const v = liveRiskManager.evaluateLive(
      validLiveReq({ recommendationId: 'dup-1' }),
      liveCtx({ liveDailyLossCapUsd: 100 }),
    );
    expect(v.ok).toBe(false);
    expect(v.code).toBe('DUPLICATE_RECOMMENDATION');
  });
});
