/**
 * Byte plumbing for sealed casts — base64url, UTF-8, concatenation. Pure: no
 * WebCrypto, no `fetch`, no browser globals, so this module can be imported by
 * anything (including the cast renderer) without pulling crypto into the main
 * bundle.
 *
 * The sealed text travels *inside a Farcaster cast*, which is why the alphabet
 * matters: base64url is `A-Z a-z 0-9 - _`, so a sealed body contains no `@`, no
 * `.` and no `/`. Nothing in it can be mistaken for a mention, a link or a
 * cashtag by any client, including ones that have never heard of this format.
 */
import { sealedProblem } from './errors';

/**
 * WebCrypto's DOM types are generic over the backing buffer, and every byte
 * array these modules produce is a fresh copy — so say so once, here, rather
 * than casting at each `subtle` call site.
 */
export type CryptoBytes = Uint8Array<ArrayBuffer>;

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encode raw bytes as unpadded base64url. */
export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let out = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];

    out += BASE64URL_ALPHABET[first >> 2];
    out += BASE64URL_ALPHABET[((first & 0b11) << 4) | ((second ?? 0) >> 4)];

    if (second === undefined) {
      break;
    }

    out += BASE64URL_ALPHABET[((second & 0b1111) << 2) | ((third ?? 0) >> 6)];

    if (third === undefined) {
      break;
    }

    out += BASE64URL_ALPHABET[third & 0b111111];
  }

  return out;
};

/** Decode unpadded base64url. Throws a `SealedError` a reader can understand. */
export const base64UrlToBytes = (text: string): CryptoBytes => {
  const trimmed = text.trim();

  if (trimmed.length % 4 === 1) {
    throw sealedProblem('this is not our kind of sealed text');
  }

  const out = new Uint8Array(Math.floor((trimmed.length * 3) / 4));
  let written = 0;
  let buffer = 0;
  let bits = 0;

  for (const character of trimmed) {
    const value = BASE64URL_ALPHABET.indexOf(character);

    if (value < 0) {
      throw sealedProblem(
        `this is not our kind of sealed text (it carries a "${character}" that our format never writes)`,
      );
    }

    buffer = (buffer << 6) | value;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      out[written] = (buffer >> bits) & 0xff;
      written += 1;
    }
  }

  return out.slice(0, written);
};

export const utf8ToBytes = (text: string): CryptoBytes =>
  new TextEncoder().encode(text);

export const bytesToUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes);

export const concatBytes = (...parts: Uint8Array[]): CryptoBytes => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

/** Lowercase hex — used for fingerprints in storage keys and in assertions. */
export const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

/** How many bytes this text costs inside a cast (the protocol counts bytes). */
export const utf8ByteLength = (text: string): number =>
  utf8ToBytes(text).length;
