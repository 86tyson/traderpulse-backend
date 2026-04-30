'use strict';

const { z } = require('zod');

const tradeApproveSchema = z
  .object({
    recommendationId: z.string().min(1),
    symbol: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    suggestedAmountUsd: z.number().finite().positive(),
    confidenceScore: z.number().finite(),
    entryReason: z.string().min(1),
    stopLoss: z.number().finite(),
    profitTarget: z.number().finite(),
    invalidationLevel: z.number().finite(),
    riskReward: z.number().finite().positive(),
    // Optional UI-driven preference. The PAPER path uses it to scale sim
    // size and tweak the confidence threshold. The LIVE path's schema is a
    // separate object (liveApproveSchema) which DOES NOT include this field
    // — any `riskMode` sent to /live/approve is rejected as INVALID_BODY
    // at the validation layer. See `services/riskModeAdjuster.js`.
    riskMode: z.enum(['conservative', 'standard', 'aggressive']).optional(),
  })
  .strict();

const tradeDeclineSchema = z
  .object({
    recommendationId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

// POST /live/approve
//
// Phase 3 micro live testing. Strict body — extra fields rejected.
// `confirmedRealMoney` MUST be exactly true; liveRiskManager re-checks this
// on top of the schema-level constraint (defence in depth).
const liveApproveSchema = z
  .object({
    recommendationId: z.string().min(1),
    symbol: z.literal('ETH-USD'), // Phase 3 explicit constraint at schema level
    side: z.enum(['buy', 'sell']),
    usdAmount: z.number().finite().positive(),
    confirmedRealMoney: z.literal(true),
    orderType: z.enum(['limit', 'market']).optional(), // default "limit" in route
    // OPTIONAL explicit limit price. When omitted, the route uses live ask
    // ± 0.5% buffer (fillable). When provided, the caller's price is honored
    // verbatim (rounded to 2 decimals). Use this for the Phase-3 dry-run
    // (a buy limit far below bid so the order does NOT fill).
    limitPrice: z.number().finite().positive().optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

function validateBody(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path.join('.') || '(body)';
      return res.status(400).json({
        ok: false,
        code: 'INVALID_BODY',
        reason: `${field}: ${issue.message}`,
      });
    }
    req.validBody = parsed.data;
    return next();
  };
}

// POST /live/close
//
// Close-out of the single open live position. Like approve, requires explicit
// real-money confirmation. Carries no symbol/side/amount fields — those are
// derived from the open position itself (which is unique because the
// liveRiskManager enforces 1-position-max). Phase 3 is ETH-only and the close
// is always a SELL of the same asset quantity that was bought.
const liveCloseSchema = z
  .object({
    confirmedRealMoney: z.literal(true),
    note: z.string().max(500).optional(),
  })
  .strict();

// POST /ai/account-chat
//
// Strict body — only `message` allowed. Capped at 1000 chars to keep prompt
// length bounded. Empty messages rejected so we never burn an LLM call on
// nothing.
const aiChatSchema = z
  .object({
    message: z.string().min(1).max(1000),
  })
  .strict();

module.exports = {
  validateBody,
  tradeApproveSchema,
  tradeDeclineSchema,
  liveApproveSchema,
  liveCloseSchema,
  aiChatSchema,
};
