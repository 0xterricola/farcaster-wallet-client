/**
 * What a cast and a profile ARE, read the way the client reads them.
 *
 * Two sources, each used only for what it can answer:
 *
 *   * the Snapchain node — `/v1/castById?fid=&hash=` and `/v1/userDataByFid`,
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
};

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
 * The readers, with one cache each and an injectable fetch (so a test answers
 * without a network, the same rule every other reader in this repo follows).
 */
export const createLinkReader = ({
  fetchImpl,
  nodeBaseUrl,
  neynarApiKey,
  neynarBaseUrl = 'https://api.neynar.com',
  timeoutMs = 8000,
  now = () => Date.now(),
  caches = CACHE,
}) => {
  const cache = createCache({ ttlMs: caches.castMs, now });
  const get = (path) =>
    fetchImpl(`${nodeBaseUrl.replace(/\/$/, '')}${path}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });

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
      const author = await userData(fid);
      return author ? { author } : undefined;
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
    size: () => cache.size(),
  };
};
