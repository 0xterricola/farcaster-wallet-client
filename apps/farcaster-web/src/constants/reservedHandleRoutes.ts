/**
 * `/u/<handle>` — the one address an account keeps when its name belongs to
 * the app.
 *
 * `/<name>` is the app's own path for a reserved name (`feed`, `explore`, …
 * see `./reservedRouteNames`), so it can never also be a profile URL. An
 * account that is *called* one of those names is not cut off by that: it is
 * served under this namespace, at `/u/feed`, and every link the app builds to
 * it (`hydratePath`) is rewritten into the namespace, which is why a mention,
 * a profile tab (`/u/feed/likes`) and a cast (`/u/feed/0xabc`) all still open
 * the right thing.
 *
 * THE FAMILY IS DERIVED FROM THE ROUTE TABLE
 * The vanity routes are the routes whose path is the handle form
 * (`/:username…`). Their `/u` twins are generated from those definitions —
 * same component, same params, prefixed path — so the two address families
 * cannot drift, and a vanity route added to `./routes` is addressable under
 * `/u` with no change here.
 */

import { ComponentType } from 'react';
import { matchRoutes, RouteMatch } from 'react-router-dom';

import { HANDLE_PARAM } from './reservedRouteNames';
import { routes } from './routes';

/** The namespace. Never a handle itself: `u` is in `APP_OWNED_NAMES`. */
export const reservedHandlePathPrefix = '/u';

const VANITY_HANDLE_PATH_PREFIX = `/:${HANDLE_PARAM}`;

export type VanityHandleRoute = {
  /**
   * Rendered with no props, which is how the router already renders every one
   * of these pages.
   */
  Component: ComponentType;
  /** The route's own name in the route table. */
  name: string;
  /** The vanity path, e.g. `/:username/likes`. */
  path: string;
};

export type ReservedHandleRoute = VanityHandleRoute & {
  /** The namespace path, e.g. `/u/:username/likes`. */
  path: string;
  /** The vanity path this entry was derived from. */
  sourceName: string;
  sourcePath: string;
};

/** Every handle-addressed ("vanity") route, straight from the route table. */
export const vanityHandleRoutes: readonly VanityHandleRoute[] = Object.entries(
  routes,
)
  .filter(([, route]) => route.path.startsWith(VANITY_HANDLE_PATH_PREFIX))
  .map(([name, route]) => ({
    name,
    path: route.path,
    // The union of every route's component type is wider than the pages that
    // actually appear here (some routes, like the channel page, take props);
    // the handle-addressed ones do not, and the router renders them as such.
    Component: route.Component as ComponentType,
  }));

/** The `/u` twins of those routes: one per vanity route, generated. */
export const reservedHandleRoutes: readonly ReservedHandleRoute[] =
  vanityHandleRoutes.map((route) => ({
    ...route,
    path: `${reservedHandlePathPrefix}${route.path}`,
    sourceName: route.name,
    sourcePath: route.path,
  }));

/** `/feed/likes` → `/u/feed/likes`. Used by the guard and by link hydration. */
export const toReservedHandlePath = (path: string): string =>
  `${reservedHandlePathPrefix}${path}`;

/** `/u/:username/likes` → `/:username/likes` (and `undefined` otherwise). */
export const reservedHandleSourcePath = (path: string): string | undefined =>
  path.startsWith(`${reservedHandlePathPrefix}${VANITY_HANDLE_PATH_PREFIX}`)
    ? path.slice(reservedHandlePathPrefix.length)
    : undefined;

/**
 * Match a pathname against the namespace, with React Router's own ranking (so
 * `/u/feed/likes` resolves to the likes tab, exactly as the router serves it,
 * not to whichever pattern happens to sit first in the table). Returning the
 * *source* route name is the point: a reader on `/u/feed/likes` is on the
 * profile's likes tab, and the hooks that watch the current route
 * (`useCurrentRoute`, layout and analytics) should see exactly that.
 */
export const matchReservedHandleRoute = (
  pathname: string,
): { match: RouteMatch; route: ReservedHandleRoute } | undefined => {
  const matches = matchRoutes([...reservedHandleRoutes], { pathname });
  const deepest = matches?.[matches.length - 1];

  if (!deepest) {
    return undefined;
  }

  return {
    match: deepest,
    route: deepest.route as unknown as ReservedHandleRoute,
  };
};
