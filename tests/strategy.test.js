'use strict';

require('./setup');
const { evaluateMarket } = require('../src/services/strategy');
const { buildSnapshot } = require('../src/services/snapshotBuilder');

// A deliberately favorable snapshot used to exercise the recommendation path.
// Geometry: pullback >= 3 %, near-support, R:R >> 1.5, UPTREND, OK volume/volatility.
const FAVORABLE_SNAP = {
  symbol: 'BTC',
  price: 65000,
  change24h: 2.5,
  ma50: 62000,         // price > ma50
  recentHigh: 67500,   // (67500 - 65000) / 67500 = 3.7% pullback
  support: 64000,      // (65000 - 64000) / 65000 = 1.54% from price (within 2%)
  resistance: 68000,   // rr = (68000 - 65000) / (65000 - 64000) = 3.0
  trend: 'UPTREND',
  volatility: 'OK',
  volume: 'STRONG',
  condition: 'FAVORABLE',
  pullbackPct: 3.7,
};

describe('strategy.evaluateMarket', () => {
  test('emits a HIGH-confidence recommendation on a clean setup', () => {
    const result = evaluateMarket(FAVORABLE_SNAP);
    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation.symbol).toBe('BTC');
    expect(result.recommendation.side).toBe('BUY');
    expect(result.recommendation.confidence).toBe('HIGH');
    expect(result.recommendation.entry).toBe(65000);
    // strategy places stop at 0.98 * entry, target at 1.03 * entry
    expect(result.recommendation.stopLoss).toBe(63700);
    expect(result.recommendation.profitTarget).toBe(66950);
    expect(result.skipReasons).toEqual([]);
  });

  test('emits skipReasons when condition is CHOPPY', () => {
    const snap = { ...FAVORABLE_SNAP, condition: 'CHOPPY', trend: 'SIDEWAYS' };
    const result = evaluateMarket(snap);
    expect(result.recommendation).toBeNull();
    expect(result.skipReasons).toContain('Choppy / sideways market');
  });

  test('emits skipReasons when pullback is too small', () => {
    const snap = { ...FAVORABLE_SNAP, pullbackPct: 1.5 };
    const result = evaluateMarket(snap);
    expect(result.recommendation).toBeNull();
    expect(result.skipReasons.some((r) => r.includes('Pullback'))).toBe(true);
  });

  test('emits skipReasons when price is below MA50', () => {
    const snap = { ...FAVORABLE_SNAP, ma50: 70000 };
    const result = evaluateMarket(snap);
    expect(result.recommendation).toBeNull();
    expect(result.skipReasons).toContain('Price below 50-period MA');
  });

  test('skipped trades do not include a recommendation id', () => {
    // Far-from-support setup is rejected with a clear reason and no rec.
    const snap = { ...FAVORABLE_SNAP, support: 60000 }; // > 2% below price
    const result = evaluateMarket(snap);
    expect(result.recommendation).toBeNull();
    expect(result.skipReasons).toContain('No clean support level nearby');
  });
});

describe('snapshotBuilder.buildSnapshot', () => {
  function makeUptrendCandles(n) {
    // Mild uptrend, ~0.1 %/bar, with small noise; produces UPTREND classification.
    const candles = [];
    let base = 60000;
    for (let i = 0; i < n; i++) {
      const drift = base + i * 60;
      const noise = (i * 7) % 11 - 5;
      const close = drift + noise;
      candles.push({
        timestamp: 1700000000000 + i * 3600 * 1000,
        open: close - 5,
        high: close + 20,
        low: close - 20,
        close,
        volume: 100 + (i % 7),
      });
    }
    return candles;
  }

  test('throws when there are fewer than 50 candles', () => {
    expect(() => buildSnapshot([], 'BTC', '1h')).toThrow(/at least 50/);
    expect(() => buildSnapshot(makeUptrendCandles(30), 'BTC', '1h')).toThrow(/at least 50/);
  });

  test('produces a well-formed snapshot from 100 uptrend candles', () => {
    const snap = buildSnapshot(makeUptrendCandles(100), 'BTC', '1h');
    expect(snap.symbol).toBe('BTC');
    expect(typeof snap.price).toBe('number');
    expect(typeof snap.ma50).toBe('number');
    expect(snap.support).toBeLessThanOrEqual(snap.price);
    expect(snap.resistance).toBeGreaterThanOrEqual(snap.support);
    expect(['UPTREND', 'DOWNTREND', 'SIDEWAYS']).toContain(snap.trend);
    expect(['STRONG', 'OK', 'WEAK']).toContain(snap.volatility);
    expect(['STRONG', 'OK', 'WEAK']).toContain(snap.volume);
    expect(['FAVORABLE', 'CHOPPY', 'LOW_VOLUME', 'LOW_VOLATILITY']).toContain(snap.condition);
    expect(snap.pullbackPct).toBeGreaterThanOrEqual(0);
  });

  test('rejects unsupported symbol or timeframe', () => {
    const candles = makeUptrendCandles(100);
    expect(() => buildSnapshot(candles, 'DOGE', '1h')).toThrow(/symbol/);
    expect(() => buildSnapshot(candles, 'BTC', '30m')).toThrow(/timeframe/);
  });
});
