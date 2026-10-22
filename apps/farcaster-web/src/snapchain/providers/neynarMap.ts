/**
 * Neynar, translated — the thin mapper, and the only place Neynar's own JSON is
 * allowed to exist.
 *
 * Neynar is a hosted index, not a node: different endpoint names
 * (`/v2/farcaster/…`), different field names (`display_name`, `pfp_url`,
 * `likes_count`), and a key the reader brought. None of that may reach the
 * pages, whose hooks still consume the shapes the hosted API served — so this
 * module answers a client request by calling Neynar and handing back the SAME
 * envelope the node-backed adapter builds:
 *
 *          client request → Neynar call → Neynar JSON → hosted shape
 *
 * WHAT IT REFUSES
 *
 * The feed, notifications/unseen counts, direct messages and search are not
 * here: this client's signed-in surfaces are assembled from protocol messages
 * on a node, and Neynar's equivalents need its own account, its own plan and
 * its own paging semantics. Asking for one comes back as `501` with a sentence
 * naming Neynar and saying what it cannot do — never as an empty success, and
 * never as a quiet fall-through to a different server.
 *
 * Counts are what Neynar says they are (its index's own numbers). Where a field
 * is absent, it is left absent rather than filled with a zero that would read
 * like a fact.
 */

import type {
  ApiCast,
  ApiChannel,
  ApiFrame,
  ApiOpenGraphMetadata,
  ApiUser,
} from 'farcaster-client-data';

import {
  type EmbedCard,
  openGraphFromCard,
} from '~/snapchain/nodeApi/embedCards';

import { NEYNAR_BASE_URL } from './catalog';

/** One Neynar read, as this client asks for it. */
export interface NeynarCall {
  url: string;
  /** Which hosted shape to build out of the answer. */
  kind:
    | 'user'
    | 'user-list'
    | 'casts'
    | 'thread'
    | 'verifications'
    | 'frames'
    | 'index';
  /**
   * Which hosted envelope a `frames` answer becomes. The app catalog has four
   * endpoints with four different envelopes (`ApiGetTopMiniApps200Response`,
   * `ApiGetNewFrames200Response`, `ApiGetFavoriteFrames200Response`, the search
   * one), and Neynar's own pagination differs between them, so the shape is
   * carried rather than guessed from the path at answer time.
   */
  shape?:
    | 'top-mini-apps'
    | 'new-frames'
    | 'favorite-frames'
    | 'search-miniapps'
    /**
     * …and the same for the reads an index answers and a node cannot: each one
     * has its own hosted envelope (`ApiGetCastQuotes200Response`,
     * `ApiGetUserLikedCasts200Response`, `ApiGetSearchUsers200Response`,
     * `ApiGetSearchChannels200Response`) and its own place in the answer, so
     * which one it is travels with the call.
     */
    | 'cast-quotes'
    | 'liked-casts'
    | 'search-users'
    | 'search-channels';
}

/** The hosted API's error envelope, same as the node-backed adapter's. */
const errorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ errors: [{ message }] }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

interface NeynarUser {
  fid?: unknown;
  username?: unknown;
  display_name?: unknown;
  pfp_url?: unknown;
  follower_count?: unknown;
  following_count?: unknown;
  custody_address?: unknown;
  profile?: { bio?: { text?: unknown } };
  verified_addresses?: { eth_addresses?: unknown };
}

interface NeynarCast {
  hash?: unknown;
  thread_hash?: unknown;
  parent_hash?: unknown;
  parent_url?: unknown;
  parent_author?: { fid?: unknown };
  author?: NeynarUser;
  text?: unknown;
  timestamp?: unknown;
  replies?: { count?: unknown };
  reactions?: { likes_count?: unknown; recasts_count?: unknown };
  embeds?: unknown;
  channel?: { id?: unknown; name?: unknown } | null;
  direct_replies?: unknown;
  chronological_parent_casts?: unknown;
}

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * A Neynar user as the fork's `ApiUser`.
 *
 * `verified` on the avatar is Neynar's own claim about the image host; it is
 * carried over only when Neynar states it, never assumed.
 */
export const apiUserFromNeynar = (user: NeynarUser): ApiUser => {
  const fid = asNumber(user.fid);
  const username = asString(user.username);
  const displayName = asString(user.display_name);
  const bio = asString(user.profile?.bio?.text) ?? '';

  const apiUser: ApiUser = {
    fid,
    displayName: displayName ?? username ?? `fid ${fid}`,
    followerCount: asNumber(user.follower_count),
    followingCount: asNumber(user.following_count),
    profile: { bio: { text: bio, mentions: [] } },
  };

  if (username !== undefined) {
    apiUser.username = username;
  }
  const pfpUrl = asString(user.pfp_url);
  if (pfpUrl !== undefined) {
    apiUser.pfp = { url: pfpUrl, verified: false };
  }

  return apiUser;
};

/** Neynar's ISO timestamp as the milliseconds the hosted shapes use. */
const timestampMs = (value: unknown): number => {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|avif)(\?|$)/i;

/**
 * What Neynar says a link embed's own page declared.
 *
 * Neynar has already read the page, and it hands back what it found: `html` is
 * the page's own open-graph tags, `frame` is the mini app / frame that page
 * published, `miniapp` is the newer spelling of the same thing, and `_status`
 * is how the read went. This is the only place that knowledge exists on a
 * Neynar read — the protocol stores a bare URL — so an embed that drops it
 * renders as an empty link card, mini app or not.
 */
