/**
 * The sealed-cast envelope: one frozen byte layout, its size arithmetic against
 * the protocol's cast limits, and the two string shapes that travel in casts.
 *
 *     version(1) | ephemeral public key, compressed(33) | recipient count(1)
 *     | per recipient: fingerprint(4) + iv(12) + wrapped key(48)
 *     | content iv(12) | ciphertext + tag(16)
 *
 * Pure — no WebCrypto, no `fetch`, no browser globals. The renderer only ever
 * needs this much: whether a body *is* sealed text, and how much room a message
 * has. Everything that touches key material lives in `keys.ts` and
 * `sealedCast.ts`, which are imported on demand.
 *
 * Two string shapes travel in casts:
 *
 *     fdy-seal-1:<base64url of the envelope>   a sealed cast
 *     fdy-key-1:<base64url of a public key>    a key you can seal *to*
 *
 * Both are deliberately boring: no dots, no `@`, no `/`. A client that has never
 * heard of this format renders them as text and nothing else in it becomes a
 * mention or a link by accident.
 */
import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  CryptoBytes,
} from './encoding';
import { sealedProblem } from './errors';
import {
  isSealedCastBody,
  keyShareCandidates,
  SEALED_CAST_PREFIX,
  SEALED_KEY_PREFIX,
} from './markers';
import {
  COMPRESSED_POINT_BYTES,
  isPointOnCurve,
  UNCOMPRESSED_POINT_BYTES,
} from './p256';

/* The two string shapes live in `markers.ts`, which the cast renderer imports
   statically; this module re-exports them so there is one definition of each. */
export { isSealedCastBody, SEALED_CAST_PREFIX, SEALED_KEY_PREFIX };

/** Farcaster: cast text of 0–320 bytes is a CAST, 321–1024 a LONG_CAST. */
export const CAST_TEXT_LIMIT_BYTES = 320;
export const LONG_CAST_TEXT_LIMIT_BYTES = 1024;

export const SEALED_VERSION = 1;

export const RECIPIENT_FINGERPRINT_BYTES = 4;
export const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
export const CONTENT_KEY_BYTES = 32;
export const WRAPPED_KEY_BYTES = CONTENT_KEY_BYTES + GCM_TAG_BYTES;

/** The codec carries a list; the v1 surface seals for one person at a time. */
export const MAX_RECIPIENTS = 8;
export const V1_RECIPIENTS = 1;

export const HEADER_BYTES =
  1 +
  COMPRESSED_POINT_BYTES +
  1; /* version | ephemeral key | recipient count */

export const RECIPIENT_BLOCK_BYTES =
  RECIPIENT_FINGERPRINT_BYTES + GCM_IV_BYTES + WRAPPED_KEY_BYTES;

/** Bytes of base64url a raw byte count costs (unpadded, rounded up). */
export const base64UrlLength = (rawBytes: number): number =>
  Math.ceil((rawBytes * 4) / 3);

export interface EnvelopeRecipient {
  /** First 4 bytes of sha256(public key) — enough to say "this one is mine". */
  fingerprint: CryptoBytes;
  /** The iv the content key was wrapped with, for this recipient. */
  iv: CryptoBytes;
  /** AES-256-GCM(content key) under the key this recipient derives. */
  wrappedKey: CryptoBytes;
}

export interface SealedEnvelope {
  version: number;
  /** The sender's one-time public key, compressed (0x02|0x03 || X). */
  ephemeralPublicKey: CryptoBytes;
  recipients: EnvelopeRecipient[];
  /** The iv the message itself was encrypted with. */
  contentIv: CryptoBytes;
  /** The sealed message: ciphertext followed by the GCM tag. */
  ciphertext: CryptoBytes;
}

/** Raw envelope bytes for a message of `plaintextBytes`, before base64url. */
export const envelopeRawBytes = (
  recipientCount: number,
  plaintextBytes: number,
): number =>
  HEADER_BYTES +
  recipientCount * RECIPIENT_BLOCK_BYTES +
  GCM_IV_BYTES +
  plaintextBytes +
  GCM_TAG_BYTES;

/** The characters a sealed cast costs in a cast body, all in. */
export const sealedTextLength = (
  recipientCount: number,
  plaintextBytes: number,
): number =>
  SEALED_CAST_PREFIX.length +
  base64UrlLength(envelopeRawBytes(recipientCount, plaintextBytes));

/**
 * The largest message (in bytes) that still fits the budget — solved, not
 * estimated, because the UI promises a number. `sealedTextLength` is monotonic
 * in `plaintextBytes`, so a binary search is exact.
 */
