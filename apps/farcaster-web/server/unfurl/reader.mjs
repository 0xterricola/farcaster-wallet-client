/**
 * What a cast and a profile ARE, read the way the client reads them.
 *
 * Two sources, each used only for what it can answer:
 *
 *   * the Snapchain node — `/v1/castById?fid=&hash=`, `/v1/userDataByFid`,
 *     and a bounded reverse `/v1/castsByFid` page for a profile's latest posts,
 *     the same reads the reader's own client makes, so a card shows what the
 *     app shows;
 *   * Neynar, for exactly one thing: turning a cast HASH into its author's FID.
 *
 * That second one is not a shortcut, it is the shape of the network. A
 * Snapchain node shards by FID, so `castById` needs the author as well as the
 * hash, and a cast URL carries only the hash (the fork's own readers say so in
 * `src/snapchain/nodeApi/reads.ts`). The client remembers the author of every
 * cast it has served; a service answering a request from a stranger has not
 * served anything, so it asks the one index that can answer — and remembers the
 * answer, because a cast's author never changes.
 *
 * Nothing here guesses. A hash Neynar does not know, a node that does not have
 * the cast, a node that does not answer: each is `undefined`, and the caller
 * serves the plain shell rather than a card full of invented facts.
 */

const CACHE = {
  castAuthorMs: 6 * 60 * 60 * 1000,
  castMs: 10 * 60 * 1000,
  userMs: 10 * 60 * 1000,
  feedMs: 10 * 60 * 1000,
};

export const PROFILE_CAST_LIMIT = 10;

/**
 * Farcaster's own public client API (`api.farcaster.xyz`) — the same safety
 * net the client's provider catalog keeps last. It answers a profile's casts
 * at `/v2/profile-casts?fid=` with no account and no key; a page cannot read
 * it (CORS, measured — `providers/publicServerOffTheWeb.ts`), but this
 * service is not a page. It serves TOP-LEVEL casts only, so it can stand in
 * for a feed's default page and never for `?replies=1`.
 */
export const FARCASTER_PUBLIC_BASE_URL = 'https://api.farcaster.xyz';

/** A feed page asks the node for more than it shows, like every other list here. */
export const FEED_PAGE_SIZE = 50;

/** The protocol's own clock: message timestamps are seconds from this epoch. */
const FARCASTER_EPOCH_MS = 1609459200000;

/** A full cast hash: `0x` and 20 bytes of hex. A prefix is not answerable. */
export const isFullCastHash = (value) =>
  /^0x[0-9a-f]{40}$/i.test(String(value ?? ''));

/** A FID as the URLs spell it. */
export const parseFid = (value) => {
  const fid = Number(String(value ?? '').trim());
  return Number.isSafeInteger(fid) && fid >= 0 ? fid : undefined;
};

/** A tiny promise cache: one answer per key per window, and a bound on size. */
export const createCache = ({
  ttlMs,
  max = 500,
  now = () => Date.now(),
} = {}) => {
  const entries = new Map();
  return {
    async readOrLoad(key, load) {
      const hit = entries.get(key);
      if (hit && now() - hit.at < hit.ttlMs) {
        return hit.value;
      }
      const value = await load();
      if (value === undefined) {
        return undefined;
      }
      if (entries.size >= max) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { at: now(), ttlMs: hit?.ttlMs ?? ttlMs, value });
      return value;
    },
    /** Remember something for its own window (an author is colder than a cast). */
    remember(key, value, ttl) {
      if (value === undefined) {
        return;
      }
      if (entries.size >= max) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { at: now(), ttlMs: ttl, value });
    },
    size: () => entries.size,
  };
};

