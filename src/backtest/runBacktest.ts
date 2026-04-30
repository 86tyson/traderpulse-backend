// src/backtest/runBacktest.ts
//
// CLI entry point for the backtest harness.
//
// Usage:
//   npm run backtest -- --file ./data/btc.csv --symbol BTC --timeframe 1h
//
// Optional flags:
//   --out          (default ./reports)
//   --cost-bps     (default 20  — round-trip basis points)
//   --notional-usd (default 25  — matches the strategy's DEFAULT_AMOUNT)

import { loadCandles } from "./loadCandles";
import { simulateTrade, type BacktestTrade, type SimulatorConfig } from "./simulator";
import { computeMetrics } from "./metrics";
import { writeReports, type ReportContext } from "./reporter";
import { evaluateMarketFromCandles } from "../lib/trading/evaluateFromCandles";
import { evaluateMomentum, type MomentumParams } from "../lib/trading/momentumStrategy";
import { evaluateCapitulation } from "../lib/trading/capitulationStrategy";
import { evaluateFunding } from "../lib/trading/fundingStrategy";
import { evaluateFundingCompression } from "../lib/trading/fundingCompressionStrategy";
import {
  buildFundingContext,
  makeFundingNormalizedAtTimeFn,
  readFundingCache,
  rollingPercentile,
  type FundingContext,
} from "../data/fundingRates";
import type { StrategyParams } from "../lib/trading/strategy";
import type { Timeframe } from "../lib/trading/snapshotBuilder";
import type { AssetSymbol } from "../lib/trading/types";

type StrategyChoice = "pullback" | "momentum" | "capitulation" | "funding" | "funding-compression";

interface CliArgs {
  file: string;
  symbol: AssetSymbol;
  timeframe: Timeframe;
  out: string;
  costBps: number;
  notionalUsd: number;
  strategy: StrategyChoice;
  params: StrategyParams;
  momentumParams: MomentumParams;
  variantLabel: string;
  fundingRatesFile: string | null;
  disableFundingFilter: boolean;
  // Exit-structure overrides (applied only to funding-compression strategy).
  exitOverrides: {
    mode?: "staged-r-trail" | "staged-r-trail-partial";
    bePromoteAtR?: number | null;
    trailFromR?: number;
    timeStopBars?: number | null;
    partialExitAtR?: number;
    partialExitFraction?: number;
  } | null;
}

const ALLOWED_TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d"];

