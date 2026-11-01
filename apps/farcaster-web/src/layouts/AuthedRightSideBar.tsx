import { FC, memo, Suspense, useMemo } from 'react';

import { AgentRailPanel } from '~/components/agent/AgentRailPanel';
import { ShellSectionErrorBoundary } from '~/components/errors/ShellSectionErrorBoundary';
import {
  MinimizableWindowHost,
  MinimizableWindowHostVariant,
} from '~/components/MinimizableWindowHost';
import { ClankerSpotlight } from '~/components/news/ClankerSpotlight';
import { MiniApps } from '~/components/rightSidebar/MiniApps';
import { TrendingTopics } from '~/components/rightSidebar/TrendingTopics';
import { Search } from '~/components/search/Search';
import { useCurrentRoute } from '~/hooks/navigation/useCurrentRoute';
import { RightSideBar } from '~/layouts/RightSideBar';
import { SupportAndTermsLinks } from '~/layouts/SupportAndTermsLinks';
import { lazyWithPreload } from '~/lazy/helpers';
import { cn } from '~/lib/utils';

/**
 * The "live now" card, loaded on its own.
 *
 * It asks the Space context whether any audio room is live, and that context
 * holds `livekit-client` — MEASURED (2026-10-22): 1.1 MB of source, and a
 * static import here put the whole WebRTC client inside the ENTRY chunk, which
 * defeated the lazy `SpaceProvider` in `AuthedLayout` (that file's own comment
 * says the provider is lazy precisely because livekit is sizeable). A card that
 * shows nothing on a quiet day has no business in the bundle that paints the
 * feed.
 */
const LiveNowSpaces = lazyWithPreload(() =>
  import('~/components/rightSidebar/LiveNowSpaces').then((module) => ({
    default: module.LiveNowSpaces,
  })),
);

const AuthedRightSideBar: FC = memo(() => {
  const currentRoute = useCurrentRoute();
  const routeFamily = currentRoute?.routeDefinition.family;
  const routeName = currentRoute?.routeName;

  const onDevelopersPage = routeName?.startsWith('developers');

  const shouldHideRightSidebar =
    routeFamily === 'settings' ||
    routeFamily === 'invites' ||
    routeFamily === 'directCasts' ||
    onDevelopersPage;

  const items = useMemo(() => {
    if (shouldHideRightSidebar) {
      return null;
    }
    return (
      <>
        <RightSideBar as="div">
          {/* The agent is one of the two things this client is for, so on the
              feed it gets the top of the right column — above search, above
              the fork's widgets, which all stay below it. */}
          {routeName === 'homeFeed' && <AgentRailPanel />}
          {routeFamily === 'search' ? <></> : <Search showClearIcon={false} />}
          {/* Every widget below reads from the hosted API, and some of those
              reads are exactly the ones a read node cannot answer (explore is a
              ranking, the channel directory and the mini-app catalog are
              Warpcast's own). Each gets its own boundary so the honest refusal
              lands in the rail, where that widget sits, instead of taking the
              feed down with it. See ~/components/errors/ShellSectionErrorBoundary. */}
          {routeFamily !== 'profile' && routeFamily !== 'news' && (
            <ShellSectionErrorBoundary label="Explore">
              <Suspense>
                <ClankerSpotlight />
              </Suspense>
            </ShellSectionErrorBoundary>
          )}
          <ShellSectionErrorBoundary label="Mini apps">
            <Suspense>
              <MiniApps />
            </Suspense>
          </ShellSectionErrorBoundary>
          {routeName === 'homeFeed' && (
            <ShellSectionErrorBoundary label="Spaces">
              <Suspense>
                <LiveNowSpaces />
              </Suspense>
            </ShellSectionErrorBoundary>
          )}
          <ShellSectionErrorBoundary label="Trending">
            <Suspense>
              <TrendingTopics />
            </Suspense>
          </ShellSectionErrorBoundary>
          <SupportAndTermsLinks />
        </RightSideBar>
      </>
    );
  }, [routeFamily, routeName, shouldHideRightSidebar]);

  let variant: MinimizableWindowHostVariant = 'sidebar';
  if (onDevelopersPage || routeFamily === 'settings') {
    variant = 'screen-right';
  } else if (routeFamily === 'directCasts') {
    variant = 'direct-casts';
  }

  return (
    <aside
      className={cn([
        'max-w-[393px] grow',
        { ['max-w-0']: variant === 'screen-right' },
      ])}
    >
      {items}
      <div
        className={cn([
          { hidden: variant === 'sidebar' && shouldHideRightSidebar },
        ])}
      >
        <MinimizableWindowHost variant={variant} />
      </div>
    </aside>
  );
});

export { AuthedRightSideBar };
