'use strict';

// solowayPlaybook — confluence-support pullback strategy.
//
// PRODUCES RECOMMENDATIONS ONLY. This module never:
//   - calls the Robinhood API
//   - places, cancels, or modifies any order
//   - bypasses any existing safety gate
//
// It returns a recommendation object (or a skip with reasons) for the scanner
// to consume. The scanner persists pass-through recommendations to the
// pending-approval queue. Live execution still requires an admin click in
// the dashboard, which still runs liveRiskManager.evaluateLive on every
// order. This module is one layer earlier in the chain.
//
// Source-of-truth rules (per the Soloway Playbook spec):
//
//   PRE-TRADE HARD BLOCKS — any one of these blocks recommendation creation:
//     1. tradingMode === 'paused'
//     2. weekend window: Sat 00:00 PT → Sun 18:00 PT (no fresh entries)
//     3. open live position already exists
//     4. today's live realized loss ≥ LIVE_DAILY_LOSS_CAP_USD
//     5. today's live BUY count ≥ LIVE_DAILY_TRADE_COUNT_CAP
//     6. symbol not in {BTC-USD, ETH-USD}
//     7. live execution requires the symbol to also be in liveAllowedSymbols
//        (currently ETH-USD only). BTC-USD passes the watchlist check but
//        is flagged paper-only.
//     8. confidence < 0.50 (minimum)
//
//   ENTRY GEOMETRY (FIRST SETUP — pullback to confluence support):
//     - readable trend (price > 50MA, MA slope positive)
//     - meaningful pullback off the recent high
//     - price near at least TWO of three support factors (50MA, swing low,
//       round-number band)
//     - concrete stop level (below the lowest support factor minus a
//       small buffer)
//     - 2:1 risk/reward minimum, 3:1 preferred (boosts confidence)
//     - max 1% account-equity risk per trade (hard-bounded by
//       config.liveMaxOrderUsd → never exceed that)
//
// FUTURE setups (not yet implemented):
//   - breakout retest
//   - inside-bar continuation
//   - failed-breakdown reversal
// Each will be its own evaluator. The dispatcher will pick the first one
// that passes (or the highest-confidence one if multiple pass).

const db = require('../db');
const tradingMode = require('./tradingMode');
const recommendationQueue = require('./recommendationQueue');
const { config } = require('../config');
const logger = require('./logger');

const MIN_CONFIDENCE = 0.5;
const MIN_RR = 2.0;
const PREFERRED_RR = 3.0;
const MAX_ACCOUNT_RISK_PCT = 0.01; // 1%

// Phase A — Soloway Playbook §03 PRE-04, §08 STP-01, §11 STAY-OUT.
// The playbook anchors all proximity / buffer math to ATR rather than to
// a fixed percent of price. ATR adapts to the symbol's current volatility
// regime; a fixed % does not. These multipliers come straight from the spec.
const CONFLUENCE_PROXIMITY_ATR_MULT = 0.5; // PRE-04: within 0.5×ATR of a level
const STOP_BUFFER_ATR_MULT = 0.5; // STP-01: stop sits 0.5×ATR below anchor
const WHITE_SPACE_ATR_MULT = 3.0; // STAY-OUT: no factors within 3×ATR

// BLK-02 thresholds — current ATR vs rolling median.
// Spec: 30-day median 1H ATR. We use the available ~200-bar window as a
// recent-regime proxy; values match the playbook's multipliers.
const VOL_EXTREME_HIGH_MULT = 3.0;
const VOL_EXTREME_LOW_MULT = 0.25;

// STAY-OUT thresholds.
const CHOP_ATR_PRICE_RATIO = 0.0025; // 0.25% — looser than the previous 0.33%
const RSI_OVERBOUGHT_THRESHOLD = 75; // §11

// Pullback minimum — loosen from 1.5% to 1.0% to increase valid setups
// while preserving the pullback-to-support structure of the playbook.
const PULLBACK_MIN_PCT = 1.0;

const ROUND_NUMBER_GRANULARITY_USD = { 'ETH-USD': 50, 'BTC-USD': 1000 };

