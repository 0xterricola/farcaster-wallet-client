import { HelmetProvider } from '@dr.pogodin/react-helmet';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BlockedDomainsProvider, PubSubProvider } from 'farcaster-client-hooks';
import React, { FC, lazy, ReactNode, Suspense, useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';

import { ShellSkeleton } from '~/components/fiddy/ShellSkeleton';
import { Router } from '~/components/routing/Router';
import { AnalyticsProvider } from '~/contexts/AnalyticsProvider';
import { AuthProvider, useAuth } from '~/contexts/AuthProvider';
import { DirectCastToTakeActionProvider } from '~/contexts/DirectCastToTakeActionProvider';
import { FeedQueryCacheProvider } from '~/contexts/FeedQueryCacheProvider';
import { GlobalKeyPressProvider } from '~/contexts/GlobalKeyPressProvider';
import { HasUnmountedProvider } from '~/contexts/HasUnmountedProvider';
import { LinkDetailsPopoverManagerProvider } from '~/contexts/LinkDetailsPopoverManagerProvider';
import { LinkifyProvider } from '~/contexts/LinkifyProvider';
import { MiniAppProvider } from '~/contexts/MiniAppProvider';
import { MinimizableWindowProvider } from '~/contexts/MinimizableWindowProvider';
import { PopStateProvider } from '~/contexts/PopStateProvider';
import { RecentFetchProvider } from '~/contexts/RecentFetchProvider';
import { ScrollProvider } from '~/contexts/ScrollProvider';
import { SolanaWalletProvider } from '~/contexts/SolanaWalletProvider';
import { StandaloneModeProvider } from '~/contexts/StandaloneModeProvider';
import { ThemeProvider } from '~/contexts/ThemeProvider';
import { UnifiedMetaMaskProvider } from '~/contexts/UnifiedMetaMaskProvider';
import { VideoPlayStatusProvider } from '~/contexts/VideoPlayStatusProvider';
import { WebFarcasterApiClientProvider } from '~/contexts/WebFarcasterApiClientProvider';
import { InteractedSnapUrlsWebProvider } from '~/providers/InteractedSnapUrlsWebProvider';
import { PrivyRoot } from '~/providers/PrivyRoot';
import { wagmiConfig } from '~/utils/wagmi';

import { FullScreenErrorBoundary } from './errors/FullScreenErrorBoundary';
import { SnapWindowErrorListenerInstaller } from './SnapWindowErrorListenerInstaller';

// Keep the host sign-in/session seam out of the ordinary browser's entry
// chunk. The host SDK was already lazy; this makes its only eager consumer
// lazy too, without letting the rest of the app suspend behind it.
const MiniAppAutoSignIn = lazy(() =>
  import('./session/MiniAppAutoSignIn').then((module) => ({
    default: module.MiniAppAutoSignIn,
  })),
);

const AuthGatedBlockedDomainsProvider: FC<{ children: ReactNode }> = ({
  children,
}) => {
  const { authToken } = useAuth();
  return (
    <BlockedDomainsProvider enabled={!!authToken}>
      {children}
    </BlockedDomainsProvider>
  );
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      refetchOnMount: true,
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 3,
      gcTime: 1000 * 60 * 5,
    },
  },
});

/* The persisted query cache is not installed here.
 *
 * It used to be, at module scope, and it was DELETED on every load
 * (`localStoragePersister.removeClient()`) because the fork's surfaces are not
 * all built to see a restored page — so a re-open paid a full read again.
 * MEASURED (2026-10-22): a warm re-open took 23.7s at 1440 / 24.4s at 390 to
 * paint a cast, against 29.4s / 27.1s cold, i.e. keeping nothing bought nothing.
 *
 * `FeedQueryCacheProvider` installs the narrow version of it instead — the
 * feeds only, for the account that read them, for a day — and it can only do
 * that once that account is known. See `~/lib/feedCache` for the policy.
 */

/** The id the document gives the shell it paints before the app runs. */
const SHELL_SKELETON_ID = 'shell-skeleton';

/**
 * Hands the shell over from the document to the app.
 *
 * `index.html` carries the shell as static markup, so a reader looks at it from
 * the first paint — but it sits outside `#root`, because React clears its own
 * container before it paints anything, and a skeleton inside would be cleared
 * with it.
 *
 * It goes when the app has something to show, which is not the same moment as
 * the app's first commit: measured on a cold load, the first commit painted
 * nothing at all (an empty root for ~800 ms while the session and the route
 * resolved). So this waits for the app's first element to appear in `#root` —
 * a real surface or one of the shell's own fallbacks, which are the same shape
 * — and takes the document's copy away one painted frame later.
 */
