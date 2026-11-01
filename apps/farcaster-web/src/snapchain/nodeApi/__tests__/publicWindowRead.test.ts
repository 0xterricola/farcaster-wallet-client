/**
 * The public window, read with NO session, from a fake node.
 *
 * This is the read the browse surface depends on, and the two things that make
 * it different from every other read in `reads.ts` are exactly what is pinned
 * here:
 *
 *   1. it never asks who is signed in. A node assembles a follow graph from
 *      *someone's* link messages, and the someone is a set of named public
 *      accounts (`publicFeedWindow.ts`), not the viewer. A version of this that
 *      reached for `requireFid()` would throw for every visitor the surface
 *      exists for, so the reader here is built with `getSignedInFid: () =>
 *      undefined` and must still answer.
 *   2. it answers real casts, newest first, and says nothing at all when it
 *      cannot read (an empty window, never an invented one).
 *
 * The fake node is the repo's own fixture fetch (`./fakeNodeFetch`), so the
 * pages it serves are decoded as real node JSON; the accounts and casts under
 * test are stated by the fallback, because the recorded fixture is one
 * account's (fid 3) and a window is by definition several.
 */

import { type ApiCastFeedItem } from 'farcaster-client-data';
import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { NodeBackedReads } from '~/snapchain/nodeApi';
import { createEmbedCardResolver } from '~/snapchain/nodeApi/embedCards';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch, TERMINAL_PAGE_TOKEN } from './fakeNodeFetch';

const NODE = 'http://node.test';

/** The protocol's own clock starts here: 2021-01-01, in unix milliseconds. */
const FC_EPOCH_MS = 1609459200000;

/** The anchors as this test resolves them: one distinct FID per name. */
const ANCHORS: Record<string, number> = {
  dwr: 3,
  farcaster: 20,
  jacek: 21,
  linda: 22,
  samantha: 23,
};

/** The accounts those anchors follow: the window's authors. */
const FOLLOWED = [40, 41, 42];

const HASH = (letter: string) => `0x${letter.repeat(40)}`;

const rawCast = ({
  fid,
  hash,
  seconds,
  text,
  parentUrl = null,
}: {
  fid: number;
  hash: string;
  seconds: number;
  text: string;
  parentUrl?: string | null;
}) => ({
  data: {
    type: 'MESSAGE_TYPE_CAST_ADD',
    fid,
    timestamp: seconds,
    network: 'FARCASTER_NETWORK_MAINNET',
    castAddBody: {
      embedsDeprecated: [],
      mentions: [],
      parentCastId: null,
      parentUrl,
      text,
      embeds: [],
      mentionsPositions: [],
      type: 'CAST',
    },
  },
  hash,
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: 'c2ln',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: '0x0',
});

const rawFollow = ({
  fid,
  targetFid,
  seconds,
}: {
  fid: number;
  targetFid: number;
  seconds: number;
}) => ({
  data: {
    type: 'MESSAGE_TYPE_LINK_ADD',
    fid,
    timestamp: seconds,
    network: 'FARCASTER_NETWORK_MAINNET',
    linkBody: { type: 'follow', displayTimestamp: null, targetFid },
  },
  hash: HASH('e'),
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: 'c2ln',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: '0x0',
});

const page = (messages: unknown[]) => ({
  messages,
  nextPageToken: TERMINAL_PAGE_TOKEN,
});

/** Three authors, three casts, two channels, oldest-to-newest 5000/7000/9000. */
const CASTS: Record<number, unknown[]> = {
  40: [
    rawCast({
      fid: 40,
      hash: HASH('a'),
      seconds: 5000,
      text: 'dev one',
      parentUrl: 'https://warpcast.com/~/channel/dev',
    }),
  ],
  41: [rawCast({ fid: 41, hash: HASH('b'), seconds: 9000, text: 'newest' })],
  42: [
    rawCast({
      fid: 42,
      hash: HASH('c'),
      seconds: 7000,
      text: 'base one',
      parentUrl: 'https://warpcast.com/~/channel/base',
    }),
  ],
};

