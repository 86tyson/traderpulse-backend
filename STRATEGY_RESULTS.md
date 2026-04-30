# Strategy Results

**Graveyard of tested strategies.** This file is the permanent decision log. If a strategy is listed here as **abandoned**, do not re-test it without proposing a *new* hypothesis (not a parameter tweak). The whole point of writing this down is to prevent re-running dead ideas under emotional pressure.

Each section records: hypothesis, rules summary, datasets actually tested, headline numbers, pre-registered falsification gates, and the verdict.

The pre-registered gates were locked **before** running each strategy and are not negotiable after the fact.

---

## 1. Pullback (S/R + 50-MA + clean retracement)

**Hypothesis:** crypto pullbacks of ≥ 3 % to clearly-defined support, while the 50-period MA is rising, mean-revert toward the prior swing high. Edge claim: pattern-based.

**Rules summary:**
- Entry: price > MA50, pullback ≥ 3 %, price within 2 % of confirmed swing-low support, S/R-derived R:R ≥ 1.5, hard filters block CHOPPY/LOW_VOLUME/LOW_VOLATILITY regimes.
- Stop / target: hardcoded `entry × 0.98` / `entry × 1.03` (flat 1.5R by construction).
- Confidence: 0–6 weighted score; LOW filtered out.

**Datasets tested:**

| Run | Trades | Closed | Win rate | Realized R:R | Expectancy / trade | Net P/L |
|---|---:|---:|---:|---:|---:|---:|
| BTC 1h 3mo  | 2  | 2  | 100.0 % | — | +$0.700 | +$1.40 |
| BTC 1h 12mo | 2  | 2  | 100.0 % | — | +$0.700 | +$1.40 |
| BTC 4h 12mo | 5  | 5  | 60.0 %  | 1.27 : 1 | +$0.200 | +$1.00 |
| ETH 1h 3mo  | 5  | 5  | 20.0 %  | 1.27 : 1 | −$0.300 | −$1.50 |
| ETH 1h 12mo | 21 | 21 | 52.4 %  | 1.27 : 1 | +$0.105 | +$2.20 |
| ETH 4h 12mo | 11 | 11 | 27.3 %  | 1.27 : 1 | −$0.209 | −$2.30 |

**Variant study (ETH 1h + ETH 15m × A/B/C, loosening pullback and near-support thresholds):**

| Variant | ETH 1h trades | ETH 1h exp/trade | ETH 15m trades | ETH 15m exp/trade |
|---|---:|---:|---:|---:|
| A baseline (3 % / 2 %)   | 21 | +$0.105 | 5  | −$0.050 |
| B moderate (2 % / 3 %)   | 51 | +$0.014 | 35 | −$0.050 |
| C loose (1.5 % / 4 %)    | 63 | +$0.045 | 81 | +$0.021 |

**Cost-sensitivity stress on the only run that cleared 80 trades** (ETH 15m Variant C):

| Cost (bps) | Expectancy / trade | Verdict |
|---:|---:|---|
| 20 | +$0.021 | barely positive |
| 30 | **−$0.004** | **flipped sign** |
| 40 | −$0.029 | clearly negative |

**Pre-registered gates (BACKTESTING.md):**

| Gate | Result |
|---|:---:|
| ≥ 80 closed trades per dataset | ❌ FAIL on 5 of 6 base runs; only ETH 15m Variant C passed |
| Sign of expectancy survives a 10 bps cost increase | ❌ FAIL — flipped at 30 bps |
| Realized R:R is a meaningful signal | ❌ FAIL — hardcoded 1.27 by construction (3 % / 2 % geometry) |
| Cross-symbol / cross-period consistency | not formally tested at variant scale; raw runs already showed sign-flips between symbols and timeframes |

**Verdict: ABANDONED 2026-04-29.**

The flat 2 % / 3 % geometry locks realized R:R at exactly 1.27 regardless of S/R quality, so no amount of filter loosening could break out of the cost-line trap. The single passing run (Variant C 15m) collapsed sign on a 10 bps cost shift.

**Do not revive without:** a structural change to the stop / target logic (e.g., dynamic targets tied to S/R levels rather than flat percentages). A different choice of pullback / near-support thresholds is **not** a new hypothesis and was already exhaustively tested.

---

## 2. Momentum breakout (MA50 trend + N-bar high + volume surge + ATR trail)

**Hypothesis:** crypto breakouts of the prior 20-bar high during a rising 50-MA on above-average volume mean continuation, captured by an ATR-trailing stop. Edge claim: trend-following on confirmed momentum.

