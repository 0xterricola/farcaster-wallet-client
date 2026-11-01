import { ApiCast } from 'farcaster-client-data';
import { usePrefetchThread } from 'farcaster-client-hooks';
import { useCallback } from 'react';

import { useCheckIfShouldSkipOptimisticPrefetch } from '~/hooks/data/useCheckIfShouldSkipOptimisticPrefetch';

/**
 * Warm the page a cast's link opens, on hover.
 *
 * It warms `/v2/thread-casts` — the read the conversation page actually makes —
 * for every cast, whatever the author's handle is. The `/<handle>/<0x prefix>`
 * route's own read (`/v2/user-thread-casts`) is not something a Snapchain node
 * answers, so prefetching it warmed a cache entry nothing would ever read and
 * spent a 501 on it (card t_5068bb26).
 */
const useOptimisticallyPrefetchConversation = ({
  cast,
}: {
  cast: Pick<ApiCast, 'hash'>;
}) => {
  const checkIfShouldSkipOptimisticPrefetch =
    useCheckIfShouldSkipOptimisticPrefetch();

  const prefetchThread = usePrefetchThread();

  return useCallback(() => {
    if (checkIfShouldSkipOptimisticPrefetch()) {
      return;
    }

    prefetchThread({
      castHash: cast.hash,
      shouldSkipIfRecentlyPrefetched: true,
      // Prefetcing conversations work well in general, except when user takes an
      // action on the cast (i.e. liking) and then the batch update after request
      // ending for optimistic fetch overriding it. This results in phantom updates.
      // The main part about prefetching is to warm the RQ cache so loads of the page
      // is instant. This flag allows us to ignore values coming from thread calls.
      shouldAvoidUpdatingGlobalCache: true,
    });
  }, [cast.hash, prefetchThread, checkIfShouldSkipOptimisticPrefetch]);
};

export { useOptimisticallyPrefetchConversation };
