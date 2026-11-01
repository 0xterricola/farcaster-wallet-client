import {
  FarcasterApiClient,
  FarcasterApiClientMetaOptions,
  OnError,
  OnFetchStart,
} from 'farcaster-client-data';
import {
  FarcasterApiClientProvider,
  useCachedOnboardingState,
} from 'farcaster-client-hooks';
import React, {
  FC,
  memo,
  ReactNode,
  useCallback,
  useMemo,
  useRef,
} from 'react';

import { baseApiUrl, localApiEnabled, wsUrl } from '~/constants/api';
import { isDev } from '~/constants/env';
import { useRecentFetch } from '~/contexts/RecentFetchProvider';
import { useCountsBehindSink } from '~/hooks/data/useCountsBehindSink';
import {
  RestoredFeedCountsProvider,
  type RestoredFeedCountsReader,
} from '~/hooks/data/useRestoredFeedCounts';
import { askForPostingKey } from '~/snapchain/accounts/postingKeyApproval';
import { isNodeBackedClientEnabled } from '~/snapchain/nodeApi';
import type { CastCountsSink } from '~/snapchain/nodeApi/reads';
import { noteWriteEvidence } from '~/snapchain/nodeApi/writeEvidenceWatch';
import { resolveEffectiveNodeBaseUrl } from '~/snapchain/nodeChoice';
import {
  createProviderBackedFetch,
  getActiveProvider,
  noteProviderReadResult,
  useProviderWatch,
} from '~/snapchain/providers';
import { useClientFilterPreferences } from '~/snapchain/useClientFilterPreferences';
import { useMutePreferences } from '~/snapchain/useMutePreferences';
import { useNodeChoice } from '~/snapchain/useNodeChoice';
import { Analytics } from '~/utils/analyticsUtils';
import { getPersistedDeviceId } from '~/utils/deviceIdUtils';

import { authOnError401Ref } from './authOnError401Ref';

const apiDebugEnabled = false;

type WebFarcasterApiClientProviderProps = {
  children: ReactNode;
};

const apiClient = new FarcasterApiClient();

