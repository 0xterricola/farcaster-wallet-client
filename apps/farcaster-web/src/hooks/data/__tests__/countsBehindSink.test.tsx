// @vitest-environment jsdom

/**
 * A late count lands on the cast the feed is ALREADY rendering.
 *
 * The counts of a feed page are read behind its paint (see
 * `~/snapchain/nodeApi/reads` `readCastCounts` and
 * `scripts/measure-first-cast.mjs`), so by the time they arrive the page is on
 * screen and must not be reloaded. Every cast a feed renders goes through
 * `useGloballyCachedCast`, which re-renders when its entry in the global cast
 * cache changes — so the merge below is what makes a count appear under the
 * paint, with no remount and no second query.
 *
 * Two rules this pins, both of which a "merge everything into everything"
 * version would break:
 *
 *   - a hash nobody has cached is NOT created by a count: the global cast cache
 *     holds whole casts, and a count-only entry would be half a cast for the
 *     next surface that reads it (its text, author and embeds missing);
 *   - a cast cached as a recast is a separate entry (`buildGloballyCachedCastKey`
 *     includes the flag), so both are filled when both exist.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { ApiCast } from 'farcaster-client-data';
import { buildGloballyCachedCastKey } from 'farcaster-client-hooks';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mergeCastCounts,
  mergeCastCountsIntoGloballyCachedCasts,
  useCountsBehindSink,
} from '~/hooks/data/useCountsBehindSink';

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

const countsFor = (hash: string) => ({
  hash,
  reactions: { count: 7 },
  recasts: { count: 2 },
});

/** The key a feed's casts are really cached under.
 *
 * NOT `{ hash }`: the flag is part of the key and `compactQueryKey` drops only
 * `undefined`, so a cast held as itself is `[.., hash, false]` — every writer
 * and every reader passes `!!recast` (`useBatchMergeIntoGloballyCachedCasts`,
 * `useGloballyCachedCast`). This test file used to seed `{ hash }` instead,
 * which is the key `mergeCastCountsIntoGloballyCachedCasts` wrote to at the
 * time — so the merge and its test agreed with each other and neither agreed
 * with the app. On a live release the counts were read, delivered to the sink
 * and dropped onto a key no cast was held under, and the feed showed no numbers
 * at all (measured 2026-10-23, cold sign-in, 390px). Seed what the app holds. */
const castKey = (hash: string, recast = false) =>
  buildGloballyCachedCastKey({ hash, recast });

describe('a page’s counts merge into the casts already cached', () => {
  it('fills the counts of a cast that is on screen', () => {
    const queryClient = new QueryClient();
    const hash = '0xabc';
    const key = castKey(hash);
    queryClient.setQueryData(key, castFixture(hash));

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: [countsFor(hash)],
    });

    expect(updated).toBe(1);
    const cast = queryClient.getQueryData<ApiCast>(key)!;
    expect(cast.reactions).toEqual({ count: 7 });
    expect(cast.recasts).toEqual({ count: 2 });
    // The rest of the cast is untouched: this is a count arriving, not a page.
    expect(cast.text).toBe('a cast with no counts yet');
    expect(cast.author.fid).toBe(3);
  });

  it('lands on the key the feed stores its casts under, and not the flagless one', () => {
    const queryClient = new QueryClient();
    const hash = '0xflag';
    queryClient.setQueryData(castKey(hash), castFixture(hash));

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: [countsFor(hash)],
    });

    expect(updated).toBe(1);
    expect(queryClient.getQueryData<ApiCast>(castKey(hash))!.reactions).toEqual(
      { count: 7 },
    );
    // The flagless key is NOT where a cast lives; a count written there is a
    // count dropped, which is what this test exists to catch.
    expect(
      queryClient.getQueryData(buildGloballyCachedCastKey({ hash })),
    ).toBeUndefined();
  });

  it('creates nothing for a hash nobody has cached', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(castKey('0xoncache'), castFixture('0xoncache'));
    const before = queryClient.getQueryCache().getAll().length;

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: [countsFor('0xnobody')],
    });

    expect(updated).toBe(0);
    expect(queryClient.getQueryCache().getAll().length).toBe(before);
    expect(
      queryClient.getQueryData(
        buildGloballyCachedCastKey({ hash: '0xnobody' }),
      ),
    ).toBeUndefined();
  });

  it('fills both a cast and its recast entry when both are cached', () => {
    const queryClient = new QueryClient();
    const hash = '0xboth';
    const plain = castKey(hash);
    const asRecast = castKey(hash, true);
    queryClient.setQueryData(plain, castFixture(hash));
    queryClient.setQueryData(asRecast, castFixture(hash, { recast: true }));

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: [countsFor(hash)],
    });

    expect(updated).toBe(1);
    expect(queryClient.getQueryData<ApiCast>(plain)!.reactions).toEqual({
      count: 7,
    });
    expect(queryClient.getQueryData<ApiCast>(asRecast)!.reactions).toEqual({
      count: 7,
    });
  });

  it('reports how many casts it filled, one per cast', () => {
    const queryClient = new QueryClient();
    for (const hash of ['0xone', '0xtwo', '0xthree']) {
      queryClient.setQueryData(castKey(hash), castFixture(hash));
    }

    const updated = mergeCastCountsIntoGloballyCachedCasts({
      queryClient,
      counts: ['0xone', '0xtwo', '0xthree', '0xmissing'].map(countsFor),
    });

    expect(updated).toBe(3);
  });

  it('names the counts that found no cast, so a miss is not silent', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(castKey('0xhere'), castFixture('0xhere'));

    const { updated, missed } = mergeCastCounts({
      queryClient,
      counts: ['0xhere', '0xabsent'].map(countsFor),
    });

    expect(updated).toBe(1);
    expect(missed.map((count) => count.hash)).toEqual(['0xabsent']);
  });
});

