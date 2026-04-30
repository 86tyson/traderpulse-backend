'use strict';

// Robinhood Crypto Trading API client.
//
// SAFETY POSTURE — read this before touching anything in this file.
// ─────────────────────────────────────────────────────────────────
//
//  • Uses the OFFICIAL Robinhood Crypto Trading API only. No screen-scraping,
//    no Selenium, no unofficial libraries, no username/password login.
//  • Auth is per-request Ed25519 signing. The PRIVATE key never leaves this
//    process; only the PUBLIC half is uploaded to Robinhood when registering
//    the API credential.
//  • Every WRITE method (`placeOrder`, `cancelOrder`) checks
//    `config.liveTradingEnabled === true` BEFORE doing anything. The switch
//    is checked again at the route layer; this is defence-in-depth.
//  • Read-only methods (`getAccount`, `getHoldings`, `getQuote`, `getProducts`,
//    `getOrders`) do not need the kill switch — they only fetch information.
//
// VERIFY-BEFORE-GOING-LIVE checklist (run once before LIVE_TRADING_ENABLED=true):
//   1. Confirm the canonical signature payload format matches the current
//      Robinhood docs (https://docs.robinhood.com/crypto/trading/). The exact
//      string is `${api_key}${timestamp}${path}${method}${body}` per the docs
//      at the time of writing — but verify before flipping the switch. A
//      wrong canonical form yields 401 (fail-safe — no orders placed).
//   2. Sanity-check by calling `getAccount()` and reading the response. A
//      successful read confirms keys + signing format end-to-end without
//      placing any order.
//   3. Place a single $10 ETH-USD limit order well below the bid (so it does
//      not fill), confirm it shows up in `getOrders()`, then cancel it.
//   4. Only then place a real fill-able micro order.
//
// CHANGE THIS FILE WITH CARE. A bug here can cost real money.

const crypto = require('crypto');
const { config } = require('../config');
const logger = require('./logger');

// Per official Robinhood Crypto Trading docs.
const RH_BASE_URL = 'https://trading.robinhood.com';
const SIG_TIMESTAMP_DRIFT_TOLERANCE_SEC = 30;
const FETCH_TIMEOUT_MS = 15_000;

// ----- Errors -----
class NotImplementedError extends Error {
  constructor(fnName, detail) {
    super(detail || `${fnName} is not implemented yet`);
    this.name = 'NotImplementedError';
    this.code = 'NOT_IMPLEMENTED';
    this.fnName = fnName;
  }
}

class RobinhoodAuthError extends Error {
  constructor(detail, opts = {}) {
    super(detail);
    this.name = 'RobinhoodAuthError';
    this.code = 'ROBINHOOD_AUTH_FAILED';
    // Optional carriers so the route layer can surface the actual RH reason
    // to the operator. Critical for diagnosing 401-vs-403 (signing vs perm).
    this.httpStatus = opts.httpStatus ?? null;
    this.responseBody = opts.responseBody ?? null;
  }
}

class RobinhoodApiError extends Error {
  constructor(status, body, detail) {
    super(detail || `Robinhood API error ${status}`);
    this.name = 'RobinhoodApiError';
    this.code = 'ROBINHOOD_API_FAILED';
    this.httpStatus = status;
    this.responseBody = body;
  }
}

class LiveTradingDisabledError extends Error {
  constructor() {
    super(
      'LIVE_TRADING_ENABLED is false. Refusing to place a real order. ' +
        'This is a hard guard inside the Robinhood client itself.',
    );
    this.name = 'LiveTradingDisabledError';
    this.code = 'LIVE_TRADING_DISABLED';
  }
}

// ----- Key parsing -----
//
// Robinhood expects an Ed25519 signature. The user's `ROBINHOOD_PRIVATE_KEY`
// can come in either of these supported forms (we try in order):
//   1. Base64 of the raw 32-byte Ed25519 seed.
//   2. PEM-encoded PRIVATE KEY block.
//
// We construct a Node KeyObject either way and sign via crypto.sign.

