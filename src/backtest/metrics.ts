// src/backtest/metrics.ts
//
// Compute aggregate metrics from a list of simulated trades.
//
// Win-rate denominator excludes ambiguous + open trades — those are reported
// separately so the user can see if they meaningfully affect interpretation.
// Drawdown is computed on the closed-trade equity curve (USD), peak-to-trough.

import type { BacktestTrade } from "./simulator";

export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  ambiguous: number;
  open: number;

  winRate: number | null;             // wins / (wins + losses)
  avgWinPct: number | null;
  avgLossPct: number | null;          // sign-preserved (negative)
  realizedRR: number | null;          // |avgWin / avgLoss|
  expectancyPct: number | null;       // mean net % per closed trade
  expectancyUsd: number | null;       // mean net USD per closed trade

  netPnlPct: number;                  // sum of net % over closed trades
  netPnlUsd: number;                  // sum of net USD over closed trades

  profitFactor: number | null;        // gross wins / |gross losses|
  maxDrawdownUsd: number;
  maxDrawdownPct: number;             // % of peak equity (or notional fallback)

  bestTradePct: number | null;
  worstTradePct: number | null;
  avgHoldingBars: number | null;

  /** Cumulative USD P/L after each closed trade (in chronological trade order). */
  equityCurveUsd: number[];
}

export function computeMetrics(trades: BacktestTrade[]): BacktestMetrics {
  const wins      = trades.filter((t) => t.outcome === "win");
  const losses    = trades.filter((t) => t.outcome === "loss");
  const ambiguous = trades.filter((t) => t.outcome === "ambiguous");
  const open      = trades.filter((t) => t.outcome === "open");
  const closed    = [...wins, ...losses].sort((a, b) => a.entryIdx - b.entryIdx);

  const winRate = wins.length + losses.length > 0
    ? wins.length / (wins.length + losses.length)
    : null;

  const avgWinPct  = wins.length   > 0 ? avg(wins.map((t)   => t.pnlPctNet ?? 0)) : null;
  const avgLossPct = losses.length > 0 ? avg(losses.map((t) => t.pnlPctNet ?? 0)) : null;

  const realizedRR =
    avgWinPct != null && avgLossPct != null && avgLossPct !== 0
      ? Math.abs(avgWinPct / avgLossPct)
      : null;

  const netPnlPct = sum(closed.map((t) => t.pnlPctNet ?? 0));
  const netPnlUsd = sum(closed.map((t) => t.pnlUsd ?? 0));

  const expectancyPct = closed.length > 0 ? netPnlPct / closed.length : null;
  const expectancyUsd = closed.length > 0 ? netPnlUsd / closed.length : null;

  const grossWinUsd  = sum(wins.map((t)   => t.pnlUsd ?? 0));
  const grossLossUsd = Math.abs(sum(losses.map((t) => t.pnlUsd ?? 0)));
  const profitFactor = grossLossUsd > 0 ? grossWinUsd / grossLossUsd : null;

  // Equity curve and drawdown (USD).
  const equityCurveUsd: number[] = [];
  let running = 0;
  for (const t of closed) {
    running += t.pnlUsd ?? 0;
    equityCurveUsd.push(round(running, 4));
  }
  let peak = 0;
  let maxDdUsd = 0;
  for (const v of equityCurveUsd) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDdUsd) maxDdUsd = dd;
  }
  // % drawdown is undefined without an account-balance baseline. Use:
  //   max(peak, |trough|, 1) as denominator. This is rough — see BACKTESTING.md.
  const trough = equityCurveUsd.length > 0 ? Math.min(...equityCurveUsd) : 0;
  const denom = Math.max(Math.abs(peak), Math.abs(Math.min(0, trough)), 1);
  const maxDdPct = (maxDdUsd / denom) * 100;

  const bestTradePct  = closed.length > 0 ? Math.max(...closed.map((t) => t.pnlPctNet ?? -Infinity)) : null;
  const worstTradePct = closed.length > 0 ? Math.min(...closed.map((t) => t.pnlPctNet ??  Infinity)) : null;

  const holdings = closed
    .map((t) => t.holdingBars)
    .filter((n): n is number => n != null);
  const avgHoldingBars = holdings.length > 0 ? avg(holdings) : null;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    ambiguous: ambiguous.length,
    open: open.length,
    winRate,
    avgWinPct:  finiteOrNull(avgWinPct),
    avgLossPct: finiteOrNull(avgLossPct),
    realizedRR,
    expectancyPct,
    expectancyUsd,
    netPnlPct: round(netPnlPct, 4),
    netPnlUsd: round(netPnlUsd, 4),
    profitFactor,
    maxDrawdownUsd: round(maxDdUsd, 4),
    maxDrawdownPct: round(maxDdPct, 4),
    bestTradePct:  finiteOrNull(bestTradePct),
    worstTradePct: finiteOrNull(worstTradePct),
    avgHoldingBars,
    equityCurveUsd,
  };
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function avg(xs: number[]): number {
  return xs.length === 0 ? NaN : sum(xs) / xs.length;
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function finiteOrNull(n: number | null): number | null {
  if (n == null) return null;
  return Number.isFinite(n) ? n : null;
}