/**
 * The counts arrive when they arrive; the cast is cached when the feed caches
 * it. A delivery that needs those two in one order is a delivery that loses a
 * number whenever the other order happens — and the wave that has nothing left
 * to read (`reads.ts` `countCache`) can answer before its page is merged.
 *
 * MEASURED before this (card t_b0291522): a wave that answered first was
 * merged onto nothing and dropped for good, and the feed kept no numbers for
 * those casts for the life of the tab.
 */
describe('a count that answers before its cast is cached', () => {
  const wrapper =
    (queryClient: QueryClient) =>
    ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as { __fiddyCountsBehind?: unknown })
      .__fiddyCountsBehind;
  });

  it('lands when the feed caches the cast, instead of being dropped', () => {
    const queryClient = new QueryClient();
    const hash = '0xlate';
    const { result } = renderHook(() => useCountsBehindSink(), {
      wrapper: wrapper(queryClient),
    });

    // The wave answers first: nothing is cached yet, so nothing can be filled.
    result.current([countsFor(hash)]);
    expect(queryClient.getQueryData(castKey(hash))).toBeUndefined();

    // The feed caches its page a moment later; the count lands on it.
    queryClient.setQueryData(castKey(hash), castFixture(hash));

    const cast = queryClient.getQueryData<ApiCast>(castKey(hash))!;
    expect(cast.reactions).toEqual({ count: 7 });
    expect(cast.recasts).toEqual({ count: 2 });
    // Still a count arriving, not a page: the rest of the cast is untouched.
    expect(cast.text).toBe('a cast with no counts yet');
  });

  it('fills a recast entry too, whichever key the cache gains first', () => {
    const queryClient = new QueryClient();
    const hash = '0xlateRecast';
    const { result } = renderHook(() => useCountsBehindSink(), {
      wrapper: wrapper(queryClient),
    });

    result.current([countsFor(hash)]);
    queryClient.setQueryData(
      castKey(hash, true),
      castFixture(hash, { recast: true }),
    );

    expect(
      queryClient.getQueryData<ApiCast>(castKey(hash, true))!.reactions,
    ).toEqual({ count: 7 });
  });

  it('does not create a cast for a count whose cast never appears', () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useCountsBehindSink(), {
      wrapper: wrapper(queryClient),
    });

    result.current([countsFor('0xnobody')]);

    expect(queryClient.getQueryCache().getAll().length).toBe(0);
  });

  it('says what happened on __fiddyCountsBehind: the miss, then the retry', () => {
    vi.stubEnv('VITE_SNAPCHAIN_DEBUG', 'true');
    const queryClient = new QueryClient();
    const hash = '0xlogged';
    const { result } = renderHook(() => useCountsBehindSink(), {
      wrapper: wrapper(queryClient),
    });

    result.current([countsFor(hash)]);
    queryClient.setQueryData(castKey(hash), castFixture(hash));

    const log = (
      globalThis as { __fiddyCountsBehind?: Array<Record<string, unknown>> }
    ).__fiddyCountsBehind;
    expect(log).toHaveLength(2);
    expect(log![0]).toMatchObject({
      received: 1,
      updated: 0,
      missed: [hash],
      retry: false,
    });
    expect(log![1]).toMatchObject({
      received: 1,
      updated: 1,
      missed: [],
      retry: true,
    });
  });

  it('writes nothing to the log when no build asked for it', () => {
    const queryClient = new QueryClient();
    const hash = '0xquiet';
    const { result } = renderHook(() => useCountsBehindSink(), {
      wrapper: wrapper(queryClient),
    });

    result.current([countsFor(hash)]);

    expect(
      (globalThis as { __fiddyCountsBehind?: unknown }).__fiddyCountsBehind,
    ).toBeUndefined();
  });
});