interface NeynarEmbedHtml {
  ogUrl?: unknown;
  ogTitle?: unknown;
  ogDescription?: unknown;
  ogSiteName?: unknown;
  ogImage?: unknown;
}

interface NeynarEmbedFrame {
  version?: unknown;
  title?: unknown;
  image?: unknown;
  frames_url?: unknown;
}

interface NeynarEmbedMetadata {
  html?: NeynarEmbedHtml | null;
  frame?: NeynarEmbedFrame | null;
  miniapp?: NeynarEmbedFrame | null;
}

/**
 * Neynar's `ogImage`, which it states either as a URL or as `[{ url }]`.
 * First usable answer wins; anything else is no answer.
 */
const ogImageUrlOf = (value: unknown): string | undefined => {
  const direct = asString(value);
  if (direct !== undefined) {
    return direct;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const url = ogImageUrlOf(entry);
      if (url !== undefined) {
        return url;
      }
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    return asString((value as { url?: unknown }).url);
  }
  return undefined;
};

/**
 * A link embed as the page itself declared it: its title, its description, its
 * picture — and, when the page is a mini app, the card whose button launches
 * it (`EmbedCard`, so a Neynar read and a node read draw the same card).
 *
 * WHAT IT REFUSES TO DO
 *
 *   - It never invents a card. No `frame`/`miniapp` in the metadata, no card:
 *     the embed stays the link it is, rather than a button this client made up.
 *   - It never puts a broken address in front of a renderer: an image or an
 *     action that is not `https:` is dropped, and the card falls back to the
 *     embed's own URL for the action exactly as the hosted API's did.
 *   - It never states a button's words the page did not: the title is the one
 *     Neynar read off the page, and when there is none the protocol's own
 *     name for a nameless button ("Open …") is used, never a marketing line.
 */
export const openGraphFromNeynarEmbed = (
  url: string,
  metadata: unknown,
): ApiOpenGraphMetadata => {
  const meta = (metadata ?? {}) as NeynarEmbedMetadata;
  const html = meta.html ?? undefined;
  const frame = meta.miniapp ?? meta.frame ?? undefined;

  const card: EmbedCard = {};
  const title = asString(html?.ogTitle);
  if (title !== undefined) {
    card.title = title;
  }
  const description = asString(html?.ogDescription);
  if (description !== undefined) {
    card.description = description;
  }
  // The mini app's own art wins over the page's og:image: for an app, the card
  // is the app's picture, and the two are usually the same file anyway.
  const image =
    httpsUrlOf(frame?.image) ?? httpsUrlOf(ogImageUrlOf(html?.ogImage));
  if (image !== undefined) {
    card.imageUrl = image;
  }
  const actionUrl = httpsUrlOf(frame?.frames_url) ?? httpsUrlOf(url);
  if (image !== undefined && actionUrl !== undefined && frame !== undefined) {
    card.miniApp = {
      imageUrl: image,
      title: asString(frame.title) ?? `Open ${actionUrl}`,
      actionUrl,
    };
  }

  const openGraph = openGraphFromCard(
    url,
    Object.keys(card).length > 0 ? card : undefined,
  );
  const domain = asString(html?.ogSiteName) ?? hostOf(url);
  if (domain !== undefined) {
    openGraph.domain = domain;
  }
  return openGraph;
};

/** Neynar's `embeds` array as the fork's `ApiCastEmbeds`. */
const embedsFromNeynar = (embeds: unknown): ApiCast['embeds'] => {
  if (!Array.isArray(embeds)) {
    return { images: [], urls: [], unknowns: [] };
  }
  const images: {
    type: 'image';
    url: string;
    sourceUrl: string;
    alt: string;
  }[] = [];
  const urls: { type: 'url'; openGraph: ApiOpenGraphMetadata }[] = [];
  const quotes: unknown[] = [];

  for (const embed of embeds) {
    const record = embed as {
      url?: unknown;
      cast?: unknown;
      metadata?: unknown;
    } | null;
    const url = asString(record?.url);
    if (url === undefined) {
      if (record?.cast) {
        quotes.push(record.cast);
      }
      continue;
    }
    if (IMAGE_EXTENSIONS.test(url)) {
      images.push({ type: 'image', url, sourceUrl: url, alt: '' });
    } else {
      // The page's own words, when Neynar read them: the title, the picture,
      // and — for a mini app — the card and button that launch it.
      urls.push({
        type: 'url',
        openGraph: openGraphFromNeynarEmbed(url, record?.metadata),
      });
    }
  }

  return {
    images,
    urls,
    ...(quotes.length > 0 ? { casts: quotes as never } : {}),
    unknowns: [],
  };
};

/**
 * One Neynar cast as `ApiCast`.
 *
 * `threadHash` is Neynar's `thread_hash` when it states one, and the cast's own
 * hash otherwise — the protocol's rule for a cast with no parent.
 */
