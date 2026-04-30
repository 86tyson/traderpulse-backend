'use strict';

const { validRequest } = require('./setup');
const request = require('supertest');
const { buildApp } = require('../src/server');
const db = require('../src/db');

const TOKEN = process.env.BACKEND_API_KEY;
const auth = { Authorization: `Bearer ${TOKEN}` };
const app = buildApp();

beforeEach(() => {
  db.exec('DELETE FROM trades; DELETE FROM decisions;');
});

describe('GET /health', () => {
  test('public, returns status payload', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      server: 'running',
      paperMode: true,
      botEnabled: true,
    });
    expect(Array.isArray(res.body.allowedSymbols)).toBe(true);
  });
});

describe('bearer auth', () => {
  test('rejects missing token', async () => {
    const res = await request(app).get('/account');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('rejects bad token', async () => {
    const res = await request(app).get('/account').set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(401);
  });

  test('accepts valid token', async () => {
    const res = await request(app).get('/account').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('paper');
  });
});

describe('POST /trade/approve', () => {
  test('simulates a valid trade in paper mode and immediately closes it', async () => {
    const res = await request(app).post('/trade/approve').set(auth).send(validRequest());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'simulated', mode: 'paper' });
    expect(['win', 'loss']).toContain(res.body.outcome);
    expect(typeof res.body.pnlUsd).toBe('number');
    expect(typeof res.body.exitPrice).toBe('number');

    const row = db.prepare('SELECT * FROM trades WHERE recommendation_id = ?').get(res.body.recommendationId);
    expect(row.status).toBe('simulated');
    expect(['win', 'loss']).toContain(row.outcome);
    expect(row.exit_timestamp).toBeTruthy();
    expect(row.exit_price).not.toBeNull();
    expect(row.simulated_pnl_usd).not.toBeNull();
    // sign of pnl matches outcome
    if (row.outcome === 'win')  expect(row.simulated_pnl_usd).toBeGreaterThan(0);
    if (row.outcome === 'loss') expect(row.simulated_pnl_usd).toBeLessThan(0);
  });

  test('rejects with INVALID_BODY when fields are wrong type', async () => {
    const bad = { ...validRequest(), suggestedAmountUsd: 'twenty' };
    const res = await request(app).post('/trade/approve').set(auth).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  test('rejects unknown extra fields (strict schema)', async () => {
    const bad = { ...validRequest(), evil: 'payload' };
    const res = await request(app).post('/trade/approve').set(auth).send(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_BODY');
  });

  test('rejects with SYMBOL_NOT_ALLOWED', async () => {
    const res = await request(app).post('/trade/approve').set(auth).send(validRequest({ symbol: 'DOGE-USD' }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ status: 'rejected', code: 'SYMBOL_NOT_ALLOWED' });
  });

  test('rejects with AMOUNT_OUT_OF_RANGE', async () => {
    const res = await request(app).post('/trade/approve').set(auth).send(validRequest({ suggestedAmountUsd: 9999 }));
    expect(res.body.code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  test('logs rejection in decisions table', async () => {
    await request(app).post('/trade/approve').set(auth).send(validRequest({ symbol: 'DOGE-USD' }));
    const decisions = db.prepare('SELECT * FROM decisions').all();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe('rejected');
    expect(decisions[0].code).toBe('SYMBOL_NOT_ALLOWED');
  });
});

describe('POST /trade/decline', () => {
  test('logs a decline', async () => {
    const res = await request(app)
      .post('/trade/decline')
      .set(auth)
      .send({ recommendationId: 'rec-x', reason: 'looks weak' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'declined' });
    const row = db.prepare('SELECT * FROM decisions').get();
    expect(row.decision).toBe('declined');
  });
});

describe('GET /trades', () => {
  test('returns recorded trades', async () => {
    await request(app).post('/trade/approve').set(auth).send(validRequest({ recommendationId: 'rec-A' }));
    await request(app).post('/trade/approve').set(auth).send(validRequest({ recommendationId: 'rec-B' }));
    const res = await request(app).get('/trades').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

describe('GET /performance', () => {
  test('returns aggregate shape', async () => {
    const res = await request(app).get('/performance').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('totalTrades');
    expect(res.body).toHaveProperty('winRate');
    expect(res.body).toHaveProperty('netPnlUsd');
    expect(res.body).toHaveProperty('weeklyPnlUsd');
    expect(res.body).toHaveProperty('realizedRR');
  });

  test('only counts closed (win/loss) trades', async () => {
    // Open trade — outcome NULL — should not be counted
    db.prepare(
      `INSERT INTO trades (recommendation_id, symbol, side, suggested_amount_usd, confidence_score,
                           status, mode, raw_request_json)
       VALUES ('open-1', 'BTC-USD', 'buy', 10, 0.7, 'simulated', 'paper', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO trades (recommendation_id, symbol, side, suggested_amount_usd, confidence_score,
                           status, mode, simulated_pnl_usd, outcome, exit_price, exit_timestamp,
                           raw_request_json)
       VALUES ('closed-win', 'BTC-USD', 'buy', 10, 0.7, 'simulated', 'paper',
               2.4, 'win', 62160, '2026-04-28T12:00:00Z', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO trades (recommendation_id, symbol, side, suggested_amount_usd, confidence_score,
                           status, mode, simulated_pnl_usd, outcome, exit_price, exit_timestamp,
                           raw_request_json)
       VALUES ('closed-loss', 'BTC-USD', 'buy', 10, 0.7, 'simulated', 'paper',
               -1.0, 'loss', 59100, '2026-04-28T12:00:00Z', '{}')`,
    ).run();

    const res = await request(app).get('/performance').set(auth);
    expect(res.body.totalTrades).toBe(2);
    expect(res.body.wins).toBe(1);
    expect(res.body.losses).toBe(1);
    expect(res.body.openOrUnsettled).toBe(1);
    expect(res.body.realizedRR).toBeCloseTo(2.4, 2);
  });
});

describe('GET /weekly-report', () => {
  test('returns weekly shape', async () => {
    const res = await request(app).get('/weekly-report').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, period: 'last_7_days' });
  });
});

describe('live mode wiring', () => {
  test('placeOrder refuses with LIVE_TRADING_DISABLED while kill switch is off', async () => {
    // Phase 3: the Robinhood client refuses to place an order whenever
    // config.liveTradingEnabled is false, regardless of any other flag.
    // This is the second-line-of-defence guard inside the client itself.
    const robinhood = require('../src/services/robinhoodClient');
    await expect(
      robinhood.placeOrder({
        clientOrderId: 'test-uuid',
        symbol: 'ETH-USD',
        side: 'buy',
        orderType: 'limit',
        assetQuantity: 0.001,
        limitPrice: 2000,
      }),
    ).rejects.toMatchObject({ code: 'LIVE_TRADING_DISABLED' });
  });
});
