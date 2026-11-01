/**
 * Sealing a cast for specific people, and opening one.
 *
 * The shape of it, in one paragraph: a random 32-byte key encrypts the message
 * (AES-256-GCM, with the envelope's own header as associated data, so a tampered
 * envelope cannot be opened even by the right key). That content key is then
 * wrapped *once per recipient* under a key derived from an ephemeral ECDH
 * agreement with their published public key (P-256 → HKDF-SHA256). The
 * ephemeral private key is thrown away the moment the cast is sealed, so the
 * only way back to the message is a recipient's own private key — which lives in
 * their browser and has never been anywhere else.
 *
 * What this module deliberately does not do: it holds no key material of its own
 * (the caller passes a `SealedIdentity`), it logs nothing, and it contains no
 * way to make a request of any kind — no request API, no address to ask. The only
 * way the plaintext leaves this module is as the return value of
 * `openSealedCast`, to the caller that asked. `scripts/verify-mask-surfaces.mjs`
 * enforces that from the built bytes: it fails if any module on this path so much
 * as mentions a request API or an address.
 *
 * The message travels as the cast text itself (`fdy-seal-1:…`), which is why
 * `sealCast` refuses a message that does not fit a cast — silently truncating a
 * secret would be worse than refusing to send it.
 */
import { concatBytes, CryptoBytes, utf8ToBytes } from './encoding';
import {
  CAST_TEXT_LIMIT_BYTES,
  CONTENT_KEY_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  envelopeRawBytes,
  GCM_IV_BYTES,
  isSealedCastBody,
  LONG_CAST_TEXT_LIMIT_BYTES,
  MAX_RECIPIENTS,
  parseKeyShare,
  plaintextBudgetBytes,
  SEALED_VERSION,
  sealedTextLength,
  V1_RECIPIENTS,
} from './envelope';
import { sealedProblem } from './errors';
import { fingerprintOf, sameFingerprint, SealedIdentity } from './keys';
import { compressPublicKey, decompressPublicKey } from './p256';

/** Everything derived for one unsealing decision carries this label. */
const HKDF_INFO = utf8ToBytes('fiddy-sealed-cast-v1');

const randomBytes = (length: number): CryptoBytes => {
  const out = new Uint8Array(length);

  globalThis.crypto.getRandomValues(out);

  return out;
};

const importPeerKey = (uncompressed: CryptoBytes): Promise<CryptoKey> =>
  globalThis.crypto.subtle.importKey(
    'raw',
    uncompressed,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

const deriveWrappingKey = async (
  privateKey: CryptoKey,
  peerPublicKey: CryptoBytes,
  salt: CryptoBytes,
  usage: 'encrypt' | 'decrypt',
): Promise<CryptoKey> => {
  const sharedSecret = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: await importPeerKey(peerPublicKey),
      },
      privateKey,
      256,
    ),
  );

  const hkdfKey = await globalThis.crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveKey'],
  );

  return globalThis.crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
};

/** The header is authenticated: a tampered envelope does not decrypt. */
const contentAssociatedData = (ephemeralPublicKey: CryptoBytes): CryptoBytes =>
  concatBytes(new Uint8Array([SEALED_VERSION]), ephemeralPublicKey);

/** A wrapped key is bound to the envelope it was wrapped for. */
const wrappedAssociatedData = (
  ephemeralPublicKey: CryptoBytes,
  contentIv: CryptoBytes,
): CryptoBytes => concatBytes(ephemeralPublicKey, contentIv);

export interface SealCastInput {
  plaintext: string;
  /** `fdy-key-1:…` strings — one per person the cast is for. */
  recipientShares: string[];
  /** Defaults to the ordinary cast limit; pass the long-cast limit for those. */
  limitBytes?: number;
  /** v1's surface seals for one person; the envelope carries up to 8. */
  recipientLimit?: number;
}

export interface SealedCast {
  /** The cast text exactly as it should be posted. */
  text: string;
  recipients: number;
  envelopeBytes: number;
  textBytes: number;
  plaintextBytes: number;
  /** Room left in the cast if this is sealed for one more character. */
  remainingBytes: number;
}

export const sealBudgetBytes = (
  recipientCount: number = V1_RECIPIENTS,
  limitBytes: number = CAST_TEXT_LIMIT_BYTES,
): number => plaintextBudgetBytes(recipientCount, limitBytes);

