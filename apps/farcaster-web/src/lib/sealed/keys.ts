/**
 * The keys a sealed cast needs, and the places they are never sent.
 *
 * Everything here is the browser's own WebCrypto: an ECDH key pair on P-256,
 * generated on this device, whose *private* half is stored in this browser and
 * nowhere else — no server, no escrow, no recovery. Clearing this browser's data
 * loses the key, and sealed casts addressed to it can then be opened nowhere
 * else. The surface says exactly that, because a privacy promise that quietly
 * keeps a copy is worse than no privacy at all.
 *
 * The public half is a shareable string (`fdy-key-1:…`) that anyone can paste in
 * a bio or a cast: it is what other people seal *to*, and sharing it gives away
 * nothing but the ability to send you something only you can read.
 *
 * The key material is stored as a JWK and the handle this module returns is
 * **non-extractable**, so nothing downstream — including a bug in a surface —
 * can read the private key back out of the CryptoKey it was handed.
 *
 * Storage is one small interface, so this module runs outside a browser in tests
 * and so a caller can hand it `memoryKeyValueStore()` when it does not want a key
 * to persist at all.
 */
import { base64UrlToBytes, bytesToHex, CryptoBytes } from './encoding';
import {
  parseKeyShare,
  RECIPIENT_FINGERPRINT_BYTES,
  sealedKeyShare,
} from './envelope';
import { sealedProblem } from './errors';
import { compressPublicKey } from './p256';

export type { CryptoBytes } from './encoding';

const IDENTITY_FORMAT = 1;

/** This browser's own sealing key pair. */
export const identityStorageKey = 'fiddy.sealed.identity.v1';

/** Public keys saved here for reuse, keyed by fingerprint. */
export const keyRegistryStorageKey = 'fiddy.sealed.keys.v1';

export interface SealedKeyValueStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface SealedIdentity {
  /** Non-extractable: the private half cannot be read back out of this handle. */
  privateKey: CryptoKey;
  /** The public half, uncompressed (`04 || X || Y`) — what the fingerprint hashes. */
  publicKeyRaw: CryptoBytes;
  /** The same point as the envelope writes it (33 bytes). */
  publicKeyCompressed: CryptoBytes;
  /** The string to paste so people can seal to you. */
  share: string;
  fingerprint: CryptoBytes;
  fingerprintHex: string;
  createdAt: number;
}

export interface SavedKey {
  share: string;
  fingerprintHex: string;
  /** What the reader called them; their fingerprint when they did not say. */
  label: string;
  addedAt: number;
}

/** WebCrypto is absent on a plain-http page and in very old browsers. */
export const sealedCryptoAvailable = (): boolean =>
  typeof globalThis.crypto?.subtle?.generateKey === 'function' &&
  typeof globalThis.crypto?.getRandomValues === 'function';

export const memoryKeyValueStore = (): SealedKeyValueStore => {
  const entries = new Map<string, string>();

  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

/**
 * This browser's storage when there is one, in-memory otherwise — nothing here
 * throws in a worker or a locked-down browser, and the surface tells the reader
 * when there is nowhere to keep a key rather than pretending there is.
 */
export const browserKeyValueStore = (): SealedKeyValueStore => {
  try {
    const probeKey = 'fiddy.sealed.probe';
    globalThis.localStorage.setItem(probeKey, '1');
    globalThis.localStorage.removeItem(probeKey);

    return {
      getItem: (key) => globalThis.localStorage.getItem(key),
      setItem: (key, value) => {
        globalThis.localStorage.setItem(key, value);
      },
      removeItem: (key) => {
        globalThis.localStorage.removeItem(key);
      },
    };
  } catch {
    return memoryKeyValueStore();
  }
};

/** sha256 of the uncompressed public key, first 4 bytes. */
export const fingerprintOf = async (
  publicKeyRaw: CryptoBytes,
): Promise<CryptoBytes> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', publicKeyRaw);

  return new Uint8Array(digest).slice(0, RECIPIENT_FINGERPRINT_BYTES);
};

export const sameFingerprint = (
  left: Uint8Array,
  right: Uint8Array,
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
};

const publicKeyRawFromJwk = (jwk: JsonWebKey): CryptoBytes => {
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw sealedProblem('the stored key is incomplete');
  }

  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(base64UrlToBytes(jwk.x), 1);
  out.set(base64UrlToBytes(jwk.y), 33);

  if (out.length !== 65) {
    throw sealedProblem('the stored key is the wrong size');
  }

  return out;
};

const identityFromJwk = async (
  jwk: JsonWebKey,
  createdAt: number,
): Promise<SealedIdentity> => {
  const privateKey = await globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );

  const publicKeyRaw = publicKeyRawFromJwk(jwk);
  const fingerprint = await fingerprintOf(publicKeyRaw);

  return {
    privateKey,
    publicKeyRaw,
    publicKeyCompressed: compressPublicKey(publicKeyRaw),
    share: sealedKeyShare(publicKeyRaw),
    fingerprint,
    fingerprintHex: bytesToHex(fingerprint),
    createdAt,
  };
};

