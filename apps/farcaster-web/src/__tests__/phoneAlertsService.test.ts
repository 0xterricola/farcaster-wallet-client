/**
 * The loop and the gate, without a network and without a phone.
 *
 *   1. **the gate** — a subscribe request is refused on every forged shape:
 *      stale, future, wrong endpoint, a signature that is not the key's, a key
 *      the node does not list for that FID, and a node that cannot answer
 *      (which is a refusal, never a pass);
 *   2. **the derivation** — the exact node reads the four kinds are derived
 *      from, and nothing else, with one consultation per FID;
 *   3. **the loop** — sends at most the cap, a stub endpoint records the pushes
 *      it would have carried (and never a real one), a second tick sends
 *      nothing, a GONE answer deletes the subscription, and a reader who just
 *      subscribed is not buzzed about the past.
 */

import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createActivityReader,
  createNameReader,
} from '../../server/alerts/derive.mjs';
import {
  createAlertService,
  filterKinds,
  filterMuted,
} from '../../server/alerts/service.mjs';
import { createAlertStore } from '../../server/alerts/store.mjs';
import {
  canonicalClaim,
  CLAIM_VERSION,
  createSubscribeGuard,
  endpointHash,
} from '../../server/alerts/subscribe.mjs';
import { createVapidStore } from '../../server/alerts/vapid.mjs';

/* ------------------------------------------------------------------ gate --- */

