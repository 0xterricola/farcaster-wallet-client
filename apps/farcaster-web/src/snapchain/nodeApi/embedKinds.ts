/**
 * What a cast's embed URL actually *is*: an image, a video, or a link.
 *
 * WHY THIS EXISTS
 *
 * A cast's embed is a bare URL on the protocol — no media type travels with it.
 * The hosted API classified those URLs for the client (images went to
 * `embeds.images`, so the renderer drew a photo). A node reader has only the
 * URL text, and until this module existed the adapter classified by file
 * extension — which is exactly what the URLs people post today do not have.
 * `https://imagedelivery.net/<account>/<id>/original` has no extension at all,
 * so a photo landed in the link bucket and rendered as a chain-link icon with a
 * blank meta box. That is the bug this file fixes at its source.
 *
 * HOW IT DECIDES, IN THIS ORDER
 *
 *   1. an answer already known (this session, or persisted from an earlier one)
 *   2. a file extension that plainly names a media type — free, no network
 *   3. a bounded probe of the URL itself: one `HEAD`, then one ranged `GET`,
 *      then (in a browser, and only if those could not be asked) an
 *      `Image()` load, which needs no CORS permission to answer
 *
 * WHAT IT REFUSES TO DO
 *
 *   - It never guesses. A probe that could not be made — refused by CORS, timed
 *     out, no content type, a non-2xx — is *no answer*, and no answer means the
 *     embed stays a link card. It is never upgraded to an image on a hunch.
 *   - It never throws at a caller. Every probe is caught here and turned into
 *     "no answer".
 *   - It never serializes a page of casts behind the network. A batch is probed
 *     with a small concurrency cap, each probe has its own deadline, and
 *     `classify` waits at most `waitMs` before returning whatever is known —
 *     probes still in flight keep running and settle into the cache for the
 *     next read, rather than holding the feed open.
 */

/** The kinds of embed the client renders inline. Everything else is a link. */
export type EmbedKind = 'image' | 'video';

/** What a probe can conclude. `link` is an answer: something real said "not media". */
export type EmbedKindAnswer = EmbedKind | 'link';

/** Where a persisted classification lives, one JSON object of url → answer. */
export const EMBED_KIND_STORAGE_KEY = 'fiddy:embed-kinds:v1';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#]|$)/i;
/**
 * Video containers the fork's renderer actually plays. An HLS manifest
 * (`…m3u8`) is deliberately *not* here: the web client has no HLS player, so
 * calling it a video would render a broken player instead of an honest link.
 */
