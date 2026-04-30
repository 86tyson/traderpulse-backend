// src/lib/trading/evaluateFromCandles.ts
//
// Thin bridge that lets the existing strategy run against real candle history.
//
// Flow:
//   candles  ─►  buildSnapshot(candles, symbol, timeframe)  ─►  MarketSnapshot
//                                                                    │
//                                                                    ▼
//                                          evaluateMarket(snapshot)  ─►  ScanResult
//                                                                    │
//                                                                    ▼
//                                              Recommendation | null  +  skipReasons
//
// Pure: no randomness, no mocks, no I/O, no mutation of the input array.

import { buildSnapshot, type Candle, type Timeframe } from "./snapshotBuilder";
import { evaluateMarket, type ScanResult, type StrategyParams } from "./strategy";
import type { AssetSymbol } from "./types";

const ALLOWED_TIMEFRAMES = new Set<Timeframe>(["5m", "15m", "1h", "4h", "1d"]);

/** Returned when the candle series is too short for the snapshot builder to compute its indicators. */
export interface InsufficientCandlesResult {
  snapshot: null;
  recommendation: null;
  skipReasons: string[];
}

export type EvaluateResult = ScanResult | InsufficientCandlesResult;

/**
 * Run the existing trading strategy against a chronologically-ordered candle series.
 *
 * @param candles    Oldest first. Not mutated.
 * @param symbol     "BTC" | "ETH". Used by the snapshot builder for rounding precision and
 *                   carried through to the final Recommendation.
 * @param timeframe  Used only by the snapshot builder to compute change24h.
 *
 * @returns
 *   - A full {@link ScanResult} when the snapshot was built successfully. Contains either
 *     a populated `recommendation` (HIGH/MEDIUM confidence buy) or `null` with skipReasons.
 *   - An {@link InsufficientCandlesResult} (snapshot: null) when there are too few candles
 *     for the snapshot builder. Surfaced as a skip reason rather than a thrown error so
 *     a backtest replay loop can iterate without try/catch on every bar.
 *
 * Throws only when the input is structurally malformed — not an array, unsupported symbol,
 * unsupported timeframe.
 */
export function evaluateMarketFromCandles(
  candles: Candle[],
  symbol: AssetSymbol,
  timeframe: Timeframe,
  params: StrategyParams = {},
): EvaluateResult {
  // Structural validation — these are programmer errors, not market conditions, so throw.
  if (!Array.isArray(candles)) {
    throw new TypeError("evaluateMarketFromCandles: candles must be an array");
  }
  if (symbol !== "BTC" && symbol !== "ETH") {
    throw new TypeError(`evaluateMarketFromCandles: unsupported symbol "${symbol}"`);
  }
  if (!ALLOWED_TIMEFRAMES.has(timeframe)) {
    throw new TypeError(`evaluateMarketFromCandles: unsupported timeframe "${timeframe}"`);
  }

  // buildSnapshot's only documented throw is "need at least N candles". Catch that
  // specific case and convert it into a structured skip result; re-raise anything else
  // because it would represent an unexpected bug, not a runtime market condition.
  let snapshot;
  try {
    snapshot = buildSnapshot(candles, symbol, timeframe);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("snapshotBuilder: need at least")) {
      return {
        snapshot: null,
        recommendation: null,
        skipReasons: ["Not enough candles to evaluate"],
      };
    }
    throw err;
  }

  return evaluateMarket(snapshot, params);
}

export type { StrategyParams } from "./strategy";

// Re-export the input types so callers don't have to dig into ./snapshotBuilder.
export type { Candle, Timeframe } from "./snapshotBuilder";
