/**
 * The HTTP seam: a real socket, a real server, the contract the node enforces.
 *
 * These tests deliberately assert on the *wire*, not on internals — request
 * content types, paging tokens, error shapes, and the JSON the node answers
 * with. A JSON body on the submit route is rejected by the fake node exactly
 * as snapchain rejects it, which is what pins the client to protobuf.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAppKey } from '../appKey';
import { NodeApiError, NodeUnreachableError } from '../errors';
import { SnapchainNodeClient } from '../http';
import { buildCastAddMessage } from '../messages';
import { bytesToHex } from '../wire';
import {
  fixedRandomBytes,
  startTestNode,
  TEST_FID,
  type TestNode,
} from './fixtures';

let node: TestNode;
let client: SnapchainNodeClient;

beforeEach(async () => {
  node = await startTestNode();
  client = new SnapchainNodeClient({ baseUrl: node.url });
});

afterEach(async () => {
  await node.close();
});

const seedCast = async (options: {
  fid: number;
  text: string;
  timestamp: number;
  parentCastId?: { fid: number; hash: string };
  parentUrl?: string;
}) => {
  const appKey = await generateAppKey(fixedRandomBytes(options.fid % 250));
  const built = await buildCastAddMessage({
    fid: options.fid,
    signerPrivateKey: appKey.privateKey,
    text: options.text,
    timestamp: options.timestamp,
    ...(options.parentCastId ? { parentCastId: options.parentCastId } : {}),
    ...(options.parentUrl ? { parentUrl: options.parentUrl } : {}),
  });
  node.store(built.message);
  return { built, appKey };
};

describe('reads', () => {
  it('reports node info from /v1/info', async () => {
    const info = await client.info();
    expect(info.version).toBe('test-node-1.0.0');
    expect(info.numShards).toBe(2);
    expect(info.peerId).toBe('12D3KooWFakeNodeForTests');
    expect(info.shardInfos).toHaveLength(2);
  });

  it('reports health with latency, and failure without throwing', async () => {
    const health = await client.health();
    expect(health.ok).toBe(true);
    expect(health.info?.version).toBe('test-node-1.0.0');
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);

    const offline = new SnapchainNodeClient({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 1500,
    });
    const deadHealth = await offline.health();
    expect(deadHealth.ok).toBe(false);
    expect(deadHealth.error).toBeTruthy();
  });

  it('decodes casts by fid: hex hashes, base64 signatures, proto enum names, unix time', async () => {
    const { built } = await seedCast({
      fid: TEST_FID,
      text: 'my own node',
      timestamp: 12_345_678,
    });

    const page = await client.castsByFid({ fid: TEST_FID });

    expect(page.messages).toHaveLength(1);
    const cast = page.messages[0]!;
    expect(cast.type).toBe('MESSAGE_TYPE_CAST_ADD');
    expect(cast.network).toBe('FARCASTER_NETWORK_MAINNET');
    expect(cast.castAdd?.text).toBe('my own node');
    expect(cast.castAdd?.castType).toBe('CAST');
    expect(cast.fid).toBe(TEST_FID);
    expect(cast.timestamp).toBe(12_345_678);
    // Farcaster seconds -> Unix ms (epoch 2021-01-01).
    expect(cast.timestampMs).toBe(12_345_678 * 1000 + Date.UTC(2021, 0, 1));
    expect(cast.hash).toBe(built.hash);
    expect(cast.signatureScheme).toBe('SIGNATURE_SCHEME_ED25519');
    // signature came back base64 and is 64 bytes of Ed25519.
    expect(Buffer.from(cast.signature, 'base64').length).toBe(64);
  });

  it('pages with nextPageToken, newest first', async () => {
    for (let i = 0; i < 5; i += 1) {
      await seedCast({
        fid: TEST_FID,
        text: `cast ${i}`,
        timestamp: 12_000_000 + i,
      });
    }

    const first = await client.castsByFid({ fid: TEST_FID, pageSize: 2 });
    expect(first.messages.map((message) => message.castAdd?.text)).toEqual([
      'cast 4',
      'cast 3',
    ]);
    expect(first.nextPageToken).toBeTruthy();

    const second = await client.castsByFid({
      fid: TEST_FID,
      pageSize: 2,
      pageToken: first.nextPageToken,
    });
    expect(second.messages.map((message) => message.castAdd?.text)).toEqual([
      'cast 2',
      'cast 1',
    ]);

    const third = await client.castsByFid({
      fid: TEST_FID,
      pageSize: 2,
      pageToken: second.nextPageToken,
    });
    expect(third.messages.map((message) => message.castAdd?.text)).toEqual([
      'cast 0',
    ]);
    expect(third.nextPageToken).toBeUndefined();
  });

  it('reads replies by parent cast and casts by channel url', async () => {
    const parent = { fid: 2, hash: `0x${'77'.repeat(20)}` };
    await seedCast({
      fid: 3,
      text: 'reply one',
      timestamp: 12_000_001,
      parentCastId: parent,
    });
    await seedCast({
      fid: 4,
      text: 'reply two',
      timestamp: 12_000_002,
      parentCastId: parent,
    });
    await seedCast({
      fid: 5,
      text: 'channel cast',
      timestamp: 12_000_003,
      parentUrl: 'https://farcaster.xyz/~/channel/fiddy',
    });

    const replies = await client.castsByParent({
      fid: parent.fid,
      hash: parent.hash,
    });
    expect(replies.messages.map((message) => message.castAdd?.text)).toEqual([
      'reply one',
      'reply two',
    ]);

    const channel = await client.castsByParent({
      url: 'https://farcaster.xyz/~/channel/fiddy',
    });
    expect(channel.messages.map((message) => message.castAdd?.text)).toEqual([
      'channel cast',
    ]);
  });

  it('reads links and user data', async () => {
    const { buildLinkAddMessage, buildUserDataAddMessage } =
      await import('../messages');
    const appKey = await generateAppKey(fixedRandomBytes(3));
    node.store(
      (
        await buildLinkAddMessage({
          fid: TEST_FID,
          signerPrivateKey: appKey.privateKey,
          targetFid: 42,
          timestamp: 12_000_010,
        })
      ).message,
    );
    node.store(
      (
        await buildUserDataAddMessage({
          fid: TEST_FID,
          signerPrivateKey: appKey.privateKey,
          userDataType: 'display',
          value: 'Fiddy client',
          timestamp: 12_000_011,
        })
      ).message,
    );

    const links = await client.linksByFid({
      fid: TEST_FID,
      linkType: 'follow',
    });
    expect(links.messages).toHaveLength(1);
    expect(links.messages[0]!.link).toMatchObject({
      linkType: 'follow',
      targetFid: 42,
    });

    const profile = await client.userDataByFid({ fid: TEST_FID });
    expect(profile.messages[0]!.userData).toMatchObject({
      userDataType: 'USER_DATA_TYPE_DISPLAY',
      value: 'Fiddy client',
    });
  });

  it('passes the reaction type as the node\u2019s variant name, and shows why', async () => {
    const { buildReactionAddMessage } = await import('../messages');
    const appKey = await generateAppKey(fixedRandomBytes(4));
    const target = { fid: 2, hash: `0x${'88'.repeat(20)}` };
    node.store(
      (
        await buildReactionAddMessage({
          fid: TEST_FID,
          signerPrivateKey: appKey.privateKey,
          reactionType: 'like',
          targetCastId: target,
          timestamp: 12_000_020,
        })
      ).message,
    );

    const likes = await client.reactionsByFid({
      fid: TEST_FID,
      reactionType: 'Like',
    });
    expect(likes.messages).toHaveLength(1);
    expect(likes.messages[0]!.reaction?.reactionType).toBe(
      'REACTION_TYPE_LIKE',
    );

    // The proto name is rejected by the node — the client must send `Like`.
    const protoName = await fetch(
      `${node.url}/v1/reactionsByFid?fid=${TEST_FID}&reaction_type=REACTION_TYPE_LIKE`,
    );
    expect(protoName.status).toBe(400);
    expect(await protoName.text()).toContain('unknown variant');

    // ...and omitting it entirely is also a 400 on this route.
    const missing = await fetch(
      `${node.url}/v1/reactionsByFid?fid=${TEST_FID}`,
    );
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('missing field `reaction_type`');

    const onCast = await client.reactionsByCast({
      targetFid: target.fid,
      targetHash: target.hash,
      reactionType: 'Like',
    });
    expect(onCast.messages).toHaveLength(1);
  });

  it('reads storage limits so the client can show remaining headroom', async () => {
    const limits = await client.storageLimitsByFid(TEST_FID);
    expect(limits.limits[0]).toMatchObject({ name: 'CASTS', limit: 5000 });
  });
});

describe('writes', () => {
  it('submits protobuf with application/octet-stream and stores the cast', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(9));
    node.addSigner({
      key: appKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_ONCHAIN',
    });

    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'posted through my node',
    });

    const accepted = await client.submitMessage(built.bytes);

    const [request] = node.requestsFor('/v1/submitMessage');
    expect(request?.method).toBe('POST');
    expect(request?.contentType).toBe('application/octet-stream');
    expect(request?.bodyBytes).toBe(built.bytes.length);

    expect(accepted.hash).toBe(built.hash);
    expect(accepted.castAdd?.text).toBe('posted through my node');
    expect(accepted.signer).toBe(appKey.publicKeyHex);

    // The node stored what it decoded, so the cast is now queryable — the
    // confirmation path a read node offers instead of a block receipt.
    const page = await client.castsByFid({ fid: TEST_FID });
    expect(page.messages.map((message) => message.castAdd?.text)).toContain(
      'posted through my node',
    );
  });

  it('accepts a pre-encoded message object as well as bytes', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(11));
    node.addSigner({
      key: appKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_ONCHAIN',
    });
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'object form',
    });
    node.state.messages.length = 0;
    const accepted = await client.submitMessage(built.message);
    expect(accepted.hash).toBe(built.hash);
    expect(node.requestsFor('/v1/submitMessage')[0]?.contentType).toBe(
      'application/octet-stream',
    );
  });

  it('is rejected when a JSON body is sent instead — the reason this client speaks protobuf', async () => {
    const response = await fetch(`${node.url}/v1/submitMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: { type: 'MESSAGE_TYPE_CAST_ADD', fid: TEST_FID },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Invalid content type');

    const noType = await fetch(`${node.url}/v1/submitMessage`, {
      method: 'POST',
      body: 'x',
    });
    expect(noType.status).toBe(400);
  });

  it('surfaces the node\u2019s own rejection reason for an unauthorized signer', async () => {
    const rogueKey = await generateAppKey(fixedRandomBytes(13));
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: rogueKey.privateKey,
      text: 'no key was ever added for this',
    });

    await expect(client.submitMessage(built.bytes)).rejects.toThrowError(
      NodeApiError,
    );
    try {
      await client.submitMessage(built.bytes);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(NodeApiError);
      const apiError = error as NodeApiError;
      expect(apiError.status).toBe(400);
      expect(apiError.nodeError).toBe('Invalid signer');
      expect(apiError.message).toContain('is not a signer for fid');
    }
  });

  it('confirms a submitted cast by querying it back, and gives up cleanly', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(15));
    node.addSigner({
      key: appKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_ONCHAIN',
    });
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'confirm me',
    });
    await client.submitMessage(built.bytes);

    const confirmed = await client.confirmMessage({
      fid: TEST_FID,
      hash: built.hash,
    });
    expect(confirmed?.castAdd?.text).toBe('confirm me');

    const missing = await client.confirmMessage({
      fid: TEST_FID,
      hash: `0x${'00'.repeat(20)}`,
      attempts: 2,
      intervalMs: 1,
    });
    expect(missing).toBeUndefined();
  });

  it('dry-runs a message with validateMessage without storing it', async () => {
    const appKey = await generateAppKey(fixedRandomBytes(17));
    node.addSigner({
      key: appKey.publicKeyHex,
      fid: TEST_FID,
      source: 'SIGNER_SOURCE_ONCHAIN',
    });
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: appKey.privateKey,
      text: 'dry run',
    });

    const result = (await client.validateMessage(built.bytes)) as {
      valid?: boolean;
    };
    expect(result.valid).toBe(true);
    expect(node.requestsFor('/v1/validateMessage')[0]?.contentType).toBe(
      'application/octet-stream',
    );
    expect(await client.castsByFid({ fid: TEST_FID })).toMatchObject({
      messages: [],
    });
  });
});

describe('errors', () => {
  it('maps a missing signer to a 404-shaped NodeApiError', async () => {
    await expect(
      client.signer({ fid: TEST_FID, signer: `0x${'99'.repeat(32)}` }),
    ).rejects.toMatchObject({ name: 'NodeApiError', status: 404 });

    try {
      await client.signer({ fid: TEST_FID, signer: `0x${'99'.repeat(32)}` });
    } catch (error) {
      expect((error as NodeApiError).isNotFound).toBe(true);
    }
  });

  it('turns a dead node into NodeUnreachableError, keeping the base url', async () => {
    const offline = new SnapchainNodeClient({
      baseUrl: 'http://127.0.0.1:1',
      timeoutMs: 1200,
    });
    await expect(offline.info()).rejects.toThrowError(NodeUnreachableError);
    try {
      await offline.info();
    } catch (error) {
      expect((error as NodeUnreachableError).baseUrl).toBe(
        'http://127.0.0.1:1',
      );
    }
  });

  it('reports an unknown route as a 404, not a crash', async () => {
    const response = await fetch(`${node.url}/v1/nope`);
    expect(response.status).toBe(404);
  });

  it('keeps the node\u2019s error detail out of the message but available', async () => {
    const rogueKey = await generateAppKey(fixedRandomBytes(19));
    const built = await buildCastAddMessage({
      fid: TEST_FID,
      signerPrivateKey: rogueKey.privateKey,
      text: 'unauthorized',
    });
    try {
      await client.submitMessage(built.bytes);
      throw new Error('expected a rejection');
    } catch (error) {
      const apiError = error as NodeApiError;
      expect(apiError.nodeErrorDetail).toContain(
        bytesToHex(rogueKey.publicKey).slice(0, 10),
      );
      expect(apiError.path).toBe('/v1/submitMessage');
    }
  });
});

describe('deterministic test seams', () => {
  it('records every request the client makes', async () => {
    await client.info();
    await client.castsByFid({ fid: TEST_FID });
    await client.signersByFid({ fid: TEST_FID });
    const paths = node.state.requests.map((request) => request.path);
    expect(paths).toEqual(['/v1/info', '/v1/castsByFid', '/v1/signersByFid']);
  });
});

describe('the fetch a client without one of its own uses', () => {
  /**
   * MEASURED 2026-10-23, in this client's own social sign-up probe (stage G):
   * the account flow's node reads never left the page, and the reason was
   * "Failed to execute 'fetch' on 'Window': Illegal invocation" — a browser's
   * `fetch` is a method of `Window`, so calling it off an instance throws. Node
   * tolerates the receiver, which is why every test in this file passed while a
   * browser did not. The reporter here is the receiver, which is the only thing
   * that differs between the two.
   */
  it('calls the global fetch with the global as its receiver', async () => {
    const original = globalThis.fetch;
    const receivers: unknown[] = [];

    globalThis.fetch = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ version: 'bound-node', numShards: 1, syncHeight: 1 }),
      });
    } as unknown as typeof fetch;

    try {
      const bound = new SnapchainNodeClient({ baseUrl: 'https://node.invalid' });
      const info = await bound.info();

      expect(info.version).toBe('bound-node');
      expect(receivers).toHaveLength(1);
      expect(receivers[0]).toBe(globalThis);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('hands an injected fetch on exactly as it was given', async () => {
    const injected = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ version: 'injected-node', numShards: 1, syncHeight: 1 }),
    });
    const receivers: unknown[] = [];
    const report = function (this: unknown) {
      receivers.push(this);
      return injected();
    };

    const client = new SnapchainNodeClient({
      baseUrl: 'https://node.invalid',
      fetch: report as unknown as (input: string) => Promise<{
        ok: boolean;
        status: number;
        text(): Promise<string>;
      }>,
    });

    await client.info();

    // Not bound to the global: it is the caller's own function, and a caller
    // that closes over something (a timeout, credentials, a retry) needs it.
    expect(receivers[0]).not.toBe(globalThis);
  });
});
