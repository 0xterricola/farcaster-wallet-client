import { ApiCastFeedIncludeReason } from 'farcaster-client-data';
import { getFeedSourceOn, useTrackEvent } from 'farcaster-client-hooks';
import { useCallback } from 'react';

import { useNavigate } from '~/hooks/navigation/useNavigate';

/**
 * Open a cast's page in this client.
 *
 * WHAT IT DOES NOT TAKE: the author's handle. It used to, to paint the pretty
 * `/<handle>/<0x prefix>` route — which the node-backed client cannot read (it
 * is served by `/v2/user-thread-casts`, and a Snapchain node shards by FID, so
 * no node can answer a hash prefix; measured live 2026-10-22, card
 * t_5068bb26). Every cast this app holds carries its full hash, so every link
 * to a cast's page is `/~/conversations/<full hash>` — the same page a share
 * copies, and the one route a node can answer.
 */
const useNavigateToConversation = () => {
  const navigate = useNavigate();
  const {
    defaultEventProps: { on },
  } = useTrackEvent();

  return useCallback(
    ({
      castHash,
      includeReason,
      openInNewTab = false,
    }: {
      castHash: string;
      includeReason?: ApiCastFeedIncludeReason['type'];
      openInNewTab?: boolean;
    }) => {
      const sourceOn = getFeedSourceOn(on);
      const searchParams = {
        ...(includeReason ? { includeReason } : {}),
        ...(sourceOn ? { sourceOn } : {}),
      };

      return navigate({
        to: 'conversationWithoutUsername',
        params: { castHash },
        ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        options: { openInNewTab },
      });
    },
    [navigate, on],
  );
};

export { useNavigateToConversation };
