// scripts/rollingWindowEth1d.ts
//
// Rolling-window stability test of ETH 1d compression-breakout (NR7 + regime).
// 2-year window, 6-month step, no funding filter, default cost 30 bps.
//
// Reuses existing strategy + simulator + metrics modules verbatim.

import { loadCandles } from "../src/backtest/loadCandles";
import { evaluateFundingCompression } from "../src/lib/trading/fundingCompressionStrategy";
import { simulateTrade, type BacktestTrade, type SimulatorConfig } from "../src/backtest/simulator";
import { computeMetrics } from "../src/backtest/metrics";

const CANDLES_FILE = process.argv[2] ?? "data/eth-1d-max.csv";
const COST_BPS = Number(process.argv[3] ?? "30");
const WINDOW_DAYS = 730;   // 2 years
const STEP_DAYS = 182;     // ~6 months
const NOTIONAL = 25;

function runWindow(slice: ReturnType<typeof loadCandles>) {
  const trades: BacktestTrade[] = [];
  const cfg: SimulatorConfig = { costBps: COST_BPS, notionalUsd: NOTIONAL };
  let positionOpen = false;
  let positionExitIdx = -1;
  for (let i = 0; i < slice.length; i++) {
    if (positionOpen) {
      if (i > positionExitIdx) positionOpen = false;
      else continue;
    }
    let result;
    try {
      result = evaluateFundingCompression(slice.slice(0, i + 1), "ETH", "1d", null, {
        useFundingFilter: false,
      });
    } catch {
      continue;
    }
    if (!result.recommendation) continue;
    const trade = simulateTrade(result.recommendation, slice, i, cfg);
    trades.push(trade);
    if (trade.exitIdx != null) {
      positionOpen = true;
      positionExitIdx = trade.exitIdx;
    } else {
      positionOpen = true;
      positionExitIdx = slice.length;
    }
  }
  return { trades, metrics: computeMetrics(trades) };
}

