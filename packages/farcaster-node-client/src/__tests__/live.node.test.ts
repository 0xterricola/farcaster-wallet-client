/**
 * Live smoke test against a real Snapchain read node.
 *
 * Skipped unless `SNAPCHAIN_LIVE_URL` is set, so the suite stays hermetic by
 * default:
 *
 *   SNAPCHAIN_LIVE_URL=https://your-read-node.example pnpm --filter farcaster-node-client test
 *
 * This is the only place the client touches production Farcaster data, and it
 * is read-only: it verifies that the decoder understands real node JSON and
 * that real casts' Ed25519 signatures verify against the client's own parsing.
 * It never submits — a write needs a real FID and an app key, and no test should
 * create one.
 */

import { ed25519 } from '@farcaster/core';
import { describe, expect, it } from 'vitest';

import { SnapchainNodeClient } from '../http';
import { hexToBytes } from '../wire';

const liveUrl = process.env.SNAPCHAIN_LIVE_URL;

describe.skipIf(!liveUrl)('live node (read-only)', () => {
  // The constructor is not called when the suite is skipped; keep the fallback
  // so module evaluation never throws on a URL-less run.
  const client = new SnapchainNodeClient({
    baseUrl: liveUrl ?? 'http://127.0.0.1:3381',
    timeoutMs: 30000,
  });

  it('answers /v1/info with the shard layout', async () => {
    const info = await client.info();
    expect(info.version.length).toBeGreaterThan(0);
    expect(info.numShards).toBeGreaterThan(0);
    expect(info.shardInfos.length).toBeGreaterThan(0);
    expect(info.shardInfos[0]!.maxHeight).toBeGreaterThan(0);
  });

  it('decodes real casts, and their Ed25519 signatures verify', async () => {
    // FID 2 is a long-lived account; ask for its newest few casts.
    const page = await client.castsByFid({ fid: 2, pageSize: 5 });
    expect(page.messages.length).toBeGreaterThan(0);

    for (const message of page.messages) {
      expect(message.type).toBe('MESSAGE_TYPE_CAST_ADD');
      expect(message.fid).toBe(2);
      expect(message.network).toBe('FARCASTER_NETWORK_MAINNET');
      expect(message.hash).toMatch(/^0x[0-9a-f]{40}$/);
      expect(message.signer).toMatch(/^0x[0-9a-f]{64}$/);
      expect(message.timestamp).toBeGreaterThan(0);
      // A plausible Farcaster timestamp: after 2021-01-01, before year 2100.
      expect(message.timestampMs).toBeGreaterThan(Date.UTC(2021, 0, 1));
      expect(message.timestampMs).toBeLessThan(Date.UTC(2100, 0, 1));
      expect(typeof message.castAdd?.text).toBe('string');

      const verified = await ed25519.verifyMessageHashSignature(
        // `Buffer` is a `Uint8Array` at runtime but is not assignable to
        // `Uint8Array<ArrayBuffer>` in the current @types/node, so decode the
        // base64 signature into a plain byte array.
        new Uint8Array(Buffer.from(message.signature, 'base64')),
        hexToBytes(message.hash),
        hexToBytes(message.signer),
      );
      expect(verified.isErr()).toBe(false);
      expect(verified._unsafeUnwrap()).toBe(true);
    }
  });

  it('decodes real profile data and signer records', async () => {
    const profile = await client.userDataByFid({ fid: 2, pageSize: 20 });
    expect(profile.messages.length).toBeGreaterThan(0);
    expect(
      profile.messages.some((message) =>
        message.userData?.userDataType.startsWith('USER_DATA_TYPE_'),
      ),
    ).toBe(true);

    const signers = await client.signersByFid({ fid: 2, pageSize: 20 });
    expect(signers.signers.length).toBeGreaterThan(0);
    expect(signers.gaslessSignerLimit).toBeGreaterThan(0);
    expect(['SIGNER_SOURCE_ONCHAIN', 'SIGNER_SOURCE_OFFCHAIN']).toContain(
      signers.signers[0]!.source,
    );
  });

  it('resolves the client behind a real cast from its signer record', async () => {
    const page = await client.castsByFid({ fid: 2, pageSize: 1 });
    const cast = page.messages[0]!;
    const signer = await client.signer({ fid: cast.fid, signer: cast.signer });
    expect(signer.key.toLowerCase()).toBe(cast.signer.toLowerCase());

    // Off-chain (gasless) keys report the app FID that requested them; on-chain
    // keys do not. Both shapes must decode without throwing.
    if (signer.source === 'SIGNER_SOURCE_OFFCHAIN') {
      expect(
        typeof signer.requestFid === 'number' ||
          signer.requestFid === undefined,
      ).toBe(true);
    }
  });

  it('decodes a channel (parent URL) feed', async () => {
    const page = await client.castsByParent({
      url: 'https://farcaster.xyz/~/channel/fiddy',
      pageSize: 5,
    });
    // The channel may be empty; what matters is that the route and the page
    // shape decode without throwing.
    expect(Array.isArray(page.messages)).toBe(true);
  });
});
