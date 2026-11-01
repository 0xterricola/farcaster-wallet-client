import {
  InternalEventingProvider,
  WebSocketsProvider,
} from 'farcaster-client-hooks';
import { FC, Suspense, useCallback, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';

import { EmbeddedWalletBridgeProvider } from '~/components/EmbeddedWallet';
import { FiddyMobileTabBar } from '~/components/fiddy/FiddyMobileTabBar';
import { FiddyTopBar } from '~/components/fiddy/FiddyTopBar';
import { ShellSkeleton } from '~/components/fiddy/ShellSkeleton';
import { useFiddyBrandGround } from '~/components/fiddy/useFiddyBrand';
import { PreloadAuthedResources } from '~/components/PrefetchAuthedResources';
import { DeviceOnlySessionLanding } from '~/components/session/DeviceOnlySessionLanding';
import { PostForYouStep } from '~/components/session/PostForYouStep';
import { SignerApprovalGate } from '~/components/session/SignerApprovalGate';
import { useDeviceOnlySession } from '~/components/session/useDeviceOnlySession';
import { EnsureCachedCurrentUser } from '~/components/users/EnsureCachedCurrentUser';
import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { AuthSessionRecoveryBridge } from '~/contexts/AuthSessionRecoveryBridge';
import { BespokeTransactionModalProvider } from '~/contexts/BespokeTransactionModalProvider';
import { CastComposerSessionProvider } from '~/contexts/CastComposerSessionProvider';
import { DirectCastsDraftsProvider } from '~/contexts/DirectCastsDraftsProvider';
import { DirectCastsProvider } from '~/contexts/DirectCastsProvider';
import { DirectCastsScrollLocksProvider } from '~/contexts/DirectCastsScrollLocksProvider';
import {
  HomeLastSelectedTabContextProvider,
  useHomeLastSelectedTab,
} from '~/contexts/HomeLastSelectedTabProvider';
// Frames v1 deprecated: remove legacy frame provider
import { MuteUserProvider } from '~/contexts/MuteUserProvider';
import { NotificationsInboxPrefetchProvider } from '~/contexts/NotificationsInboxPrefetchProvider';
import { PayUserProvider } from '~/contexts/PayUserProvider';
import { useStandaloneMode } from '~/contexts/StandaloneModeProvider';
import { UserAppContextProvider } from '~/contexts/UserAppContextProvider';
import { WalletLockedProvider } from '~/contexts/WalletLockedProvider';
import { WalletProvider } from '~/contexts/WalletProvider';
import { WebEventingProvider } from '~/contexts/WebEventingProvider';
import { WebExperimentationProvider } from '~/contexts/WebExperimentationProvider';
import { WebUnseenProvider } from '~/contexts/WebUnseenProvider';
import { useCurrentRoute } from '~/hooks/navigation/useCurrentRoute';
import { AuthedLeftSideBar } from '~/layouts/AuthedLeftSideBar';
import { AuthedRightSideBar } from '~/layouts/AuthedRightSideBar';
import { Container } from '~/layouts/Container';
import { MainContent } from '~/layouts/MainContent';
import { lazyWithPreload } from '~/lazy/helpers';
import { Analytics } from '~/utils/analyticsUtils';
import {
  closeFollowingFeedSession,
  openFollowingFeedSession,
  resumeFollowingFeedSession,
  scheduleFollowingFeedSessionClose,
  scheduleHiddenFollowingFeedSessionClose,
} from '~/utils/followingFeedSessionTracking';
import {
  closeHomeFeedSession,
  resumeHomeFeedSession,
  scheduleHiddenHomeFeedSessionClose,
  scheduleHomeFeedSessionClose,
} from '~/utils/homeFeedSessionTracking';
import { toastOptions } from '~/utils/toast';

// `SpaceProvider` pulls in `livekit-client` (a sizeable WebRTC dependency), so
// it stays in its own chunk rather than the main authed bundle. Rendering the
// lazy component starts the import during render — no explicit preload needed.
const LazySpaceProvider = lazyWithPreload(() =>
  import('~/contexts/SpaceContext').then((m) => ({ default: m.SpaceProvider })),
);

// This boundary sits above the shell's own chrome, so falling back to nothing
// here is falling back to a blank page: a reader mid-session would lose the top
// bar and the rail while a WebRTC chunk loads, and on a slow connection they
// would stay lost. The fallback is the shell itself, which is the same shape the
// document paints before the app runs — see ~/components/fiddy/ShellSkeleton.
const SpacesContainer: FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <LazySpaceProvider>{children}</LazySpaceProvider>
    </Suspense>
  );
};

