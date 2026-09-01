import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfirmedAllowance } from '~/utils/readConfirmedAllowance';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function options(read = vi.fn().mockResolvedValue(25n)) {
  return { read, assertCurrent: vi.fn(), onRetry: vi.fn() };
}

describe('confirmed allowance RPC catch-up', () => {
  it('returns immediately when the block is available', async () => {
    const input = options();
    expect(await readConfirmedAllowance(input)).toBe(25n);
    expect(input.read).toHaveBeenCalledOnce();
    expect(input.onRetry).not.toHaveBeenCalled();
  });
  it('returns a real zero without retrying or inventing allowance', async () => {
    const input = options(vi.fn().mockResolvedValue(0n));
    expect(await readConfirmedAllowance(input)).toBe(0n);
    expect(input.read).toHaveBeenCalledOnce();
  });
  it('waits between missing-block responses and returns the eventual allowance', async () => {
    const input = options(
      vi
        .fn()
        .mockRejectedValueOnce(new Error('block not found: 0x305b0a6'))
        .mockRejectedValueOnce({ cause: { details: 'header not found' } })
        .mockResolvedValue(25n),
    );
    const result = readConfirmedAllowance(input);
    await vi.advanceTimersByTimeAsync(1499);
    expect(input.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(input.read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toBe(25n);
    expect(input.onRetry).toHaveBeenCalledTimes(2);
  });
  it('stops after eight attempts with a clear message', async () => {
    const input = options(
      vi.fn().mockRejectedValue(new Error('unknown block')),
    );
    const result = expect(readConfirmedAllowance(input)).rejects.toThrow(
      'Approval confirmed, but Base RPC could not read its block yet',
    );
    await vi.runAllTimersAsync();
    await result;
    expect(input.read).toHaveBeenCalledTimes(8);
    expect(input.onRetry).toHaveBeenCalledTimes(7);
  });
  it('names the active chain when its confirmed block stays unavailable', async () => {
    const input = {
      ...options(vi.fn().mockRejectedValue(new Error('unknown block'))),
      chainName: 'Ethereum',
    };
    const result = expect(readConfirmedAllowance(input)).rejects.toThrow(
      'Ethereum RPC could not read its block yet',
    );
    await vi.runAllTimersAsync();
    await result;
  });
  it.each(['execution reverted', 'HTTP 403', 'invalid address'])(
    'does not retry an unrelated failure: %s',
    async (message) => {
      const input = options(vi.fn().mockRejectedValue(new Error(message)));
      await expect(readConfirmedAllowance(input)).rejects.toThrow(message);
      expect(input.read).toHaveBeenCalledOnce();
      expect(input.onRetry).not.toHaveBeenCalled();
    },
  );
  it('stops before another read when the wallet changes during the delay', async () => {
    const input = options(
      vi.fn().mockRejectedValue(new Error('block not found')),
    );
    const result = expect(readConfirmedAllowance(input)).rejects.toThrow(
      'Wallet changed',
    );
    await vi.advanceTimersByTimeAsync(0);
    input.assertCurrent.mockImplementation(() => {
      throw new Error('Wallet changed');
    });
    await vi.runAllTimersAsync();
    await result;
    expect(input.read).toHaveBeenCalledOnce();
  });
  it('rejects a late read after the wallet changes', async () => {
    let resolve!: (value: bigint) => void;
    const input = options(
      vi.fn().mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const result = expect(readConfirmedAllowance(input)).rejects.toThrow(
      'Wallet changed',
    );
    input.assertCurrent.mockImplementation(() => {
      throw new Error('Wallet changed');
    });
    resolve(25n);
    await result;
    expect(input.onRetry).not.toHaveBeenCalled();
  });
  it('handles cyclic error causes without looping', async () => {
    const error: { message: string; cause?: unknown } = {
      message: 'RPC failed',
    };
    error.cause = error;
    const input = options(vi.fn().mockRejectedValue(error));
    await expect(readConfirmedAllowance(input)).rejects.toBe(error);
    expect(input.read).toHaveBeenCalledOnce();
  });
});
