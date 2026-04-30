'use strict';

// Account Assistant — read-only AI helper.
//
// SAFETY POSTURE (defence-in-depth):
//
//   1. SCHEMA GATE   — POST body validated by Zod (max-length, strict object).
//                      Enforced at the route layer before this module runs.
//
//   2. INTENT GATE   — `detectTradeIntent()` short-circuits any message that
//                      looks like a trade/settings request BEFORE we call
//                      the AI. The user gets a canned refusal; no LLM round
//                      trip; no chance the model could be coaxed into an
//                      unsafe answer.
//
//   3. CONTEXT GATE  — `buildAiContext()` is an EXPLICIT cherry-pick of
//                      fields we send to the model. API keys, private keys,
//                      bearer tokens, and `.env` values cannot reach the AI
//                      because they are never written into the context object.
//
//   4. SYSTEM PROMPT — Reinforces all three above to the model itself.
//
//   5. NO TRADE FUNCTIONS — This module imports no trading client and has
//                          zero ability to call /live/approve, /live/close,
//                          robinhoodClient.placeOrder, robinhoodClient.cancelOrder.
//                          It only consumes data from read-only endpoints.

const logger = require('./logger');

const SAFETY_REFUSAL =
  "I can't place trades or change settings. I can only explain your account and trade data.";

// Patterns that strongly suggest the user is trying to make us trade or
// reconfigure the system. Conservative — false positives (refusing a benign
// question) are safer than false negatives (acting on intent).
const TRADE_INTENT_PATTERNS = [
  /\b(buy|sell|short|long|bid|ask|long\s+eth|long\s+btc)\s+(eth|btc|crypto|now|please|now\.?|right\s+now)\b/i,
  /\bplace\s+(an?\s+)?(order|trade|buy|sell)\b/i,
  /\bexecute\s+(an?\s+)?(order|trade|buy|sell)\b/i,
  /\bclose\s+(my|the|this|that)?\s*(position|trade)\b/i,
  /\bsell\s+all\b/i,
  // "cancel my/that/the/this order" or "cancel an order"
  /\bcancel\s+(an?|my|the|this|that|all)?\s*(order|trade|position)\b/i,
  // Allow optional "the/my" determiner: "turn on the bot", "enable the bot"
  /\b(enable|turn\s+on|activate|start)\s+(the\s+|my\s+)?(live|live\s+trading|bot|auto[\s-]?trading|trading)\b/i,
  // Allow optional "the/my" determiner: "turn off the kill switch"
  /\b(disable|turn\s+off)\s+(the\s+|my\s+)?(paper|kill\s+switch|safety|safeties)\b/i,
  /\bset\s+LIVE_TRADING_ENABLED/i,
  /\bset\s+\w+\s*=/i, // any env-var-style assignment
  /\bchange\s+(the\s+)?(risk|max|cap|setting|config)\b/i,
  /\bincrease\s+(the\s+)?(size|cap|max|limit)\b/i,
];

function detectTradeIntent(message) {
  if (typeof message !== 'string' || !message) return false;
  return TRADE_INTENT_PATTERNS.some((p) => p.test(message));
}

// Deterministic, authoritative answer for "who built this?" type questions.
// Short-circuits before the LLM so the answer is identical in fallback mode
// AND with the API key configured.
const AUTHORSHIP_ANSWER = 'Chris Tyson was the genius behind this website.';