export const plaintextBudgetBytes = (
  recipientCount: number,
  limitBytes: number = CAST_TEXT_LIMIT_BYTES,
): number => {
  if (recipientCount < 1 || recipientCount > MAX_RECIPIENTS) {
    return 0;
  }

  let low = 0;
  let high = Math.max(0, limitBytes);

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (sealedTextLength(recipientCount, middle) <= limitBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
};

export const encodeEnvelope = (envelope: SealedEnvelope): string => {
  if (envelope.version !== SEALED_VERSION) {
    throw sealedProblem(
      'that sealed text was written by a version we do not read',
    );
  }

  if (
    envelope.recipients.length < 1 ||
    envelope.recipients.length > MAX_RECIPIENTS
  ) {
    throw sealedProblem('a sealed cast names between 1 and 8 people');
  }

  if (envelope.ephemeralPublicKey.length !== COMPRESSED_POINT_BYTES) {
    throw sealedProblem('the sealed envelope is missing its one-time key');
  }

  const blocks = envelope.recipients.flatMap((recipient) => {
    if (
      recipient.fingerprint.length !== RECIPIENT_FINGERPRINT_BYTES ||
      recipient.iv.length !== GCM_IV_BYTES ||
      recipient.wrappedKey.length !== WRAPPED_KEY_BYTES
    ) {
      throw sealedProblem(
        'the sealed envelope has a recipient block of the wrong size',
      );
    }

    return [recipient.fingerprint, recipient.iv, recipient.wrappedKey];
  });

  return (
    SEALED_CAST_PREFIX +
    bytesToBase64Url(
      concatBytes(
        new Uint8Array([SEALED_VERSION]),
        envelope.ephemeralPublicKey,
        new Uint8Array([envelope.recipients.length]),
        ...blocks,
        envelope.contentIv,
        envelope.ciphertext,
      ),
    )
  );
};

export const decodeEnvelope = (text: string): SealedEnvelope => {
  const trimmed = text.trim();

  if (!trimmed.startsWith(SEALED_CAST_PREFIX)) {
    throw sealedProblem('this text is not a sealed cast');
  }

  const raw = base64UrlToBytes(trimmed.slice(SEALED_CAST_PREFIX.length));

  if (raw.length < HEADER_BYTES + GCM_IV_BYTES + GCM_TAG_BYTES) {
    throw sealedProblem('this sealed cast is shorter than its own header');
  }

  const version = raw[0] ?? 0;

  if (version !== SEALED_VERSION) {
    throw sealedProblem(
      `this sealed cast was written by version ${version}, and this client reads version ${SEALED_VERSION}`,
    );
  }

  const ephemeralPublicKey = raw.slice(1, 1 + COMPRESSED_POINT_BYTES);
  const marker = ephemeralPublicKey[0] ?? 0;

  if (marker !== 0x02 && marker !== 0x03) {
    throw sealedProblem('this sealed cast has no usable one-time key');
  }

  const recipientCount = raw[1 + COMPRESSED_POINT_BYTES] ?? 0;

  if (recipientCount < 1 || recipientCount > MAX_RECIPIENTS) {
    throw sealedProblem(
      'this sealed cast names a number of people we cannot read',
    );
  }

  const expected =
    HEADER_BYTES +
    recipientCount * RECIPIENT_BLOCK_BYTES +
    GCM_IV_BYTES +
    GCM_TAG_BYTES;

  if (raw.length < expected) {
    throw sealedProblem('this sealed cast is cut short');
  }

  const recipients: EnvelopeRecipient[] = [];
  let offset = HEADER_BYTES;

  for (let index = 0; index < recipientCount; index += 1) {
    recipients.push({
      fingerprint: raw.slice(offset, offset + RECIPIENT_FINGERPRINT_BYTES),
      iv: raw.slice(
        offset + RECIPIENT_FINGERPRINT_BYTES,
        offset + RECIPIENT_FINGERPRINT_BYTES + GCM_IV_BYTES,
      ),
      wrappedKey: raw.slice(
        offset + RECIPIENT_FINGERPRINT_BYTES + GCM_IV_BYTES,
        offset + RECIPIENT_BLOCK_BYTES,
      ),
    });
    offset += RECIPIENT_BLOCK_BYTES;
  }

  const contentIv = raw.slice(offset, offset + GCM_IV_BYTES);
  const ciphertext = raw.slice(offset + GCM_IV_BYTES);

  if (ciphertext.length < GCM_TAG_BYTES) {
    throw sealedProblem('this sealed cast carries no message');
  }

  return { version, ephemeralPublicKey, recipients, contentIv, ciphertext };
};

/** A public key you can seal to, as text: 87 base64url characters. */
export const sealedKeyShare = (publicKeyUncompressed: Uint8Array): string => {
  if (
    publicKeyUncompressed.length !== UNCOMPRESSED_POINT_BYTES ||
    publicKeyUncompressed[0] !== 0x04
  ) {
    throw sealedProblem('that key is not 65 bytes of uncompressed point');
  }

  return SEALED_KEY_PREFIX + bytesToBase64Url(publicKeyUncompressed);
};

/**
 * Read a key-share string back into raw point bytes, checking that it really is
 * a point on the curve. Returns null (never throws) so a renderer can ask "is
 * this a key?" about any text at all.
 */
export const parseKeyShare = (text: string): CryptoBytes | null => {
  const trimmed = text.trim();

  if (!trimmed.startsWith(SEALED_KEY_PREFIX)) {
    return null;
  }

  let raw: CryptoBytes;

  try {
    raw = base64UrlToBytes(trimmed.slice(SEALED_KEY_PREFIX.length));
  } catch {
    return null;
  }

  if (raw.length !== UNCOMPRESSED_POINT_BYTES || raw[0] !== 0x04) {
    return null;
  }

  const xBytes = raw.slice(1, 33);
  const yBytes = raw.slice(33);

  let x = 0n;
  let y = 0n;

  for (const byte of xBytes) {
    x = (x << 8n) | BigInt(byte);
  }

  for (const byte of yBytes) {
    y = (y << 8n) | BigInt(byte);
  }

  return isPointOnCurve(x, y) ? raw : null;
};

/** Every valid key-share string in a body, deduplicated, in the order found. */
export const findKeyShares = (text: string): string[] => {
  const candidates = keyShareCandidates(text);
  const found: string[] = [];

  for (const candidate of candidates) {
    if (parseKeyShare(candidate) !== null && !found.includes(candidate)) {
      found.push(candidate);
    }
  }

  return found;
};
