/**
 * Storage and preference behaviour that the node page depends on.
 *
 * The secrets half is the important half: the app key is the only key material
 * this client persists, and the *only* thing `clearAppKey` is allowed to leave
 * behind is nothing at all. `localforage` is mocked so the tests assert the exact
 * keys written rather than trusting a wrapper.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, unknown>();

vi.mock('~/utils/storageUtils', () => ({
  getItem: vi.fn(
    async ({ key, fallback }: { key: string; fallback: unknown }) =>
      store.has(key) ? store.get(key) : fallback,
  ),
  setItem: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
    store.set(key, value);
  }),
  deleteItem: vi.fn(async (key: string) => {
    store.delete(key);
  }),
}));

import {
  clearAppKey,
  loadAppKey,
  loadAppNonce,
  saveAppKey,
  saveAppNonce,
} from '~/snapchain/appKeyStorage';
import {
  DEFAULT_FILTER_POLICY,
  loadClientLabels,
  loadFilterPolicy,
  requestFidFromClientId,
  saveClientLabels,
  saveFilterPolicy,
  toKnownClients,
  withClientLabel,
} from '~/snapchain/nodePreferences';

describe('app key storage', () => {
  beforeEach(() => {
    store.clear();
  });

  it('round-trips the private key hex for one FID', async () => {
    expect(await loadAppKey(1234)).toBeNull();
    await saveAppKey(1234, '0xabcdef');
    expect(await loadAppKey(1234)).toBe('0xabcdef');
    // Keys are per FID: another account must not inherit this one.
    expect(await loadAppKey(5678)).toBeNull();
  });

  it('clears the key and the nonce together on revoke', async () => {
    await saveAppKey(1234, '0xabcdef');
    await saveAppNonce(1234, 4);
    await clearAppKey(1234);

    expect(await loadAppKey(1234)).toBeNull();
    expect(await loadAppNonce(1234)).toBe(1);
  });

  it('defaults the app nonce to 1, the first value the node will accept', async () => {
    expect(await loadAppNonce(999)).toBe(1);
    await saveAppNonce(999, 3);
    expect(await loadAppNonce(999)).toBe(3);
  });

  it('stores nothing but the key: no mnemonic-shaped values anywhere', async () => {
    await saveAppKey(1234, '0xabcdef');
    const values = [...store.values()].map((value) => JSON.stringify(value));
    expect(values.some((value) => /test test test/.test(value))).toBe(false);
    expect(
      [...store.keys()].every((key) => key.startsWith('snapchain_app_')),
    ).toBe(true);
  });
});

describe('client filter preferences', () => {
  beforeEach(() => {
    store.clear();
  });

  it('defaults to showing everything', async () => {
    expect(await loadFilterPolicy(1234)).toEqual(DEFAULT_FILTER_POLICY);
  });

  it('round-trips a policy per FID', async () => {
    await saveFilterPolicy(1234, { mode: 'exclude', clientIds: ['app:9152'] });
    expect(await loadFilterPolicy(1234)).toEqual({
      mode: 'exclude',
      clientIds: ['app:9152'],
    });
    expect(await loadFilterPolicy(5678)).toEqual(DEFAULT_FILTER_POLICY);
  });

  it('ignores a corrupted stored policy instead of throwing', async () => {
    await saveFilterPolicy(1234, {
      mode: 'nonsense',
      clientIds: 'all',
    } as never);
    expect(await loadFilterPolicy(1234)).toEqual(DEFAULT_FILTER_POLICY);
  });
});

describe('client labels', () => {
  it('only app FIDs can be named', () => {
    expect(requestFidFromClientId('app:9152')).toBe(9152);
    expect(requestFidFromClientId('self')).toBeNull();
    expect(requestFidFromClientId('signer:0xabc')).toBeNull();
  });

  it('sets and clears a label', () => {
    const named = withClientLabel({}, 'app:9152', '  my other client  ');
    expect(named).toEqual({ '9152': 'my other client' });
    expect(withClientLabel(named, 'app:9152', '   ')).toEqual({});
  });

  it('refuses to name a client with no app FID', () => {
    expect(withClientLabel({}, 'signer:0xabc', 'whatever')).toEqual({});
  });

  it('maps stored labels to the numeric keys the resolver takes', async () => {
    const labels = { '9152': 'other app', oops: 'ignored' };
    expect(toKnownClients(labels)).toEqual({ 9152: 'other app' });

    await saveClientLabels(1234, labels);
    expect(await loadClientLabels(1234)).toEqual(labels);
    expect(await loadClientLabels(5678)).toEqual({});
  });
});