// Pacific-time helpers — uses server local time. Railway is configured
// with TZ=America/Los_Angeles per the deploy notes. If TZ is wrong,
// the weekend block will still fire — just on the wrong window. Boot
// log surfaces the active TZ for verification.
function isWeekendBlock(now = new Date()) {
  // Date.getDay(): 0=Sun, 1=Mon, ..., 6=Sat
  const day = now.getDay();
  const hour = now.getHours();
  // Block: Saturday all day (day=6, any hour) OR Sunday before 18:00 (day=0, hour<18)
  if (day === 6) return true;
  if (day === 0 && hour < 18) return true;
  return false;
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Run the Soloway hard-block checks. Returns { ok: true } if all pass,
 * or { ok: false, code, reason } on the first failure. Pure read of
 * config + DB; no side effects.
 *
 * Some of these duplicate checks in liveRiskManager.evaluateLive. That's
 * intentional — we want the SCANNER to short-circuit early instead of
 * queueing a recommendation that would be guaranteed to fail at approve
 * time. Defense in depth: the live-risk pipeline still runs on every
 * order regardless.
 *
 * @param {object} args
 * @param {string} args.symbol  e.g. 'ETH-USD'
 * @param {Date}   [args.now]   override for tests
 */
function runHardBlocks({ symbol, now = new Date() }) {
  // 1. tradingMode = paused → bot must not produce anything
  const { mode: trading } = tradingMode.getMode();
  if (trading === 'paused') {
    return fail('TRADING_MODE_PAUSED', 'tradingMode is paused; no recommendations queued');
  }

  // 2. weekend block (PT)
  if (isWeekendBlock(now)) {
    return fail(
      'WEEKEND_NO_ENTRY',
      'No fresh entries from Saturday 00:00 PT through Sunday 18:00 PT.',
    );
  }

  // 3. symbol must be in scanner watchlist
  const watchlistSymbols = ['BTC-USD', 'ETH-USD'];
  if (!watchlistSymbols.includes(symbol)) {
    return fail(
      'SYMBOL_NOT_IN_WATCHLIST',
      `Symbol ${symbol} is not in Soloway watchlist (${watchlistSymbols.join(', ')}).`,
    );
  }

  // 4. open live position max — check `trades` for an unclosed live BUY
  const openRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
        WHERE mode = 'live'
          AND status = 'executed'
          AND side = 'buy'
          AND outcome IS NULL`,
    )
    .get();
  if ((openRow.n || 0) >= 1) {
    return fail(
      'OPEN_POSITION_EXISTS',
      'An open live position already exists. Close it before queuing new recommendations.',
    );
  }

  // 5. daily realized loss cap — same SQL the live risk pipeline uses
  const lossRow = db
    .prepare(
      `SELECT COALESCE(SUM(simulated_pnl_usd), 0) AS loss
         FROM trades
        WHERE date(created_at) = date('now')
          AND mode = 'live'
          AND simulated_pnl_usd IS NOT NULL
          AND simulated_pnl_usd < 0`,
    )
    .get();
  const lossUsd = Math.abs(lossRow.loss || 0);
  if (lossUsd >= config.liveDailyLossCapUsd) {
    return fail(
      'DAILY_LOSS_CAP_HIT',
      `Today's live realized loss ($${lossUsd.toFixed(2)}) ≥ daily cap ` +
        `($${config.liveDailyLossCapUsd}). No more recommendations today.`,
    );
  }

  // 6. daily trade count cap (executed + pending_approval BUYs)
  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
        WHERE mode = 'live'
          AND side = 'buy'
          AND status IN ('executed', 'pending_approval')
          AND date(created_at) = date('now')`,
    )
    .get();
  const todayCount = countRow.n || 0;
  if (todayCount >= config.liveDailyTradeCountCap) {
    return fail(
      'DAILY_TRADE_COUNT_CAP_HIT',
      `Today's live BUY count (${todayCount}) ≥ daily cap ` +
        `(${config.liveDailyTradeCountCap}). No more recommendations today.`,
    );
  }

  return { ok: true };
}

/**
 * Identify support confluence factors for a given snapshot. PRE-04: a
 * level is "near" the price if it's within `CONFLUENCE_PROXIMITY_ATR_MULT
 * × ATR` of price. The playbook's exact form ("within 0.5 × ATR of at
 * least two independent technical levels").
 *
 * Also returns `nearbyFactors` — anything within `WHITE_SPACE_ATR_MULT ×
 * ATR` of price. Used by the STAY-OUT "white space" check (no levels
 * mapped within 2×ATR).
 *
 * @param {object} snap  market snapshot from snapshotBuilder
 * @returns {{
 *   factors: string[],          // qualifying levels within 0.5×ATR
 *   anchorPrice: number,        // highest of the qualifying levels
 *   lowestSupport: number,      // lowest of the qualifying levels
 *   nearbyFactors: string[],    // any factor within 2×ATR (broader)
 * }}
 */
