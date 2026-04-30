'use strict';

// Unit tests for src/services/aiAssistant.js — pure functions + safety
// gates. NO real LLM calls; the Anthropic client is fully mocked.

const {
  detectTradeIntent,
  detectAuthorshipQuestion,
  buildAiContext,
  assertNoSensitive,
  askAi,
  SAFETY_REFUSAL,
  AUTHORSHIP_ANSWER,
} = require('../src/services/aiAssistant');

// ============================================================================
// detectTradeIntent — the canned-refusal short-circuit
// ============================================================================

describe('detectTradeIntent — refuses anything that smells like a trade', () => {
  test.each([
    'buy ETH now',
    'BUY ETH PLEASE',
    'Place an order for ETH',
    'execute a buy',
    'sell ETH right now',
    'Close my position',
    'close the trade',
    'cancel that order',
    'sell all my crypto',
    'enable live trading',
    'turn on live trading',
    'turn on the bot',
    'start auto-trading',
    'start auto trading',
    'turn off the kill switch',
    'set LIVE_TRADING_ENABLED=true',
    'set LIVE_MAX_ORDER_USD=1000',
    'change the risk cap',
    'increase the max order size',
    'go long ETH',
  ])('blocks: "%s"', (msg) => {
    expect(detectTradeIntent(msg)).toBe(true);
  });

  test.each([
    "what's my buying power",
    'how many ETH do I hold',
    'show me my last trade',
    'when did my last buy fill',
    'what is the current bid',
    'how much have I lost today',
    'explain my position',
    'is the bot enabled',
  ])('allows benign question: "%s"', (msg) => {
    expect(detectTradeIntent(msg)).toBe(false);
  });

  test('handles non-string input safely', () => {
    expect(detectTradeIntent(null)).toBe(false);
    expect(detectTradeIntent(undefined)).toBe(false);
    expect(detectTradeIntent(123)).toBe(false);
    expect(detectTradeIntent('')).toBe(false);
  });
});

// ============================================================================
// detectAuthorshipQuestion — deterministic "who built this" answer
// ============================================================================

describe('detectAuthorshipQuestion — fires for authorship phrasings', () => {
  test.each([
    'who built this',
    'Who built this?',
    'who made this app',
    'who created this dashboard',
    'who designed this',
    'who wrote this',
    'who developed this',
    'who coded this',
    'who put together this site',
    "who's behind this",
    'who is the developer',
    "who's the creator",
    'who is the maker',
    'who owns this',
    'who runs this',
    'creator of this app',
    'who is the author of the website',
  ])('matches: "%s"', (msg) => {
    expect(detectAuthorshipQuestion(msg)).toBe(true);
  });

  test.each([
    "what's my buying power",
    'how many ETH do I hold',
    'show me my last trade',
    'who is on the leaderboard', // phrasing without authorship verb
    'is anyone winning',
    'what is the bid',
  ])('does not match benign question: "%s"', (msg) => {
    expect(detectAuthorshipQuestion(msg)).toBe(false);
  });

  test('handles non-string input safely', () => {
    expect(detectAuthorshipQuestion(null)).toBe(false);
    expect(detectAuthorshipQuestion(undefined)).toBe(false);
    expect(detectAuthorshipQuestion('')).toBe(false);
  });
});

