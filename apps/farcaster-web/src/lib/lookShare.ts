/**
 * Handing a look to someone else: one small thing we store, one link.
 *
 * WHERE IT TALKS. Same origin as this app, two routes on the host that serves it
 * (`fiddy.fun/look` and `fiddy.fun/look/<id>.json`), answered by the per-page
 * service this repo already ships (`server/unfurl/`) — the same one that answers
 * a cast or profile URL as itself. Nothing here names another origin, and a
 * shared look is never fetched from anyone else's host.
 *
 * WHY A LINK AND NOT THE WHOLE LOOK. A look is at most a few hundred bytes of
 * checked settings, so the link could have carried it inline. It does not,
 * because the point of a link is that it unfurls: a URL with the look inside it
 * has no picture, no title and nothing for a crawler to read, which is what
 * makes a shared look feel like something a person handed over. The host stores
 * the checked body once, under a hash of itself, and answers `{ id }`; a
 * thousand taps on the same link cost one small file.
 *
 * WHAT THE SERVER ANSWERS. `POST /look` with a look body answers `{ id }` or a
 * plain-English refusal (an empty look, a look carrying a picture, a body that
 * is too large). `GET /look/<id>.json` answers the stored look, or a 404 — which
 * is a sentence, never a blank card: "That look link doesn't work any more."
 */

import { cleanLook, Look } from '~/utils/lookTheme';

export const LOOK_SHARE_PATH = '/look';

export const sharedLookPath = (id: string): string =>
  `${LOOK_SHARE_PATH}/${encodeURIComponent(id)}.json`;

export type ShareLookResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

export type ReadLookResult =
  | { ok: true; look: Look }
  | { ok: false; error: string };

/** The one sentence a dead or unknown link gets, on every surface. */
export const LOOK_LINK_DEAD = "That look link doesn't work any more.";

const LOOK_SHARE_FAILED = "Fiddy couldn't save that look just now.";

/** The server's own sentence when it gave one; ours when it did not. */
const sentenceFrom = async (
  response: Response,
): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    return typeof body?.error === 'string' && body.error.trim()
      ? body.error.trim()
      : undefined;
  } catch {
    return undefined;
  }
};

/** Store a look and get the link's id back. */
export async function shareLook(
  look: Look,
  fetchImpl: typeof fetch = fetch,
): Promise<ShareLookResult> {
  let response: Response;
  try {
    response = await fetchImpl(LOOK_SHARE_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(look),
    });
  } catch {
    return { ok: false, error: LOOK_SHARE_FAILED };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: (await sentenceFrom(response)) ?? LOOK_SHARE_FAILED,
    };
  }

  try {
    const body = (await response.json()) as { id?: unknown } | null;
    if (typeof body?.id !== 'string' || !body.id) {
      return { ok: false, error: LOOK_SHARE_FAILED };
    }
    return { ok: true, id: body.id };
  } catch {
    return { ok: false, error: LOOK_SHARE_FAILED };
  }
}

/**
 * A look someone else shared.
 *
 * A missing link and an unreachable service answer the SAME sentence on
 * purpose: from the reader's side there is nothing useful in the difference, and
 * a card that says "server error" for a link whose look was never there is
 * worse than one that says the link does not work.
 */
export async function readSharedLook(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadLookResult> {
  try {
    const response = await fetchImpl(sharedLookPath(id), {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      return { ok: false, error: LOOK_LINK_DEAD };
    }
    const body = (await response.json()) as { look?: unknown } | null;
    if (!body || typeof body.look !== 'object' || body.look === null) {
      return { ok: false, error: LOOK_LINK_DEAD };
    }
    // The look is checked AGAIN here, on the reading side: what comes off the
    // wire is data from a stranger, and the only thing that may be applied is
    // what survives `cleanLook`.
    const look = cleanLook(body.look);
    return Object.keys(look).length
      ? { ok: true, look }
      : { ok: false, error: LOOK_LINK_DEAD };
  } catch {
    return { ok: false, error: LOOK_LINK_DEAD };
  }
}