const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|ogv)(?:[?#]|$)/i;

/** The media type a URL's own file name names, when it names one at all. */
export const embedKindFromExtension = (url: string): EmbedKind | undefined => {
  if (IMAGE_EXTENSIONS.test(url)) {
    return 'image';
  }
  if (VIDEO_EXTENSIONS.test(url)) {
    return 'video';
  }
  return undefined;
};

/**
 * A `Content-Type` header as an answer — `undefined` when the header says
 * nothing (a server that answered without one is not evidence of an image).
 */
export const embedKindFromContentType = (
  contentType: string | null | undefined,
): EmbedKindAnswer | undefined => {
  if (typeof contentType !== 'string') {
    return undefined;
  }
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === '') {
    return undefined;
  }
  if (type.startsWith('image/')) {
    return 'image';
  }
  if (type.startsWith('video/')) {
    return 'video';
  }
  // A real answer that is not media: `text/html`, `application/json`, … The
  // URL is a page, and it is rendered as one.
  return 'link';
};

export interface EmbedKindResolverOptions {
  /** Requests for the probes. Defaults to the global `fetch`, at call time. */
  fetchImpl?: typeof fetch;
  /** How long one probe may take, whole. */
  probeTimeoutMs?: number;
  /** How many probes may be in flight at once. */
  concurrency?: number;
  /** Where answers are remembered across sessions. Defaults to `localStorage`. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** How many answers the persisted cache keeps (newest last). */
  maxEntries?: number;
  /** A URL that could not be answered is not asked again until this has passed. */
  retryAfterMs?: number;
  /** The last-resort probe. Defaults to the browser's `Image()`. */
  imageProbe?: (
    url: string,
    timeoutMs: number,
  ) => Promise<EmbedKind | undefined>;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface ClassifyOptions {
  /** How long `classify` waits for probes before returning what it knows. */
  waitMs?: number;
}

export interface EmbedKindResolver {
  /** What is known right now — synchronous, so a renderer can ask per embed. */
  kindOf(url: string): EmbedKindAnswer | undefined;
  /**
   * Make sure the answers for these URLs are on their way, then return. Waiting
   * is capped by `waitMs`; probes that outlast it settle into the cache later.
   */
  classify(urls: Iterable<string>, options?: ClassifyOptions): Promise<void>;
  /** Wait for every probe still in flight. For tests and for a caller that wants to know. */
  settle(): Promise<void>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_WAIT_MS = 1_500;
const DEFAULT_MAX_ENTRIES = 400;
const DEFAULT_RETRY_AFTER_MS = 60_000;

/** A probe's own question: does anything here say what this is? */
type ProbeResponse = EmbedKindAnswer | undefined;

const defaultStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage can be refused (private mode, a locked-down browser). A cache
    // that cannot be reached is not an error — it is just not a cache.
    return null;
  }
};

/**
 * The browser's own answer to "is this an image?", which needs no CORS grant:
 * an `<img>` that loads is an image, one that errors is not. Costs one download
 * of a URL that is about to be displayed anyway (the browser serves the second
 * request from its cache). Absent outside a browser, so `undefined` there.
 */
export const browserImageProbe = (
  url: string,
  timeoutMs: number,
): Promise<EmbedKind | undefined> =>
  new Promise((resolve) => {
    if (typeof Image !== 'function') {
      resolve(undefined);
      return;
    }
    const image = new Image();
    let settled = false;
    const finish = (answer: EmbedKind | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      resolve(answer);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    image.onload = () => finish('image');
    image.onerror = () => finish(undefined);
    image.src = url;
  });

/**
 * Classification for the cast renderer: ask once per URL, then answer from
 * memory for the rest of the session (and, where a browser lets us, for the
 * next session too).
 */
export const createEmbedKindResolver = (
  options: EmbedKindResolverOptions = {},
): EmbedKindResolver => {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const now = options.now ?? (() => Date.now());
  const storage =
    options.storage === undefined ? defaultStorage() : options.storage;
  const imageProbe = options.imageProbe ?? browserImageProbe;

  const probeFetch: typeof fetch =
    options.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));

  /** Definitive answers only: a URL with no entry has never been answered. */
  const answers = new Map<string, EmbedKindAnswer>();
  /** When each URL was last *asked*, so a failed probe is not repeated at once. */
  const askedAt = new Map<string, number>();
  /** One probe per URL, shared by every caller that asks for it meanwhile. */
  const inFlight = new Map<string, Promise<void>>();

  let loaded = false;
  let dirty = false;

  const loadPersisted = (): void => {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      const raw = storage?.getItem(EMBED_KIND_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [url, answer] of Object.entries(parsed)) {
        if (answer === 'image' || answer === 'video' || answer === 'link') {
          answers.set(url, answer);
        }
      }
    } catch {
      // A cache that cannot be read is empty, not fatal.
    }
  };

  const persist = (): void => {
    if (!dirty) {
      return;
    }
    dirty = false;
    try {
      const kept = [...answers.entries()].slice(-maxEntries);
      storage?.setItem(
        EMBED_KIND_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(kept)),
      );
    } catch {
      // A cache that cannot be written still answered this session.
    }
  };

  /** One request, one question. `undefined` means "could not ask". */
  const ask = async (
    url: string,
    method: 'HEAD' | 'GET',
  ): Promise<ProbeResponse> => {
    const canAbort = typeof AbortController === 'function';
    const controller = canAbort ? new AbortController() : undefined;
    const timer =
      controller === undefined
        ? undefined
        : setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const response = await probeFetch(url, {
        method,
        // A redirect to the real bytes is the normal case for a short link.
        redirect: 'follow',
        credentials: 'omit',
        headers: {
          accept: 'image/*,video/*;q=0.9,*/*;q=0.1',
          // `HEAD` is not universally supported; the ranged `GET` that follows
          // asks for the same header and one byte, which is the closest thing
          // to a HEAD a server will accept when it refuses the first.
          ...(method === 'GET' ? { range: 'bytes=0-0' } : {}),
        },
        ...(controller ? { signal: controller.signal } : {}),
      });
      // Headers are the answer; the body is not wanted, and cancelling it stops
      // a server that ignored `Range` from streaming a whole photo at us.
      const body = response.body;
      if (body) {
        void body.cancel().catch(() => undefined);
      }
      if (!response.ok) {
        return undefined;
      }
      return embedKindFromContentType(response.headers.get('content-type'));
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  const probe = async (url: string): Promise<ProbeResponse> => {
    const head = await ask(url, 'HEAD');
    if (head !== undefined) {
      return head;
    }
    const ranged = await ask(url, 'GET');
    if (ranged !== undefined) {
      return ranged;
    }
    try {
      return await imageProbe(url, probeTimeoutMs);
    } catch {
      return undefined;
    }
  };

  const probeOnce = (url: string): Promise<void> => {
    const running = inFlight.get(url);
    if (running) {
      return running;
    }
    const started = (async () => {
      askedAt.set(url, now());
      const answer = await probe(url);
      if (answer !== undefined) {
        answers.set(url, answer);
        dirty = true;
        persist();
      }
    })().finally(() => {
      inFlight.delete(url);
    });
    inFlight.set(url, started);
    return started;
  };

  const kindOf = (url: string): EmbedKindAnswer | undefined => {
    loadPersisted();
    return answers.get(url) ?? embedKindFromExtension(url);
  };

  const classify = async (
    urls: Iterable<string>,
    { waitMs = DEFAULT_WAIT_MS }: ClassifyOptions = {},
  ): Promise<void> => {
    loadPersisted();
    const targets: string[] = [];
    for (const url of new Set(urls)) {
      if (typeof url !== 'string' || url === '') {
        continue;
      }
      if (kindOf(url) !== undefined) {
        continue;
      }
      const asked = askedAt.get(url);
      if (asked !== undefined && now() - asked < retryAfterMs) {
        continue;
      }
      targets.push(url);
    }
    if (targets.length === 0) {
      persist();
      return;
    }

    // A pool, not a queue: the first `concurrency` probes start together and
    // each next URL starts as one finishes. The wait below is capped, so a slow
    // host costs the caller its deadline and never more.
    let cursor = 0;
    const runners = new Array(
      Math.max(1, Math.min(concurrency, targets.length)),
    )
      .fill(undefined)
      .map(async () => {
        while (cursor < targets.length) {
          const url = targets[cursor];
          cursor += 1;
          if (url === undefined) {
            continue;
          }
          await probeOnce(url);
        }
      });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(runners),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
    persist();
  };

  const settle = async (): Promise<void> => {
    // Probes started by a `classify` that hit its deadline are still running.
    while (inFlight.size > 0) {
      await Promise.all([...inFlight.values()]);
    }
    persist();
  };

  return { kindOf, classify, settle };
};

/**
 * The resolver the surfaces that render a URL use — a direct message's picture
 * links today (`splitDirectCastMessageImageTokens`).
 *
 * WHY A SHARED ONE
 *
 * The node-backed adapter keeps a resolver of its own for the embeds it
 * classifies while it reads a feed (`reads.ts`). A renderer that meets a URL the
 * adapter has never seen — a DM body is text, not an embed — needs the same
 * answers without a second round of probes, and needs them to outlive the
 * component that asked. So there is one of these per page load: the first
 * surface that needs it creates it, everything after that shares the cache.
 *
 * Both instances read and write the same persisted entry
 * (`EMBED_KIND_STORAGE_KEY`), so an answer learned by either is known to the
 * other on the next load — and an answer learned in a conversation is what lets
 * a DM list say "shared an image" without a probe of its own.
 *
 * Created lazily: importing this module must not touch storage (the tests
 * import it, and so does a page that never renders a message).
 */
let clientResolver: EmbedKindResolver | undefined;

export const clientEmbedKindResolver = (): EmbedKindResolver => {
  if (clientResolver === undefined) {
    clientResolver = createEmbedKindResolver();
  }
  return clientResolver;
};
