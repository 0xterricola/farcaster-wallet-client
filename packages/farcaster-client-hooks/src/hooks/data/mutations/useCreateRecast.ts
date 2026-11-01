import { ApiCast } from 'farcaster-client-data';
import { useCallback } from 'react';

import { RecastError } from '../../../errors';
import { useFarcasterApiClient } from '../../../providers/FarcasterApiClientProvider';
import {
  optimisticallySteppedCount,
  useOptimisticallyUpdateCast,
} from '../optimistic';
import { useInvalidateUserCasts } from '../queries/userCasts/useInvalidateUserCasts';

const useCreateRecast = () => {
  const { apiClient } = useFarcasterApiClient();
  const optimisticallyUpdateCast = useOptimisticallyUpdateCast();
  const invalidateUserCasts = useInvalidateUserCasts();

  return useCallback(
    async ({
      cast,
      viewerFid,
      viewerUsername,
      viewerDisplayName,
    }: {
      cast: ApiCast;
      viewerFid?: number;
      viewerUsername?: string;
      viewerDisplayName?: string;
    }) => {
      const revertOptimisticUpdates = optimisticallyUpdateCast({
        updates: {
          hash: cast.hash,
          recasts: {
            // Nothing when the count has not been read yet (see the helper).
            ...optimisticallySteppedCount({
              count: cast.recasts?.count,
              delta: 1,
            }),
            recasters:
              // Add viewer to recasters if values are provided
              viewerFid && viewerDisplayName
                ? [
                    ...(cast.recasts?.recasters || []),
                    {
                      fid: viewerFid,
                      username: viewerUsername,
                      displayName: viewerDisplayName,
                    },
                  ]
                : undefined,
          },
          viewerContext: {
            recast: true,
          },
          combinedRecastCount:
            typeof cast.combinedRecastCount !== 'undefined'
              ? Math.max(0, cast.combinedRecastCount + 1)
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
        const response = await apiClient.createRecast({
          castHash: cast.hash,
        });

        invalidateUserCasts({ fid: cast.author.fid });

        try {
          // Updating the cast again now that we have the recast hash.
          optimisticallyUpdateCast({
            updates: {
              hash: response.data.result.castHash,
            },
            revertUpdates: undefined,
          });
        } catch {}
      } catch (error) {
        revertOptimisticUpdates();

        throw new RecastError({
          error,
          fid: cast.author.fid,
          castHash: cast.hash,
        });
      }
    },
    [apiClient, invalidateUserCasts, optimisticallyUpdateCast],
  );
};

export { useCreateRecast };