**Rules summary:**
- Entry: close > MA50, MA50 has risen over 10 bars, close > prior 20-bar high, volume > 20-bar SMA.
- Stop: `entry − ATR(14) × 1.5`.
- Exit: trailing ATR stop (`max(stop, close − ATR × 1.5)`), 10R far cap on profit. No fixed target; trailing is the binding exit.
- Confidence: 0–4 score (breakout magnitude, volume surge, ATR expansion, slope steepness).

**Datasets tested:**

| Run | Trades | Win rate | Realized R:R | Expectancy / trade | Net P/L | Cost |
|---|---:|---:|---:|---:|---:|---:|
| ETH 1h current 12mo | 108 | 37.0 % | 2.33 : 1 | +$0.063 | +$6.80 | 20 bps |
| ETH 1h current 12mo | 108 | 36.1 % | 2.13 : 1 | +$0.038 | +$4.10 | 30 bps |
| ETH 1h current 12mo | 108 | 34.3 % | 2.04 : 1 | +$0.013 | +$1.40 | 40 bps |
| ETH 15m current 12mo | 431 | 28.8 % | 1.82 : 1 | −$0.030 | −$13.09 | 20 bps |
| ETH 1h prior 12mo (2024-04 → 2025-04) | 110 | 29.1 % | 2.12 : 1 | −$0.025 | −$2.71 | 20 bps |
| ETH 1h prior 12mo | 110 | 26.4 % | 2.12 : 1 | −$0.050 | −$5.46 | 30 bps |
| ETH 1h prior 12mo | 110 | 26.4 % | 1.86 : 1 | −$0.075 | −$8.21 | 40 bps |
| BTC 1h current 12mo | 123 | 26.0 % | 1.26 : 1 | −$0.077 | −$9.51 | 20 bps |
| BTC 1h current 12mo | 123 | 22.8 % | 1.20 : 1 | −$0.102 | −$12.58 | 30 bps |
| BTC 1h current 12mo | 123 | 18.7 % | 1.23 : 1 | −$0.127 | −$15.66 | 40 bps |

**Pre-registered gates:**

| Gate | Result |
|---|:---:|
| ≥ 80 closed trades per dataset | ✅ PASS (108, 110, 123, 431 — all clear) |
| Sign of expectancy survives 30 bps cost on the passing run | ✅ PASS only on ETH 1h current (held +$0.038 / +$0.013); ❌ FAIL on every other dataset |
| Cross-symbol consistency (no sign-flip BTC vs ETH at same cost / period) | ❌ FAIL — ETH 1h current +$0.063 vs BTC 1h current −$0.077 at 20 bps |
| Cross-period consistency (no sign-flip on same symbol, non-overlapping 12-month windows) | ❌ FAIL — ETH 1h current +$0.063 vs ETH 1h prior −$0.025 at 20 bps |
| Cross-timeframe consistency | ❌ FAIL — ETH 1h current +, ETH 15m current − |

**Verdict: ABANDONED 2026-04-29.**

The single positive cell (ETH × current 12-month window × 1h × ≤ 40 bps) is regime-specific to ETH 2025-04 → 2026-04, not a strategy edge. The same rules on BTC over the same period, on ETH over the prior 12 months, and on ETH at 15m all produce clearly negative expectancy. This is the textbook "single-cell win that doesn't replicate is overfitting to a regime" pattern that the evaluation framework was built to detect.

**Do not revive without:** evidence that a different timeframe (4h, 1d) survives the cross-symbol and cross-period gates simultaneously. Tweaking `breakoutLookback`, `atrMultiplier`, or `slopeLookback` on 1h is **not** a new hypothesis. A regime-conditioned variant (e.g., trade only in a separately-defined "high-volatility" regime) would be a new hypothesis worth testing — but only if pre-registered.

---

## 3. Capitulation Reversion (liquidation cascade + daily-MA50 regime gate + staged R-trail)

**Hypothesis:** leveraged-long liquidation cascades in BTC / ETH create short-term oversold conditions that mean-revert within ~24 hours, conditional on the longer-term uptrend being intact. Mechanism: forced sellers exhaust, bid book is temporarily bare, opportunistic capital steps in. Edge claim: structural inefficiency from leverage stack flushes.

