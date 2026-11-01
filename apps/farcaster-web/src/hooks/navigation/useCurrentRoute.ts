import { useMemo } from 'react';
import { matchPath, useLocation } from 'react-router-dom';

import { matchReservedHandleRoute } from '~/constants/reservedHandleRoutes';
import { isReservedHandleMatch } from '~/constants/reservedRouteNames';
import { routes } from '~/constants/routes';
import { RouteName } from '~/types';

/**
 * The route the current URL belongs to.
 *
 * Two rules, in this order:
 *
 * 1. The app's own routes are evaluated first, and a match that addresses a
 *    *reserved* name as a handle is dropped (see
 *    `~/constants/reservedRouteNames`) — `/feed` is the app's path, so it
 *    resolves to the app's route for it, or to the catch-all while that route
 *    does not exist yet. It never resolves to the profile of a user called
 *    @feed.
 * 2. `/u/<handle>` (see `~/constants/reservedHandleRoutes`) is the app's own
 *    address for an account whose name it owns: it resolves to that account's
 *    profile route, because that is what a reader on it is looking at.
 */
const useCurrentRoute = () => {
  const location = useLocation();

  return useMemo(() => {
    for (const [routeName, routeDefinition] of Object.entries(routes)) {
      const match = matchPath(
        {
          end: true,
          path: routeDefinition.path,
        },
        location.pathname,
      );

      if (match && !isReservedHandleMatch(match)) {
        return {
          routeName,
          routeDefinition,
          match,
        };
      }
    }

    const reservedHandle = matchReservedHandleRoute(location.pathname);

    if (reservedHandle) {
      return {
        routeName: reservedHandle.route.sourceName,
        routeDefinition: routes[reservedHandle.route.sourceName as RouteName],
        match: reservedHandle.match,
      };
    }

    return undefined;
  }, [location]);
};

export { useCurrentRoute };
