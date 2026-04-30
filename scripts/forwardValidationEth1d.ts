// scripts/forwardValidationEth1d.ts
//
// Forward-validation runner for ETH 1D Compression Breakout.
//
// HARD GUARANTEES (do not edit without re-locking the spec):
//   - Strategy code (src/lib/trading/fundingCompressionStrategy.ts) is NOT modified.
//   - No filters added. No parameters tuned. No optimization.
//   - PAPER ONLY. No Robinhood connection. No live order placement of any kind.
//
// Idempotent and deterministic: re-running on the same input produces the same output.
//
// Run daily after the UTC daily candle closes:
//   npx tsx scripts/forwardValidationEth1d.ts
//
// On each run:
//   1. Pulls latest ETH-USD daily bars from Coinbase Exchange public API (no auth).
//      Appends new bars to data/eth-1d-max.csv.
//   2. Walks the locked compression-breakout strategy + staged-r-trail simulator
//      from FORWARD_VALIDATION_START_ISO with FRESH STATE (no carry-over positions).
//   3. Writes:
//        - data/forward-validation-eth-1d-log.csv     (per-bar daily decision log)
//        - data/forward-validation-eth-1d-state.json  (current open/closed snapshot)
//        - FORWARD_VALIDATION_ETH_1D.md                (human-readable report)

import * as fs from "fs";
import { loadCandles } from "../src/backtest/loadCandles";
import { evaluateFundingCompression } from "../src/lib/trading/fundingCompressionStrategy";
import {
  simulateTrade,
  type BacktestTrade,
  type SimulatorConfig,
} from "../src/backtest/simulator";

// ============================================================================
// LOCKED CONFIG — DO NOT EDIT after first deployment.
// Re-locking requires explicit user approval and a new validation window.
// ============================================================================
const FORWARD_VALIDATION_START_ISO = "2026-04-30T00:00:00.000Z"; // bars on/after this date
const CANDLES_FILE = "data/eth-1d-max.csv";
const STATE_FILE = "data/forward-validation-eth-1d-state.json";
const LOG_FILE = "data/forward-validation-eth-1d-log.csv";
const REPORT_FILE = "FORWARD_VALIDATION_ETH_1D.md";
// Compact, frontend-optimized snapshot consumed by GET /forward/latest.
const LATEST_JSON_FILE = "data/forward/latest.json";
const COST_BPS = 30;
const NOTIONAL_USD = 25;

// ============================================================================
// Coinbase Exchange public-endpoint daily-bar fetch (idempotent CSV update).
// ============================================================================
const COINBASE_BASE = "https://api.exchange.coinbase.com";
const SYMBOL = "ETH-USD";
const GRANULARITY_SEC = 86400; // 1d
const PAGE_SIZE = 300;
const FETCH_TIMEOUT_MS = 15_000;
const RATE_LIMIT_DELAY_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchCoinbasePage(startSec: number, endSec: number): Promise<number[][]> {
  const url =
    `${COINBASE_BASE}/products/${SYMBOL}/candles` +
    `?granularity=${GRANULARITY_SEC}` +
    `&start=${new Date(startSec * 1000).toISOString()}` +
    `&end=${new Date(endSec * 1000).toISOString()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "forward-validation-eth-1d/1.0" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Coinbase ${res.status} ${res.statusText}`);
  const arr = (await res.json()) as number[][];
  if (!Array.isArray(arr)) throw new Error("Coinbase returned non-array body");
  return arr;
}

