/**
 * The names the app owns, and the one thing that must be true of them: a URL
 * segment the app answers to can never be read as a handle.
 *
 * `feed` and `explore` are the finding this file exists for — both resolved
 * through the vanity profile route and rendered a stranger's stale profile.
 */

import { matchPath } from 'react-router-dom';

import {
  APP_OWNED_NAMES,
  derivedReservedRouteNames,
  isReservedHandleMatch,
  isReservedRouteName,
  normalizeRouteName,
  reservedRouteNames,
} from '~/constants/reservedRouteNames';
import { routes } from '~/constants/routes';

/** The vocabulary the app answers to, whatever the route table says. */
const APP_OWNED_VOCABULARY = [
  'feed',
  'explore',
  'home',
  'index',
  'settings',
  'notifications',
  'login',
  'signup',
  'signin',
  'logout',
  'search',
  'about',
  'api',
  'auth',
  'admin',
  'trending',
  'discover',
  'embed',
  'share',
];

describe('reserved route names', () => {
  it('reserves every name the app owns', () => {
    for (const name of APP_OWNED_VOCABULARY) {
      expect(reservedRouteNames.has(name)).toBe(true);
    }

    // The paths the browse surface is about to take are reserved *before* it
    // exists, so the profile route cannot hold the address in the meantime.
    expect(reservedRouteNames.has('feed')).toBe(true);
    expect(reservedRouteNames.has('explore')).toBe(true);
    // The `/u` namespace itself is never a handle.
    expect(reservedRouteNames.has('u')).toBe(true);
  });

  it('derives its route vocabulary from the real route table', () => {
    const segmentsOfRoutes = new Set<string>();

    for (const route of Object.values(routes)) {
      for (const segment of route.path.split('/')) {
        if (
          !segment ||
          segment.startsWith(':') ||
          segment === '*' ||
          segment === '#' ||
          segment === '~'
        ) {
          continue;
        }

        segmentsOfRoutes.add(segment.toLowerCase());
      }
    }

    expect(segmentsOfRoutes.size).toBeGreaterThan(0);

    for (const segment of segmentsOfRoutes) {
      expect(reservedRouteNames.has(segment)).toBe(true);
    }

    // Derived, not retyped: every derived name is in the canonical set.
    for (const derived of derivedReservedRouteNames) {
      expect(reservedRouteNames.has(derived)).toBe(true);
    }

    // Params, wildcards, fragments and the app prefix are syntax, not names.
    for (const notAName of [':username', ':fid', '*', '#', '~', '']) {
      expect(reservedRouteNames.has(notAName)).toBe(false);
    }
  });

  it('reads case, percent-encoding, trailing slash, unicode-lookalike and fullwidth variants as the same name', () => {
    const variantsOfFeed = [
      'feed',
      'Feed',
      'FEED',
      ' feed ',
      'feed/',
      'fee%64',
      'f%65%65d',
      '%66eed',
      'f\u0435\u0435d', // Cyrillic `е`, a homoglyph of `e`
      '\uff46\uff45\uff45\uff44', // fullwidth `ｆｅｅｄ`
    ];

    for (const variant of variantsOfFeed) {
      expect(isReservedRouteName(variant)).toBe(true);
      expect(normalizeRouteName(variant)).toBe('feed');
    }

    for (const handle of [
      'alice',
      'mochi-scout',
      'feedbag',
      'feed-me',
      'explores',
      'u2',
      undefined,
      null,
      '',
    ]) {
      expect(isReservedRouteName(handle)).toBe(false);
    }
  });

  it('drops a vanity handle match for a reserved name, and keeps it for a handle', () => {
    const profilePath = routes.profileCastsWithUsername.path;

    expect(
      isReservedHandleMatch(
        matchPath({ end: true, path: profilePath }, '/feed'),
      ),
    ).toBe(true);
    expect(
      isReservedHandleMatch(
        matchPath({ end: true, path: profilePath }, '/explore'),
      ),
    ).toBe(true);
    // Case-insensitive: `/Feed` is the same claim as `/feed`.
    expect(
      isReservedHandleMatch(
        matchPath({ end: true, path: profilePath }, '/Feed'),
      ),
    ).toBe(true);

    expect(
      isReservedHandleMatch(
        matchPath({ end: true, path: profilePath }, '/alice'),
      ),
    ).toBe(false);
    expect(isReservedHandleMatch(undefined)).toBe(false);
    expect(isReservedHandleMatch({ params: {} })).toBe(false);
  });

  it('never resolves a reserved path to a username route in the app route table', () => {
    for (const reservedPath of ['/feed', '/explore']) {
      const resolved: string[] = [];

      for (const [name, route] of Object.entries(routes)) {
        const match = matchPath({ end: true, path: route.path }, reservedPath);

        if (match && !isReservedHandleMatch(match)) {
          resolved.push(name);
        }
      }

      // Whatever the app gains at `/feed` later, it is never a profile.
      expect(resolved.filter((name) => /WithUsername$/.test(name))).toEqual([]);
      expect(resolved).not.toContain('profileCastsWithUsername');
    }
  });

  it('is declared once, so the claim vocabulary can mirror it', () => {
    // A single module owns the set; nothing else hard-codes the list.
    expect(new Set(APP_OWNED_NAMES).size).toBe(APP_OWNED_NAMES.length);
    expect(reservedRouteNames.size).toBe(
      new Set([...derivedReservedRouteNames, ...APP_OWNED_NAMES]).size,
    );
  });
});