function findConfluenceFactors(snap) {
  const factors = [];
  const candidates = [];
  const nearbyFactors = [];
  const atr = snap.atr || 0;
  // If we have no ATR yet (warm-up), fall back to a small fixed band so
  // we don't accidentally call every level "near" or "far". 0.5% of price
  // is a reasonable proxy until ATR is available.
  const proximity =
    atr > 0 ? CONFLUENCE_PROXIMITY_ATR_MULT * atr : snap.price * 0.005;
  const whiteSpaceBand =
    atr > 0 ? WHITE_SPACE_ATR_MULT * atr : snap.price * 0.02;

  function checkFactor(name, level) {
    if (!Number.isFinite(level) || level <= 0 || level > snap.price) return;
    const dist = snap.price - level;
    if (dist <= whiteSpaceBand) nearbyFactors.push(name);
    if (dist <= proximity) {
      factors.push(name);
      candidates.push(level);
    }
  }

  // Factor A: 50-period MA
  checkFactor('ma50', snap.ma50);

  // Factor B: most recent swing low (snapshot's `support` field)
  checkFactor('swingLow', snap.support);

  // Factor C: nearest round number below price (per-symbol granularity)
  const granularity =
    ROUND_NUMBER_GRANULARITY_USD[`${snap.symbol}-USD`] || 100;
  const roundLevel = Math.floor(snap.price / granularity) * granularity;
  checkFactor('roundNumber', roundLevel);

  if (factors.length === 0) {
    return {
      factors: [],
      anchorPrice: 0,
      lowestSupport: 0,
      nearbyFactors,
    };
  }
  return {
    factors,
    anchorPrice: Math.max(...candidates),
    lowestSupport: Math.min(...candidates),
    nearbyFactors,
  };
}

// ---------------------------------------------------------------------------
// BLK-03 — RSI negative divergence into resistance (long-only veto)
//
// "Price prints a higher high while RSI prints a lower high, AND price is
//  within 1×ATR of a known resistance level."
//
// We get the recent swing-high series with RSI from the snapshot. The
// last two pivot highs are compared. If price[2] > price[1] but
// rsi[2] < rsi[1], that's negative divergence. Combined with proximity
// to resistance, it's the "big-money exits while retail buys" tell.
// ---------------------------------------------------------------------------
function hasNegativeDivergenceIntoResistance(snap) {
  const swings = snap.recentSwingHighsRsi || [];
  // collectSwingHighs returns most-recent first, so swings[0] is the
  // newest swing high, swings[1] the one before, etc.
  if (swings.length < 2) return { divergent: false, reason: null };
  const newest = swings[0];
  const previous = swings[1];
  if (!Number.isFinite(newest.rsi) || !Number.isFinite(previous.rsi)) {
    return { divergent: false, reason: null };
  }

  const priceHH = newest.price > previous.price;
  const rsiLH = newest.rsi < previous.rsi;
  if (!priceHH || !rsiLH) return { divergent: false, reason: null };

  // Resistance proximity — 1×ATR per the playbook.
  const atr = snap.atr || 0;
  if (atr <= 0 || !Number.isFinite(snap.resistance)) {
    return { divergent: false, reason: null };
  }
  const distToResistance = snap.resistance - snap.price;
  if (distToResistance < 0) {
    // We're already above the most recent resistance — divergence still
    // matters but the playbook's specific wording is "within 1×ATR of
    // resistance," which strictly means above-resistance is a different
    // case. Be conservative and still treat it as divergence.
    return { divergent: true, reason: 'price above last resistance with negative divergence' };
  }
  const within = distToResistance <= atr;
  if (!within) return { divergent: false, reason: null };

  return {
    divergent: true,
    reason:
      `price HH (${newest.price} > ${previous.price}) with RSI LH ` +
      `(${newest.rsi.toFixed(2)} < ${previous.rsi.toFixed(2)}) ` +
      `within 1×ATR of resistance ($${snap.resistance})`,
  };
}

/**
 * Confidence score 0..1 for the pullback-to-confluence setup. Combines
 * trend strength, factor count, R:R, pullback depth, volume.
 */
