/**
 * A feed page is answered BEFORE its engagement counts are read, and the
 * counts land afterwards.
 *
 * THE MEASUREMENT THIS PINS (2026-10-22, live release, 390px, cold, from the
 * client's own request timeline): the feed's page read finished at 7.9 s and
 * the first cast painted at 13.4 s. The 5.5 s in between was the per-cast count
 * wave — 60 `reactionsByCast` + 37 `userDataByFid` + 35 `linkById` +
 * 10 `castsByParent` + 6 `castById` — whose last read ended 170 ms before the
 * paint, because every cast was built `withCounts: true` and the client
 * resolves a feed page once. So the page cannot paint until the slowest count
 * on it has answered.
 *
 * What has to stay true, and what these tests are for:
 *
 *   1. `readFeed({ onCounts })` resolves while count reads are STILL IN FLIGHT.
 *      (Held, not merely slow: a fake node that answers instantly could not
 *      tell the two apart.)
 *   2. That page carries no count claims at all — `reactions` / `recasts`
 *      absent, never `0`, because a 0 nobody counted is a lie the UI renders.
 *   3. The counts do arrive, for every cast on the page, in BOTH directions
 *      (like AND recast — the recast count is rendered too, `CastDetails`).
 *   4. They are the same numbers the page would have carried had it waited
 *      (`withCounts: true`), so "behind" is a scheduling change and not a
 *      different answer.
 *   5. A count whose read FAILED is left out rather than answered with 0.
 *   6. Without a sink the page carries its counts exactly as before — the
 *      mechanism is opt-in by the caller that can render a late count.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { type CastCounts, NodeBackedReads } from '~/snapchain/nodeApi';
import {
  createEmbedCardResolver,
  type EmbedCardResolver,
} from '~/snapchain/nodeApi/embedCards';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch, TERMINAL_PAGE_TOKEN } from './fakeNodeFetch';

const NODE = 'http://node.test';

/** The node's answer for a cast with no reactions at all. */
const emptyCountPage = () =>
  new Response(
    JSON.stringify({ messages: [], nextPageToken: TERMINAL_PAGE_TOKEN }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** The card resolver a test uses: it asks nothing, and says so. */
const offlineEmbedCards = (): EmbedCardResolver =>
  createEmbedCardResolver({
    storage: null,
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

/**
 * The recorded node, with `/v1/reactionsByCast` answered by `counts` — the one
 * route these tests are about. The recorded pages are one page each, so the
 * counts a cast comes back with are those of the fixture.
 */
const nodeFetch = ({
  log,
  counts,
}: {
  log?: string[];
  /** Stands in for the node's count route, or holds it. */
  counts?: (input: string) => Promise<Response> | Response;
} = {}) => {
  const fixture = createFixtureNodeFetch({
    log,
    // The viewer's own reaction log: an explicit empty answer, which is a real
    // answer and therefore a cacheable one (see feedPageReads.test.ts).
    fallback: (request) =>
      request.path === '/v1/reactionsByFid'
        ? { messages: [], nextPageToken: TERMINAL_PAGE_TOKEN }
        : undefined,
  });

  return (async (input: string, init?: RequestInit) => {
    const path = new URL(input, NODE).pathname;
    if (path === '/v1/reactionsByCast' && counts) {
      log?.push(`${path} (held)`);
      return await counts(input);
    }
    return await fixture(input, init);
  }) as unknown as typeof fetch;
};

const readerFor = (fetchImpl: typeof fetch) =>
  new NodeBackedReads({
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

const readHomeFeed = (
  reads: NodeBackedReads,
  onCounts?: (counts: CastCounts[]) => void,
) =>
  reads.readFeed({
    feedKey: 'home',
    updateState: false,
    ...(onCounts ? { onCounts } : {}),
  });

describe('a feed page is answered before its counts', () => {
  it('resolves while the count reads are still in flight', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const reads = readerFor(
      nodeFetch({
        counts: async () => {
          await held;
          return emptyCountPage();
        },
      }),
    );

    const seen: CastCounts[][] = [];
    const page = await readHomeFeed(reads, (counts) => seen.push(counts));

    // The page is here, and NOT ONE count has been read yet: this is the whole
    // point — the slowest count on the page is no longer part of the paint.
    expect(page.items.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(0);

    release();
    await expect.poll(() => seen.length, { timeout: 5_000 }).toBe(1);
  });

  it('claims no count it has not read', async () => {
    const reads = readerFor(nodeFetch());
    const page = await readHomeFeed(reads, () => {});

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      // Absent, not zero: `0` would render as "no likes", which nobody read.
      expect(item.cast.reactions).toBeUndefined();
      expect(item.cast.recasts).toBeUndefined();
    }
  });

  it('hands the page its counts afterwards, both directions, for every cast', async () => {
    const reads = readerFor(nodeFetch());
    const seen: CastCounts[][] = [];
    const page = await readHomeFeed(reads, (counts) => seen.push(counts));

    await expect.poll(() => seen.length, { timeout: 5_000 }).toBe(1);
    const counts = seen[0]!;
    const hashes = [
      ...new Set(page.items.map((item) => item.cast.hash)),
    ].sort();

    expect(counts.map((count) => count.hash).sort()).toEqual(hashes);
    // BOTH directions: a recast count is rendered too (`CastDetails`,
    // `Recasts`), so deferring only likes would leave a number that never
    // arrives.
    for (const entry of counts) {
      expect(entry.reactions.count).toBeGreaterThan(0);
      expect(entry.recasts.count).toBeGreaterThan(0);
    }
  });

  it('reads the same numbers the page would have carried had it waited', async () => {
    const waited = await readHomeFeed(readerFor(nodeFetch()));
    const behind: CastCounts[][] = [];
    const early = await readHomeFeed(readerFor(nodeFetch()), (counts) =>
      behind.push(counts),
    );
    await expect.poll(() => behind.length, { timeout: 5_000 }).toBe(1);

    const waitedByHash = new Map(
      waited.items.map((item) => [
        item.cast.hash,
        {
          reactions: item.cast.reactions?.count ?? null,
          recasts: item.cast.recasts?.count ?? null,
        },
      ]),
    );

    expect(behind[0]!.length).toBeGreaterThan(0);
    for (const entry of behind[0]!) {
      expect(waitedByHash.get(entry.hash)).toEqual({
        reactions: entry.reactions.count,
        recasts: entry.recasts.count,
      });
    }
    // And the page that waited really did carry counts, or the comparison
    // above would be satisfied by two empty answers.
    for (const counts of waitedByHash.values()) {
      expect(counts.reactions).not.toBeNull();
    }
    // The same casts, read the same way, from both paths.
    expect(early.items.length).toBe(waited.items.length);
  });

  it('leaves out a count whose read failed instead of answering 0', async () => {
    const reads = readerFor(
      nodeFetch({
        counts: () => new Response('nope', { status: 500 }),
      }),
    );

    const seen: CastCounts[][] = [];
    const page = await readHomeFeed(reads, (counts) => seen.push(counts));

    await expect.poll(() => seen.length, { timeout: 5_000 }).toBe(1);
    // Nothing was read, so nothing is claimed: the page keeps casts with no
    // counts and the sink is handed an empty pass rather than zeroes.
    expect(seen[0]).toEqual([]);
    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.cast.reactions).toBeUndefined();
    }
  });

  it('carries its counts in the page when no sink is registered', async () => {
    const reads = readerFor(nodeFetch());
    const page = await readHomeFeed(reads);

    expect(page.items.length).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.cast.reactions?.count).toBeGreaterThan(0);
      expect(item.cast.recasts?.count).toBeGreaterThan(0);
    }
  });

  it('does not re-read a count another pass already read', async () => {
    const log: string[] = [];
    const reads = readerFor(nodeFetch({ log }));

    const first = await reads.readCastCounts({
      targets: [{ fid: 3, hash: '0xfirst' }],
    });
    const afterFirst = log.filter((entry) =>
      entry.startsWith('/v1/reactionsByCast'),
    ).length;
    expect(first).toHaveLength(1);
    expect(afterFirst).toBeGreaterThan(0);

    await reads.readCastCounts({ targets: [{ fid: 3, hash: '0xfirst' }] });
    // The same count, asked again: `countCache` answers it. This is what makes
    // the second pass cheap for casts another surface has already counted.
    expect(
      log.filter((entry) => entry.startsWith('/v1/reactionsByCast')).length,
    ).toBe(afterFirst);
  });
});
