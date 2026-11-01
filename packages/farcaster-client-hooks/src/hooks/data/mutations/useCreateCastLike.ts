import { ApiCast } from 'farcaster-client-data';
import { useCallback } from 'react';

import { UpdateCastLikeError } from '../../../errors';
import { useFarcasterApiClient } from '../../../providers/FarcasterApiClientProvider';
import {
  optimisticallySteppedCount,
  useOptimisticallyUpdateCast,
} from '../optimistic';

const useCreateCastLike = () => {
  const { apiClient } = useFarcasterApiClient();
  const optimisticallyUpdateCast = useOptimisticallyUpdateCast();

  return useCallback(
    async ({ cast }: { cast: ApiCast }) => {
      const revertOptimisticUpdates = optimisticallyUpdateCast({
        updates: {
          hash: cast.hash,
          // Nothing when the count has not been read yet (see the helper): the
          // heart fills either way, and no number is invented.
          reactions: optimisticallySteppedCount({
            count: cast.reactions?.count,
            delta: 1,
          }),
          viewerContext: {
            reacted: true,
          },
        },
        revertUpdates: {
          hash: cast.hash,
          reactions: optimisticallySteppedCount({
            count: cast.reactions?.count,
            delta: 0,
          }),
          viewerContext: {
            reacted: cast.viewerContext?.reacted,
          },
        },
      });

      try {
        const response = await apiClient.createCastLike({
          castHash: cast.hash,
        });
        return response.data;
      } catch (error) {
        revertOptimisticUpdates();
        throw new UpdateCastLikeError({ castHash: cast.hash, error });
      }
    },
    [apiClient, optimisticallyUpdateCast],
  );
};

export { useCreateCastLike };
