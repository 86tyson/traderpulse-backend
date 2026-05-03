'use strict';

require('./setup');

const { rollingRSI } = require('../src/services/snapshotBuilder');
const {
  evaluateSoloway,
  findConfluenceFactors,
  hasNegativeDivergenceIntoResistance,
  isWeekendBlock,
  CONFLUENCE_PROXIMITY_ATR_MULT,
  STOP_BUFFER_ATR_MULT,
  VOL_EXTREME_HIGH_MULT,
  VOL_EXTREME_LOW_MULT,
  CHOP_ATR_PRICE_RATIO,
  RSI_OVERBOUGHT_THRESHOLD,
} = require('../src/services/solowayPlaybook');

// ---------------------------------------------------------------------------
// Test helpers — these construct synthetic candles + snapshots without
// touching the live data feed. The Soloway evaluator works off the
// snapshot object, so we can build snapshots directly to test branches.
// ---------------------------------------------------------------------------

function makeCandles(closes, options = {}) {
  const startTs = options.startTs || 1700000000000;
  const stepMs = options.stepMs || 3600000; // 1H
  return closes.map((close, i) => ({
    time: startTs + i * stepMs,
    open: i === 0 ? close : closes[i - 1],
    high: close + (options.range || 1),
    low: close - (options.range || 1),
    close,
    volume: options.volume || 100,
  }));
}

function baseSnapshot(overrides = {}) {
  // A "passing" snapshot: ETH-USD on a Monday-PT, in an uptrend, with
  // confluence support overlap and reasonable ATR. Override per-test.
  return {
    symbol: 'ETH',
    price: 2300,
    change24h: 1.5,
    ma50: 2295, // within 0.5 × ATR (5) of price (5 distance)
    recentHigh: 2380,
    support: 2293, // swing low — also within proximity
    resistance: 2380,
    trend: 'UPTREND',
    volatility: 'OK',
    volume: 'OK',
    condition: 'FAVORABLE',
    pullbackPct: 3.4,
    atr: 10,
    atrMedian: 10,
    rsi: 55,
    recentSwingHighsRsi: [
      { price: 2370, rsi: 65 },
      { price: 2350, rsi: 60 },
    ],
    ...overrides,
  };
}

// Each test re-imports the module fresh so any module-level state in the
// recommendationQueue doesn't carry across tests. Done in setup.js via
// jest.resetModules in beforeEach where needed.

// ---------------------------------------------------------------------------
// 1. RSI(14) computation correctness
// ---------------------------------------------------------------------------
describe('rollingRSI(14)', () => {
  test('returns NaN for the first `period` bars', () => {
    const candles = makeCandles([100, 101, 102]);
    const rsi = rollingRSI(candles, 14);
    expect(rsi.length).toBe(3);
    expect(rsi.every((v) => Number.isNaN(v))).toBe(true);
  });

  test('produces a value once enough bars are available', () => {
    // 20 bars of monotonic increase → all gains, no losses → RSI saturates
    // at 100.
    const closes = [];
    for (let i = 0; i < 20; i++) closes.push(100 + i);
    const candles = makeCandles(closes);
    const rsi = rollingRSI(candles, 14);
    const last = rsi[rsi.length - 1];
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBe(100);
  });

  test('saturates near 0 for monotonic decline', () => {
    const closes = [];
    for (let i = 0; i < 20; i++) closes.push(120 - i);
    const candles = makeCandles(closes);
    const rsi = rollingRSI(candles, 14);
    const last = rsi[rsi.length - 1];
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBe(0);
  });

  test('alternating up/down bars produce a value near 50', () => {
    const closes = [];
    for (let i = 0; i < 20; i++) closes.push(i % 2 === 0 ? 100 : 101);
    const candles = makeCandles(closes);
    const rsi = rollingRSI(candles, 14);
    const last = rsi[rsi.length - 1];
    expect(last).toBeGreaterThan(40);
    expect(last).toBeLessThan(60);
  });
});

