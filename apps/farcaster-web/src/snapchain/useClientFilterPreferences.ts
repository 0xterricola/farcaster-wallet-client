/**
 * The client filter, as a React value.
 *
 * The store lives in `clientFilterPreferences` (synchronous, so the read seam
 * can consult it mid-request); this hook is the one subscription to it: it
 * loads the reader's stored filter and labels when the FID is known, and
 * re-renders when either changes.
 */

import { useEffect, useSyncExternalStore } from 'react';

import {
  type ActiveClientPreferences,
  getActiveClientPreferences,
  loadActiveClientPreferences,
  subscribeToClientPreferences,
} from './clientFilterPreferences';

/** The preferences in use right now; re-renders when they change. */
export const useActiveClientPreferences = (): ActiveClientPreferences | null =>
  useSyncExternalStore(
    subscribeToClientPreferences,
    getActiveClientPreferences,
    getActiveClientPreferences,
  );

/**
 * The preferences in use, restored from this FID's storage.
 *
 * Loading is the update: `loadActiveClientPreferences` notifies this same
 * store, so there is no second piece of state that could disagree with what the
 * feed is filtering by.
 */
export const useClientFilterPreferences = (
  fid: number | undefined,
): ActiveClientPreferences | null => {
  const active = useActiveClientPreferences();

  useEffect(() => {
    if (fid === undefined) {
      return;
    }
    void loadActiveClientPreferences(fid).catch(() => {
      // Unreadable storage must not stop the client from reading a feed: with
      // nothing loaded, no filter is applied and everything is shown.
    });
  }, [fid]);

  return active;
};
