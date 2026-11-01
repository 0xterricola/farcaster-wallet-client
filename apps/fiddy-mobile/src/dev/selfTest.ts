/**
 * On-device checks for the read path — run by hand from the node sheet.
 *
 * The card for this release says the React Native compatibility of
 * `@farcaster/core` (NobleEd25519 + the hub/protobuf layer) has to be *verified
 * on-device, not assumed*. Hermes is not Node: `Buffer`, `TextDecoder` and the
 * protobuf helpers are exactly where this normally breaks, and a bundler
 * resolving a module proves nothing about whether it runs.
 *
 * So this runs the real thing on the device and prints what happened. It signs
 * with a PUBLIC TEST VECTOR (bytes 1..32) that appears in every Farcaster test
 * fixture — never a user key, and nothing here is submitted to any node: there
 * is no `submitMessage` call in this file, by design.
 */

import {
  CastType,
  FARCASTER_EPOCH,
  FarcasterNetwork,
  Message,
  MessageType,
  NobleEd25519Signer,
  ed25519,
  fromFarcasterTime,
  makeCastAdd,
  toFarcasterTime,
} from '@farcaster/core';
import type { SnapchainNodeClient } from 'farcaster-node-client';

export interface SelfTestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

const ok = (name: string, detail: string): SelfTestCheck => ({ name, ok: true, detail });
const fail = (name: string, detail: string): SelfTestCheck => ({ name, ok: false, detail });

const errorDetail = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** `Buffer` — @farcaster/core reaches for `globalThis.Buffer` in its protobuf helpers. */
const checkBuffer = (): SelfTestCheck => {
  try {
    const roundTripped = Buffer.from('fiddy', 'utf8').toString('base64');
    const back = Buffer.from(roundTripped, 'base64').toString('utf8');
    if (back !== 'fiddy') {
      return fail('Buffer', `base64 round-trip returned "${back}"`);
    }
    const hex = Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('hex');
    return ok('Buffer', `utf8+base64+hex ok (${hex})`);
  } catch (error) {
    return fail('Buffer', errorDetail(error));
  }
};

/** `TextEncoder`/`TextDecoder` — constructed at module scope by @farcaster/core. */
const checkTextCodec = (): SelfTestCheck => {
  try {
    const native =
      typeof (globalThis as { TextEncoder?: unknown }).TextEncoder === 'function' &&
      Object.prototype.toString
        .call((globalThis as { TextEncoder?: unknown }).TextEncoder)
        .includes('native code');
    const sample = 'Fiddy · 🥚 é 𝟘';
    const bytes = new globalThis.TextEncoder().encode(sample);
    const decoded = new globalThis.TextDecoder().decode(bytes);
    if (decoded !== sample) {
      return fail('TextEncoder/Decoder', `round-trip mismatch: "${decoded}"`);
    }
    return ok(
      'TextEncoder/Decoder',
      `${bytes.length} bytes round-tripped (${native ? 'native' : 'shim'})`,
    );
  } catch (error) {
    return fail('TextEncoder/Decoder', errorDetail(error));
  }
};

/** The OS CSPRNG: Hermes has no WebCrypto, so this comes from expo-crypto. */
const checkCrypto = (): SelfTestCheck => {
  try {
    const cryptoImpl = (
      globalThis as unknown as {
        crypto?: {
          getRandomValues?: (array: Uint8Array) => Uint8Array;
          randomUUID?: () => string;
        };
      }
    ).crypto;
    if (typeof cryptoImpl?.getRandomValues !== 'function') {
      return fail('CSPRNG', 'globalThis.crypto.getRandomValues is missing');
    }
    const first = cryptoImpl.getRandomValues(new Uint8Array(16));
    const second = cryptoImpl.getRandomValues(new Uint8Array(16));
    if (first.every((byte) => byte === 0)) {
      return fail('CSPRNG', 'getRandomValues returned all zeroes');
    }
    if (first.every((byte, index) => byte === second[index])) {
      return fail('CSPRNG', 'two calls returned the same bytes');
    }
    const uuid = cryptoImpl.randomUUID?.() ?? '';
    return ok('CSPRNG', `16 bytes from the OS per call, uuid ${uuid.slice(0, 8)}…`);
  } catch (error) {
    return fail('CSPRNG', errorDetail(error));
  }
};

/** Farcaster time helpers — the epoch math every timestamp in the feed uses. */
const checkFarcasterTime = (): SelfTestCheck => {
  try {
    if (FARCASTER_EPOCH !== 1609459200000) {
      return fail('Farcaster time', `epoch is ${FARCASTER_EPOCH}`);
    }
    const now = Date.now();
    const encoded = toFarcasterTime(now);
    if (encoded.isErr()) {
      return fail('Farcaster time', encoded.error.message);
    }
    const decoded = fromFarcasterTime(encoded.value);
    if (decoded.isErr()) {
      return fail('Farcaster time', decoded.error.message);
    }
    const drift = Math.abs(decoded.value - now);
    return ok('Farcaster time', `epoch ok, round-trip drift ${drift}ms`);
  } catch (error) {
    return fail('Farcaster time', errorDetail(error));
  }
};

