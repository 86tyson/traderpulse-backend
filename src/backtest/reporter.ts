// src/backtest/reporter.ts
//
// Writes three artifacts side-by-side in the chosen output directory:
//   - backtest-trades.csv    one row per trade (machine-readable)
//   - backtest-report.json   full dump (context + metrics + trades + equity curve)
//   - backtest-report.md     scannable summary with the load-bearing caveats
//
// Files are overwritten on each run. Caller is responsible for archiving if needed.

import * as fs from "fs";
import * as path from "path";
import type { BacktestTrade } from "./simulator";
import type { BacktestMetrics } from "./metrics";

export interface ReportContext {
  symbol: string;
  timeframe: string;
  inputFile: string;
  candleCount: number;
  costBps: number;
  notionalUsd: number;
  startTime: number | null;
  endTime: number | null;
  evalErrors: number;
}

export function writeReports(
  outDir: string,
  trades: BacktestTrade[],
  metrics: BacktestMetrics,
  ctx: ReportContext,
): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "backtest-trades.csv"), tradesToCsv(trades));
  fs.writeFileSync(
    path.join(outDir, "backtest-report.json"),
    JSON.stringify({ context: ctx, metrics, trades }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "backtest-report.md"), tradesToMd(trades, metrics, ctx));
}

// ---- CSV ----

const CSV_COLUMNS = [
  "index",
  "recommendation_id",
  "symbol",
  "side",
  "confidence",
  "entry_time",
  "exit_time",
  "entry_price",
  "stop_loss",
  "profit_target",
  "exit_price",
  "outcome",
  "pnl_pct_gross",
  "pnl_pct_net",
  "pnl_usd",
  "r_realized",
  "holding_bars",
  "planned_rr",
] as const;

function tradesToCsv(trades: BacktestTrade[]): string {
  const rows = trades.map((t, i) =>
    [
      i + 1,
      t.recommendationId,
      t.symbol,
      t.side,
      t.confidence,
      isoOrEmpty(t.entryTime),
      isoOrEmpty(t.exitTime),
      t.entryPrice,
      t.stopLoss,
      t.profitTarget,
      t.exitPrice ?? "",
      t.outcome,
      t.pnlPctGross ?? "",
      t.pnlPctNet ?? "",
      t.pnlUsd ?? "",
      t.rRealized ?? "",
      t.holdingBars ?? "",
      t.riskRewardPlanned,
    ].join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}

// ---- Markdown ----

function tradesToMd(trades: BacktestTrade[], m: BacktestMetrics, ctx: ReportContext): string {
  const fmtPct  = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)}%`);
  const fmtUsd  = (n: number | null) => (n == null ? "—" : `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(2)}`);
  const fmtNum  = (n: number | null) => (n == null ? "—" : n.toFixed(2));
  const fmtRR   = (n: number | null) => (n == null ? "—" : `${n.toFixed(2)} : 1`);
  const fmtRate = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
  const dateOnly = (ms: number | null) => (ms == null ? "?" : new Date(ms).toISOString().slice(0, 10));

  const dataRange =
    ctx.startTime && ctx.endTime
      ? `${dateOnly(ctx.startTime)} → ${dateOnly(ctx.endTime)}`
      : "?";

  const head =
    "| # | Entry time (UTC) | Symbol | Outcome | Net % | USD | Bars |\n" +
    "|---|---|---|---|---|---|---|";

  const tradeRow = (t: BacktestTrade, i: number) =>
    "| " +
    [
      i + 1,
      isoOrEmpty(t.entryTime).slice(0, 16).replace("T", " "),
      t.symbol,
      t.outcome,
      t.pnlPctNet != null ? t.pnlPctNet.toFixed(2) : "—",
      t.pnlUsd != null ? `$${t.pnlUsd.toFixed(2)}` : "—",
      t.holdingBars ?? "—",
    ].join(" | ") +
    " |";

  const tradesList =
    trades.length === 0
      ? "_No trades._"
      : trades.length <= 20
      ? `${head}\n${trades.map(tradeRow).join("\n")}`
      : `### First 10\n\n${head}\n${trades.slice(0, 10).map(tradeRow).join("\n")}\n\n` +
        `### Last 10\n\n${head}\n${trades.slice(-10).map((t, i) => tradeRow(t, trades.length - 10 + i)).join("\n")}`;

  return `# Backtest report

| Field | Value |
|---|---|
| Symbol | ${ctx.symbol} |
| Timeframe | ${ctx.timeframe} |
| Input file | \`${ctx.inputFile}\` |
| Candles | ${ctx.candleCount.toLocaleString()} |
| Date range | ${dataRange} |
| Cost (round-trip) | ${ctx.costBps} bps |
| Position notional | $${ctx.notionalUsd} |
| Evaluation errors (skipped bars) | ${ctx.evalErrors} |

## Summary

| Metric | Value |
|---|---|
| Total trades | ${m.totalTrades} |
| Wins | ${m.wins} |
| Losses | ${m.losses} |
| Ambiguous (same-bar stop+target) | ${m.ambiguous} |
| Open at end of data | ${m.open} |
| Win rate | ${fmtRate(m.winRate)} |
| Avg win | ${fmtPct(m.avgWinPct)} |
| Avg loss | ${fmtPct(m.avgLossPct)} |
| Realized R:R | ${fmtRR(m.realizedRR)} |
| Expectancy (per closed trade) | ${fmtPct(m.expectancyPct)} / ${fmtUsd(m.expectancyUsd)} |
| Net P/L | ${fmtPct(m.netPnlPct)} / ${fmtUsd(m.netPnlUsd)} |
| Profit factor | ${fmtNum(m.profitFactor)} |
| Max drawdown | ${m.maxDrawdownPct.toFixed(2)}% / ${fmtUsd(m.maxDrawdownUsd)} |
| Best trade | ${fmtPct(m.bestTradePct)} |
| Worst trade | ${fmtPct(m.worstTradePct)} |
| Avg holding | ${fmtNum(m.avgHoldingBars)} bars |

## Caveats — read before drawing conclusions

- **Realized R:R will sit near 1.5 by construction.** The strategy places a flat 2 % stop and 3 % target on every trade regardless of S/R structure. A 1.5 R:R is an arithmetic artifact, not evidence of edge. The number to watch is **win rate** and **expectancy** instead.
- **Ambiguous trades are excluded from win/loss counts.** If \`ambiguous / (wins + losses + ambiguous) > 10 %\`, the timeframe is too coarse for trustworthy results — drop to a finer timeframe.
- **Open trades are excluded** from win/loss/expectancy. They have no settled outcome.
- **Cost haircut is a flat ${ctx.costBps} bps round-trip** applied to every closed trade. This stands in for spread + slippage + fees. Real fills will diverge.
- **Strategy is BUY-only.** Sustained downtrends will produce few or no trades — this is correct behavior, not a bug.
- **One position at a time.** New signals fired while a position is open are skipped. This avoids double-counting and matches realistic single-position trading.
- **Drawdown % uses a rough denominator** (max of peak equity, trough magnitude, $1). It is a directional indicator, not a precise account-equity drawdown.

## Trades

${tradesList}
`;
}

function isoOrEmpty(ms: number | null): string {
  if (ms == null) return "";
  return new Date(ms).toISOString();
}
