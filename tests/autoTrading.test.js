'use strict';

// Unit tests for the auto-trading gate.
//
// Verifies the safety hierarchy at the function level (no DB, no network):
//   - default config has autoTradingEnabled=false
//   - manualApprovalRequired flips correctly across the matrix
//   - canAutoTradeNow refuses without LIVE_TRADING_ENABLED, AUTO_TRADING_ENABLED,
//     BOT_ENABLED, or RH credentials
//
// No test in this file places any live order. The gate is config-only;
// per-order risk gates live in liveRiskManager.js and have their own tests.

const {
  isManualApprovalRequired,
  canAutoTradeNow,
} = require('../src/services/autoTradingGate');

const baseConfig = (overrides = {}) => ({
  liveTradingEnabled: false,
  autoTradingEnabled: false,
  botEnabled: false,
  robinhoodApiKey: '',
  robinhoodPrivateKey: '',
  ...overrides,
});

describe('config defaults', () => {
  test('AUTO_TRADING_ENABLED defaults to false in the live config object', () => {
    // Re-require config so the default is visible regardless of whether
    // .env happens to set the env var locally — the flag must default false
    // when AUTO_TRADING_ENABLED is unset.
    delete process.env.AUTO_TRADING_ENABLED;
    delete require.cache[require.resolve('../src/config')];
    const { config } = require('../src/config');
    expect(config.autoTradingEnabled).toBe(false);
  });
});

describe('isManualApprovalRequired — derives correctly across the matrix', () => {
  test('live OFF → manual approval is NOT required (no live orders possible at all)', () => {
    expect(
      isManualApprovalRequired(
        baseConfig({ liveTradingEnabled: false, autoTradingEnabled: false }),
      ),
    ).toBe(false);
    expect(
      isManualApprovalRequired(
        baseConfig({ liveTradingEnabled: false, autoTradingEnabled: true }),
      ),
    ).toBe(false);
  });

  test('live ON + auto OFF → manual approval IS required (the only path)', () => {
    expect(
      isManualApprovalRequired(
        baseConfig({ liveTradingEnabled: true, autoTradingEnabled: false }),
      ),
    ).toBe(true);
  });

  test('live ON + auto ON → manual approval is NOT required (auto loop could act)', () => {
    expect(
      isManualApprovalRequired(
        baseConfig({ liveTradingEnabled: true, autoTradingEnabled: true }),
      ),
    ).toBe(false);
  });

  test('handles missing config gracefully', () => {
    expect(isManualApprovalRequired(null)).toBe(false);
    expect(isManualApprovalRequired(undefined)).toBe(false);
  });
});

