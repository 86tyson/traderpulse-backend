'use strict';

// Generic Robinhood-order terminal-state poller.
//
// Calls `getOrderById(id)` repeatedly until either the returned `state` is
// terminal (filled / canceled / rejected / failed) or a deadline elapses.
// Defaults: 2-second poll interval, 60-second maximum wait. Returns the
// final order shape verbatim plus a `timedOut` flag — the CALLER decides
// what to do based on `state`.
//
// Dependencies (`sleep`, `getOrderById`) are injectable for testing — the
// unit tests pass instant sleepers and a mock getter so they run in millis.

const robinhood = require('./robinhoodClient');
const logger = require('./logger');

const TERMINAL_STATES = new Set([
  'filled',
  // Robinhood has shipped both spellings historically; accept either.
  'canceled',
  'cancelled',
  'rejected',
  'failed',
]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} orderId - Robinhood order id (UUID).
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=2000]   Time between polls.
 * @param {number} [opts.maxWaitMs=60000]   Deadline for total elapsed time.
 * @param {function} [opts.sleep]           Injectable sleeper (tests).
 * @param {function} [opts.getOrderById]    Injectable RH client method (tests).
 * @returns {Promise<{
 *   timedOut: boolean,
 *   order: object | null,
 *   state: string,
 *   pollCount: number,
 *   elapsedMs: number,
 * }>}
 */
async function pollUntilTerminal(orderId, opts = {}) {
  if (!orderId) throw new Error('pollUntilTerminal: orderId is required');
  const intervalMs = opts.intervalMs ?? 2000;
  const maxWaitMs = opts.maxWaitMs ?? 60000;
  const sleep = opts.sleep ?? defaultSleep;
  const getOrderById = opts.getOrderById ?? robinhood.getOrderById;

  const start = Date.now();
  let pollCount = 0;
  let order = null;

  // We always poll at least once so a maxWaitMs of 0 still attempts a fetch.
  // The loop exits when either a terminal state is observed or the next
  // sleep would push us past the deadline.
  for (;;) {
    pollCount += 1;
    try {
      order = await getOrderById(orderId);
    } catch (err) {
      // A transient fetch failure shouldn't crash the poll. Log and retry.
      logger.warn(
        { event: 'orderPoller.fetch_fail', orderId, pollCount, msg: err.message },
        `orderPoller fetch failed (will retry): ${err.message}`,
      );
      order = null;
    }

    const state = order?.state ?? null;
    if (state && TERMINAL_STATES.has(state)) {
      return {
        timedOut: false,
        order,
        state,
        pollCount,
        elapsedMs: Date.now() - start,
      };
    }

    const elapsed = Date.now() - start;
    if (elapsed + intervalMs >= maxWaitMs) {
      // Either we've already hit the deadline or a sleep would put us over.
      return {
        timedOut: true,
        order,
        state: order?.state ?? 'unknown',
        pollCount,
        elapsedMs: elapsed,
      };
    }
    await sleep(intervalMs);
  }
}

module.exports = { pollUntilTerminal, TERMINAL_STATES };
