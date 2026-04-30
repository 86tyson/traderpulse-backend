'use strict';

// Integration tests for POST /ai/account-chat. Uses supertest to drive the
// actual Express app. The Anthropic SDK is jest-mocked at the module level
// so no real LLM calls happen.

const request = require('supertest');

// Mock the Anthropic SDK BEFORE the route loads.
jest.mock(
  '@anthropic-ai/sdk',
  () => {
    return jest.fn().mockImplementation(() => ({
      messages: {
        create: jest.fn(async () => ({
          content: [
            { type: 'text', text: 'Your buying power is $4,059.92.' },
          ],
        })),
      },
    }));
  },
  { virtual: true },
);

// Mock robinhoodClient so RH calls don't try to hit the network.
jest.mock('../src/services/robinhoodClient', () => ({
  getAccount: jest.fn(async () => ({
    buying_power: '4059.92',
    buying_power_currency: 'USD',
    status: 'active',
  })),
  getHoldings: jest.fn(async () => ({
    results: [
      {
        asset_code: 'ETH',
        total_quantity: '0.65',
        quantity_available_for_trading: '0.65',
      },
    ],
  })),
  getQuote: jest.fn(async () => ({
    results: [
      {
        symbol: 'ETH-USD',
        price: '2250',
        bid_inclusive_of_sell_spread: '2240',
        ask_inclusive_of_buy_spread: '2260',
      },
    ],
  })),
  getOrders: jest.fn(async () => ({ results: [] })),
  // Trade-action methods MUST exist for the require chain but should never
  // be called from /ai/* — assertions below verify this.
  placeOrder: jest.fn(),
  cancelOrder: jest.fn(),
  getOrderById: jest.fn(),
  getProducts: jest.fn(),
}));

const robinhood = require('../src/services/robinhoodClient');
const { buildApp } = require('../src/server');
const db = require('../src/db');

const app = buildApp();
const AUTH = `Bearer ${process.env.BACKEND_API_KEY}`;

beforeEach(() => {
  jest.clearAllMocks();
  db.exec('DELETE FROM trades; DELETE FROM decisions;');
});

describe('POST /ai/account-chat — auth gate', () => {
  test('rejects unauthenticated requests with 401', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .send({ message: "what's my buying power" });
    expect(res.status).toBe(401);
  });

  test('rejects wrong bearer with 401', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', 'Bearer wrong-token')
      .send({ message: "what's my buying power" });
    expect(res.status).toBe(401);
  });
});

describe('POST /ai/account-chat — schema gate', () => {
  test('rejects missing message with INVALID_BODY', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  test('rejects extra fields (strict schema)', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({ message: 'hi', extraField: 'sneaky' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  test('rejects empty message', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({ message: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  test('rejects messages over 1000 chars', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({ message: 'a'.repeat(1001) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });
});

describe('POST /ai/account-chat — trade-intent safety', () => {
  test('refuses "buy ETH now" without calling RH trade methods or any LLM', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({ message: 'buy ETH now' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.source).toBe('safety-gate');
    expect(res.body.answer).toMatch(
      /can't place trades or change settings/i,
    );

    // CRITICAL: no trading actions should ever fire from this path.
    expect(robinhood.placeOrder).not.toHaveBeenCalled();
    expect(robinhood.cancelOrder).not.toHaveBeenCalled();
  });

  test('refuses "close my position" → no trade calls', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({ message: 'close my position' });
    expect(res.body.source).toBe('safety-gate');
    expect(robinhood.placeOrder).not.toHaveBeenCalled();
    expect(robinhood.cancelOrder).not.toHaveBeenCalled();
  });

  test('refuses "enable live trading" → no trade calls, no settings change', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({ message: 'enable live trading please' });
    expect(res.body.source).toBe('safety-gate');
    expect(robinhood.placeOrder).not.toHaveBeenCalled();
  });
});

describe('POST /ai/account-chat — read-only Q&A path', () => {
  test('answers a benign question using mocked RH + LLM', async () => {
    const res = await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({ message: "what's my buying power" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Answer comes from the (mocked) LLM OR from the deterministic fallback;
    // either way it should mention the buying-power figure that was injected.
    expect(res.body.answer).toMatch(/4[,.]?059/);

    // Confirm we read from RH but never wrote.
    expect(robinhood.getAccount).toHaveBeenCalled();
    expect(robinhood.getHoldings).toHaveBeenCalled();
    expect(robinhood.getQuote).toHaveBeenCalledWith('ETH-USD');
    expect(robinhood.getOrders).toHaveBeenCalled();
    expect(robinhood.placeOrder).not.toHaveBeenCalled();
    expect(robinhood.cancelOrder).not.toHaveBeenCalled();
  });

  test('the AI client never receives keys or secrets in the prompt', async () => {
    const Anthropic = require('@anthropic-ai/sdk');
    const ctorSpy = Anthropic;
    // Trigger the route so the SDK is instantiated.
    await request(app)
      .post('/ai/account-chat')
      .set('Authorization', AUTH)
      .send({ message: "what's the bid" });

    if (ctorSpy.mock.results.length === 0) return; // SDK not loaded; fine
    const instance = ctorSpy.mock.results[0]?.value;
    if (!instance) return;
    const calls = instance.messages.create.mock.calls;
    if (calls.length === 0) return; // fallback path; no LLM call to inspect

    const userPayload = calls[0][0].messages[0].content;
    // The prompt the model receives must not contain any forbidden field.
    expect(userPayload).not.toMatch(/api[_-]?key/i);
    expect(userPayload).not.toMatch(/private[_-]?key/i);
    expect(userPayload).not.toMatch(/bearer/i);
    expect(userPayload).not.toMatch(/authorization/i);
    // BACKEND_API_KEY value itself must not leak.
    expect(userPayload).not.toMatch(/test-bearer-token/);
  });
});