**Rules summary:**
- Regime gate: latest completed daily close > daily MA(50).
- Trigger (1h bar T): `close[T-1] − close[T] > 2 × ATR(14, T-1)` AND `volume[T] > 2 × SMA(volume, 20)[T-1]`.
- Confirmation: `close[T+1] > close[T]`.
- Entry: close of T+1.
- Initial stop: low of T.
- Exit progression: BE at +1R, prior-bar-low trail at +2R, 24-bar time stop. No fixed profit target.
- Risk: $25 notional; one position at a time; streak rule (3 consec losses → 50 % size for 5 trades).

**Datasets tested:**

| Run | Trades | W / L | Win rate | Realized R:R | Expectancy / trade | Net P/L | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ETH 1h 12mo @ 20 bps | 14 | 4 / 10 | 28.6 % | 2.53 : 1 | +$0.004 | +$0.05 | 1.03 | $1.12 |
| ETH 1h 12mo @ 30 bps | 14 | 4 / 10 | 28.6 % | 2.14 : 1 | **−$0.020** | −$0.29 | 0.87 | $1.38 |
| BTC 1h 12mo @ 20 bps | 11 | 2 / 9  | 18.2 % | 2.24 : 1 | **−$0.057** | −$0.63 | 0.27 | $0.63 |
| BTC 1h 12mo @ 30 bps | 11 | 2 / 9  | 18.2 % | 1.62 : 1 | **−$0.077** | −$0.84 | 0.20 | $0.84 |

**Pre-registered gates** (locked in proposal before any code was written):

| # | Gate | Result |
|---|---|:---:|
| 1 | ≥ 80 closed trades on each of BTC 1h × 12mo and ETH 1h × 12mo | ❌ **FAIL** — 14 (ETH) and 11 (BTC), both well below 80 |
| 2 | Positive expectancy on **both** BTC and ETH at 30 bps | ❌ **FAIL** — both negative (ETH −$0.020, BTC −$0.077) |
| 3 | No sign-flip between BTC and ETH at the same cost level | ❌ **FAIL** at 20 bps (ETH +$0.004, BTC −$0.057) |
| 4 | No sign-flip between two non-overlapping 12-month windows on same symbol | ⏸ NOT TESTED (sample size already failed gate 1) |
| 5 | Regime filter materially affects results (ablation study) | ⏸ NOT TESTED (sample size already failed gate 1) |

**Verdict: ABANDONED 2026-04-29.**

The strategy fails the first three gates and the sample size is too small to evaluate the remaining two. Only 25 total closed trades across BTC and ETH in 12 months — that is well below the noise floor for any expectancy claim, in either direction. The trigger conditions (sharp 2×-ATR drop *with* 2×-volume surge *with* same-direction confirmation candle *with* daily uptrend) co-occur too rarely to produce a usable trading frequency at H1 on either symbol.

The hypothesis (liquidation-cascade mean reversion) was theoretically sound. The *operationalization* of "capitulation" (2× ATR drop + 2× volume) at H1 over a 12-month window did not produce enough qualifying events to test it.

**Do not revive without:** a fundamentally different way to detect liquidation cascades — for example, direct funding-rate or open-interest data from a perpetual-swap exchange, or a different timeframe where capitulation events are observable in higher numbers. Loosening "2× ATR" to "1.5× ATR" or "2× volume" to "1.5× volume" is **not** a new hypothesis; it is exactly the parameter-tweak path the evaluation framework was designed to forbid. The trigger thresholds were chosen because they operationalized the word "capitulation" — softening them turns it into a different (and untheorized) trade idea.

---

## 4. Funding-Regime Compression Breakout (NR7 + breakout, gated by funding-percentile regime)

**Hypothesis:** funding rate in the bottom 10th percentile of its trailing 90-day distribution identifies a crowded-shorts regime; an NR7 compression bar followed by a breakout above its high provides the entry timing for the resulting squeeze. Funding is used as a context filter (regime), not a direct trigger; price action determines when the squeeze begins. The claim is specifically that the *conjunction* (funding regime + compression breakout) has positive edge while either signal alone does not.

**Rules summary:**
- Funding regime gate: at the post-funding 1h bar close, cum7d (sum of last 21 funding rates) is in the bottom 10th percentile of trailing 90-day distribution. Same metric / threshold as the prior funding-trigger study; here used as a filter that gates entry rather than as the entry itself.
- Compression: NR7 bar (range strictly less than each of the prior 6 bars).
- Breakout confirmation: `close[T+1] > high[T]`.
- Spot regime gate: latest completed daily close > daily MA(50).
- Entry: at the close of T+1.
- Stop: low of T (the NR7 bar).
- Exits: BE at +1R, prior-bar-low trail at +2R, 48-bar time stop, no fixed profit target.
- Risk: $25 notional, one position at a time, existing daily loss cap, existing streak damper.