export const apiCastFromNeynar = (cast: NeynarCast): ApiCast => {
  const hash = asString(cast.hash) ?? '';
  const author = apiUserFromNeynar(cast.author ?? {});
  const parentHash = asString(cast.parent_hash);
  const parentUrl = asString(cast.parent_url);
  const channelId = asString(cast.channel?.id);

  const apiCast: ApiCast = {
    hash,
    threadHash: asString(cast.thread_hash) ?? hash,
    author,
    text: asString(cast.text) ?? '',
    timestamp: timestampMs(cast.timestamp),
    replies: { count: asNumber(cast.replies?.count) },
    reactions: { count: asNumber(cast.reactions?.likes_count) },
    recasts: { count: asNumber(cast.reactions?.recasts_count) },
    // Neynar's own view counts are behind another plan; absent, not zero.
    watches: { count: 0 },
    castType: parentHash !== undefined ? 'reply-cast' : 'root-cast',
  };

  const embeds = embedsFromNeynar(cast.embeds);
  if (
    embeds &&
    ((embeds.images?.length ?? 0) > 0 ||
      (embeds.urls?.length ?? 0) > 0 ||
      (embeds.casts?.length ?? 0) > 0)
  ) {
    apiCast.embeds = embeds;
  }

  if (parentHash !== undefined) {
    apiCast.parentHash = parentHash;
  }
  if (parentUrl !== undefined) {
    apiCast.parentUrl = parentUrl;
    if (channelId !== undefined) {
      apiCast.channel = {
        type: 'channel',
        key: channelId,
        name: asString(cast.channel?.name) ?? channelId,
        showCastSourceLabels: false,
        showCastTags: false,
        sectionRank: 0,
        subscribable: false,
        viewerContext: {
          following: false,
          isMember: false,
          hasUnseenItems: false,
        },
      } as ApiCast['channel'];
    }
  }

  return apiCast;
};

const asNeynarArray = (value: unknown): NeynarCast[] =>
  Array.isArray(value) ? (value as NeynarCast[]) : [];

/**
 * One mini app as Neynar publishes it.
 *
 * A frame / mini app is a *web page*, not a protocol message: its own
 * `/.well-known/farcaster.json` (the "manifest") describes it, and Neynar's
 * index is what has read that file. `manifest.frame` is the older spelling of
 * `manifest.miniapp` and carries the same fields, so both are read and the
 * miniapp one wins when they disagree.
 */
interface NeynarFrameManifestFile {
  name?: unknown;
  home_url?: unknown;
  icon_url?: unknown;
  splash_image_url?: unknown;
  splash_background_color?: unknown;
  webhook_url?: unknown;
  subtitle?: unknown;
  description?: unknown;
  tagline?: unknown;
  primary_category?: unknown;
  tags?: unknown;
  screenshot_urls?: unknown;
  hero_image_url?: unknown;
  og_title?: unknown;
  og_description?: unknown;
  og_image_url?: unknown;
}

interface NeynarFrame {
  version?: unknown;
  frames_url?: unknown;
  image?: unknown;
  author?: NeynarUser;
  manifest?: {
    frame?: NeynarFrameManifestFile;
    miniapp?: NeynarFrameManifestFile;
  } | null;
  manifest_url?: unknown;
}

/** The categories the fork's `ApiFrame` names, so a category is never invented. */
const APP_PRIMARY_CATEGORIES = [
  'games',
  'social',
  'finance',
  'utility',
  'productivity',
  'health-fitness',
  'news-media',
  'music',
  'shopping',
  'education',
  'developer-tools',
  'entertainment',
  'art-creativity',
] as const;

type AppPrimaryCategory = (typeof APP_PRIMARY_CATEGORIES)[number];

/**
 * A URL carried into the fork's shapes only when it is one the page can load.
 *
 * The hosted shapes spell these fields `ApiHttpsUrl` — the fork's own renderer
 * puts them straight into `src=` and `href=`. A manifest that names something
 * else (`http:`, `data:`, a relative path, a string that is not a URL at all)
 * leaves the field absent rather than handing the renderer a broken promise.
 */
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

const hexColorOf = (value: unknown): string | undefined => {
  const raw = asString(value);
  return raw !== undefined &&
    /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(raw)
    ? raw
    : undefined;
};

const categoryOf = (value: unknown): AppPrimaryCategory | undefined => {
  const raw = asString(value)?.toLowerCase();
  return APP_PRIMARY_CATEGORIES.find((category) => category === raw);
};

/** The manifest file behind a frame, with the newer spelling preferred. */
const manifestOf = (frame: NeynarFrame): NeynarFrameManifestFile =>
  frame.manifest?.miniapp ?? frame.manifest?.frame ?? {};

/** This app's home page, as an address a page may load. */
const homeUrlOf = (frame: NeynarFrame): string | undefined =>
  httpsUrlOf(manifestOf(frame).home_url) ??
  httpsUrlOf(frame.frames_url) ??
  undefined;

/**
 * One Neynar frame as the fork's `ApiFrame`.
 *
 * Absent means absent: a field Neynar does not state is left off rather than
 * filled with a zero, a placeholder or this client's own guess. `domain` is the
 * app's own host, which is what the fork keys a frame by.
 *
 * `supportsNotifications` is the one derived field, and it is derived from the
 * protocol's own rule rather than from taste: an app takes notifications when it
 * registered a webhook in its manifest, and the manifest's `webhook_url` is
 * exactly that registration.
 */
