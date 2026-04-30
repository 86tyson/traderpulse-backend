'use strict';

require('./setup');

// Run the momentum strategy via tsx programmatically so we can stay in jest.
// We use a child-process call to npx tsx to invoke a short eval script that
// imports the TS module and emits JSON. This avoids adding tsx as a runtime
// dep to jest itself while still letting us exercise the TS code.
//
// The momentum strategy lives in src/lib/trading/momentumStrategy.ts (TS).
// jest+CommonJS can't require it directly. So we spawn a child process.

const { execFileSync } = require('child_process');
const path = require('path');

function runTsHelper(args) {
  const helper = path.resolve(__dirname, 'helpers', 'momentumHelper.ts');
  const out = execFileSync('npx', ['--yes', 'tsx', helper, JSON.stringify(args)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  return JSON.parse(out);
}

// Build a deterministic clean-breakout candle sequence:
//   - 60 bars of slight uptrend (so MA50 is established and rising)
//   - last bar breaks above the 20-bar high with above-average volume
function buildBreakoutCandles() {
  const candles = [];
  let price = 1000;
  for (let i = 0; i < 60; i++) {
    // small drift up + tight noise; bars 40-58 establish the "prior 20-bar high"
    const drift = 1000 + i * 5;
    const noise = ((i * 7) % 11) - 5;
    const close = drift + noise;
    candles.push({
      timestamp: 1700000000000 + i * 3600 * 1000,
      open: close - 2,
      high: close + 8,
      low: close - 8,
      close,
      volume: 100,
    });
  }
  // The 20-bar high looking back from index 59 spans bars 39..58 — that's the
  // window we need to break. Bar 59 closes above all of their highs and has
  // a clear volume surge.
  const last = candles[candles.length - 1];
  last.close = 2000;
  last.high = 2010;
  last.low = 1290;
  last.open = 1295;
  last.volume = 250;
  return candles;
}

function buildSidewaysCandles() {
  const candles = [];
  for (let i = 0; i < 60; i++) {
    const close = 1000 + (((i * 13) % 9) - 4);
    candles.push({
      timestamp: 1700000000000 + i * 3600 * 1000,
      open: close - 1,
      high: close + 3,
      low: close - 3,
      close,
      volume: 100,
    });
  }
  return candles;
}

describe('momentumStrategy.evaluateMomentum', () => {
  test('emits a recommendation on a clean breakout', () => {
    const candles = buildBreakoutCandles();
    const result = runTsHelper({ candles, symbol: 'BTC', timeframe: '1h' });

    expect(result.recommendation).not.toBeNull();
    expect(result.recommendation.symbol).toBe('BTC');
    expect(result.recommendation.side).toBe('BUY');
    expect(result.recommendation.exitPlan).toBeDefined();
    expect(result.recommendation.exitPlan.mode).toBe('trailing-atr');
    expect(result.recommendation.exitPlan.atrMultiplier).toBeGreaterThan(0);

    // Stop should be below entry (LONG); target is a far cap above entry.
    expect(result.recommendation.stopLoss).toBeLessThan(result.recommendation.entry);
    expect(result.recommendation.profitTarget).toBeGreaterThan(result.recommendation.entry);

    // 2R minimum target captured in the headline number, but trailing is the actual exit.
    expect(result.recommendation.riskRewardRatio).toBeGreaterThanOrEqual(2);

    expect(result.skipReasons).toEqual([]);
  });

  test('returns skipReasons when there is no breakout', () => {
    const candles = buildSidewaysCandles();
    const result = runTsHelper({ candles, symbol: 'ETH', timeframe: '1h' });

    expect(result.recommendation).toBeNull();
    expect(result.skipReasons.length).toBeGreaterThan(0);
    // Sideways data may trip multiple filters; we only require at least one.
    const text = result.skipReasons.join(' | ');
    const tripped =
      text.includes('breakout') ||
      text.includes('not above MA50') ||
      text.includes('slope not positive') ||
      text.includes('Volume');
    expect(tripped).toBe(true);
  });

  test('returns skipReasons when there are too few candles', () => {
    const candles = buildBreakoutCandles().slice(0, 30);
    const result = runTsHelper({ candles, symbol: 'BTC', timeframe: '1h' });
    expect(result.recommendation).toBeNull();
    expect(result.skipReasons.join(' | ')).toMatch(/Not enough candles/);
  });
});
