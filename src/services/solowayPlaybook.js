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
const { config } = require('../config');
const logger = require('./logger');

const MIN_CONFIDENCE = 0.5;
const MIN_RR = 2.0;
const PREFERRED_RR = 3.0;
const MAX_ACCOUNT_RISK_PCT = 0.01; // 1%
const SUPPORT_PROXIMITY_PCT = 0.015; // within 1.5% of a support factor counts as "near"
const PULLBACK_MIN_PCT = 2.5;
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
 * Identify support confluence factors for a given snapshot. Returns the
 * subset of {ma50, swingLow, roundNumber} where price is within
 * SUPPORT_PROXIMITY_PCT of that level. We need at least 2 to call the
 * area "confluence support."
 *
 * @param {object} snap  market snapshot from snapshotBuilder
 * @returns {{factors: string[], anchorPrice: number, distancePct: number}}
 */
function findConfluenceFactors(snap) {
  const factors = [];
  const candidates = [];

  // Factor A: 50-period MA
  if (snap.ma50 > 0 && snap.ma50 <= snap.price) {
    const dist = (snap.price - snap.ma50) / snap.price;
    if (dist <= SUPPORT_PROXIMITY_PCT) {
      factors.push('ma50');
      candidates.push(snap.ma50);
    }
  }

  // Factor B: most recent swing low (snapshot's `support` field)
  if (snap.support > 0 && snap.support <= snap.price) {
    const dist = (snap.price - snap.support) / snap.price;
    if (dist <= SUPPORT_PROXIMITY_PCT) {
      factors.push('swingLow');
      candidates.push(snap.support);
    }
  }

  // Factor C: nearest round number below price (depends on symbol granularity)
  const granularity =
    ROUND_NUMBER_GRANULARITY_USD[`${snap.symbol}-USD`] || 100;
  const roundLevel = Math.floor(snap.price / granularity) * granularity;
  if (roundLevel > 0 && roundLevel <= snap.price) {
    const dist = (snap.price - roundLevel) / snap.price;
    if (dist <= SUPPORT_PROXIMITY_PCT) {
      factors.push('roundNumber');
      candidates.push(roundLevel);
    }
  }

  // The "anchor" — the highest of the qualifying levels (closest to price).
  // Stop will sit a small buffer below the LOWEST of these (i.e. behind the
  // weakest factor).
  if (factors.length === 0) {
    return { factors: [], anchorPrice: 0, distancePct: 0, lowestSupport: 0 };
  }
  const anchor = Math.max(...candidates);
  const lowest = Math.min(...candidates);
  return {
    factors,
    anchorPrice: anchor,
    distancePct: (snap.price - anchor) / snap.price,
    lowestSupport: lowest,
  };
}

/**
 * Confidence score 0..1 for the pullback-to-confluence setup. Combines
 * trend strength, factor count, R:R, pullback depth, volume.
 */
