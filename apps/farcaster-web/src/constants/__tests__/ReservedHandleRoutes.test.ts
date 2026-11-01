/**
 * `/u/<handle>` — where an account the app is named after stays reachable.
 *
 * The family is generated from the vanity route definitions, so this file
 * guards the generation: one twin per handle-addressed route, same page, no
 * collision with a route the app already serves, and a match that ranks the
 * way React Router ranks it.
 */

import {
  matchReservedHandleRoute,
  reservedHandlePathPrefix,
  reservedHandleRoutes,
  reservedHandleSourcePath,
  toReservedHandlePath,
  vanityHandleRoutes,
} from '~/constants/reservedHandleRoutes';
import { routes } from '~/constants/routes';

describe('the /u handle namespace', () => {
  it('has exactly one /u twin per handle-addressed route, read from the route table', () => {
    const vanityPaths = Object.entries(routes)
      .filter(([, route]) => route.path.startsWith('/:username'))
      .map(([, route]) => route.path)
      .sort();

    expect(vanityPaths.length).toBeGreaterThan(0);
    expect(vanityHandleRoutes.map((route) => route.path).sort()).toEqual(
      vanityPaths,
    );

    for (const route of reservedHandleRoutes) {
      expect(route.path).toBe(`${reservedHandlePathPrefix}${route.sourcePath}`);
    }
  });

  it('addresses the profile, its tabs and a cast without colliding with an app route', () => {
    const servedPaths = new Set<string>(
      Object.values(routes).map((route) => route.path),
    );

    for (const route of reservedHandleRoutes) {
      expect(servedPaths.has(route.path)).toBe(false);
    }

    expect(toReservedHandlePath('/feed')).toBe('/u/feed');
    expect(toReservedHandlePath('/feed/likes')).toBe('/u/feed/likes');
  });

  it('reads the namespace back to the route it was derived from', () => {
    expect(reservedHandleSourcePath('/u/:username/likes')).toBe(
      '/:username/likes',
    );
    expect(reservedHandleSourcePath('/:username/likes')).toBeUndefined();
    expect(reservedHandleSourcePath('/~/settings/storage')).toBeUndefined();
  });

  it('resolves the way the router serves it: the tab, not the cast pattern that sits first', () => {
    expect(matchReservedHandleRoute('/u/feed')?.route.sourceName).toBe(
      'profileCastsWithUsername',
    );
    expect(matchReservedHandleRoute('/u/feed/likes')?.route.sourceName).toBe(
      'profileLikesWithUsername',
    );
    expect(
      matchReservedHandleRoute('/u/feed/0xdeadbeef')?.route.sourceName,
    ).toBe('conversationWithUsername');

    // The namespace is the only address: `/<handle>` is the app's own path.
    expect(matchReservedHandleRoute('/feed')).toBeUndefined();
    expect(matchReservedHandleRoute('/feed/likes')).toBeUndefined();
  });
});
