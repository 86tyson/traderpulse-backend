'use strict';

// Unit tests for src/services/orderPoller.js.
//
// All tests use injected `sleep` (instant resolve) and `getOrderById` (jest
// mock) so they execute in milliseconds. No real Robinhood traffic. No real
// wall-clock waits.

const { pollUntilTerminal } = require('../src/services/orderPoller');

const noopSleep = () => Promise.resolve();

describe('pollUntilTerminal — terminal-state branches', () => {
  test('stops immediately when order is filled', async () => {
    const getOrderById = jest.fn().mockResolvedValue({
      id: 'abc',
      state: 'filled',
      filled_asset_quantity: '0.005',
      average_price: '2300.00',
    });
    const result = await pollUntilTerminal('abc', {
      intervalMs: 100,
      maxWaitMs: 1000,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.timedOut).toBe(false);
    expect(result.state).toBe('filled');
    expect(result.pollCount).toBe(1);
    expect(getOrderById).toHaveBeenCalledTimes(1);
  });

  test('stops on rejected', async () => {
    const getOrderById = jest.fn().mockResolvedValue({ id: 'x', state: 'rejected' });
    const result = await pollUntilTerminal('x', {
      intervalMs: 100,
      maxWaitMs: 1000,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.timedOut).toBe(false);
    expect(result.state).toBe('rejected');
  });

  test('stops on cancelled (US spelling)', async () => {
    const getOrderById = jest.fn().mockResolvedValue({ id: 'y', state: 'canceled' });
    const result = await pollUntilTerminal('y', {
      intervalMs: 100,
      maxWaitMs: 1000,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.timedOut).toBe(false);
    expect(result.state).toBe('canceled');
  });

  test('stops on cancelled (UK spelling — both accepted)', async () => {
    const getOrderById = jest.fn().mockResolvedValue({ id: 'z', state: 'cancelled' });
    const result = await pollUntilTerminal('z', {
      intervalMs: 100,
      maxWaitMs: 1000,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.timedOut).toBe(false);
    expect(result.state).toBe('cancelled');
  });

  test('stops on failed', async () => {
    const getOrderById = jest.fn().mockResolvedValue({ id: 'q', state: 'failed' });
    const result = await pollUntilTerminal('q', {
      intervalMs: 100,
      maxWaitMs: 1000,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.timedOut).toBe(false);
    expect(result.state).toBe('failed');
  });
});

describe('pollUntilTerminal — non-terminal states wait through', () => {
  test('polls multiple times when state stays "open" then transitions to filled', async () => {
    const getOrderById = jest
      .fn()
      .mockResolvedValueOnce({ id: 'a', state: 'open' })
      .mockResolvedValueOnce({ id: 'a', state: 'open' })
      .mockResolvedValueOnce({ id: 'a', state: 'filled', average_price: '2300', filled_asset_quantity: '0.005' });
    const result = await pollUntilTerminal('a', {
      intervalMs: 1,
      maxWaitMs: 1000,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.timedOut).toBe(false);
    expect(result.state).toBe('filled');
    expect(result.pollCount).toBe(3);
  });

  test('treats "queued" and "partially_filled" as non-terminal', async () => {
    const getOrderById = jest
      .fn()
      .mockResolvedValueOnce({ id: 'b', state: 'queued' })
      .mockResolvedValueOnce({ id: 'b', state: 'partially_filled', filled_asset_quantity: '0.001' })
      .mockResolvedValueOnce({ id: 'b', state: 'filled', average_price: '2300', filled_asset_quantity: '0.005' });
    const result = await pollUntilTerminal('b', {
      intervalMs: 1,
      maxWaitMs: 1000,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.state).toBe('filled');
    expect(result.pollCount).toBe(3);
  });
});

describe('pollUntilTerminal — timeout', () => {
  test('returns timedOut=true when order never reaches terminal state', async () => {
    const getOrderById = jest.fn().mockResolvedValue({ id: 'c', state: 'open' });
    const result = await pollUntilTerminal('c', {
      intervalMs: 10,
      maxWaitMs: 30,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.timedOut).toBe(true);
    expect(result.state).toBe('open');
    expect(result.pollCount).toBeGreaterThanOrEqual(1);
    // The final returned order should still be the latest fetch.
    expect(result.order.state).toBe('open');
  });

  test('still polls once even when maxWaitMs is small', async () => {
    const getOrderById = jest.fn().mockResolvedValue({ id: 'd', state: 'open' });
    const result = await pollUntilTerminal('d', {
      intervalMs: 100,
      maxWaitMs: 50,
      sleep: noopSleep,
      getOrderById,
    });
    expect(getOrderById).toHaveBeenCalledTimes(1);
    expect(result.timedOut).toBe(true);
  });
});

describe('pollUntilTerminal — fetch errors are retried, not fatal', () => {
  test('a transient fetch error does not crash the poll; next poll succeeds', async () => {
    const getOrderById = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient network blip'))
      .mockResolvedValueOnce({ id: 'e', state: 'filled', average_price: '2300', filled_asset_quantity: '0.005' });
    const result = await pollUntilTerminal('e', {
      intervalMs: 1,
      maxWaitMs: 1000,
      sleep: noopSleep,
      getOrderById,
    });
    expect(result.timedOut).toBe(false);
    expect(result.state).toBe('filled');
    expect(result.pollCount).toBe(2);
  });

  test('throws synchronously when orderId is missing', async () => {
    await expect(pollUntilTerminal('', { sleep: noopSleep, getOrderById: jest.fn() })).rejects.toThrow(
      /orderId is required/,
    );
  });
});
