import {
  InfiniteData,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ApiCast,
  ApiCastFeedItem,
  ApiGetFeedItems200Response,
} from 'farcaster-client-data';
import {
  BatchMergeIntoGloballyCachedCasts,
  buildGloballyCachedCastKey,
  useBatchMergeIntoGloballyCachedCasts,
} from 'farcaster-client-hooks';
import React, {
  createContext,
  FC,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
} from 'react';

import { PERSISTED_FEED_KEYS } from '~/lib/feedCache';
import type {
  CastCounts,
  CastCountsSink,
  CastCountsTarget,
} from '~/snapchain/nodeApi/reads';

/**
 * The counts of a feed page this browser RESTORED, asked for the moment the page
 * is back on screen.
 *
 * WHY THIS EXISTS (card t_43249104)
 *
 * `~/lib/feedCache` keeps one page of `feedItems` per account for a day, and
 * `~/contexts/FeedQueryCacheProvider` restores it on mount — so a re-open inside
 * the three-minute staleness window paints the stored page and issues no feed
 * read at all. The stored page was written by the node-backed path, which builds
 * a page WITHOUT its engagement counts (`nodeApi/reads.ts` `readFeed`,
 * `withCounts: onCounts === undefined`): the numbers were never in the blob, and
 * with no page read there is no count pass either — no `readFeed`, no
 * `startCountsBehind`, no counts, ever.
 *
 * MEASURED on the live release (2026-10-23, 390px, warm re-open after a cold
 * sign-in, 2/2 runs): the warm page painted `{replies: 25}` and was still
 * `{replies: 25}` after the wait — no likes, no recasts — with the counts sink
 * never called once (`warmCountsAfterPaintMs: null`, `warmSink: null`). Nothing
 * about that was a race: the page simply never asked.
 *
 * WHAT THIS DOES: the restored page asks. The casts it restored are read from a
 * node (`readCounts`, i.e. the seam's `readCastCounts`) and handed to the same
 * sink a page's own count wave uses (`~/hooks/data/useCountsBehindSink`), so the
 * numbers land on the casts already on screen. No page is re-read — which is the
 * whole point of keeping one: a page read costs the follow graph and every
 * author, mention and embed read on it, and the counts are the only part that was
 * missing.
 *
 * HOW A RESTORED PAGE IS TOLD FROM A PAGE THIS DOCUMENT READ — and why it is
 * not "the moment the restore finished"
 *
 * MEASURED, locally served node-backed build, 390px, warm re-open (this card):
 * a pass run at the instant the restore promise settles finds NOTHING to ask
 * about — the feed's own query does not exist yet. The order is: the app learns
 * the account, the persister is installed, the kept page is hydrated into the
 * query cache, and only THEN does the feed mount and find it. A pass that only
 * looks at that moment misses the page it is for, on every warm load.
 *
 * So the test is a stamp react-query already keeps: WHEN THE DATA LANDED.
 * `dehydrateQuery` persists a query's whole state and `hydrate` restores it
 * unchanged (`@tanstack/query-core` `hydration`), so a page restored from this
 * browser's storage carries the `dataUpdatedAt` of the load that read it — always
 * older than this document — while a page read in this document is stamped at or
 * after the moment it began. That is a fact about the page, it holds wherever the
 * page is when the pass looks, and it cannot be confused with a timer.
 *
 * The pass therefore runs on the query cache's own events (a kept page arriving
 * in the cache is a hydrate) as well as on mount, and asks about every kept page
 * whose data predates this document. A page read now is skipped because its OWN
 * count wave is already on its way (`readFeed` with the sink), and a cast whose
 * counts are already in the cast cache is skipped because that read would be a
 * second one for a number already on screen.
 */

/** The query family this is about, as `buildFeedItemsKey` writes it. */
const FEED_ITEMS_QUERY_HEAD = 'feedItems';

/**
 * When this document began — a kept page's `dataUpdatedAt` is older than this,
 * and a page read now is not (see the header).
 */
const LOAD_STARTED_AT = Date.now();

/**
 * What the app registers so a restored page can ask: where its counts are read
 * from, and where they go when they land.
 */
export type RestoredFeedCountsReader = {
  readCounts: (targets: CastCountsTarget[]) => Promise<CastCounts[]>;
  sink: CastCountsSink;
};

/** What one pass found and did — enough for a test to pin, nothing to interpret. */
export type RestoredFeedCountsReport = {
  /** Restored pages whose counts were missing. */
  pages: number;
  /** The casts those pages asked about. */
  targets: number;
  /** Counts the node answered with; a count it could not read is left out. */
  counts: number;
  /** False when there was nothing to ask, or no node-backed seam to ask with. */
  asked: boolean;
};