const homeFeedRelatedRouteNames = new Set([
  'homeFeed',
  'conversationWithoutUsername',
  'conversationWithUsername',
  'compose',
]);

const followingFeedRelatedRouteNames = new Set([
  'following',
  'homeFeed',
  'conversationWithoutUsername',
  'conversationWithUsername',
  'compose',
]);

function HomeFeedSessionBoundary() {
  const { trackEvent } = useAnalytics();
  const currentRoute = useCurrentRoute();

  const routeName = currentRoute?.routeName;

  const closeSession = useCallback(() => {
    closeHomeFeedSession({ trackEvent });
  }, [trackEvent]);

  useEffect(() => {
    if (
      typeof routeName === 'undefined' ||
      !homeFeedRelatedRouteNames.has(routeName)
    ) {
      scheduleHomeFeedSessionClose({ trackEvent });
    }
  }, [routeName, trackEvent]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        scheduleHiddenHomeFeedSessionClose({ trackEvent });
        return;
      }

      if (
        typeof routeName !== 'undefined' &&
        homeFeedRelatedRouteNames.has(routeName)
      ) {
        // Resume the existing session on feed-related routes so tab switches
        // do not fragment one feed visit into multiple short sessions.
        resumeHomeFeedSession({ trackEvent });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', closeSession);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', closeSession);
      // Intentionally do not close the session on unmount. Layout/provider
      // remounts are not reliable feed-exit signals and would skew duration
      // metrics low.
    };
  }, [closeSession, routeName, trackEvent]);

  return null;
}

function FollowingFeedSessionBoundary() {
  const { trackEvent } = useAnalytics();
  const currentRoute = useCurrentRoute();
  const { feedKey } = useHomeLastSelectedTab();
  const { inStandaloneMode } = useStandaloneMode();

  const routeName = currentRoute?.routeName;

  const shouldOpenOnCurrentRoute =
    routeName === 'following' ||
    (routeName === 'homeFeed' && feedKey === 'following');
  const shouldResumeOnCurrentRoute =
    routeName === 'following' ||
    ((routeName === 'homeFeed' ||
      routeName === 'conversationWithoutUsername' ||
      routeName === 'conversationWithUsername' ||
      routeName === 'compose') &&
      feedKey === 'following');

  const closeSession = useCallback(() => {
    closeFollowingFeedSession({ trackEvent });
  }, [trackEvent]);

  useEffect(() => {
    if (!shouldOpenOnCurrentRoute && !shouldResumeOnCurrentRoute) {
      scheduleFollowingFeedSessionClose({ trackEvent });
      return;
    }

    if (document.visibilityState !== 'visible') {
      return;
    }

    if (shouldResumeOnCurrentRoute && !shouldOpenOnCurrentRoute) {
      resumeFollowingFeedSession({ trackEvent });
      return;
    }

    openFollowingFeedSession({
      trackEvent,
      props: {
        standalone: inStandaloneMode,
      },
    });
  }, [
    inStandaloneMode,
    shouldOpenOnCurrentRoute,
    shouldResumeOnCurrentRoute,
    trackEvent,
  ]);

  useEffect(() => {
    if (
      typeof routeName === 'undefined' ||
      !followingFeedRelatedRouteNames.has(routeName) ||
      !shouldResumeOnCurrentRoute
    ) {
      scheduleFollowingFeedSessionClose({ trackEvent });
    }
  }, [routeName, shouldResumeOnCurrentRoute, trackEvent]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        scheduleHiddenFollowingFeedSessionClose({ trackEvent });
        return;
      }

      if (shouldOpenOnCurrentRoute) {
        openFollowingFeedSession({
          trackEvent,
          props: {
            standalone: inStandaloneMode,
          },
        });
        return;
      }

      if (shouldResumeOnCurrentRoute) {
        resumeFollowingFeedSession({ trackEvent });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', closeSession);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', closeSession);
    };
  }, [
    closeSession,
    inStandaloneMode,
    shouldOpenOnCurrentRoute,
    shouldResumeOnCurrentRoute,
    trackEvent,
  ]);

  return null;
}

