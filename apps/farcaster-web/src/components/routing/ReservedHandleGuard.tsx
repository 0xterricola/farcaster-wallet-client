import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { reservedHandlePathPrefix } from '~/constants/reservedHandleRoutes';
import { isReservedRouteName } from '~/constants/reservedRouteNames';
import { defaultRoute } from '~/constants/routes';

/**
 * A reserved name is the app's, not an account's.
 *
 * This wraps the handle-addressed ("vanity") routes, which are the only place
 * a path segment is read as a handle. A reserved first segment therefore never
 * reaches a profile page:
 *
 *   `/feed`        the app's path. The app's own route for it wins the match
 *                  when one exists (React Router ranks a static segment above
 *                  `/:username`); until then the front door is the honest
 *                  answer — never a stranger's profile.
 *   `/feed/likes`  a handle *with* a tail: that is an account the app is named
 *                  after, so it is served under the explicit `/u` namespace.
 *   `/alice`       a normal handle: rendered as before.
 */
const ReservedHandleGuard = () => {
  const { pathname } = useLocation();

  // The guard only ever wraps routes of the form `/:username…`, so the first
  // segment of the path is the handle being addressed.
  const [handle, ...tail] = pathname.split('/').filter(Boolean);

  if (!isReservedRouteName(handle)) {
    return <Outlet />;
  }

  return (
    <Navigate
      replace
      to={
        tail.length > 0
          ? `${reservedHandlePathPrefix}${pathname}`
          : defaultRoute.path
      }
    />
  );
};

ReservedHandleGuard.displayName = 'ReservedHandleGuard';

export { ReservedHandleGuard };
