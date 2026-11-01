# Reserved route names, and `/u/<handle>`

A path segment the app answers to is not a handle. `/feed` is fiddy.fun's own
address for browsing, so it is not the address of whoever is called @feed.

This is the fix for a verified finding (2026-10-23): signed out, `/feed` and
`/explore` matched the handle-addressed ("vanity") route `/:username` and
rendered the profile of the Farcaster users literally called @feed and
@explore — months-stale strangers. A visitor typing a plausible URL concluded
the whole network was dead.

## The set

One module: `apps/farcaster-web/src/constants/reservedRouteNames.ts`.

It is **derived from the route table** (`src/constants/routes.ts`), not retyped:
every static segment of every route path is reserved, so a route added to the
table reserves its own segments with no edit to the list, and the two cannot
drift. `APP_OWNED_NAMES` adds the vocabulary the app claims but has no route for
yet — `feed`, `explore`, `home`, `index`, `trending`, `u`, and the rest of the
sign-in and settings words.

Matching is case-insensitive and normalized: `Feed`, `fee%64`, ` feed/`,
fullwidth `ｆｅｅｄ` and a Cyrillic-lookalike `fееd` are all the same name as
`feed`. Normalization decides, it never rewrites.

## Where precedence is enforced

| Layer | File | What it does |
| --- | --- | --- |
| Route matching | `src/components/routing/ReservedHandleGuard.tsx` (wraps the vanity routes in `Router.tsx`) | A reserved first segment never renders a profile. `/feed` goes to the app's own route for it — React Router ranks a static segment above `/:username` — or to the front door while that route does not exist yet. |
| Current-route hooks | `src/hooks/navigation/useCurrentRoute.ts`, `useIsCurrentRoute.ts` | A vanity match for a reserved name is dropped, so `/feed` resolves to the app's route (or the catch-all), never to `profileCastsWithUsername`. |
| Link building | `src/utils/navUtils.ts` (`hydratePath`) | Links to an account whose name is reserved are built in the `/u` namespace (below), so mentions, tabs and cast links keep opening the account. |
| Claiming and editing | `ivcained/legitmate-farcaster` → `lib/reserved-route-names.ts`, used by `lib/farcaster-username.ts` and `lib/fiddy-profile.ts` | The same vocabulary, plus Fiddy's host names, is refused at claim time with `RESERVED_USERNAME` (HTTP 400) and a sentence saying why. |

## `/u/<handle>` — the accounts that already exist

@feed and @explore are real Farcaster accounts, and this change does not delete
them. It takes their *bare* address away, because that address is the app's.

**Decision:** an account whose name the app owns is reachable only through the
explicit namespace `/u/<handle>`. There is no second scheme, and nothing is
redirected back into the vanity form:

| URL | Renders |
| --- | --- |
| `/feed` | the app's browse surface (or the front door until it exists) — never a profile |
| `/u/feed` | the profile of @feed |
| `/u/feed/likes` | that profile's likes tab |
| `/u/feed/0xabc…` | a cast by @feed |
| `/alice` | @alice's profile, unchanged |

The namespace is generated, not hand-listed: `src/constants/reservedHandleRoutes.ts`
walks the route table for the handle-addressed routes (`/:username…`) and builds
one `/u` twin per route — same component, same params, prefixed path. Add a
vanity route and its `/u` twin appears; there is no parallel table to keep in
step. `u` itself is in `APP_OWNED_NAMES`, so no one can be named after it.

Links follow: `hydratePath` rewrites a link to a reserved handle into the
namespace, which is why a mention of @feed in a cast, a profile tab and a shared
cast URL all keep working instead of landing on the front door.

## Tests

| File | Pins |
| --- | --- |
| `src/constants/__tests__/ReservedRouteNames.test.ts` | membership, derivation from the route table, normalization, and that no reserved path resolves to a `…WithUsername` route |
| `src/constants/__tests__/ReservedHandleRoutes.test.ts` | one `/u` twin per vanity route, no collision with a served path, namespace ranking (`/u/feed/likes` is the likes tab) |
| `src/utils/__tests__/navUtils.test.ts` | the link rewrite, and that `/alice` and `/~/r/:username` are untouched |
| `src/components/routing/__tests__/ReservedHandleGuard.test.tsx` | `/feed`, `/explore`, `/Feed`, `/fee%64` render no profile; `/alice` still does; an app route at a reserved path wins |
| `../legitmate-farcaster/tests/reserved-route-names.test.ts` | the claim layer: both validators agree on every reserved name, `feed`/`Feed`/`fee%64` are refused with 400 |