const AuthedLayout: FC = () => {
  const location = useLocation();
  const { inStandaloneMode } = useStandaloneMode();
  const deviceOnlySession = useDeviceOnlySession();

  // Fiddy ships dark; pin the ground while the shell is mounted.
  useFiddyBrandGround();

  // A session that exists only on this device cannot run this shell: every
  // surface below is a farcaster.xyz read or write, and this session has no
  // token for any of them. Landing the user here — named, explained, with the
  // account-free surfaces one tap away — is the honest outcome; mounting the
  // shell would only produce a broken client. The two account-free surfaces
  // themselves are the exception, and the landing links to them; see
  // ~/components/session/DeviceOnlySessionLanding.
  if (deviceOnlySession.isDeviceOnly) {
    return <DeviceOnlySessionLanding />;
  }

  return (
    <EnsureCachedCurrentUser>
      <UserAppContextProvider>
        <WebSocketsProvider>
          <SpacesContainer>
            <WebUnseenProvider>
              <NotificationsInboxPrefetchProvider>
                <MuteUserProvider>
                  <DirectCastsProvider>
                    <DirectCastsDraftsProvider>
                      <DirectCastsScrollLocksProvider>
                        <WebExperimentationProvider>
                          {/* InternalEventingProvider must be a child of FarcasterApiClientProvider and PubSubProvider */}
                          <InternalEventingProvider
                            onCastViewAccepted={(event) => {
                              Analytics.logAnalyticsOnlyEvent('cast.view', {
                                castHash: event.castHash,
                                ...(typeof event.castAuthorFid === 'number'
                                  ? { author_fid: event.castAuthorFid }
                                  : {}),
                                on: event.on,
                                channel: event.channel,
                                feed: event.feed,
                                ...(event.includeReason
                                  ? { includeReason: event.includeReason }
                                  : {}),
                                ...(event.includeReason
                                  ? { reason: event.includeReason }
                                  : {}),
                                ...(typeof event.index === 'number'
                                  ? { index: event.index }
                                  : {}),
                                ...(typeof event.index === 'number'
                                  ? { position: event.index }
                                  : {}),
                                ...(event.homeFeedSnapBoostVariant
                                  ? {
                                      homeFeedSnapBoostVariant:
                                        event.homeFeedSnapBoostVariant,
                                      home_feed_snap_boost_variant:
                                        event.homeFeedSnapBoostVariant,
                                    }
                                  : {}),
                                path: location.pathname,
                                warpcastPlatform: inStandaloneMode
                                  ? 'pwa'
                                  : 'web',
                              });
                            }}
                          >
                            {/* WebEventingProvider must be a child of WebExperimentationProvider */}
                            <WebEventingProvider>
                              <WalletLockedProvider>
                                <EmbeddedWalletBridgeProvider surface="full_warplet">
                                  <AuthSessionRecoveryBridge />
                                  <WalletProvider>
                                    <PayUserProvider>
                                      <HomeLastSelectedTabContextProvider>
                                        <BespokeTransactionModalProvider>
                                          <HomeFeedSessionBoundary />
                                          <FollowingFeedSessionBoundary />
                                          <CastComposerSessionProvider>
                                            <div className="fiddy-shell-frame fiddy-surface">
                                              <FiddyTopBar />
                                              <Container>
                                                <PreloadAuthedResources />
                                                <AuthedLeftSideBar />
                                                <MainContent />
                                                <AuthedRightSideBar />
                                                <ToastContainer
                                                  {...toastOptions}
                                                />
                                              </Container>
                                              {/* Keeps the phone's tab bar
                                                  from covering the last row. */}
                                              <div
                                                aria-hidden="true"
                                                className="h-16 sm:hidden"
                                              />
                                              <FiddyMobileTabBar />
                                              {/* The one-time "let Fiddy post
                                                  as you" offer: a reader should
                                                  not have to find Advanced to
                                                  learn that Fiddy can post for
                                                  them, and approving it is one
                                                  tap on their own phone. It
                                                  renders nothing unless the
                                                  offer applies. */}
                                              <PostForYouStep />
                                              {/* Pressing the heart, or
                                                  sending a cast, with no
                                                  posting key yet: the exact
                                                  write waiting is held by the
                                                  write seam and this is the
                                                  approval it asks for, in
                                                  place. It renders nothing
                                                  unless a write is waiting. */}
                                              <SignerApprovalGate />
                                            </div>
                                          </CastComposerSessionProvider>
                                        </BespokeTransactionModalProvider>
                                      </HomeLastSelectedTabContextProvider>
                                    </PayUserProvider>
                                  </WalletProvider>
                                </EmbeddedWalletBridgeProvider>
                              </WalletLockedProvider>
                            </WebEventingProvider>
                          </InternalEventingProvider>
                        </WebExperimentationProvider>
                      </DirectCastsScrollLocksProvider>
                    </DirectCastsDraftsProvider>
                  </DirectCastsProvider>
                </MuteUserProvider>
              </NotificationsInboxPrefetchProvider>
            </WebUnseenProvider>
          </SpacesContainer>
        </WebSocketsProvider>
      </UserAppContextProvider>
    </EnsureCachedCurrentUser>
  );
};

export { AuthedLayout };
