// @vitest-environment jsdom

/**
 * A feed page this browser RESTORED asks for its counts — and asks only when
 * that is what happened.
 *
 * `~/lib/feedCache` keeps one page of `feedItems` per account and
 * `~/contexts/FeedQueryCacheProvider` restores it, so a re-open inside the
 * three-minute staleness window paints the stored page and reads nothing at all.
 * The stored page carries no engagement counts (the node-backed path builds a
 * page without them), and with no page read there is no count wave either — so
 * the wall of casts stayed numberless (measured on the live release, card
 * t_43249104: `{replies: 25}` at the paint and after it, sink never called).
 *
 * What has to stay true, and what these tests are for:
 *
 *   1. A restored page's casts are asked about — once, for the ones that have no
 *      counts — and the numbers reach the casts the feed renders.
 *   2. A page this load READ is not asked about: its fetcher already cached its
 *      casts, and its own count wave is on its way. This is the difference the
 *      whole thing turns on, and it is mechanical (the cast cache), not a timer.
 *   3. A page that carries its counts is not asked about either (a page the
 *      hosted API answered), and neither is a feed this browser never keeps.
 *   4. A restored page is not re-read: the counts are the only thing asked for,
 *      and the page's own data is left exactly as it was restored.
 *   5. Nothing is asked when there is no node to ask (the fork's mock API, or
 *      the node-backed client off) — and the pass says so rather than looking
 *      like a delivery that found nothing.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import {
  ApiCast,
  ApiCastFeedItem,
  ApiGetFeedItems200Response,
} from 'farcaster-client-data';
import {
  buildFeedItemsKey,
  buildGloballyCachedCastKey,
  useBatchMergeIntoGloballyCachedCasts,
} from 'farcaster-client-hooks';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCountsBehindSink } from '~/hooks/data/useCountsBehindSink';
import {
  askForRestoredFeedCounts,
  RestoredFeedCountsProvider,
  type RestoredFeedCountsReader,
  useRestoredFeedCounts,
} from '~/hooks/data/useRestoredFeedCounts';

const wrapper =
  (queryClient: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

/** A cast as the node-backed reader builds one a page paints before its counts:
 * `reactions` / `recasts` ABSENT, which is how "not read yet" travels. */
const castFixture = (hash: string, overrides: Partial<ApiCast> = {}): ApiCast =>
  ({
    hash,
    threadHash: hash,
    author: { fid: 3, displayName: 'dwr', followerCount: 0, followingCount: 0 },
    text: 'a cast with no counts yet',
    timestamp: 1_700_000_000_000,
    replies: { count: 0 },
    watches: { count: 0 },
    ...overrides,
  }) as ApiCast;

const feedItem = (cast: ApiCast): ApiCastFeedItem => ({
  id: cast.hash,
  timestamp: cast.timestamp,
  cast,
  otherParticipants: [],
});

/**
 * When the visit before this one read the kept page: a minute before this
 * document began. That is the stamp `hydrate` carries through unchanged
 * (`dataUpdatedAt`), and it is what tells a kept page from one read now.
 */
const RESTORED_AT = Date.now() - 60_000;

/** A page as it was written to this browser's storage: casts, no counts. */
const seedPage = ({
  queryClient,
  casts,
  feedKey = 'home',
  updatedAt = RESTORED_AT,
}: {
  queryClient: QueryClient;
  casts: ApiCast[];
  feedKey?: string;
  updatedAt?: number;
}): readonly unknown[] => {
  const key = buildFeedItemsKey({ feedKey, feedType: 'default' });
  const page = {
    result: { items: casts.map(feedItem) },
  } as ApiGetFeedItems200Response;
  queryClient.setQueryData(
    key,
    { pageParams: [undefined], pages: [page] },
    { updatedAt },
  );
  return key;
};

/** The real sink and the real cast-cache merge, exactly as the app uses them. */
const appHarness = (queryClient: QueryClient) => {
  const { result: sink } = renderHook(() => useCountsBehindSink(), {
    wrapper: wrapper(queryClient),
  });
  const { result: merge } = renderHook(
    () => useBatchMergeIntoGloballyCachedCasts(),
    { wrapper: wrapper(queryClient) },
  );
  return {
    sink: sink.current,
    batchUpdateGloballyCachedCast: merge.current,
  };
};

/** A node that answers every count it is asked for. */
const readerAnswering = (sink: RestoredFeedCountsReader['sink']) => {
  const readCounts = vi.fn(async (targets: { fid: number; hash: string }[]) =>
    targets.map(({ hash }) => ({
      hash,
      reactions: { count: 7 },
      recasts: { count: 2 },
    })),
  );
  return {
    readCounts,
    sink,
    reader: { readCounts, sink } as RestoredFeedCountsReader,
  };
};