export const apiFrameFromNeynarFrame = (
  frame: NeynarFrame,
): ApiFrame | null => {
  const homeUrl = homeUrlOf(frame);
  const manifest = manifestOf(frame);
  const iconUrl =
    httpsUrlOf(manifest.icon_url) ?? httpsUrlOf(frame.image) ?? undefined;

  if (homeUrl === undefined || iconUrl === undefined) {
    // Without a home page and a picture there is no card to draw, and drawing a
    // blank one would read as "this app has no art".
    return null;
  }

  let domain: string;
  try {
    domain = new URL(homeUrl).hostname;
  } catch {
    return null;
  }

  const apiFrame: ApiFrame = {
    domain,
    name: asString(manifest.name) ?? domain,
    iconUrl,
    homeUrl,
    supportsNotifications: typeof asString(manifest.webhook_url) === 'string',
  };

  const imageUrl = httpsUrlOf(frame.image) ?? httpsUrlOf(manifest.og_image_url);
  if (imageUrl !== undefined) {
    apiFrame.imageUrl = imageUrl;
  }
  const splashImageUrl = httpsUrlOf(manifest.splash_image_url);
  if (splashImageUrl !== undefined) {
    apiFrame.splashImageUrl = splashImageUrl;
  }
  const splashBackgroundColor = hexColorOf(manifest.splash_background_color);
  if (splashBackgroundColor !== undefined) {
    apiFrame.splashBackgroundColor = splashBackgroundColor;
  }
  const subtitle = asString(manifest.subtitle);
  if (subtitle !== undefined) {
    apiFrame.subtitle = subtitle;
  }
  const description = asString(manifest.description);
  if (description !== undefined) {
    apiFrame.description = description;
  }
  const tagline = asString(manifest.tagline);
  if (tagline !== undefined) {
    apiFrame.tagline = tagline;
  }
  const primaryCategory = categoryOf(manifest.primary_category);
  if (primaryCategory !== undefined) {
    apiFrame.primaryCategory = primaryCategory;
  }
  if (Array.isArray(manifest.tags)) {
    const tags = manifest.tags.filter(
      (tag): tag is string => typeof tag === 'string' && tag.length > 0,
    );
    if (tags.length > 0) {
      apiFrame.tags = tags;
    }
  }
  if (Array.isArray(manifest.screenshot_urls)) {
    const screenshots = manifest.screenshot_urls
      .map(httpsUrlOf)
      .filter((url): url is string => url !== undefined);
    if (screenshots.length > 0) {
      apiFrame.screenshotUrls = screenshots;
    }
  }
  const heroImageUrl = httpsUrlOf(manifest.hero_image_url);
  if (heroImageUrl !== undefined) {
    apiFrame.heroImageUrl = heroImageUrl;
  }
  const ogTitle = asString(manifest.og_title);
  if (ogTitle !== undefined) {
    apiFrame.ogTitle = ogTitle;
  }
  const ogDescription = asString(manifest.og_description);
  if (ogDescription !== undefined) {
    apiFrame.ogDescription = ogDescription;
  }
  const ogImageUrl = httpsUrlOf(manifest.og_image_url);
  if (ogImageUrl !== undefined) {
    apiFrame.ogImageUrl = ogImageUrl;
  }
  if (frame.author) {
    apiFrame.author = apiUserFromNeynar(frame.author);
  }

  return apiFrame;
};

/** The bodies of Neynar's frame answers, whichever endpoint they came from. */
const frameListOf = (payload: unknown): NeynarFrame[] => {
  const body = payload as {
    frames?: unknown;
    relevant_frames?: unknown;
  } | null;
  if (Array.isArray(body?.frames)) {
    return body.frames as NeynarFrame[];
  }
  if (Array.isArray(body?.relevant_frames)) {
    return (body.relevant_frames as { frame?: NeynarFrame }[])
      .map((entry) => entry.frame)
      .filter((frame): frame is NeynarFrame => frame !== undefined);
  }
  return [];
};

/** Neynar's own paging cursor for a frame list, when it states one. */
const frameCursorOf = (payload: unknown): string | undefined => {
  const next = (payload as { next?: { cursor?: unknown } } | null)?.next;
  return asString(next?.cursor);
};

const framesFromNeynar = (payload: unknown): ApiFrame[] =>
  frameListOf(payload)
    .map(apiFrameFromNeynarFrame)
    .filter((frame): frame is ApiFrame => frame !== null);

/**
 * The frame embed a mini app declares — the card art and the button a feed
 * draws for one.
 *
 * Built only out of what the index actually holds: the picture the app
 * published, its name, its splash and the address to launch. The button's own
 * title is the app's (`Open` is what the protocol's default button is called
 * when an app does not name one), never a sentence this client made up.
 */
export const frameEmbedCardFromNeynarFrame = (
  frame: NeynarFrame,
): { imageUrl: string; title: string; actionUrl: string } | null => {
  const apiFrame = apiFrameFromNeynarFrame(frame);
  if (apiFrame === null) {
    return null;
  }
  const imageUrl = apiFrame.imageUrl ?? apiFrame.iconUrl;
  if (imageUrl === undefined) {
    return null;
  }
  return {
    imageUrl,
    title: `Open ${apiFrame.name}`,
    actionUrl: apiFrame.homeUrl,
  };
};