const useShellSkeletonHandoff = () => {
  useEffect(() => {
    const skeleton = document.getElementById(SHELL_SKELETON_ID);
    const root = document.getElementById('root');
    if (!skeleton || !root) {
      return undefined;
    }

    let frame = 0;
    const handOver = () => {
      frame = requestAnimationFrame(() => {
        skeleton.remove();
      });
    };

    if (root.childElementCount > 0) {
      handOver();
      return () => cancelAnimationFrame(frame);
    }

    const observer = new MutationObserver(() => {
      if (root.childElementCount === 0) {
        return;
      }
      observer.disconnect();
      handOver();
    });
    observer.observe(root, { childList: true });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
};

const App: FC = () => {
  useShellSkeletonHandoff();

  return (
    <HelmetProvider>
      {/* This needs to be outside QueryClientProvider so that Wagmi uses a basic queryClient rather than our normal one with suspense */}
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <PopStateProvider>
            <HasUnmountedProvider>
              <ScrollProvider>
                <StandaloneModeProvider>
                  <GlobalKeyPressProvider>
                    <LinkDetailsPopoverManagerProvider>
                      <RecentFetchProvider>
                        {/* The shell is meant to be on screen whatever the
                              feed is doing, and this boundary sits above every
                              provider in it: anything that suspends up here
                              falls back to the shell and its loading column,
                              never to an empty page. The same shell is what the
                              document itself paints, so the reader sees one
                              shape from the first paint onwards. */}
                        <Suspense fallback={<ShellSkeleton />}>
                          <QueryClientProvider client={queryClient}>
                            {/* FullScreenErrorBoundary must be a child of QueryClientProvider */}
                            <FullScreenErrorBoundary>
                              <LinkifyProvider>
                                {/* WebFarcasterApiClientProvider must be a child of QueryClientProvider, AuthProvider, and RecentFetchProvider */}
                                <WebFarcasterApiClientProvider>
                                  {/* The kept feeds are restored for the
                                        account this session belongs to, so the
                                        provider needs the session and has to
                                        sit above AuthProvider (which removes
                                        that storage on sign-out). */}
                                  <FeedQueryCacheProvider>
                                    {/* AuthProvider must be a child of QueryClientProvider, AuthProvider, WebFarcasterApiClientProvider, and FeatureFlagProvider */}
                                    <AuthProvider>
                                      <AuthGatedBlockedDomainsProvider>
                                        <ThemeProvider>
                                          <AnalyticsProvider>
                                            <SnapWindowErrorListenerInstaller />
                                            {/* Inside a Farcaster Mini App host, the
                                                host already knows who this is:
                                                this signs in from its own context
                                                instead of showing a QR code the
                                                phone could not scan. Does nothing
                                                anywhere else. */}
                                            <Suspense
                                              fallback={<ShellSkeleton />}
                                            >
                                              <MiniAppAutoSignIn />
                                            </Suspense>
                                            <InteractedSnapUrlsWebProvider>
                                              <PubSubProvider>
                                                <VideoPlayStatusProvider>
                                                  <DirectCastToTakeActionProvider>
                                                    <MiniAppProvider>
                                                      <MinimizableWindowProvider>
                                                        <BrowserRouter>
                                                          <UnifiedMetaMaskProvider>
                                                            <SolanaWalletProvider>
                                                              {/* Privy's provider is mounted here, low and
                                                                  late: it appears only when this build has an
                                                                  app id, and only once its chunk has arrived,
                                                                  so nothing above it waits for a third-party
                                                                  script. See ~/providers/PrivyRoot. */}
                                                              <PrivyRoot>
                                                                <Router />
                                                              </PrivyRoot>
                                                            </SolanaWalletProvider>
                                                          </UnifiedMetaMaskProvider>
                                                        </BrowserRouter>
                                                      </MinimizableWindowProvider>
                                                    </MiniAppProvider>
                                                  </DirectCastToTakeActionProvider>
                                                </VideoPlayStatusProvider>
                                              </PubSubProvider>
                                            </InteractedSnapUrlsWebProvider>
                                          </AnalyticsProvider>
                                        </ThemeProvider>
                                      </AuthGatedBlockedDomainsProvider>
                                    </AuthProvider>
                                  </FeedQueryCacheProvider>
                                </WebFarcasterApiClientProvider>
                              </LinkifyProvider>
                            </FullScreenErrorBoundary>
                          </QueryClientProvider>
                        </Suspense>
                      </RecentFetchProvider>
                    </LinkDetailsPopoverManagerProvider>
                  </GlobalKeyPressProvider>
                </StandaloneModeProvider>
              </ScrollProvider>
            </HasUnmountedProvider>
          </PopStateProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </HelmetProvider>
  );
};

export { App };