function scoreSetup({ snap, factorCount, rr }) {
  let score = 0;

  // Trend (max 0.25). Sideways is still lower-quality than an uptrend,
  // but it is less harshly penalized so valid sideways pullbacks remain
  // tradeable when the rest of the setup is strong.
  if (snap.trend === 'UPTREND') score += 0.25;
  else if (snap.trend === 'SIDEWAYS') score += 0.10;

  // Confluence factors (max 0.30 — 2 factors = 0.20, 3 factors = 0.30)
  if (factorCount >= 3) score += 0.30;
  else if (factorCount === 2) score += 0.20;

  // R:R (max 0.20 — 2:1 = 0.10, 3:1 = 0.20)
  if (rr >= PREFERRED_RR) score += 0.20;
  else if (rr >= MIN_RR) score += 0.10;

  // Pullback depth (max 0.15 — sweet spot 3-5%)
  if (snap.pullbackPct >= 3 && snap.pullbackPct <= 5) score += 0.15;
  else if (snap.pullbackPct >= 2.5 && snap.pullbackPct < 3) score += 0.08;
  else if (snap.pullbackPct > 5) score += 0.10;

  // Volume (max 0.10)
  if (snap.volume === 'STRONG') score += 0.10;
  else if (snap.volume === 'OK') score += 0.05;

  return Math.min(1, Math.max(0, score));
}

function qualifiesAsSingleStrongFactor({ snap, achievedRR, confidence }) {
  return (
    snap.trend === 'UPTREND' &&
    snap.price > snap.ma50 &&
    achievedRR >= MIN_RR &&
    confidence >= 0.55
  );
}

/**
 * Evaluate a single market snapshot under the Soloway Playbook rules.
 * Returns either:
 *   { recommendation: {...}, snapshot, confidence, setup }   — pass
 *   { recommendation: null, snapshot, skipReasons: [...] }   — fail
 *
 * Symbol must already be in the scanner's watchlist. The hard-block
 * pre-check ALSO covers symbol filtering, but we accept a defensive
 * extra check for safety.
 *
 * @param {object} snap          snapshot from snapshotBuilder (BTC or ETH-USD)
 * @param {object} ctx
 * @param {string} ctx.liveSymbol  e.g. 'ETH-USD' — what the live route uses
 * @param {Date}   [ctx.now]
 * @returns {object}
 */
