// @vitest-environment jsdom
/**
 * The transfer this device still owes a question to.
 *
 * A top-up is two events: the wallet broadcasts, then Fiddy credits. Between
 * them, the tab can die — and if that hash lived only in React state, the next
 * load could not ask Fiddy anything about it. So the hash is remembered here.
 *
 * What matters, and what is measured: a real hash is kept and read back, a
 * stored value that is not exactly that shape reads as "nothing pending"
 * (never a half-formed record a screen would try to use), and forgetting is
 * quiet even when storage refuses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: async ({ key, fallback }: { key: string; fallback: unknown }) =>
    store.has(key) ? store.get(key) : fallback,
  setItem: async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  },
  deleteItem: async (key: string) => {
    store.delete(key);
  },
}));

const {
  forgetPendingTopUp,
  PENDING_TOP_UP_KEY,
  readPendingTopUp,
  rememberPendingTopUp,
} = await import('~/lib/fiddyPendingTopUp');

const HASH = `0x${'ab'.repeat(32)}`;

beforeEach(() => {
  store.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a top-up that has been sent and not credited yet', () => {
  it('is remembered with what the screen said it was sending', async () => {
    const record = await rememberPendingTopUp({
      txHash: HASH,
      usdc: '5.00',
      source: 'wallet',
    });

    expect(record?.txHash).toBe(HASH);
    expect(store.get(PENDING_TOP_UP_KEY)).toMatchObject({
      txHash: HASH,
      usdc: '5.00',
      source: 'wallet',
    });

    const read = await readPendingTopUp();
    expect(read?.usdc).toBe('5.00');
    expect(read?.at).toBeGreaterThan(0);
  });

  it('is nothing pending when nothing was stored', async () => {
    expect(await readPendingTopUp()).toBeNull();
  });

  it('refuses a stored value that is not a real transfer', async () => {
    store.set(PENDING_TOP_UP_KEY, { txHash: 'not-a-hash', usdc: '5.00' });
    expect(await readPendingTopUp()).toBeNull();

    store.set(PENDING_TOP_UP_KEY, 'a string');
    expect(await readPendingTopUp()).toBeNull();

    expect(
      await rememberPendingTopUp({
        txHash: 'nope',
        usdc: '5.00',
        source: 'wallet',
      }),
    ).toBeNull();
  });

  it('keeps the shape honest when a stored field is missing', async () => {
    store.set(PENDING_TOP_UP_KEY, { txHash: HASH });
    const read = await readPendingTopUp();
    expect(read?.usdc).toBe('—');
    expect(read?.source).toBe('wallet');
  });

  it('forgets on request, and survives storage that refuses to', async () => {
    await rememberPendingTopUp({
      txHash: HASH,
      usdc: '5.00',
      source: 'wallet',
    });
    await forgetPendingTopUp();
    expect(await readPendingTopUp()).toBeNull();

    const failing = await import('~/utils/storageUtils');
    vi.spyOn(failing, 'deleteItem').mockRejectedValue(new Error('nope'));
    await expect(forgetPendingTopUp()).resolves.toBeUndefined();
  });
});
