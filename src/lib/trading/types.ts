// Verbatim copy of the Lovable frontend types — placed here so backtest imports resolve.
// Keep in sync with the canonical version in the Lovable repo.

export type AssetSymbol = "BTC" | "ETH";
export type Side = "BUY" | "SELL";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type MarketCondition = "FAVORABLE" | "CHOPPY" | "LOW_VOLUME" | "LOW_VOLATILITY";
export type TrendStatus = "UPTREND" | "DOWNTREND" | "SIDEWAYS";
export type Quality = "STRONG" | "OK" | "WEAK";

export interface MarketSnapshot {
  symbol: AssetSymbol;
  price: number;
  change24h: number; // percent
  ma50: number;
  recentHigh: number;
  support: number;
  resistance: number;
  trend: TrendStatus;
  volatility: Quality;
  volume: Quality;
  condition: MarketCondition;
  pullbackPct: number; // percent off recent high
}

/**
 * Optional exit plan attached to a Recommendation.
 *
 * Absent / mode "fixed" = legacy fixed stop+target (pullback strategy).
 * mode "trailing-atr"   = ratchet stop each bar by close - ATR*mult (momentum).
 * mode "staged-r-trail" = capitulation strategy:
 *   - initial stop is rec.stopLoss (set by the strategy);
 *   - when high >= entry + bePromoteAtR * R, stop -> entry (breakeven);
 *   - when high >= entry + trailFromR * R, stop trails the prior bar's low;
 *   - exit if open after timeStopBars bars regardless of P/L.
 *
 * Frontend safely ignores this field; the backtest simulator reads it.
 */
export interface ExitPlan {
  mode:
    | "fixed"
    | "trailing-atr"
    | "staged-r-trail"
    | "staged-r-trail-partial"
    | "funding-reversion";
  // for trailing-atr
  atrMultiplier?: number;
  // for staged-r-trail / staged-r-trail-partial / funding-reversion
  // - bePromoteAtR: when set, promote stop to entry (BE) once unrealized
  //   profit reaches this R-multiple. When undefined, no BE step.
  // - trailFromR: activate prior-bar-low trailing once unrealized profit
  //   reaches this R-multiple.
  // - timeStopBars: exit at market this many bars after entry. When undefined,
  //   no time stop is applied.
  // - partialExitAtR / partialExitFraction: for staged-r-trail-partial only.
  //   At first +partialExitAtR, close `partialExitFraction` of the position;
  //   the remainder continues with the trail rules. Defaults: 1R, 0.5.
  bePromoteAtR?: number;
  trailFromR?: number;
  timeStopBars?: number;
  partialExitAtR?: number;
  partialExitFraction?: number;
}

export interface Recommendation {
  id: string;
  symbol: AssetSymbol;
  side: Side;
  amountUsd: number;
  entry: number;
  stopLoss: number;
  profitTarget: number;
  invalidation: number;
  riskRewardRatio: number;
  confidence: Confidence;
  reasoning: string;
  srNotes: string;
  marketSummary: string;
  createdAt: number;
  exitPlan?: ExitPlan;
}

export type TradeStatus = "APPROVED" | "DECLINED" | "SIMULATED" | "SKIPPED" | "CLOSED_WIN" | "CLOSED_LOSS";

export interface TradeLogEntry {
  id: string;
  timestamp: number;
  symbol: AssetSymbol;
  side: Side;
  status: TradeStatus;
  entry?: number;
  exit?: number;
  resultPct?: number;
  resultUsd?: number;
  amountUsd: number;
  confidence?: Confidence;
  notes: string;
}

export interface SystemState {
  paperMode: true;
  botEnabled: boolean;
  autoExecution: false;
  approvalRequired: true;
  mockData: true;
  lastScanAt: number | null;
  nextScanAt: number | null;
}

export interface Account {
  buyingPower: number;
  portfolioValue: number;
  btcHoldings: number; // units
  ethHoldings: number;
  openPositions: number;
  dailyPnl: number;
  weeklyPnl: number;
}

export interface NoTradeReason {
  symbol: AssetSymbol;
  reasons: string[];
}