/**
 * Has this cast's counts been read?
 *
 * `ApiCast`'s own rule: `reactions` / `recasts` absent means NOT READ YET, and a
 * page painted before its counts is exactly that page. `0` would be a claim
 * nobody made, so it is never written — see the type's own comment.
 */
const countsRead = (cast: ApiCast): boolean =>
  cast.reactions !== undefined && cast.recasts !== undefined;

/**
 * Every cast a page renders, in the shape `buildFeedItemsFetcher` caches them
 * (the item's cast, its reply previews, and the previews hanging off it).
 *
 * Mirrored deliberately: the restore does what the read would have done with the
 * page, so a cast on screen is in the cast cache whichever way the page arrived.
 */
const castsOfPage = (items: ApiCastFeedItem[]): ApiCast[] => {
  const casts: ApiCast[] = [];
  for (const item of items) {
    casts.push(item.cast);
    item.replies?.forEach((reply) => casts.push(reply));
    item.cast.replies.casts?.forEach((reply) => casts.push(reply));
  }
  return casts;
};

/** Is this a query about a feed this browser keeps (`~/lib/feedCache`)? */
const isKeptFeedItemsKey = (queryKey: readonly unknown[]): boolean => {
  const [head, feedKey] = queryKey;
  return (
    head === FEED_ITEMS_QUERY_HEAD &&
    typeof feedKey === 'string' &&
    PERSISTED_FEED_KEYS.has(feedKey)
  );
};

/** A page that was restored, and the casts on it that have no counts yet. */
type RestoredPage = {
  /** Everything the page renders, for the cast cache. */
  casts: ApiCast[];
  /** The casts whose counts are missing — what the node is asked about. */
  targets: CastCountsTarget[];
};

/** The first page's items, or `undefined` for a page that has none. */
const firstPageItems = (
  data: InfiniteData<ApiGetFeedItems200Response> | undefined,
): ApiCastFeedItem[] | undefined => {
  const page = data?.pages?.[0];
  if (page === null || page === undefined) {
    return undefined;
  }
  const items = page.result.items;
  return items.length === 0 ? undefined : items;
};

/**
 * The casts of a page it was restored with, when that page's counts are missing.
 *
 * `null` for anything that is not a restored page needing counts: a page this
 * load READ (its fetcher already cached its casts — see the header) and a page
 * that carries its counts (a page the hosted API answered) are both nothing to
 * do.
 */
const restoredPageNeedingCounts = ({
  queryClient,
  items,
}: {
  queryClient: QueryClient;
  items: ApiCastFeedItem[];
}): RestoredPage | null => {
  const casts = castsOfPage(items);
  const targets: CastCountsTarget[] = [];
  const seen = new Set<string>();

  for (const cast of casts) {
    if (countsRead(cast)) {
      continue;
    }
    const fid = cast.author?.fid;
    if (typeof fid !== 'number') {
      continue;
    }
    const key = `${fid}:${cast.hash}`;
    if (seen.has(key)) {
      continue;
    }
    // Counts already in the cast cache are counts already on screen: a read for
    // them again would be a second read for a number this browser has. A cast
    // cached WITHOUT them (the shape a page read leaves behind) is still asked
    // about — but that page's own wave is what usually fills it, which is why a
    // page read in this document is skipped before this loop is reached.
    const cached = queryClient.getQueryData<ApiCast>(
      buildGloballyCachedCastKey({ hash: cast.hash, recast: !!cast.recast }),
    );
    if (cached !== undefined && countsRead(cached)) {
      continue;
    }
    seen.add(key);
    targets.push({ fid, hash: cast.hash });
  }

  return targets.length === 0 ? null : { casts, targets };
};

/** The kept feed pages in the cache that were restored and have no counts. */
const restoredPagesNeedingCounts = ({
  queryClient,
}: {
  queryClient: QueryClient;
}): RestoredPage[] => {
  const pages: RestoredPage[] = [];
  for (const query of queryClient.getQueryCache().getAll()) {
    // Only a KEPT feed can be restored (`~/lib/feedCache` is the list), so only
    // those are looked at — a channel feed is read on every visit and never kept.
    if (!isKeptFeedItemsKey(query.queryKey)) {
      continue;
    }
    // A page whose own read is in flight has a count wave of its own: asking
    // again would be a second pass for the same hashes. And a page read in THIS
    // document is not a restored page at all — its data is stamped at or after
    // the moment this document began (`hydrate` carries the writing load's stamp
    // through unchanged), and its counts are already on the way.
    if (
      query.state.fetchStatus !== 'idle' ||
      query.state.dataUpdatedAt >= LOAD_STARTED_AT
    ) {
      continue;
    }
    const items = firstPageItems(
      query.state.data as InfiniteData<ApiGetFeedItems200Response> | undefined,
    );
    if (items === undefined) {
      continue;
    }
    const page = restoredPageNeedingCounts({ queryClient, items });
    if (page !== null) {
      pages.push(page);
    }
  }
  return pages;
};

