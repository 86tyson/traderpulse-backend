// scripts/downloadFundingRates.ts
//
// One-shot downloader for Binance USDT-margined-futures funding-rate archives.
//
// Source: data.binance.vision/data/futures/um/monthly/fundingRate/{SYMBOL}/...
// Accessible from US (different host from the geo-blocked fapi.binance.com).
//
// Run via:  npx tsx scripts/downloadFundingRates.ts
// Writes:    data/funding-{symbol}-15mo.json

import {
  fetchBinanceArchiveFunding,
  writeFundingCache,
  fundingCachePath,
  type FundingSymbol,
} from "../src/data/fundingRates";

async function main() {
  // Two test windows (current and prior 12-month) plus 90-day rolling-window
  // warmup before each. Earliest required = 2024-01-29 (prior window starts
  // 2024-04-29, minus 90 days).
  const startMs = Date.parse("2024-01-29T00:00:00Z");
  const endMs = Date.parse("2026-04-29T00:00:00Z");

  const symbols: FundingSymbol[] = ["BTCUSDT", "ETHUSDT"];
  for (const symbol of symbols) {
    console.log(
      `Fetching ${symbol} funding archive ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)}`,
    );
    const events = await fetchBinanceArchiveFunding(symbol, startMs, endMs);
    const out = fundingCachePath(symbol, "all");
    writeFundingCache(out, events, symbol, "BINANCE-ARCHIVE");
    if (events.length > 0) {
      console.log(
        `  wrote ${events.length} events to ${out}` +
          ` (first ${new Date(events[0].timestamp).toISOString()},` +
          ` last ${new Date(events[events.length - 1].timestamp).toISOString()})`,
      );
    } else {
      console.log(`  no events written (empty result)`);
    }
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Funding download failed:", err.message ?? err);
  process.exit(1);
});
