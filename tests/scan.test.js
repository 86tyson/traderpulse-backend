'use strict';

require('./setup');
const request = require('supertest');

const TOKEN = process.env.BACKEND_API_KEY;
const auth = { Authorization: `Bearer ${TOKEN}` };

// Build synthetic Coinbase candle tuples that produce a clear UPTREND so the
// scan returns valid snapshots. (The strategy may still skip on filters; we
// only assert response *shape*, not that a recommendation was emitted.)
//
// Coinbase tuple shape: [time(s), low, high, open, close, volume]
// Coinbase returns newest-first; the marketDataClient sorts ascending so the
// test data here can be in either order.
function syntheticCoinbaseCandles(n) {
  const out = [];
  let base = 60000;
  const startSec = 1700000000;
  for (let i = 0; i < n; i++) {
    const drift = base + i * 80;
    const noise = ((i * 13) % 17) - 8;
    const close = drift + noise;
    out.push([
      startSec + i * 3600,   // time (seconds)
      close - 25,             // low
      close + 25,             // high
      close - 10,             // open
      close,                  // close
      100 + (i % 9),          // volume
    ]);
  }
  return out;
}

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
  // Reset the module-level cache between tests by re-requiring scan.js.
  jest.resetModules();
});

afterEach(() => {
  global.fetch = originalFetch;
});

function appWithMockedFetch(fetchImpl) {
  global.fetch = fetchImpl;
  // Re-require buildApp AFTER stubbing fetch so the route closure picks it up.
  const { buildApp } = require('../src/server');
  return buildApp();
}

describe('GET /scan', () => {
  test('rejects when bearer token is missing', async () => {
    const app = appWithMockedFetch(async () => {
      throw new Error('should not be called');
    });
    const res = await request(app).get('/scan');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('returns ok=true with two snapshots on successful Binance fetch', async () => {
    const candles = syntheticCoinbaseCandles(100);
    const app = appWithMockedFetch(async (url) => {
      if (typeof url !== 'string' || !url.includes('coinbase.com')) {
        throw new Error('unexpected url: ' + url);
      }
      return new Response(JSON.stringify(candles), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await request(app).get('/scan').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.timeframe).toBe('1h');
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results).toHaveLength(2);

    for (const r of res.body.results) {
      expect(r.snapshot).toBeTruthy();
      expect(['BTC', 'ETH']).toContain(r.snapshot.symbol);
      expect(typeof r.snapshot.price).toBe('number');
      expect(Array.isArray(r.skipReasons)).toBe(true);
      // recommendation may be null if filters blocked it — both shapes are valid here
      if (r.recommendation) {
        expect(r.recommendation.side).toBe('BUY');
        expect(['HIGH', 'MEDIUM']).toContain(r.recommendation.confidence);
      }
    }
  });

  test('returns 502 MARKET_DATA_UNAVAILABLE when upstream fetch fails', async () => {
    const app = appWithMockedFetch(async () => {
      throw new Error('connection refused');
    });
    const res = await request(app).get('/scan').set(auth);
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('MARKET_DATA_UNAVAILABLE');
  });

  test('caches successive calls for 60 seconds (cached: true on second call)', async () => {
    const candles = syntheticCoinbaseCandles(100);
    let fetchCount = 0;
    const app = appWithMockedFetch(async () => {
      fetchCount++;
      return new Response(JSON.stringify(candles), { status: 200 });
    });

    const r1 = await request(app).get('/scan').set(auth);
    const r2 = await request(app).get('/scan').set(auth);
    expect(r1.body.cached).toBe(false);
    expect(r2.body.cached).toBe(true);
    // First call fetches twice (BTC + ETH); cache hit on second call adds nothing.
    expect(fetchCount).toBe(2);
  });
});