/** How many cast-cache entries the page's casts have, and their counts. */
const cachedCast = (queryClient: QueryClient, hash: string) =>
  queryClient.getQueryData<ApiCast>(
    buildGloballyCachedCastKey({ hash, recast: false }),
  );

/** The real merge caches a page's casts in chunks on a timer (5 per 5 ms), and
 * the sink lands a count that arrived early the moment its cast appears — so a
 * pass's effect is only settled after those timers. */
const settleCastCache = () => new Promise((resolve) => setTimeout(resolve, 60));

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { __fiddyCountsBehind?: unknown }).__fiddyCountsBehind;
});

describe('a restored feed page asks for its counts', () => {
  it('reads them for the casts that have none, and lands them on the casts', async () => {
    const queryClient = new QueryClient();
    const { sink, batchUpdateGloballyCachedCast } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);
    const key = seedPage({
      queryClient,
      casts: [castFixture('0xa'), castFixture('0xb')],
    });

    const report = await askForRestoredFeedCounts({
      queryClient,
      batchUpdateGloballyCachedCast,
      reader,
    });

    expect(report).toMatchObject({
      pages: 1,
      targets: 2,
      counts: 2,
      asked: true,
    });
    // One cast per hash, addressed the way a node addresses a cast.
    expect(readCounts).toHaveBeenCalledWith([
      { fid: 3, hash: '0xa' },
      { fid: 3, hash: '0xb' },
    ]);

    await settleCastCache();

    expect(cachedCast(queryClient, '0xa')?.reactions).toEqual({ count: 7 });
    expect(cachedCast(queryClient, '0xa')?.recasts).toEqual({ count: 2 });
    expect(cachedCast(queryClient, '0xb')?.reactions).toEqual({ count: 7 });

    // The page the reader is looking at is untouched — a count lands on the
    // cast cache, never as a rewritten page (that would be a second load).
    const page = queryClient.getQueryData<
      { pages: ApiGetFeedItems200Response[] } | ApiGetFeedItems200Response
    >(key);
    expect(
      (page as { pages: ApiGetFeedItems200Response[] }).pages[0]!.result
        .items[0]!.cast.reactions,
    ).toBeUndefined();
  });

  it('asks about the casts with no counts and leaves a counted one alone', async () => {
    const queryClient = new QueryClient();
    const { sink, batchUpdateGloballyCachedCast } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);
    seedPage({
      queryClient,
      casts: [
        castFixture('0xcounted', {
          reactions: { count: 4 },
          recasts: { count: 1 },
        }),
        castFixture('0xbare'),
      ],
    });

    const report = await askForRestoredFeedCounts({
      queryClient,
      batchUpdateGloballyCachedCast,
      reader,
    });

    expect(report).toMatchObject({ targets: 1, asked: true });
    expect(readCounts).toHaveBeenCalledWith([{ fid: 3, hash: '0xbare' }]);
  });

  it('leaves a page THIS document read alone: its own wave is on its way', async () => {
    const queryClient = new QueryClient();
    const { sink, batchUpdateGloballyCachedCast } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);
    // Read now: the data is stamped with this document's own moment, which is the
    // difference `hydrate` preserves — a kept page is always older than this one.
    seedPage({
      queryClient,
      casts: [castFixture('0xread'), castFixture('0xread2')],
      updatedAt: Date.now(),
    });

    const report = await askForRestoredFeedCounts({
      queryClient,
      batchUpdateGloballyCachedCast,
      reader,
    });

    expect(report).toEqual({ pages: 0, targets: 0, counts: 0, asked: false });
    expect(readCounts).not.toHaveBeenCalled();
  });

  it('leaves a cast whose counts are already cached alone', async () => {
    const queryClient = new QueryClient();
    const { sink, batchUpdateGloballyCachedCast } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);
    // A kept page whose first cast another surface in this document has already
    // read — with its counts. That number is on screen; asking again is a read
    // for something this browser has.
    queryClient.setQueryData(
      buildGloballyCachedCastKey({ hash: '0xknown', recast: false }),
      castFixture('0xknown', {
        reactions: { count: 5 },
        recasts: { count: 1 },
      }),
    );
    seedPage({
      queryClient,
      casts: [castFixture('0xknown'), castFixture('0xunknown')],
    });

    const report = await askForRestoredFeedCounts({
      queryClient,
      batchUpdateGloballyCachedCast,
      reader,
    });

    expect(report).toMatchObject({ targets: 1, asked: true });
    expect(readCounts).toHaveBeenCalledWith([{ fid: 3, hash: '0xunknown' }]);
  });

  it('leaves a page whose own read is in flight alone', async () => {
    const queryClient = new QueryClient();
    const { sink, batchUpdateGloballyCachedCast } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);
    const key = seedPage({ queryClient, casts: [castFixture('0xinFlight')] });

    // A re-read of the same page, still running: react-query keeps the restored
    // data and reports the query as fetching, and that read has a count wave of
    // its own.
    void queryClient.fetchQuery({
      queryKey: key,
      queryFn: () => new Promise(() => {}),
      staleTime: 0,
    });

    const report = await askForRestoredFeedCounts({
      queryClient,
      batchUpdateGloballyCachedCast,
      reader,
    });

    expect(report.asked).toBe(false);
    expect(readCounts).not.toHaveBeenCalled();
  });

  it('leaves a page that carries its counts alone (a page the hosted API answered)', async () => {
    const queryClient = new QueryClient();
    const { sink, batchUpdateGloballyCachedCast } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);
    seedPage({
      queryClient,
      casts: [
        castFixture('0xfull', {
          reactions: { count: 9 },
          recasts: { count: 3 },
        }),
      ],
    });

    const report = await askForRestoredFeedCounts({
      queryClient,
      batchUpdateGloballyCachedCast,
      reader,
    });

    expect(report.asked).toBe(false);
    expect(readCounts).not.toHaveBeenCalled();
  });

  it('looks only at the feeds this browser keeps', async () => {
    const queryClient = new QueryClient();
    const { sink, batchUpdateGloballyCachedCast } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);
    // A channel feed is read on every visit and never kept (`~/lib/feedCache`),
    // so a page of one in the cache was read now — and it is not this pass's.
    seedPage({
      queryClient,
      feedKey: 'channel-farcaster',
      casts: [castFixture('0xchannel')],
    });

    const report = await askForRestoredFeedCounts({
      queryClient,
      batchUpdateGloballyCachedCast,
      reader,
    });

    expect(report.asked).toBe(false);
    expect(readCounts).not.toHaveBeenCalled();
  });

  it('says it asked nothing when the build has no node-backed client', async () => {
    const queryClient = new QueryClient();
    const { batchUpdateGloballyCachedCast } = appHarness(queryClient);
    seedPage({ queryClient, casts: [castFixture('0xnoNode')] });

    const report = await askForRestoredFeedCounts({
      queryClient,
      batchUpdateGloballyCachedCast,
      reader: null,
    });

    // The page was found — and no node could be asked. Not a silent nothing.
    expect(report).toEqual({ pages: 1, targets: 0, counts: 0, asked: false });
  });
});

