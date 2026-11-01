import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { useQueryClient } from '@tanstack/react-query';
import {
  type Persister,
  persistQueryClient,
} from '@tanstack/react-query-persist-client';
import { useCachedOnboardingState } from 'farcaster-client-hooks';
import React, { FC, memo, ReactNode, useEffect, useMemo } from 'react';

import { useRestoredFeedCounts } from '~/hooks/data/useRestoredFeedCounts';
import {
  FEED_CACHE_MAX_AGE_MS,
  feedCacheKeyFor,
  shouldPersistFeedQuery,
} from '~/lib/feedCache';

import { PersistQueryClientInstanceProvider } from './PersistQueryClientInstanceProvider';

/**
 * Keeps the feeds this browser already read, for the account that read them.
 *
 * This is where the app's persisted query cache is installed — the one place
 * `~/lib/feedCache` is wired to storage — and it is installed only once the
 * signed-in FID is known, because the FID is part of the storage key. That is
 * the difference from the old arrangement, in which one module-scope persister
 * existed before any account did and had to be deleted on every load to keep a
 * second account from reading the first one's data.
 *
 * It sits inside `WebFarcasterApiClientProvider` (for the cached onboarding
 * state, which answers synchronously and without a fetch) and above
 * `AuthProvider` (which removes the client on sign-out through the context this
 * provides).
 *
 * AND THE COUNTS OF WHAT IT RESTORED. A kept page carries no engagement numbers
 * (the node-backed path builds a page without them, `reads.ts` `readFeed`) and a
 * restored page is not re-read, so it has no count wave either — a warm re-open
 * used to paint a wall of casts with no likes or recasts on any of them, for as
 * long as the page was fresh (measured on the live release, card t_43249104).
 * The restore promise is the one moment a restored page exists, so it is where
 * the page is asked for its counts: `~/hooks/data/useRestoredFeedCounts` reads
 * the kept page's casts from a node and hands them to the sink a read page's own
 * wave uses.
 */
const FeedQueryCacheProvider: FC<{ children: ReactNode }> = memo(
  ({ children }) => {
    const queryClient = useQueryClient();

    // Who is signed in, from the same cached state the shell renders the
    // account from. It re-renders when that state loads, so the persister
    // below exists as soon as the session does.
    const signedInFid = useCachedOnboardingState().result.state.user?.fid;

    const persister: Persister | undefined = useMemo(
      () =>
        signedInFid === undefined
          ? undefined
          : createSyncStoragePersister({
              storage: window.localStorage,
              key: feedCacheKeyFor(signedInFid),
              // Writes are batched: a feed page is a large value and a
              // synchronous localStorage write per query update would land on
              // the main thread while the feed is still settling.
              throttleTime: 1000,
            }),
      [signedInFid],
    );

    // The counts of a restored page, asked for by the page itself (card
    // t_43249104). The page this browser kept carries no engagement numbers —
    // the node-backed path builds a page without them — so a re-open inside the
    // staleness window paints a wall of casts and, having no page read, never
    // runs a count wave either. This call is what watches for such a page and
    // asks: it subscribes to the query cache above (before the persister below
    // is installed) and reads the kept page's casts from a node, handing them to
    // the sink a read page's own wave uses — see
    // `~/hooks/data/useRestoredFeedCounts` for the whole of it.
    useRestoredFeedCounts();

    useEffect(() => {
      if (!persister) {
        return undefined;
      }

      // Restores what this account's last visit kept, then keeps what this
      // visit reads. The restore is deliberately not awaited: the feed renders
      // from the query cache the moment its query mounts, and the restored page
      // lands in that cache.
      const [stopPersisting] = persistQueryClient({
        queryClient,
        persister,
        maxAge: FEED_CACHE_MAX_AGE_MS,
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistFeedQuery },
      });

      return stopPersisting;
    }, [persister, queryClient]);

    return (
      <PersistQueryClientInstanceProvider localStoragePersister={persister}>
        {children}
      </PersistQueryClientInstanceProvider>
    );
  },
);

FeedQueryCacheProvider.displayName = 'FeedQueryCacheProvider';

export { FeedQueryCacheProvider };
