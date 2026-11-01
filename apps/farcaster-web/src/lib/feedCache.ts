/**
 * What this browser keeps of the client's own query cache between loads — the
 * policy, with no React in it so it can be pinned by a test.
 *
 * WHY THIS EXISTS (user report, 2026-10-22: "after first sign-in, casts take
 * long to load")
 *
 * MEASURED on the deployed client: a sign-in → first cast took 29.4s at 1440 and
 * 27.1s at 390, and a WARM re-open — the same browser, an HTTP cache already
 * holding the bundle — took 23.7s and 24.4s. Warm was as slow as cold for one
 * reason: `App.tsx` deleted the whole persisted query cache on every load (see
 * `localStoragePersister.removeClient()`), so a re-open began with no data and
 * re-read a 60-account follow graph from the node.
 *
 * That deletion was there for a real reason, and this file is the narrow version
 * of it: the persisted cache is NOT safe for every surface the fork has
 * (threads, direct casts, and anything whose shape changed since it was written
 * are the ones its comment named). So the rule is a list, not a blanket:
 *
 *   - only the FEEDS (`feedItems` for `home` and `following`) are kept;
 *   - only one page each (the app trims the feed to its first page on mount
 *     anyway — see `purgeToFirstPageOnMount`);
 *   - only for the account that read it, because the key carries the FID: a
 *     second account on this device, or a sign-out, can never paint the first
 *     one's feed;
 *   - and only for a day, after which it is dropped rather than restored.
 *
 * Nothing else is remembered, so nothing else can be restored in a shape its
 * renderer does not expect.
 *
 * WHAT A RESTORE BUYS: the feed paints from this browser's own storage on the
 * first frame and refreshes in the background (the query is stale after three
 * minutes, so opening it later shows casts and then replaces them — the pattern
 * quilcast uses for its own feeds).
 */

/**
 * The key prefix and the version. Bump the version when the shape of what is
 * stored changes: an old blob under a new version is simply never read.
 */
const FEED_CACHE_PREFIX = 'fiddy:feed-cache:v1';

/** How long a kept page may be restored. Beyond it the feed is read afresh. */
const FEED_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The query family this policy is about, as `buildFeedItemsKey` writes it. */
const FEED_ITEMS_QUERY_HEAD = 'feedItems';

/**
 * The feeds whose first page is kept. Deliberately a list: a channel feed, a
 * profile's casts, a thread and a direct-cast conversation are all reads whose
 * consumers were never built to see a restored page, and the card that put the
 * blanket deletion in place said so.
 */
const PERSISTED_FEED_KEYS: ReadonlySet<string> = new Set(['home', 'following']);

/**
 * Where one account's kept feed lives. Account-scoped on purpose: `home` means
 * "the account signed in on this device", so a page kept for one FID is not an
 * answer for another.
 */
const feedCacheKeyFor = (fid: number): string => `${FEED_CACHE_PREFIX}:${fid}`;

/** What `shouldDehydrateQuery` is allowed to persist. */
const shouldPersistFeedQuery = (query: {
  queryKey: readonly unknown[];
  state: { status: string };
}): boolean => {
  if (query.state.status !== 'success') {
    return false;
  }

  const [head, feedKey] = query.queryKey as readonly unknown[];
  return (
    head === FEED_ITEMS_QUERY_HEAD &&
    typeof feedKey === 'string' &&
    PERSISTED_FEED_KEYS.has(feedKey)
  );
};

export {
  FEED_CACHE_MAX_AGE_MS,
  feedCacheKeyFor,
  PERSISTED_FEED_KEYS,
  shouldPersistFeedQuery,
};
