// src/backtest/simulator.ts
//
// Forward-walk a recommendation through subsequent candles to determine the
// exit. Two exit modes:
//
//   FIXED (default — used by the pullback strategy):
//     - Exit at rec.profitTarget if hit; rec.stopLoss if hit.
//     - Same-bar collision -> "ambiguous".
//     - Outcome: hitTgt -> win, hitStop -> loss.
//
//   TRAILING-ATR (used by the momentum strategy when rec.exitPlan.mode === "trailing-atr"):
//     - Initial stop = rec.stopLoss; ratchets up each bar:
//         stop = max(stop, close - ATR * atrMultiplier)   (BUY)
//         stop = min(stop, close + ATR * atrMultiplier)   (SELL)
//     - profitTarget acts as a far-out cap (e.g. 10R).
//     - Outcome is classified by the SIGN of net P/L, since a trailing stop
//       can be hit at a price above entry (= win) just as easily as below.
//
// Cost haircut (round-trip basis points) is applied identically in both modes.

import type { Recommendation, AssetSymbol, Side, Confidence } from "../lib/trading/types";
import type { Candle } from "../lib/trading/snapshotBuilder";

export type BacktestOutcome = "win" | "loss" | "ambiguous" | "open";

export interface BacktestTrade {
  recommendationId: string;
  symbol: AssetSymbol;
  side: Side;
  confidence: Confidence;
  entryIdx: number;
  entryTime: number;
  entryPrice: number;
  stopLoss: number;             // initial; for trailing, this is the entry-time level
  profitTarget: number;
  riskRewardPlanned: number;
  exitIdx: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  outcome: BacktestOutcome;
  pnlPctGross: number | null;
  pnlPctNet: number | null;
  pnlUsd: number | null;
  rRealized: number | null;
  holdingBars: number | null;
  exitMode:
    | "fixed"
    | "trailing-atr"
    | "staged-r-trail"
    | "staged-r-trail-partial"
    | "funding-reversion";
  // For trailing exits, the actual stop level when the trade closed.
  finalStop: number | null;
  // For staged-r-trail-partial: details of the first-leg partial exit.
  partialClosed?: boolean;
  partialExitIdx?: number | null;
  partialExitPrice?: number | null;
  partialPnlUsd?: number | null;
}

export interface SimulatorConfig {
  costBps: number;
  notionalUsd: number;
  /**
   * For exitMode === "funding-reversion": called at each post-entry bar's close
   * (timestamp = bar.timestamp + 1h, since Coinbase bar timestamps are open-times).
   * If the function returns true, the simulator exits at this bar's close.
   * Used to capture the "funding has normalized" exit signal.
   */
  fundingNormalizedAtTime?: (closeMs: number) => boolean;
}

const DEFAULT_TRAILING_ATR_PERIOD = 14;