export const sealCast = async ({
  plaintext,
  recipientShares,
  limitBytes = CAST_TEXT_LIMIT_BYTES,
  recipientLimit = V1_RECIPIENTS,
}: SealCastInput): Promise<SealedCast> => {
  if (plaintext.trim() === '') {
    throw sealedProblem('there is nothing to seal yet');
  }

  if (recipientShares.length === 0) {
    throw sealedProblem('a sealed cast needs one person to seal it for');
  }

  if (recipientShares.length > recipientLimit) {
    throw sealedProblem(
      recipientLimit === 1
        ? 'this seals a cast for one person at a time'
        : `a sealed cast names up to ${MAX_RECIPIENTS} people`,
    );
  }

  const recipientKeys = recipientShares.map((share) => {
    const parsed = parseKeyShare(share);

    if (parsed === null) {
      throw sealedProblem('one of those keys is not a key we can seal to');
    }

    return parsed;
  });

  const plaintextBytes = utf8ToBytes(plaintext);
  const budget = plaintextBudgetBytes(recipientKeys.length, limitBytes);

  if (plaintextBytes.length > budget) {
    throw sealedProblem(
      `this message needs ${plaintextBytes.length} bytes and a sealed cast of this size holds ${budget}`,
    );
  }

  const ephemeral = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );

  const ephemeralPublicKey = compressPublicKey(
    new Uint8Array(
      await globalThis.crypto.subtle.exportKey('raw', ephemeral.publicKey),
    ),
  );

  const contentIv = randomBytes(GCM_IV_BYTES);
  const contentKey = randomBytes(CONTENT_KEY_BYTES);

  const contentKeyHandle = await globalThis.crypto.subtle.importKey(
    'raw',
    contentKey,
    'AES-GCM',
    false,
    ['encrypt'],
  );

  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: contentIv,
        additionalData: contentAssociatedData(ephemeralPublicKey),
      },
      contentKeyHandle,
      plaintextBytes,
    ),
  );

  const recipients = [];

  for (const recipientKey of recipientKeys) {
    const iv = randomBytes(GCM_IV_BYTES);
    const wrappingKey = await deriveWrappingKey(
      ephemeral.privateKey,
      recipientKey,
      contentIv,
      'encrypt',
    );

    recipients.push({
      fingerprint: await fingerprintOf(recipientKey),
      iv,
      wrappedKey: new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv,
            additionalData: wrappedAssociatedData(
              ephemeralPublicKey,
              contentIv,
            ),
          },
          wrappingKey,
          contentKey,
        ),
      ),
    });
  }

  const text = encodeEnvelope({
    version: SEALED_VERSION,
    ephemeralPublicKey,
    recipients,
    contentIv,
    ciphertext,
  });

  return {
    text,
    recipients: recipients.length,
    envelopeBytes: envelopeRawBytes(recipients.length, plaintextBytes.length),
    textBytes: utf8ToBytes(text).length,
    plaintextBytes: plaintextBytes.length,
    remainingBytes: Math.max(0, budget - plaintextBytes.length),
  };
};

export interface OpenedSealedCast {
  status: 'opened';
  plaintext: string;
  recipients: number;
}

export interface UnopenedSealedCast {
  status: 'not-addressed' | 'failed';
  /** Plain words for a reader — shown as-is. */
  reason: string;
  recipients: number;
}

export type OpenSealedCastResult = OpenedSealedCast | UnopenedSealedCast;

/**
 * Open a sealed cast with the key this browser holds. Never throws: a cast that
 * is not for this key, a cast that has been altered, and a cast from a newer
 * writer all come back as a status with a sentence a reader can act on.
 */
export const openSealedCast = async ({
  text,
  identity,
}: {
  text: string;
  identity: SealedIdentity;
}): Promise<OpenSealedCastResult> => {
  let envelope;

  try {
    envelope = decodeEnvelope(text);
  } catch (error) {
    return {
      status: 'failed',
      reason:
        error instanceof Error
          ? error.message
          : 'this sealed cast could not be read',
      recipients: 0,
    };
  }

  const mine = envelope.recipients.find((recipient) =>
    sameFingerprint(recipient.fingerprint, identity.fingerprint),
  );

  /*
   * No block for this key: say so *before* touching the crypto, so a reader
   * learns nothing about a cast that was never addressed to them.
   */
  if (mine === undefined) {
    return {
      status: 'not-addressed',
      reason: `this cast was sealed for ${envelope.recipients.length === 1 ? 'someone else' : 'other keys'}, not for the key this browser holds`,
      recipients: envelope.recipients.length,
    };
  }

  try {
    const ephemeralPublicKey = decompressPublicKey(envelope.ephemeralPublicKey);

    const contentKey = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: mine.iv,
          additionalData: wrappedAssociatedData(
            envelope.ephemeralPublicKey,
            envelope.contentIv,
          ),
        },
        await deriveWrappingKey(
          identity.privateKey,
          ephemeralPublicKey,
          envelope.contentIv,
          'decrypt',
        ),
        mine.wrappedKey,
      ),
    );

    const contentKeyHandle = await globalThis.crypto.subtle.importKey(
      'raw',
      contentKey,
      'AES-GCM',
      false,
      ['decrypt'],
    );

    const plaintext = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: envelope.contentIv,
          additionalData: contentAssociatedData(envelope.ephemeralPublicKey),
        },
        contentKeyHandle,
        envelope.ciphertext,
      ),
    );

    return {
      status: 'opened',
      plaintext: new TextDecoder().decode(plaintext),
      recipients: envelope.recipients.length,
    };
  } catch {
    return {
      status: 'failed',
      reason:
        'this cast is addressed to a key like this one but does not open — it was altered, or it was sealed to a different key with the same fingerprint',
      recipients: envelope.recipients.length,
    };
  }
};

/**
 * How many people a sealed cast names, without any key at all. A renderer uses
 * this to describe a cast it cannot open.
 */
export const sealedCastRecipients = (text: string): number | null => {
  if (!isSealedCastBody(text)) {
    return null;
  }

  try {
    return decodeEnvelope(text).recipients.length;
  } catch {
    return null;
  }
};

export { CAST_TEXT_LIMIT_BYTES, LONG_CAST_TEXT_LIMIT_BYTES, sealedTextLength };
