/**
 * Which account wrote a cast, asked of this origin.
 *
 * A Snapchain node shards by FID: `castById` needs the author as well as the
 * hash, and a cast URL carries only the hash (`reads.ts` says so at length, and
 * that is why the reader remembers the author of every cast it has served).
 * That memo is what a shared link cannot have — a reader opening
 * `fiddy.fun/~/conversations/0x…` has served nothing yet, and before this file
 * the honest refusal was the end of the page.
 *
 * So the SAME origin that answers a crawler with the cast's own card answers
 * the client with the one fact the crawler's page already carried: the FID.
 * One same-origin read, no key in the page, nothing cross-origin (the host's
 * CSP is `connect-src 'self'`), and the node still does all the reading — this
 * is an index of authors, not a copy of the network.
 *
 * MEASURED on this repo's own host: the service that answers it is
 * `server/unfurl/` (`GET /unfurl/cast-author/<hash>`), it is the same process
 * that drew the card on the other end of the link, and it holds Neynar — the
 * one index that answers a bare hash — on the server side of the wire. When
 * that service is not there, or has never seen the hash, this answers
 * `undefined` and the reader says what is missing rather than inventing a FID.
 */

export const CAST_AUTHOR_PATH = '/unfurl/cast-author';

/** The URL a cast's author is asked at, by hash. */
export const castAuthorUrl = (hash: string, base = ''): string =>
  `${base}${CAST_AUTHOR_PATH}/${encodeURIComponent(hash)}`;

export const fCastAuthorFromPayload = (
  payload: unknown,
): number | undefined => {
  const fid = Number((payload as { fid?: unknown } | null)?.fid);
  return Number.isSafeInteger(fid) && fid > 0 ? fid : undefined;
};

export const fetchCastAuthorFromOrigin = async ({
  hash,
  fetchImpl = fetch,
  baseUrl = '',
  timeoutMs = 8000,
}: {
  hash: string;
  fetchImpl?: typeof fetch;
  /** Empty in the app: the service is on this origin. Injectable for tests. */
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<number | undefined> => {
  if (!/^0x[0-9a-f]{40}$/i.test(hash)) {
    return undefined;
  }
  try {
    const response = await fetchImpl(castAuthorUrl(hash, baseUrl), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      credentials: 'omit',
    });
    if (!response.ok) {
      return undefined;
    }
    return fCastAuthorFromPayload(await response.json());
  } catch {
    // A lookup that could not be made is not an answer: the caller says what is
    // missing rather than guessing a FID.
    return undefined;
  }
};