describe('canAutoTradeNow — auto execution refused without all gates passing', () => {
  const fullyEnabled = () =>
    baseConfig({
      liveTradingEnabled: true,
      autoTradingEnabled: true,
      botEnabled: true,
      robinhoodApiKey: 'rh-key',
      robinhoodPrivateKey: 'rh-private',
    });

  test('all gates pass → ok:true', () => {
    expect(canAutoTradeNow({ config: fullyEnabled() })).toEqual({ ok: true });
  });

  test('LIVE_TRADING_ENABLED=false → blocked at the kill switch', () => {
    const r = canAutoTradeNow({
      config: { ...fullyEnabled(), liveTradingEnabled: false },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('LIVE_TRADING_DISABLED');
  });

  test('AUTO_TRADING_ENABLED=false → blocked', () => {
    const r = canAutoTradeNow({
      config: { ...fullyEnabled(), autoTradingEnabled: false },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('AUTO_TRADING_DISABLED');
  });

  test('BOT_ENABLED=false → blocked', () => {
    const r = canAutoTradeNow({
      config: { ...fullyEnabled(), botEnabled: false },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('BOT_DISABLED');
  });

  test('Robinhood keys missing → blocked', () => {
    const r = canAutoTradeNow({
      config: { ...fullyEnabled(), robinhoodPrivateKey: '' },
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('ROBINHOOD_KEYS_MISSING');
  });

  test('missing config object → blocked, never throws', () => {
    expect(canAutoTradeNow({}).ok).toBe(false);
    expect(canAutoTradeNow({ config: null }).ok).toBe(false);
    expect(canAutoTradeNow().ok).toBe(false);
  });

  test('LIVE off takes priority over AUTO off in the diagnostic message', () => {
    // When BOTH live and auto are off (the default state), we want the user
    // to see "kill switch is off" first — that's the more actionable signal.
    const r = canAutoTradeNow({
      config: {
        ...fullyEnabled(),
        liveTradingEnabled: false,
        autoTradingEnabled: false,
      },
    });
    expect(r.code).toBe('LIVE_TRADING_DISABLED');
  });
});

// ============================================================================
// Manual approval still works regardless of AUTO_TRADING_ENABLED
// ============================================================================
//
// The /live/approve route is gated by liveRiskManager.evaluateLive, which
// checks LIVE_TRADING_ENABLED but NOT AUTO_TRADING_ENABLED. This is correct:
// manual approvals from the dashboard should always be possible whenever
// the kill switch is on, whether auto trading is enabled or not.

describe('liveRiskManager.evaluateLive does NOT depend on autoTradingEnabled', () => {
  const liveRiskManager = require('../src/services/liveRiskManager');
  const db = require('../src/db');

  beforeEach(() => {
    db.exec('DELETE FROM trades; DELETE FROM decisions;');
  });

  function validRequest() {
    return {
      recommendationId: 'manual-rec-' + Math.random().toString(36).slice(2, 10),
      symbol: 'ETH-USD',
      side: 'buy',
      usdAmount: 10,
      confirmedRealMoney: true,
    };
  }

  test('live ON + auto OFF → manual approval passes the risk pipeline', () => {
    const v = liveRiskManager.evaluateLive(validRequest(), {
      config: {
        liveTradingEnabled: true,
        autoTradingEnabled: false,
        botEnabled: false,
        robinhoodApiKey: 'k',
        robinhoodPrivateKey: 'p',
        liveMaxOrderUsd: 10,
        liveDailyLossCapUsd: 10,
        liveAllowedSymbols: ['ETH-USD'],
      },
    });
    expect(v.ok).toBe(true);
  });

  test('live ON + auto ON → manual approval ALSO passes (additive, not replacing)', () => {
    const v = liveRiskManager.evaluateLive(validRequest(), {
      config: {
        liveTradingEnabled: true,
        autoTradingEnabled: true,
        botEnabled: true,
        robinhoodApiKey: 'k',
        robinhoodPrivateKey: 'p',
        liveMaxOrderUsd: 10,
        liveDailyLossCapUsd: 10,
        liveAllowedSymbols: ['ETH-USD'],
      },
    });
    expect(v.ok).toBe(true);
  });

  test('live OFF (regardless of auto) → still blocked', () => {
    const v = liveRiskManager.evaluateLive(validRequest(), {
      config: {
        liveTradingEnabled: false,
        autoTradingEnabled: true, // even with auto on
        botEnabled: true,
        robinhoodApiKey: 'k',
        robinhoodPrivateKey: 'p',
        liveMaxOrderUsd: 10,
        liveDailyLossCapUsd: 10,
        liveAllowedSymbols: ['ETH-USD'],
      },
    });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('LIVE_TRADING_DISABLED');
  });
});

// ============================================================================
// /live/status endpoint exposes autoTradingEnabled + manualApprovalRequired
// ============================================================================

describe('GET /live/status exposes the new auto-trading fields', () => {
  const request = require('supertest');
  const { buildApp } = require('../src/server');
  const app = buildApp();
  const AUTH = `Bearer ${process.env.BACKEND_API_KEY}`;

  test('returns autoTradingEnabled and manualApprovalRequired (false / false in test env)', async () => {
    const res = await request(app)
      .get('/live/status')
      .set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.autoTradingEnabled).toBe('boolean');
    expect(typeof res.body.manualApprovalRequired).toBe('boolean');
    // Default test env: live off, auto off, so manualApprovalRequired=false
    // (no live orders possible at all).
    expect(res.body.liveTradingEnabled).toBe(false);
    expect(res.body.autoTradingEnabled).toBe(false);
    expect(res.body.manualApprovalRequired).toBe(false);
  });
});

describe('GET /health exposes the new auto-trading fields', () => {
  const request = require('supertest');
  const { buildApp } = require('../src/server');
  const app = buildApp();

  test('returns autoTradingEnabled and manualApprovalRequired (no auth required for /health)', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.autoTradingEnabled).toBe(false);
    expect(res.body.manualApprovalRequired).toBe(false);
  });
});
