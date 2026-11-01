/**
 * What this client does about Farcaster's own public server, now that it is
 * measured and known to be unreadable from a web page.
 *
 * MEASURED (2026-10-21, a real signed-in browser session on the live release at
 * https://fiddy.fun — the console of `scripts/verify-media-upload.mjs` against
 * the public origin):
 *
 *   - `GET https://api.farcaster.xyz/v2/unseen` → "Access to fetch … has been
 *     blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present
 *     on the requested resource."
 *   - the same for `/v1/audio-rooms` (twice per load, and again on every poll),
 *     `/v1/favorite-frames`, `/v1/get-trending-topics`,
 *     `/v2/highlighted-channels`, `/v2/direct-cast-inbox`, `/v2/explore-feed`,
 *     `/v2/feeds`, `/v2/channel-streaks`, `/v2/user-following-channels` and
 *     `/v2/user-thread-casts` — eleven distinct reads, none of them able to come
 *     back, which is most of the "66 console errors" that release probe counted.
 *   - `curl -sD- -H 'Origin: https://fiddy.fun'` on those same paths: every one
 *     answers `Vary: Origin` and NO `Access-Control-Allow-Origin`; only `/fc/*`
 *     is open (`access-control-allow-origin: *`).
 *
 * So a page on any other origin cannot read a single endpoint this client's data
 * layer uses. That matters here because this provider is in the reader's list,
 * and while the failover had it live — its probe used to ask the one path a page
 * MAY read, see `health.probeFarcasterPublic` — the client sent it every read it
 * had, twice a minute, for nothing.
 *
 * The provider stays in the catalog: the reader can see it in Advanced, the pill
 * can name it, and a context that really can read it (a native shell, a page on
 * an origin it allows) is not lied about. What changes is the seam: a request
 * that would go to it is refused here, in the words of its own classification,
 * instead of being fired at an origin the browser will throw away. Nothing is
 * given up — every one of those requests failed anyway, and it failed with
 * "Failed to fetch" instead of a reason.
 *
 * The one read from that server that DOES work from a page, `/fc/primary-address`,
 * is not routed through this seam (it is `farcaster-client-hooks`' own fetch), so
 * it is left exactly as it was.
 */

import type { HostedRouteMatch } from '~/snapchain/nodeApi/hostedRoutes';

/**
 * The status every refusal here is answered with: the hosted API's own error
 * envelope, so the client turns it into a `HandledFetchError` carrying the
 * sentence below — the same shape, and the same 501, the node-backed adapter
 * uses for the routes it cannot answer (`hostedRefusal`, `nodeBackedFetch.ts`).
 */
export const PUBLIC_SERVER_OFF_THE_WEB_STATUS = 501;

/**
 * Why this request did not go to Farcaster's own public server, in the reader's
 * words. Three shapes, because the three cases are honestly different:
 *
 *   - a write: that server takes no writes from this client at all.
 *   - a read a node assembles (`/v2/unseen`, a feed, a profile): it is the
 *     protocol's to answer, and the public server was never going to — a page
 *     may not read it, and it holds no session for the signed-in ones anyway.
 *   - a hosted-only feature (audio rooms, the direct-cast inbox, explore): the
 *     classification already says whose job it is; this client simply has no
 *     other source, because the one server that could have said more is off the
 *     web. The surface that asked shows this sentence.
 */
export const publicServerCannotAnswer = (
  route: Pick<HostedRouteMatch, 'kind' | 'method' | 'path' | 'why'>,
): string => {
  if (route.method !== 'GET' && route.method !== 'HEAD') {
    return `${route.method} ${route.path} is a write, and Farcaster's own public server does not take writes from this client. Posting goes through your node (or ours) instead.`;
  }
  if (route.kind === 'node') {
    return `${route.path} is read from a node — your own, or a public one you pick — and Farcaster's own public server cannot be read from a web page.`;
  }
  return `${route.why}. Farcaster's own public server cannot be read from a web page, so this client has no other source for it.`;
};

/**
 * The reason a probe of that server gives in a page: it is not asked, because
 * the answer is already measured.
 *
 * This build runs in a web page, and a page on another origin may not read that
 * server at all (see this file's header). So the honest sample is the one
 * already taken — reading it costs a CORS failure in the console once a minute,
 * for an answer that cannot change while the page is open. The reader sees this
 * as "not answering" on that row of Advanced, which is what it is from here.
 */
export const PUBLIC_SERVER_UNREADABLE_FROM_A_PAGE =
  'A page cannot read it at all: it permits its own origins only, and Fiddy runs in a page.';

/**
 * The reason a probe of that server gives when no answer comes back at all.
 *
 * In a browser a refused request and an unreachable host look identical to
 * JavaScript (`TypeError: Failed to fetch`), so this says both rather than
 * picking one and being wrong half the time.
 */
export const PUBLIC_SERVER_NO_ANSWER_REASON =
  'No answer came back: either it is unreachable from here, or this page is not allowed to read it.';
