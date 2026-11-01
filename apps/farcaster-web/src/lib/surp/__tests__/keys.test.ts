// @vitest-environment jsdom
/**
 * Where the key is kept, and what it is kept out of.
 *
 * The key is money, so the storage rules are the test subject: it goes in one
 * entry of its own, it never lands in the setup file (which documents that it
 * holds no key), and a stored value that is not a Surp key is ignored rather
 * than handed back.
 *
 * Creation itself is exercised against the real response shape (`fixtures/`)
 * with `fetch` stubbed, because a test that mints a live key on every run is a
 * test that writes to production.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeStorage } from '~/lib/__tests__/fakeStorage';
import { loadFiddySetup, saveFiddySetup } from '~/lib/fiddySetup';
import {
  createSurpKey,
  forgetSurpKey,
  looksLikeSurpKey,
  readSurpKey,
  readSurpKeyBalance,
  SURP_KEY_STORAGE,
} from '~/lib/surp/keys';

import keyBalance from './fixtures/key-balance.json';
import keyCreated from './fixtures/key-created.json';

const KEY = keyCreated.key as string;

beforeEach(() => {
  installFakeStorage();
});

afterEach(() => {
  forgetSurpKey();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const stubJson = (payload: unknown, status = 200) => {
  const fetchMock = vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => payload,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('a key made in this browser', () => {
  it('writes the key into its own entry', async () => {
    stubJson(keyCreated);
    const record = await createSurpKey('fiddy', 1_700_000_000_000);
    expect(readSurpKey()).toEqual(record);
    expect(window.localStorage.getItem(SURP_KEY_STORAGE)).toContain(KEY);
  });

  it('never puts the key in the setup file', async () => {
    stubJson(keyCreated);
    saveFiddySetup({ brain: 'surp' });
    await createSurpKey('fiddy');
    const setup = JSON.stringify(loadFiddySetup());
    expect(setup).not.toContain(KEY);
    expect(setup).not.toContain('sk-surp-');
  });

  it('sends a label and an empty balance — never a balance it asked for', async () => {
    const fetchMock = stubJson(keyCreated);
    await createSurpKey('  my agent  ');
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    const body = JSON.parse(init.body);
    expect(body.label).toBe('my agent');
    expect(body.balance_cents).toBe(0);
    expect(Object.keys(body).sort()).toEqual(['balance_cents', 'label']);
  });

  it('refuses a response that is not a key', async () => {
    stubJson({ key: 'sk-other-nope' });
    await expect(createSurpKey('fiddy')).rejects.toThrow('surp-key-unreadable');
    expect(readSurpKey()).toBeNull();
  });

  it('forgets on request, and only on request', async () => {
    stubJson(keyCreated);
    await createSurpKey('fiddy');
    expect(readSurpKey()).not.toBeNull();
    forgetSurpKey();
    expect(readSurpKey()).toBeNull();
  });

  it('ignores a stored value that is not a key', () => {
    window.localStorage.setItem(
      SURP_KEY_STORAGE,
      JSON.stringify({ key: 'not-a-key' }),
    );
    expect(readSurpKey()).toBeNull();
    window.localStorage.setItem(SURP_KEY_STORAGE, 'not json at all');
    expect(readSurpKey()).toBeNull();
  });

  it('recognises the shape Surp writes and nothing else', () => {
    expect(looksLikeSurpKey(KEY)).toBe(true);
    expect(looksLikeSurpKey('sk-surp-')).toBe(false);
    expect(looksLikeSurpKey('surp_abc')).toBe(false);
    expect(looksLikeSurpKey(`${KEY} `)).toBe(true);
  });
});

describe('reading what a key has left', () => {
  it('reads the balance through the read-only endpoint', async () => {
    const fetchMock = stubJson(keyBalance);
    const balance = await readSurpKeyBalance(KEY);
    expect(balance.balanceUsdCents).toBe(0);
    expect(balance.totalRequests).toBe(0);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/api/keys/balance');
    expect(url).toContain(encodeURIComponent(KEY));
  });

  it('says the key is unusable when the service refuses it', async () => {
    stubJson({ error: 'invalid key' }, 404);
    await expect(readSurpKeyBalance(KEY)).rejects.toThrow();
  });
});