const jsonOrUndefined = async (response) => {
  if (!response?.ok) {
    return undefined;
  }
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/**
 * The FID that wrote a cast, from the one index that answers a bare hash.
 *
 * Neynar's `cast?identifier=&type=hash` is the shape the client already uses on
 * its write path (`fetchCastAuthorFromNeynar`), so this is the same question
 * asked from the server side of the wire, with the same refusal to invent a FID
 * when the answer is not there.
 */
export const fetchCastAuthor = async ({
  hash,
  apiKey,
  fetchImpl,
  baseUrl = 'https://api.neynar.com',
  timeoutMs = 8000,
}) => {
  if (!apiKey || !isFullCastHash(hash)) {
    return undefined;
  }
  const response = await fetchImpl(
    `${baseUrl}/v2/farcaster/cast?identifier=${encodeURIComponent(hash)}&type=hash`,
    {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    },
  ).catch(() => undefined);
  const payload = await jsonOrUndefined(response);
  const fid = Number(payload?.cast?.author?.fid);
  return Number.isSafeInteger(fid) ? fid : undefined;
};

/** A profile's own words, from the node. */
export const userDataFromMessages = (messages, fid) => {
  const valueOf = (type) => {
    for (const message of messages ?? []) {
      const body = message?.data?.userDataBody;
      if (body?.type === type && typeof body.value === 'string') {
        return body.value;
      }
    }
    return undefined;
  };
  return {
    fid,
    username: valueOf('USER_DATA_TYPE_USERNAME'),
    displayName: valueOf('USER_DATA_TYPE_DISPLAY'),
    bio: valueOf('USER_DATA_TYPE_BIO'),
  };
};

export const castTextFromMessage = (message) => {
  // The node hands back a MESSAGE, not a bare body: `/v1/castById` answers
  // `{"data":{"castAddBody":{"text":…}}}` and `/v1/castsByFid` the same message
  // inside `messages`. Reading `message.castAddBody` finds nothing on the real
  // node and every cast page silently falls back to the site card — the flat
  // form is accepted too, because a card renderer is not the place to be strict
  // about an envelope somebody already unwrapped.
  const body = message?.data?.castAddBody ?? message?.castAddBody;
  return typeof body?.text === 'string' ? body.text : undefined;
};

/**
 * A feed's cast, mapped once from whichever server answered, so the writer
 * (`feed.mjs`) never knows a wire shape. `parent` marks a reply (the node
 * spells it `parentCastId`); `embeds` keeps only what a reader can be shown
 * (a URL, or a full cast hash to link as a quoted cast).
 */
export const feedCastFromNodeMessage = (message) => {
  const hash = message?.hash;
  if (!isFullCastHash(hash)) {
    return undefined;
  }
  const body = message?.data?.castAddBody;
  const timestamp = Number(message?.data?.timestamp);
  return {
    hash,
    fid: Number(message?.data?.fid),
    text: typeof body?.text === 'string' ? body.text : '',
    timestampMs: Number.isFinite(timestamp)
      ? timestamp * 1000 + FARCASTER_EPOCH_MS
      : undefined,
    parent: body?.parentCastId != null,
    embeds: Array.isArray(body?.embeds)
      ? body.embeds.filter(
          (embed) =>
            (typeof embed?.url === 'string' && embed.url) ||
            isFullCastHash(embed?.castId?.hash),
        )
      : [],
  };
};

/** The same shape, from Farcaster's public server (`/v2/profile-casts`). */
export const feedCastFromPublicCast = (cast) => {
  if (!isFullCastHash(cast?.hash)) {
    return undefined;
  }
  const embeds = cast?.embeds ?? {};
  const urls = [
    ...(Array.isArray(embeds.images) ? embeds.images : []),
    ...(Array.isArray(embeds.urls) ? embeds.urls : []),
  ]
    .map((each) => (typeof each?.url === 'string' ? { url: each.url } : undefined))
    .filter(Boolean);
  const quotes = (Array.isArray(embeds.casts) ? embeds.casts : [])
    .filter((each) => isFullCastHash(each?.hash))
    .map((each) => ({ castId: { hash: each.hash } }));
  return {
    hash: cast.hash,
    fid: Number(cast?.author?.fid),
    text: typeof cast?.text === 'string' ? cast.text : '',
    timestampMs: Number(cast?.timestamp),
    // The public server serves top-level casts only; there is no reply to mark.
    parent: false,
    embeds: [...urls, ...quotes],
  };
};

/**
 * The parent URLs a channel key could be carried under, in the order to try.
 *
 * A key that already spells a URL (`https://…/~/channel/x`, `chain://…`) is
 * the channel's real parent URL and is asked exactly as given. A bare key is
 * spelled the way the network actually carries channels — MEASURED
 * (2026-10-22, `reads.ts`): `warpcast.com/~/channel/snaps` answers casts,
 * `farcaster.xyz/~/channel/snaps` answers none — so the warpcast spelling is
 * asked first and the farcaster.xyz one only when the first came back empty.
 */
export const channelParentUrls = (key) => {
  const value = String(key ?? '').trim();
  if (/^(https?:\/\/|chain:\/\/)/.test(value)) {
    return [value];
  }
  return [
    `https://warpcast.com/~/channel/${value}`,
    `https://farcaster.xyz/~/channel/${value}`,
  ];
};

/** A read the SERVER answered with "nobody by that name": a miss, not a failure. */
class NoSuchFeed extends Error {}

/**
 * The readers, with one cache each and an injectable fetch (so a test answers
 * without a network, the same rule every other reader in this repo follows).
 */
export const createLinkReader = ({
  fetchImpl,
  nodeBaseUrl,
  /**
   * Neynar's API key, for the cast-hash → author index. Optional in fact (an
   * absent key means no author lookup), but typed here so the checker does
   * not guess `undefined` from the one early return that reads it.
   * @type {string | undefined}
   */
  neynarApiKey,
  neynarBaseUrl = 'https://api.neynar.com',
  /**
   * This host's public origin, used only to NAME the read server that
   * answered a feed: a node reached through this app's own proxy is the
   * relay, any other node is named by its origin — the same shape the parity
   * probe reports (`node:<origin>` / `relay` / `farcaster-public`). The empty
   * default means "no origin given": a reader built without it names every
   * node by the node's own origin.
   */
  appOrigin = '',
  farcasterPublicBaseUrl = FARCASTER_PUBLIC_BASE_URL,
  timeoutMs = 8000,
  now = () => Date.now(),
  caches = CACHE,
}) => {
  const cache = createCache({ ttlMs: caches.castMs, now });
  // A feed's READ is kept for its own window (quilcast's number: 10 minutes),
  // apart from the page cache, so a feed and a page can never evict each
  // other's entries by one another's rules. A missing feed is remembered for
  // the same window; a FAILED read is remembered not at all.
  const feedCache = createCache({ ttlMs: caches.feedMs, now });
  const get = (path) =>
    fetchImpl(`${nodeBaseUrl.replace(/\/$/, '')}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });

  /**
   * Which read server answered a feed, named the way the parity probe names
   * them: `relay` when this app's own proxy carried the read, `node:<origin>`
   * for any other node, `farcaster-public` for Farcaster's own server. Neynar
   * is deliberately absent: it stays the cast-hash → author index it already
   * is here and is never asked for a feed's content.
   */
  const nodeLabel = (() => {
    try {
      const origin = new URL(nodeBaseUrl).origin;
      return appOrigin && new URL(appOrigin).origin === origin
        ? 'relay'
        : `node:${origin}`;
    } catch {
      return 'relay';
    }
  })();

  /**
   * A chain read that FAILS OUT LOUD, unlike `get` (whose failures the page
   * paths read as "no such page"). A feed must know the difference between
   * "the server said no" and "the server did not answer", because the one is
   * a 404 and the other is a retry-later — and because the chain below moves
   * to the next server on exactly that signal.
   *
   * `missStatuses` are the answers that mean the SERVER said "nobody by that
   * name" (Farcaster's public server answers 404 for an unknown fid): those
   * throw `NoSuchFeed`, which a feed turns into "no such feed" rather than
   * "try again".
   */
  const readJsonOrThrow = async (url, missStatuses = []) => {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) {
      if (missStatuses.includes(response?.status)) {
        throw new NoSuchFeed(`${new URL(url).host} answered ${response?.status}`);
      }
      throw new Error(`${new URL(url).host} answered ${response?.status}`);
    }
    return await response.json();
  };

  const userData = (fid) =>
    cache.readOrLoad(`user:${fid}`, async () => {
      const payload = await jsonOrUndefined(
        await get(`/v1/userDataByFid?fid=${fid}&pageSize=32`).catch(
          () => undefined,
        ),
      );
      if (!payload?.messages?.length) {
        return undefined;
      }
      return userDataFromMessages(payload.messages, fid);
    });

  const latestCasts = (fid) =>
    cache.readOrLoad(`latest:${fid}`, async () => {
      const payload = await jsonOrUndefined(
        await get(
          `/v1/castsByFid?fid=${fid}&pageSize=${PROFILE_CAST_LIMIT}&reverse=true`,
        ).catch(() => undefined),
      );
      if (!Array.isArray(payload?.messages)) {
        // A failed page is not an empty one. Keep those states separate so the
        // crawler never says a person has no posts when the read simply failed.
        return undefined;
      }
      return payload.messages
        .map((message) => {
          const text = castTextFromMessage(message);
          const hash = message?.hash;
          return text !== undefined && isFullCastHash(hash)
            ? { hash, fid, text }
            : undefined;
        })
        .filter(Boolean)
        .slice(0, PROFILE_CAST_LIMIT);
    });

  const castByAuthor = (fid, hash) =>
    cache.readOrLoad(`cast:${fid}:${hash.toLowerCase()}`, async () => {
      const payload = await jsonOrUndefined(
        await get(
          `/v1/castById?fid=${fid}&hash=${encodeURIComponent(hash)}`,
        ).catch(() => undefined),
      );
      const text = castTextFromMessage(payload);
      return text === undefined ? undefined : { hash, fid, text };
    });

  const castAuthor = (hash) =>
    cache.readOrLoad(`author:${hash.toLowerCase()}`, async () => {
      const fid = await fetchCastAuthor({
        hash,
        apiKey: neynarApiKey,
        fetchImpl,
        baseUrl: neynarBaseUrl,
        timeoutMs,
      });
      // An author is a fact about a cast, not about a moment: it is remembered
      // far longer than the cast's text is.
      cache.remember(`author:${hash.toLowerCase()}`, fid, caches.castAuthorMs);
      return fid;
    });

  /** `@dwr`, or `fid 3` when the account has no name to print. */
  const handleOf = (author) =>
    author?.username
      ? `@${author.username}`
      : `fid ${author?.fid ?? ''}`.trim();

  /** A feed item's creator line: the name a reader shows, beside the handle. */
  const creatorOf = (author) => {
    const handle = handleOf(author);
    const display = author?.displayName?.trim();
    return display && display !== handle ? `${display} (${handle})` : handle;
  };

  /**
   * One account's feed: its profile (so the feed can be titled and a nameless
   * FID can be refused), and its newest casts — the node's own reads first,
   * and Farcaster's public server only when the node does not answer, which
   * is the same failover the client's provider chain performs (node first;
   * the public server is the safety net, and it serves top-level casts only —
   * with replies asked for, a dead node is a failed read rather than a
   * quietly thinner feed).
   *
   * `undefined` means no such feed: an account the answering servers cannot
   * name (a nameless FID, an id nobody has). A read that failed THROWS, so
   * the caller can say "try again" instead of "no such feed" — a node that is
   * down is not allowed to say an account does not exist (the rule the
   * profile pages already hold, card t_5eb7e2b5). Which server answered is in
   * `source`, in the parity probe's own vocabulary.
   */
  const accountFeedRead = async (fid, { replies = false } = {}) => {
    try {
      return await feedCache.readOrLoad(
        `feed:${fid}:${replies ? 1 : 0}`,
        async () => {
          const publicProfile = () =>
            readJsonOrThrow(
              `${farcasterPublicBaseUrl}/v2/user-by-fid?fid=${fid}`,
              [400, 404],
            ).then((payload) => {
              const user = payload?.result?.user;
              return user
                ? {
                    fid,
                    username:
                      typeof user.username === 'string' && user.username
                        ? user.username
                        : undefined,
                    displayName:
                      typeof user.displayName === 'string' && user.displayName
                        ? user.displayName
                        : undefined,
                    bio:
                      typeof user.profile?.bio?.text === 'string'
                        ? user.profile.bio.text
                        : undefined,
                  }
                : undefined;
            });

          let author;
          let source = nodeLabel;
          let nodeIsDown = false;
          try {
            const payload = await readJsonOrThrow(
              `${nodeBaseUrl.replace(/\/$/, '')}/v1/userDataByFid?fid=${fid}&pageSize=32`,
            );
            const messages = payload?.messages;
            if (!Array.isArray(messages)) {
              throw new Error('the node answered no user data');
            }
            author = messages.length
              ? userDataFromMessages(messages, fid)
              : undefined;
          } catch {
            // The node did not answer: the public server names the account,
            // or nobody does. A node that is down must not be allowed to say
            // an account does not exist.
            nodeIsDown = true;
            source = 'farcaster-public';
            author = await publicProfile();
          }
          if (!author) {
            // A profile the node HOLDS with no user data is a nameless FID: a
            // real protocol state, and no such feed. A node that answered
            // with nothing because it is down has already fallen through
            // above; here the answer is the account's own.
            return { missing: true };
          }

          const who = creatorOf(author);
          let casts;
          if (!nodeIsDown) {
            try {
              const payload = await readJsonOrThrow(
                `${nodeBaseUrl.replace(/\/$/, '')}/v1/castsByFid?fid=${fid}&pageSize=${FEED_PAGE_SIZE}&reverse=true`,
              );
              if (!Array.isArray(payload?.messages)) {
                throw new Error('the node answered no cast page');
              }
              casts = payload.messages
                .map((message) => {
                  const cast = feedCastFromNodeMessage(message);
                  return cast ? { ...cast, who } : undefined;
                })
                .filter(Boolean);
            } catch (error) {
              nodeIsDown = true;
              source = 'farcaster-public';
              if (replies) {
                throw new Error(
                  `the account's replies could not be read (${error?.message ?? error}); only a node holds them`,
                );
              }
            }
          }
          if (nodeIsDown) {
            if (replies) {
              throw new Error(
                'the account’s replies could not be read; only a node holds them',
              );
            }
            const payload = await readJsonOrThrow(
              `${farcasterPublicBaseUrl}/v2/profile-casts?fid=${fid}&limit=${FEED_PAGE_SIZE}`,
              [400, 404],
            );
            const page = payload?.result?.casts;
            if (!Array.isArray(page)) {
              throw new Error('the public server answered no cast page');
            }
            casts = page
              .map((cast) => {
                const mapped = feedCastFromPublicCast(cast);
                return mapped ? { ...mapped, who } : undefined;
              })
              .filter(Boolean);
          }
          return { author, casts, source };
        },
      );
    } catch (error) {
      if (error instanceof NoSuchFeed) {
        // The server answered, and the answer is: nobody by that name. That
        // is a miss, remembered like one — not a failure.
        return feedCache.readOrLoad(`feed:${fid}:${replies ? 1 : 0}`, async () => ({
          missing: true,
        }));
      }
      throw error;
    }
  };

  /**
   * One channel's feed, read from the node (`/v1/castsByParent`) under the
   * parent URL the network really carries the channel under — both spellings
   * of a bare key are tried, the one that answers casts wins. A node is the
   * only server that answers this read (Farcaster's public server keeps no
   * channel casts route), so a dead node is a failed read, and a channel that
   * returns no casts at all is `undefined`: no such feed, not an empty one —
   * we cannot tell a new channel from a missing one, and we refuse to guess.
   */
  const channelFeedRead = (key) =>
    feedCache.readOrLoad(`chfeed:${key}`, async () => {
      for (const parentUrl of channelParentUrls(key)) {
        const payload = await readJsonOrThrow(
          `${nodeBaseUrl.replace(/\/$/, '')}/v1/castsByParent?url=${encodeURIComponent(parentUrl)}&pageSize=${FEED_PAGE_SIZE}`,
        );
        if (!Array.isArray(payload?.messages)) {
          throw new Error('the node answered no channel page');
        }
        const casts = payload.messages
          .map((message) => feedCastFromNodeMessage(message))
          .filter(Boolean);
        if (casts.length) {
          const named = await Promise.all(
            casts.map(async (cast) => {
              const author =
                Number.isInteger(cast.fid) && cast.fid >= 0
                  ? await userData(cast.fid)
                  : undefined;
              return { ...cast, who: author ? creatorOf(author) : undefined };
            }),
          );
          return { casts: named, parentUrl, source: nodeLabel };
        }
      }
      return { missing: true };
    });

  return {
    /**
     * A cast page's facts: the cast itself, and who wrote it.
     *
     * The author is asked for FIRST, because without it the node cannot address
     * the cast at all — and a profile read that follows is the same read the
     * client's profile page makes.
     */
    async cast(hash) {
      if (!isFullCastHash(hash)) {
        return undefined;
      }
      const fid = await castAuthor(hash);
      if (fid === undefined) {
        return undefined;
      }
      const [cast, author] = await Promise.all([
        castByAuthor(fid, hash),
        userData(fid),
      ]);
      if (!cast) {
        return undefined;
      }
      return { cast, author: author ?? { fid } };
    },
    async profile(fid) {
      const [author, casts] = await Promise.all([
        userData(fid),
        latestCasts(fid),
      ]);
      // An empty user-data answer cannot prove a missing FID rather than an
      // unpublished or incomplete profile. The handler retains its shell
      // fallback for both that case and a failed read; neither becomes a 404.
      return author ? { author, casts } : undefined;
    },
    /**
     * The FID that wrote a cast, when the caller has only the hash.
     *
     * The cast-hash index (Neynar) answers this, and it is the one thing a
     * caller without a viewer needs — a node shards by FID. `undefined` when
     * there is no index configured or the index does not know the hash: never a
     * guess, so the caller refuses rather than reads the wrong shard.
     */
    async authorOf(hash) {
      return isFullCastHash(hash) ? castAuthor(hash) : undefined;
    },
    /**
     * One cast's own words, for a caller that already knows who wrote it.
     *
     * Used by the translator (`server/translate/`): the browser knows the
     * author of every cast on screen, and a translation that is only of the
     * real cast is what stops that endpoint from being a free model for
     * anybody's words. `undefined` when the node does not hold the cast.
     */
    async castText(fid, hash) {
      if (!Number.isSafeInteger(fid) || !isFullCastHash(hash)) {
        return undefined;
      }
      const cast = await castByAuthor(fid, hash);
      return cast?.text;
    },
    /**
     * An account's feed (`/~/profiles/<fid>/rss`), newest casts first.
     *
     * `undefined` is "no such feed" (a nameless FID); a thrown error is a read
     * that failed and may be retried. `{author, casts, source}` otherwise,
     * where `source` names the server that answered.
     */
    async feed(fid, options) {
      const result = await accountFeedRead(fid, options);
      return result?.missing ? undefined : result;
    },
    /**
     * A channel's feed (`/~/channel/<id>/rss`), under the channel's real
     * parent URL. Same refusal rules as `feed`.
     */
    async channelFeed(key) {
      const result = await channelFeedRead(key);
      return result?.missing ? undefined : result;
    },
    size: () => cache.size(),
    /** The feed reads' own cache, for the health route. */
    feedSize: () => feedCache.size(),
  };
};
