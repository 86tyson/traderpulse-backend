# Backtesting

Run the existing strategy (`evaluateMarket`) against historical OHLCV candle data to get an honest read on whether it has edge.

No live APIs, no Robinhood, no UI.

---

## Setup

The harness lives in `src/backtest/` (TypeScript) and depends on `src/lib/trading/` (the strategy + snapshot builder + bridge function).

### One-time

The CLI is TypeScript. Add `tsx` (a zero-config TS runner) to your project's dev dependencies:

```bash
npm install --save-dev tsx
```

Add this line to your `package.json` `"scripts"`:

```json
"backtest": "tsx src/backtest/runBacktest.ts"
```

### Where data files go

Place CSV files in the `data/` directory at the project root:

```
data/
├── sample-btc-1h.csv     ← shipped synthetic file, for smoke-testing only
├── btc-1h.csv            ← your real BTC 1h history (you provide)
└── eth-1h.csv            ← your real ETH 1h history (you provide)
```

The harness expects this exact CSV header (case-insensitive, column order doesn't matter):

```
timestamp,open,high,low,close,volume
```

Each row is one candle. Timestamps can be:
- ISO 8601 strings (e.g. `2024-01-01T00:00:00Z`)
- Unix milliseconds (e.g. `1704067200000`)
- Unix seconds (e.g. `1704067200`) — auto-detected when value < 1e11

> **About `data/sample-btc-1h.csv`:** Synthetic data shipped with the repo to verify the pipeline runs end-to-end. **It is NOT a market replay and proves nothing about strategy performance.** Real market structure is required to evaluate the strategy.

---

## Getting real BTC/ETH historical data

Pick one source. Stick to it. Mixing exchanges or sources between BTC and ETH makes results harder to compare because exchange spreads create small price differences that distort MA50 and pullback math.

### Source 1: Binance public archive (recommended for bulk)

URL: `https://data.binance.vision/?prefix=data/spot/monthly/klines/BTCUSDT/1h/`

Free, no account, no API key. Download monthly ZIPs containing one CSV each. Default header:

```
Open time,Open,High,Low,Close,Volume,Close time,Quote asset volume,Number of trades,Taker buy base asset volume,Taker buy quote asset volume,Ignore
```

Munge to the harness format (keep first 6 columns, rename header):

```bash
unzip -p BTCUSDT-1h-2024-01.zip | \
  awk -F, 'BEGIN { print "timestamp,open,high,low,close,volume" } \
           { print $1","$2","$3","$4","$5","$6 }' > data/btc-1h.csv
```

`Open time` is unix milliseconds — the loader auto-detects that. To stitch multiple months, concatenate the data rows (drop subsequent headers) before writing.

### Source 2: Coinbase Exchange public REST API

URL: `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600`

Returns JSON: `[[time, low, high, open, close, volume], ...]`. **Columns are NOT in OHLCV order** — convert before saving. Max 300 candles per call; page with `start` and `end` query params for longer ranges. Pair name on Coinbase is `BTC-USD`, not `BTCUSDT`.

### Source 3: CryptoDataDownload

URL: `https://www.cryptodatadownload.com/data/binance/`

Pre-built historical CSVs across multiple timeframes. Example file: `Binance_BTCUSDT_1h.csv`. Header (after one prefatory line):

```
Unix Timestamp,Date,Symbol,Open,High,Low,Close,Volume BTC,Volume USDT
```

Munge to the harness format (skip the prefatory line, keep timestamp + OHLC + base volume):

```bash
awk -F, 'NR==1 { print "timestamp,open,high,low,close,volume" } \
         NR>2  { print $1","$4","$5","$6","$7","$8 }' Binance_BTCUSDT_1h.csv > data/btc-1h.csv
```

### Data quality requirements

- **Minimum 500–1000 candles.** Smaller samples give win-rate confidence intervals too wide to be meaningful (95 % CI on 30 trades spans ~30 percentage points). 1000 hourly candles ≈ 42 days of market data.
- **Prefer 1h timeframe to start.** Coarse enough that a few months fits in one CSV; fine enough that ambiguous-trade ratios stay low. Move to 4h once 1h is solid; only drop to 15m / 5m if you suspect ambiguous-bar contamination.
- **No missing timestamps.** Crypto trades 24/7. Every consecutive pair of bars should differ by exactly your timeframe interval. Gaps (exchange outages, missing daily files) cause the strategy to treat non-adjacent bars as adjacent, silently corrupting MA50 and pullback calculations.
- **Single source per CSV.** Don't merge Binance and Coinbase prices into the same file — exchange spread creates artificial noise.
- **Save the raw download.** Document provenance in the filename: `data/btc-1h-binance-jan2024-jun2024.csv`. If results look off, you can re-derive the harness CSV from the original.

### Quick integrity check

```bash
# Total candles (subtract 1 for the header row)
wc -l data/btc-1h.csv

# First/last timestamps
head -2 data/btc-1h.csv | tail -1
tail -1 data/btc-1h.csv

# Detect timestamp gaps (1h = 3600000 ms; for 5m use 300000, for 4h use 14400000, for 1d use 86400000)
awk -F, -v expected=3600000 \
  'NR==2 { last=$1+0; next } \
   NR>2  { gap=$1-last; if (gap > expected*1.5) print "row "NR-1": gap="gap" ms"; last=$1+0 }' \
  data/btc-1h.csv
```

If the last command prints any rows, the file has gaps — fix them before running the backtest.

---

## Smoke test (verify the pipeline works)

```bash
npm run backtest -- --file ./data/sample-btc-1h.csv --symbol BTC --timeframe 1h
```

**Expected outcome:** the harness loads 250 candles, runs without errors, and writes the three report files to `./reports/`. The strategy's filters are intentionally strict, so this synthetic dataset commonly produces 0 trades — that is acceptable. The point of the smoke test is to prove the *pipeline* runs, not the *strategy* succeeds.

A successful smoke test ends with:

```
Reports written to ./reports/
  - backtest-trades.csv
  - backtest-report.json
  - backtest-report.md
```

If you see those three files written and the process exits 0, the harness is working. Now feed it real data.

---

## Real backtest

> **Real market structure is required to evaluate the strategy.** The synthetic sample produces zero trades because purely mathematical sine-wave price action almost never satisfies all four geometric filters simultaneously (3 % pullback, support within 2 %, price > MA50, R:R ≥ 1.5). Real BTC/ETH history exhibits the structure the strategy is looking for. **Do not interpret the synthetic file's zero-trade output as evidence about the strategy.**

```bash
npm run backtest -- --file ./data/btc-1h.csv --symbol BTC --timeframe 1h
npm run backtest -- --file ./data/eth-1h.csv --symbol ETH --timeframe 1h
```

If your real backtest *also* produces zero trades, that is a meaningful signal — it means the strategy's filters are too restrictive for the market regime in your data window. Note it; do not loosen filters yet. Try a different date range or timeframe first.

---

## Recommended Test Runs

Six required runs across BTC and ETH at three timeframe/window configurations each. **Complete all six before evaluating or tuning the strategy.** Mid-suite tuning is p-hacking by reflex.

### The runs

| # | Symbol | Timeframe | Window | Suggested filename | `--out` dir |
|---|---|---|---|---|---|
| 1 | BTC | 1h | last 3 months  | `data/btc-1h-last3mo.csv`  | `./reports/btc-1h-3mo` |
| 2 | BTC | 1h | last 12 months | `data/btc-1h-last12mo.csv` | `./reports/btc-1h-12mo` |
| 3 | BTC | 4h | last 12 months | `data/btc-4h-last12mo.csv` | `./reports/btc-4h-12mo` |
| 4 | ETH | 1h | last 3 months  | `data/eth-1h-last3mo.csv`  | `./reports/eth-1h-3mo` |
| 5 | ETH | 1h | last 12 months | `data/eth-1h-last12mo.csv` | `./reports/eth-1h-12mo` |
| 6 | ETH | 4h | last 12 months | `data/eth-4h-last12mo.csv` | `./reports/eth-4h-12mo` |

Approximate bar counts: 1h × 3 mo ≈ 2 160; 1h × 12 mo ≈ 8 760; 4h × 12 mo ≈ 2 190. All comfortably above the 500–1 000 minimum.

### Commands

```bash
npm run backtest -- --file ./data/btc-1h-last3mo.csv  --symbol BTC --timeframe 1h --out ./reports/btc-1h-3mo
npm run backtest -- --file ./data/btc-1h-last12mo.csv --symbol BTC --timeframe 1h --out ./reports/btc-1h-12mo
npm run backtest -- --file ./data/btc-4h-last12mo.csv --symbol BTC --timeframe 4h --out ./reports/btc-4h-12mo

npm run backtest -- --file ./data/eth-1h-last3mo.csv  --symbol ETH --timeframe 1h --out ./reports/eth-1h-3mo
npm run backtest -- --file ./data/eth-1h-last12mo.csv --symbol ETH --timeframe 1h --out ./reports/eth-1h-12mo
npm run backtest -- --file ./data/eth-4h-last12mo.csv --symbol ETH --timeframe 4h --out ./reports/eth-4h-12mo
```

### What to record (one row per run)

Read these from each `backtest-report.md` and fill in the matrix. **Don't skip ambiguous %** — it's how you know whether the rest of the numbers are trustworthy.

| # | Run | Total trades | Wins | Losses | Win rate | Realized R:R | Expectancy | Max DD | Ambiguous % |
|---|---|---|---|---|---|---|---|---|---|
| 1 | BTC 1h 3mo  |  |  |  |  |  |  |  |  |
| 2 | BTC 1h 12mo |  |  |  |  |  |  |  |  |
| 3 | BTC 4h 12mo |  |  |  |  |  |  |  |  |
| 4 | ETH 1h 3mo  |  |  |  |  |  |  |  |  |
| 5 | ETH 1h 12mo |  |  |  |  |  |  |  |  |
| 6 | ETH 4h 12mo |  |  |  |  |  |  |  |  |

`ambiguous % = ambiguous / (wins + losses + ambiguous) × 100`

### Evaluation gate

Do **not** evaluate the strategy until **either** of these holds:

- **At least 80 closed trades** (`wins + losses`) exist per dataset, **OR**
- **Multiple datasets consistently show zero trades** — e.g. 4 out of 6 runs return 0 trades

Below 80 closed trades and not zero-consistent: sample size is dominating signal. Collect more data (longer window or finer timeframe) before drawing any conclusion. A 30-trade win-rate sample has a 95 % CI roughly ±18 percentage points — wider than any "edge" you could read from it.

### Interpretation guidance

- **Zero trades across all datasets** → strategy is too restrictive for real BTC/ETH structure. Don't loosen filters yet. First verify data quality (no gaps, correct format, sane price levels), then schedule a separate, deliberate filter-review cycle.
- **Trades only in trending periods** → expected behavior. The strategy is BUY-only and explicitly filters CHOPPY / SIDEWAYS. Sustained downtrends or chop should produce few or no signals. This is the strategy doing its job, not a bug.
- **Ambiguous % > 10 %** → timeframe is too coarse. Same-bar stop-and-target collisions are masking outcomes. Re-run on the next-finer timeframe (1h → 15m, 4h → 1h). **Do not trust win rate, R:R, or expectancy from any run with ambiguous % > 10 %.**
- **Large drawdown early in the equity curve** (within the first 20 % of trades, never recovered) → likely no edge. A real edge produces drawdowns that recover; a non-edge produces a curve that drifts down with brief recoveries. Check the equity curve in `backtest-report.json` directly.
- **Expectancy near zero** — or negative when `--cost-bps` is increased modestly — → no edge regardless of win rate. The system pays back what it earns on average. A 55 % win rate at 1.5R returning ~0 expectancy means the wins don't actually clear the cost line. Try `--cost-bps 30` or `40` to stress-test; if expectancy collapses, there's no edge.

### Hard rule

> 🛑 **Do not adjust strategy parameters during these runs.** Do not tweak `REQUIRED_PULLBACK`, `MIN_RR`, MA period, confidence thresholds, support/resistance lookback, or anything else. Complete all six runs against the same code, fill in the matrix, then evaluate as a single cohort. Tuning between runs is p-hacking by reflex — the only thing it proves is which dataset you happened to peek at first.

### Required flags

| Flag | Values |
|---|---|
| `--file` | path to OHLCV CSV |
| `--symbol` | `BTC` or `ETH` |
| `--timeframe` | one of `5m`, `15m`, `1h`, `4h`, `1d` |

### Optional flags

| Flag | Default | Meaning |
|---|---|---|
| `--out` | `./reports` | output directory |
| `--cost-bps` | `20` | round-trip transaction cost in basis points (covers spread + slippage + fees) |
| `--notional-usd` | `25` | per-trade notional, matches the strategy's `DEFAULT_AMOUNT` |

### What it does

1. Loads the CSV, sorts by timestamp ascending, validates each row.
2. Walks forward candle by candle. At each bar `i`:
   - Calls `evaluateMarketFromCandles(candles[0..i], symbol, timeframe)`.
   - If a recommendation is emitted, opens a simulated trade.
   - **No future-data peeking** — only candles up to `i` are passed to the strategy.
3. For each open trade, walks subsequent candles until either the stop or the target is hit:
   - `BUY`: stop = `low <= stopLoss`, target = `high >= profitTarget`.
   - If both fire in the same bar → **ambiguous**, no win/loss assigned.
   - If neither fires by end of data → **open**, excluded from win/loss.
4. **One position at a time.** New signals fired while a position is open are skipped.
5. Writes three artifacts to `--out`:
   - `backtest-trades.csv` — one row per trade, machine-readable
   - `backtest-report.json` — full dump (context + metrics + trades + equity curve)
   - `backtest-report.md` — scannable summary with caveats

---

## How the metrics are calculated

| Metric | Formula |
|---|---|
| Win rate | `wins / (wins + losses)` — ambiguous and open are excluded from the denominator |
| Avg win % | mean of net % across winning trades (after cost haircut) |
| Avg loss % | mean of net % across losing trades (sign-preserved, so it's negative) |
| Realized R:R | `|avg_win / avg_loss|` |
| Expectancy | mean net % per closed trade `= net_pnl_pct / closed_count` |
| Profit factor | `gross_winners_usd / |gross_losers_usd|` |
| Max drawdown | peak-to-trough on the closed-trade USD equity curve |
| Net P/L | sum of net % and net USD across closed trades |

Each individual trade's net P/L is `gross_pct - (cost_bps / 100)`. With `--cost-bps 20`, every closed trade pays 20 bps regardless of size.

---

## What to trust, what NOT to trust

### Not trustworthy

- **Realized R:R.** The strategy hardcodes `stopLoss = entry × 0.98` and `profitTarget = entry × 1.03`. Every winning trade is exactly 1.5R minus cost; every losing trade is exactly −1R minus cost. Realized R:R will collapse to ~1.5 in any sample. **Do not read 1.5 R:R as evidence of edge.** It's an arithmetic artifact.
- **Confidence as a signal.** `evaluateMarket` returns three confidence buckets (HIGH / MEDIUM / LOW); LOW is filtered out. Whether HIGH actually outperforms MEDIUM is an open question this harness can answer (look at trade-level `confidence` in the CSV and group), but the bucketing rule itself was hand-calibrated and not validated.
- **Drawdown %**. Computed against `max(peak, |trough|, $1)` since there is no account-balance baseline. It is directionally correct (more red = worse) but not a precise account-equity drawdown.
- **Ambiguous trades.** A single-timeframe backtest cannot tell which of the stop or target fired first when both prices appear in the same bar. The harness reports the count but excludes them from win/loss. **If `ambiguous / closed > 10 %`, the timeframe is too coarse.** Re-run on a finer timeframe.
- **Sample sizes < 80 closed trades.** Sampling noise dominates. The 95 % CI on a 50 % observed win rate at n = 30 is roughly 32 % to 68 % — wide enough to swallow most "edge" claims.
- **One-shot results from a single date range.** A bull-run sample will look great. A chop sample will look terrible. Run multiple date ranges and regimes before drawing conclusions.

### Trustworthy

- **Win rate**, given a sample ≥ 80 closed trades AND ambiguous ratio < 10 %.
- **Expectancy** in the same conditions — net of the cost haircut.
- **Profit factor** as a relative comparison across runs (e.g. tweaking the strategy, comparing timeframes).
- **Trade frequency** (signals per period) — useful for estimating real-world burst load.
- **Skipped-signal count** during open positions — tells you how often the one-position-at-a-time rule is filtering valid signals.

### Mismatches to expect between backtest and live paper

| Backtest assumption | Live paper reality |
|---|---|
| Entry at `snap.price` (close of signal candle) | Likely ~next-bar open with some spread |
| Stop fills exactly at `stopLoss` | May fill worse on a fast move (slippage > cost-bps) |
| Target fills exactly at `profitTarget` | May fill better or worse depending on liquidity at the level |
| Single position at a time | Frontend currently allows multiple approvals — behaviour to align later |
| Strategy is BUY-only | Strategy is BUY-only (matches) |

If you change `--cost-bps` and the sign of expectancy flips, the strategy is sitting on the cost line and there is no real edge. Treat that result with extreme suspicion.

---

## Troubleshooting

### `snapshotBuilder: need at least 50 candles, got N`
**Cause:** The CSV has fewer than 50 rows. The strategy's 50-period MA needs at least that much warmup.
**Fix:** Provide more candles, OR start with a higher timeframe (1d uses fewer bars per unit of time).

### CSV parse errors — `missing required column "X"`, `non-numeric OHLC values`, `high < low`
**Cause:** The CSV does not match the expected schema, has empty cells, or is corrupted.
**Fix:** Re-export from the data source. The header must contain all six columns: `timestamp,open,high,low,close,volume` (case-insensitive). Each data row must have at least 6 numeric values. No quoted fields. Strip any "Adj Close" or "Symbol" columns before importing.

### Ambiguous-trade ratio is high (warning printed by the harness)
**Cause:** Many bars have both stop and target prices touched in the same candle, so we cannot tell which fired first.
**Fix:** Re-run with a finer timeframe (e.g. drop from 1h to 15m, or 4h to 1h). Same date range, more bars, fewer ambiguities. If `ambiguous / closed > 10 %`, **do not draw conclusions from the rest of the metrics** — the sample is contaminated.

### Zero trades fired
**This is not necessarily a bug.** The strategy is intentionally strict — it filters out CHOPPY/SIDEWAYS markets, low volume, low volatility, sub-3 % pullbacks, support not within 2 %, weak R:R, and LOW-confidence setups. Causes, in rough order of likelihood:
- The data really has no setups that match the strategy's criteria. Try a longer date range or a regime more favorable to trend-pullback (sustained uptrend with periodic shallow dips).
- The synthetic `sample-btc-1h.csv` falls into this category — it is engineered to exercise the pipeline, not the strategy filters. Real BTC/ETH history should produce trades.
- Check the strategy's filters individually: temporarily log `result.skipReasons` from `evaluateMarketFromCandles` to see which filter is rejecting bars. Usually one or two filters dominate.

### `Cannot find module 'tsx'` / `npm ERR! missing script: backtest`
**Cause:** The `tsx` dev dependency wasn't installed, or the `"backtest"` script line is missing from `package.json`.
**Fix:**
```bash
npm install --save-dev tsx
```
Then add to `package.json` `"scripts"`:
```json
"backtest": "tsx src/backtest/runBacktest.ts"
```
Verify with `npm run backtest -- --help` — should print the harness's "Backtest failed: --file is required" message, not a "missing script" error.

### `SyntaxError: Cannot use import statement outside a module`
**Cause:** You ran the harness with plain `node` instead of `tsx`. Plain Node treats `.ts` as CommonJS by default and chokes on ESM imports.
**Fix:** Always invoke through the `npm run backtest` script, which routes through `tsx`. Or use `npx tsx src/backtest/runBacktest.ts ...` directly.

---

## Out of scope (deliberately deferred)

- Confidence calibration buckets (50–59 / 60–69 / etc.) — the strategy emits HIGH / MEDIUM / LOW, not numeric scores. Calibration would need a numeric confidence first.
- Regime tagging (trending vs choppy vs low-vol vs high-vol) — the snapshot builder already classifies these per bar; surfacing them in the report is a follow-up.
- Walk-forward / out-of-sample splits.
- Multiple-position support.
- Live-data fetching (would violate the no-external-API rule).

If you want any of these, they go in a follow-up turn — not this minimal harness.

---

## Safety

- **Backtest only.** No Robinhood, no live execution paths, no API keys, no order placement. The strategy code referenced (`evaluateMarket`) is the same function the live system uses to generate recommendations, but in this harness it is a pure function — no side effects.
- **Read-only.** The harness reads candles and writes report files. It does not mutate the strategy code, the snapshot builder, the trading-backend SQLite database, or anything else.