const AUTHORSHIP_PATTERNS = [
  /\bwho\s+(built|made|created|designed|wrote|developed|coded|engineered|put\s+together|owns|runs)\b/i,
  /\bwho('s|\s+is)\s+(the\s+)?(developer|creator|maker|engineer|author|builder|architect|founder|owner|person|programmer|coder)\b/i,
  /\bwho('s|\s+is)\s+behind\b/i,
  /\b(creator|author|maker|developer|owner)\s+of\s+(this|the\s+(app|site|website|dashboard|system|tool|project))\b/i,
];

function detectAuthorshipQuestion(message) {
  if (typeof message !== 'string' || !message) return false;
  return AUTHORSHIP_PATTERNS.some((p) => p.test(message));
}

// ----- Context builder -----
// Explicit allow-list of fields we send to the AI. Anything not listed here
// CANNOT reach the model. API keys, private keys, bearer tokens never appear
// — they're not in the input shape we accept.
function buildAiContext({
  liveStatus,
  account,
  holdings,
  quote,
  orders,
  trades,
}) {
  const ctx = {};

  if (liveStatus) {
    ctx.liveStatus = {
      paperMode: !!liveStatus.paperMode,
      botEnabled: !!liveStatus.botEnabled,
      liveTradingEnabled: !!liveStatus.liveTradingEnabled,
      requireApproval: !!liveStatus.requireApproval,
      robinhoodConnected: !!liveStatus.robinhoodConnected,
      caps: liveStatus.caps
        ? {
            maxOrderUsd: Number(liveStatus.caps.maxOrderUsd),
            dailyLossCapUsd: Number(liveStatus.caps.dailyLossCapUsd),
            allowedSymbols: Array.isArray(liveStatus.caps.allowedSymbols)
              ? [...liveStatus.caps.allowedSymbols]
              : [],
          }
        : null,
      today: liveStatus.today
        ? {
            liveRealizedLossUsd: Number(liveStatus.today.liveRealizedLossUsd),
            openLivePositions: Number(liveStatus.today.openLivePositions),
          }
        : null,
    };
  }

  if (account) {
    ctx.account = {
      buyingPowerUsd: Number(account.buying_power),
      buyingPowerCurrency: account.buying_power_currency,
      status: account.status,
    };
  }

  if (holdings && Array.isArray(holdings.results)) {
    ctx.holdings = holdings.results.map((h) => ({
      assetCode: h.asset_code,
      totalQuantity: Number(h.total_quantity),
      availableForTrading: Number(h.quantity_available_for_trading),
    }));
  }

  if (quote && Array.isArray(quote.results) && quote.results[0]) {
    const q = quote.results[0];
    const bid = Number(
      q.bid_inclusive_of_sell_spread ?? q.bid_price ?? q.bid ?? NaN,
    );
    const ask = Number(
      q.ask_inclusive_of_buy_spread ?? q.ask_price ?? q.ask ?? NaN,
    );
    const mid = Number(q.price ?? NaN);
    ctx.quote = {
      symbol: 'ETH-USD',
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      mid: Number.isFinite(mid)
        ? mid
        : Number.isFinite(bid) && Number.isFinite(ask)
          ? (bid + ask) / 2
          : null,
      timestampIso: q.timestamp ?? null,
    };
  }

  if (orders && Array.isArray(orders.results)) {
    ctx.recentOrders = orders.results.slice(0, 10).map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      state: o.state,
      filledQuantity: Number(o.filled_asset_quantity),
      averagePrice: o.average_price != null ? Number(o.average_price) : null,
      createdAt: o.created_at,
    }));
  }

  if (Array.isArray(trades)) {
    ctx.localTrades = trades.slice(0, 10).map((t) => ({
      id: t.id,
      mode: t.mode,
      side: t.side,
      symbol: t.symbol,
      status: t.status,
      outcome: t.outcome,
      pnlUsd: t.simulated_pnl_usd,
      entryPrice: t.entry_price,
      exitPrice: t.exit_price,
      filledQuantity: t.filled_quantity,
      createdAt: t.created_at,
      exitTimestamp: t.exit_timestamp,
    }));
  }

  return ctx;
}

// Safety check: confirm a candidate context blob has no sensitive fields.
// Used in tests + run as a final guard before sending to the AI.
const FORBIDDEN_KEY_NAMES = [
  /api[_-]?key/i,
  /private[_-]?key/i,
  /secret/i,
  /bearer/i,
  /authorization/i,
  /password/i,
  /token/i,
];

