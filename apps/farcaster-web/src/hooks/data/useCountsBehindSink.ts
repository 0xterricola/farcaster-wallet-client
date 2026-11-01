import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { ApiCast } from 'farcaster-client-data';
import { buildGloballyCachedCastKey } from 'farcaster-client-hooks';
import { useCallback, useEffect, useRef } from 'react';

import type { CastCounts, CastCountsSink } from '~/snapchain/nodeApi/reads';

/**
 * A feed page's counts, landing in the casts the feed is already rendering.
 *
 * WHY THE GLOBAL CAST CACHE AND NOT THE FEED's OWN PAGE DATA
 *
 * The counts arrive seconds after the page did, into a page that is already on
 * screen and must not be remounted (`useFeedItems` resolves once for the whole
 * page; re-writing it would be a second, visible load). Every cast a feed
 * renders goes through `useGloballyCachedCast`, which re-renders when the entry
 * for that hash changes — so a count written onto the cached cast appears on
 * screen under the paint, with no remount and no second query.
 *
 * Only counts that were really read arrive here (`reads.ts` `readCastCounts`
 * leaves out a count whose read failed), and only casts that are really in the
 * cache are written: this never CREATES an entry. A count written onto a hash
 * nobody is rendering would be half a cast in the global cache, and the next
 * surface to read it would find a cast with counts and no text.
 *
 * A cast can be cached under two keys — itself, and as a recast — and both are
 * filled when both exist. The flag is part of the key, and `compactQueryKey`
 * drops only `undefined`, so "itself" is `false` and not `undefined`: every
 * writer and every reader of this cache passes `!!recast` (a feed stores its
 * page's casts with `recast: false`). Writing the `undefined` key instead reads
 * the same in review and matches nothing at all — the counts were read, merged
 * onto a key no cast was held under, and dropped, leaving a feed that painted
 * early and never showed a number.
 *
 * WHY A MISS IS HELD AND RETRIED (card t_b0291522)
 *
 * The ordering normally holds on its own: a page's casts are written into this
 * cache by the fetcher before the page reaches React (`buildFeedItemsFetcher`
 * `batchUpdateGloballyCachedCast`), so they are cached before anything from
 * that page can be painted, while a count wave needs a network round trip per
 * cast (measured on live: 50 reads at 24 concurrency, 5.2–12.2 s). MEASURED on
 * a local build, including 4x and 8x CPU throttling, the sink reports
 * `received: 25, updated: 25, missed: 0` every time.
 *
 * The exception is a wave with nothing left to read: `reads.ts` `countCache`
 * answers a count some other surface already read, so a wave for casts whose
 * counts are cached resolves without any round trip and can answer before the
 * page it belongs to has been merged — the shape a prefetch leaves behind when
 * its query is cancelled between `startCountsBehind` and the merge. Under the
 * merge above such a count lands on nothing and, before this, was dropped for
 * good: the same number the feed painted early to receive, lost silently.
 *
 * So a count that finds no cast is HELD (bounded, see the constants below) and
 * the merge re-runs for that hash the moment the cache gains it — the retry is
 * driven by the cache write that was going to happen anyway, so it costs
 * nothing on the ordinary path (`missed: 0` holds nothing at all).
 */
export type CountsBehindMerge = {
  /** How many casts the counts landed on, one per cast (both keys count once). */
  updated: number;
  /** The counts that landed on nothing: the cast was not cached at this moment.
   * Held and retried by the sink below, and reported by the log. */
  missed: CastCounts[];
};

export const mergeCastCounts = ({
  queryClient,
  counts,
}: {
  queryClient: QueryClient;
  counts: CastCounts[];
}): CountsBehindMerge => {
  let updated = 0;
  const missed: CastCounts[] = [];

  for (const count of counts) {
    const { hash, reactions, recasts } = count;
    let wroteThisCast = false;

    for (const recast of [false, true]) {
      const key = buildGloballyCachedCastKey({ hash, recast });
      const cached = queryClient.getQueryData<ApiCast>(key);
      if (!cached) {
        continue;
      }
      queryClient.setQueryData<ApiCast>(key, {
        ...cached,
        reactions,
        recasts,
      });
      wroteThisCast = true;
    }

    if (wroteThisCast) {
      updated += 1;
    } else {
      missed.push(count);
    }
  }

  return { updated, missed };
};

export const mergeCastCountsIntoGloballyCachedCasts = ({
  queryClient,
  counts,
}: {
  queryClient: QueryClient;
  counts: CastCounts[];
}): number => mergeCastCounts({ queryClient, counts }).updated;

/** How long a count that found no cast is worth holding.
 *
 * A count is a number about right now, so it is not carried far: if its cast
 * has not appeared inside this window the reader has left that page, and a much
 * later write would be a number arriving about a page nobody is looking at. */
const PENDING_COUNT_TTL_MS = 30_000;

/** How many casts' counts may be held at once.
 *
 * A feed page is 25 casts, so this holds several pages' worth and no more: a
 * page whose casts are never cached cannot grow the hold without bound. */
const PENDING_COUNT_LIMIT = 200;

/** Counts waiting for their cast to be cached, oldest insertion first. */
type HeldCounts = Map<string, { counts: CastCounts; at: number }>;

