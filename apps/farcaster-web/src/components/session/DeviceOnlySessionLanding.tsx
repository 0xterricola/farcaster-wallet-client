/**
 * What a device-only session is allowed to render.
 *
 * A device-only session cannot run the authed shell — every provider and region
 * in it is a farcaster.xyz read or write it has no token for (the measurement
 * is in ~/components/session/DeviceOnlySessionPage), so `AuthedLayout` hands it
 * the landing instead. But two of the surfaces routed inside that shell need
 * nothing from Farcaster: "Add a brain" and "Connect apps" are stored on this
 * device only, and `Router` routes them signed out as well, deliberately. The
 * landing itself offers them as buttons.
 *
 * Short-circuiting those two as well made the landing lie: measured on the real
 * API, clicking "Add a brain" changed the URL to /~/agent/brains and re-rendered
 * the landing, byte for byte — a button that does nothing, under copy claiming
 * the screen needs no sign-in at all. That is the same dishonesty the landing
 * exists to remove, so it is fixed here rather than by deleting the buttons.
 *
 * So the account-free paths render their real surfaces, inside the smallest
 * frame that can carry them: a line saying whose session this is (the account
 * stays on screen, as it does everywhere else in this work) and the route
 * itself. The frame mounts no provider that fetches, so nothing in it can fail
 * the way the authed shell does. Everything else still lands on the
 * device-only screen.
 */

import { ChevronLeft } from 'lucide-react';
import React, { FC, memo, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { ShellSectionErrorBoundary } from '~/components/errors/ShellSectionErrorBoundary';
import { Link } from '~/components/links/Link';
import { FullScreenLoadingIndicator } from '~/components/loaders/FullScreenLoadingIndicator';
import { DeviceOnlySessionPage } from '~/components/session/DeviceOnlySessionPage';
import {
  describeDeviceOnlyAccount,
  useDeviceOnlySession,
} from '~/components/session/useDeviceOnlySession';
import { routes } from '~/constants/routes';

/** Deliberately one entry per surface, not a prefix: nothing else under /agent
 *  is account-free, and a prefix would quietly widen this door later. */
const accountFreeDeviceOnlyPaths = new Set<string>([
  routes.fiddyBrains.path,
  routes.fiddyApps.path,
]);

const normalizePathname = (pathname: string): string => {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
};

const isAccountFreeDeviceOnlyPath = (pathname: string): boolean =>
  accountFreeDeviceOnlyPaths.has(normalizePathname(pathname));

const DeviceOnlySurfaceFrame: FC = memo(() => {
  const session = useDeviceOnlySession();
  const account = describeDeviceOnlyAccount(session);

  return (
    <div className="fiddy-surface fiddy-device-only-surface">
      <div className="fiddy-device-only-bar">
        <span className="fiddy-brand">
          <span className="fiddy-dot" aria-hidden="true">
            ●
          </span>
          fiddy
        </span>

        {account !== '' && (
          <span
            className="fiddy-device-only-account"
            data-fiddy="device-only-account"
          >
            {account}
          </span>
        )}

        <Link
          to="homeFeed"
          params={{}}
          searchParams={{}}
          title="Signed in on this device"
          className="fiddy-device-only-back"
        >
          <ChevronLeft aria-hidden="true" />
          Signed in on this device
        </Link>
      </div>

      <Suspense fallback={<FullScreenLoadingIndicator />}>
        {/* Same treatment as the shell's page column: a surface that cannot
            load says so in place rather than clearing the screen. */}
        <ShellSectionErrorBoundary label="This page">
          <Outlet />
        </ShellSectionErrorBoundary>
      </Suspense>
    </div>
  );
});

DeviceOnlySurfaceFrame.displayName = 'DeviceOnlySurfaceFrame';

const DeviceOnlySessionLanding: FC = () => {
  const { pathname } = useLocation();

  return isAccountFreeDeviceOnlyPath(pathname) ? (
    <DeviceOnlySurfaceFrame />
  ) : (
    <DeviceOnlySessionPage />
  );
};

DeviceOnlySessionLanding.displayName = 'DeviceOnlySessionLanding';

export { DeviceOnlySessionLanding, isAccountFreeDeviceOnlyPath };