function assertNoSensitive(obj) {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === null || typeof cur !== 'object') continue;
    for (const k of Object.keys(cur)) {
      if (FORBIDDEN_KEY_NAMES.some((p) => p.test(k))) {
        throw new Error(`Forbidden field "${k}" in AI context`);
      }
      stack.push(cur[k]);
    }
  }
}

// ----- AI caller -----
// Lazily loads the Anthropic SDK only if the user has configured a key. If
// the SDK is missing or the key is unset, fall back to a deterministic
// structured response so the assistant still works (in a less smart way).
const DEFAULT_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

let cachedClient; // undefined = not tried, null = unavailable, object = ready
function getClient() {
  if (cachedClient !== undefined) return cachedClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    cachedClient = null;
    return null;
  }
  try {
    // eslint-disable-next-line global-require
    const Anthropic = require('@anthropic-ai/sdk');
    const Ctor = Anthropic.default || Anthropic;
    cachedClient = new Ctor({ apiKey: process.env.ANTHROPIC_API_KEY });
    logger.info({ event: 'aiAssistant.ready' }, 'Anthropic client initialised');
  } catch (err) {
    logger.warn(
      { event: 'aiAssistant.sdk_missing', msg: err.message },
      'Anthropic SDK not installed; using deterministic fallback',
    );
    cachedClient = null;
  }
  return cachedClient;
}

const SYSTEM_PROMPT = `You are a read-only account assistant for a crypto paper-trading dashboard.

ABSOLUTE RULES:
1. You CANNOT place trades, close positions, cancel orders, or modify any setting.
2. If the user asks you to trade, place an order, close a position, enable live trading, change a setting, or alter risk caps — your ONLY response is exactly: "${SAFETY_REFUSAL}"
3. Answer only from the provided context data. If a field is missing or null, say so plainly. NEVER invent numbers, prices, fills, or events.
4. Do NOT give financial advice. Do NOT promise gains. Do NOT say "you should buy/sell". Stay informational.
5. Be concise. Plain prose. No markdown headers or bullet lists unless the user explicitly asks for a list.

Available context fields:
- liveStatus: paperMode, botEnabled, liveTradingEnabled, robinhoodConnected, caps, today.openLivePositions, today.liveRealizedLossUsd
- account: buyingPowerUsd, status
- holdings: array of { assetCode, totalQuantity, availableForTrading }
- quote: { symbol, bid, ask, mid }
- recentOrders: array of last 10 Robinhood orders (read-only history)
- localTrades: array of last 10 trades the app has logged

Format dollar amounts as $X.XX. Use the user's wording when echoing back data.`;

function deterministicFallbackAnswer(userMessage, context) {
  const lines = [
    "I'm running in degraded mode (ANTHROPIC_API_KEY not configured). Here's what your account looks like right now from read-only data — set the env var to get full natural-language answers.",
    '',
  ];

  if (context.liveStatus) {
    const ls = context.liveStatus;
    lines.push(
      `Live trading: ${ls.liveTradingEnabled ? 'ON' : 'OFF'} · Paper mode: ${ls.paperMode ? 'on' : 'off'} · RH connected: ${ls.robinhoodConnected ? 'yes' : 'no'} · Open positions: ${ls.today?.openLivePositions ?? 0} · Today's live loss: $${(ls.today?.liveRealizedLossUsd ?? 0).toFixed(2)}.`,
    );
  }
  if (context.account) {
    lines.push(`Buying power: $${context.account.buyingPowerUsd.toFixed(2)}.`);
  }
  if (context.holdings) {
    const eth = context.holdings.find((h) => h.assetCode === 'ETH');
    const btc = context.holdings.find((h) => h.assetCode === 'BTC');
    if (eth) lines.push(`ETH balance: ${eth.totalQuantity} ETH.`);
    if (btc) lines.push(`BTC balance: ${btc.totalQuantity} BTC.`);
  }
  if (context.quote) {
    lines.push(
      `ETH-USD quote: bid $${context.quote.bid?.toFixed(2) ?? '—'}, ask $${context.quote.ask?.toFixed(2) ?? '—'}.`,
    );
  }
  if (context.localTrades && context.localTrades.length > 0) {
    const last = context.localTrades[0];
    lines.push(
      `Most recent local trade: #${last.id} · ${last.symbol} · ${last.side} · ${last.outcome ?? 'open'} · P/L $${last.pnlUsd ?? '—'}.`,
    );
  }
  lines.push('');
  lines.push(`Your question was: "${userMessage}"`);
  return lines.join('\n');
}