/** The `globallyCachedCast` hash a query key belongs to, or `null` for any
 * other key — only a cast landing in the cache can complete a held count. */
export const globallyCachedCastHashOf = (
  queryKey: readonly unknown[],
): string | null =>
  queryKey[0] === 'globallyCachedCast' && typeof queryKey[1] === 'string'
    ? queryKey[1]
    : null;

/**
 * What the delivery did, for a probe (`VITE_SNAPCHAIN_DEBUG=true` puts it on
 * `window.__fiddyCountsBehind`, the same shape `nodeBackedFetch` uses for
 * `window.__nodeBackedRequests`).
 *
 * A count wave that lands on nothing and a count wave that lands look identical
 * from the DOM alone — both are "no numbers yet" — so the sink has to say which
 * one happened, and how many of the page's hashes were even in the cache when
 * it ran. Nothing leaves the tab, and a normal build never sets the flag.
 */
export type CountsBehindLogEntry = {
  at: number;
  /** Casts the page's count wave named. */
  received: number;
  /** Casts the merge filled. */
  updated: number;
  /** Casts the merge could not fill: their entry was not in the cache yet. */
  missed: string[];
  /** How many globally-cached casts the query cache holds at this moment. */
  cachedCasts: number;
  /** True for a re-attempt on a held count, false for the wave itself. */
  retry: boolean;
};

const countsBehindLog = (): CountsBehindLogEntry[] | null => {
  if (
    String(import.meta.env.VITE_SNAPCHAIN_DEBUG ?? '')
      .trim()
      .toLowerCase() !== 'true'
  ) {
    return null;
  }
  const globalStore = globalThis as unknown as {
    __fiddyCountsBehind?: CountsBehindLogEntry[];
  };
  globalStore.__fiddyCountsBehind ??= [];
  return globalStore.__fiddyCountsBehind;
};

/** Every `globallyCachedCast` entry the cache holds, for the log line above. */
const cachedCastCount = (queryClient: QueryClient): number =>
  queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] === 'globallyCachedCast').length;

/**
 * The sink the node-backed seam hands a feed page's counts to
 * (`~/snapchain/nodeApi/nodeBackedFetch` `onCountsRead`, wired in
 * `~/contexts/WebFarcasterApiClientProvider`).
 *
 * Returning this from a component is what turns the counts-behind-the-paint
 * read on at all: without a sink registered the seam answers a page WITH its
 * counts exactly as it used to, because there would be nowhere for a late
 * count to land. So the app that renders counts is the app that asks for them
 * this way — see the card: a cold first cast used to wait ~5.5 s for the
 * slowest per-cast count read on the page.
 */
export const useCountsBehindSink = (): CastCountsSink => {
  const queryClient = useQueryClient();
  const held = useRef<HeldCounts>(new Map());

  /** One merge attempt, logged. Returns the counts that landed on nothing. */
  const deliver = useCallback(
    (counts: CastCounts[], retry: boolean): CastCounts[] => {
      const { updated, missed } = mergeCastCounts({ queryClient, counts });
      countsBehindLog()?.push({
        at: Date.now(),
        received: counts.length,
        updated,
        missed: missed.map((count) => count.hash),
        cachedCasts: cachedCastCount(queryClient),
        retry,
      });
      return missed;
    },
    [queryClient],
  );

  const sink = useCallback<CastCountsSink>(
    (counts) => {
      const missed = deliver(counts, false);
      if (missed.length === 0) {
        return;
      }

      const now = Date.now();
      const waiting = held.current;
      for (const [hash, entry] of waiting) {
        if (now - entry.at > PENDING_COUNT_TTL_MS) {
          waiting.delete(hash);
        }
      }
      for (const count of missed) {
        // A later wave for the same cast wins: it read the count more recently.
        waiting.delete(count.hash);
        waiting.set(count.hash, { counts: count, at: now });
      }
      for (const [hash] of waiting) {
        if (waiting.size <= PENDING_COUNT_LIMIT) {
          break;
        }
        waiting.delete(hash);
      }
    },
    [deliver],
  );

  useEffect(() => {
    // The retry, driven by the cache itself: a held count is attempted again the
    // moment the cast it belongs to is written (`added`/`updated` on that hash).
    // Nothing else fires a walk — an observer event on a cast already held is
    // ignored before any lookup, so the ordinary path pays nothing here.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (held.current.size === 0) {
        return;
      }
      if (event.type !== 'updated') {
        // `added` fires when the query object is built, BEFORE its data is in
        // place (`QueryCache.build` → `setQueryData` sets it next), so an
        // attempt there could only miss a cast that is about to be there.
        return;
      }
      const hash = globallyCachedCastHashOf(event.query.queryKey);
      if (hash === null) {
        return;
      }
      const entry = held.current.get(hash);
      if (entry === undefined) {
        return;
      }
      // Dropped BEFORE the attempt: writing the count fires an `updated` for
      // this same hash, and holding it would make that write re-enter here.
      held.current.delete(hash);
      if (deliver([entry.counts], true).length > 0) {
        // Still nothing to land on (both keys gone again): keep it for the next
        // write to this hash rather than dropping it now.
        held.current.set(hash, entry);
      }
    });

    return unsubscribe;
  }, [deliver, queryClient]);

  return sink;
};
