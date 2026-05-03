# Forward Validation — ETH 1D Compression Breakout

**Status: PAPER ONLY.** No Robinhood connection. No live trading. No order placement. This document tracks how the locked strategy performs on bars unseen at the time of strategy lock-in.

## Locked configuration

| Field | Value |
|---|---|
| Strategy | ETH 1d compression-breakout (NR7 + daily MA50 regime gate) |
| Strategy source | `src/lib/trading/fundingCompressionStrategy.ts` (unchanged) |
| Funding filter | DISABLED (1d TF; locked spec) |
| Exit plan | staged-r-trail (BE @ 1R, prior-bar-low trail from 2R, time-stop = 48 bars) |
| Cost (round-trip) | 30 bps |
| Notional per trade | $25 |
| Forward validation start | 2026-04-30 |
| Last evaluated candle | 2026-05-03 |
| Forward bars elapsed | 4 |

## Tracked metrics (forward-only — bars on/after lock-in)

| Metric | Value |
|---|---|
| Total signals | 0 |
| Trades opened | 0 |
| Trades closed | 0 |
| Wins | 0 |
| Losses | 0 |
| Win rate | — |
| Realized P/L | — |
| Expectancy / closed trade | — |
| Max drawdown (closed-trade equity) | — |
| Open position | No |

## Comparison to backtest assumptions

Backtest baseline: 16 rolling 2-yr windows over 2016–2026, ETH 1d, 30 bps cost, $25 notional, NR7 + MA50 regime, staged-r-trail exit. (See `STRATEGY_RESULTS.md` and rolling-window study.)

| Metric | Backtest baseline | Forward (live) | Verdict |
|---|---|---|---|
| Avg expectancy / trade | +$0.521 | — | Insufficient data (need ≥10 closed) |
| Median expectancy / window | +$0.600 | (single window) | n/a until ≥1 yr forward |
| Win rate | ~42–58% per backtest window | — | Insufficient sample |
| Trade frequency | ~1 trade / 30–80 days (9–22 / 2 yr window) | 0 closed in 4 forward day(s) | Too early to compare |
| Worst-window expectancy | −$0.925 (W4 2017–19 bear) | — | track for sign-flip vs. regime |

**Promotion gates not yet cleared (from prior pre-registration):** ≥80 closed trades on a single tape and BTC cross-symbol confirmation. Forward validation is independent of those gates — it tests whether the *backtested* edge holds out-of-sample.

## Closed trades (forward window only)

_No closed trades yet._

## Open position

_No open position._

## Daily decision log (most recent 30 days)

| Date | Close | Classification | Signal | Entry | Stop | Open? | Unrealized | Realized |
|---|---|---|---|---|---|---|---|---|
| 2026-04-30 | $2256.80 | no-signal |  |  |  |  |  |  |
| 2026-05-01 | $2295.54 | no-signal |  |  |  |  |  |  |
| 2026-05-02 | $2316.89 | no-signal |  |  |  |  |  |  |
| 2026-05-03 | $2313.30 | no-signal |  |  |  |  |  |  |

Full daily log: [`data/forward-validation-eth-1d-log.csv`](data/forward-validation-eth-1d-log.csv).

## Hard guarantees

- Strategy code (`src/lib/trading/fundingCompressionStrategy.ts`) is **NOT modified** by this runner.
- No filters added. No parameters tuned. No optimization.
- No connection is made to Robinhood. No order is placed.
- All P/L is paper-only. Cost = 30 bps round-trip, notional = $25 per trade, fixed.
- Re-running the script on the same candle data produces identical output (deterministic).

_Last updated: 2026-05-03T00:20:51.776Z_