/**
 * @param {object} args
 * @param {string} args.userMessage
 * @param {object} args.context           - output of buildAiContext()
 * @param {object} [args.client]          - injectable Anthropic client (for tests)
 * @param {string} [args.model]
 */
async function askAi({ userMessage, context, client, model } = {}) {
  if (!userMessage || typeof userMessage !== 'string') {
    return { answer: SAFETY_REFUSAL, source: 'invalid' };
  }

  if (detectTradeIntent(userMessage)) {
    logger.info(
      { event: 'aiAssistant.intent_blocked' },
      'Trade-intent detected; canned refusal returned without LLM call',
    );
    return { answer: SAFETY_REFUSAL, source: 'safety-gate' };
  }

  // Authorship question → deterministic authoritative answer.
  // Fires before the LLM round-trip so the response is identical regardless
  // of whether the Anthropic key is configured.
  if (detectAuthorshipQuestion(userMessage)) {
    logger.info(
      { event: 'aiAssistant.authorship_answered' },
      'Authorship question; canonical answer returned without LLM call',
    );
    return { answer: AUTHORSHIP_ANSWER, source: 'authorship' };
  }

  // Final paranoid check on the context itself.
  assertNoSensitive(context || {});

  const ai = client !== undefined ? client : getClient();
  if (!ai) {
    return {
      answer: deterministicFallbackAnswer(userMessage, context || {}),
      source: 'fallback',
    };
  }

  let response;
  try {
    response = await ai.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Context (read-only data from the user's own account; never invent extras):
${JSON.stringify(context, null, 2)}

Question: ${userMessage}`,
        },
      ],
    });
  } catch (err) {
    logger.error(
      { event: 'aiAssistant.api_fail', msg: err.message },
      'Anthropic API call failed',
    );
    return {
      answer:
        "I couldn't reach the assistant model right now. The dashboard data is still available; please try again in a moment.",
      source: 'api-error',
    };
  }

  const text =
    Array.isArray(response?.content) &&
    response.content.find((b) => b.type === 'text')?.text;
  if (!text) {
    return {
      answer: '(empty response from assistant)',
      source: 'empty',
    };
  }

  // Final guard: even if the model ignored its instructions and emitted
  // anything that looks like a trade-action plan, refuse to forward it.
  if (
    /\bplaceOrder\b|\bcancelOrder\b|\b\/live\/(approve|close|reconcile)\b/i.test(
      text,
    )
  ) {
    logger.warn(
      { event: 'aiAssistant.unsafe_output_blocked' },
      'AI output contained trading API references; replaced with safety message',
    );
    return { answer: SAFETY_REFUSAL, source: 'output-guard' };
  }

  return { answer: text, source: 'claude' };
}

module.exports = {
  detectTradeIntent,
  detectAuthorshipQuestion,
  buildAiContext,
  assertNoSensitive,
  askAi,
  SAFETY_REFUSAL,
  AUTHORSHIP_ANSWER,
  SYSTEM_PROMPT,
  TRADE_INTENT_PATTERNS,
  AUTHORSHIP_PATTERNS,
  // exposed for tests:
  _internal: { deterministicFallbackAnswer },
};
