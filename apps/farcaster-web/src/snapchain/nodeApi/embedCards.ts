/**
 * What a cast's link embed *says*: its title, its picture, and — when the page
 * is a mini app — the card and the button that launches it.
 *
 * WHY THIS EXISTS
 *
 * A cast carries a bare URL, and the hosted API used to hand the client a
 * scraped open-graph for it (title, description, image) plus, for an app, the
 * `fc:miniapp` embed the app itself declares: the picture and the button the
 * feed draws. A node reader has only the URL text, so every link embed rendered
 * as an empty meta box — and a mini app embedded in a cast rendered as a plain
 * link instead of the card whose button opens it. That is the gap this module
 * closes, from the page's own tags rather than from a guess.
 *
 * HOW IT DECIDES
 *
 *   1. an answer already known (this session, or persisted from an earlier one)
 *   2. one bounded `GET` of the URL itself — `text/html` only — reading the
 *      `<head>` and no further, then the tags on it:
 *        `fc:miniapp` (or the older `fc:frame`) → the mini-app card
 *        `og:title`, `og:description`, `og:image` → the link card
 *   3. only when that read could not be made or said nothing about an app:
 *      the caller's index lookup (`indexLookup`), which for this client is
 *      Neynar's own catalog — an index has already read those pages, so it can
 *      answer for the pages a browser is not allowed to read
 *
 * WHAT IT REFUSES TO DO
 *
 *   - It never makes a page up. A read refused by CORS, timed out, answering a
 *     non-2xx, or carrying no tags is *no answer*, and no answer leaves the
 *     embed exactly as it was — a link. Nothing is upgraded on a hunch, and a
 *     card is never drawn from a different app than the one the URL names.
 *   - It never invents a button. A mini-app card is carried over only when the
 *     page declares the launch action the protocol defines; the address the
 *     button opens is the one the page named.
 *   - It never serializes a page of casts behind the network: one bounded read
 *     per URL, a small concurrency cap, its own deadline per read, and
 *     `resolve` waits at most `waitMs` before returning what is already known —
 *     reads still in flight settle into the cache for the next page.
 */

import type {
  ApiFrameEmbedNextExtended,
  ApiOpenGraphMetadata,
} from 'farcaster-client-data';

/** The mini-app card a page declares: art, a button's words, and a target. */
export interface EmbedMiniAppCard {
  imageUrl: string;
  title: string;
  actionUrl: string;
  /** The app's own splash, when it named one. */
  splashImageUrl?: string;
  splashBackgroundColor?: string;
}

/** Everything a link embed can honestly say about itself. */
export interface EmbedCard {
  title?: string;
  description?: string;
  imageUrl?: string;
  miniApp?: EmbedMiniAppCard;
}

export interface EmbedCardResolver {
  /** What is known right now — synchronous, so a renderer can ask per embed. */
  cardOf(url: string): EmbedCard | undefined;
  /** Make sure these URLs are being read, then return (bounded by `waitMs`). */
  resolve(urls: Iterable<string>, options?: { waitMs?: number }): Promise<void>;
  /** Wait for every read still in flight. For tests, and for a caller who asks. */
  settle(): Promise<void>;
}

export interface EmbedCardResolverOptions {
  fetchImpl?: typeof fetch;
  /**
   * Where to ask when the page itself could not be read — an index that has
   * already read it. Absent means the resolver only ever reads the page.
   */
  indexLookup?: (url: string) => Promise<EmbedMiniAppCard | null>;
  timeoutMs?: number;
  concurrency?: number;
  waitMs?: number;
  maxEntries?: number;
  /** A URL that could not be answered is not asked again until this has passed. */
  retryAfterMs?: number;
  maxHtmlBytes?: number;
  /** Where a card is remembered between sessions. Defaults to this browser's. */
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Clock seam for tests. */
  now?: () => number;
}

/** Where a persisted card lives, one JSON object of url → card. */
export const EMBED_CARD_STORAGE_KEY = 'fiddy:embed-cards:v1';

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_RETRY_AFTER_MS = 120_000;
/** `<head>` is where these tags live; a page that never closes it is cut here. */
const DEFAULT_MAX_HTML_BYTES = 192 * 1024;