describe('who may subscribe', () => {
  const ed25519 = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    // The signer is the app key itself — the raw 32-byte key, hex with `0x`,
    // because that is what the node's signer record carries as `key`.
    return { privateKey, raw, signer: `0x${raw.toString('hex')}` };
  };

  const claimBody = (endpoint: string, fid: number, issuedAt: number) =>
    canonicalClaim({ fid, endpoint, issuedAt });

  const guardWith = (nodeAnswer: any, signer?: string) =>
    createSubscribeGuard({
      nodeGet: async () =>
        nodeAnswer === undefined
          ? undefined
          : {
              signer: {
                fid: 7,
                key: nodeAnswer.key ?? signer,
                keyType: nodeAnswer.keyType ?? 1,
              },
            },
      now: () => 1_000_000,
    });

  it('accepts a claim signed by the key the node lists for that FID', async () => {
    const key = ed25519();
    const endpoint = 'https://push.example.com/send/abc';
    const issuedAt = 999_000;
    const signature = cryptoSign(
      null,
      new Uint8Array(Buffer.from(claimBody(endpoint, 7, issuedAt))),
      key.privateKey,
    );
    const guard = guardWith({}, key.signer);
    const result = await guard.check({
      fid: 7,
      signer: key.signer,
      signature: signature.toString('base64url'),
      endpoint,
      issuedAt,
    });
    expect(result).toEqual({ ok: true });
  });

  it('binds the claim to the endpoint it was minted for', async () => {
    const key = ed25519();
    const issuedAt = 999_000;
    const signature = cryptoSign(
      null,
      new Uint8Array(
        Buffer.from(
          claimBody('https://push.example.com/send/abc', 7, issuedAt),
        ),
      ),
      key.privateKey,
    );
    const result = await guardWith({}, key.signer).check({
      fid: 7,
      signer: key.signer,
      signature: signature.toString('base64url'),
      // A different phone address: the claim cannot be replayed against it.
      endpoint: 'https://push.example.com/send/xyz',
      issuedAt,
    });
    expect(result).toMatchObject({ ok: false, reason: 'not-your-signature' });
  });

  it('refuses every forged shape, each with its own word', async () => {
    const key = ed25519();
    const endpoint = 'https://push.example.com/send/abc';
    const issue = (when: number) =>
      cryptoSign(
        null,
        new Uint8Array(Buffer.from(claimBody(endpoint, 7, when))),
        key.privateKey,
      ).toString('base64url');
    const guard = guardWith({}, key.signer);
    // Stale and future are about WHEN the claim was made.
    await expect(
      guard.check({
        fid: 7,
        signer: key.signer,
        signature: issue(1_000_000 - 11 * 60 * 1000),
        endpoint,
        issuedAt: 1_000_000 - 11 * 60 * 1000,
      }),
    ).resolves.toMatchObject({ reason: 'stale' });
    await expect(
      guard.check({
        fid: 7,
        signer: key.signer,
        signature: issue(1_000_000 + 60 * 60 * 1000),
        endpoint,
        issuedAt: 1_000_000 + 60 * 60 * 1000,
      }),
    ).resolves.toMatchObject({ reason: 'from-the-future' });
    // A bad fid, a bad key, a missing phone, a missing when.
    await expect(
      guard.check({
        fid: -1,
        signer: key.signer,
        signature: issue(999_000),
        endpoint,
        issuedAt: 999_000,
      }),
    ).resolves.toMatchObject({ reason: 'not-a-fid' });
    await expect(
      guard.check({
        fid: 7,
        signer: 'not-a-key',
        signature: issue(999_000),
        endpoint,
        issuedAt: 999_000,
      }),
    ).resolves.toMatchObject({ reason: 'not-a-key' });
    await expect(
      guard.check({
        fid: 7,
        signer: key.signer,
        signature: issue(999_000),
        endpoint: '',
        issuedAt: 999_000,
      }),
    ).resolves.toMatchObject({ reason: 'no-phone' });
    await expect(
      guard.check({
        fid: 7,
        signer: key.signer,
        signature: issue(NaN),
        endpoint,
        issuedAt: NaN,
      }),
    ).resolves.toMatchObject({ reason: 'no-when' });
    // A signature that is not the key's.
    const other = ed25519();
    const otherSig = cryptoSign(
      null,
      new Uint8Array(Buffer.from(claimBody(endpoint, 7, 999_000))),
      other.privateKey,
    ).toString('base64url');
    await expect(
      guard.check({
        fid: 7,
        signer: key.signer,
        signature: otherSig,
        endpoint,
        issuedAt: 999_000,
      }),
    ).resolves.toMatchObject({ reason: 'not-your-signature' });
    // A key the node does not list for this FID, and a key that is somebody else's.
    await expect(
      guard.check({
        fid: 7,
        signer: key.signer,
        signature: issue(999_000),
        endpoint,
        issuedAt: 999_000,
      }),
    ).resolves.toEqual({ ok: true });
    const refused = createSubscribeGuard({
      nodeGet: async () => ({
        signer: { fid: 8, key: key.signer, keyType: 1 },
      }),
      now: () => 1_000_000,
    });
    await expect(
      refused.check({
        fid: 7,
        signer: key.signer,
        signature: issue(999_000),
        endpoint,
        issuedAt: 999_000,
      }),
    ).resolves.toMatchObject({ reason: 'key-not-on-this-fid' });
    const empty = createSubscribeGuard({
      nodeGet: async () => ({}),
      now: () => 1_000_000,
    });
    await expect(
      empty.check({
        fid: 7,
        signer: key.signer,
        signature: issue(999_000),
        endpoint,
        issuedAt: 999_000,
      }),
    ).resolves.toMatchObject({ reason: 'key-not-on-this-fid' });
  });

  it('refuses when the node cannot answer: silence is not consent', async () => {
    const key = ed25519();
    const endpoint = 'https://push.example.com/send/abc';
    const signature = cryptoSign(
      null,
      new Uint8Array(Buffer.from(claimBody(endpoint, 7, 999_000))),
      key.privateKey,
    );
    const guard = guardWith(undefined);
    const result = await guard.check({
      fid: 7,
      signer: key.signer,
      signature: signature.toString('base64url'),
      endpoint,
      issuedAt: 999_000,
    });
    expect(result).toMatchObject({ ok: false, reason: 'key-not-on-this-fid' });
  });

  it('the claim name is the version, so the browser and the server cannot drift', () => {
    expect(CLAIM_VERSION).toBe('fiddy-alerts-v1');
    const endpoint = 'https://push.example.com/send/abc';
    expect(canonicalClaim({ fid: 7, endpoint, issuedAt: 5 })).toBe(
      `fiddy-alerts-v1\n7\n${endpointHash(endpoint)}\n5`,
    );
    expect(endpointHash(endpoint)).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* -------------------------------------------------------------- derive --- */

describe('deriving what happened from protocol reads only', () => {
  /**
   * A node that records every read and answers fixture pages. The RECORD is the
   * assertion material: the derivation is the shape of the questions it asks.
   */
  const fakeNode = (pages: Record<string, any>) => {
    const paths: string[] = [];
    const nodeGet = async (path: string, query: Record<string, any> = {}) => {
      const key = path;
      paths.push(
        `${path}${query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`,
      );
      return pages[key];
    };
    return { paths, nodeGet };
  };

  const farcasterSeconds = (ms: number) =>
    Math.round((ms - 1609459200000) / 1000);
  const cast = (fid: number, hash: string, at: number, text = '') => ({
    hash,
    signer: '0x',
    data: {
      fid,
      timestamp: farcasterSeconds(at),
      castAddBody: { text, parentCastId: undefined },
    },
  });
  const like = (fid: number, at: number) => ({
    hash: `0x${fid}r`,
    data: {
      fid,
      timestamp: farcasterSeconds(at),
      reactionBody: { type: 'Like', targetCastId: { hash: '0xown1' } },
    },
  });
  const follow = (fid: number, at: number) => ({
    hash: `0x${fid}f`,
    data: {
      fid,
      timestamp: farcasterSeconds(at),
      linkBody: { type: 'follow' },
    },
  });

  it('asks the node the four reads, once per FID, and names what it found', async () => {
    const { paths, nodeGet } = fakeNode({
      '/v1/castsByFid': { messages: [cast(7, '0xown1', 500)] },
      '/v1/castsByMention': {
        messages: [cast(9, '0xment', 900, 'hello @you')],
      },
      '/v1/castsByParent': { messages: [cast(9, '0xment', 900, 'hello')] },
      '/v1/reactionsByCast': { messages: [like(8, 800)] },
      '/v1/linksByTargetFid': { messages: [follow(8, 700)] },
      '/v1/userDataByFid': {
        messages: [
          {
            data: {
              fid: 8,
              userDataBody: { type: 'USER_DATA_TYPE_DISPLAY', value: 'Maya' },
            },
          },
        ],
      },
    });
    const nameOf = createNameReader({ nodeGet });
    const reader = createActivityReader({ nodeGet, nameOf });
    const items = await reader.activity(7);
    // The paths that were asked for are exactly the derivation.
    expect(
      paths.filter((entry) => entry.startsWith('/v1/castsByFid')),
    ).toHaveLength(1);
    expect(
      paths.filter((entry) => entry.startsWith('/v1/castsByMention')),
    ).toHaveLength(1);
    expect(
      paths.filter((entry) => entry.startsWith('/v1/castsByParent')),
    ).toHaveLength(1);
    expect(
      paths.filter((entry) => entry.startsWith('/v1/reactionsByCast')),
    ).toHaveLength(1);
    expect(
      paths.filter((entry) => entry.startsWith('/v1/linksByTargetFid')),
    ).toHaveLength(1);
    // The ids are the protocol's own: a cast hash, a reaction's author, a follow.
    // The mention and the reply are the SAME cast, so they collapse to one item
    // and the reply description wins.
    expect(items.map((item) => item.id).sort()).toEqual([
      'cast:0xment',
      'follow:8',
      'reaction:0xown1:8',
    ]);
    expect(new Set(items.map((item) => item.id)).size).toBe(3);
    const mentionOrReply = items.find((item) => item.id === 'cast:0xment');
    expect(mentionOrReply.kind).toBe('reply');
    // And the actor was named from the node's own user data.
    expect(items.find((item) => item.kind === 'follow').actor.name).toBe(
      'Maya',
    );
  });

  it('never reads a quote or a recast, because no read exists for them', async () => {
    const { paths, nodeGet } = fakeNode({});
    await createActivityReader({
      nodeGet,
      nameOf: async () => undefined,
    }).activity(7);
    expect(paths.join('\n')).not.toMatch(/recast|quote/i);
  });

  it('a failed read is an empty answer, never an invented activity', async () => {
    const nodeGet = async () => undefined;
    const items = await createActivityReader({
      nodeGet,
      nameOf: async () => undefined,
    }).activity(7);
    expect(items).toEqual([]);
  });

  it('ignores the reader’s own activity on their own casts', async () => {
    const { nodeGet } = fakeNode({
      '/v1/castsByFid': { messages: [cast(7, '0xown1', 500)] },
      '/v1/castsByMention': {
        messages: [cast(7, '0xself', 900, 'my own words')],
      },
      '/v1/castsByParent': { messages: [cast(7, '0xself2', 900)] },
      '/v1/reactionsByCast': { messages: [like(7, 800)] },
      '/v1/linksByTargetFid': { messages: [follow(7, 700)] },
    });
    const items = await createActivityReader({
      nodeGet,
      nameOf: async () => undefined,
    }).activity(7);
    expect(items).toEqual([]);
  });

  it('one consultation is capped: at most ten of the reader’s own casts, so 32 reads', async () => {
    const { paths, nodeGet } = fakeNode({
      '/v1/castsByFid': {
        messages: Array.from({ length: 40 }, (_, index) =>
          cast(7, `0xown${index}`, 500),
        ),
      },
      '/v1/castsByParent': { messages: [] },
      '/v1/reactionsByCast': { messages: [] },
    });
    await createActivityReader({
      nodeGet,
      nameOf: async () => undefined,
    }).activity(7);
    expect(
      paths.filter((entry) => entry.startsWith('/v1/castsByParent')),
    ).toHaveLength(10);
    expect(
      paths.filter((entry) => entry.startsWith('/v1/reactionsByCast')),
    ).toHaveLength(10);
    // castsByFid + mentions + follows + 10 + 10: the ceiling, named.
    expect(paths).toHaveLength(23);
  });
});

/* -------------------------------------------------------------- filters --- */

describe('what the loop keeps out', () => {
  const items = [
    { kind: 'like', actor: { fid: 8, name: 'Maya' } },
    { kind: 'follow', actor: { fid: 3, name: 'Hidden' } },
    { kind: 'mention', actor: { fid: 12, name: 'Kept' } },
  ];

  it('a muted FID cannot push, and the filter is the loop’s, not the copy’s', () => {
    const kept = filterMuted(items, [3]);
    expect(kept.map((item: any) => item.kind)).toEqual(['like', 'mention']);
  });

  it('a switched-off kind is not derived into pushes', () => {
    expect(
      filterKinds(items, { likes: false }).map((item: any) => item.kind),
    ).toEqual(['follow', 'mention']);
    expect(filterKinds(items, undefined).map((item: any) => item.kind)).toEqual(
      ['like', 'follow', 'mention'],
    );
  });
});

/* ----------------------------------------------------------------- loop --- */

describe('the loop', () => {
  const dirs = [];
  const stateDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fiddy-alerts-service-'));
    dirs.push(dir);
    return dir;
  };
  beforeEach(() => {
    dirs.length = 0;
  });
  afterEach(async () => {
    dirs.length = 0;
  });

  const phoneKeys = () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const jwk = publicKey.export({ format: 'jwk' });
    const p256dh = Buffer.from(
      `04${Buffer.from(String(jwk.x), 'base64url').toString('hex')}${Buffer.from(String(jwk.y), 'base64url').toString('hex')}`,
      'hex',
    ).toString('base64url');
    const auth = Buffer.from(
      new Uint8Array(
        createHash('sha256').update('auth').digest().subarray(0, 16),
      ),
    ).toString('base64url');
    return { privateKey, p256dh, auth };
  };

  it('sends nothing, says why, when the host has no push identity', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    const vapid = createVapidStore({ dir: join(dir, 'vapid') });
    const service = createAlertService({
      store,
      vapid,
      activityReader: {
        activity: async () => [
          { id: 'a', kind: 'like', at: 1, actor: { fid: 2 } },
        ],
      },
      fetchImpl: async () => {
        throw new Error('a host with no keys must not reach a phone');
      },
    });
    const result = await service.tick();
    expect(result).toEqual({ skipped: 'no-keys' });
    expect(service.stats.sent).toBe(0);
  });

  it('sends the grouped pushes, then nothing on the next tick (dedupe)', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    await store.write(7, {
      endpoint: 'https://push.example.com/send/abc',
      keys: phoneKeys(),
      createdAt: 0,
    });
    const vapid = createVapidStore({ dir: join(dir, 'vapid') });
    await vapid.ensure({ subject: 'https://fiddy.example' });

    const sent: any[] = [];
    const service = createAlertService({
      store,
      vapid,
      activityReader: {
        activity: async () => [
          {
            id: 'a',
            kind: 'like',
            at: Date.now(),
            actor: { fid: 2, name: 'Maya' },
            castHash: '0x1',
          },
        ],
      },
      fetchImpl: async (url: string, init: any) => {
        sent.push({ url, headers: init.headers, body: init.body });
        return { status: 201 };
      },
      intervalMs: 0,
    });

    const first = await service.tick();
    expect(first.sent).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://push.example.com/send/abc');
    expect(sent[0].headers.authorization).toMatch(/^vapid t=/);
    expect(sent[0].headers['content-encoding']).toBe('aes128gcm');
    // The phone's key means the payload is a record the push cannot read.
    expect(sent[0].body.length).toBeGreaterThan(1);
    // The id was recorded: the next tick finds nothing new.
    const second = await service.tick();
    expect(second.sent).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('a reader who just subscribed is not buzzed about the past', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    await store.write(7, {
      endpoint: 'https://push.example.com/send/abc',
      keys: phoneKeys(),
    });
    const vapid = createVapidStore({ dir: join(dir, 'vapid') });
    await vapid.ensure({ subject: 'https://fiddy.example' });
    const service = createAlertService({
      store,
      vapid,
      activityReader: {
        // Everything here happened long before the subscription existed.
        activity: async () => [
          { id: 'old', kind: 'like', at: 1, actor: { fid: 2, name: 'Maya' } },
        ],
      },
      fetchImpl: async () => {
        throw new Error('the past must not push');
      },
    });
    const result = await service.tick();
    expect(result.sent).toBe(0);
  });

  it('deletes the subscription when the phone says it is gone', async () => {
    const dir = await stateDir();
    const store = createAlertStore({ dir });
    await store.write(7, {
      endpoint: 'https://push.example.com/send/abc',
      keys: phoneKeys(),
      createdAt: 0,
    });
    const vapid = createVapidStore({ dir: join(dir, 'vapid') });
    await vapid.ensure({ subject: 'https://fiddy.example' });
    const service = createAlertService({
      store,
      vapid,
      activityReader: {
        activity: async () => [
          { id: 'a', kind: 'like', at: Date.now(), actor: { fid: 2 } },
        ],
      },
      fetchImpl: async () => ({ status: 410 }),
      intervalMs: 0,
    });
    await service.tick();
    await expect(store.read(7)).resolves.toBeUndefined();
    expect(service.stats.gone).toBe(1);
  });
});
