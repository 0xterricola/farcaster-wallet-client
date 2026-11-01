import {
  usePrefetchActiveChannelStreak,
  usePrefetchUser,
  usePrefetchUserByUsername,
  usePrefetchUserFollowingChannels,
} from 'farcaster-client-hooks';
import { FC, memo, useEffect } from 'react';

import { useCurrentUser } from '~/hooks/data/useCurrentUser';

/**
 * How long the app has on screen before these prefetches are asked for.
 *
 * A prefetch is not urgent by definition — it is work done so a LATER click is
 * instant — and doing it during the first paint was measured to be expensive:
 *
 * MEASURED (2026-10-22, the live client, cold sign-in, box load ~5–11): this
 * component reads the SIGNED-IN account's own profile, by fid and by username
 * (two profile-shaped reads), the moment the authed layout mounts. A
 * profile-shaped read COUNTS followers and following, and the node serves a
 * count as a paged log at `pageSize: 1000` — its count pages were still in
 * flight 5.3s, 1.7s and 1.7s later, in parallel with the ~240 reads the feed's
 * first cast was waiting on. Deferring the whole set costs nothing a reader can
 * see: by three seconds the feed is painted, and the profile page this fills in
 * has not been asked for yet.
 */
const PREFETCH_DELAY_MS = 3_000;

const PreloadAuthedResources: FC = memo(() => {
  const currentUser = useCurrentUser();

  const prefetchUser = usePrefetchUser();
  const prefetchUserByUsername = usePrefetchUserByUsername();
  const prefetchUserFollowingChannels = usePrefetchUserFollowingChannels();
  const prefetchActiveChannelStreak = usePrefetchActiveChannelStreak();

  useEffect(() => {
    const timer = setTimeout(() => {
      prefetchUser({
        fid: currentUser.fid,
        shouldSkipIfRecentlyPrefetched: true,
      });

      prefetchUserFollowingChannels({
        forComposer: true,
        shouldSkipIfRecentlyPrefetched: true,
      });

      if (currentUser.username) {
        prefetchUserByUsername({
          shouldSkipIfRecentlyPrefetched: true,
          username: currentUser.username,
        });
      }

      prefetchActiveChannelStreak({ fid: currentUser.fid });
    }, PREFETCH_DELAY_MS);

    return () => clearTimeout(timer);
  }, [
    currentUser.fid,
    currentUser.username,
    prefetchUser,
    prefetchUserByUsername,
    prefetchUserFollowingChannels,
    prefetchActiveChannelStreak,
  ]);

  return null;
});

PreloadAuthedResources.displayName = 'PreloadAuthedResources';

export { PreloadAuthedResources };
