'use strict';

/**
 * Public market-data client (read-only, anonymous).
 *
 * Uses Coinbase Exchange's public candles endpoint:
 *   https://api.exchange.coinbase.com/products/{product_id}/candles
 *
 * No API key, no auth, no order placement, no live trading. This is purely
 * a price-data feed for the strategy snapshot builder. Works in US (Binance
 * returns 451 to US IPs; Coinbase Exchange's read endpoints are open).
 *
 * Response shape (per Coinbase docs):
 *   [[ time, low, high, open, close, volume ], ...]
 *   - time is unix seconds
 *   - newest-first ordering (we sort ascending before returning)
 */

const COINBASE_BASE = 'https://api.exchange.coinbase.com';

const SYMBOL_MAP = {
  // Coinbase already uses the BTC-USD / ETH-USD form, so the map is identity.
  'BTC-USD': 'BTC-USD',
  'ETH-USD': 'ETH-USD',
};

const GRANULARITY_MAP = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '1d': 86400,
};
const ALLOWED_INTERVALS = new Set(Object.keys(GRANULARITY_MAP));

// Coinbase tops out at 300 candles per request. Asking for more silently truncates.
const MAX_LIMIT = 300;

const FETCH_TIMEOUT_MS = 10_000;

class MarketDataError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'MarketDataError';
    this.cause = cause;
  }
}

async function fetchCoinbaseCandles(symbol, interval = '1h', limit = 100) {
  const cbSymbol = SYMBOL_MAP[symbol];
  if (!cbSymbol) throw new MarketDataError(`Unsupported symbol: ${symbol}`);
  if (!ALLOWED_INTERVALS.has(interval)) {
    throw new MarketDataError(
      `Unsupported interval: ${interval} (supported: ${[...ALLOWED_INTERVALS].join(', ')})`,
    );
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new MarketDataError(`limit must be 1..${MAX_LIMIT}, got ${limit}`);
  }

  const granularity = GRANULARITY_MAP[interval];
  // Compute an explicit start window so we get exactly `limit` bars ending now.
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = nowSec;
  const startSec = endSec - granularity * limit;
  const url =
    `${COINBASE_BASE}/products/${cbSymbol}/candles` +
    `?granularity=${granularity}` +
    `&start=${new Date(startSec * 1000).toISOString()}` +
    `&end=${new Date(endSec * 1000).toISOString()}`;

  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'crypto-trading-backend/0.1 (read-only)' },
    });
  } catch (err) {
    throw new MarketDataError(`Coinbase fetch failed: ${err.message ?? err}`, err);
  }
  if (!res.ok) {
    throw new MarketDataError(`Coinbase API error: ${res.status} ${res.statusText}`);
  }

  let raw;
  try {
    raw = await res.json();
  } catch (err) {
    throw new MarketDataError(`Coinbase response was not valid JSON`, err);
  }
  if (!Array.isArray(raw)) {
    throw new MarketDataError('Unexpected Coinbase response shape (expected array)');
  }

  // Coinbase tuple: [time(s), low, high, open, close, volume].
  // Note: coinbase returns newest-first, so we sort ascending by timestamp.
  const candles = raw.map((k) => ({
    timestamp: k[0] * 1000,
    low: Number(k[1]),
    high: Number(k[2]),
    open: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

module.exports = {
  fetchCoinbaseCandles,
  MarketDataError,
  SYMBOL_MAP,
  ALLOWED_INTERVALS,
  // Backward-compatible alias if anyone in the project still calls the old name.
  fetchBinanceKlines: fetchCoinbaseCandles,
};
