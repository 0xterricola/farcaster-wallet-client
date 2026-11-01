/**
 * React Native polyfills for the read path of `farcaster-node-client`.
 *
 * What is actually needed, measured against the built output rather than
 * assumed:
 *
 *  - `Buffer` — @farcaster/core's ts-proto helpers reach for `globalThis.Buffer`
 *    (`Buffer.from(b64, "base64")`) for byte fields. 103 references in
 *    dist/index.js.
 *  - `TextEncoder` / `TextDecoder` — constructed at module scope in the same
 *    bundle, so they must exist *before* the first import of @farcaster/core.
 *  - `crypto.getRandomValues` — only used to *sign*. v1 is read-only, and a
 *    silent weak-RNG fallback would be worse than a loud error, so this shim
 *    throws with an explanation instead of inventing randomness.
 *
 * Order matters: index.js imports this module before anything else.
 */

import { Buffer as NodeBuffer } from 'buffer';
import * as ExpoCrypto from 'expo-crypto';

type MutableGlobal = { [key: string]: unknown };

const globalScope = globalThis as unknown as MutableGlobal;

if (typeof globalScope.Buffer === 'undefined') {
  globalScope.Buffer = NodeBuffer;
}

if (typeof globalScope.TextEncoder === 'undefined') {
  globalScope.TextEncoder = class TextEncoderShim {
    readonly encoding = 'utf-8';

    encode(input: string = ''): Uint8Array {
      const text = String(input);
      const bytes: number[] = [];
      for (let index = 0; index < text.length; index += 1) {
        let code = text.charCodeAt(index);
        // Join a surrogate pair into one code point before encoding.
        if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
          const next = text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            index += 1;
          }
        }
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
          bytes.push(
            0xe0 | (code >> 12),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        } else {
          bytes.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        }
      }
      return Uint8Array.from(bytes);
    }
  };
}

if (typeof globalScope.TextDecoder === 'undefined') {
  globalScope.TextDecoder = class TextDecoderShim {
    readonly encoding = 'utf-8';
    private readonly fatal: boolean;

    constructor(_label?: string, options?: { fatal?: boolean }) {
      this.fatal = Boolean(options?.fatal);
    }

    decode(input?: ArrayBufferView | ArrayBuffer): string {
      if (!input) {
        return '';
      }
      const bytes =
        input instanceof Uint8Array
          ? input
          : new Uint8Array(
              input instanceof ArrayBuffer ? input : (input as ArrayBufferView).buffer,
            );
      let out = '';
      let index = 0;
      while (index < bytes.length) {
        const first = bytes[index];
        let code: number;
        let size: number;
        if (first < 0x80) {
          code = first;
          size = 1;
        } else if ((first & 0xe0) === 0xc0) {
          code = first & 0x1f;
          size = 2;
        } else if ((first & 0xf0) === 0xe0) {
          code = first & 0x0f;
          size = 3;
        } else if ((first & 0xf8) === 0xf0) {
          code = first & 0x07;
          size = 4;
        } else {
          if (this.fatal) {
            throw new TypeError('TextDecoder: invalid UTF-8 lead byte');
          }
          out += '\ufffd';
          index += 1;
          continue;
        }
        if (index + size > bytes.length) {
          if (this.fatal) {
            throw new TypeError('TextDecoder: truncated UTF-8 sequence');
          }
          out += '\ufffd';
          break;
        }
        let valid = true;
        for (let offset = 1; offset < size; offset += 1) {
          const continuation = bytes[index + offset];
          if ((continuation & 0xc0) !== 0x80) {
            valid = false;
            break;
          }
          code = (code << 6) | (continuation & 0x3f);
        }
        if (!valid || code > 0x10ffff) {
          if (this.fatal) {
            throw new TypeError('TextDecoder: invalid UTF-8 sequence');
          }
          out += '\ufffd';
          index += valid ? size : 1;
          continue;
        }
        if (code > 0xffff) {
          const adjusted = code - 0x10000;
          out += String.fromCharCode(
            0xd800 + (adjusted >> 10),
            0xdc00 + (adjusted & 0x3ff),
          );
        } else {
          out += String.fromCharCode(code);
        }
        index += size;
      }
      return out;
    }
  };
}

if (
  typeof globalScope.crypto === 'undefined' ||
  typeof (globalScope.crypto as { getRandomValues?: unknown } | undefined)
    ?.getRandomValues !== 'function'
) {
  // Hermes has no WebCrypto. This is the OS CSPRNG (SecRandomCopyBytes via
  // expo-crypto), not a JS fallback — v2 signs app keys, and a weak RNG there
  // would be a silent key compromise.
  const getRandomValues = <T extends Uint8Array>(array: T): T =>
    ExpoCrypto.getRandomValues(array as never) as T;

  globalScope.crypto = {
    getRandomValues,
    randomUUID: (): string => {
      const bytes = getRandomValues(new Uint8Array(16));
      // RFC 4122 version 4 layout.
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
      return [
        hex.slice(0, 4).join(''),
        hex.slice(4, 6).join(''),
        hex.slice(6, 8).join(''),
        hex.slice(8, 10).join(''),
        hex.slice(10, 16).join(''),
      ].join('-');
    },
  };
}