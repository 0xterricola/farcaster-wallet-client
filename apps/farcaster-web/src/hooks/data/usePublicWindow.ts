/**
 * The browse window, as React values.
 *
 * One hook for both public surfaces, because they are the same read shaped two
 * ways: `/feed` shows the window (and can rank it), `/explore` shows what the
 * window is made of (its topics) with the ranked view as the default.
 *
 * The read itself is the client's own: `useNonSuspenseFeedItems` posts to
 * `/v2/feed-items` exactly as the signed-in feeds do, with the public feed key,
 * and the node adapter answers it from `readPublicFeed` through whichever
 * server the provider chain has live. Nothing here fetches anything by hand.
 *
 * `useNonSuspenseFeedItems` rather than the suspense variant on purpose: this
 * surface has real empty, error and retry states (a visitor with no account on
 * a public node is exactly the case where a read can fail), and a suspended
 * query would hand that to an error boundary instead.
 */

import { useNonSuspenseFeedItems } from 'farcaster-client-hooks';
import { useCallback, useMemo, useState } from 'react';

import {
  feedTypeForWindow,
  PUBLIC_FEED_KEY,
  type PublicFeedKind,
  type PublicWindowTopic,
  topicsFromCasts,
} from '~/snapchain/nodeApi/publicFeedWindow';
import { type ApiCastWithContext } from '~/types';
import { buildCastsWithContext } from '~/utils/castUtils';

/** Which of the two public surfaces is being rendered. */
export type PublicBrowseVariant = 'feed' | 'explore';

export interface PublicWindow {
  kind: PublicFeedKind;
  topic: string | null;
  selectKind: (kind: PublicFeedKind) => void;
  selectTopic: (topic: string | null) => void;
  /** The feed type the read is asking with (`recent`, `trending`, `topic:x`). */
  feedType: string;
  /** What the window is made of, most-used first. Kept while a topic is shown. */
  topics: PublicWindowTopic[];
  castsWithContext: ApiCastWithContext[];
  /** First read in flight and nothing to show yet. */
  isLoading: boolean;
  /** A read failed and there is nothing to show. */
  isError: boolean;
  errorMessage: string | null;
  /** Any read in flight (a refresh, a tab change, the next page). */
  isFetching: boolean;
  isEmpty: boolean;
  onEndReached: () => void;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  retry: () => void;
}

const noop = () => {
  // A null page from the read layer is reported here; the window's own states
  // already say everything a visitor needs, so there is nothing to add.
};

export const usePublicWindow = (variant: PublicBrowseVariant): PublicWindow => {
  // `/feed` opens on what is newest; `/explore` opens on what is getting
  // attention, which is the whole difference between the two surfaces.
  const [kind, setKind] = useState<PublicFeedKind>(
    variant === 'explore' ? 'trending' : 'recent',
  );
  const [topic, setTopic] = useState<string | null>(null);

  const feedType = feedTypeForWindow({ kind, topic });

  const {
    feedItems,
    isLoading,
    isError,
    error,
    isFetching,
    refetch,
    onEndReached,
    isFetchingNextPage,
    hasNextPage,
  } = useNonSuspenseFeedItems({
    feedKey: PUBLIC_FEED_KEY,
    feedType,
    // Nothing about a browse window is the viewer's own state: no seen
    // bookkeeping, no updateState write.
    updateState: false,
    onNullFeedItemsResponse: noop,
  });

  const castsWithContext = useMemo(
    () =>
      buildCastsWithContext(feedItems, {
        showChannelTag: (cast) => !cast.parentHash,
      }),
    [feedItems],
  );

  /**
   * The topics the surface offers: what the window is really made of.
   *
   * A channel key per cast, most-used first. Nothing is invented here and no
   * directory is asked for: a node keeps no channel list, and the hosted
   * directory cannot be read from a page. A narrowed window naturally offers
   * only its own channel, so the surface pairs these chips with a way back to
   * the whole window (`PublicBrowsePage`, the topic row).
   */
  const topics = useMemo(
    () => topicsFromCasts(feedItems.map((item) => item.cast)),
    [feedItems],
  );

  const selectKind = useCallback((next: PublicFeedKind) => {
    setKind(next);
  }, []);
  const selectTopic = useCallback((next: string | null) => {
    setTopic(next);
  }, []);

  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    kind,
    topic,
    selectKind,
    selectTopic,
    feedType,
    topics,
    castsWithContext,
    isLoading,
    isError,
    errorMessage: isError
      ? error instanceof Error && error.message.length > 0
        ? error.message
        : 'The window could not be read.'
      : null,
    isFetching,
    isEmpty: !isLoading && !isError && castsWithContext.length === 0,
    onEndReached,
    isFetchingNextPage,
    hasNextPage: hasNextPage ?? false,
    retry,
  };
};
