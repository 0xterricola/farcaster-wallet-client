import { ApiCast } from 'farcaster-client-data';
import { useCallback } from 'react';

import { useFarcasterApiClient } from '../../../providers/FarcasterApiClientProvider';
import {
  optimisticallySteppedCount,
  useOptimisticallyUpdateCast,
} from '../optimistic';
import { useInvalidateUserCasts } from '../queries/userCasts/useInvalidateUserCasts';

const useUndoRecast = () => {
  const { apiClient } = useFarcasterApiClient();
  const invalidateUserCasts = useInvalidateUserCasts();

  const optimisticallyUpdateCast = useOptimisticallyUpdateCast();

  return useCallback(
    async ({ cast, viewerFid }: { cast: ApiCast; viewerFid: number }) => {
      const revertOptimisticUpdates = optimisticallyUpdateCast({
        updates: {
          hash: cast.hash,
          recasts: {
            // Nothing when the count has not been read yet (see the helper):
            // the recasters list moves, no number is invented.
            ...optimisticallySteppedCount({
              count: cast.recasts?.count,
              delta: -1,
            }),
            recasters: cast.recasts?.recasters?.filter(
              (recaster) => recaster.fid !== viewerFid,
            ),
          },
          viewerContext: {
            recast: false,
          },
          combinedRecastCount:
            typeof cast.combinedRecastCount !== 'undefined'
              ? Math.max(0, cast.combinedRecastCount - 1)
              : undefined,
        },
        revertUpdates: {
          hash: cast.hash,
          recasts: {
            ...optimisticallySteppedCount({
              count: cast.recasts?.count,
              delta: 0,
            }),
            recasters: cast.recasts?.recasters?.slice(),
          },
          viewerContext: {
            recast: cast.viewerContext?.recast,
          },
          combinedRecastCount:
            typeof cast.combinedRecastCount !== 'undefined'
              ? cast.combinedRecastCount
              : undefined,
        },
      });

      try {
        await apiClient.deleteRecast({
          castHash: cast.hash,
        });

        invalidateUserCasts({ fid: viewerFid });
      } catch (error) {
        revertOptimisticUpdates();
        throw error;
      }
    },
    [apiClient, invalidateUserCasts, optimisticallyUpdateCast],
  );
};

export { useUndoRecast };
