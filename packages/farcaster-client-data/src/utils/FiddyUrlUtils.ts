/**
 * The URLs a fiddy.fun share copies.
 *
 * A share is a link somebody else will open, so it has to be a page this client
 * can render *and* a page a crawler can read. Those are two different
 * requirements and fiddy.fun only satisfies both for the routes below:
 *
 *   * `/~/conversations/<full hash>` — the same route the client's own
 *     Conversation page serves. The FULL hash, not the 10-character prefix
 *     `getCastURL` puts in an upstream link: the prefix form is a route this
 *     client reads through `/v2/user-thread-casts`, which no Snapchain node can
 *     answer, so a prefix link is a page we would hand somebody and then fail to
 *     open.
 *   * `/~/profiles/<fid>` — the profile route that reads by FID, which is what
 *     a node can answer.
 *
 * Neither carries the handle in the path, and that is the trade this makes:
 * `/dwr/0xec0c8a22` reads better but is the unanswerable one. The handle is not
 * lost — it is on the page, and it is on the unfurl card the link renders as
 * (`GET /unfurl/cards/cast/<hash>.png`).
 *
 * `getCastURL` is untouched for everything else (quote casts, composer
 * hydration, the mobile app): those are canonical NETWORK links, and pointing
 * another client's quotation at fiddy.fun would be a different product
 * decision than pointing our own share button at our own page.
 */

export const FIDDY_ORIGIN = 'https://fiddy.fun';

export const getFiddyCastUrl = ({ castHash }: { castHash: string }): string =>
  `${FIDDY_ORIGIN}/~/conversations/${castHash}`;

export const getFiddyProfileUrl = ({ fid }: { fid: number }): string =>
  `${FIDDY_ORIGIN}/~/profiles/${fid}`;