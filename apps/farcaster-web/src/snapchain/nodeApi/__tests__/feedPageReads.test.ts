/**
 * What a page read costs BEHIND the casts it already has, measured on the
 * adapter's own request log.
 *
 * THE MEASUREMENT (2026-10-22, the live client, box load ~11, cold sign-in to
 * fiddy.fun): the feed's first page of casts was in hand by 8.8s, the first cast
 * painted at 17.4s, and the eight seconds in between were three page-level
 * questions asked ONE AFTER ANOTHER, each with its own bounded wait:
 *
 *   - `classifyEmbeds`  (bounded probes of pages this client does not own, up to
 *     1.5s + 2s),
 *   - `resolveMentionUsers`,
 *   - `viewerReactionHashes` — `/v1/reactionsByFid` at `pageSize: 1000`, which
 *     the node answers with 2000 messages: those two requests only STARTED at
 *     12.6s and each took 5.3s.
 *
 * Nothing about any one of them depends on the others, so these tests pin the
 * two things that were actually wrong: they run AT ONCE, and the viewer's own
 * reaction logs are read once per session rather than once per read.
 *
 * A future change that serialises the page again, or that re-reads the viewer's
 * whole like history for every page, goes red here rather than slow on the feed.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { createNodeBackedFetch, NodeBackedReads } from '~/snapchain/nodeApi';
import {
  createEmbedCardResolver,
  type EmbedCardResolver,
} from '~/snapchain/nodeApi/embedCards';
import type { EmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch, TERMINAL_PAGE_TOKEN } from './fakeNodeFetch';

const FEED_ITEMS_URL = 'https://farcaster.xyz/~api/v2/feed-items';
const NODE = 'http://node.test';

const feedItemsRequest = () => ({
  method: 'POST',
  body: JSON.stringify({
    feedKey: 'home',
    feedType: 'default',
    updateState: true,
  }),
});

/** The card resolver a test uses: it asks nothing, and says so. */
const offlineEmbedCards = (): EmbedCardResolver =>
  createEmbedCardResolver({
    storage: null,
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

const readerFor = (log: string[]) => {
  const fetchImpl = createFixtureNodeFetch({
    log,
    // The viewer's own reaction log: not one of the recorded pages, so the fake
    // answers it explicitly — an empty log, which is a real answer and therefore
    // a cacheable one. (A read the node FAILS is deliberately not remembered;
    // see `viewerReactionHashes`.)
    fallback: (request) =>
      request.path === '/v1/reactionsByFid'
        ? { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN }
        : undefined,
  });
  return new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: NODE,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl: NODE,
    fetchImpl,
    embedKinds: offlineEmbedKinds(),
    embedCards: offlineEmbedCards(),
    getSignedInFid: () => 3,
  });
};

const reactionReads = (log: string[]) =>
  log.filter((entry) => entry.startsWith('/v1/reactionsByFid'));

describe('the page-level reads are asked together', () => {
  it('does not wait for the embed probes before the viewer’s reaction log', async () => {
    const nodeLog: string[] = [];
    let releaseEmbeds = () => {};
    const embedsHeld = new Promise<void>((resolve) => {
      releaseEmbeds = resolve;
    });

    /**
     * An embed classifier that answers only when this test says so — the shape
     * of the live slow case (a page this client is not allowed to read, probed
     * to its own deadline), without a network and without the wait.
     */
    const heldEmbeds: EmbedKindResolver = {
      kindOf: () => undefined,
      classify: async () => {
        await embedsHeld;
      },
      settle: async () => {},
    };

    const handle = createNodeBackedFetch({
      nodeBaseUrl: NODE,
      embedKinds: heldEmbeds,
      embedCards: offlineEmbedCards(),
      getSignedInFid: () => 3,
      fetchImpl: createFixtureNodeFetch({ log: nodeLog }),
    });

    const answer = handle.fetch(FEED_ITEMS_URL, feedItemsRequest());

    // WHILE the embeds are still held, the viewer's own reaction logs must
    // already have been asked: they are an independent question about the same
    // page, not a step after the embeds.
    await expect
      .poll(() => reactionReads(nodeLog).length, { timeout: 2_000 })
      .toBeGreaterThan(0);

    releaseEmbeds();
    const response = await answer;
    expect(response.status).toBe(200);
  });
});

describe('the viewer’s own reaction log is read once', () => {
  const readHomeFeed = (reads: NodeBackedReads) =>
    reads.readFeed({ feedKey: 'home', updateState: false });

  it('answers a second page read without re-reading it', async () => {
    const log: string[] = [];
    const reads = readerFor(log);

    await readHomeFeed(reads);
    const afterFirst = reactionReads(log).length;
    expect(afterFirst).toBeGreaterThan(0);

    await readHomeFeed(reads);
    // A second read of the feed, and not one more request for the viewer's
    // whole like and recast history.
    expect(reactionReads(log).length).toBe(afterFirst);
  });

  it('reads them again after the caches are forgotten', async () => {
    const log: string[] = [];
    const reads = readerFor(log);

    await readHomeFeed(reads);
    const afterFirst = reactionReads(log).length;

    reads.clearCaches();
    await readHomeFeed(reads);

    expect(reactionReads(log).length).toBeGreaterThan(afterFirst);
  });
});
