import { describe, expect, it } from 'vitest';

import {
  COMPRESSED_POINT_BYTES,
  compressPublicKey,
  decompressPublicKey,
  isPointOnCurve,
  UNCOMPRESSED_POINT_BYTES,
} from '~/lib/sealed/p256';

const FIELD_PRIME = BigInt(
  '0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
);

const bigIntFromBytes = (bytes: Uint8Array): bigint => {
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return value;
};

const exportRawKey = async (): Promise<Uint8Array<ArrayBuffer>> => {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );

  return new Uint8Array(
    await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey),
  );
};

describe('P-256 point compression', () => {
  it('round-trips WebCrypto keys of both parities, byte for byte', async () => {
    let sawEvenY = false;
    let sawOddY = false;

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const raw = await exportRawKey();
      const compressed = compressPublicKey(raw);
      const decompressed = decompressPublicKey(compressed);

      expect(compressed.length).toBe(COMPRESSED_POINT_BYTES);
      expect(decompressed.length).toBe(UNCOMPRESSED_POINT_BYTES);
      expect(Array.from(decompressed)).toEqual(Array.from(raw));

      if (raw[64]! % 2 === 0) {
        sawEvenY = true;
      } else {
        sawOddY = true;
      }
    }

    /* Both parities must actually be exercised, or the parity branch is untested. */
    expect(sawEvenY).toBe(true);
    expect(sawOddY).toBe(true);
  });

  it('is the key WebCrypto accepts: an ECDH agreement survives the round trip', async () => {
    const alice = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    const bobRaw = await exportRawKey();

    const bobCompressed = compressPublicKey(bobRaw);
    const bobDecompressed = decompressPublicKey(bobCompressed);

    const direct = new Uint8Array(
      await globalThis.crypto.subtle.deriveBits(
        {
          name: 'ECDH',
          public: await globalThis.crypto.subtle.importKey(
            'raw',
            bobRaw,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            [],
          ),
        },
        alice.privateKey,
        256,
      ),
    );

    const throughCompression = new Uint8Array(
      await globalThis.crypto.subtle.deriveBits(
        {
          name: 'ECDH',
          public: await globalThis.crypto.subtle.importKey(
            'raw',
            bobDecompressed,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            [],
          ),
        },
        alice.privateKey,
        256,
      ),
    );

    expect(Array.from(throughCompression)).toEqual(Array.from(direct));
  });

  it('puts the decompressed point back on the curve', async () => {
    const raw = await exportRawKey();
    const point = decompressPublicKey(compressPublicKey(raw));
    const x = bigIntFromBytes(point.slice(1, 33));
    const y = bigIntFromBytes(point.slice(33));

    expect(isPointOnCurve(x, y)).toBe(true);
    expect(y).toBeLessThan(FIELD_PRIME);
  });

  it('refuses an uncompressed key that is not a point on the curve', () => {
    const raw = new Uint8Array(UNCOMPRESSED_POINT_BYTES);
    raw[0] = 0x04;
    raw[32] = 0xff;

    expect(() => compressPublicKey(raw)).toThrow(/point on this curve/);
  });

  it('refuses a marker it does not understand, and a wrong length', () => {
    const raw = new Uint8Array(COMPRESSED_POINT_BYTES);
    raw[0] = 0x07;

    expect(() => decompressPublicKey(raw)).toThrow(/parity marker/);
    expect(() => decompressPublicKey(raw.slice(0, 32))).toThrow(/33 bytes/);
    expect(() => compressPublicKey(raw.slice(0, 33))).toThrow(/65 bytes/);
  });

  it('refuses an x that has no square root, rather than inventing a point', () => {
    /* x = 1 is not on P-256: 1 - 3 + b is not a quadratic residue here, and the
       sign check after the square root is what catches anything that slips past
       the exponentiation. */
    const compressed = new Uint8Array(COMPRESSED_POINT_BYTES);
    compressed[0] = 0x02;
    compressed[32] = 0x01;

    expect(() => decompressPublicKey(compressed)).toThrow(
      /point on this curve/,
    );
  });
});