const WebFarcasterApiClientProvider: FC<WebFarcasterApiClientProviderProps> =
  memo(({ children }) => {
    const { trackFetch } = useRecentFetch();

    // deviceId → FC-DEVICE-ID header. The backend's one-token-per-device
    // dedup keys on it; without it every web mint takes the noDeviceId path
    // and accumulates in auth-tokens:{fid} (see deviceIdUtils).
    const meta = useMemo(
      (): FarcasterApiClientMetaOptions => ({
        deviceId: getPersistedDeviceId(),
      }),
      [],
    );

    // Who the node-backed reads are about. The cached onboarding state is the
    // same source the shell renders the signed-in account from, and it never
    // fetches — which matters, because this has to answer synchronously inside
    // the client's requests, including the ones that run while the network is
    // what is broken.
    const signedInFid = useCachedOnboardingState().result.state.user?.fid;
    const signedInFidRef = useRef<number | undefined>(signedInFid);
    signedInFidRef.current = signedInFid;

    // The server this reader chose (a public one, or their own) is restored
    // here, once, and every node-backed surface below reads it from the same
    // store — the reads adapter, the writes client and the status pill can
    // never disagree about where answers came from.
    const nodeChoice = useNodeChoice(signedInFid);

    // The reader's client filter and their own names for other apps. Same
    // shape and same reason as the node choice above: the read seam below asks
    // the store synchronously on every request, so a filter changed on the
    // settings screen applies to the next page instead of waiting for a reload.
    useClientFilterPreferences(signedInFid);

    // The reader's own mutes, blocks and hidden words. Loaded here for the same
    // reason as the filter above: the seam below asks this store synchronously
    // on every request, so hiding somebody on a profile or a cast menu applies
    // to the next page instead of waiting for a reload.
    useMutePreferences(signedInFid);

    // The reader's servers, and which one is live right now.
    //
    // The watch starts here because this provider wraps every signed-in
    // surface: the fetch seam below reads the live choice synchronously, and a
    // surface that renders before the first check lands reads from the build's
    // own node exactly as it did before any of this existed.
    useProviderWatch(signedInFid);

    /**
     * Where a feed page's counts land when they arrive behind its paint.
     *
     * Registering this is what asks the seam for a page built WITHOUT its
     * like/recast counts (`~/hooks/data/useCountsBehindSink`): the page paints
     * as soon as its own reads are done, the counts are read behind it, and
     * they are merged onto the casts already on screen. See the card — a cold
     * first cast used to wait ~5.5 s for the slowest per-cast count read.
     *
     * Held in a ref and handed to the seam as one stable function, so the
     * adapter (built per node address, kept between requests) always calls the
     * current sink — the same shape as `signedInFidRef` above, and for the same
     * reason: the seam is not rebuilt when a hook identity changes.
     */
    const countsBehind = useCountsBehindSink();
    const countsBehindRef = useRef<CastCountsSink>(countsBehind);
    countsBehindRef.current = countsBehind;
    const onCountsRead = useCallback<CastCountsSink>(
      (counts) => countsBehindRef.current(counts),
      [],
    );

    /**
     * The read adapter the client is handed, now provider-aware.
     *
     * It replaces the hosted API as the client's data source: same `fetch`
     * signature, same request paths, and the answer comes from whichever server
     * the failover engine currently considers live — your own node, a public
     * one, Neynar, or Farcaster's own public server as a last resort. See
     * `~/snapchain/providers` for how that choice is measured and moved, and
     * `~/snapchain/nodeApi` for what is node-backed, what is local, and what
     * the node genuinely cannot answer.
     *
     * Not installed when the fork's mock API is on (`farcasterApi.local`):
     * that switch exists to serve the shell from a mock, and quietly rerouting
     * it to the node would make the mock lie about what it is showing.
     */
    const nodeBackedHandle = useMemo(() => {
      if (localApiEnabled || !isNodeBackedClientEnabled()) {
        return undefined;
      }
      return createProviderBackedFetch({
        // Asked fresh on every request, so a switch mid-session takes effect
        // on the very next read instead of needing the app to rebuild.
        getActiveProvider: () => getActiveProvider(),
        getSignedInFid: () => signedInFidRef.current,
        nodeBaseUrl: resolveEffectiveNodeBaseUrl(),
        fetchImpl: fetch,
        // Repeated read failures are part of the switch rule: a server that
        // passes its status check and fails every read still has to lose its
        // place.
        onRead: (providerId, ok) => noteProviderReadResult({ providerId, ok }),
        // A write with no key to sign it is not refused at the person: the
        // approval screen goes up where they are, and the very same write is
        // carried once they approve it (`postingKeyApproval` is the store that
        // screen and this seam share).
        askForPostingKey,
        // One write, one piece of evidence, handed on to whoever in the app has
        // to read it rather than guess — today the mini app agent bridge's
        // `post` ask (`docs/CLIENT-MINIAPP-AGENT-BRIDGE.md` §3.3). Read-only:
        // nothing about a write changes, and nothing is kept here.
        onWriteEvidence: noteWriteEvidence,
        // A feed page is answered without its engagement counts and the counts
        // are read behind the paint, landing on the casts already rendered
        // (see above, and `~/hooks/data/useCountsBehindSink`).
        onCountsRead,
      });
      // The address the build was configured with is the only input that can
      // change under a running tab and needs the adapter rebuilt; the live
      // provider is read per request, above. `nodeChoice` is read through the
      // store inside `resolveEffectiveNodeBaseUrl`, which the linter cannot
      // follow — it is still the input that decides the fallback address.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodeChoice]);

    const nodeBackedFetch = nodeBackedHandle?.fetch;

    /**
     * What a RESTORED feed page asks with — see
     * `~/hooks/data/useRestoredFeedCounts` for the whole of it.
     *
     * A page this browser kept (`~/lib/feedCache`) carries no engagement counts
     * and is not re-read, so it never has a count wave: the one thing missing
     * from it is the numbers. This is where the two halves are joined, in the
     * one component that owns both — the seam's own `readCastCounts` (a node
     * read for casts this browser already holds) and the sink their numbers land
     * in.
     *
     * `null` when this build has no node-backed client at all (the fork's mock
     * API, or the switch off): there is no node to ask, and the pages such a
     * build restores carry their counts, because the API it reads answers pages
     * with them.
     */
    const restoredFeedCountsReader = useMemo<RestoredFeedCountsReader | null>(
      () =>
        nodeBackedHandle
          ? {
              readCounts: nodeBackedHandle.readCastCounts,
              sink: countsBehind,
            }
          : null,
      [countsBehind, nodeBackedHandle],
    );

    const onFetchStart: OnFetchStart = useCallback(() => {
      trackFetch();
    }, [trackFetch]);

    // Single apiClient.onError owner. Delegate 401s to AuthProvider's
    // revalidation handler (registered via authOnError401Ref) so we probe
    // /v2/me before signing out, instead of tearing the session down on any
    // transient 401. Recovery/re-entry/stale-token guards live in that handler.
    const onError: OnError = useCallback(({ requestInfo, responseStatus }) => {
      if (responseStatus !== 401) {
        return;
      }
      // Don't loop on the deleteAuthToken call that sign-out makes.
      if (requestInfo.endpointName === 'deleteAuthToken') {
        return;
      }
      void authOnError401Ref.current?.({
        source: 'global_handler',
        endpointName: requestInfo.endpointName,
        responseStatus,
      });
    }, []);

    return (
      <FarcasterApiClientProvider
        apiClient={apiClient}
        address={undefined}
        baseUrl={baseApiUrl}
        wsUrl={wsUrl}
        debug={isDev && apiDebugEnabled}
        meta={meta}
        onError={onError}
        onFetchStart={onFetchStart}
        fetch={nodeBackedFetch ?? fetch}
        getDeviceId={Analytics.getDeviceId}
        getSessionId={Analytics.getSessionId}
      >
        {/* A restored feed page asks for its counts from inside here: this is
            the component that owns the seam a count is read through and the
            sink it lands in (see `restoredFeedCountsReader` above). */}
        <RestoredFeedCountsProvider reader={restoredFeedCountsReader}>
          {children}
        </RestoredFeedCountsProvider>
      </FarcasterApiClientProvider>
    );
  });

WebFarcasterApiClientProvider.displayName = 'WebFarcasterApiClientProvider';

export { WebFarcasterApiClientProvider };