async function updateCandlesCsv(): Promise<void> {
  if (!fs.existsSync(CANDLES_FILE)) {
    throw new Error(
      `${CANDLES_FILE} missing — initialize first via scripts/downloadCoinbaseHistorical.js or manually.`,
    );
  }
  const existing = loadCandles(CANDLES_FILE);
  const lastTs = existing[existing.length - 1].timestamp;
  const lastIso = new Date(lastTs).toISOString().slice(0, 10);

  const nowSec = Math.floor(Date.now() / 1000);
  const lastClosedBarOpenSec = nowSec - (nowSec % GRANULARITY_SEC) - GRANULARITY_SEC;

  if (Math.floor(lastTs / 1000) >= lastClosedBarOpenSec) {
    console.log(`CSV already up to date (last bar: ${lastIso}).`);
    return;
  }

  const startSec = Math.floor(lastTs / 1000) + GRANULARITY_SEC;
  const endSec = lastClosedBarOpenSec + GRANULARITY_SEC; // Coinbase end is exclusive of next bar
  console.log(
    `Fetching ETH-USD 1d bars from Coinbase: ${new Date(startSec * 1000)
      .toISOString()
      .slice(0, 10)} → ${new Date(endSec * 1000).toISOString().slice(0, 10)} ...`,
  );

  const bucket = new Map<number, number[]>();
  let cursorEnd = endSec;
  while (cursorEnd > startSec) {
    const cursorStart = Math.max(startSec, cursorEnd - GRANULARITY_SEC * PAGE_SIZE);
    const page = await fetchCoinbasePage(cursorStart, cursorEnd);
    if (page.length === 0) break;
    for (const k of page) {
      // [time(s), low, high, open, close, volume]
      if (k[0] * 1000 > lastTs) bucket.set(k[0], k);
    }
    cursorEnd = cursorStart;
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  const toAppend = [...bucket.values()].sort((a, b) => a[0] - b[0]);
  if (toAppend.length === 0) {
    console.log("Coinbase returned no new bars after dedupe.");
    return;
  }

  const lines: string[] = [];
  for (const k of toAppend) {
    const tsIso = new Date(k[0] * 1000).toISOString();
    // CSV format: timestamp,open,high,low,close,volume
    lines.push([tsIso, k[3], k[2], k[1], k[4], k[5]].join(","));
  }
  fs.appendFileSync(CANDLES_FILE, lines.join("\n") + "\n");
  console.log(
    `Appended ${toAppend.length} new bar(s); newest = ${new Date(
      toAppend[toAppend.length - 1][0] * 1000,
    )
      .toISOString()
      .slice(0, 10)}.`,
  );
}

// ============================================================================
// Strategy walk — FORWARD-ONLY ENTRIES.
//   - Walks every bar so the strategy has full history for indicator computation.
//   - But only OPENS positions when the bar's timestamp >= forwardStartTs.
//   - State (positionOpen, exitIdx) starts fresh at the forward-window boundary.
// ============================================================================
function walkForwardOnly(
  candles: ReturnType<typeof loadCandles>,
  forwardStartTs: number,
): BacktestTrade[] {
  const cfg: SimulatorConfig = { costBps: COST_BPS, notionalUsd: NOTIONAL_USD };
  const trades: BacktestTrade[] = [];
  let positionOpen = false;
  let positionExitIdx = -1;

  for (let i = 0; i < candles.length; i++) {
    if (positionOpen) {
      if (i > positionExitIdx) positionOpen = false;
      else continue;
    }
    if (candles[i].timestamp < forwardStartTs) continue;

    let result;
    try {
      result = evaluateFundingCompression(candles.slice(0, i + 1), "ETH", "1d", null, {
        useFundingFilter: false,
      });
    } catch {
      continue;
    }
    if (!result.recommendation) continue;

    const trade = simulateTrade(result.recommendation, candles, i, cfg);
    trades.push(trade);
    positionOpen = true;
    positionExitIdx = trade.exitIdx ?? candles.length;
  }
  return trades;
}

// ============================================================================
// Per-bar daily-decision log.
// ============================================================================
type Classification =
  | "no-signal"
  | "signal-trade-opened"
  | "position-open-no-action"
  | "trade-closed-today";

interface DailyDecision {
  dateIso: string;
  closePrice: number;
  classification: Classification;
  signal: boolean;
  entryPrice: number | null;
  stopLoss: number | null;
  profitTarget: number | null;
  exitCondition: string | null;
  positionOpen: boolean;
  unrealizedPnlUsd: number | null;
  realizedPnlUsd: number | null;
  notes: string;
}

function classifyExit(t: BacktestTrade): string {
  if (t.exitPrice == null) return "open";
  if (t.exitPrice >= t.profitTarget - 1e-6) return "profit-target-hit";
  if (t.holdingBars != null && t.holdingBars >= 48) return "time-stop-48d";
  // Check breakeven band BEFORE "trail-locked-profit": a BE-promoted stop hit
  // exits exactly at entry, which would otherwise misclassify as a trailing win.
  if (Math.abs(t.exitPrice - t.entryPrice) <= t.entryPrice * 0.001) {
    return "stopped-at-breakeven";
  }
  if (t.exitPrice > t.entryPrice) return "trail-locked-profit";
  return "initial-stop-hit";
}

function buildDailyLog(
  candles: ReturnType<typeof loadCandles>,
  trades: BacktestTrade[],
  forwardStartTs: number,
): DailyDecision[] {
  const log: DailyDecision[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.timestamp < forwardStartTs) continue;

    const dateIso = new Date(c.timestamp).toISOString().slice(0, 10);
    const close = c.close;

    const tradeOpenedHere = trades.find((t) => t.entryIdx === i);
    const tradeClosedHere = trades.find((t) => t.exitIdx === i);
    const tradeStillOpenHere = trades.find(
      (t) =>
        t.entryIdx < i &&
        ((t.exitIdx == null && i === candles.length - 1 && t.exitTime == null) ||
          (t.exitIdx != null && t.exitIdx > i)),
    );

    let classification: Classification = "no-signal";
    let signal = false;
    let entryPrice: number | null = null;
    let stopLoss: number | null = null;
    let profitTarget: number | null = null;
    let exitCondition: string | null = null;
    let positionOpen = false;
    let unrealizedPnlUsd: number | null = null;
    let realizedPnlUsd: number | null = null;
    let notes = "";

    if (tradeOpenedHere) {
      classification = "signal-trade-opened";
      signal = true;
      entryPrice = tradeOpenedHere.entryPrice;
      stopLoss = tradeOpenedHere.stopLoss;
      profitTarget = tradeOpenedHere.profitTarget;
      positionOpen = tradeOpenedHere.exitIdx !== i;
      unrealizedPnlUsd = round(
        ((close - entryPrice) / entryPrice) * NOTIONAL_USD,
        4,
      );
      notes =
        `Entry triggered (NR7 compression breakout, MA50 regime up). ` +
        `Stop=$${stopLoss.toFixed(2)} (R=$${(entryPrice - stopLoss).toFixed(2)}). ` +
        `Exit plan: staged-r-trail (BE@1R, prior-bar-low trail from 2R, time-stop=48d).`;
    } else if (tradeClosedHere) {
      classification = "trade-closed-today";
      positionOpen = false;
      entryPrice = tradeClosedHere.entryPrice;
      realizedPnlUsd = tradeClosedHere.pnlUsd ?? null;
      exitCondition = classifyExit(tradeClosedHere);
      notes =
        `Trade closed. Outcome=${tradeClosedHere.outcome}. ` +
        `R=${tradeClosedHere.rRealized?.toFixed(2) ?? "—"}. ` +
        `Held ${tradeClosedHere.holdingBars ?? "—"} bars. ` +
        `Exit reason: ${exitCondition}.`;
    } else if (tradeStillOpenHere) {
      classification = "position-open-no-action";
      positionOpen = true;
      entryPrice = tradeStillOpenHere.entryPrice;
      stopLoss = tradeStillOpenHere.stopLoss;
      profitTarget = tradeStillOpenHere.profitTarget;
      unrealizedPnlUsd = round(
        ((close - entryPrice) / entryPrice) * NOTIONAL_USD,
        4,
      );
      notes = `Position open (entered ${new Date(tradeStillOpenHere.entryTime)
        .toISOString()
        .slice(0, 10)} @ $${entryPrice.toFixed(2)}). Mark-to-market at today's close.`;
    } else {
      classification = "no-signal";
      notes = "No compression-breakout signal today.";
    }

    log.push({
      dateIso,
      closePrice: round(close, 2),
      classification,
      signal,
      entryPrice,
      stopLoss,
      profitTarget,
      exitCondition,
      positionOpen,
      unrealizedPnlUsd,
      realizedPnlUsd,
      notes,
    });
  }

  return log;
}

