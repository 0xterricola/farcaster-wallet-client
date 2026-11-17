/**
 * The per-origin mini app manifest this host reads for the browser.
 *
 *   GET /api/manifest?origin=https://example.com
 *
 * WHY THIS EXISTS
 *
 * A mini app's launch surface wants what the app declares in its
 * `/.well-known/farcaster.json`: its name, its icon, its splash. The cast's
 * `fc:miniapp` tag carries the card (image, button, action URL) — that half is
 * read client-side from the page itself (`src/snapchain/nodeApi/embedCards.ts`)
 * — but the tag says nothing about the app's NAME, and a browser that is not
 * signed in to a hosted API has nobody left to ask. The pattern this follows is
 * quilcast's (MIT, backmeupplz/quilcast, `server/notify.mjs`): the app's host
 * is the only third party involved, and it is OUR server that talks to it, so
 * the reader's address never leaves first party.
 *
 * WHAT IT DOES
 *
 *   - validates the `origin` parameter BEFORE any fetch: https only, no
 *     credentials in the URL, no port other than the default — and `safeGet`
 *     (the same guarded fetcher the picture proxy uses) re-checks every hop of
 *     every redirect against the public internet, so a manifest "origin" can
 *     never aim this service at a private address;
 *   - reads `<origin>/.well-known/farcaster.json`, capped at 64 KB, and keeps
 *     only the fields a launch surface can use: `miniapp` (or the older
 *     `frame`) name, iconUrl, homeUrl, splashImageUrl, splashBackgroundColor;
 *   - keeps one answer per origin for ten minutes.
 *
 * THE ONE-HOUR RULE (card t_f50c14a1, from quilcast 0.70.1)
 *
 * The manifest carries the app's launch address, so a cached copy that outlives
 * a moved app keeps opening the OLD one. Quilcast's own lesson was a day-long
 * cache; the rule that came out of it is a ceiling of one hour — server-side
 * AND in the HTTP header AND with a versioned client cache key, so a browser
 * that already stored a payload is reached too. Ten minutes sits under the
 * ceiling and matches quilcast's own manifest cache; nothing here may raise it
 * past 3_600_000 ms without re-reading that lesson.
 *
 * WHAT IT REFUSES TO DO
 *
 *   - It never answers `webhookUrl`. This host runs no mini app notifications
 *     yet (see the deferred follow-up on the card), and a webhook address is
 *     not a launch surface's business — it is stripped here, not hidden by the
 *     caller.
 *   - It never invents a manifest. An origin that answers nothing, or
 *     something that is not a manifest, is `null` — and the caller says so in
 *     one sentence rather than drawing a card from a guess.
 *   - It never fetches an origin naming THIS host: the reader's own manifest
 *     is already first-party, and looping the service back at itself is how
 *     proxies become amplifiers. (quilcast's `notify.mjs` refuses the same.)
 */

/** The most a manifest read may cost: at the ceiling of the one-hour rule. */
export const MANIFEST_TTL_MAX_MS = 3_600_000;
/** Default: ten minutes, quilcast's own manifest cache, well under the ceiling. */
export const MANIFEST_TTL_MS = 600_000;
/** A manifest is a small document; the spec's own cap is bytes, not pages. */
export const MANIFEST_MAX_BYTES = 64 * 1024;
/** How many origins are remembered before the oldest answer is dropped. */
export const MANIFEST_MAX_ENTRIES = 500;

const asString = (value, max) =>
  typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined;

const httpsUrl = (value) => {
  if (typeof value !== 'string' || value.length >= 1024) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The origin a caller may ask about, or `undefined`.
 *
 * https only, no embedded credentials, no explicit port (the well-known file
 * lives on the site's front door). The check is cheap and happens BEFORE any
 * network, so a refused origin costs nothing and touches nobody.
 */
export const manifestOriginOf = (raw) => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length >= 2048) {
    return undefined;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:') {
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return undefined;
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    return undefined;
  }
  return `${parsed.protocol}//${parsed.host}`;
};

/**
 * The launch-half of a well-known manifest, or `undefined`.
 *
 * `miniapp` first, `frame` as the older name for the same document — quilcast
 * reads them the same way, and the fields a host uses are the same. Everything
 * else in the file (accountAssociation, webhookUrl, anything new) is left
 * behind: this route answers a launch, nothing else.
 */
export const manifestFacts = (parsed) => {
  const app = parsed?.miniapp ?? parsed?.frame;
  if (!app || typeof app !== 'object') {
    return undefined;
  }
  const facts = {
    name: asString(app.name, 60),
    iconUrl: httpsUrl(app.iconUrl),
    homeUrl: httpsUrl(app.homeUrl),
    splashImageUrl: httpsUrl(app.splashImageUrl),
    splashBackgroundColor: asString(app.splashBackgroundColor, 9),
  };
  // Only what the app actually said: an absent field is absent, not `null`
  // and not `undefined` serialised into the answer.
  const said = Object.fromEntries(
    Object.entries(facts).filter(([, value]) => value !== undefined),
  );
  return Object.keys(said).length > 0 ? said : undefined;
};

/**
 * `manifest(origin)` → the origin's manifest facts, or `null`.
 *
 * One fetch per origin per TTL, shared by every reader asking in that window:
 * the in-process cache below is the only concurrency control the route needs.
 * A negative answer is cached too — an origin with no manifest is a fact about
 * that origin, not a reason to re-ask on every card render.
 */
export const createManifestService = ({
  safeGet,
  now = () => Date.now(),
  ttlMs = MANIFEST_TTL_MS,
  maxEntries = MANIFEST_MAX_ENTRIES,
  /** Refused here rather than fetched, whoever asks (see the header). */
  ownOrigins = [],
}) => {
  if (ttlMs > MANIFEST_TTL_MAX_MS) {
    throw new Error(
      `manifest TTL ${ttlMs}ms is over the one-hour ceiling (${MANIFEST_TTL_MAX_MS}ms)`,
    );
  }
  const own = new Set(ownOrigins.map((each) => manifestOriginOf(each)).filter(Boolean));
  /** origin → { at, m } — the answer and when it landed. */
  const answers = new Map();
  /** origin → the promise in flight, so a stampede is still one read. */
  const inFlight = new Map();

  const remember = (origin, m) => {
    if (answers.size >= maxEntries) {
      answers.delete(answers.keys().next().value);
    }
    answers.set(origin, { at: now(), m });
  };

  const read = async (origin) => {
    try {
      const answer = await safeGet(`${origin}/.well-known/farcaster.json`, {
        headers: { accept: 'application/json' },
      });
      if (answer.status !== 200) {
        return null;
      }
      const body =
        typeof answer.body === 'string'
          ? answer.body
          : Buffer.from(answer.body).toString('utf8');
      return manifestFacts(JSON.parse(body)) ?? null;
    } catch {
      // A manifest that could not be read, or was not JSON, or was over the
      // byte cap: no answer, never an error in a reader's face.
      return null;
    }
  };

  return async (rawOrigin) => {
    const origin = manifestOriginOf(rawOrigin);
    if (origin === undefined || own.has(origin)) {
      return null;
    }
    const hit = answers.get(origin);
    if (hit && now() - hit.at < ttlMs) {
      return hit.m;
    }
    const running = inFlight.get(origin);
    if (running) {
      return running;
    }
    const m = read(origin).finally(() => {
      inFlight.delete(origin);
    });
    inFlight.set(origin, m);
    remember(origin, await m);
    return m;
  };
};