const offlineEmbedCards = () =>
  createEmbedCardResolver({
    storage: null,
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

/**
 * A node that answers the window's reads and nothing else: the anchors' names,
 * the accounts each anchor follows, and those accounts' casts.
 */
const windowFetch = ({
  log,
  anchors = ANCHORS,
}: {
  log?: string[];
  anchors?: Record<string, number>;
}) =>
  createFixtureNodeFetch({
    ...(log ? { log } : {}),
    fallback: ({ path, params }) => {
      if (path === '/v1/userNameProofByName') {
        const name = params.get('name') ?? '';
        const fid = anchors[name];
        return fid === undefined
          ? undefined
          : {
              timestamp: 1,
              name,
              owner: '0x0',
              signature: 'c2ln',
              fid,
              type: 'USERNAME_TYPE_FNAME',
            };
      }
      if (path === '/v1/linksByFid') {
        const fid = Number(params.get('fid'));
        return page(
          FOLLOWED.map((targetFid, index) =>
            rawFollow({ fid, targetFid, seconds: 1000 + index }),
          ),
        );
      }
      if (path === '/v1/castsByFid') {
        const fid = Number(params.get('fid'));
        return page(CASTS[fid] ?? []);
      }
      return undefined;
    },
  });

/** The reader under test, with nobody signed in: the whole point. */
const signedOutReader = (fetchImpl: typeof fetch) =>
  new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: NODE,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl: NODE,
    fetchImpl,
    embedKinds: offlineEmbedKinds(),
    embedCards: offlineEmbedCards(),
    getSignedInFid: () => undefined,
  });

describe('a window read with no account at all', () => {
  it('answers real casts, newest first, from the anchors’ follows', async () => {
    const log: string[] = [];
    const reads = signedOutReader(windowFetch({ log }));

    const result = await reads.readPublicFeed({ kind: 'recent' });

    expect(result.items.map((item: ApiCastFeedItem) => item.cast.text)).toEqual(
      ['newest', 'base one', 'dev one'],
    );
    expect(
      result.items.map((item: ApiCastFeedItem) => item.cast.author.fid),
    ).toEqual([41, 42, 40]);

    // The two reads a public window is assembled from, and no name unresolved.
    expect(
      log.some((entry) => entry.startsWith('/v1/userNameProofByName')),
    ).toBe(true);
    expect(log.some((entry) => entry.startsWith('/v1/linksByFid'))).toBe(true);
    expect(log.some((entry) => entry.startsWith('/v1/castsByFid'))).toBe(true);
  });

  it('narrows to a topic, and keeps the rest out', async () => {
    const reads = signedOutReader(windowFetch({}));

    const result = await reads.readPublicFeed({ kind: 'recent', topic: 'dev' });

    expect(result.items.map((item: ApiCastFeedItem) => item.cast.text)).toEqual(
      ['dev one'],
    );
  });

  it('walks back through the window when an older slice is asked for', async () => {
    const reads = signedOutReader(windowFetch({}));

    // `olderThan` is a wall-clock millisecond time: the protocol's own seconds
    // are counted from 2021-01-01, and the reader compares against
    // `timestampMs`, which the node client already puts on the unix clock.
    const result = await reads.readPublicFeed({
      kind: 'recent',
      olderThan: FC_EPOCH_MS + 8000 * 1000,
    });

    expect(result.items.map((item: ApiCastFeedItem) => item.cast.text)).toEqual(
      ['base one', 'dev one'],
    );
  });

  it('answers an empty window, not an error, when nothing can be read', async () => {
    // A node that will not answer at all: the anchors cannot be resolved, so
    // there is no window to assemble. The honest answer is nothing, and the
    // surface has an empty state for it.
    const reads = signedOutReader((async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch);

    const result = await reads.readPublicFeed({ kind: 'recent' });

    expect(result.items).toEqual([]);
    expect(typeof result.latestMainCastTimestamp).toBe('number');
  });

  it('ranks the same window by engagement when it is asked to', async () => {
    const reads = signedOutReader(windowFetch({}));

    const result = await reads.readPublicFeed({ kind: 'trending' });

    // Same casts, same count of them: the ranking itself is pinned by the
    // window's own unit tests (`publicFeedWindow.test.ts`), which can state
    // counts the fake node would otherwise have to invent.
    expect(result.items).toHaveLength(3);
    expect(
      new Set(
        result.items.map((item: ApiCastFeedItem) => item.cast.author.fid),
      ),
    ).toEqual(new Set(FOLLOWED));
  });
});