function loadPrivateKey() {
  const raw = (config.robinhoodPrivateKey || '').trim();
  if (!raw) {
    throw new RobinhoodAuthError('ROBINHOOD_PRIVATE_KEY is not set.');
  }

  if (raw.startsWith('-----BEGIN')) {
    try {
      return crypto.createPrivateKey({ key: raw, format: 'pem' });
    } catch (err) {
      throw new RobinhoodAuthError(`Failed to parse PEM Ed25519 key: ${err.message}`);
    }
  }

  let seed;
  try {
    seed = Buffer.from(raw, 'base64');
  } catch (err) {
    throw new RobinhoodAuthError(`ROBINHOOD_PRIVATE_KEY is not valid base64: ${err.message}`);
  }
  if (seed.length !== 32) {
    throw new RobinhoodAuthError(
      `Decoded ROBINHOOD_PRIVATE_KEY is ${seed.length} bytes; expected 32 (Ed25519 seed).`,
    );
  }
  // Wrap the 32-byte seed in a minimal PKCS#8 DER envelope so Node will accept it.
  // Magic prefix is the OID for Ed25519 followed by the 32-byte octet-string header.
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([pkcs8Prefix, seed]);
  try {
    return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch (err) {
    throw new RobinhoodAuthError(`Failed to load raw-seed Ed25519 key: ${err.message}`);
  }
}

// ----- Signing -----
//
// Per Robinhood's Crypto Trading API docs each request must carry:
//   x-api-key:   <ROBINHOOD_API_KEY>
//   x-timestamp: <unix seconds>
//   x-signature: base64(Ed25519.sign(privateKey, canonicalMessage))
//
// where canonicalMessage = `${api_key}${timestamp}${path}${method}${body}`.
//
// `path` includes the leading "/api/..." but NOT the host. `body` is the exact
// JSON we send (or empty string for GETs). Method is uppercase.

function buildCanonicalMessage(method, path, body, timestampSec) {
  const apiKey = config.robinhoodApiKey;
  if (!apiKey) {
    throw new RobinhoodAuthError('ROBINHOOD_API_KEY is not set.');
  }
  return `${apiKey}${timestampSec}${path}${method.toUpperCase()}${body}`;
}

function signRequest(method, path, body) {
  const timestampSec = Math.floor(Date.now() / 1000);
  if (Math.abs(Date.now() / 1000 - timestampSec) > SIG_TIMESTAMP_DRIFT_TOLERANCE_SEC) {
    throw new RobinhoodAuthError(
      `System clock appears skewed by more than ${SIG_TIMESTAMP_DRIFT_TOLERANCE_SEC}s; ` +
        'fix NTP before signing requests.',
    );
  }
  const message = buildCanonicalMessage(method, path, body, timestampSec);
  const privateKey = loadPrivateKey();
  // For Ed25519, the digest algorithm is null — Ed25519 signs the message directly.
  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey);
  return {
    apiKey: config.robinhoodApiKey,
    timestampSec,
    signatureB64: signature.toString('base64'),
  };
}

// ----- Low-level request helper -----

