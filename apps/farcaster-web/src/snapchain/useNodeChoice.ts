/**
 * The chosen server, as a React value.
 *
 * Every surface that reads or writes through the node has to follow the same
 * choice, and has to notice when the reader changes it on the Advanced screen
 * without a reload. One store (`nodeChoice`) and this one subscription is how
 * that happens: components render from the active choice, and the effect below
 * is what loads it out of storage once the FID is known.
 */

import { useEffect, useSyncExternalStore } from 'react';

import {
  getActiveNodeChoice,
  loadActiveNodeChoice,
  subscribeToNodeChoice,
} from './nodeChoice';
import type { NodeChoice } from './nodePreferences';

/** The choice in use right now; re-renders when it changes. */
export const useActiveNodeChoice = (): NodeChoice | null =>
  useSyncExternalStore(
    subscribeToNodeChoice,
    getActiveNodeChoice,
    getActiveNodeChoice,
  );

/**
 * The choice in use, restored from this FID's storage.
 *
 * Storage is per FID (like the client filter and the labels), so a FID with no
 * stored choice — including a signed-out one — keeps the build's own
 * configuration. That is not a fallback for a broken choice: it is the default
 * the pill calls "Fiddy serves it".
 */
export const useNodeChoice = (fid: number | undefined): NodeChoice | null => {
  const choice = useActiveNodeChoice();

  useEffect(() => {
    if (fid === undefined) {
      return;
    }
    // Loading it IS the update: `loadActiveNodeChoice` notifies this same
    // store, so there is no second piece of state that could disagree with
    // what the rest of the client is reading from.
    void loadActiveNodeChoice(fid).catch(() => {
      // Unreadable storage must not stop the client from reading a feed.
      // With no choice active, the build's own configuration stays in use.
    });
  }, [fid]);

  return choice;
};