// ============================================================================
// File writers.
// ============================================================================
function writeDailyLogCsv(log: DailyDecision[]): void {
  const headers = [
    "dateIso",
    "closePrice",
    "classification",
    "signal",
    "entryPrice",
    "stopLoss",
    "profitTarget",
    "exitCondition",
    "positionOpen",
    "unrealizedPnlUsd",
    "realizedPnlUsd",
    "notes",
  ];
  const lines = [headers.join(",")];
  for (const r of log) {
    lines.push(
      [
        r.dateIso,
        r.closePrice,
        r.classification,
        r.signal,
        r.entryPrice ?? "",
        r.stopLoss ?? "",
        r.profitTarget ?? "",
        r.exitCondition ?? "",
        r.positionOpen,
        r.unrealizedPnlUsd ?? "",
        r.realizedPnlUsd ?? "",
        `"${r.notes.replace(/"/g, '""')}"`,
      ].join(","),
    );
  }
  fs.writeFileSync(LOG_FILE, lines.join("\n") + "\n");
}

function writeStateJson(
  forwardStartIso: string,
  lastCandleIso: string,
  forwardTrades: BacktestTrade[],
  lastClose: number | null,
): void {
  const open = forwardTrades.find((t) => t.exitIdx == null);
  const closed = forwardTrades.filter((t) => t.exitIdx != null);
  const realizedPnl = closed.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);

  const state = {
    schemaVersion: 1,
    lastRunIso: new Date().toISOString(),
    forwardValidationStartIso: forwardStartIso,
    lastCandleIso,
    config: {
      strategy:
        "ETH 1d compression-breakout (NR7 + MA50 regime, no funding filter)",
      strategySource: "src/lib/trading/fundingCompressionStrategy.ts",
      costBps: COST_BPS,
      notionalUsd: NOTIONAL_USD,
      exitPlan: {
        mode: "staged-r-trail",
        bePromoteAtR: 1,
        trailFromR: 2,
        timeStopBars: 48,
      },
      paperMode: true,
      liveTrading: false,
      robinhoodConnected: false,
    },
    summary: {
      totalSignals: forwardTrades.length,
      tradesOpened: forwardTrades.length,
      tradesClosed: closed.length,
      wins: closed.filter((t) => t.outcome === "win").length,
      losses: closed.filter((t) => t.outcome === "loss").length,
      realizedPnlUsd: round(realizedPnl, 4),
      expectancyPerClosedTradeUsd:
        closed.length > 0 ? round(realizedPnl / closed.length, 4) : null,
    },
    openTrade: open
      ? {
          entryDateIso: new Date(open.entryTime).toISOString().slice(0, 10),
          entryPrice: open.entryPrice,
          stopLoss: open.stopLoss,
          profitTarget: open.profitTarget,
          side: open.side,
          rUsd: round(Math.abs(open.entryPrice - open.stopLoss), 4),
          unrealizedPnlAtLastCloseUsd:
            lastClose != null
              ? round(
                  ((lastClose - open.entryPrice) / open.entryPrice) *
                    NOTIONAL_USD,
                  4,
                )
              : null,
        }
      : null,
    closedTrades: closed.map((t) => ({
      entryDateIso: new Date(t.entryTime).toISOString().slice(0, 10),
      entryPrice: t.entryPrice,
      exitDateIso:
        t.exitTime != null
          ? new Date(t.exitTime).toISOString().slice(0, 10)
          : null,
      exitPrice: t.exitPrice,
      exitCondition: classifyExit(t),
      outcome: t.outcome,
      pnlUsd: t.pnlUsd,
      rRealized: t.rRealized,
      holdingBars: t.holdingBars,
    })),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

// ============================================================================
// Compact, frontend-optimized snapshot.
//
// Consumed by GET /forward/latest. Read-only — produced exclusively by this
// script. No strategy logic runs in the frontend; the panel simply renders
// the fields below.
//
// `today.status` semantics:
//   "inactive" — forward window has not started yet (today < lock-in date)
//   "waiting"  — window active, no signal today, no open position
//   "open"     — a position is open at today's close (mark-to-market)
//   "closed"   — a position closed on today's bar
// ============================================================================
function writeLatestJson(
  forwardStartIso: string,
  lastCandleIso: string,
  lastClose: number,
  forwardTrades: BacktestTrade[],
  log: DailyDecision[],
): void {
  const closed = forwardTrades.filter((t) => t.exitIdx != null);
  const open = forwardTrades.find((t) => t.exitIdx == null);
  const wins = closed.filter((t) => t.outcome === "win").length;
  const losses = closed.filter((t) => t.outcome === "loss").length;
  const realizedPnl = closed.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);

  const todayDecision = log.length > 0 ? log[log.length - 1] : null;

  // Map daily-decision classification to a panel-friendly status.
  type Status = "inactive" | "waiting" | "open" | "closed";
  let status: Status;
  let rMultiple: number | null = null;

  if (todayDecision == null) {
    status = "inactive";
  } else if (todayDecision.classification === "trade-closed-today") {
    status = "closed";
    const t = forwardTrades.find(
      (tr) =>
        tr.exitTime != null &&
        new Date(tr.exitTime).toISOString().slice(0, 10) === todayDecision.dateIso,
    );
    rMultiple = t?.rRealized ?? null;
  } else if (
    todayDecision.classification === "signal-trade-opened" ||
    todayDecision.classification === "position-open-no-action"
  ) {
    status = "open";
    if (open) {
      const rUnit = Math.abs(open.entryPrice - open.stopLoss);
      rMultiple =
        rUnit > 0 ? round((lastClose - open.entryPrice) / rUnit, 4) : null;
    }
  } else {
    status = "waiting";
  }

  const latest = {
    schemaVersion: 1,
    lastUpdatedIso: new Date().toISOString(),
    strategy: {
      name: "ETH 1D Compression Breakout",
      source: "src/lib/trading/fundingCompressionStrategy.ts",
      timeframe: "1d",
      symbol: "ETH",
      costBps: COST_BPS,
      notionalUsd: NOTIONAL_USD,
      exitPlan: "staged-r-trail (BE@1R, prior-bar-low trail from 2R, 48-bar time stop)",
    },
    forwardWindow: {
      startIso: forwardStartIso,
      lastCandleIso,
      lastClose: round(lastClose, 2),
      barsElapsed: log.length,
    },
    today: {
      dateIso: todayDecision?.dateIso ?? lastCandleIso,
      status,
      signal: todayDecision?.signal ?? false,
      classification: todayDecision?.classification ?? null,
      entryPrice:
        todayDecision?.entryPrice ?? open?.entryPrice ?? null,
      stopLoss: todayDecision?.stopLoss ?? open?.stopLoss ?? null,
      profitTarget: todayDecision?.profitTarget ?? open?.profitTarget ?? null,
      rMultiple,
      unrealizedPnlUsd: todayDecision?.unrealizedPnlUsd ?? null,
      realizedPnlUsd: todayDecision?.realizedPnlUsd ?? null,
      notes:
        todayDecision?.notes ??
        `Forward validation start (${forwardStartIso.slice(0, 10)}) is in the future. No bar evaluated yet.`,
    },
    openTrade: open
      ? {
          entryDateIso: new Date(open.entryTime).toISOString().slice(0, 10),
          entryPrice: open.entryPrice,
          stopLoss: open.stopLoss,
          profitTarget: open.profitTarget,
          rUsd: round(Math.abs(open.entryPrice - open.stopLoss), 4),
          side: open.side,
        }
      : null,
    summary: {
      totalSignals: forwardTrades.length,
      tradesOpened: forwardTrades.length,
      tradesClosed: closed.length,
      wins,
      losses,
      winRate:
        closed.length > 0 ? round(wins / closed.length, 4) : null,
      realizedPnlUsd: round(realizedPnl, 4),
      expectancyPerTradeUsd:
        closed.length > 0 ? round(realizedPnl / closed.length, 4) : null,
    },
    safety: {
      paperMode: true,
      liveTrading: false,
      robinhoodConnected: false,
    },
  };

  // Ensure directory exists (idempotent).
  const dir = LATEST_JSON_FILE.replace(/\/[^/]+$/, "");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LATEST_JSON_FILE, JSON.stringify(latest, null, 2) + "\n");
}