**Datasets tested:** 4 datasets (BTC current 12mo, ETH current 12mo, BTC prior 12mo, ETH prior 12mo) × 2 cost levels (20 / 30 bps) × 2 modes (filter on / filter off ablation) = 16 runs. Funding source: Binance USDT-margined perpetual archive (`data.binance.vision`), 2024-01-29 → 2026-03-31.

**Filter ON (full strategy):**

| Run | Trades | W / L | Win rate | Realized R:R | Expectancy / trade | Net P/L | PF | Max DD |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ETH current @ 20 bps | 10 | 2 / 8  | 20.0 % | 3.84 : 1 | −$0.000 |  −$0.00 | 1.00 | $1.18 |
| ETH current @ 30 bps | 10 | 2 / 8  | 20.0 % | 3.32 : 1 | −$0.019 |  −$0.19 | 0.88 | $1.32 |
| BTC current @ 20 bps |  5 | 2 / 3  | 40.0 % | 0.99 : 1 | −$0.097 |  −$0.48 | 0.35 | $0.74 |
| BTC current @ 30 bps |  5 | 1 / 4  | 20.0 % | 2.16 : 1 | −$0.091 |  −$0.46 | 0.33 | $0.68 |
| ETH prior   @ 20 bps |  0 | 0 / 0  |  —     |  —       |  —      |  $0.00 |  —   | $0.00 |
| ETH prior   @ 30 bps |  0 | 0 / 0  |  —     |  —       |  —      |  $0.00 |  —   | $0.00 |
| BTC prior   @ 20 bps | 19 | 5 / 13 | 27.8 % | 2.60 : 1 | −$0.017 |  −$0.31 | 0.84 | $1.06 |
| BTC prior   @ 30 bps | 19 | 4 / 14 | 22.2 % | 2.92 : 1 | −$0.035 |  −$0.63 | 0.70 | $1.22 |

**Filter OFF (ablation = compression breakout + spot regime gate only):**

| Run | Trades | Expectancy / trade | Δ vs filter ON | Filter helped? |
|---|---:|---:|---:|:---:|
| ETH current @ 20 bps | 147 | −$0.009 | +$0.0086 | ✅ helps marginally |
| ETH current @ 30 bps | 147 | −$0.025 | +$0.0058 | ✅ helps marginally |
| BTC current @ 20 bps | 120 | −$0.012 | −$0.0847 | ❌ filter is *worse* |
| BTC current @ 30 bps | 120 | −$0.026 | −$0.0658 | ❌ filter is *worse* |
| ETH prior   @ 20 bps |  78 | −$0.060 | not testable (0 trades with filter) | n/a |
| ETH prior   @ 30 bps |  78 | −$0.076 | not testable | n/a |
| BTC prior   @ 20 bps | 151 | −$0.008 | −$0.0088 | ❌ filter is *worse* |
| BTC prior   @ 30 bps | 151 | −$0.025 | −$0.0105 | ❌ filter is *worse* |

The funding filter helped marginally on ETH-current at both cost levels but **hurt** results on BTC at both periods and both cost levels (delta from −$0.0088 to −$0.0847 per trade vs ablation). On ETH-prior the filter produced 0 trades, so no comparison is possible.

**Pre-registered gates** (locked in proposal before any code was written):

| # | Gate | Result |
|---|---|:---:|
| 1 | ≥ 80 closed trades on each of BTC × 12mo and ETH × 12mo (filter on) | ❌ **FAIL** — current 10 (ETH) / 5 (BTC); prior 0 (ETH) / 19 (BTC); no dataset clears 80 |
| 2 | Positive expectancy on **both** BTC and ETH at 30 bps (filter on) | ❌ **FAIL** — every measurable cell is negative |
| 3 | No sign-flip BTC vs ETH at the same cost level (filter on) | ⚠️ technically holds because every cell is negative; ETH prior has 0 trades and is not testable |
| 4 | No sign-flip current vs prior on the same symbol (filter on) | BTC: −$0.091 vs −$0.035 at 30 bps — both negative, no sign-flip. ETH: not testable (0 prior trades) |
| 5 | **Ablation: full strategy must outperform compression-breakout-only on both symbols at both cost levels** | ❌ **FAIL** — funding filter is *worse* than ablation on every BTC dataset |