async function rhFetch(method, path, body = null) {
  if (!config.robinhoodApiKey || !config.robinhoodPrivateKey) {
    throw new RobinhoodAuthError(
      'Robinhood credentials are missing. Set ROBINHOOD_API_KEY and ROBINHOOD_PRIVATE_KEY.',
    );
  }

  const bodyStr = body == null ? '' : JSON.stringify(body);
  const { apiKey, timestampSec, signatureB64 } = signRequest(method, path, bodyStr);

  const headers = {
    'x-api-key': apiKey,
    'x-signature': signatureB64,
    'x-timestamp': String(timestampSec),
    Accept: 'application/json',
  };
  if (bodyStr) headers['Content-Type'] = 'application/json';

  // Pino redacts api_key/private_key/authorization fields globally; the body
  // we log here is request payload only (no credentials in it).
  logger.info(
    { method, path, bodyShape: body ? Object.keys(body) : null },
    'Robinhood request',
  );

  let res;
  try {
    res = await fetch(`${RH_BASE_URL}${path}`, {
      method: method.toUpperCase(),
      headers,
      body: bodyStr || undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RobinhoodApiError(
      0,
      null,
      `Network error talking to Robinhood: ${err.message}`,
    );
  }

  let parsedBody = null;
  const text = await res.text();
  if (text) {
    try {
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = { raw: text };
    }
  }

  logger.info(
    { method, path, httpStatus: res.status, ok: res.ok },
    'Robinhood response',
  );

  if (res.status === 401 || res.status === 403) {
    // Differentiate between auth-rejected (401) and permission-denied (403).
    // 401 → signature couldn't be verified at all (key/format mismatch).
    // 403 → signature OK but the API credential lacks the permission for
    //       this method+path. Most common cause: the credential doesn't
    //       have "place orders" enabled. Surface BOTH the parsed body and
    //       the diagnostic context so the operator can act.
    const interpretation =
      res.status === 401
        ? 'signature/api-key not accepted (key id, signing format, or clock skew).'
        : 'signature accepted but credential lacks permission for this operation ' +
          '(likely "place orders" not enabled on the API credential).';
    const rhMessage =
      (parsedBody &&
        (parsedBody.error ||
          parsedBody.detail ||
          parsedBody.message ||
          parsedBody.error_description)) ||
      JSON.stringify(parsedBody) ||
      '(empty response body)';
    logger.error(
      {
        event: 'rh.auth_failed',
        method,
        path,
        httpStatus: res.status,
        responseBody: parsedBody,
      },
      `Robinhood ${res.status}: ${rhMessage}`,
    );
    throw new RobinhoodAuthError(
      `Robinhood ${res.status} on ${method} ${path}: ${rhMessage}. ` +
        `Interpretation: ${interpretation}`,
      { httpStatus: res.status, responseBody: parsedBody },
    );
  }
  if (!res.ok) {
    throw new RobinhoodApiError(
      res.status,
      parsedBody,
      `Robinhood ${method} ${path} failed with HTTP ${res.status}`,
    );
  }
  return parsedBody;
}

// ============================================================================
// Read-only API
// ============================================================================

/** Fetch the trading account summary. Read-only. */
async function getAccount() {
  return rhFetch('GET', '/api/v1/crypto/trading/accounts/');
}

/** Fetch current crypto holdings. Read-only. */
async function getHoldings() {
  return rhFetch('GET', '/api/v1/crypto/trading/holdings/');
}

/**
 * Fetch best bid/ask for the given trading pair. Read-only.
 * Use the bid for sells and ask (+ small buffer) for buys when building a
 * limit order from a USD notional.
 */
async function getQuote(symbol) {
  if (!symbol) throw new Error('getQuote: symbol is required');
  const qs = new URLSearchParams({ symbol }).toString();
  return rhFetch('GET', `/api/v1/crypto/marketdata/best_bid_ask/?${qs}`);
}

/**
 * Fetch the list of supported trading pairs and their precision rules.
 * Use min_order_size / quote_increment when sizing live orders.
 */
async function getProducts() {
  return rhFetch('GET', '/api/v1/crypto/trading/trading_pairs/');
}

/** Fetch recent orders. Read-only. */
async function getOrders() {
  return rhFetch('GET', '/api/v1/crypto/trading/orders/');
}

/** Fetch a single order by Robinhood-assigned id. Read-only. */
async function getOrderById(id) {
  if (!id) throw new Error('getOrderById: id is required');
  return rhFetch('GET', `/api/v1/crypto/trading/orders/${encodeURIComponent(id)}/`);
}

// ============================================================================
// Order placement (gated by LIVE_TRADING_ENABLED)
// ============================================================================

/**
 * Place a new crypto order.
 *
 * GUARDS (in order):
 *   1. config.liveTradingEnabled must be true. The route layer also checks
 *      this; this is the second line of defence.
 *   2. Credentials must be present (rhFetch enforces).
 *   3. Caller is expected to have already validated symbol allow-list, USD
 *      amount cap, daily loss cap, and one-position-max via liveRiskManager.
 *      This function does NOT re-run business rules — it is a thin wrapper.
 *
 * @param {object} args
 * @param {string} args.clientOrderId  - UUID; idempotency key on RH side.
 * @param {string} args.symbol         - e.g. "ETH-USD".
 * @param {"buy"|"sell"} args.side
 * @param {"limit"|"market"} args.orderType  - "limit" preferred.
 * @param {number} args.assetQuantity  - quantity in crypto units.
 * @param {number} [args.limitPrice]   - required for limit orders.
 * @param {"gtc"|"ioc"|"fok"} [args.timeInForce] - default "gtc".
 */
async function placeOrder(args) {
  if (!config.liveTradingEnabled) {
    throw new LiveTradingDisabledError();
  }

  const {
    clientOrderId,
    symbol,
    side,
    orderType,
    assetQuantity,
    limitPrice,
    timeInForce = 'gtc',
  } = args;

  if (!clientOrderId) throw new Error('placeOrder: clientOrderId is required');
  if (!symbol) throw new Error('placeOrder: symbol is required');
  if (side !== 'buy' && side !== 'sell') {
    throw new Error('placeOrder: side must be buy/sell');
  }
  if (orderType !== 'limit' && orderType !== 'market') {
    throw new Error('placeOrder: orderType must be limit or market');
  }
  if (!Number.isFinite(assetQuantity) || assetQuantity <= 0) {
    throw new Error('placeOrder: assetQuantity must be a positive number');
  }
  if (orderType === 'limit') {
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      throw new Error('placeOrder: limitPrice is required for limit orders');
    }
  }

  // RH expects amounts as strings to preserve precision.
  const body = {
    client_order_id: clientOrderId,
    symbol,
    side,
    type: orderType,
  };
  if (orderType === 'limit') {
    body.limit_order_config = {
      asset_quantity: assetQuantity.toString(),
      limit_price: limitPrice.toString(),
      time_in_force: timeInForce,
    };
  } else {
    // Market order — only used if explicitly requested. Phase 3 prefers limit.
    body.market_order_config = {
      asset_quantity: assetQuantity.toString(),
    };
  }

  return rhFetch('POST', '/api/v1/crypto/trading/orders/', body);
}

/** Cancel an open order. Gated behind the kill switch. */
async function cancelOrder(id) {
  if (!config.liveTradingEnabled) {
    throw new LiveTradingDisabledError();
  }
  if (!id) throw new Error('cancelOrder: id is required');
  return rhFetch(
    'POST',
    `/api/v1/crypto/trading/orders/${encodeURIComponent(id)}/cancel/`,
  );
}

module.exports = {
  // Errors
  NotImplementedError,
  RobinhoodAuthError,
  RobinhoodApiError,
  LiveTradingDisabledError,
  // Read-only
  getAccount,
  getHoldings,
  getQuote,
  getProducts,
  getOrders,
  getOrderById,
  // Write (gated)
  placeOrder,
  cancelOrder,
  // Internal helpers exposed for tests
  _internal: { buildCanonicalMessage, loadPrivateKey, signRequest, rhFetch },
};