/** NobleEd25519 on Hermes: pure-JS curves, no crypto module, no RNG needed. */
const checkEd25519 = async (): Promise<SelfTestCheck> => {
  try {
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const publicKeyResult = await ed25519.getPublicKey(seed);
    if (publicKeyResult.isErr()) {
      return fail('Noble Ed25519', publicKeyResult.error.message);
    }
    const publicKey = publicKeyResult.value;
    const hash = new Uint8Array(32).fill(7);
    const signatureResult = await ed25519.signMessageHash(hash, seed);
    if (signatureResult.isErr()) {
      return fail('Noble Ed25519', signatureResult.error.message);
    }
    const signature = signatureResult.value;
    const verified = await ed25519.verifyMessageHashSignature(signature, hash, publicKey);
    if (verified.isErr() || !verified.value) {
      return fail('Noble Ed25519', 'signature did not verify');
    }
    const tampered = Uint8Array.from(hash);
    tampered[0] = 8;
    const tamperedResult = await ed25519.verifyMessageHashSignature(
      signature,
      tampered,
      publicKey,
    );
    if (!tamperedResult.isErr() && tamperedResult.value) {
      return fail('Noble Ed25519', 'tampered hash still verified');
    }
    const publicKeyHex = Array.from(publicKey.slice(0, 10))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    // Cross-checked against the same seed on Node: 79b5562e8fe654f94078…
    const nodeHex = '79b5562e8fe654f94078';
    if (publicKeyHex !== nodeHex) {
      return fail(
        'Noble Ed25519',
        `public key ${publicKeyHex}… differs from the Node-computed ${nodeHex}…`,
      );
    }
    return ok(
      'Noble Ed25519',
      `${signature.length}B signature matches the Node-computed key ${publicKeyHex}…, tamper rejected`,
    );
  } catch (error) {
    return fail('Noble Ed25519', errorDetail(error));
  }
};

/**
 * The real write path, minus the network: build → hash (blake3) → sign →
 * protobuf encode → protobuf decode. This is what "hub-nodejs compat" means in
 * practice, and it never touches a node.
 */
const checkCastRoundTrip = async (): Promise<SelfTestCheck> => {
  try {
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const signer = new NobleEd25519Signer(seed);
    const built = await makeCastAdd(
      {
        text: 'fiddy self-test — never submitted',
        embeds: [],
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        type: CastType.CAST,
      },
      { fid: 3, network: FarcasterNetwork.MAINNET },
      signer,
    );
    if (built.isErr()) {
      return fail('Cast build+sign', built.error.message);
    }
    const message = built.value;
    const bytes = Message.encode(message).finish();
    const decoded = Message.decode(bytes);
    if (decoded.data?.castAddBody?.text !== message.data?.castAddBody?.text) {
      return fail('Cast build+sign', 'protobuf round-trip lost the cast text');
    }
    if (!decoded.signature || decoded.signature.length !== 64) {
      return fail('Cast build+sign', 'signature missing after decode');
    }
    const hash = Buffer.from(message.hash).toString('hex').slice(0, 12);
    return ok(
      'Cast build+sign',
      `${bytes.length}B protobuf, ${decoded.signature.length}B sig, hash ${hash}… (not submitted)`,
    );
  } catch (error) {
    return fail('Cast build+sign', errorDetail(error));
  }
};

/** The read path against the node the app is actually pointed at. */
const checkNodeRead = async (
  client: SnapchainNodeClient,
  fid: number,
): Promise<SelfTestCheck> => {
  try {
    const health = await client.health();
    if (!health.ok) {
      return fail('Node read', health.error ?? 'no response');
    }
    const page = await client.castsByFid({ fid: fid || 3, pageSize: 5 });
    const casts = page.messages.filter((message) => message.castAdd);
    if (casts.length === 0) {
      return fail('Node read', `fid ${fid || 3} returned no casts`);
    }
    const newest = casts[0];
    return ok(
      'Node read',
      `${casts.length} casts decoded from fid ${fid || 3} in ${health.latencyMs}ms · ${
        newest.castAdd?.text.slice(0, 32) ?? ''
      }…`,
    );
  } catch (error) {
    return fail('Node read', errorDetail(error));
  }
};

export const runSelfTest = async (
  client: SnapchainNodeClient,
  fid: number,
): Promise<SelfTestCheck[]> => {
  const results: SelfTestCheck[] = [
    checkBuffer(),
    checkTextCodec(),
    checkCrypto(),
    checkFarcasterTime(),
    await checkEd25519(),
    await checkCastRoundTrip(),
  ];
  results.push(await checkNodeRead(client, fid));
  return results;
};