const HTML_ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&#34;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&#x2F;': '/',
  '&#47;': '/',
};

/** Entities a `content=` attribute may carry, as the tag's real value. */
export const decodeHtmlEntities = (value: string): string =>
  value.replace(
    /&(?:quot|apos|amp|lt|gt|nbsp|#34|#39|#x2F|#47);/g,
    (match) => HTML_ENTITIES[match] ?? match,
  );

const decodeJsonEntities = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;

const httpsUrlOf = (value: unknown): string | undefined => {
  const raw = asString(value);
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Every `<meta>` tag on a page, keyed by its `name`/`property`, lowercased.
 *
 * A `<meta>` may spell its key as `name` or as `property` (both are in the wild
 * for the same tag), its value may be quoted either way, and its attributes may
 * be in either order — so all of that is read rather than assumed. Later tags
 * win, which is what every crawler does with a duplicated tag.
 */
export const metaTagsFromHtml = (html: string): Record<string, string> => {
  const tags: Record<string, string> = {};
  const head =
    html.length > 0
      ? html.slice(
          0,
          html.indexOf('</head>') === -1
            ? html.length
            : html.indexOf('</head>') + 7,
        )
      : '';
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key =
      /(?:name|property)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const content = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(
      tag,
    );
    const name = (key?.[1] ?? key?.[2] ?? key?.[3] ?? '').trim().toLowerCase();
    const value = content?.[1] ?? content?.[2] ?? content?.[3];
    if (name.length > 0 && value !== undefined) {
      tags[name] = decodeHtmlEntities(value);
    }
  }
  return tags;
};

/**
 * The mini-app card a page's `fc:miniapp` (or `fc:frame`) tag declares.
 *
 * The protocol's rule, applied as written: the tag is JSON, its version is
 * `next` or `1`, it names an image, and its button's action is one of the two
 * launch actions. An action that names no address launches the page it is on,
 * which is the app's own home — that is the protocol's fallback, not this
 * client's. Anything else about the tag is *not* an app card.
 */
export const miniAppCardFromMetaTag = (
  raw: string | undefined,
  pageUrl: string,
): EmbedMiniAppCard | undefined => {
  const text = asString(raw);
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeJsonEntities(text)) as unknown;
  } catch {
    return undefined;
  }
  const embed = parsed as {
    version?: unknown;
    imageUrl?: unknown;
    image_url?: unknown;
    button?: {
      title?: unknown;
      action?: {
        type?: unknown;
        url?: unknown;
        name?: unknown;
        splashImageUrl?: unknown;
        splash_background_color?: unknown;
        splashBackgroundColor?: unknown;
      };
    };
  } | null;

  const version = asString(embed?.version);
  if (version !== 'next' && version !== '1') {
    return undefined;
  }
  const imageUrl = httpsUrlOf(embed?.imageUrl ?? embed?.image_url);
  if (imageUrl === undefined) {
    return undefined;
  }
  const action = embed?.button?.action;
  if (action?.type !== 'launch_frame' && action?.type !== 'launch_miniapp') {
    return undefined;
  }
  const actionUrl = httpsUrlOf(action.url) ?? httpsUrlOf(pageUrl);
  if (actionUrl === undefined) {
    return undefined;
  }

  const card: EmbedMiniAppCard = {
    imageUrl,
    title: asString(embed?.button?.title) ?? `Open ${actionUrl}`,
    actionUrl,
  };
  const splashImageUrl = httpsUrlOf(action.splashImageUrl);
  if (splashImageUrl !== undefined) {
    card.splashImageUrl = splashImageUrl;
  }
  const splashBackgroundColor = asString(
    action.splashBackgroundColor ?? action.splash_background_color,
  );
  if (splashBackgroundColor !== undefined) {
    card.splashBackgroundColor = splashBackgroundColor;
  }
  return card;
};

/**
 * Everything a page's own tags say about it, as a card.
 *
 * `undefined` when the page said nothing usable: a read that answered but
 * carried no open-graph and no mini-app tag is not a blank card, it is no
 * answer, and the embed stays a link.
 */