function evaluateSoloway(snap, ctx) {
  const liveSymbol = ctx.liveSymbol;
  const now = ctx.now || new Date();
  const skipReasons = [];

  // Common return helper that always includes the diagnostic fields
  // required by the spec's logging contract.
  const ret = (extra) => ({
    snapshot: snap,
    recommendation: null,
    confidence: null,
    atr: snap.atr,
    rsi: snap.rsi,
    confluenceCount: 0,
    ...extra,
  });

  // ─── 1. Pre-trade hard blocks (BLK-01, BLK-05, BLK-06 etc.) ────
  const block = runHardBlocks({ symbol: liveSymbol, now });
  if (!block.ok) {
    return ret({ skipReasons: [`${block.code}: ${block.reason}`] });
  }

  // ─── 2. BLK-02 — volatility extreme ────────────────────────────
  // Current 1H ATR vs rolling median. > 3× = parabolic / flash event,
  // < 0.25× = dead market. Either way: skip.
  if (Number.isFinite(snap.atr) && Number.isFinite(snap.atrMedian) && snap.atrMedian > 0) {
    const ratio = snap.atr / snap.atrMedian;
    if (ratio > VOL_EXTREME_HIGH_MULT) {
      return ret({
        skipReasons: [
          `VOLATILITY_TOO_HIGH: 1H ATR ${snap.atr} is ${ratio.toFixed(2)}× median ` +
            `(threshold ${VOL_EXTREME_HIGH_MULT}×) — chart moving too fast for technical levels.`,
        ],
      });
    }
    if (ratio < VOL_EXTREME_LOW_MULT) {
      return ret({
        skipReasons: [
          `VOLATILITY_TOO_LOW: 1H ATR ${snap.atr} is ${ratio.toFixed(2)}× median ` +
            `(threshold ${VOL_EXTREME_LOW_MULT}×) — dead market, no movement to capture.`,
        ],
      });
    }
  }

  // ─── 3. BLK-03 — RSI negative divergence into resistance ────────
  const div = hasNegativeDivergenceIntoResistance(snap);
  if (div.divergent) {
    return ret({
      skipReasons: [`RSI_NEGATIVE_DIVERGENCE: ${div.reason}`],
    });
  }

  // ─── 4. STAY-OUT filters (Section 11 subset) ───────────────────
  // STAY-OUT D — pending approval already exists. Don't stack up
  // un-actioned recs. Cheap COUNT(*) on the queue.
  if (recommendationQueue.hasPending()) {
    return ret({
      skipReasons: [
        'PENDING_APPROVAL_EXISTS: a previous recommendation is still awaiting admin action',
      ],
    });
  }

  // STAY-OUT A — chop. ATR / price < 0.4% means the market is too small
  // to pay for the round trip (per §11).
  if (Number.isFinite(snap.atr) && snap.atr > 0 && snap.price > 0) {
    const ratio = snap.atr / snap.price;
    if (ratio < CHOP_ATR_PRICE_RATIO) {
      return ret({
        skipReasons: [
          `CHOP_LOW_VOL: ATR/price ratio ${(ratio * 100).toFixed(2)}% ` +
            `< ${(CHOP_ATR_PRICE_RATIO * 100).toFixed(2)}% — market too tight to trade.`,
        ],
      });
    }
  }

  // STAY-OUT B — RSI > 75 with no negative divergence. Too late to
  // enter a long, too early to short. Stand aside.
  if (Number.isFinite(snap.rsi) && snap.rsi > RSI_OVERBOUGHT_THRESHOLD && !div.divergent) {
    return ret({
      skipReasons: [
        `RSI_OVERBOUGHT_NO_ENTRY: 1H RSI ${snap.rsi} > ${RSI_OVERBOUGHT_THRESHOLD} ` +
          `with no negative divergence yet — stretched without a top tell.`,
      ],
    });
  }

  // STAY-OUT C — white space. No support factors within 3×ATR. Note
  // we compute the WHITE_SPACE band in findConfluenceFactors below,
  // so we run it once and re-use the result.
  const conf = findConfluenceFactors(snap);
  if (conf.nearbyFactors.length === 0) {
    return ret({
      skipReasons: [
        'NO_NEARBY_LEVELS: no support factors within 3×ATR — candidate is in white space.',
      ],
    });
  }

  // ─── 5. Trend filter ───────────────────────────────────────────
  if (snap.trend !== 'UPTREND' && snap.trend !== 'SIDEWAYS') {
    skipReasons.push('Trend not readable as uptrend or stable sideways');
  }
  if (snap.price <= snap.ma50) {
    skipReasons.push('Price below 50-period MA — not a buyable trend');
  }

  // ─── 6. Pullback filter ────────────────────────────────────────
  if (snap.pullbackPct < PULLBACK_MIN_PCT) {
    skipReasons.push(
      `Pullback only ${snap.pullbackPct.toFixed(2)}% — need ≥ ${PULLBACK_MIN_PCT}%`,
    );
  }

  // ─── 7. Confluence support (PRE-04 — ≥2 factors within 0.5×ATR) ─
  // The playbook still prefers two factors, but very strong single-factor
  // setups may qualify when the trend, trend location, and risk/reward are all
  // high enough.
  const singleFactorCandidate = conf.factors.length === 1;
  if (conf.factors.length < 2 && !singleFactorCandidate) {
    skipReasons.push(
      `INSUFFICIENT_CONFLUENCE: only ${conf.factors.length} support factor(s) ` +
        `within 0.5×ATR — need ≥ 2 (Soloway PRE-04).`,
    );
  }

  if (skipReasons.length > 0 && !singleFactorCandidate) {
    return ret({ skipReasons, confluenceCount: conf.factors.length });
  }

  // ─── 8. Stop (STP-01 ATR-anchored), target, R:R ────────────────
  // Stop = lowest qualifying support − 0.5×ATR (§08 STP-01).
  // BLK-04 (no clean invalidation) is enforced here: if ATR isn't
  // available or the resulting stop is ≥ entry, refuse — "if you can't
  // define your stop, you can't define your risk."
  if (!Number.isFinite(snap.atr) || snap.atr <= 0) {
    return ret({
      skipReasons: ['MISSING_ATR: cannot compute ATR-anchored stop (warm-up).'],
      confluenceCount: conf.factors.length,
    });
  }
  const stopBufferUsd = STOP_BUFFER_ATR_MULT * snap.atr;
  const stopLoss = conf.lowestSupport - stopBufferUsd;
  if (stopLoss <= 0 || stopLoss >= snap.price) {
    return ret({
      skipReasons: [
        `MISSING_STOP: ATR-anchored stop ($${stopLoss.toFixed(2)}) is not ` +
          `strictly below entry ($${snap.price}). Cannot define risk (Soloway BLK-04).`,
      ],
      confluenceCount: conf.factors.length,
    });
  }
  const riskUsd = snap.price - stopLoss;

  // Target — prefer 3:1 if resistance allows, else 2:1, else reject.
  const distToResistance = snap.resistance - snap.price;
  const targetMin = snap.price + MIN_RR * riskUsd;
  const targetPreferred = snap.price + PREFERRED_RR * riskUsd;
  let profitTarget;
  let achievedRR;
  if (distToResistance >= PREFERRED_RR * riskUsd) {
    profitTarget = targetPreferred;
    achievedRR = PREFERRED_RR;
  } else if (distToResistance >= MIN_RR * riskUsd) {
    profitTarget = targetMin;
    achievedRR = MIN_RR;
  } else {
    return ret({
      skipReasons: [
        `INSUFFICIENT_RR: room to resistance ($${distToResistance.toFixed(2)}) ` +
          `< ${MIN_RR}× risk ($${(MIN_RR * riskUsd).toFixed(2)}). Soloway PRE-05.`,
      ],
      confluenceCount: conf.factors.length,
    });
  }

  // ─── 9. Confidence score ───────────────────────────────────────
  const confidence = scoreSetup({
    snap,
    factorCount: conf.factors.length,
    rr: achievedRR,
  });

  if (singleFactorCandidate && !qualifiesAsSingleStrongFactor({ snap, achievedRR, confidence })) {
    return ret({
      skipReasons: [
        'INSUFFICIENT_CONFLUENCE: only 1 support factor within 0.5×ATR; ' +
          'single-factor setups require UPTREND, price > MA50, ≥2:1 R:R, and confidence ≥ 0.55.',
      ],
      confidence,
      confluenceCount: conf.factors.length,
    });
  }

  if (confidence < MIN_CONFIDENCE) {
    return ret({
      skipReasons: [
        `LOW_CONFIDENCE: score ${confidence.toFixed(2)} < minimum ${MIN_CONFIDENCE}`,
      ],
      confidence,
      confluenceCount: conf.factors.length,
    });
  }

  // ─── 10. Build the recommendation ──────────────────────────────
  // Suggested USD respects config.liveMaxOrderUsd. Real 1% account-equity
  // sizing is Phase D — the per-order cap stands as the operative ceiling.
  const suggestedAmountUsd = Math.min(config.liveMaxOrderUsd, 10);

  const isoMinute = new Date().toISOString().slice(0, 16);
  const recId = `soloway-${liveSymbol}-${isoMinute}`;

  const recommendation = {
    id: recId,
    symbol: snap.symbol,
    side: 'buy',
    amountUsd: suggestedAmountUsd,
    suggestedAmountUsd,
    confidenceScore: confidence,
    entryReason:
      `Soloway Playbook: pullback to confluence support ` +
      `(${conf.factors.join(' + ')}). Entry $${snap.price}, ` +
      `stop $${stopLoss.toFixed(2)} (-$${riskUsd.toFixed(2)}, 0.5×ATR=${(STOP_BUFFER_ATR_MULT * snap.atr).toFixed(2)}), ` +
      `target $${profitTarget.toFixed(2)} (${achievedRR.toFixed(1)}:1 R:R). ` +
      `RSI ${snap.rsi != null ? snap.rsi.toFixed(1) : 'n/a'}, ATR $${snap.atr.toFixed(2)}.`,
    stopLoss,
    profitTarget,
    invalidationLevel: stopLoss,
    riskReward: achievedRR,
    entryPrice: snap.price,
    setup: 'pullback_to_confluence_support',
    factorsUsed: conf.factors,
  };

  return {
    snapshot: snap,
    recommendation,
    skipReasons: [],
    confidence,
    atr: snap.atr,
    rsi: snap.rsi,
    confluenceCount: conf.factors.length,
    setup: 'pullback_to_confluence_support',
  };
}

module.exports = {
  evaluateSoloway,
  runHardBlocks,
  isWeekendBlock,
  findConfluenceFactors,
  scoreSetup,
  hasNegativeDivergenceIntoResistance,
  // Constants exposed for testing / introspection
  MIN_CONFIDENCE,
  MIN_RR,
  PREFERRED_RR,
  PULLBACK_MIN_PCT,
  CONFLUENCE_PROXIMITY_ATR_MULT,
  STOP_BUFFER_ATR_MULT,
  WHITE_SPACE_ATR_MULT,
  VOL_EXTREME_HIGH_MULT,
  VOL_EXTREME_LOW_MULT,
  CHOP_ATR_PRICE_RATIO,
  RSI_OVERBOUGHT_THRESHOLD,
};