**Verdict: ABANDONED 2026-04-29.**

The strategy fails gates 1, 2, and 5. Gates 3 and 4 hold trivially because every measurable cell is negative; passing those gates by way of "uniformly negative" is not a partial credit. The load-bearing gate for this strategy was gate 5 (ablation) — the entire reason for separating funding (regime filter) from price (timing trigger) was the claim that the conjunction would outperform either alone. The data shows the opposite on BTC: the funding filter cuts trade frequency dramatically without an offsetting increase in per-trade expectancy, and on BTC the filter actively makes results worse than the ablation that has no funding signal at all.

**Do not revive without:** a fundamentally new funding or positioning hypothesis. Specifically forbidden as not-a-new-hypothesis:
- Changing the NR window (NR4, NR5, NR8, etc.).
- Changing the funding percentile threshold (5 %, 15 %, 20 %, etc.).
- Changing the time stop (24 bars, 36 bars, 72 bars, etc.).
- Loosening the regime gate.
- Adding additional confirmation filters (volume, RSI, etc.) to "fix" the BTC underperformance.

The ablation result on BTC says the funding signal is not adding edge in the form tested. A new funding-based study must propose a different *mechanism* — for example, open interest changes, funding-rate term structure across exchanges, or premium-of-perp-vs-spot — and lock its own gates before any code. Tweaking the operationalization of cum7d or the entry pattern around it is the parameter-fishing path the evaluation framework was specifically built to refuse.

---

## Cross-strategy summary

Four strategies tested over real Coinbase BTC and ETH data, 2024-04 → 2026-04, multiple cost levels, multiple timeframes; funding-aware strategies use Binance USDT-perp funding history from `data.binance.vision`:

| Strategy | Best run | Cleared 80 trades | Survived 30 bps | Cross-symbol consistent | Cross-period consistent |
|---|---|:---:|:---:|:---:|:---:|
| Pullback | ETH 1h baseline +$0.105/trade (n=21) | 1 of 6 base runs | ❌ | not testable (n) | not testable (n) |
| Momentum | ETH 1h current +$0.063/trade (n=108) | 4 of 4 1h runs | partial (1 of 3) | ❌ | ❌ |
| Capitulation | ETH 1h +$0.004/trade (n=14) | 0 of 2 runs | ❌ | ❌ | not testable (n) |
| Funding-Regime Compression Breakout | ETH current −$0.000/trade (n=10) at 20 bps | 0 of 4 runs | ❌ | technically (all negative) | not testable on ETH; both negative on BTC |

**No strategy in this study has demonstrated edge.** Each had at least one cell that looked best in isolation; none generalized. This is the framework working as designed — most "edges" in retail backtests are regime-specific or sample-noise artifacts, and the cross-dataset gate is what surfaces that.

The honest message of this graveyard: **stop pattern-guessing strategies. Next attempt should start from a hypothesis that has a clearly stated mechanical or behavioral mechanism, with a falsification protocol locked before any rules are written.** The capitulation strategy did this and still failed — but it failed *cleanly* (the hypothesis was right, the operationalization was wrong), which is more useful than the pullback or momentum failures.

---

## Process rules going forward

These are non-negotiable, derived from this graveyard:

1. **No strategy gets coded without a hypothesis-and-falsification proposal first.** Mechanism, market condition targeted, generalization argument, and falsification gates all locked in writing before the first line of code.
2. **No mid-run tuning.** If a strategy produces unexpected results, complete the run, document, and propose changes as a new strategy with a new hypothesis. Do not edit thresholds during a study.
3. **Cross-dataset gates are mandatory.** No edge claim from a single (symbol × period × timeframe) cell. Minimum two non-overlapping windows on each of BTC and ETH at the same cost level.
4. **Cost-line stress is mandatory.** A strategy is not validated unless its sign of expectancy survives a 10 bps cost shift above the chosen baseline.
5. **The gates from a failed study cannot be relaxed for the next study without an explicit, written reason.** Saying "this strategy is different" is not a reason. The gates exist precisely because every strategy looks different to its author.
6. **A strategy that fails its own pre-registered gates is abandoned.** Period. Re-running the same strategy with a different parameter is not a new study; it is a fishing expedition this graveyard was designed to prevent.

---

*Last updated: 2026-04-29 (added section 4: Funding-Regime Compression Breakout).*
*This file is append-only for new strategy results. Existing entries are not edited.*
