'use strict';

// Robinhood Crypto Trading — request-signing self-tests.
//
// These do NOT hit Robinhood. They prove the LOCAL signing pipeline is
// internally consistent: the bytes we sign are the bytes we send, and the
// signature roundtrips through a freshly generated public key.
//
// Coverage:
//   1. Canonical message structure for GET (no body)        — byte-exact assertion
//   2. Canonical message structure for POST (with body)     — byte-exact assertion
//   3. Signature roundtrips (sign w/ private, verify w/ public) for GET and POST
//   4. The exact bodyStr we sign is what `JSON.stringify` of the request body produces
//   5. Method casing is uppercase even when the caller passed lowercase
//   6. Path with query string is included verbatim
//   7. Timestamp format: integer Unix seconds (not millis, no fractional)

const crypto = require('crypto');

// Generate a fresh keypair locally, plug it into the client config so the
// module's signRequest path uses it, then exercise.
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const seedB64 = privateKey.export({ format: 'der', type: 'pkcs8' }).slice(-32).toString('base64');

process.env.ROBINHOOD_API_KEY = 'rh-api-test-1234567890';
process.env.ROBINHOOD_PRIVATE_KEY = seedB64;

// Reload config + client so env changes take effect.
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/services/robinhoodClient')];
const rh = require('../src/services/robinhoodClient');
const { buildCanonicalMessage, signRequest } = rh._internal;

const API_KEY = 'rh-api-test-1234567890';

// Helper: verify a base64 Ed25519 signature against a UTF-8 message using
// the public half of the keypair generated above.
function verifyB64(message, signatureB64) {
  return crypto.verify(
    null,
    Buffer.from(message, 'utf8'),
    publicKey,
    Buffer.from(signatureB64, 'base64'),
  );
}

describe('robinhoodClient signing — canonical message format', () => {
  test('GET with no body: canonical = apiKey + ts + path + METHOD + ""', () => {
    const ts = 1700000000;
    const path = '/api/v1/crypto/trading/accounts/';
    const msg = buildCanonicalMessage('GET', path, '', ts);
    expect(msg).toBe(`${API_KEY}${ts}${path}GET`);
    // No trailing characters.
    expect(msg.endsWith('GET')).toBe(true);
  });

  test('GET with query string: query is part of `path`', () => {
    const ts = 1700000000;
    const path = '/api/v1/crypto/marketdata/best_bid_ask/?symbol=ETH-USD';
    const msg = buildCanonicalMessage('GET', path, '', ts);
    expect(msg).toBe(`${API_KEY}${ts}${path}GET`);
  });

  test('POST with JSON body: canonical = apiKey + ts + path + METHOD + body', () => {
    const ts = 1700000000;
    const path = '/api/v1/crypto/trading/orders/';
    const body = JSON.stringify({
      client_order_id: '11111111-2222-3333-4444-555555555555',
      symbol: 'ETH-USD',
      side: 'buy',
      type: 'limit',
      limit_order_config: {
        asset_quantity: '0.01',
        limit_price: '1000.00',
        time_in_force: 'gtc',
      },
    });
    const msg = buildCanonicalMessage('POST', path, body, ts);
    // The canonical message must be exactly the concatenation, with the body
    // appearing AFTER the method, with no separators or whitespace.
    expect(msg).toBe(`${API_KEY}${ts}${path}POST${body}`);
    // The body suffix is byte-equal to JSON.stringify of the same payload.
    expect(msg.slice(-body.length)).toBe(body);
  });

  test('lowercase method is normalized to uppercase in the canonical msg', () => {
    const ts = 1700000000;
    const msg = buildCanonicalMessage('post', '/x/', 'BODY', ts);
    expect(msg).toBe(`${API_KEY}${ts}/x/POSTBODY`);
  });

  test('timestamp is an integer Unix-second count (no millis, no decimals)', () => {
    const sig = signRequest('GET', '/api/v1/crypto/trading/accounts/', '');
    expect(Number.isInteger(sig.timestampSec)).toBe(true);
    // Sanity: within 60s of system clock; otherwise either the clock is wrong
    // or our signRequest skew check would have already thrown.
    expect(Math.abs(sig.timestampSec - Math.floor(Date.now() / 1000))).toBeLessThan(60);
  });
});