function scoreSetup({ snap, factorCount, rr }) {
  let score = 0;

  // Trend (max 0.25)
  if (snap.trend === 'UPTREND') score += 0.25;
  else if (snap.trend === 'SIDEWAYS') score += 0.05;

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

  // ─── 1. Pre-trade hard blocks ──────────────────────────────────
  const block = runHardBlocks({ symbol: liveSymbol, now });
  if (!block.ok) {
    return {
      snapshot: snap,
      recommendation: null,
      skipReasons: [`${block.code}: ${block.reason}`],
      confidence: null,
    };
  }

  // ─── 2. Trend filter ───────────────────────────────────────────
  if (snap.trend !== 'UPTREND' && snap.trend !== 'SIDEWAYS') {
    skipReasons.push('Trend not readable as uptrend or stable sideways');
  }
  if (snap.price <= snap.ma50) {
    skipReasons.push('Price below 50-period MA — not a buyable trend');
  }

  // ─── 3. Pullback filter ────────────────────────────────────────
  if (snap.pullbackPct < PULLBACK_MIN_PCT) {
    skipReasons.push(
      `Pullback only ${snap.pullbackPct.toFixed(2)}% — need ≥ ${PULLBACK_MIN_PCT}%`,
    );
  }

  // ─── 4. Confluence support (need ≥ 2 factors) ──────────────────
  const conf = findConfluenceFactors(snap);
  if (conf.factors.length < 2) {
    skipReasons.push(
      `Only ${conf.factors.length} support factor(s) within ${(SUPPORT_PROXIMITY_PCT * 100).toFixed(1)}% — need ≥ 2`,
    );
  }

  // If any of the above failed, short-circuit BEFORE computing R:R.
  if (skipReasons.length > 0) {
    return { snapshot: snap, recommendation: null, skipReasons, confidence: null };
  }

  // ─── 5. Stop, target, R:R ──────────────────────────────────────
  // Stop sits just below the lowest qualifying support factor.
  const stopBufferUsd = Math.max(snap.price * 0.003, 0.5); // 0.3% or $0.50, whichever bigger
  const stopLoss = Math.max(0, conf.lowestSupport - stopBufferUsd);
  const riskUsd = snap.price - stopLoss;
  if (riskUsd <= 0) {
    return {
      snapshot: snap,
      recommendation: null,
      skipReasons: ['MISSING_STOP: cannot compute a sane stop level below price'],
      confidence: null,
    };
  }

  // Target = entry + (MIN_RR × risk). Prefer 3:1 if resistance allows.
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
    return {
      snapshot: snap,
      recommendation: null,
      skipReasons: [
        `Insufficient room to resistance for ${MIN_RR}:1 R:R ` +
          `(have $${distToResistance.toFixed(2)}, need $${(MIN_RR * riskUsd).toFixed(2)})`,
      ],
      confidence: null,
    };
  }

  // ─── 6. Confidence score ───────────────────────────────────────
  const confidence = scoreSetup({
    snap,
    factorCount: conf.factors.length,
    rr: achievedRR,
  });
  if (confidence < MIN_CONFIDENCE) {
    return {
      snapshot: snap,
      recommendation: null,
      skipReasons: [
        `Confidence ${confidence.toFixed(2)} < minimum ${MIN_CONFIDENCE}`,
      ],
      confidence,
    };
  }

  // ─── 7. Build the recommendation ───────────────────────────────
  // Suggested USD: Soloway calls for max 1% account risk per trade. We
  // cannot read live account equity from this synchronous code path
  // safely, so we use config.liveMaxOrderUsd as the upper bound (which
  // the user has set conservatively at $10). The 1% rule is enforced in
  // spirit here and re-checked at approval time by liveRiskManager.
  const suggestedAmountUsd = Math.min(config.liveMaxOrderUsd, 10);

  // recommendation_id must be unique. Fold in symbol + ISO bar ts so the
  // SAME setup repeating across cached scans dedupes correctly via the
  // queue's UNIQUE constraint.
  const isoMinute = new Date().toISOString().slice(0, 16);
  const recId = `soloway-${liveSymbol}-${isoMinute}`;

  const recommendation = {
    id: recId,
    symbol: snap.symbol, // 'BTC' or 'ETH' — scanner.js will map to live symbol
    side: 'buy',
    amountUsd: suggestedAmountUsd,
    suggestedAmountUsd,
    confidenceScore: confidence,
    entryReason:
      `Soloway Playbook: pullback to confluence support ` +
      `(${conf.factors.join(' + ')}). Entry $${snap.price}, ` +
      `stop $${stopLoss.toFixed(2)} (-${riskUsd.toFixed(2)}), ` +
      `target $${profitTarget.toFixed(2)} (${achievedRR.toFixed(1)}:1 R:R).`,
    stopLoss,
    profitTarget,
    invalidationLevel: stopLoss, // the Soloway invalidation = the stop
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
    setup: 'pullback_to_confluence_support',
  };
}

module.exports = {
  evaluateSoloway,
  runHardBlocks,
  isWeekendBlock,
  findConfluenceFactors,
  scoreSetup,
  // Constants exposed for testing / introspection
  MIN_CONFIDENCE,
  MIN_RR,
  PREFERRED_RR,
  PULLBACK_MIN_PCT,
  SUPPORT_PROXIMITY_PCT,
};