function parseArgs(argv: string[]): CliArgs {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      flags[key] = "true";
    } else {
      flags[key] = next;
      i++;
    }
  }

  const file = flags.file;
  const symbol = flags.symbol as AssetSymbol;
  const timeframe = flags.timeframe as Timeframe;

  if (!file) throw new Error("--file is required (path to OHLCV CSV)");
  if (symbol !== "BTC" && symbol !== "ETH") {
    throw new Error(`--symbol must be BTC or ETH (got "${flags.symbol ?? ""}")`);
  }
  if (!ALLOWED_TIMEFRAMES.includes(timeframe)) {
    throw new Error(
      `--timeframe must be one of ${ALLOWED_TIMEFRAMES.join(", ")} (got "${flags.timeframe ?? ""}")`,
    );
  }

  const costBps = flags["cost-bps"] != null ? Number(flags["cost-bps"]) : 20;
  if (!Number.isFinite(costBps) || costBps < 0) {
    throw new Error(`--cost-bps must be a non-negative number`);
  }
  const notionalUsd = flags["notional-usd"] != null ? Number(flags["notional-usd"]) : 25;
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    throw new Error(`--notional-usd must be a positive number`);
  }

  // Optional strategy-parameter overrides for controlled variant studies.
  // Defaults preserve the baseline strategy (3 % pullback, 2 % near-support).
  const params: StrategyParams = {};
  if (flags["pullback-min"] != null) {
    const v = Number(flags["pullback-min"]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--pullback-min must be a positive number`);
    params.pullbackMin = v;
  }
  if (flags["near-support-max"] != null) {
    const v = Number(flags["near-support-max"]);
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      throw new Error(`--near-support-max must be a fraction in (0..1] (e.g. 0.02 for 2 %)`);
    }
    params.nearSupportMax = v;
  }
  // Strategy selector. Default keeps prior runs reproducible.
  const strategyRaw = flags["strategy"] ?? "pullback";
  if (
    strategyRaw !== "pullback" &&
    strategyRaw !== "momentum" &&
    strategyRaw !== "capitulation" &&
    strategyRaw !== "funding" &&
    strategyRaw !== "funding-compression"
  ) {
    throw new Error(
      `--strategy must be "pullback", "momentum", "capitulation", "funding", or "funding-compression" (got "${strategyRaw}")`,
    );
  }
  const strategy = strategyRaw as StrategyChoice;

  const fundingRatesFile = flags["funding-rates-file"] ?? null;
  const disableFundingFilter = flags["disable-funding-filter"] === "true";

  // Parse exit-structure override flags. Each flag accepts a number, or the
  // literal "none" to mean "skip this step entirely" (BE / time stop only).
  const parseOptionalNum = (raw: string | undefined, name: string): number | null | undefined => {
    if (raw == null) return undefined;
    if (raw === "none") return null;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`${name} must be a positive number or "none" (got "${raw}")`);
    }
    return v;
  };
  const beR = parseOptionalNum(flags["exit-be-r"], "--exit-be-r");
  const trailR = (() => {
    if (flags["exit-trail-r"] == null) return undefined;
    const v = Number(flags["exit-trail-r"]);
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`--exit-trail-r must be a positive number (got "${flags["exit-trail-r"]}")`);
    }
    return v;
  })();
  const tsBars = parseOptionalNum(flags["exit-time-stop"], "--exit-time-stop");
  const exitMode = flags["exit-mode"];
  if (exitMode != null && exitMode !== "staged-r-trail" && exitMode !== "staged-r-trail-partial") {
    throw new Error(
      `--exit-mode must be "staged-r-trail" or "staged-r-trail-partial" (got "${exitMode}")`,
    );
  }
  const partialR = flags["exit-partial-r"] != null ? Number(flags["exit-partial-r"]) : undefined;
  const partialFrac =
    flags["exit-partial-fraction"] != null ? Number(flags["exit-partial-fraction"]) : undefined;
  if (partialR != null && (!Number.isFinite(partialR) || partialR <= 0)) {
    throw new Error(`--exit-partial-r must be a positive number`);
  }
  if (partialFrac != null && (!Number.isFinite(partialFrac) || partialFrac <= 0 || partialFrac >= 1)) {
    throw new Error(`--exit-partial-fraction must be in (0..1)`);
  }
  const hasAnyExitOverride =
    beR !== undefined ||
    trailR != null ||
    tsBars !== undefined ||
    exitMode != null ||
    partialR != null ||
    partialFrac != null;
  const exitOverrides = hasAnyExitOverride
    ? {
        mode: exitMode as "staged-r-trail" | "staged-r-trail-partial" | undefined,
        ...(beR !== undefined ? { bePromoteAtR: beR } : {}),
        ...(trailR != null ? { trailFromR: trailR } : {}),
        ...(tsBars !== undefined ? { timeStopBars: tsBars } : {}),
        ...(partialR != null ? { partialExitAtR: partialR } : {}),
        ...(partialFrac != null ? { partialExitFraction: partialFrac } : {}),
      }
    : null;
  if (strategy === "funding" && !fundingRatesFile) {
    throw new Error(`--strategy funding requires --funding-rates-file`);
  }
  if (strategy === "funding-compression" && !disableFundingFilter && !fundingRatesFile) {
    throw new Error(
      `--strategy funding-compression requires --funding-rates-file (or --disable-funding-filter for the ablation variant)`,
    );
  }

  const momentumParams: MomentumParams = {};
  if (flags["breakout-lookback"] != null) {
    const v = Number(flags["breakout-lookback"]);
    if (!Number.isInteger(v) || v <= 0) throw new Error(`--breakout-lookback must be a positive integer`);
    momentumParams.breakoutLookback = v;
  }
  if (flags["atr-multiplier"] != null) {
    const v = Number(flags["atr-multiplier"]);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`--atr-multiplier must be a positive number`);
    momentumParams.atrMultiplier = v;
  }

  const variantLabel = flags["variant"] ?? "default";

  return {
    file,
    symbol,
    timeframe,
    out: flags.out ?? "./reports",
    costBps,
    notionalUsd,
    strategy,
    params,
    momentumParams,
    variantLabel,
    fundingRatesFile,
    disableFundingFilter,
    exitOverrides,
  };
}

function run(): void {
  const cli = parseArgs(process.argv.slice(2));

  console.log(`Loading candles: ${cli.file}`);
  const candles = loadCandles(cli.file);
  console.log(`Loaded ${candles.length.toLocaleString()} candles.`);
  console.log(
    `Strategy: ${cli.strategy} | Symbol: ${cli.symbol} | Timeframe: ${cli.timeframe} | Cost: ${cli.costBps} bps | Notional: $${cli.notionalUsd}`,
  );
  if (cli.params.pullbackMin != null || cli.params.nearSupportMax != null) {
    const pb = cli.params.pullbackMin ?? 3;
    const ns = ((cli.params.nearSupportMax ?? 0.02) * 100).toFixed(1);
    console.log(`Variant: ${cli.variantLabel} | pullback >= ${pb}% | near-support <= ${ns}%`);
  }

  // Load funding-rate context if running a funding-aware strategy.
  let fundingContext: FundingContext | null = null;
  let fundingNormalizedAtTime: ((ms: number) => boolean) | undefined = undefined;
  const needsFundingContext =
    (cli.strategy === "funding") ||
    (cli.strategy === "funding-compression" && !cli.disableFundingFilter);
  if (needsFundingContext && cli.fundingRatesFile) {
    console.log(`Loading funding-rate cache: ${cli.fundingRatesFile}`);
    const cached = readFundingCache(cli.fundingRatesFile);
    fundingContext = buildFundingContext(cached.events, cached.symbol, cached.venue);
    if (cli.strategy === "funding") {
      // Only the prior funding-trigger strategy uses the normalization-exit callback.
      fundingNormalizedAtTime = makeFundingNormalizedAtTimeFn(fundingContext);
    }
    console.log(
      `  ${cached.events.length} funding events from ${cached.venue}` +
        ` (${cached.symbol}); first ${new Date(fundingContext.events[0]?.timestamp ?? 0).toISOString().slice(0, 10)}` +
        ` last ${new Date(fundingContext.events[fundingContext.events.length - 1]?.timestamp ?? 0).toISOString().slice(0, 10)}`,
    );
  }
  if (cli.strategy === "funding-compression" && cli.disableFundingFilter) {
    console.log(`Ablation: --disable-funding-filter set; running compression+regime only.`);
  }

  const baseCfg: SimulatorConfig = {
    costBps: cli.costBps,
    notionalUsd: cli.notionalUsd,
    fundingNormalizedAtTime,
  };
  const trades: BacktestTrade[] = [];
  let positionOpen = false;
  let positionExitIdx = -1;
  let approvedCount = 0;
  let evalErrors = 0;

  // Streak rule (capitulation strategy): after 3 consecutive losing trades,
  // size the next 5 trades at 50% of base notional. The rule applies regardless
  // of strategy — non-capitulation strategies just won't typically trigger it.
  let consecLosses = 0;
  let penaltyRemaining = 0;
  const STREAK_LOSS_TRIGGER = 3;
  const STREAK_PENALTY_TRADES = 5;
  const STREAK_SIZE_REDUCTION = 0.5;

  for (let i = 0; i < candles.length; i++) {
    // One-position-at-a-time rule: skip new signals while a position is open.
    if (positionOpen) {
      if (i > positionExitIdx) {
        positionOpen = false;
      } else {
        continue;
      }
    }

    let result;
    try {
      // Pass only candles up to and including index i — no future-data peeking.
      const slice = candles.slice(0, i + 1);
      if (cli.strategy === "momentum") {
        result = evaluateMomentum(slice, cli.symbol, cli.timeframe, cli.momentumParams);
      } else if (cli.strategy === "capitulation") {
        result = evaluateCapitulation(slice, cli.symbol, cli.timeframe);
      } else if (cli.strategy === "funding") {
        if (!fundingContext) throw new Error("funding context not loaded");
        result = evaluateFunding(slice, cli.symbol, cli.timeframe, fundingContext);
      } else if (cli.strategy === "funding-compression") {
        result = evaluateFundingCompression(slice, cli.symbol, cli.timeframe, fundingContext, {
          useFundingFilter: !cli.disableFundingFilter,
          exitOverrides: cli.exitOverrides ?? undefined,
        });
      } else {
        result = evaluateMarketFromCandles(slice, cli.symbol, cli.timeframe, cli.params);
      }
    } catch {
      evalErrors++;
      continue;
    }
    if (!result.recommendation) continue;

    approvedCount++;

    // Apply streak-rule sizing for this trade.
    const inPenalty = penaltyRemaining > 0;
    const tradeNotional = inPenalty
      ? baseCfg.notionalUsd * STREAK_SIZE_REDUCTION
      : baseCfg.notionalUsd;
    const tradeCfg: SimulatorConfig = {
      costBps: baseCfg.costBps,
      notionalUsd: tradeNotional,
      fundingNormalizedAtTime: baseCfg.fundingNormalizedAtTime,
    };
    if (inPenalty) penaltyRemaining -= 1;

    const trade = simulateTrade(result.recommendation, candles, i, tradeCfg);
    trades.push(trade);

    // Update streak counter and possibly start a new penalty window.
    if (trade.outcome === "loss") {
      consecLosses += 1;
      if (consecLosses >= STREAK_LOSS_TRIGGER && penaltyRemaining === 0) {
        penaltyRemaining = STREAK_PENALTY_TRADES;
      }
    } else if (trade.outcome === "win") {
      consecLosses = 0;
    }
    // ambiguous and open outcomes: do not change either counter.

    if (trade.exitIdx != null) {
      positionOpen = true;
      positionExitIdx = trade.exitIdx;
    } else {
      // Open at end of data — block any further entries.
      positionOpen = true;
      positionExitIdx = candles.length;
    }

    if (approvedCount % 25 === 0) {
      console.log(`  ${approvedCount} trades simulated (bar ${i + 1}/${candles.length})`);
    }
  }

  console.log(`Approved recommendations: ${approvedCount}`);
  if (evalErrors > 0) console.log(`Evaluation errors (skipped): ${evalErrors}`);

  const metrics = computeMetrics(trades);
  const ctx: ReportContext = {
    symbol: cli.symbol,
    timeframe: cli.timeframe,
    inputFile: cli.file,
    candleCount: candles.length,
    costBps: cli.costBps,
    notionalUsd: cli.notionalUsd,
    startTime: candles[0]?.timestamp ?? null,
    endTime: candles[candles.length - 1]?.timestamp ?? null,
    evalErrors,
  };

  writeReports(cli.out, trades, metrics, ctx);
  console.log(`\nReports written to ${cli.out}/`);
  console.log(`  - backtest-trades.csv`);
  console.log(`  - backtest-report.json`);
  console.log(`  - backtest-report.md`);

  // Funding-strategy: emit per-window distribution stats (gate 5 evidence).
  if (cli.strategy === "funding" && fundingContext) {
    const series = fundingContext.cum7dSeries;
    const events = fundingContext.events;
    const startMs = candles[0]?.timestamp ?? 0;
    const endMs = candles[candles.length - 1]?.timestamp ?? 0;
    const stats: { fundingTime: string; cum7d: number; p5: number; p50: number; p10: number; spread_p50_minus_p5: number }[] = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i].timestamp < startMs || events[i].timestamp > endMs) continue;
      const r = rollingPercentile(series, i);
      if (!r) continue;
      const sorted = r.sortedAscending;
      const p5 = sorted[Math.floor(sorted.length * 0.05)];
      const p10 = sorted[Math.floor(sorted.length * 0.10)];
      const p50 = sorted[Math.floor(sorted.length * 0.50)];
      stats.push({
        fundingTime: new Date(events[i].timestamp).toISOString(),
        cum7d: series[i],
        p5,
        p10,
        p50,
        spread_p50_minus_p5: p50 - p5,
      });
    }
    if (stats.length > 0) {
      const spreads = stats.map((s) => s.spread_p50_minus_p5);
      const minSpread = Math.min(...spreads);
      const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
      const summary = {
        windowsEvaluated: stats.length,
        firstWindow: stats[0].fundingTime,
        lastWindow: stats[stats.length - 1].fundingTime,
        minSpread_p50_minus_p5: minSpread,
        meanSpread_p50_minus_p5: meanSpread,
        // Gate 5 mechanical check: distribution must contain extreme tails
        // throughout. Operationalized as: minimum spread between p50 and p5
        // strictly greater than zero (i.e., the distribution is never flat).
        gate5_distributionTailsPresent: minSpread > 0,
      };
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      fs.writeFileSync(path.join(cli.out, "funding-distribution-stats.json"),
        JSON.stringify({ summary, perWindow: stats }, null, 2));
      console.log(`  - funding-distribution-stats.json`);
      console.log(
        `\nFunding distribution: ${stats.length} windows | min(p50-p5)=${minSpread.toExponential(3)} | mean(p50-p5)=${meanSpread.toExponential(3)} | gate5 tails-present=${summary.gate5_distributionTailsPresent ? "PASS" : "FAIL"}`,
      );
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(
    `Trades: ${metrics.totalTrades} (${metrics.wins}W / ${metrics.losses}L / ${metrics.ambiguous} ambiguous / ${metrics.open} open)`,
  );
  console.log(
    `Win rate:        ${metrics.winRate != null ? (metrics.winRate * 100).toFixed(1) + "%" : "—"}`,
  );
  console.log(
    `Realized R:R:    ${metrics.realizedRR != null ? metrics.realizedRR.toFixed(2) + " : 1" : "—"}`,
  );
  console.log(
    `Expectancy:      ${metrics.expectancyPct != null ? metrics.expectancyPct.toFixed(3) + "% / " : ""}` +
      `${metrics.expectancyUsd != null ? "$" + metrics.expectancyUsd.toFixed(3) + "/trade" : "—"}`,
  );
  console.log(
    `Net P/L:         ${metrics.netPnlPct.toFixed(2)}% / ${metrics.netPnlUsd >= 0 ? "+" : "−"}$${Math.abs(metrics.netPnlUsd).toFixed(2)}`,
  );
  console.log(
    `Profit factor:   ${metrics.profitFactor != null ? metrics.profitFactor.toFixed(2) : "—"}`,
  );
  console.log(
    `Max drawdown:    $${metrics.maxDrawdownUsd.toFixed(2)} (${metrics.maxDrawdownPct.toFixed(2)}%)`,
  );

  if (metrics.ambiguous / Math.max(1, metrics.wins + metrics.losses + metrics.ambiguous) > 0.1) {
    console.log(
      `\n⚠ Ambiguous-trade ratio is high (${metrics.ambiguous} of ${
        metrics.wins + metrics.losses + metrics.ambiguous
      }). The timeframe is likely too coarse for trustworthy outcomes — try a finer one.`,
    );
  }
}

try {
  run();
} catch (err) {
  console.error("Backtest failed:", err instanceof Error ? err.message : err);
  process.exit(1);
}
