/**
 * The provider state, as React values.
 *
 * Two hooks, one store (`runtime.ts`):
 *
 *   useProviderSnapshot   read the live snapshot, re-rendering on every check
 *   useProviderWatch      read it *and* run the watching for a signed-in FID
 *
 * The watch is idempotent on purpose: the sidebar, the phone header and the
 * node settings page all mount it, and three mounts must not mean three timers
 * or three rounds of probes per minute. Starting it twice is starting it once.
 */

import { useEffect, useSyncExternalStore } from 'react';

import {
  getProviderSnapshot,
  type ProviderRuntimeSnapshot,
  startProviderWatch,
  stopProviderWatch,
  subscribeToProviders,
} from './runtime';

/** The live snapshot. Nothing is started by reading it. */
export const useProviderSnapshot = (): ProviderRuntimeSnapshot =>
  useSyncExternalStore(
    subscribeToProviders,
    getProviderSnapshot,
    getProviderSnapshot,
  );

/**
 * Keep watching while this component is mounted, and give it the state.
 *
 * `fid === undefined` means nobody is signed in: the reader's stored order is
 * per FID, so there is nothing to watch against and the snapshot is returned
 * unstarted (the pill then shows the build's own configuration, as before).
 */
export const useProviderWatch = (
  fid: number | undefined,
): ProviderRuntimeSnapshot => {
  const snapshot = useProviderSnapshot();

  useEffect(() => {
    if (fid === undefined) {
      return;
    }
    void startProviderWatch(fid).catch(() => {
      // A failed watch must not take a surface down: the client keeps reading
      // from whatever it was reading from, and the pill keeps its last story.
    });
    return () => {
      // The last mounted surface owns the loop; when everything unmounts, the
      // client is going away and so is the reason to poll.
      stopProviderWatch();
    };
  }, [fid]);

  return snapshot;
};
