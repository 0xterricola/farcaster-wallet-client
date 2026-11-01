import { describe, expect, it } from 'vitest';

import { bytesToBase64Url } from '~/lib/sealed/encoding';
import {
  CAST_TEXT_LIMIT_BYTES,
  CONTENT_KEY_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  envelopeRawBytes,
  findKeyShares,
  GCM_IV_BYTES,
  GCM_TAG_BYTES,
  HEADER_BYTES,
  isSealedCastBody,
  LONG_CAST_TEXT_LIMIT_BYTES,
  MAX_RECIPIENTS,
  parseKeyShare,
  plaintextBudgetBytes,
  RECIPIENT_BLOCK_BYTES,
  RECIPIENT_FINGERPRINT_BYTES,
  SEALED_CAST_PREFIX,
  SEALED_KEY_PREFIX,
  sealedKeyShare,
  sealedTextLength,
} from '~/lib/sealed/envelope';
import { createIdentity, fingerprintOf } from '~/lib/sealed/keys';

const randomBytes = (length: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    out[index] = Math.floor(Math.random() * 256);
  }

  return out;
};

const rawEnvelopeBytes = ({
  version = 1,
  recipientCount = 1,
  ciphertextLength = 32,
}: {
  version?: number;
  recipientCount?: number;
  ciphertextLength?: number;
}): Uint8Array => {
  const ephemeralPublicKey = randomBytes(33);

  /* A real one-time key always starts with the parity marker. */
  ephemeralPublicKey[0] = 0x02;

  const parts: Uint8Array[] = [
    new Uint8Array([version]),
    ephemeralPublicKey,
    new Uint8Array([recipientCount]),
  ];

  for (let index = 0; index < recipientCount; index += 1) {
    parts.push(randomBytes(RECIPIENT_BLOCK_BYTES));
  }

  parts.push(randomBytes(GCM_IV_BYTES));
  parts.push(randomBytes(ciphertextLength));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

const textFromRaw = (raw: Uint8Array): string =>
  SEALED_CAST_PREFIX + bytesToBase64Url(raw);

describe('the budget a sealed cast has in a cast', () => {
  it('is exact: the budget fits, and one byte more does not', () => {
    for (const limit of [CAST_TEXT_LIMIT_BYTES, LONG_CAST_TEXT_LIMIT_BYTES]) {
      for (const recipients of [1, 2, 3, MAX_RECIPIENTS]) {
        const budget = plaintextBudgetBytes(recipients, limit);

        if (budget === 0) {
          /* It does not fit at all, and the first byte already does not. */
          expect(sealedTextLength(recipients, 0)).toBeGreaterThan(limit);
          continue;
        }

        expect(sealedTextLength(recipients, budget)).toBeLessThanOrEqual(limit);
        expect(sealedTextLength(recipients, budget + 1)).toBeGreaterThan(limit);
      }
    }
  });

  it('says what an ordinary cast and a long cast each hold, in bytes', () => {
    /* The numbers the surface promises, pinned so the copy cannot drift. */
    expect(plaintextBudgetBytes(1, CAST_TEXT_LIMIT_BYTES)).toBe(104);
    expect(plaintextBudgetBytes(1, LONG_CAST_TEXT_LIMIT_BYTES)).toBe(632);
  });

  it('accounts for the base64 rounding rather than estimating it', () => {
    expect(envelopeRawBytes(1, 104)).toBe(231);
    expect(sealedTextLength(1, 104)).toBe(319);
    expect(sealedTextLength(1, 105)).toBeGreaterThan(CAST_TEXT_LIMIT_BYTES);
  });

  it('names the honest cost of naming more people: at 320 bytes only one fits', () => {
    /* The measured reason the surface seals for one person at a time. */
    expect(plaintextBudgetBytes(2, CAST_TEXT_LIMIT_BYTES)).toBe(40);
    expect(plaintextBudgetBytes(3, CAST_TEXT_LIMIT_BYTES)).toBe(0);
    expect(plaintextBudgetBytes(3, LONG_CAST_TEXT_LIMIT_BYTES)).toBe(504);
    expect(
      plaintextBudgetBytes(MAX_RECIPIENTS, LONG_CAST_TEXT_LIMIT_BYTES),
    ).toBe(184);
  });

  it('never promises room for more people than the codec carries', () => {
    expect(plaintextBudgetBytes(MAX_RECIPIENTS + 1, 1024)).toBe(0);
    expect(plaintextBudgetBytes(0, 1024)).toBe(0);
  });
});

describe('the envelope', () => {
  it('round-trips every field it wrote', () => {
    const ephemeralPublicKey = randomBytes(33);

    ephemeralPublicKey[0] = 0x03;

    const envelope = {
      version: 1,
      ephemeralPublicKey,
      recipients: [
        {
          fingerprint: randomBytes(RECIPIENT_FINGERPRINT_BYTES),
          iv: randomBytes(GCM_IV_BYTES),
          wrappedKey: randomBytes(CONTENT_KEY_BYTES + GCM_TAG_BYTES),
        },
        {
          fingerprint: randomBytes(RECIPIENT_FINGERPRINT_BYTES),
          iv: randomBytes(GCM_IV_BYTES),
          wrappedKey: randomBytes(CONTENT_KEY_BYTES + GCM_TAG_BYTES),
        },
      ],
      contentIv: randomBytes(GCM_IV_BYTES),
      ciphertext: randomBytes(64),
    };

    const decoded = decodeEnvelope(encodeEnvelope(envelope));

    expect(decoded.version).toBe(1);
    expect(Array.from(decoded.ephemeralPublicKey)).toEqual(
      Array.from(envelope.ephemeralPublicKey),
    );
    expect(decoded.recipients.length).toBe(2);
    expect(Array.from(decoded.recipients[1]!.wrappedKey)).toEqual(
      Array.from(envelope.recipients[1]!.wrappedKey),
    );
    expect(Array.from(decoded.contentIv)).toEqual(
      Array.from(envelope.contentIv),
    );
    expect(Array.from(decoded.ciphertext)).toEqual(
      Array.from(envelope.ciphertext),
    );
  });

  it('accepts a body with the prefix, and nothing else as a sealed body', () => {
    const text = textFromRaw(rawEnvelopeBytes({}));

    expect(isSealedCastBody(text)).toBe(true);
    expect(isSealedCastBody(`  ${text}`)).toBe(true);
    expect(isSealedCastBody('fdy-seal-2:' + text.slice(11))).toBe(false);
    expect(isSealedCastBody('just a cast about sealing casts')).toBe(false);
  });

  it('refuses text that is not sealed text, in words a reader can use', () => {
    expect(() => decodeEnvelope('hello')).toThrow(/not a sealed cast/);
    expect(() => decodeEnvelope('fdy-seal-1:ab!d')).toThrow(/sealed text/);
  });

  it('refuses a version it does not read', () => {
    expect(() =>
      decodeEnvelope(textFromRaw(rawEnvelopeBytes({ version: 2 }))),
    ).toThrow(/version 2/);
  });

  it('refuses an envelope whose one-time key has no parity marker', () => {
    const raw = rawEnvelopeBytes({});
    raw[1] = 0x07;

    expect(() => decodeEnvelope(textFromRaw(raw))).toThrow(
      /no usable one-time key/,
    );
  });

  it('refuses a recipient count of zero, or more than it carries', () => {
    expect(() =>
      decodeEnvelope(textFromRaw(rawEnvelopeBytes({ recipientCount: 0 }))),
    ).toThrow(/number of people/);
    expect(() =>
      decodeEnvelope(textFromRaw(rawEnvelopeBytes({ recipientCount: 9 }))),
    ).toThrow(/number of people/);
  });

  it('refuses a cut-short envelope rather than reading whatever is left', () => {
    const raw = rawEnvelopeBytes({ ciphertextLength: 0 });

    expect(() => decodeEnvelope(textFromRaw(raw))).toThrow(
      /cut short|no message/,
    );
    expect(() =>
      decodeEnvelope(textFromRaw(raw.slice(0, HEADER_BYTES + 10))),
    ).toThrow(/short/);
  });

  it('checks the envelope is exactly one envelope long', () => {
    const raw = rawEnvelopeBytes({ ciphertextLength: 8 });

    /* A name that reads its own length: the reader must not trust a length it
       did not measure. 8 bytes of "ciphertext" is under the tag, so it is cut
       short; two recipients' worth of blocks with a one-recipient header is
       simply not our layout. */
    expect(() => decodeEnvelope(textFromRaw(raw))).toThrow(
      /no message|cut short/,
    );
  });
});

describe('key shares', () => {
  it('round-trips a real public key through the shareable string', async () => {
    const identity = await createIdentity();
    const share = sealedKeyShare(identity.publicKeyRaw);

    expect(share.startsWith(SEALED_KEY_PREFIX)).toBe(true);
    expect(share.length).toBe(SEALED_KEY_PREFIX.length + 87);

    const parsed = parseKeyShare(share);

    expect(parsed).not.toBeNull();
    expect(Array.from(parsed!)).toEqual(Array.from(identity.publicKeyRaw));
  });

  it('answers null — never throws — for text that is not a key', () => {
    expect(parseKeyShare('not a key')).toBeNull();
    expect(parseKeyShare(SEALED_KEY_PREFIX)).toBeNull();
    expect(parseKeyShare(`${SEALED_KEY_PREFIX}ab!d`)).toBeNull();
    expect(parseKeyShare(SEALED_KEY_PREFIX + 'A'.repeat(87))).toBeNull();
  });

  it('finds key shares inside a cast that also says something', async () => {
    const identity = await createIdentity();
    const share = sealedKeyShare(identity.publicKeyRaw);

    const body = `here is my key, seal things to me: ${share} — thanks!`;

    expect(findKeyShares(body)).toEqual([share]);
    expect(findKeyShares(`${share} and again ${share}`)).toEqual([share]);
    expect(findKeyShares('no key here')).toEqual([]);
    expect(findKeyShares(`${SEALED_KEY_PREFIX}${'A'.repeat(87)}`)).toEqual([]);
  });

  it('gives every key its own fingerprint', async () => {
    const first = await createIdentity();
    const second = await createIdentity();

    expect(first.fingerprintHex).not.toBe(second.fingerprintHex);
    expect(Array.from(await fingerprintOf(first.publicKeyRaw))).toEqual(
      Array.from(first.fingerprint),
    );
  });
});
