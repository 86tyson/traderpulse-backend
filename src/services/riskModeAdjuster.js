'use strict';

// riskModeAdjuster — pure function that maps a (request, config, riskMode)
// triple to the *effective* trade-size + confidence threshold for a paper
// trade. Has zero side-effects.
//
// CRITICAL INVARIANTS:
//   - Only invoked from the PAPER path of /trade/approve.
//   - When paperMode === false, returns the original values unchanged
//     (this is enforced both here AND by the calling route — defence-in-depth).
//   - The "aggressive" multiplier is CAPPED at config.maxTradeUsd so size can
//     never exceed the existing per-trade cap.
//   - Has no power over /live/approve or /live/close — those endpoints use
//     `liveApproveSchema.strict()` / `liveCloseSchema.strict()` which reject
//     `riskMode` at the validation layer, AND the live route ignores any
//     amount field outside `config.liveMaxOrderUsd` regardless.
//
// Mapping:
//   Conservative → 0.5× size, minConfidence 0.85 (HIGH-only).
//                  Reduces both frequency (more rejections) and size.
//   Standard     → unchanged. Preserves current paper behavior.
//   Aggressive   → 2× size (capped at maxTradeUsd), minConfidence 0.4
//                  (allows LOW). Increases both frequency and size.

/** @typedef {"conservative" | "standard" | "aggressive"} RiskMode */

const VALID_MODES = new Set(['conservative', 'standard', 'aggressive']);

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param {object} args
 * @param {object} args.request  - validated request (must include suggestedAmountUsd)
 * @param {object} args.config   - app config (must include maxTradeUsd, minConfidence, paperMode)
 * @param {string} [args.riskMode] - one of "conservative" | "standard" | "aggressive"
 * @returns {{
 *   suggestedAmountUsd: number,
 *   minConfidence: number,
 *   applied: boolean,
 *   riskMode: RiskMode,
 *   reason: string | null,
 * }}
 */
function applyRiskMode({ request, config, riskMode }) {
  const mode = VALID_MODES.has(riskMode) ? riskMode : 'standard';
  const original = {
    suggestedAmountUsd: request.suggestedAmountUsd,
    minConfidence: config.minConfidence,
    applied: false,
    riskMode: mode,
    reason: null,
  };

  // STRUCTURAL GUARD: when not in paper mode, the adjuster is a no-op.
  // The route layer already prevents calling us in live mode, but this is
  // belt-and-suspenders so accidental misuse can't increase live size.
  if (config.paperMode !== true) {
    return {
      ...original,
      reason: 'live mode — riskMode ignored',
    };
  }

  switch (mode) {
    case 'conservative': {
      const scaled = Math.max(1, round2(request.suggestedAmountUsd * 0.5));
      return {
        suggestedAmountUsd: scaled,
        minConfidence: 0.85,
        applied: true,
        riskMode: mode,
        reason:
          'conservative: 0.5× size, HIGH-confidence only (minConfidence raised to 0.85)',
      };
    }
    case 'aggressive': {
      // CAP at maxTradeUsd so we cannot exceed the per-trade limit.
      const scaled = Math.min(
        config.maxTradeUsd,
        round2(request.suggestedAmountUsd * 2),
      );
      return {
        suggestedAmountUsd: scaled,
        minConfidence: 0.4,
        applied: true,
        riskMode: mode,
        reason:
          'aggressive: 2× size (capped at MAX_TRADE_USD), LOW-confidence allowed (minConfidence lowered to 0.4)',
      };
    }
    case 'standard':
    default:
      return {
        ...original,
        riskMode: 'standard',
        reason: 'standard: no adjustments',
      };
  }
}

module.exports = { applyRiskMode, VALID_MODES };
