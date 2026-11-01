/**
 * The reader's mutes, as a React value.
 *
 * The store lives in `mutePreferences` (synchronous, so the read seam can
 * consult it mid-request); this hook is the one subscription to it: it loads
 * the reader's stored list when the FID is known, and re-renders when it
 * changes. Everything that draws a mute — the settings rows, the quote
 * placeholder — reads the same subscription, so a change can never half-happen.
 */

import { useEffect, useSyncExternalStore } from 'react';

import {
  type ActiveMutes,
  getActiveMutes,
  loadActiveMutes,
  subscribeToMutes,
} from './mutePreferences';

/** The list in use right now; re-renders when it changes. */
export const useActiveMutes = (): ActiveMutes | null =>
  useSyncExternalStore(subscribeToMutes, getActiveMutes, getActiveMutes);

/**
 * The list in use, restored from this FID's storage.
 *
 * Loading is the update: `loadActiveMutes` notifies this same store, so there is
 * no second piece of state that could disagree with what the seam is hiding by.
 *
 * A FID that is not signed in loads nothing, and the seam then hides nothing —
 * which is the honest answer for a visitor browsing the public feed, not a
 * filter borrowed from whoever used this browser last. (Sign-out leaves the
 * address for the front door, which reloads the app, so a previous reader's list
 * cannot outlive their session in the first place.)
 */
export const useMutePreferences = (
  fid: number | undefined,
): ActiveMutes | null => {
  const active = useActiveMutes();

  useEffect(() => {
    if (fid === undefined) {
      return;
    }
    void loadActiveMutes(fid).catch(() => {
      // Unreadable storage must not stop the client from reading a feed: with
      // nothing loaded, nothing is hidden and everything is shown.
    });
  }, [fid]);

  return active;
};