export const embedCardFromHtml = (
  html: string,
  pageUrl: string,
): EmbedCard | undefined => {
  const tags = metaTagsFromHtml(html);
  const card: EmbedCard = {};

  const title = asString(tags['og:title']) ?? asString(tags['twitter:title']);
  if (title !== undefined) {
    card.title = title;
  }
  const description =
    asString(tags['og:description']) ?? asString(tags['twitter:description']);
  if (description !== undefined) {
    card.description = description;
  }
  const imageUrl =
    httpsUrlOf(tags['og:image']) ?? httpsUrlOf(tags['twitter:image']);
  if (imageUrl !== undefined) {
    card.imageUrl = imageUrl;
  }
  const miniApp = miniAppCardFromMetaTag(
    tags['fc:miniapp'] ?? tags['fc:frame'],
    pageUrl,
  );
  if (miniApp !== undefined) {
    card.miniApp = miniApp;
  }

  return Object.keys(card).length > 0 ? card : undefined;
};

/**
 * A card as the fork's `openGraph` metadata.
 *
 * The mini-app half becomes the `frameEmbedNext` the existing renderer already
 * knows how to draw and launch (`components/frames/FrameEmbedNext`), so an
 * in-feed app embed renders as the app's card with a working button without a
 * single page component changing.
 */
export const openGraphFromCard = (
  url: string,
  card: EmbedCard | undefined,
): ApiOpenGraphMetadata => {
  const openGraph: ApiOpenGraphMetadata = { url };
  if (card === undefined) {
    return openGraph;
  }
  if (card.title !== undefined) {
    openGraph.title = card.title;
  }
  if (card.description !== undefined) {
    openGraph.description = card.description;
  }
  if (card.imageUrl !== undefined) {
    openGraph.image = card.imageUrl;
  }
  if (card.miniApp !== undefined) {
    const frameEmbedNext: ApiFrameEmbedNextExtended = {
      frameUrl: card.miniApp.actionUrl,
      frameEmbed: {
        version: 'next',
        imageUrl: card.miniApp.imageUrl,
        button: {
          title: card.miniApp.title,
          action: {
            type: 'launch_miniapp',
            name: card.title ?? card.miniApp.title,
            url: card.miniApp.actionUrl,
            ...(card.miniApp.splashImageUrl !== undefined
              ? { splashImageUrl: card.miniApp.splashImageUrl }
              : {}),
            ...(card.miniApp.splashBackgroundColor !== undefined
              ? { splashBackgroundColor: card.miniApp.splashBackgroundColor }
              : {}),
          },
        },
      },
    };
    openGraph.frameEmbedNext = frameEmbedNext;
  }
  return openGraph;
};

const defaultStorage = (): Pick<Storage, 'getItem' | 'setItem'> | null => {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage can be refused (private mode, a locked-down browser). A cache
    // that cannot be reached is not an error — it is just not a cache.
    return null;
  }
};

/** Read at most `maxBytes` of a response, stopping once the head is in hand. */
const readBoundedHtml = async (
  response: Response,
  maxBytes: number,
): Promise<string> => {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let read = 0;
  try {
    while (read < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      read += chunk.value.byteLength;
      html += decoder.decode(chunk.value, { stream: true });
      if (html.includes('</head>')) {
        break;
      }
    }
  } catch {
    // A body that stops mid-stream still gave us what arrived.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancelling a finished stream is not a failure.
    }
  }
  return html;
};

const isHtmlResponse = (response: Response): boolean => {
  const type = response.headers.get('content-type') ?? '';
  return type.toLowerCase().includes('text/html');
};

/**
 * Read once per URL, then answer from memory — for the rest of the session and,
 * where a browser allows it, for the next one.
 */
