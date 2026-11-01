/**
 * P-256 point compression, written from the curve's own parameters.
 *
 * Why this file exists: a sealed cast carries an ephemeral public key, and
 * WebCrypto exports that key uncompressed — 65 bytes, `04 || X || Y`. Inside a
 * cast, every byte of envelope costs 4/3 of a character of base64url against a
 * hard 320-byte budget, so dropping `Y` (which is derivable from `X`, up to its
 * sign) buys back 32 bytes — about 43 characters of readable message per cast.
 * The sign of `Y` is exactly what the 0x02/0x03 prefix records.
 *
 * The maths is P-256's own: `y² = x³ - 3x + b (mod p)`, and because
 * `p ≡ 3 (mod 4)` a square root is one exponentiation, `y = rhs^((p+1)/4)`.
 * Pure BigInt, no dependencies, and `p256.test.ts` round-trips every key through
 * it against WebCrypto — a wrong square root cannot survive both parity checks
 * and a real ECDH agreement.
 */
import { CryptoBytes } from './encoding';
import { sealedProblem } from './errors';

/** The field prime of P-256 (FIPS 186-4, D.1.2.3). */
const FIELD_PRIME = BigInt(
  '0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
);

/** The curve constant `b` of P-256. */
const CURVE_B = BigInt(
  '0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b',
);

/** `(p + 1) / 4` — the square-root exponent, valid because `p ≡ 3 (mod 4)`. */
const SQUARE_ROOT_EXPONENT = (FIELD_PRIME + 1n) / 4n;

const PARITY_COMPRESSED_EVEN = 0x02;
const PARITY_COMPRESSED_ODD = 0x03;
const UNCOMPRESSED_MARKER = 0x04;

export const UNCOMPRESSED_POINT_BYTES = 65;
export const COMPRESSED_POINT_BYTES = 33;

const FIELD_BYTES = 32;

const mod = (value: bigint): bigint =>
  ((value % FIELD_PRIME) + FIELD_PRIME) % FIELD_PRIME;

const modPow = (base: bigint, exponent: bigint): bigint => {
  let result = 1n;
  let square = mod(base);
  let remaining = exponent;

  while (remaining > 0n) {
    if (remaining & 1n) {
      result = mod(result * square);
    }

    square = mod(square * square);
    remaining >>= 1n;
  }

  return result;
};

const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return value;
};

const bigIntToBytes = (value: bigint, length: number): CryptoBytes => {
  const out = new Uint8Array(length);
  let remaining = value;

  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  if (remaining !== 0n) {
    throw sealedProblem('that key is too large to be a key on this curve');
  }

  return out;
};

/** The right-hand side of the curve equation, `x³ - 3x + b`. */
const curveRightHandSide = (x: bigint): bigint =>
  mod(mod(x * x * x) - 3n * x + CURVE_B);

export const isPointOnCurve = (x: bigint, y: bigint): boolean =>
  x >= 0n && x < FIELD_PRIME && y >= 0n && y < FIELD_PRIME
    ? mod(y * y) === curveRightHandSide(x)
    : false;

/**
 * `04 || X || Y` → `0x02|0x03 || X`. Throws if the bytes are not a point on
 * the curve, so a corrupted key is refused at the door rather than at decryption
 * time.
 */
export const compressPublicKey = (uncompressed: Uint8Array): CryptoBytes => {
  if (
    uncompressed.length !== UNCOMPRESSED_POINT_BYTES ||
    uncompressed[0] !== UNCOMPRESSED_MARKER
  ) {
    throw sealedProblem('that key is not 65 bytes of uncompressed point');
  }

  const x = uncompressed.slice(1, 1 + FIELD_BYTES);
  const y = bytesToBigInt(uncompressed.slice(1 + FIELD_BYTES));

  if (!isPointOnCurve(bytesToBigInt(x), y)) {
    throw sealedProblem('that key is not a point on this curve');
  }

  const out = new Uint8Array(COMPRESSED_POINT_BYTES);
  out[0] = (y & 1n) === 0n ? PARITY_COMPRESSED_EVEN : PARITY_COMPRESSED_ODD;
  out.set(x, 1);

  return out;
};

/**
 * `0x02|0x03 || X` → `04 || X || Y`, by solving the curve equation for `Y` and
 * keeping the root whose parity matches the prefix.
 */
export const decompressPublicKey = (compressed: Uint8Array): CryptoBytes => {
  if (compressed.length !== COMPRESSED_POINT_BYTES) {
    throw sealedProblem('that key is not 33 bytes of compressed point');
  }

  const marker = compressed[0];

  if (marker !== PARITY_COMPRESSED_EVEN && marker !== PARITY_COMPRESSED_ODD) {
    throw sealedProblem('that key has no parity marker we understand');
  }

  const xBytes = compressed.slice(1);
  const x = bytesToBigInt(xBytes);

  if (x >= FIELD_PRIME) {
    throw sealedProblem('that key is not a point on this curve');
  }

  const rhs = curveRightHandSide(x);
  let y = modPow(rhs, SQUARE_ROOT_EXPONENT);

  if (mod(y * y) !== rhs) {
    throw sealedProblem('that key is not a point on this curve');
  }

  const wantOdd = marker === PARITY_COMPRESSED_ODD;

  if (((y & 1n) === 1n) !== wantOdd) {
    y = FIELD_PRIME - y;
  }

  const out = new Uint8Array(UNCOMPRESSED_POINT_BYTES);
  out[0] = UNCOMPRESSED_MARKER;
  out.set(xBytes, 1);
  out.set(bigIntToBytes(y, FIELD_BYTES), 1 + FIELD_BYTES);

  return out;
};