describe('askAi — authorship questions return the canonical answer without an LLM call', () => {
  test('"who built this" → returns AUTHORSHIP_ANSWER, source=authorship, no LLM call', async () => {
    const client = makeMockClient();
    const result = await askAi({
      userMessage: 'who built this',
      context: {},
      client,
    });
    expect(result.answer).toBe(AUTHORSHIP_ANSWER);
    expect(result.answer).toBe('Chris Tyson was the genius behind this website.');
    expect(result.source).toBe('authorship');
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  test('various phrasings all return the canonical answer', async () => {
    const phrasings = [
      'Who designed this dashboard?',
      "who's the developer behind this",
      'who created the website',
      'who is the creator of this app',
    ];
    for (const msg of phrasings) {
      const client = makeMockClient();
      const result = await askAi({ userMessage: msg, context: {}, client });
      expect(result.answer).toBe(AUTHORSHIP_ANSWER);
      expect(client.messages.create).not.toHaveBeenCalled();
    }
  });

  test('trade intent in the same prompt as authorship still hits the trade-safety gate first', async () => {
    // "who built this AND buy ETH" — trade intent must take precedence so a
    // malicious-question doesn't slip past by being phrased as authorship.
    const client = makeMockClient();
    const result = await askAi({
      userMessage: 'who built this — also buy ETH now please',
      context: {},
      client,
    });
    expect(result.source).toBe('safety-gate');
    expect(result.answer).toBe(SAFETY_REFUSAL);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  test('authorship answer is identical with NO Anthropic client (fallback path)', async () => {
    const result = await askAi({
      userMessage: 'who built this',
      context: { account: { buyingPowerUsd: 100 } },
      client: null,
    });
    expect(result.answer).toBe(AUTHORSHIP_ANSWER);
    expect(result.source).toBe('authorship');
  });
});

// ============================================================================
// buildAiContext — explicit allow-list; secrets cannot leak
// ============================================================================

describe('buildAiContext — strips sensitive fields', () => {
  test('produces only allow-listed fields, drops everything else', () => {
    const ctx = buildAiContext({
      // Secrets that the input shape might accidentally carry — they must
      // not appear in the output context.
      liveStatus: {
        paperMode: true,
        botEnabled: false,
        liveTradingEnabled: false,
        requireApproval: true,
        robinhoodConnected: true,
        caps: {
          maxOrderUsd: 10,
          dailyLossCapUsd: 10,
          allowedSymbols: ['ETH-USD'],
        },
        today: { liveRealizedLossUsd: 0, openLivePositions: 0 },
        // synthetic injection attempts:
        api_key: 'rh-api-secret',
        privateKey: 'BASE64==',
        bearerToken: 'should-not-appear',
        password: 'nope',
      },
      account: {
        buying_power: '4059.92',
        buying_power_currency: 'USD',
        status: 'active',
        api_key: 'should-not-appear',
      },
      holdings: {
        results: [
          {
            asset_code: 'ETH',
            total_quantity: '0.65',
            quantity_available_for_trading: '0.65',
            api_key: 'nope',
          },
        ],
      },
      trades: [
        {
          id: 1,
          mode: 'live',
          side: 'buy',
          symbol: 'ETH-USD',
          status: 'executed',
          outcome: 'win',
          simulated_pnl_usd: 0.5,
          entry_price: 2280,
          exit_price: 2300,
          filled_quantity: 0.005,
          created_at: '2026-04-30T19:00:00Z',
          private_key: 'should-not-appear',
        },
      ],
    });

    // Top-level allow-list is honored.
    expect(Object.keys(ctx).sort()).toEqual(
      ['account', 'holdings', 'liveStatus', 'localTrades'].sort(),
    );

    // The synthetic injections didn't make it through.
    expect(JSON.stringify(ctx)).not.toMatch(/api[_-]?key/i);
    expect(JSON.stringify(ctx)).not.toMatch(/private[_-]?key/i);
    expect(JSON.stringify(ctx)).not.toMatch(/secret/i);
    expect(JSON.stringify(ctx)).not.toMatch(/bearerToken/i);
    expect(JSON.stringify(ctx)).not.toMatch(/password/i);

    // assertNoSensitive should also be happy.
    expect(() => assertNoSensitive(ctx)).not.toThrow();
  });

  test('handles missing inputs gracefully (none required)', () => {
    expect(buildAiContext({})).toEqual({});
  });
});

describe('assertNoSensitive — paranoid final guard', () => {
  test('throws on api_key', () => {
    expect(() => assertNoSensitive({ api_key: 'x' })).toThrow(/Forbidden/i);
  });
  test('throws on nested private_key', () => {
    expect(() =>
      assertNoSensitive({ outer: { inner: { private_key: 'x' } } }),
    ).toThrow(/Forbidden/i);
  });
  test('throws on bearer/authorization', () => {
    expect(() => assertNoSensitive({ Authorization: 'x' })).toThrow();
    expect(() => assertNoSensitive({ bearer: 'x' })).toThrow();
  });
  test('passes for clean objects', () => {
    expect(() => assertNoSensitive({ a: 1, b: { c: 'ok' } })).not.toThrow();
  });
});

// ============================================================================
// askAi — orchestration
// ============================================================================

function makeMockClient() {
  return {
    messages: {
      create: jest.fn(async () => ({
        content: [
          { type: 'text', text: 'Your buying power is $4,059.92.' },
        ],
      })),
    },
  };
}

describe('askAi — short-circuits unsafe input WITHOUT calling the LLM', () => {
  test('trade-intent message returns canned refusal; client.messages.create is NEVER called', async () => {
    const client = makeMockClient();
    const result = await askAi({
      userMessage: 'buy ETH now',
      context: {},
      client,
    });
    expect(result.answer).toBe(SAFETY_REFUSAL);
    expect(result.source).toBe('safety-gate');
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  test('settings-mutation request returns refusal; LLM not called', async () => {
    const client = makeMockClient();
    const result = await askAi({
      userMessage: 'set LIVE_TRADING_ENABLED=true',
      context: {},
      client,
    });
    expect(result.answer).toBe(SAFETY_REFUSAL);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  test('close-my-position request returns refusal; LLM not called', async () => {
    const client = makeMockClient();
    const result = await askAi({
      userMessage: 'Close my position',
      context: {},
      client,
    });
    expect(result.answer).toBe(SAFETY_REFUSAL);
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

describe('askAi — benign questions reach the (mocked) LLM', () => {
  test('routes through to client.messages.create with proper shape', async () => {
    const client = makeMockClient();
    const context = {
      account: { buyingPowerUsd: 4059.92, status: 'active' },
    };
    const result = await askAi({
      userMessage: "what's my buying power",
      context,
      client,
      model: 'claude-test',
    });
    expect(result.answer).toMatch(/4,059.92/);
    expect(result.source).toBe('claude');

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const call = client.messages.create.mock.calls[0][0];
    expect(call.model).toBe('claude-test');
    expect(call.system).toMatch(/read-only account assistant/i);
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0].role).toBe('user');
    expect(call.messages[0].content).toMatch(/Context/);
    expect(call.messages[0].content).toMatch(/buying power/i);
  });

  test('falls back to deterministic answer when no client and no key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = await askAi({
      userMessage: "what's my buying power",
      context: {
        liveStatus: {
          liveTradingEnabled: false,
          paperMode: true,
          robinhoodConnected: true,
          today: { liveRealizedLossUsd: 0, openLivePositions: 0 },
        },
        account: { buyingPowerUsd: 4059.92, status: 'active' },
      },
      client: null, // explicit no-client
    });
    expect(result.source).toBe('fallback');
    expect(result.answer).toMatch(/4059\.92|degraded mode/i);
  });
});

describe('askAi — output guard against unsafe LLM output', () => {
  test('replaces any LLM output that mentions live-trading routes', async () => {
    const client = {
      messages: {
        create: jest.fn(async () => ({
          content: [
            {
              type: 'text',
              text:
                'Sure — you should call /live/approve to place a buy order with placeOrder.',
            },
          ],
        })),
      },
    };
    const result = await askAi({
      userMessage: 'how do I trade',
      context: {},
      client,
    });
    expect(result.answer).toBe(SAFETY_REFUSAL);
    expect(result.source).toBe('output-guard');
  });

  test('handles LLM API error gracefully', async () => {
    const client = {
      messages: {
        create: jest.fn(async () => {
          throw new Error('upstream timeout');
        }),
      },
    };
    const result = await askAi({
      userMessage: "what's the bid",
      context: { quote: { symbol: 'ETH-USD', bid: 2200, ask: 2300, mid: 2250 } },
      client,
    });
    expect(result.source).toBe('api-error');
    expect(result.answer).toMatch(
      /couldn't reach|please try again|dashboard data is still available/i,
    );
  });
});