/**
 * Ask a node for the counts of every restored page in the cache, and hand them
 * to the sink.
 *
 * Shaped as a plain async function so it can be driven against a real
 * QueryClient and a stubbed reader, with no React in the way.
 */
export const askForRestoredFeedCounts = async ({
  queryClient,
  batchUpdateGloballyCachedCast,
  reader,
}: {
  queryClient: QueryClient;
  batchUpdateGloballyCachedCast: BatchMergeIntoGloballyCachedCasts;
  reader: RestoredFeedCountsReader | null;
}): Promise<RestoredFeedCountsReport> => {
  const pages = restoredPagesNeedingCounts({ queryClient });
  if (pages.length === 0) {
    return { pages: 0, targets: 0, counts: 0, asked: false };
  }
  // No seam to ask: a build whose reads are not node-backed at all (the fork's
  // mock API, or the node-backed client switched off) has no node to read a
  // count from — and its pages carry their counts, because the API it reads
  // answers a page with them. Nothing is invented here and nothing is hidden:
  // the counts a surface asks for either come from a node or are not asked for.
  if (reader === null) {
    return { pages: pages.length, targets: 0, counts: 0, asked: false };
  }

  // The page's casts go into the cast cache FIRST, exactly as the fetcher does
  // for a page it reads: a count lands on a cast that is already cached and never
  // creates one (`~/hooks/data/useCountsBehindSink` `mergeCastCounts`), and a
  // restored page put nothing there. Ordering is not relied on — the sink holds a
  // count that finds no cast and lands it when the cache gains one.
  batchUpdateGloballyCachedCast({
    batchUpdates: pages.flatMap((page) => page.casts),
  });

  const targets = pages.flatMap((page) => page.targets);
  const counts = await reader.readCounts(targets);
  reader.sink(counts);

  return {
    pages: pages.length,
    targets: targets.length,
    counts: counts.length,
    asked: true,
  };
};

/**
 * Where the app that owns the seam registers the reader.
 *
 * `null` is a build with no node-backed client, which has no node to ask (see
 * the pass above). The value is registered by
 * `~/contexts/WebFarcasterApiClientProvider`, which owns both halves — the seam's
 * `readCastCounts` and the sink — and read by
 * `~/contexts/FeedQueryCacheProvider`, which is the one place that knows a kept
 * page was restored.
 */
const RestoredFeedCountsContext =
  createContext<RestoredFeedCountsReader | null>(null);

const RestoredFeedCountsProvider: FC<{
  reader: RestoredFeedCountsReader | null;
  children: ReactNode;
}> = ({ reader, children }) => (
  <RestoredFeedCountsContext.Provider value={reader}>
    {children}
  </RestoredFeedCountsContext.Provider>
);

/**
 * The pass, ready to run: called once per restore, right after what this account
 * kept is back in the query cache.
 *
 * WHY THE EVENTS AND NOT THE RESTORE PROMISE. MEASURED (this card, local
 * node-backed build, 390px, warm re-open): a pass run the moment the restore
 * promise settles finds nothing — the kept page is in the query cache before the
 * feed's own query exists, so the page it is for is not there yet. The order is
 * account → persister → hydrate → the feed mounts. Watching the cache catches the
 * page wherever it appears: this effect subscribes before
 * `~/contexts/FeedQueryCacheProvider` installs the persister (same component,
 * earlier hook), so the hydrate's own events are seen, and the mount run covers a
 * page that is somehow already there.
 *
 * The run is coalesced: a hydrate lands every kept query in one go, so one scan
 * after the burst is the whole of what is needed.
 */
export const useRestoredFeedCounts =
  (): (() => Promise<RestoredFeedCountsReport>) => {
    const queryClient = useQueryClient();
    const batchUpdateGloballyCachedCast =
      useBatchMergeIntoGloballyCachedCasts();
    const reader = useContext(RestoredFeedCountsContext);

    const run = useCallback(
      () =>
        askForRestoredFeedCounts({
          queryClient,
          batchUpdateGloballyCachedCast,
          reader,
        }),
      [batchUpdateGloballyCachedCast, queryClient, reader],
    );

    useEffect(() => {
      let scheduled = false;
      const schedule = () => {
        if (scheduled) {
          return;
        }
        scheduled = true;
        // A microtask, so a hydrate's whole burst of queries is one pass, and so
        // an event that fires before a query's data is in place (`added`) is
        // followed by the one that carries it (`updated`) before anything is
        // looked at.
        queueMicrotask(() => {
          scheduled = false;
          void run();
        });
      };

      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (isKeptFeedItemsKey(event.query.queryKey)) {
          schedule();
        }
      });
      schedule();

      return unsubscribe;
    }, [queryClient, run]);

    return run;
  };

export { RestoredFeedCountsProvider };
