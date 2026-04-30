'use strict';

// Resilient downloader for Coinbase Exchange public candles.
//
// Public read-only endpoint (anonymous, no API key, US-friendly):
//   https://api.exchange.coinbase.com/products/{id}/candles
//
// Coinbase tuple: [time(s), low, high, open, close, volume]
// Newest-first within each page; we sort ascending and dedupe at the end.
//
// Usage (programmatic from this file's main):
//   node scripts/downloadCoinbaseHistorical.js
//
// Outputs CSVs into ./data/ in the harness's expected format:
//   timestamp,open,high,low,close,volume
//
// Aggregates 1h candles to 4h post-download since Coinbase has no native 4h.

const fs = require('fs');
const path = require('path');

const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const PAGE_SIZE = 300;          // Coinbase max
const RATE_LIMIT_DELAY_MS = 200; // polite spacing
const MAX_RETRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(symbol, granularitySec, startSec, endSec, attempt = 0) {
  const url =
    `${COINBASE_BASE}/products/${symbol}/candles` +
    `?granularity=${granularitySec}` +
    `&start=${new Date(startSec * 1000).toISOString()}` +
    `&end=${new Date(endSec * 1000).toISOString()}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'crypto-trading-backend-downloader/0.1' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 429) {
      // rate-limited; back off
      if (attempt >= MAX_RETRIES) throw new Error('429 rate-limited too many times');
      await sleep(1000 * (attempt + 1));
      return fetchPage(symbol, granularitySec, startSec, endSec, attempt + 1);
    }
    if (!res.ok) throw new Error(`Coinbase ${res.status} ${res.statusText}`);
    const arr = await res.json();
    if (!Array.isArray(arr)) throw new Error('Unexpected non-array response');
    return arr;
  } catch (err) {
    if (attempt >= MAX_RETRIES) throw err;
    await sleep(500 * (attempt + 1));
    return fetchPage(symbol, granularitySec, startSec, endSec, attempt + 1);
  }
}

async function downloadHistorical(symbol, granularitySec, totalBars) {
  const all = new Map(); // dedupe by timestamp
  let endSec = Math.floor(Date.now() / 1000);
  // Snap end to a clean bar boundary to avoid weird half-bars on the edge.
  endSec = endSec - (endSec % granularitySec);

  while (all.size < totalBars) {
    const startSec = endSec - granularitySec * PAGE_SIZE;
    const page = await fetchPage(symbol, granularitySec, startSec, endSec);
    if (page.length === 0) break;
    for (const k of page) {
      // k = [time, low, high, open, close, volume]
      all.set(k[0], k);
    }
    process.stdout.write(`\r  ${symbol} g=${granularitySec}: ${all.size}/${totalBars} bars`);
    endSec = startSec;
    await sleep(RATE_LIMIT_DELAY_MS);
  }
  process.stdout.write('\n');

  const sorted = [...all.values()].sort((a, b) => a[0] - b[0]);
  return sorted.slice(-totalBars).map((k) => ({
    timestamp: k[0] * 1000,
    low: Number(k[1]),
    high: Number(k[2]),
    open: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

function aggregateTo4h(hourly) {
  // Group consecutive 4 1h candles into a single 4h candle.
  // Anchor on the first candle whose hour is a multiple of 4 in UTC, so the
  // resulting 4h bars line up with standard {0,4,8,12,16,20} UTC boundaries.
  let firstIdx = 0;
  while (firstIdx < hourly.length) {
    const hour = new Date(hourly[firstIdx].timestamp).getUTCHours();
    if (hour % 4 === 0) break;
    firstIdx++;
  }
  const result = [];
  for (let i = firstIdx; i + 3 < hourly.length; i += 4) {
    const group = hourly.slice(i, i + 4);
    result.push({
      timestamp: group[0].timestamp,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((acc, c) => acc + c.volume, 0),
    });
  }
  return result;
}

function writeCsv(filePath, candles) {
  const lines = ['timestamp,open,high,low,close,volume'];
  for (const c of candles) {
    lines.push(
      [
        new Date(c.timestamp).toISOString(),
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume,
      ].join(','),
    );
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

async function main() {
  const dataDir = path.resolve(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Bar counts for "last 3 months" and "last 12 months" at 1h granularity.
  const BARS_3MO_1H = 24 * 30 * 3; // 2160
  const BARS_12MO_1H = 24 * 365;   // 8760

  const datasets = [
    { symbol: 'BTC-USD', granularity: 3600, bars: BARS_3MO_1H, file: 'btc-1h-last3mo.csv' },
    { symbol: 'BTC-USD', granularity: 3600, bars: BARS_12MO_1H, file: 'btc-1h-last12mo.csv' },
    { symbol: 'ETH-USD', granularity: 3600, bars: BARS_3MO_1H, file: 'eth-1h-last3mo.csv' },
    { symbol: 'ETH-USD', granularity: 3600, bars: BARS_12MO_1H, file: 'eth-1h-last12mo.csv' },
  ];

  for (const d of datasets) {
    console.log(`Downloading ${d.symbol} ${d.granularity}s ${d.bars} bars -> ${d.file}`);
    const candles = await downloadHistorical(d.symbol, d.granularity, d.bars);
    const out = path.join(dataDir, d.file);
    writeCsv(out, candles);
    console.log(`  wrote ${candles.length} rows`);
  }

  // Derive 4h-12mo by aggregating from 1h-12mo for each symbol.
  for (const sym of ['btc', 'eth']) {
    const inFile = path.join(dataDir, `${sym}-1h-last12mo.csv`);
    const outFile = path.join(dataDir, `${sym}-4h-last12mo.csv`);
    const raw = fs.readFileSync(inFile, 'utf8').trim().split('\n');
    const hourly = raw.slice(1).map((line) => {
      const [t, o, h, l, c, v] = line.split(',');
      return {
        timestamp: Date.parse(t),
        open: Number(o), high: Number(h), low: Number(l), close: Number(c), volume: Number(v),
      };
    });
    const fourHour = aggregateTo4h(hourly);
    writeCsv(outFile, fourHour);
    console.log(`Aggregated ${sym} 1h -> 4h: ${fourHour.length} bars -> ${outFile}`);
  }

  console.log('\nAll datasets ready.');
}

main().catch((err) => {
  console.error('Download failed:', err.message ?? err);
  process.exit(1);
});
