/**
 * The policy that decides what this browser keeps between loads.
 *
 * WHY IT IS PINNED HERE: the app used to delete its whole persisted query cache
 * on every load, and MEASURED (2026-10-22) that made a warm re-open exactly as
 * slow as a cold sign-in (23.7s / 24.4s against 29.4s / 27.1s to the first cast
 * painted). Keeping the feeds is the fix; keeping anything else is what the
 * deletion existed to prevent. So the list is the assertion.
 */

import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
  FEED_CACHE_MAX_AGE_MS,
  feedCacheKeyFor,
  shouldPersistFeedQuery,
} from '~/lib/feedCache';

const query = (queryKey: readonly unknown[], status = 'success') => ({
  queryKey,
  state: { status },
});

describe('what is kept between loads', () => {
  it('keeps the home feed and the following feed', () => {
    expect(
      shouldPersistFeedQuery(query(['feedItems', 'home', 'default'])),
    ).toBe(true);
    expect(
      shouldPersistFeedQuery(query(['feedItems', 'following', 'default'])),
    ).toBe(true);
  });

  it('keeps nothing else — the surfaces the blanket deletion protected', () => {
    // A channel feed, a profile's casts, a thread, a direct-cast conversation,
    // and the signed-in account: every one of these was named (or implied) by
    // the comment that deleted the cache, and none of them is a feed first page.
    expect(shouldPersistFeedQuery(query(['feedItems', 'dev', 'default']))).toBe(
      false,
    );
    expect(shouldPersistFeedQuery(query(['userCasts', 'dwr', 'default']))).toBe(
      false,
    );
    expect(shouldPersistFeedQuery(query(['thread', '0xabc']))).toBe(false);
    expect(shouldPersistFeedQuery(query(['directCastConversation', 1]))).toBe(
      false,
    );
    expect(shouldPersistFeedQuery(query(['onboardingState']))).toBe(false);
    expect(shouldPersistFeedQuery(query([]))).toBe(false);
  });

  it('keeps an answer, never a question in flight', () => {
    expect(
      shouldPersistFeedQuery(
        query(['feedItems', 'home', 'default'], 'pending'),
      ),
    ).toBe(false);
    expect(
      shouldPersistFeedQuery(query(['feedItems', 'home', 'default'], 'error')),
    ).toBe(false);
  });

  it('keeps a feed per account, so one account cannot read another’s', () => {
    expect(feedCacheKeyFor(3)).not.toBe(feedCacheKeyFor(4));
    expect(feedCacheKeyFor(3)).toContain('3');
    // A version lives in the key, so a shape change is a new key rather than a
    // restore of something whose renderer no longer matches.
    expect(feedCacheKeyFor(3)).toMatch(/v\d+:/);
  });

  it('forgets a kept page after a day', () => {
    expect(FEED_CACHE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('is the predicate the query client is given, over a real Query', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(['feedItems', 'home', 'default'], { pages: [] });
    client.setQueryData(['thread', '0xabc'], { pages: [] });

    const [home] = client.getQueryCache().findAll({
      queryKey: ['feedItems', 'home', 'default'],
    });
    const [thread] = client.getQueryCache().findAll({ queryKey: ['thread'] });

    expect(shouldPersistFeedQuery(home!)).toBe(true);
    expect(shouldPersistFeedQuery(thread!)).toBe(false);
  });
});
