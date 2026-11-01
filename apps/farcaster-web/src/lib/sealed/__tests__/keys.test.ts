import { beforeEach, describe, expect, it } from 'vitest';

import {
  createIdentity,
  forgetIdentity,
  forgetSavedKey,
  getOrCreateKey,
  identityStorageKey,
  keyRegistryStorageKey,
  listSavedKeys,
  loadIdentity,
  memoryKeyValueStore,
  sameFingerprint,
  saveKey,
  sealedCryptoAvailable,
  type SealedKeyValueStore,
} from '~/lib/sealed/keys';

let store: SealedKeyValueStore;

beforeEach(() => {
  store = memoryKeyValueStore();
});

describe('this browser’s key', () => {
  it('is made once and then found again', async () => {
    const first = await getOrCreateKey(store, () => 1_700_000_000_000);
    const second = await getOrCreateKey(store);

    expect(second.publicKeyRaw).toEqual(first.publicKeyRaw);
    expect(second.fingerprintHex).toBe(first.fingerprintHex);
    expect(second.share).toBe(first.share);
    /* The stored key remembers when it was made; the second read reuses it. */
    expect(second.createdAt).toBe(1_700_000_000_000);
  });

  it('hands back a private key nobody can export', async () => {
    const identity = await getOrCreateKey(store);

    await expect(
      globalThis.crypto.subtle.exportKey('jwk', identity.privateKey),
    ).rejects.toThrow();

    /* And it still works for what it is for. */
    const peer = await createIdentity();
    await expect(
      globalThis.crypto.subtle.deriveBits(
        {
          name: 'ECDH',
          public: await globalThis.crypto.subtle.importKey(
            'raw',
            peer.publicKeyRaw,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            [],
          ),
        },
        identity.privateKey,
        256,
      ),
    ).resolves.toBeTruthy();
  });

  it('stores the key in this storage and nowhere else', async () => {
    await getOrCreateKey(store);

    expect(store.getItem(identityStorageKey)).toContain('"format":1');
    expect(listSavedKeys(store)).toEqual([]);
  });

  it('reports no key when the stored one is junk, rather than half a key', async () => {
    expect(await loadIdentity(store)).toBeNull();

    store.setItem(identityStorageKey, 'not json');
    expect(await loadIdentity(store)).toBeNull();

    store.setItem(identityStorageKey, JSON.stringify({ format: 1, jwk: {} }));
    expect(await loadIdentity(store)).toBeNull();
  });

  it('forgets the key on request', async () => {
    await getOrCreateKey(store);
    forgetIdentity(store);

    expect(store.getItem(identityStorageKey)).toBeNull();
    expect(await loadIdentity(store)).toBeNull();
  });
});

describe('keys other people shared', () => {
  it('saves one, lists it, and does not duplicate it', async () => {
    const friend = await createIdentity();
    const saved = await saveKey(friend.share, store, { label: 'Ada' });

    expect(saved.label).toBe('Ada');
    expect(saved.fingerprintHex).toBe(friend.fingerprintHex);

    await saveKey(friend.share, store, { label: 'Ada again' });

    const list = listSavedKeys(store);

    expect(list.length).toBe(1);
    expect(list[0]!.label).toBe('Ada again');
  });

  it('falls back to the fingerprint when nobody said who it is', async () => {
    const friend = await createIdentity();
    const saved = await saveKey(friend.share, store);

    expect(saved.label).toBe(friend.fingerprintHex);
  });

  it('refuses something that is not a key', async () => {
    await expect(saveKey('fdy-key-1:nope', store)).rejects.toThrow(
      /not a key we can seal to/,
    );
  });

  it('forgets one without touching the others', async () => {
    const first = await createIdentity();
    const second = await createIdentity();

    await saveKey(first.share, store);
    await saveKey(second.share, store);
    forgetSavedKey(first.fingerprintHex, store);

    const list = listSavedKeys(store);

    expect(list.length).toBe(1);
    expect(list[0]!.fingerprintHex).toBe(second.fingerprintHex);
  });

  it('survives a registry that has been tampered with', () => {
    store.setItem(keyRegistryStorageKey, '{"not":"an array"}');

    expect(listSavedKeys(store)).toEqual([]);
  });
});

describe('fingerprints', () => {
  it('compare without leaking where they differ', async () => {
    const identity = await createIdentity();
    const near = new Uint8Array(identity.fingerprint);

    expect(sameFingerprint(identity.fingerprint, identity.fingerprint)).toBe(
      true,
    );
    expect(sameFingerprint(identity.fingerprint, near)).toBe(true);

    near[0] = (near[0]! + 1) % 256;

    expect(sameFingerprint(identity.fingerprint, near)).toBe(false);
    expect(sameFingerprint(identity.fingerprint, near.slice(0, 3))).toBe(false);
  });
});

describe('the environment', () => {
  it('says WebCrypto is here, because every test above used it', () => {
    expect(sealedCryptoAvailable()).toBe(true);
  });
});
