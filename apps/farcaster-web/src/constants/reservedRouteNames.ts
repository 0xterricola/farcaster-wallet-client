/**
 * The names that belong to the app, not to a person.
 *
 * A path segment the router answers to must not double as a handle. When it
 * did, a bare `/feed` or `/explore` fell through to the vanity profile route
 * (`/:username`) and rendered the profile of whichever Farcaster user happened
 * to be called @feed / @explore — months-stale strangers. A visitor typing a
 * plausible URL concluded the network was dead.
 *
 * THE SET IS DERIVED, NOT RETYPED
 * `derivedReservedRouteNames` walks the real route table in `./routes`, so a
 * route added there reserves its own segments with no edit here, and no route
 * can drift out of the reserved list. `APP_OWNED_NAMES` adds the app's
 * vocabulary that has no route yet — the names the browse surface and the
 * rest of the pivot are about to claim, plus `/u`, the namespace below.
 *
 * WHAT A RESERVED NAME MEANS
 *   `/feed`      the app's path (`/explore`, `/home`,
 *                `/notifications`, …). Never a profile.
 *   `/u/<name>`  the one address an account named after the app keeps: see
 *                `./reservedHandleRoutes`. Every link the app builds to such
 *                an account is rewritten into that namespace, so mentions,
 *                profile tabs and cast links keep working.
 *   `/alice`     a normal handle. Unchanged.
 *
 * A name is matched case-insensitively and after unicode/percent-encoding
 * normalization, because the URL is not the only place a name arrives from:
 * `Feed`, `fee%64` and a Cyrillic-lookalike `fееd` are all the same name as
 * `feed`. Claiming one is refused by the control plane (ivcained/legitmate-
 * farcaster `lib/reserved-route-names.ts`, which mirrors this vocabulary); this
 * module is what stops such a name from ever resolving as a handle at the
 * routing layer.
 */

import { routes } from './routes';

/** Syntax, never a name: the app prefix (`/~`), a fragment, a wildcard. */
const NON_NAME_SEGMENTS = new Set(['~', '#', '*']);

/** The path parameter that carries a handle, wherever a route has one. */
export const HANDLE_PARAM = 'username';

/**
 * The app's own vocabulary. `feed` and `explore` are the paths the browse
 * surface takes; the rest are names the app answers to by convention (and
 * several of them are routes already, in which case this list is a no-op for
 * them — the derivation above found them first).
 */
export const APP_OWNED_NAMES = [
  'about',
  'admin',
  'api',
  'auth',
  'discover',
  'embed',
  'explore',
  'feed',
  'home',
  'index',
  'login',
  'logout',
  'notifications',
  'search',
  'settings',
  'share',
  'signin',
  'signup',
  'trending',
  'u',
] as const;

/**
 * Every static segment of every route path in the app's route table.
 *
 * Params (`:username`), wildcards and the `~` prefix are not names; everything
 * else a URL can contain is app vocabulary and cannot be a handle.
 */
export const derivedReservedRouteNames: readonly string[] = (() => {
  const names = new Set<string>();

  for (const route of Object.values(routes)) {
    for (const segment of route.path.split('/')) {
      if (
        !segment ||
        segment.startsWith(':') ||
        NON_NAME_SEGMENTS.has(segment)
      ) {
        continue;
      }

      names.add(segment.toLowerCase());
    }
  }

  return [...names].sort();
})();

/** The canonical set: derived from the route table, plus the app's names. */
export const reservedRouteNames: ReadonlySet<string> = new Set([
  ...derivedReservedRouteNames,
  ...APP_OWNED_NAMES.map((name) => name.toLowerCase()),
]);

/**
 * Characters that look like ASCII letters but are not, so a claim of `fееd`
 * (Cyrillic `е`) cannot pass as a reserved name's lookalike either way: the
 * app reads it as `feed`, and the control plane refuses it as reserved.
 */
const HOMOGLYPHS: Record<string, string> = {
  а: 'a',
  с: 'c',
  е: 'e',
  ѕ: 's',
  і: 'i',
  ј: 'j',
  о: 'o',
  р: 'p',
  х: 'x',
  у: 'y',
  ԁ: 'd',
  һ: 'h',
  ӏ: 'l',
  ν: 'v',
};

const decodeOnce = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    // A half-written escape (`%6`) is not a URL: read it literally rather than
    // throwing away the whole comparison.
    return value;
  }
};

/**
 * The name a path segment or a submitted handle is *really* asking for:
 * percent-decoded (twice, for double-encoding), unicode-normalized (so
 * fullwidth `ｆｅｅｄ` is `feed`), lowercased, trimmed, with a stray trailing
 * slash dropped and lookalike characters folded to ASCII.
 *
 * Normalizing here is for *deciding*, never for writing back: a reserved name
 * is refused, not mangled into something else.
 */
export const normalizeRouteName = (raw: string | null | undefined): string => {
  if (typeof raw !== 'string') {
    return '';
  }

  return (
    decodeOnce(decodeOnce(raw))
      .normalize('NFKC')
      .trim()
      .replace(/\/+$/, '')
      .toLowerCase()
      // Non-ASCII only: ASCII needs no folding, and a control-character class
      // would be a lint error of its own.
      .replace(
        /[\u0080-\uffff]/g,
        (character) => HOMOGLYPHS[character] ?? character,
      )
  );
};

/** Is this path segment a name the app owns (case/unicode-insensitively)? */
export const isReservedRouteName = (
  raw: string | null | undefined,
): boolean => {
  const name = normalizeRouteName(raw);

  return name.length > 0 && reservedRouteNames.has(name);
};

/**
 * Does a router match address a reserved name as a handle? This is what makes
 * route precedence hold in the matching layer (`useCurrentRoute`,
 * `useIsCurrentRoute`): the vanity route's match is dropped, so the reserved
 * name resolves to the app's own route — or to the catch-all, never to a
 * profile.
 */
export const isReservedHandleMatch = (
  match:
    | { params?: Record<string, string | undefined> | undefined }
    | null
    | undefined,
): boolean => isReservedRouteName(match?.params?.[HANDLE_PARAM]);