export const createEmbedCardResolver = (
  options: EmbedCardResolverOptions = {},
): EmbedCardResolver => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
  const maxHtmlBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;
  const now = options.now ?? (() => Date.now());
  const storage =
    options.storage === undefined ? defaultStorage() : options.storage;
  const indexLookup = options.indexLookup;

  const readFetch: typeof fetch =
    options.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init));

  /** Definitive answers only: a URL with no entry has never been answered. */
  const cards = new Map<string, EmbedCard | null>();
  const askedAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  let loaded = false;
  let dirty = false;

  const loadPersisted = (): void => {
    if (loaded) {
      return;
    }
    loaded = true;
    try {
      const raw = storage?.getItem(EMBED_CARD_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [url, value] of Object.entries(parsed)) {
        if (value === null) {
          cards.set(url, null);
        } else if (typeof value === 'object') {
          cards.set(url, value as EmbedCard);
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
      const kept = [...cards.entries()].slice(-maxEntries);
      storage?.setItem(
        EMBED_CARD_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(kept)),
      );
    } catch {
      // A cache that cannot be written still answered this session.
    }
  };

  const requestRead = async (url: string): Promise<EmbedCard | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let card: EmbedCard | undefined;
    try {
      const response = await readFetch(url, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
        // Reading a page from the reader's own browser is how a link's card is
        // found when nothing else can answer, and it is a privacy surface: that
        // read tells the page's host the reader's address and that somebody is
        // looking at this cast. `credentials: 'omit'` keeps it anonymous of the
        // session; `referrerPolicy: 'no-referrer'` keeps it from also saying
        // WHICH cast, which is what a referrer would hand over for free.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'follow',
      });
      if (response.ok && isHtmlResponse(response)) {
        const html = await readBoundedHtml(response, maxHtmlBytes);
        card = embedCardFromHtml(html, response.url || url);
      }
    } catch {
      // A read that could not be made is not an answer.
      card = undefined;
    } finally {
      clearTimeout(timer);
    }

    // The index is asked only for what the page itself could not say, and only
    // about an app — a link's title is not worth a second server.
    if (indexLookup !== undefined) {
      const pageSaid = card?.miniApp !== undefined;
      if (!pageSaid) {
        try {
          const indexed = await indexLookup(url);
          if (indexed !== null) {
            card = { ...(card ?? {}), miniApp: indexed };
          }
        } catch {
          // An index that did not answer is not an answer either.
        }
      }
    }

    return card ?? null;
  };

  const readOne = (url: string): Promise<void> => {
    const existing = inFlight.get(url);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      try {
        const card = await requestRead(url);
        cards.set(url, card);
        dirty = true;
        persist();
      } finally {
        inFlight.delete(url);
      }
    })();
    inFlight.set(url, promise);
    return promise;
  };

  const shouldAsk = (url: string): boolean => {
    if (inFlight.has(url)) {
      return false;
    }
    if (cards.has(url)) {
      return false;
    }
    const asked = askedAt.get(url);
    return asked === undefined || now() - asked >= retryAfterMs;
  };

  const sleep = (ms: number): Promise<void> =>
    new Promise((settle) => setTimeout(settle, ms));

  return {
    cardOf: (url: string): EmbedCard | undefined => {
      loadPersisted();
      return cards.get(url) ?? undefined;
    },

    resolve: async (
      urls: Iterable<string>,
      resolveOptions: { waitMs?: number } = {},
    ): Promise<void> => {
      loadPersisted();
      const wanted = [...new Set(urls)].filter(shouldAsk);
      if (wanted.length === 0) {
        return;
      }
      for (const url of wanted) {
        askedAt.set(url, now());
      }

      const waitMs = resolveOptions.waitMs ?? options.waitMs ?? DEFAULT_WAIT_MS;
      const queue = [...wanted];
      const workers = new Array(Math.min(concurrency, queue.length))
        .fill(undefined)
        .map(async () => {
          for (
            let next = queue.shift();
            next !== undefined;
            next = queue.shift()
          ) {
            await readOne(next);
          }
        });
      const running = Promise.all(workers);
      // Whatever is not in hand by the deadline keeps running in the
      // background and lands in the cache for the next page — the feed is never
      // held open on somebody else's server.
      await Promise.race([running, sleep(waitMs)]);
    },

    settle: async (): Promise<void> => {
      while (inFlight.size > 0) {
        await Promise.all([...inFlight.values()]);
      }
    },
  };
};
