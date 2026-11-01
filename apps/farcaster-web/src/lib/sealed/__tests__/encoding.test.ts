import { describe, expect, it } from 'vitest';

import {
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  bytesToUtf8,
  concatBytes,
  utf8ByteLength,
  utf8ToBytes,
} from '~/lib/sealed/encoding';

const bytesOfLength = (length: number, seed = 7): Uint8Array => {
  const out = new Uint8Array(length);

  for (let index = 0; index < length; index += 1) {
    out[index] = (seed * (index + 1) * 31) % 256;
  }

  return out;
};

describe('base64url', () => {
  it('round-trips every remainder class', () => {
    for (let length = 0; length <= 12; length += 1) {
      const bytes = bytesOfLength(length);
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
    }

    const long = bytesOfLength(1000);
    expect(base64UrlToBytes(bytesToBase64Url(long))).toEqual(long);
  });

  it('never writes a character a cast could mistake for markup', () => {
    const encoded = bytesToBase64Url(bytesOfLength(512));

    expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('.');
    expect(encoded).not.toContain('@');
  });

  it('says which character it could not read', () => {
    expect(() => base64UrlToBytes('ab!d')).toThrow(/sealed text/);
    expect(() => base64UrlToBytes('ab!d')).toThrow(/"!"/);
  });

  it('refuses a length that cannot be base64 at all', () => {
    expect(() => base64UrlToBytes('abcde')).toThrow(/sealed text/);
  });
});

describe('utf8 and hex', () => {
  it('counts bytes, not characters, because casts are counted in bytes', () => {
    expect(utf8ByteLength('hi')).toBe(2);
    expect(utf8ByteLength('ħi')).toBe(3);
    expect(utf8ByteLength('🔒')).toBe(4);
  });

  it('round-trips a message with emoji and combining characters', () => {
    const text = 'seal this 🔒 for Zoë — yes, really';

    expect(bytesToUtf8(utf8ToBytes(text))).toBe(text);
  });

  it('writes fingerprints as fixed-width hex', () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});

describe('concatBytes', () => {
  it('concatenates in order and copies rather than aliases', () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3]);
    const joined = concatBytes(first, second, new Uint8Array([4]));

    expect(Array.from(joined)).toEqual([1, 2, 3, 4]);

    first[0] = 99;

    expect(joined[0]).toBe(1);
  });

  it('returns an empty array for no parts', () => {
    expect(concatBytes().length).toBe(0);
  });
});
