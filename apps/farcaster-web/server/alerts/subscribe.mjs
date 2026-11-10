/**
 * Who is allowed to say "send pushes for FID 123", proved without custody.
 *
 * NO KEY EVER REACHES THIS SERVER. The browser already holds an app key for the
 * reader's FID (`src/snapchain/appKeyStorage.ts` — an on-chain signer, added by
 * the reader, kept in their own browser). To subscribe, the browser signs a
 * short claim with that key; this module checks the signature and asks the NODE
 * whether the key really belongs to that FID (`GET /v1/signer?fid=&signer=`, the
 * same read `clientAttribution.ts` already uses). Nothing is stored but the
 * phone's push address and its two keys.
 *
 * THE CLAIM IS BOUND TO THE ENDPOINT, and it expires. If it were not, an
 * observer of one request could re-point a reader's notifications at their own
 * push address and read everything the reader is sent. So:
 *
 *     fiddy-alerts-v1
 *     <fid>
 *     <sha256(endpoint) hex>
 *     <issuedAt ms>
 *
 * signed by the app key. A replay is only useful for ten minutes and only for
 * the exact endpoint it was minted for; a claim with a different endpoint hash
 * is refused even if the signature is perfect.
 *
 * WHAT IS REFUSED, and why each one is refused rather than trusted:
 *
 *   * a signature that does not verify                  → forged
 *   * a signer the node does not list for that FID      → not the reader's key
 *   * a signer record for a DIFFERENT fid               → a key that is real,
 *                                                        just somebody else's
 *   * an `issuedAt` older than the window, or in the
 *     future beyond a little clock skew                 → a replay
 *   * a key type this host cannot check                 → silence is not consent
 */

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

/** The claim's first line: a new version is a new string, so old claims die. */
export const CLAIM_VERSION = 'fiddy-alerts-v1';

/** How long a claim may sit before it is refused. */
export const CLAIM_MAX_AGE_MS = 10 * 60 * 1000;

/** How much clock skew ahead of us is tolerated. */
export const CLAIM_FUTURE_MS = 2 * 60 * 1000;

/** How long a node's "yes, that key is theirs" is trusted. */
export const SIGNER_TTL_MS = 10 * 60 * 1000;

/** Ed25519 and secp256k1 as the protocol numbers them. */
export const KEY_TYPE_ED25519 = 1;
export const KEY_TYPE_SECP256K1 = 2;

/** DER prefixes that turn a raw protocol key into an SPKI a verifier accepts. */
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const SPKI_SECP256K1 = Buffer.from(
  '3036301006072a8648ce3d020106052b8104000a032200',
  'hex',
);

const asObject = (value) => (value && typeof value === 'object' ? value : {});

export const endpointHash = (endpoint) =>
  createHash('sha256').update(String(endpoint)).digest('hex');

/**
 * The exact bytes an app key signs. Written once, used by both sides: the
 * browser's copy lives in `src/snapchain/alerts/phoneAlerts.ts`, and a test
 * holds the two to the same string.
 */
export const canonicalClaim = ({ fid, endpoint, issuedAt }) =>
  [CLAIM_VERSION, fid, endpointHash(endpoint), issuedAt].join('\n');

const fromB64url = (value) => Buffer.from(String(value), 'base64url');

/** A key as the protocol writes it: `0x` and 32 bytes (Ed25519) or 33 (secp256k1). */
const isSignerKey = (value) => /^0x[0-9a-f]{64,66}$/i.test(String(value ?? ''));