export function simulateTrade(
  rec: Recommendation,
  candles: Candle[],
  entryIdx: number,
  cfg: SimulatorConfig,
): BacktestTrade {
  const entryCandle = candles[entryIdx];
  const direction = rec.side === "BUY" ? 1 : -1;
  const exitMode = (rec.exitPlan?.mode ?? "fixed") as BacktestTrade["exitMode"];
  const trailingAtrMult = rec.exitPlan?.atrMultiplier ?? 1.5;

  const open: BacktestTrade = {
    recommendationId: rec.id,
    symbol: rec.symbol,
    side: rec.side,
    confidence: rec.confidence,
    entryIdx,
    entryTime: entryCandle.timestamp,
    entryPrice: rec.entry,
    stopLoss: rec.stopLoss,
    profitTarget: rec.profitTarget,
    riskRewardPlanned: rec.riskRewardRatio,
    exitIdx: null,
    exitTime: null,
    exitPrice: null,
    outcome: "open",
    pnlPctGross: null,
    pnlPctNet: null,
    pnlUsd: null,
    rRealized: null,
    holdingBars: null,
    exitMode,
    finalStop: null,
  };

  // Pre-compute ATR for trailing-atr mode only.
  const atrSeries =
    exitMode === "trailing-atr" ? rollingATR(candles, DEFAULT_TRAILING_ATR_PERIOD) : null;

  // Staged-R-trail mode parameters. bePromoteAtR / timeStopBars are optional —
  // undefined means "skip that step entirely" (V2: no BE, V4: no TS).
  const bePromoteAtR: number | undefined = rec.exitPlan?.bePromoteAtR;
  const trailFromR = rec.exitPlan?.trailFromR ?? 2;
  const timeStopBars: number | undefined = rec.exitPlan?.timeStopBars;
  const partialExitAtR = rec.exitPlan?.partialExitAtR ?? 1;
  const partialExitFraction = rec.exitPlan?.partialExitFraction ?? 0.5;
  const R = Math.abs(rec.entry - rec.stopLoss);
  type Stage = "initial" | "be" | "trailing";
  let stage: Stage = "initial";

  // Partial-exit accounting (only used for staged-r-trail-partial).
  let partialClosed = false;
  let partialPnlUsd = 0;
  let partialExitIdx: number | null = null;
  let partialExitPrice: number | null = null;

  let currentStop = rec.stopLoss;

  // Helper for staged-trail / partial / funding-reversion exits at a specific
  // bar's close. Encapsulates the partial-leg accounting so each exit branch
  // can call it consistently.
  const settleAtClose = (j: number, c: Candle): BacktestTrade => {
    const exit = c.close;
    const grossPct = ((exit - rec.entry) / rec.entry) * 100 * direction;
    const netPct = grossPct - cfg.costBps / 100;
    const stopDistPct = (Math.abs(rec.entry - rec.stopLoss) / rec.entry) * 100;
    const remainingFraction = partialClosed ? 1 - partialExitFraction : 1;
    const remainingPnlUsd = (netPct / 100) * cfg.notionalUsd * remainingFraction;
    const totalPnlUsd = round(partialPnlUsd + remainingPnlUsd, 4);
    return {
      ...open,
      exitIdx: j,
      exitTime: c.timestamp,
      holdingBars: j - entryIdx,
      finalStop: currentStop,
      exitPrice: exit,
      pnlPctGross: round(grossPct, 4),
      pnlPctNet: round(netPct, 4),
      pnlUsd: totalPnlUsd,
      rRealized: stopDistPct > 0 ? round(netPct / stopDistPct, 4) : null,
      outcome: totalPnlUsd > 0 ? "win" : "loss",
      partialClosed,
      partialExitIdx,
      partialExitPrice,
      partialPnlUsd: partialClosed ? round(partialPnlUsd, 4) : null,
    };
  };

  const settleAtPriceLevel = (j: number, c: Candle, exitPrice: number): BacktestTrade => {
    const grossPct = ((exitPrice - rec.entry) / rec.entry) * 100 * direction;
    const netPct = grossPct - cfg.costBps / 100;
    const stopDistPct = (Math.abs(rec.entry - rec.stopLoss) / rec.entry) * 100;
    const remainingFraction = partialClosed ? 1 - partialExitFraction : 1;
    const remainingPnlUsd = (netPct / 100) * cfg.notionalUsd * remainingFraction;
    const totalPnlUsd = round(partialPnlUsd + remainingPnlUsd, 4);
    return {
      ...open,
      exitIdx: j,
      exitTime: c.timestamp,
      holdingBars: j - entryIdx,
      finalStop: currentStop,
      exitPrice,
      pnlPctGross: round(grossPct, 4),
      pnlPctNet: round(netPct, 4),
      pnlUsd: totalPnlUsd,
      rRealized: stopDistPct > 0 ? round(netPct / stopDistPct, 4) : null,
      outcome: totalPnlUsd > 0 ? "win" : "loss",
      partialClosed,
      partialExitIdx,
      partialExitPrice,
      partialPnlUsd: partialClosed ? round(partialPnlUsd, 4) : null,
    };
  };

  for (let j = entryIdx + 1; j < candles.length; j++) {
    const c = candles[j];
    const barsSinceEntry = j - entryIdx;

    // ----- Stop / target hit detection -----
    const hitStop =
      rec.side === "BUY" ? c.low <= currentStop : c.high >= currentStop;
    const hitTgt =
      rec.side === "BUY" ? c.high >= rec.profitTarget : c.low <= rec.profitTarget;

    if (!hitStop && !hitTgt) {
      // No exit on this bar — update trailing/staged state for the next bar.
      if (exitMode === "trailing-atr" && atrSeries) {
        const atr = atrSeries[j];
        if (Number.isFinite(atr) && atr > 0) {
          if (rec.side === "BUY") {
            const newStop = c.close - atr * trailingAtrMult;
            if (newStop > currentStop) currentStop = newStop;
          } else {
            const newStop = c.close + atr * trailingAtrMult;
            if (newStop < currentStop) currentStop = newStop;
          }
        }
      } else if (exitMode === "staged-r-trail" && R > 0 && rec.side === "BUY") {
        // Promote to BE only if bePromoteAtR is defined (V2 = "no BE" passes undefined).
        if (
          bePromoteAtR != null &&
          stage === "initial" &&
          c.high - rec.entry >= bePromoteAtR * R
        ) {
          if (rec.entry > currentStop) currentStop = rec.entry;
          stage = "be";
        }
        // Activate trailing once unrealized profit hits +trailFromR * R
        if ((stage === "initial" || stage === "be") && c.high - rec.entry >= trailFromR * R) {
          stage = "trailing";
        }
        // While trailing, ratchet stop up to the prior bar's low.
        if (stage === "trailing" && j - 1 >= entryIdx) {
          const priorLow = candles[j - 1].low;
          if (priorLow > currentStop) currentStop = priorLow;
        }
      } else if (exitMode === "staged-r-trail-partial" && R > 0 && rec.side === "BUY") {
        // First-leg partial exit at +partialExitAtR * R: close `partialExitFraction`
        // of the position at the level. No BE step (the partial-realized profit
        // replaces it). Track per-leg PnL for final accounting.
        if (
          !partialClosed &&
          c.high - rec.entry >= partialExitAtR * R
        ) {
          const partialExitLevel = rec.entry + partialExitAtR * R;
          const grossPctA = ((partialExitLevel - rec.entry) / rec.entry) * 100 * direction;
          const netPctA = grossPctA - cfg.costBps / 100;
          partialPnlUsd = (netPctA / 100) * cfg.notionalUsd * partialExitFraction;
          partialClosed = true;
          partialExitIdx = j;
          partialExitPrice = partialExitLevel;
        }
        // Activate trailing once unrealized profit hits +trailFromR * R
        if (stage === "initial" && c.high - rec.entry >= trailFromR * R) {
          stage = "trailing";
        }
        // While trailing, ratchet stop up to the prior bar's low.
        if (stage === "trailing" && j - 1 >= entryIdx) {
          const priorLow = candles[j - 1].low;
          if (priorLow > currentStop) currentStop = priorLow;
        }
      } else if (exitMode === "funding-reversion" && R > 0 && rec.side === "BUY") {
        // Activate trailing once unrealized profit hits +trailFromR * R (no BE step).
        if (stage === "initial" && c.high - rec.entry >= trailFromR * R) {
          stage = "trailing";
        }
        // While trailing, ratchet stop up to the prior bar's low.
        if (stage === "trailing" && j - 1 >= entryIdx) {
          const priorLow = candles[j - 1].low;
          if (priorLow > currentStop) currentStop = priorLow;
        }
      }

      // Funding-normalization exit (close-based, only for funding-reversion mode).
      if (exitMode === "funding-reversion" && cfg.fundingNormalizedAtTime) {
        const closeMs = c.timestamp + 60 * 60 * 1000;
        if (cfg.fundingNormalizedAtTime(closeMs)) {
          return settleAtClose(j, c);
        }
      }

      // Time stop: applies to staged-r-trail / staged-r-trail-partial / funding-reversion.
      // Skipped when timeStopBars is undefined (V4 = "no time stop").
      if (
        timeStopBars != null &&
        (exitMode === "staged-r-trail" ||
          exitMode === "staged-r-trail-partial" ||
          exitMode === "funding-reversion") &&
        barsSinceEntry >= timeStopBars
      ) {
        return settleAtClose(j, c);
      }
      continue;
    }

    // ----- An exit fired on this bar -----
    if (hitStop && hitTgt) {
      // Same-bar collision: cannot tell which fired first from a single timeframe.
      return {
        ...open,
        exitIdx: j,
        exitTime: c.timestamp,
        holdingBars: barsSinceEntry,
        finalStop: currentStop,
        outcome: "ambiguous",
        exitPrice: null,
        partialClosed,
        partialExitIdx,
        partialExitPrice,
        partialPnlUsd: partialClosed ? round(partialPnlUsd, 4) : null,
      };
    }

    const exit = hitTgt ? rec.profitTarget : currentStop;
    return settleAtPriceLevel(j, c, exit);
  }

  return open;
}

function trueRange(curr: Candle, prev: Candle | undefined): number {
  const hl = curr.high - curr.low;
  if (!prev) return hl;
  return Math.max(hl, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
}

function rollingATR(candles: Candle[], period: number): number[] {
  const trs = candles.map((c, i) => trueRange(c, candles[i - 1]));
  const out: number[] = [];
  let runningSum = 0;
  for (let i = 0; i < trs.length; i++) {
    runningSum += trs[i];
    if (i + 1 < period) { out.push(NaN); continue; }
    if (i + 1 > period) runningSum -= trs[i - period];
    out.push(runningSum / period);
  }
  return out;
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
