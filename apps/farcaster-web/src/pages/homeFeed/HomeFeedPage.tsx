import { EventingProvider } from 'farcaster-client-hooks';
import React, { useState } from 'react';

import { BorderedMainContent } from '~/components/BorderedMainContent';
import { ShellSectionErrorBoundary } from '~/components/errors/ShellSectionErrorBoundary';
import { FeedHeader } from '~/components/feeds/FeedHeader';
import { FullScreenLoadingIndicator } from '~/components/loaders/FullScreenLoadingIndicator';
import { DepositBonusModal } from '~/components/modals/DepositBonusModal';
import { Page } from '~/components/page/Page';
import { PageHeader } from '~/components/page/PageHeader';
import { PageTitle } from '~/components/page/PageTitle';
import { useAnalytics } from '~/contexts/AnalyticsProvider';
import { useHomeLastSelectedTab } from '~/contexts/HomeLastSelectedTabProvider';
import { useStandaloneMode } from '~/contexts/StandaloneModeProvider';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { useSearchParams } from '~/hooks/navigation/useSearchParams';
import { FollowingPage } from '~/lazy/pages';
import {
  openHomeFeedSession,
  scheduleHomeFeedSessionClose,
} from '~/utils/homeFeedSessionTracking';

import { HomeFeedPageContent } from './HomeFeedPageContent';

const HomeFeedPage = React.memo(() => {
  const isSignedIn = useIsSignedIn();

  if (!isSignedIn) {
    return (
      <Page
        meta={{
          title: 'Fiddy / Home',
          description: 'A decentralized social network',
          canonical: 'https://farcaster.xyz',
          twitterCard: 'summary',
        }}
      >
        <BorderedMainContent>
          <PageHeader footer={undefined}>
            <PageTitle>Home</PageTitle>
          </PageHeader>
          <EventingProvider on="home" channel="home">
            <React.Suspense fallback={<FullScreenLoadingIndicator />}>
              <ShellSectionErrorBoundary label="Home">
                <HomeFeedPageContent />
              </ShellSectionErrorBoundary>
            </React.Suspense>
          </EventingProvider>
        </BorderedMainContent>
      </Page>
    );
  }

  return <HomeFeedTabbed />;
});

HomeFeedPage.displayName = 'HomeFeedPage';

function HomeFeedTabbed() {
  const { inStandaloneMode } = useStandaloneMode();

  const { trackEvent } = useAnalytics();

  const { defaultFeed, feedKey } = useHomeLastSelectedTab();

  const searchParams = useSearchParams('homeFeed');
  const [showDepositBonusesModal, setShowDepositBonusesModal] =
    useState<boolean>(searchParams?.launchDepositBonusesInfo === 'true');

  const handleCloseDepositBonusesModal = React.useCallback(() => {
    setShowDepositBonusesModal(false);
  }, []);

  React.useEffect(() => {
    const props = {
      standalone: inStandaloneMode,
    };

    if (feedKey !== 'home') {
      scheduleHomeFeedSessionClose({ trackEvent });
      return;
    }

    const openSession = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }

      openHomeFeedSession({
        trackEvent,
        props,
      });
    };

    openSession();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        openSession();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [feedKey, inStandaloneMode, trackEvent]);

  if (feedKey === 'following') {
    return <FollowingPage />;
  }

  return (
    <Page
      meta={{
        title: 'Fiddy / Home',
        description: 'A decentralized social network',
        canonical: 'https://farcaster.xyz',
        twitterCard: 'summary',
      }}
    >
      <BorderedMainContent>
        <PageHeader
          footer={<FeedHeader defaultFeedTab={defaultFeed} tab="home" />}
        >
          <PageTitle>Home</PageTitle>
        </PageHeader>
        <EventingProvider on="home" key="home">
          <React.Suspense fallback={<FullScreenLoadingIndicator />}>
            {/* The feed's own reads fail like any other region's, so it answers
                like any other region: the adapter's sentence (or the session
                note) in the column, with the frame still standing. This used to
                be the fork's `FullScreenErrorBoundary`, whose fallback is the
                generic "Error retrieving data" / "Could not reach Farcaster" —
                a sentence that hides why, and, for a node that did not answer,
                offers no retry that could work. MEASURED: with the node
                black-holed this column showed nothing at all for as long as the
                page was open. */}
            <ShellSectionErrorBoundary label="Home">
              <HomeFeedPageContent />
            </ShellSectionErrorBoundary>
          </React.Suspense>
        </EventingProvider>
      </BorderedMainContent>
      {showDepositBonusesModal && (
        <DepositBonusModal onClose={handleCloseDepositBonusesModal} />
      )}
    </Page>
  );
}

export { HomeFeedPage };
