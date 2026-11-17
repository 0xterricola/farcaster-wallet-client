/**
 * A mini app's manifest, read through OUR host — never the app's.
 *
 * `GET /api/manifest?v=1&origin=…` is the per-origin proxy the unfurl service
 * answers (`server/miniapp/manifest.mjs`): the browser asks fiddy.fun, and
 * fiddy.fun — not the browser — talks to the app's host. A signed-out reader
 * on the node-only chain has no hosted API to ask for an app's name, and this
 * is the answer: the request stays first party, the app's host never learns
 * who opened the card, and every reader of one origin shares one cached read.
 *
 * The launch URL itself is NOT taken from here. The cast's `fc:miniapp` tag
 * already names the address the button opens (read client-side in
 * `~/snapchain/nodeApi/embedCards.ts`, never guessed); the manifest only
 * supplies what a launch surface draws around it: the app's name, its icon,
 * its splash. When a hosted API is available its frame details are still
 * preferred (`useNonSuspenseFrameDetails`); this is the fallback that makes
 * the launch work with zero Neynar, not a replacement for it.
 *
 * THE ONE-HOUR RULE (card t_f50c14a1, quilcast 0.70.1): a manifest carries
 * the app's launch address, so no cache layer may hold it longer than an
 * hour. The `v=1` in the path is that rule's client half — bumping it
 * invalidates every stored payload at once, because a server-side purge
 * cannot reach a browser that already kept one. The in-memory cache below
 * is ten minutes, matching the server's.
 */

/** What a launch surface can use from `/.well-known/farcaster.json`. */
export type MiniAppManifest = {
  name?: string;
  iconUrl?: string;
  homeUrl?: string;
  splashImageUrl?: string;
  splashBackgroundColor?: string;
};

/**
 * The versioned cache key. Bump when the answer's shape changes — this is
 * the one lever that reaches browsers a server purge cannot.
 */
const MANIFEST_PATH_VERSION = 1;
const MANIFEST_CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<
  string,
  { at: number; manifest: MiniAppManifest | null }
>();
const inFlight = new Map<string, Promise<MiniAppManifest | null>>();

const isMiniAppManifest = (value: unknown): value is MiniAppManifest => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return Object.entries(candidate).every(
    ([key, entry]) =>
      [
        'name',
        'iconUrl',
        'homeUrl',
        'splashImageUrl',
        'splashBackgroundColor',
      ].includes(key) &&
      (entry === undefined || typeof entry === 'string'),
  );
};

/**
 * One origin's manifest, or `null` when this host could not read one.
 *
 * `fetchImpl` and `now` are seams for tests; a caller never passes them.
 */
export const fetchMiniAppManifest = async (
  origin: string,
  {
    fetchImpl = (...args: Parameters<typeof fetch>) => fetch(...args),
    now = () => Date.now(),
  }: {
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<MiniAppManifest | null> => {
  if (!/^https:\/\//i.test(origin)) {
    return null;
  }
  const hit = cache.get(origin);
  if (hit && now() - hit.at < MANIFEST_CACHE_TTL_MS) {
    return hit.manifest;
  }
  const running = inFlight.get(origin);
  if (running) {
    return running;
  }
  const read = (async () => {
    try {
      const response = await fetchImpl(
        `/api/manifest?v=${MANIFEST_PATH_VERSION}&origin=${encodeURIComponent(origin)}`,
        // Same-origin, and anonymous of the session: the read is a fact about
        // an app, not about the reader.
        { credentials: 'omit' },
      );
      if (!response.ok) {
        return null;
      }
      const parsed = (await response.json()) as unknown;
      return isMiniAppManifest(parsed) ? parsed : null;
    } catch {
      // A host that did not answer is not an answer: the launch surface keeps
      // what it already knew (the card's own tags) rather than failing on it.
      return null;
    }
  })();
  inFlight.set(origin, read);
  const manifest = await read;
  inFlight.delete(origin);
  cache.set(origin, { at: now(), manifest });
  return manifest;
};