/**
 * A fresh key pair. The pair is generated extractable only long enough to be
 * written down as a JWK; what comes back is a non-extractable handle, so the
 * only copy of the private half that can be read at all is the one in storage.
 */
const freshIdentity = async (
  now: () => number,
): Promise<{ identity: SealedIdentity; jwk: JsonWebKey }> => {
  if (!sealedCryptoAvailable()) {
    throw sealedProblem(
      'this browser cannot make a key that only you hold — it has no WebCrypto, which a page on plain http also lacks',
    );
  }

  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );

  const jwk = (await globalThis.crypto.subtle.exportKey(
    'jwk',
    keyPair.privateKey,
  )) as JsonWebKey;

  return { identity: await identityFromJwk(jwk, now()), jwk };
};

/** Make a key pair for this browser without storing it. */
export const createIdentity = async (
  now: () => number = Date.now,
): Promise<SealedIdentity> => (await freshIdentity(now)).identity;

/**
 * The key this browser holds, or null when it holds none. A stored key that no
 * longer imports is reported as null rather than as half a key.
 */
export const loadIdentity = async (
  store: SealedKeyValueStore = browserKeyValueStore(),
): Promise<SealedIdentity | null> => {
  const stored = store.getItem(identityStorageKey);

  if (stored === null || stored === '') {
    return null;
  }

  try {
    const parsed = JSON.parse(stored) as {
      format?: number;
      jwk?: JsonWebKey;
      createdAt?: number;
    };

    if (
      parsed.format !== IDENTITY_FORMAT ||
      parsed.jwk === undefined ||
      typeof parsed.jwk.d !== 'string'
    ) {
      return null;
    }

    return await identityFromJwk(parsed.jwk, parsed.createdAt ?? 0);
  } catch {
    return null;
  }
};

/** This browser's key, made on first use and kept afterwards. */
export const getOrCreateKey = async (
  store: SealedKeyValueStore = browserKeyValueStore(),
  now: () => number = Date.now,
): Promise<SealedIdentity> => {
  const existing = await loadIdentity(store);

  if (existing !== null) {
    return existing;
  }

  const { identity, jwk } = await freshIdentity(now);

  store.setItem(
    identityStorageKey,
    JSON.stringify({
      format: IDENTITY_FORMAT,
      jwk,
      createdAt: identity.createdAt,
    }),
  );

  return identity;
};

/** Forget this browser's key. Sealed casts addressed to it stop opening here. */
export const forgetIdentity = (
  store: SealedKeyValueStore = browserKeyValueStore(),
): void => {
  store.removeItem(identityStorageKey);
};

/**
 * What a shared key is, without saving it: null when it is not a key at all.
 * A renderer uses this to decide whether to offer it.
 */
export const describeKeyShare = async (
  share: string,
): Promise<{ fingerprintHex: string; share: string } | null> => {
  const publicKeyRaw = parseKeyShare(share);

  if (publicKeyRaw === null) {
    return null;
  }

  return {
    fingerprintHex: bytesToHex(await fingerprintOf(publicKeyRaw)),
    share: sealedKeyShare(publicKeyRaw),
  };
};

const readSavedKeys = (store: SealedKeyValueStore): SavedKey[] => {
  const stored = store.getItem(keyRegistryStorageKey);

  if (stored === null || stored === '') {
    return [];
  }

  try {
    const parsed = JSON.parse(stored) as SavedKey[];

    return Array.isArray(parsed)
      ? parsed.filter(
          (entry) =>
            typeof entry?.share === 'string' &&
            typeof entry?.fingerprintHex === 'string',
        )
      : [];
  } catch {
    return [];
  }
};

export const listSavedKeys = (
  store: SealedKeyValueStore = browserKeyValueStore(),
): SavedKey[] => readSavedKeys(store);

const writeSavedKeys = (store: SealedKeyValueStore, keys: SavedKey[]): void => {
  store.setItem(keyRegistryStorageKey, JSON.stringify(keys));
};

/** Keep a public key someone shared, so it can be sealed to later. */
export const saveKey = async (
  share: string,
  store: SealedKeyValueStore = browserKeyValueStore(),
  options: { label?: string; now?: () => number } = {},
): Promise<SavedKey> => {
  const publicKeyRaw = parseKeyShare(share);

  if (publicKeyRaw === null) {
    throw sealedProblem('that is not a key we can seal to');
  }

  const fingerprint = await fingerprintOf(publicKeyRaw);
  const fingerprintHex = bytesToHex(fingerprint);
  const saved: SavedKey = {
    share: sealedKeyShare(publicKeyRaw),
    fingerprintHex,
    label: options.label?.trim() || fingerprintHex,
    addedAt: (options.now ?? Date.now)(),
  };

  writeSavedKeys(store, [
    saved,
    ...readSavedKeys(store).filter(
      (entry) => entry.fingerprintHex !== fingerprintHex,
    ),
  ]);

  return saved;
};

export const forgetSavedKey = (
  fingerprintHex: string,
  store: SealedKeyValueStore = browserKeyValueStore(),
): void => {
  writeSavedKeys(
    store,
    readSavedKeys(store).filter(
      (entry) => entry.fingerprintHex !== fingerprintHex,
    ),
  );
};
