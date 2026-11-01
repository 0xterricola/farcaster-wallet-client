import { useMemo } from 'react';
import { matchRoutes, useLocation } from 'react-router-dom';

import {
  reservedHandleRoutes,
  reservedHandleSourcePath,
} from '~/constants/reservedHandleRoutes';
import { isReservedHandleMatch } from '~/constants/reservedRouteNames';
import { routesArray } from '~/constants/routes';
import { Route } from '~/types';

/**
 * Is the app currently on the route with this path?
 *
 * Route precedence applies here too: a reserved name is never read as a handle,
 * so the vanity profile route does not read as current on `/feed`. A reader on
 * `/u/<handle>` *is* on that route's page — the namespace is matched as the
 * route it was derived from — so tab and sidebar highlighting survives the
 * namespace.
 */
const useIsCurrentRoute = ({ path }: Pick<Route, 'path'>) => {
  const location = useLocation();

  return useMemo(() => {
    const matches = matchRoutes(
      [...routesArray, ...reservedHandleRoutes],
      location,
    );

    return (matches || []).some((match) => {
      if (isReservedHandleMatch(match)) {
        return false;
      }

      const matchedPath = match.route.path as string;

      return (reservedHandleSourcePath(matchedPath) ?? matchedPath) === path;
    });
  }, [location, path]);
};

export { useIsCurrentRoute };