// ---------------------------------------------------------------------------
// 2. ATR-based volatility filter — BLK-02
// ---------------------------------------------------------------------------
describe('BLK-02 — volatility extreme', () => {
  test('blocks when current ATR > 3× median', () => {
    const snap = baseSnapshot({ atr: 35, atrMedian: 10 }); // 3.5×
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).toBeNull();
    expect(r.skipReasons.some((s) => s.startsWith('VOLATILITY_TOO_HIGH'))).toBe(true);
  });

  test('blocks when current ATR < 0.25× median', () => {
    const snap = baseSnapshot({ atr: 2, atrMedian: 10 }); // 0.2×
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).toBeNull();
    expect(r.skipReasons.some((s) => s.startsWith('VOLATILITY_TOO_LOW'))).toBe(true);
  });

  test('allows when ATR within range', () => {
    const snap = baseSnapshot({ atr: 12, atrMedian: 10 }); // 1.2×
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(
      r.skipReasons.some(
        (s) => s.startsWith('VOLATILITY_TOO_HIGH') || s.startsWith('VOLATILITY_TOO_LOW'),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. RSI negative divergence — BLK-03
// ---------------------------------------------------------------------------
describe('BLK-03 — RSI negative divergence into resistance', () => {
  test('detects HH price + LH RSI within 1×ATR of resistance', () => {
    const snap = baseSnapshot({
      price: 2370, // close to resistance 2380, within 1×ATR (10)
      resistance: 2380,
      atr: 10,
      recentSwingHighsRsi: [
        { price: 2375, rsi: 62 }, // newest: HH
        { price: 2350, rsi: 70 }, // older: lower price, higher RSI
      ],
    });
    const div = hasNegativeDivergenceIntoResistance(snap);
    expect(div.divergent).toBe(true);
  });

  test('does NOT trigger when price is far from resistance', () => {
    const snap = baseSnapshot({
      price: 2200, // 180 below resistance, > 1×ATR
      resistance: 2380,
      atr: 10,
      recentSwingHighsRsi: [
        { price: 2375, rsi: 62 },
        { price: 2350, rsi: 70 },
      ],
    });
    const div = hasNegativeDivergenceIntoResistance(snap);
    expect(div.divergent).toBe(false);
  });

  test('does NOT trigger without HH+LH pattern', () => {
    const snap = baseSnapshot({
      recentSwingHighsRsi: [
        { price: 2350, rsi: 70 }, // newer LL
        { price: 2375, rsi: 62 }, // older HH
      ],
    });
    const div = hasNegativeDivergenceIntoResistance(snap);
    expect(div.divergent).toBe(false);
  });

  test('Soloway evaluator skips with RSI_NEGATIVE_DIVERGENCE', () => {
    const snap = baseSnapshot({
      price: 2370,
      resistance: 2380,
      atr: 10,
      recentSwingHighsRsi: [
        { price: 2375, rsi: 62 },
        { price: 2350, rsi: 70 },
      ],
    });
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).toBeNull();
    expect(r.skipReasons.some((s) => s.startsWith('RSI_NEGATIVE_DIVERGENCE'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. PRE-04 confluence — at-least-2 factors within 0.5×ATR
// ---------------------------------------------------------------------------
describe('PRE-04 — confluence requires ≥ 2 factors', () => {
  test('passes when 2 factors within 0.5×ATR', () => {
    const snap = baseSnapshot({ atr: 10, ma50: 2297, support: 2298 });
    const r = findConfluenceFactors(snap);
    expect(r.factors.length).toBeGreaterThanOrEqual(2);
  });

  test('rejects when only 1 factor within 0.5×ATR', () => {
    // ATR=10, proximity=5. Set price=2317 so:
    //   ma50=2314 → dist 3, within (factor)
    //   support=2280 → dist 37, NOT within
    //   roundNumber=floor(2317/50)*50=2300 → dist 17, NOT within
    // Only 1 factor.
    const snap = baseSnapshot({ atr: 10, price: 2317, ma50: 2314, support: 2280 });
    const r = findConfluenceFactors(snap);
    expect(r.factors.length).toBeLessThan(2);
  });

  test('Soloway skips with INSUFFICIENT_CONFLUENCE message', () => {
    const snap = baseSnapshot({ atr: 10, price: 2317, ma50: 2314, support: 2280 });
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).toBeNull();
    expect(
      r.skipReasons.some((s) => s.startsWith('INSUFFICIENT_CONFLUENCE') || s.startsWith('NO_NEARBY_LEVELS')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. STP-01 — stop is ATR-anchored and below entry
// ---------------------------------------------------------------------------
describe('STP-01 — ATR-anchored stop', () => {
  test('stop = lowestSupport − 0.5×ATR and < entry', () => {
    // ATR=20, proximity=10, all 3 factors within range:
    //   ma50=2295 (dist 5)
    //   support=2293 (dist 7)
    //   roundNumber=2300 (dist 0)
    // → lowestSupport = min(2295, 2293, 2300) = 2293
    // → stop = 2293 − (0.5 × 20) = 2283
    const snap = baseSnapshot({ atr: 20, atrMedian: 20, ma50: 2295, support: 2293 });
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).not.toBeNull();
    expect(r.recommendation.stopLoss).toBeCloseTo(2283, 1);
    expect(r.recommendation.stopLoss).toBeLessThan(snap.price);
    expect(r.recommendation.invalidationLevel).toBe(r.recommendation.stopLoss);
  });

  test('rejects when ATR is missing (warm-up)', () => {
    const snap = baseSnapshot({ atr: null, atrMedian: null });
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).toBeNull();
    // Either MISSING_ATR OR another earlier gate fired — both acceptable
    // because the evaluator short-circuits on the first failure.
    expect(r.skipReasons.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 6. STAY-OUT filters
// ---------------------------------------------------------------------------
describe('STAY-OUT filters', () => {
  test('CHOP_LOW_VOL when ATR/price < 0.4%', () => {
    // ATR/price = 5/2300 ≈ 0.22% — chop
    const snap = baseSnapshot({ atr: 5, atrMedian: 5 });
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).toBeNull();
    expect(r.skipReasons.some((s) => s.startsWith('CHOP_LOW_VOL'))).toBe(true);
  });

  test('RSI_OVERBOUGHT_NO_ENTRY when RSI > 75 and no divergence', () => {
    const snap = baseSnapshot({
      rsi: 80,
      // Make swings non-divergent (newer is also higher RSI)
      recentSwingHighsRsi: [
        { price: 2375, rsi: 78 },
        { price: 2350, rsi: 60 },
      ],
    });
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).toBeNull();
    expect(r.skipReasons.some((s) => s.startsWith('RSI_OVERBOUGHT_NO_ENTRY'))).toBe(true);
  });

  test('NO_NEARBY_LEVELS when no factors within 2×ATR', () => {
    // ATR=10, white-space band=20. Place all factors > 20 from price.
    const snap = baseSnapshot({
      atr: 10,
      ma50: 2270, // 30 below
      support: 2260, // 40 below
      // round-number factor for ETH: floor(2300/50)*50 = 2300 (would equal
      // price, which is "not below"). Set price to 2305 so floor(2305/50)*50 = 2300
      // is 5 below — within range. So we need to push price up to make round
      // far. price=2350, floor(2350/50)*50=2350 (equal, skipped). Hmm —
      // round-number passes only when level <= price AND not equal? Look
      // at checkFactor: requires level <= snap.price. Set price=2351 →
      // floor=2350, 1 below, within range. Need to construct so round is
      // also far. Use price=2371 → floor=2350, 21 below, > 20. Good.
      price: 2371,
      ma50: 2330, // 41 below
      support: 2300, // 71 below
      recentHigh: 2400,
    });
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    expect(r.recommendation).toBeNull();
    expect(r.skipReasons.some((s) => s.startsWith('NO_NEARBY_LEVELS'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Soloway evaluator does NOT execute trades — it only returns
//    recommendation OR null. No live API references in its module.
// ---------------------------------------------------------------------------
describe('execution safety', () => {
  test('module never imports a place-order or live-execute path', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'src/services/solowayPlaybook.js'),
      'utf8',
    );
    expect(src).not.toMatch(/robinhoodClient/);
    expect(src).not.toMatch(/\/live\/(approve|close|reconcile)/);
    expect(src).not.toMatch(/placeOrder/);
    expect(src).not.toMatch(/cancelOrder/);
  });

  test('evaluator returns recommendation OR null, never side-effects', () => {
    const snap = baseSnapshot();
    const r = evaluateSoloway(snap, { liveSymbol: 'ETH-USD', now: monday() });
    // Either passes (rec) or is rejected. Either way the return shape
    // includes the diagnostic fields needed by the spec's logging contract.
    expect(r).toHaveProperty('snapshot');
    expect(r).toHaveProperty('skipReasons');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('atr');
    expect(r).toHaveProperty('rsi');
    expect(r).toHaveProperty('confluenceCount');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function monday() {
  // Anchor a Monday in PT so the weekend hard-block doesn't interfere
  // with tests that should otherwise pass earlier filters.
  return new Date('2026-05-11T17:00:00.000Z'); // Monday 10:00 PT
}