function main() {
  const candles = loadCandles(CANDLES_FILE);
  console.log(`Source: ${CANDLES_FILE} (${candles.length} bars)`);
  console.log(`First: ${new Date(candles[0].timestamp).toISOString().slice(0, 10)}`);
  console.log(`Last:  ${new Date(candles[candles.length - 1].timestamp).toISOString().slice(0, 10)}`);
  console.log(`Window: ${WINDOW_DAYS} bars (~${(WINDOW_DAYS / 365).toFixed(1)} years), step: ${STEP_DAYS} bars (~${(STEP_DAYS / 30).toFixed(1)} months)`);
  console.log(`Cost: ${COST_BPS} bps, notional: $${NOTIONAL}`);
  console.log("");

  const windows: { start: number; end: number }[] = [];
  for (let s = 0; s + WINDOW_DAYS <= candles.length; s += STEP_DAYS) {
    windows.push({ start: s, end: s + WINDOW_DAYS });
  }
  console.log(`# of windows: ${windows.length}\n`);

  console.log(
    "win | start      | end        | trades | wins | losses | winRate | exp/trade | netUsd | PF    | maxDD",
  );
  console.log("----+------------+------------+--------+------+--------+---------+-----------+---------+-------+--------");

  const perWindow: Array<{
    idx: number;
    startDate: string;
    endDate: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    expectancyUsd: number | null;
    netPnlUsd: number;
    profitFactor: number | null;
    maxDrawdownUsd: number;
  }> = [];

  windows.forEach((w, idx) => {
    const slice = candles.slice(w.start, w.end);
    const { metrics } = runWindow(slice);
    const startDate = new Date(slice[0].timestamp).toISOString().slice(0, 10);
    const endDate = new Date(slice[slice.length - 1].timestamp).toISOString().slice(0, 10);
    const exp = metrics.expectancyUsd;
    const wr = metrics.winRate;
    const pf = metrics.profitFactor;
    perWindow.push({
      idx: idx + 1,
      startDate,
      endDate,
      trades: metrics.totalTrades,
      wins: metrics.wins,
      losses: metrics.losses,
      winRate: wr,
      expectancyUsd: exp,
      netPnlUsd: metrics.netPnlUsd,
      profitFactor: pf,
      maxDrawdownUsd: metrics.maxDrawdownUsd,
    });
    console.log(
      `${String(idx + 1).padStart(3)} | ${startDate} | ${endDate} | ${String(metrics.totalTrades).padStart(6)} | ${String(metrics.wins).padStart(4)} | ${String(metrics.losses).padStart(6)} | ${wr == null ? "    —    " : ((wr * 100).toFixed(1) + "%").padStart(8)} | ${exp == null ? "    —    " : ((exp >= 0 ? "+" : "") + "$" + exp.toFixed(3)).padStart(9)} | ${(metrics.netPnlUsd >= 0 ? "+" : "") + "$" + metrics.netPnlUsd.toFixed(2).padStart(6)} | ${pf == null ? "  —  " : pf.toFixed(2).padStart(5)} | ${"$" + metrics.maxDrawdownUsd.toFixed(2).padStart(6)}`,
    );
  });

  // ----- Aggregate -----
  console.log("\n=== Aggregate ===");
  const validExp = perWindow.filter((w) => w.expectancyUsd != null) as Array<typeof perWindow[number] & { expectancyUsd: number }>;
  const positiveExp = validExp.filter((w) => w.expectancyUsd > 0);
  const negativeExp = validExp.filter((w) => w.expectancyUsd < 0);
  const zeroOrUndef = perWindow.length - validExp.length;

  const expValues = validExp.map((w) => w.expectancyUsd);
  const avgExp = expValues.length > 0 ? expValues.reduce((a, b) => a + b, 0) / expValues.length : null;
  const minExp = expValues.length > 0 ? Math.min(...expValues) : null;
  const maxExp = expValues.length > 0 ? Math.max(...expValues) : null;

  const sortedExp = [...expValues].sort((a, b) => a - b);
  const median = sortedExp.length > 0 ? sortedExp[Math.floor(sortedExp.length / 2)] : null;

  const totalTrades = perWindow.reduce((a, w) => a + w.trades, 0);
  const totalWins = perWindow.reduce((a, w) => a + w.wins, 0);
  const totalLosses = perWindow.reduce((a, w) => a + w.losses, 0);

  console.log(`Total windows:                 ${perWindow.length}`);
  console.log(`Windows with positive exp:     ${positiveExp.length} (${((positiveExp.length / perWindow.length) * 100).toFixed(0)}%)`);
  console.log(`Windows with negative exp:     ${negativeExp.length} (${((negativeExp.length / perWindow.length) * 100).toFixed(0)}%)`);
  console.log(`Windows with no closed trades: ${zeroOrUndef}`);
  console.log(``);
  console.log(`Average expectancy / trade:    ${avgExp == null ? "—" : (avgExp >= 0 ? "+" : "") + "$" + avgExp.toFixed(3)}`);
  console.log(`Median expectancy / trade:     ${median == null ? "—" : (median >= 0 ? "+" : "") + "$" + median.toFixed(3)}`);
  console.log(`Worst-case (min) expectancy:   ${minExp == null ? "—" : (minExp >= 0 ? "+" : "") + "$" + minExp.toFixed(3)}`);
  console.log(`Best-case (max) expectancy:    ${maxExp == null ? "—" : (maxExp >= 0 ? "+" : "") + "$" + maxExp.toFixed(3)}`);
  console.log(``);
  console.log(`Aggregate trades across windows (note: windows OVERLAP, so this double-counts):`);
  console.log(`  Total trades: ${totalTrades}, wins: ${totalWins}, losses: ${totalLosses}`);
  console.log(`  Aggregate WR: ${totalWins + totalLosses > 0 ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(1) + "%" : "—"}`);
}

main();