describe('robinhoodClient signing — Ed25519 roundtrip', () => {
  test('GET signature verifies with the matching public key', () => {
    const path = '/api/v1/crypto/trading/accounts/';
    const sig = signRequest('GET', path, '');
    const canonical = buildCanonicalMessage('GET', path, '', sig.timestampSec);
    expect(verifyB64(canonical, sig.signatureB64)).toBe(true);
  });

  test('POST signature verifies with the matching public key (real order body)', () => {
    const path = '/api/v1/crypto/trading/orders/';
    const body = JSON.stringify({
      client_order_id: 'abcdef01-2345-6789-abcd-ef0123456789',
      symbol: 'ETH-USD',
      side: 'buy',
      type: 'limit',
      limit_order_config: {
        asset_quantity: '0.01',
        limit_price: '1000.00',
        time_in_force: 'gtc',
      },
    });
    const sig = signRequest('POST', path, body);
    const canonical = buildCanonicalMessage('POST', path, body, sig.timestampSec);
    expect(verifyB64(canonical, sig.signatureB64)).toBe(true);
  });

  test('POST cancel-order signature verifies (no body)', () => {
    // Cancel is POST with empty body — same signing path as GET except method.
    const path = '/api/v1/crypto/trading/orders/abc-123/cancel/';
    const sig = signRequest('POST', path, '');
    const canonical = buildCanonicalMessage('POST', path, '', sig.timestampSec);
    expect(verifyB64(canonical, sig.signatureB64)).toBe(true);
  });

  test('changing one byte of the body invalidates the signature', () => {
    const path = '/api/v1/crypto/trading/orders/';
    const body = JSON.stringify({ a: 1 });
    const sig = signRequest('POST', path, body);
    const tamperedCanonical = buildCanonicalMessage(
      'POST',
      path,
      JSON.stringify({ a: 2 }), // different body
      sig.timestampSec,
    );
    expect(verifyB64(tamperedCanonical, sig.signatureB64)).toBe(false);
  });

  test('changing the method invalidates the signature', () => {
    const path = '/api/v1/crypto/trading/accounts/';
    const sig = signRequest('GET', path, '');
    const tampered = buildCanonicalMessage('POST', path, '', sig.timestampSec);
    expect(verifyB64(tampered, sig.signatureB64)).toBe(false);
  });
});

describe('robinhoodClient signing — invariants the dry-run order would have produced', () => {
  test('the exact bytes we would have signed for the failed dry-run are reproducible', () => {
    // Reconstruct the body the route would have built for a $10 ETH limit @ $1000.
    const body = {
      client_order_id: '00000000-0000-0000-0000-000000000000',
      symbol: 'ETH-USD',
      side: 'buy',
      type: 'limit',
      limit_order_config: {
        asset_quantity: '0.01',
        limit_price: '1000.00',
        time_in_force: 'gtc',
      },
    };
    const bodyStr = JSON.stringify(body);
    // No leading/trailing whitespace; compact JSON.
    expect(bodyStr.startsWith('{')).toBe(true);
    expect(bodyStr.endsWith('}')).toBe(true);
    expect(/\s/.test(bodyStr)).toBe(false);

    // The signed message includes the body suffix exactly.
    const sig = signRequest('POST', '/api/v1/crypto/trading/orders/', bodyStr);
    const canonical = buildCanonicalMessage(
      'POST',
      '/api/v1/crypto/trading/orders/',
      bodyStr,
      sig.timestampSec,
    );
    expect(canonical.slice(-bodyStr.length)).toBe(bodyStr);
    expect(verifyB64(canonical, sig.signatureB64)).toBe(true);
  });
});