describe('the pass the app calls', () => {
  const readerWrapper =
    (queryClient: QueryClient, reader: RestoredFeedCountsReader) =>
    ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RestoredFeedCountsProvider reader={reader}>
          {children}
        </RestoredFeedCountsProvider>
      </QueryClientProvider>
    );

  /** Long enough for the pass's coalesced microtask, and no longer. */
  const settlePass = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('is the one that reads the restored page, through the reader it is given', async () => {
    const queryClient = new QueryClient();
    const { sink } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);
    seedPage({ queryClient, casts: [castFixture('0xwired')] });

    const { result } = renderHook(() => useRestoredFeedCounts(), {
      wrapper: readerWrapper(queryClient, reader),
    });

    const report = await result.current();

    expect(report).toMatchObject({ pages: 1, targets: 1, asked: true });
    expect(readCounts).toHaveBeenCalledWith([{ fid: 3, hash: '0xwired' }]);
  });

  it('asks when the kept page arrives AFTER the pass has already run', async () => {
    // MEASURED on a warm re-open (this card, local node-backed build): the kept
    // page is hydrated into the query cache BEFORE the feed's own query exists, so
    // a pass that only looked at the restore moment found nothing to ask about —
    // on every warm load. The pass watches the cache instead, so the page is
    // asked about wherever it lands.
    const queryClient = new QueryClient();
    const { sink } = appHarness(queryClient);
    const { readCounts, reader } = readerAnswering(sink);

    renderHook(() => useRestoredFeedCounts(), {
      wrapper: readerWrapper(queryClient, reader),
    });
    // Nothing kept is in the cache yet: this is the mount run finding nothing.
    await settlePass();
    expect(readCounts).not.toHaveBeenCalled();

    // The feed mounts a moment later and finds the page this browser kept.
    seedPage({ queryClient, casts: [castFixture('0xlate')] });
    await settlePass();

    expect(readCounts).toHaveBeenCalledWith([{ fid: 3, hash: '0xlate' }]);
  });
});
