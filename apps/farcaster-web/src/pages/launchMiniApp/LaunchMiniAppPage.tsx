import { addPathToUrl, injectQueryParams } from 'farcaster-client-data';
import {
  useFrameDetails,
  useGloballyCachedFrame,
} from 'farcaster-client-hooks';
import React from 'react';

import { FullScreenLoadingIndicator } from '~/components/loaders/FullScreenLoadingIndicator';
import { useIsSignedIn } from '~/hooks/data/useIsSignedIn';
import { useNavigate } from '~/hooks/navigation/useNavigate';
import { useParams } from '~/hooks/navigation/useParams';
import { useSearchParams } from '~/hooks/navigation/useSearchParams';
import { useRedirectToWarpcastMobile } from '~/hooks/useRedirectToWarpcastMobile';
import { HomeLandingPage } from '~/lazy/pages';

/**
 * Where a SIGNED-IN session goes once the frame it asked for is resolved.
 *
 * This is the only half of the launch route that needs the frame read, so it is
 * the only half that mounts it. The read is a suspense query
 * (`useFrameDetails`), and on the node-backed client there is no node-backed
 * frame reader — the adapter answers its honest 501, the query rejects, and
 * FullScreenErrorBoundary ABOVE the router catches it, so the whole page
 * becomes "Error retrieving data. Please try again.".
 *
 * Mounting that read for a signed-out visitor is what made the landing
 * unreachable: the frame read decides nothing for them — it exists to pick the
 * destination of a session — and the page behind it is the landing every
 * signed-out visitor should get. Measured on fiddy.fun at 5ea187d, signed out,
 * 1440x900: `/~/mini-apps/launch?domain=dwr.xyz` painted the error fallback,
 * so the 'run your own node →' link in HomeLandingPage was rendered nowhere on
 * the site.
 */
const LaunchMiniAppResolver: React.FC = () => {
  const navigate = useNavigate();

  const {
    domain: domainParam,
    url,
    ...extraParams
  } = useSearchParams('launchMiniApp');
  const { id, '*': path } = useParams('miniAppsCanonical');
  const domain = (() => {
    if (url) {
      return new URL(url).hostname;
    }

    return domainParam;
  })();

  const { data } = useFrameDetails({
    domain: id ? undefined : domain,
    id,
  });
  const frame = useGloballyCachedFrame(data);

  const queryParams = Object.entries(extraParams).reduce(
    (acc, [key, value]) => {
      if (value !== undefined) {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, string>,
  );

  React.useEffect(() => {
    if (!frame || frame.harmful) {
      navigate({
        to: 'miniApps',
        params: {},
        searchParams: {},
      });
      return;
    }

    navigate({
      to: 'homeFeed',
      params: {},
      searchParams: {
        launchFrameUrl: injectQueryParams(
          addPathToUrl(url ?? frame.homeUrl, path),
          queryParams,
        ),
      },
    });
  }, [frame, domain, navigate, url, queryParams, path]);

  return <FullScreenLoadingIndicator />;
};

LaunchMiniAppResolver.displayName = 'LaunchMiniAppResolver';

const LaunchMiniAppPage: React.FC = React.memo(() => {
  const isSignedIn = useIsSignedIn();

  useRedirectToWarpcastMobile();

  // Signed out, the landing IS the answer and it is painted BEFORE any frame
  // read, because the read is only ever a decision about where a session goes.
  if (!isSignedIn) {
    return <HomeLandingPage />;
  }

  return <LaunchMiniAppResolver />;
});

LaunchMiniAppPage.displayName = 'LaunchMiniAppPage';

export { LaunchMiniAppPage };