// ============================================================================
// Markdown report.
// ============================================================================
function writeReport(
  forwardTrades: BacktestTrade[],
  log: DailyDecision[],
  lastCandleIso: string,
): void {
  const closed = forwardTrades
    .filter((t) => t.exitIdx != null)
    .sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));
  const open = forwardTrades.find((t) => t.exitIdx == null);
  const wins = closed.filter((t) => t.outcome === "win").length;
  const losses = closed.filter((t) => t.outcome === "loss").length;
  const realizedPnl = closed.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
  const expectancy = closed.length > 0 ? realizedPnl / closed.length : null;

  // Max drawdown on cumulative realized P/L curve (equity curve over closed trades only).
  let cum = 0,
    peak = 0,
    maxDd = 0;
  for (const t of closed) {
    cum += t.pnlUsd ?? 0;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDd) maxDd = peak - cum;
  }

  const lastClose = log.length > 0 ? log[log.length - 1].closePrice : null;

  const lines: string[] = [];
  lines.push("# Forward Validation — ETH 1D Compression Breakout");
  lines.push("");
  lines.push(
    "**Status: PAPER ONLY.** No Robinhood connection. No live trading. No order placement. " +
      "This document tracks how the locked strategy performs on bars unseen at the time of strategy lock-in.",
  );
  lines.push("");
  lines.push("## Locked configuration");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(
    "| Strategy | ETH 1d compression-breakout (NR7 + daily MA50 regime gate) |",
  );
  lines.push("| Strategy source | `src/lib/trading/fundingCompressionStrategy.ts` (unchanged) |");
  lines.push("| Funding filter | DISABLED (1d TF; locked spec) |");
  lines.push(
    "| Exit plan | staged-r-trail (BE @ 1R, prior-bar-low trail from 2R, time-stop = 48 bars) |",
  );
  lines.push("| Cost (round-trip) | 30 bps |");
  lines.push("| Notional per trade | $25 |");
  lines.push(
    `| Forward validation start | ${FORWARD_VALIDATION_START_ISO.slice(0, 10)} |`,
  );
  lines.push(`| Last evaluated candle | ${lastCandleIso} |`);
  lines.push(
    `| Forward bars elapsed | ${log.length} |`,
  );
  lines.push("");

  lines.push("## Tracked metrics (forward-only — bars on/after lock-in)");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Total signals | ${forwardTrades.length} |`);
  lines.push(`| Trades opened | ${forwardTrades.length} |`);
  lines.push(`| Trades closed | ${closed.length} |`);
  lines.push(`| Wins | ${wins} |`);
  lines.push(`| Losses | ${losses} |`);
  lines.push(
    `| Win rate | ${
      closed.length > 0
        ? ((wins / closed.length) * 100).toFixed(1) + "%"
        : "—"
    } |`,
  );
  lines.push(
    `| Realized P/L | ${
      closed.length > 0 ? "$" + realizedPnl.toFixed(2) : "—"
    } |`,
  );
  lines.push(
    `| Expectancy / closed trade | ${
      expectancy != null
        ? (expectancy >= 0 ? "+" : "") + "$" + expectancy.toFixed(3)
        : "—"
    } |`,
  );
  lines.push(
    `| Max drawdown (closed-trade equity) | ${
      closed.length > 0 ? "$" + maxDd.toFixed(2) : "—"
    } |`,
  );
  lines.push(
    `| Open position | ${
      open
        ? `Yes — entered ${new Date(open.entryTime)
            .toISOString()
            .slice(0, 10)} @ $${open.entryPrice.toFixed(2)}`
        : "No"
    } |`,
  );
  lines.push("");

  lines.push("## Comparison to backtest assumptions");
  lines.push("");
  lines.push(
    "Backtest baseline: 16 rolling 2-yr windows over 2016–2026, ETH 1d, 30 bps cost, $25 notional, NR7 + MA50 regime, staged-r-trail exit. (See `STRATEGY_RESULTS.md` and rolling-window study.)",
  );
  lines.push("");
  lines.push("| Metric | Backtest baseline | Forward (live) | Verdict |");
  lines.push("|---|---|---|---|");
  lines.push(
    `| Avg expectancy / trade | +$0.521 | ${
      expectancy != null
        ? (expectancy >= 0 ? "+" : "") + "$" + expectancy.toFixed(3)
        : "—"
    } | ${
      expectancy == null
        ? "Insufficient data (need ≥10 closed)"
        : expectancy >= 0
          ? "On track / above"
          : "Below baseline"
    } |`,
  );
  lines.push(
    `| Median expectancy / window | +$0.600 | (single window) | n/a until ≥1 yr forward |`,
  );
  lines.push(
    `| Win rate | ~42–58% per backtest window | ${
      closed.length > 0
        ? ((wins / closed.length) * 100).toFixed(1) + "%"
        : "—"
    } | ${
      closed.length < 10 ? "Insufficient sample" : "Compare with caution (small N)"
    } |`,
  );
  lines.push(
    `| Trade frequency | ~1 trade / 30–80 days (9–22 / 2 yr window) | ${closed.length} closed in ${log.length} forward day(s) | ${
      log.length < 90 ? "Too early to compare" : "—"
    } |`,
  );
  lines.push(
    `| Worst-window expectancy | −$0.925 (W4 2017–19 bear) | — | track for sign-flip vs. regime |`,
  );
  lines.push("");
  lines.push(
    "**Promotion gates not yet cleared (from prior pre-registration):** ≥80 closed trades on a single tape and BTC cross-symbol confirmation. Forward validation is independent of those gates — it tests whether the *backtested* edge holds out-of-sample.",
  );
  lines.push("");

  lines.push("## Closed trades (forward window only)");
  lines.push("");
  if (closed.length === 0) {
    lines.push("_No closed trades yet._");
  } else {
    lines.push(
      "| # | Entry date | Entry $ | Exit date | Exit $ | Exit reason | Outcome | R | Held (bars) | P/L $ |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    closed.forEach((t, i) => {
      lines.push(
        `| ${i + 1} | ${new Date(t.entryTime)
          .toISOString()
          .slice(0, 10)} | ${t.entryPrice.toFixed(2)} | ${
          t.exitTime
            ? new Date(t.exitTime).toISOString().slice(0, 10)
            : "—"
        } | ${t.exitPrice?.toFixed(2) ?? "—"} | ${classifyExit(t)} | ${
          t.outcome
        } | ${t.rRealized?.toFixed(2) ?? "—"} | ${t.holdingBars ?? "—"} | ${
          (t.pnlUsd ?? 0) >= 0 ? "+" : ""
        }${(t.pnlUsd ?? 0).toFixed(2)} |`,
      );
    });
  }
  lines.push("");

  lines.push("## Open position");
  lines.push("");
  if (!open) {
    lines.push("_No open position._");
  } else {
    const unr =
      lastClose != null
        ? ((lastClose - open.entryPrice) / open.entryPrice) * NOTIONAL_USD
        : null;
    lines.push(
      `- Entered: ${new Date(open.entryTime).toISOString().slice(0, 10)} @ $${open.entryPrice.toFixed(2)}`,
    );
    lines.push(`- Initial stop: $${open.stopLoss.toFixed(2)}`);
    lines.push(`- R-target: $${open.profitTarget.toFixed(2)}`);
    lines.push(
      `- Mark-to-market unrealized P/L (at last close $${lastClose?.toFixed(2) ?? "—"}): ${
        unr != null ? (unr >= 0 ? "+" : "") + "$" + unr.toFixed(2) : "—"
      }`,
    );
    lines.push(
      `- Exit plan: staged-r-trail (BE @ +1R, prior-bar-low trail from +2R, time-stop = 48 bars)`,
    );
  }
  lines.push("");

  lines.push("## Daily decision log (most recent 30 days)");
  lines.push("");
  const recent = log.slice(-30);
  if (recent.length === 0) {
    lines.push(
      "_No bars evaluated yet — forward validation start is in the future. The first row will appear after the lock-in date's daily candle closes._",
    );
  } else {
    lines.push(
      "| Date | Close | Classification | Signal | Entry | Stop | Open? | Unrealized | Realized |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of recent) {
      lines.push(
        `| ${r.dateIso} | $${r.closePrice.toFixed(2)} | ${r.classification} | ${
          r.signal ? "YES" : ""
        } | ${r.entryPrice ? "$" + r.entryPrice.toFixed(2) : ""} | ${
          r.stopLoss ? "$" + r.stopLoss.toFixed(2) : ""
        } | ${r.positionOpen ? "Y" : ""} | ${
          r.unrealizedPnlUsd != null
            ? (r.unrealizedPnlUsd >= 0 ? "+" : "") +
              "$" +
              r.unrealizedPnlUsd.toFixed(2)
            : ""
        } | ${
          r.realizedPnlUsd != null
            ? (r.realizedPnlUsd >= 0 ? "+" : "") +
              "$" +
              r.realizedPnlUsd.toFixed(2)
            : ""
        } |`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Full daily log: [`data/forward-validation-eth-1d-log.csv`](data/forward-validation-eth-1d-log.csv).",
  );
  lines.push("");

  lines.push("## Hard guarantees");
  lines.push("");
  lines.push(
    "- Strategy code (`src/lib/trading/fundingCompressionStrategy.ts`) is **NOT modified** by this runner.",
  );
  lines.push("- No filters added. No parameters tuned. No optimization.");
  lines.push("- No connection is made to Robinhood. No order is placed.");
  lines.push(
    "- All P/L is paper-only. Cost = 30 bps round-trip, notional = $25 per trade, fixed.",
  );
  lines.push(
    "- Re-running the script on the same candle data produces identical output (deterministic).",
  );
  lines.push("");
  lines.push(`_Last updated: ${new Date().toISOString()}_`);
  lines.push("");

  fs.writeFileSync(REPORT_FILE, lines.join("\n"));
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

// ============================================================================
// Entry point.
// ============================================================================
async function main() {
  console.log("=== ETH 1D Compression-Breakout Forward Validation ===");
  console.log(
    "Mode: PAPER ONLY — no live trading, no Robinhood connection, no order placement.\n",
  );

  await updateCandlesCsv();

  const candles = loadCandles(CANDLES_FILE);
  console.log(
    `Loaded ${candles.length} bars (${new Date(candles[0].timestamp)
      .toISOString()
      .slice(0, 10)} → ${new Date(candles[candles.length - 1].timestamp)
      .toISOString()
      .slice(0, 10)})\n`,
  );

  const forwardStartTs = Date.parse(FORWARD_VALIDATION_START_ISO);
  const forwardTrades = walkForwardOnly(candles, forwardStartTs);
  console.log(
    `Forward trades (entry ≥ ${FORWARD_VALIDATION_START_ISO.slice(0, 10)}): ${forwardTrades.length}`,
  );

  const log = buildDailyLog(candles, forwardTrades, forwardStartTs);
  console.log(`Daily decision log: ${log.length} bar(s)`);

  const lastCandleIso = new Date(candles[candles.length - 1].timestamp)
    .toISOString()
    .slice(0, 10);
  const lastClose = candles[candles.length - 1].close;

  writeDailyLogCsv(log);
  writeStateJson(FORWARD_VALIDATION_START_ISO, lastCandleIso, forwardTrades, lastClose);
  writeLatestJson(FORWARD_VALIDATION_START_ISO, lastCandleIso, lastClose, forwardTrades, log);
  writeReport(forwardTrades, log, lastCandleIso);

  const today = log[log.length - 1];
  console.log("");
  if (today) {
    console.log(
      `Today (${today.dateIso}): ${today.classification}${today.signal ? " — SIGNAL TRIGGERED" : ""}`,
    );
    if (today.notes) console.log(`  ${today.notes}`);
  } else {
    console.log(
      `Forward validation start (${FORWARD_VALIDATION_START_ISO.slice(0, 10)}) is in the future. Nothing to log yet — first row will appear once that bar closes.`,
    );
  }

  console.log(
    `\nWritten:\n  ${LOG_FILE}\n  ${STATE_FILE}\n  ${LATEST_JSON_FILE}\n  ${REPORT_FILE}\n`,
  );
}

main().catch((err) => {
  console.error("Forward validation failed:", err);
  process.exit(1);
});