/** The public key object for one protocol key, or undefined if unusable. */
const publicKeyFor = ({ signer, keyType }) => {
  const raw = Buffer.from(String(signer).replace(/^0x/i, ''), 'hex');
  try {
    if (keyType === KEY_TYPE_ED25519) {
      if (raw.length !== 32) {
        return undefined;
      }
      return createPublicKey({
        key: Buffer.concat([SPKI_ED25519, raw]),
        format: 'der',
        type: 'spki',
      });
    }
    if (keyType === KEY_TYPE_SECP256K1) {
      if (raw.length !== 33 && raw.length !== 65) {
        return undefined;
      }
      // An uncompressed point is not what the SPKI prefix above declares; a
      // 65-byte key is compressed to the 33-byte form the prefix expects.
      const point =
        raw.length === 33 ? raw : Buffer.concat([Buffer.from([0x04]), raw.subarray(1)]);
      const compressed = raw.length === 33 ? point : compressPoint(point);
      return createPublicKey({
        key: Buffer.concat([SPKI_SECP256K1, compressed]),
        format: 'der',
        type: 'spki',
      });
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * A 0x04… point as 0x02/0x03 (y parity) and its 32-byte x. Only used if a node
 * ever answers an uncompressed key; the prefix above expects compressed.
 */
const compressPoint = (point) => {
  const x = point.subarray(1, 33);
  const y = point.subarray(33, 65);
  const prefix = (y[y.length - 1] & 0x01) === 1 ? 0x03 : 0x02;
  return Buffer.concat([Buffer.from([prefix]), x]);
};

/**
 * Does `signature` prove `message` was signed by `signer`?
 *
 * `signer` is the app key's own public key — the 32-byte Ed25519 key or the
 * 33-byte compressed secp256k1 point, hex with `0x` — because that is what the
 * node's signer record carries as `key` (`packages/farcaster-node-client/src/appKey.ts`
 * `publicKeyHex`). The protocol also writes 20-byte addresses in other places;
 * those are NOT accepted here, because an address cannot be verified against.
 *
 * The protocol writes signatures as base64 or hex depending on the path; both
 * are accepted, because the browser sends what `appKey` wrote.
 */
export const checkSignature = ({
  signer,
  keyType,
  signature,
  message,
}) => {
  const key = publicKeyFor({ signer, keyType });
  if (!key) {
    return false;
  }
  const text = String(signature ?? '').trim();
  /** @type {Buffer} */
  let bytes;
  try {
    bytes =
      /^0x[0-9a-f]+$/i.test(text) || (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0)
        ? Buffer.from(text.replace(/^0x/i, ''), 'hex')
        : fromB64url(text);
  } catch {
    return false;
  }
  if (keyType === KEY_TYPE_ED25519) {
    if (bytes.length !== 64) {
      return false;
    }
    try {
      return verifySignature(null, Buffer.from(message, 'utf8'), key, bytes);
    } catch {
      return false;
    }
  }
  // A secp256k1 protocol signature is `r || s` and sometimes carries a recovery
  // byte (65). Verification needs r||s in the P1363 encoding.
  const rs = bytes.length === 65 ? bytes.subarray(0, 64) : bytes;
  if (rs.length !== 64) {
    return false;
  }
  try {
    return verifySignature(
      'sha256',
      Buffer.from(message, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      rs,
    );
  } catch {
    return false;
  }
};

/**
 * The gate a subscribe request passes.
 *
 * `nodeGet` is the same bounded node read the rest of this host uses. A node
 * that cannot answer is a REFUSAL (`node-cannot-answer`), not a pass: this is
 * the one place where "we could not check" must not become "yes".
 */
export const createSubscribeGuard = ({
  nodeGet,
  now = () => Date.now(),
  signerTtlMs = SIGNER_TTL_MS,
}) => {
  const seen = new Map();

  const signerFor = async (fid, signer) => {
    const key = `${fid}:${signer.toLowerCase()}`;
    const hit = seen.get(key);
    if (hit && now() - hit.at < signerTtlMs) {
      return hit.record;
    }
    const page = await nodeGet('/v1/signer', { fid, signer });
    const record = asObject(asObject(page).signer);
    const usable = Object.keys(record).length > 0 ? record : undefined;
    if (seen.size >= 2000) {
      seen.delete(seen.keys().next().value);
    }
    seen.set(key, { at: now(), record: usable });
    return usable;
  };

  return {
    /**
     * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
     *   `reason` is a stable token, not a sentence: the route turns it into the
     *   one sentence the browser shows, and the tests assert the token.
     */
    async check({ fid, signer, signature, endpoint, issuedAt }) {
      if (!Number.isSafeInteger(fid) || fid <= 0) {
        return { ok: false, reason: 'not-a-fid' };
      }
      if (!isSignerKey(signer)) {
        return { ok: false, reason: 'not-a-key' };
      }
      if (!Number.isFinite(issuedAt)) {
        return { ok: false, reason: 'no-when' };
      }
      const age = now() - issuedAt;
      if (age > CLAIM_MAX_AGE_MS) {
        return { ok: false, reason: 'stale' };
      }
      if (age < -CLAIM_FUTURE_MS) {
        return { ok: false, reason: 'from-the-future' };
      }
      if (typeof endpoint !== 'string' || endpoint.length === 0) {
        return { ok: false, reason: 'no-phone' };
      }

      let record;
      try {
        record = await signerFor(fid, signer);
      } catch {
        return { ok: false, reason: 'node-cannot-answer' };
      }
      if (!record) {
        return { ok: false, reason: 'key-not-on-this-fid' };
      }
      if (Number(record.fid) !== fid) {
        return { ok: false, reason: 'key-not-on-this-fid' };
      }
      if (
        record.key !== undefined &&
        String(record.key).toLowerCase() !== String(signer).toLowerCase()
      ) {
        return { ok: false, reason: 'key-not-on-this-fid' };
      }

      const keyType = Number(record.keyType);
      const message = canonicalClaim({ fid, endpoint, issuedAt });
      if (!checkSignature({ signer, keyType, signature, message })) {
        return { ok: false, reason: 'not-your-signature' };
      }
      return { ok: true };
    },

    /** Test seam: what the guard has cached. */
    _cache: seen,
  };
};