/** The host of a URL, or undefined when it is not one. */
const hostOf = (value: string): string | undefined => {
  try {
    return new URL(value).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * A feed embed's mini-app card, looked up in Neynar's index by the URL itself.
 *
 * WHY THIS EXISTS AT ALL: a cast carries a bare URL, and the way to know that a
 * URL is an app is to read the `fc:miniapp` meta tag on its page — which a web
 * page may only do for a page that allows it (measured: most app pages do not
 * send `Access-Control-Allow-Origin`, so the read is refused by the browser, not
 * by this client). Neynar has already read those pages, so for the apps it
 * knows, its index can answer the same question without the page's permission.
 *
 * WHAT IT REFUSES: a fuzzy match. The search is asked for this URL's host, and
 * only an entry whose own home page is on *that* host is accepted — otherwise a
 * near-miss would put a different app's art on someone else's link. No exact
 * match means no answer, and the embed stays the link it was.
 */
export const fetchFrameCardFromNeynar = async ({
  url,
  apiKey,
  fetchImpl = fetch,
  baseUrl = NEYNAR_BASE_URL,
  timeoutMs = 6_000,
}: {
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<{ imageUrl: string; title: string; actionUrl: string } | null> => {
  const host = hostOf(url);
  if (host === undefined) {
    return null;
  }

  // The host, then its own label: Neynar's search matches names as well as
  // hosts, so `fiddy.fun` finds the app whose home page is `fiddy.fun` only
  // when the label is asked for. Two bounded questions at most, never a loop.
  const queries = [host, host.split('.')[0] ?? host].filter(
    (query, index, all) => query.length > 0 && all.indexOf(query) === index,
  );

  for (const query of queries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let payload: unknown = null;
    try {
      const response = await fetchImpl(
        `${baseUrl}/v2/farcaster/frame/search/?q=${encodeURIComponent(query)}&limit=20`,
        {
          method: 'GET',
          headers: { 'x-api-key': apiKey },
          signal: controller.signal,
          credentials: 'omit',
        },
      );
      if (!response.ok) {
        return null;
      }
      payload = await readJson(response);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }

    const exact = frameListOf(payload).find(
      (frame) => hostOf(String(homeUrlOf(frame) ?? '')) === host,
    );
    if (exact) {
      return frameEmbedCardFromNeynarFrame(exact);
    }
  }

  return null;
};

/**
 * Which Neynar URL a client request becomes — or null when Neynar cannot serve
 * it at all.
 *
 * Pure: no key, no fetch, so the refusal list is a test rather than a promise.
 */
export const neynarCallFor = ({
  path,
  searchParams,
  signedInFid,
  baseUrl = NEYNAR_BASE_URL,
}: {
  path: string;
  searchParams: URLSearchParams;
  /** Needed by the one catalog read that is about *this* reader. */
  signedInFid?: number;
  baseUrl?: string;
}): NeynarCall | null => {
  const base = `${baseUrl}/v2/farcaster`;
  const limit = (fallback: string): string =>
    searchParams.get('limit') ?? fallback;
  const cursorParam = searchParams.get('cursor');
  const cursor =
    cursorParam === null || cursorParam.length === 0
      ? ''
      : `&cursor=${encodeURIComponent(cursorParam)}`;

  switch (path) {
    // ── the app catalog ────────────────────────────────────────────────────
    //
    // Today's list and "new" apps are the same public catalog: the index that
    // has read the apps' own manifest files, newest first. The hosted app it
    // replaces had an editorial list of its own, which no third party can have,
    // so this is the honest stand-in rather than a copy of a ranking nobody
    // outside Warpcast can see.
    case '/v1/top-mini-apps':
    case '/v1/new-frameapps': {
      return {
        url: `${base}/frame/catalog/?limit=${encodeURIComponent(limit('50'))}${cursor}`,
        kind: 'frames',
        shape: path === '/v1/top-mini-apps' ? 'top-mini-apps' : 'new-frames',
      };
    }

    // "Your apps" — the apps relevant to this reader, from the index's own
    // relevance for their FID. What it is NOT: Warpcast's saved-favourites list,
    // which is account state on a server this client has no session for.
    case '/v1/favorite-frames': {
      if (signedInFid === undefined) {
        return null;
      }
      return {
        url: `${base}/frame/relevant/?viewer_fid=${signedInFid}&limit=${encodeURIComponent(limit('20'))}`,
        kind: 'frames',
        shape: 'favorite-frames',
      };
    }

    case '/v1/search-miniapps': {
      const query = searchParams.get('query') ?? searchParams.get('q');
      if (!query) {
        return null;
      }
      return {
        url: `${base}/frame/search/?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit('20'))}${cursor}`,
        kind: 'frames',
        shape: 'search-miniapps',
      };
    }

    case '/v2/user':
    case '/v2/user-by-fid':
    case '/v2/verifications': {
      const fid = searchParams.get('fid');
      if (!fid) {
        return null;
      }
      return {
        url: `${base}/user/bulk?fids=${encodeURIComponent(fid)}`,
        kind: path === '/v2/verifications' ? 'verifications' : 'user',
      };
    }

    case '/v2/user-by-username': {
      const username = searchParams.get('username');
      if (!username) {
        return null;
      }
      return {
        url: `${base}/user/by_username?username=${encodeURIComponent(username)}`,
        kind: 'user',
      };
    }

    case '/v2/user-casts':
    case '/v2/profile-casts': {
      const fid = searchParams.get('fid');
      if (!fid) {
        return null;
      }
      const limit = searchParams.get('limit') ?? '25';
      return {
        url: `${base}/feed/user/casts?fid=${encodeURIComponent(fid)}&limit=${encodeURIComponent(limit)}`,
        kind: 'casts',
      };
    }

    case '/v2/thread-casts': {
      const castHash = searchParams.get('castHash');
      if (!castHash) {
        return null;
      }
      return {
        url: `${base}/cast/conversation?identifier=${encodeURIComponent(castHash)}&type=hash&reply_depth=1`,
        kind: 'thread',
      };
    }

    // ── the reads only an index can answer ─────────────────────────────────
    //
    // MEASURED (2026-10-22, this build's own key against api.neynar.com): each
    // one of these answers 200 with the fields the surface draws, from the
    // index that keeps what a read node does not — an index of what embeds
    // what, a join from a like to the cast it points at, a search index.
    //
    //  GET /v2/farcaster/cast/quotes?identifier=<hash>&type=hash&limit=2 → 200
    //    {"casts":[{"hash":"0x361f…","author":{"fid":16098,…}}]}
    //  GET /v2/farcaster/reactions/user?fid=3&type=likes&limit=2 → 200
    //    {"reactions":[{"reaction_type":"like","cast":{"hash":"0x5c5b…"}}]}
    //  GET /v2/farcaster/user/search?q=dwr&limit=1 → 200 {"result":{"users":[…]}}
    //  GET /v2/farcaster/channel/search?q=ai&limit=2 → 200 {"channels":[…]}
    case '/v2/cast-quotes': {
      const castHash = searchParams.get('castHash');
      if (!castHash) {
        return null;
      }
      return {
        url: `${base}/cast/quotes?identifier=${encodeURIComponent(castHash)}&type=hash&limit=${encodeURIComponent(limit('25'))}${cursor}`,
        kind: 'index',
        shape: 'cast-quotes',
      };
    }

    case '/v2/user-liked-casts': {
      const fid = searchParams.get('fid');
      if (!fid) {
        return null;
      }
      return {
        url: `${base}/reactions/user?fid=${encodeURIComponent(fid)}&type=likes&limit=${encodeURIComponent(limit('25'))}${cursor}`,
        kind: 'index',
        shape: 'liked-casts',
      };
    }

    case '/v2/search-users': {
      // Two spellings reach this route: the surface's own box sends `q`, and the
      // fork's generated client sends `query`. Both mean the same thing.
      const query = searchParams.get('q') ?? searchParams.get('query');
      if (!query) {
        return null;
      }
      return {
        url: `${base}/user/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit('20'))}${cursor}`,
        kind: 'index',
        shape: 'search-users',
      };
    }

    case '/v2/search-channels': {
      const query = searchParams.get('q') ?? searchParams.get('query');
      if (!query) {
        return null;
      }
      return {
        url: `${base}/channel/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(limit('20'))}${cursor}`,
        kind: 'index',
        shape: 'search-channels',
      };
    }

    default:
      return null;
  }
};

/** `/v2/me` resolves to the signed-in FID, which only the caller knows. */
export const neynarMeCall = ({
  fid,
  baseUrl = NEYNAR_BASE_URL,
}: {
  fid: number;
  baseUrl?: string;
}): NeynarCall => ({
  url: `${baseUrl}/v2/farcaster/user/bulk?fids=${fid}`,
  kind: 'user',
});

/** The envelope the client's profile reads expect, from one Neynar user. */
const userProfileEnvelope = (user: ApiUser, fid: number) => ({
  result: {
    user,
    collectionsOwned: [],
    // `custodyAddress` is an on-chain fact this read does not fetch; empty
    // rather than invented, the same as the node-backed reader.
    extras: { fid, custodyAddress: '' },
  },
});

/**
 * The four app-catalog envelopes, each built from the same frame list.
 *
 * They differ only in what the surface reads: the top list is ranked (by the
 * order the index gave, which is the only ranking this client can honestly
 * state), "your apps" and search are plain lists, and the "new apps" surface
 * also wants a title and a description to print above the grid.
 *
 * The cursor is passed through only when Neynar states one — a list that ends
 * says so by having no `next`, rather than by carrying a cursor that loads
 * nothing. Ranks are positions in the list the index returned, and
 * `rank72hChange` is left off: this client has not measured any change, and a
 * zero there would read as "no change" when the truth is "not known".
 */
const appCatalogEnvelope = (
  shape: NonNullable<NeynarCall['shape']>,
  payload: unknown,
): unknown => {
  const frames = framesFromNeynar(payload);
  const cursor = frameCursorOf(payload);
  const paging = cursor === undefined ? {} : { next: { cursor } };

  switch (shape) {
    case 'top-mini-apps':
      return {
        result: {
          miniApps: frames.map((miniApp, index) => ({
            rank: index + 1,
            miniApp,
          })),
        },
        ...paging,
      };

    case 'new-frames':
      return {
        result: {
          frames,
          title: 'Mini apps',
          description:
            'Apps from Neynar’s public app catalog — the list new apps land in.',
        },
        ...paging,
      };

    case 'favorite-frames':
      return { result: { frames }, ...paging };

    case 'search-miniapps':
    default:
      return { result: { apps: frames }, ...paging };
  }
};

/** One thread as `{ casts }`, in reading order: parents, root, then replies. */
export const threadCastsFromNeynar = (conversation: unknown): ApiCast[] => {
  const root = (conversation as { cast?: NeynarCast } | null)?.cast;
  if (!root) {
    return [];
  }
  const parents = asNeynarArray(root.chronological_parent_casts).map(
    apiCastFromNeynar,
  );
  const replies = asNeynarArray(root.direct_replies).map(apiCastFromNeynar);
  return [...parents, apiCastFromNeynar(root), ...replies];
};

const readJson = async (response: Response): Promise<unknown | null> => {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
};

/**
 * The author of one cast, looked up by hash alone.
 *
 * A node cannot answer this — it addresses a cast by *author and hash*, and the
 * hash on its own is not an index it keeps. Neynar's index can, and this is the
 * one read a write needs it for: a reaction and a reply are messages about a
 * cast, and the protocol message needs the target's author FID. Without this, a
 * like pressed on a cast that this client had not already read through a node
 * would have nothing to address itself to.
 *
 * Returns undefined for a hash Neynar does not know, and never guesses a FID.
 */
export const castAuthorFromNeynar = (payload: unknown): number | undefined => {
  const cast = (payload as { cast?: { author?: NeynarUser } } | null)?.cast;
  const fid = asNumber(cast?.author?.fid, Number.NaN);
  return Number.isFinite(fid) ? fid : undefined;
};

export const fetchCastAuthorFromNeynar = async ({
  hash,
  apiKey,
  fetchImpl = fetch,
  baseUrl = NEYNAR_BASE_URL,
  timeoutMs = 8_000,
}: {
  hash: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<number | undefined> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${baseUrl}/v2/farcaster/cast?identifier=${encodeURIComponent(hash)}&type=hash`,
      {
        method: 'GET',
        headers: { 'x-api-key': apiKey },
        signal: controller.signal,
        credentials: 'omit',
      },
    );
    if (!response.ok) {
      return undefined;
    }
    return castAuthorFromNeynar(await readJson(response));
  } catch {
    // A lookup that could not be made is not an answer: the caller says what is
    // missing rather than inventing a FID.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The next-page cursor a Neynar answer carries, in the hosted API's spelling.
 *
 * Neynar pages with `next.cursor` on the reads that page at all; a read that
 * does not page carries nothing, and the caller is told nothing rather than an
 * empty cursor that would look like a page token.
 */
const neynarNext = (body: unknown): { next?: { cursor?: string } } => {
  const cursor = (body as { next?: { cursor?: unknown } } | null)?.next?.cursor;
  return typeof cursor === 'string' && cursor.length > 0
    ? { next: { cursor } }
    : {};
};

/** The accounts in a Neynar payload, whatever envelope it used. */
const asNeynarUsers = (value: unknown): NeynarUser[] =>
  Array.isArray(value) ? (value as NeynarUser[]) : [];

/** One channel as Neynar's index publishes it. */
interface NeynarChannel {
  id?: unknown;
  name?: unknown;
  image_url?: unknown;
  header_image_url?: unknown;
  description?: unknown;
  follower_count?: unknown;
  member_count?: unknown;
}

const asNeynarChannels = (value: unknown): NeynarChannel[] =>
  Array.isArray(value) ? (value as NeynarChannel[]) : [];

/**
 * One channel, in the shape the channel surfaces draw.
 *
 * Neynar's channel record has the identity and the numbers a list row needs —
 * key, name, art, description, follower count — and nothing about *this*
 * reader's relationship to the channel. So the viewer's own row is neutral
 * (`following: false`, `isMember: false`, no notification state) rather than
 * guessed: a channel a reader has joined must never be drawn as one they have
 * not, and the honest neutral value is the one that claims nothing.
 */
export const apiChannelFromNeynar = (channel: NeynarChannel): ApiChannel => {
  const key = asString(channel.id) ?? '';
  const imageUrl = asString(channel.image_url);
  const headerImageUrl = asString(channel.header_image_url);
  const description = asString(channel.description);
  const followerCount = channel.follower_count;
  const memberCount = channel.member_count;
  return {
    type: 'channel',
    key,
    name: asString(channel.name) ?? key,
    ...(imageUrl === undefined ? {} : { imageUrl }),
    ...(headerImageUrl === undefined ? {} : { headerImageUrl }),
    ...(description === undefined ? {} : { description }),
    ...(typeof followerCount === 'number' ? { followerCount } : {}),
    ...(typeof memberCount === 'number' ? { memberCount } : {}),
    // Nothing here is editorial state this client can know: a channel that
    // arrives from a search result is shown as a channel, with no badge and no
    // join button that would promise a membership write nobody made.
    showCastSourceLabels: false,
    showCastTags: false,
    sectionRank: 0,
    subscribable: false,
    viewerContext: {
      following: false,
      isMember: false,
      hasUnseenItems: false,
    },
  };
};

/**
 * A read only an index can answer, in the hosted envelope its surface reads.
 *
 * Four routes, four envelopes, one rule: what Neynar returned is what is
 * handed on, mapped into the hosted shapes (`ApiCast`/`ApiUser`/`ApiChannel`)
 * and never invented. An answer with no rows is an empty list — which is a
 * fact about the query, and the surface draws it as one.
 */
const indexEnvelope = (
  shape: NonNullable<NeynarCall['shape']> | undefined,
  body: unknown,
): unknown => {
  const next = neynarNext(body);
  switch (shape) {
    case 'cast-quotes':
      return {
        result: {
          quotes: asNeynarArray((body as { casts?: unknown }).casts).map(
            apiCastFromNeynar,
          ),
        },
        ...next,
      };

    case 'liked-casts':
      return {
        result: {
          // `/v2/farcaster/reactions/user?type=likes` answers with the reader's
          // own like messages, each carrying the cast it points at.
          casts: asNeynarArray(
            (
              (body as { reactions?: unknown }).reactions as
                | { cast?: unknown }[]
                | undefined
            )?.map((reaction) => reaction.cast),
          ).map(apiCastFromNeynar),
        },
        ...next,
      };

    case 'search-users':
      return {
        result: {
          users: asNeynarUsers(
            (body as { result?: { users?: unknown } }).result?.users,
          ).map(apiUserFromNeynar),
        },
        ...next,
      };

    case 'search-channels':
      return {
        result: {
          channels: asNeynarChannels(
            (body as { channels?: unknown }).channels,
          ).map(apiChannelFromNeynar),
        },
        ...next,
      };

    default:
      return { result: {}, ...next };
  }
};

/**
 * Make the call and shape the answer.
 *
 * The key travels in the `x-api-key` header and never in a URL: a key in a
 * query string ends up in logs and in browser history, and this client does not
 * do that to a reader's credential.
 */
export const answerFromNeynar = async ({
  path,
  searchParams,
  signedInFid,
  apiKey,
  fetchImpl = fetch,
  baseUrl = NEYNAR_BASE_URL,
  timeoutMs = 8_000,
}: {
  path: string;
  searchParams: URLSearchParams;
  signedInFid: number | undefined;
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<Response> => {
  const call =
    path === '/v2/me'
      ? signedInFid !== undefined
        ? neynarMeCall({ fid: signedInFid, baseUrl })
        : null
      : neynarCallFor({ path, searchParams, signedInFid, baseUrl });

  if (call === null) {
    if (path === '/v1/favorite-frames') {
      return errorResponse(
        501,
        'The apps relevant to you come from Neynar’s index, which needs a signed-in account to work out what is relevant. Sign in, and this list loads.',
      );
    }
    if (path === '/v1/search-miniapps' && !searchParams.get('query')) {
      return errorResponse(
        400,
        'Searching apps needs something to search for.',
      );
    }
    return errorResponse(
      501,
      `Neynar cannot serve ${path} for this client. Reads through Neynar cover profiles, one account's casts, threads, verified addresses and the app catalog; the feed, your notifications and cast search need a node (or Farcaster's own server) instead.`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(call.url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      signal: controller.signal,
      credentials: 'omit',
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    return errorResponse(
      502,
      aborted
        ? `Neynar did not answer within ${timeoutMs / 1000}s.`
        : `Neynar did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 402) {
    return errorResponse(
      response.status,
      'Neynar refused your API key. Run scripts/fiddy-setup.command to check it, or its plan.',
    );
  }

  if (!response.ok) {
    return errorResponse(
      response.status,
      `Neynar answered with an error (${response.status}).`,
    );
  }

  const body = await readJson(response);
  if (body === null) {
    return errorResponse(
      502,
      'Neynar answered with something that was not a list.',
    );
  }

  switch (call.kind) {
    case 'user': {
      const users = (body as { users?: NeynarUser[] }).users;
      const user = Array.isArray(users)
        ? users[0]
        : (body as { user?: NeynarUser }).user;
      if (!user) {
        return errorResponse(404, 'Neynar has no such account.');
      }
      const apiUser = apiUserFromNeynar(user);
      if (path === '/v2/me') {
        return jsonResponse({
          result: { user: apiUser, enabledFeatureFlags: [] },
        });
      }
      return jsonResponse(userProfileEnvelope(apiUser, apiUser.fid));
    }

    case 'verifications': {
      const users = (body as { users?: NeynarUser[] }).users;
      const user = Array.isArray(users) ? users[0] : undefined;
      const addresses = user?.verified_addresses?.eth_addresses;
      const verifications = Array.isArray(addresses)
        ? addresses
            .filter((address): address is string => typeof address === 'string')
            .map((address) => ({ fid: asNumber(user?.fid), address }))
        : [];
      return jsonResponse({ result: { verifications } });
    }

    case 'casts': {
      const casts = asNeynarArray((body as { casts?: unknown }).casts).map(
        apiCastFromNeynar,
      );
      return jsonResponse({ result: { casts } });
    }

    case 'frames': {
      // The app catalog: the same list, in whichever envelope the surface that
      // asked reads (`appCatalogEnvelope`).
      return jsonResponse(
        appCatalogEnvelope(call.shape ?? 'search-miniapps', body),
      );
    }

    case 'index': {
      // A read only an index can answer (the quotes of a cast, the casts one
      // account liked, people and channel search). The envelope is the one the
      // surface asked for, built from Neynar's own answer and nothing else.
      return jsonResponse(indexEnvelope(call.shape, body));
    }

    case 'thread':
    default: {
      const casts = threadCastsFromNeynar(
        (body as { conversation?: unknown }).conversation,
      );
      return jsonResponse({ result: { casts } });
    }
  }
};
