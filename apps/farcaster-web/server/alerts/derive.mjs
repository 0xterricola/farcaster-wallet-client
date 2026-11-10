/**
 * What happened to one reader, derived from PROTOCOL READS ONLY.
 *
 * This is the same derivation the client already makes in
 * `src/snapchain/nodeApi/reads.ts` `readNotifications()` — the four kinds a
 * read node can actually answer:
 *
 *   * **mentions**  `/v1/castsByMention?fid=`        (someone @-named you)
 *   * **replies**   `/v1/castsByParent?hash=` on each of your recent casts
 *   * **likes**     `/v1/reactionsByCast?target_…&reaction_type=Like`
 *   * **follows**   `/v1/linksByTargetFid?link_type=follow`
 *
 * AND NOTHING ELSE. Recasts and quotes are not derived here because the read
 * does not derive them: upstream quilcast's server polls a hosted notifications
 * endpoint that knows about both, and copying that copy would make this client
 * claim activity it cannot see. A push that says "recasted" when nothing was
 * read is worse than no push.
 *
 * THE CEILING, said plainly: one consultation per reader is at most
 * `1 + 1 + OWN_CAST_LIMIT + OWN_CAST_LIMIT + 1` = 32 node reads — your latest
 * casts, your mentions, replies to each of your last ten casts, likes on each
 * of the same ten, and your follows. The loop asks a reader no more than once a
 * minute (`service.mjs`), so 32 reads/minute/reader is the hard ceiling, and a
 * name is read at most once per NAME_TTL because a person's name does not
 * change between two ticks.
 */

/** How far back "your own casts" goes for reply and like reads. Upstream: 10. */
export const OWN_CAST_LIMIT = 10;

/** One page per read. A reader with more than this in a minute is a burst. */
export const PAGE_SIZE = 25;

/** How long a display name is trusted. */
export const NAME_TTL_MS = 30 * 60 * 1000;

/** The protocol's clock: message timestamps are seconds from this epoch. */
const FARCASTER_EPOCH_MS = 1609459200000;

const asObject = (value) =>
  value && typeof value === 'object' ? value : {};

/**
 * A node read, with the deadline every other read on this host has.
 *
 * An unavailable or malformed answer is `undefined` — never an invented
 * activity. The loop reports the miss and tries again next minute.
 */
export const createNodeGet = ({
  nodeBaseUrl,
  fetchImpl = fetch,
  timeoutMs = 8000,
}) => {
  const base = String(nodeBaseUrl ?? '').replace(/\/+$/, '');
  return async (path, query = {}) => {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        return undefined;
      }
      return await response.json();
    } catch {
      return undefined;
    } finally {
      clearTimeout(deadline);
    }
  };
};

/** The page's messages, or an empty list — a read that failed is not a burst. */
const messagesOf = (page) => (Array.isArray(asObject(page).messages) ? page.messages : []);

/** A cast add out of a node message, with just what a push needs. */
const castAddOf = (message) => {
  const json = asObject(message);
  const data = asObject(json.data);
  const body = data.castAddBody;
  if (!body || typeof body !== 'object') {
    return undefined;
  }
  const timestamp = Number(data.timestamp);
  return {
    fid: Number(data.fid),
    hash: String(json.hash ?? ''),
    text: typeof body.text === 'string' ? body.text : '',
    parentHash:
      asObject(body.parentCastId).hash === undefined
        ? undefined
        : String(body.parentCastId.hash),
    at: Number.isFinite(timestamp) ? FARCASTER_EPOCH_MS + timestamp * 1000 : 0,
  };
};

/** A like out of a node message. */
const reactionOf = (message) => {
  const json = asObject(message);
  const data = asObject(json.data);
  const body = asObject(data.reactionBody);
  if (String(body.type ?? '') !== 'Like') {
    return undefined;
  }
  const timestamp = Number(data.timestamp);
  return {
    fid: Number(data.fid),
    actor: Number(data.fid),
    hash: String(asObject(body.targetCastId).hash ?? ''),
    at: Number.isFinite(timestamp) ? FARCASTER_EPOCH_MS + timestamp * 1000 : 0,
  };
};

/** A follow out of a node message. */
const followOf = (message) => {
  const json = asObject(message);
  const data = asObject(json.data);
  const body = asObject(data.linkBody);
  if (String(body.type ?? '') !== 'follow') {
    return undefined;
  }
  const timestamp = Number(data.timestamp);
  return {
    fid: Number(data.fid),
    at: Number.isFinite(timestamp) ? FARCASTER_EPOCH_MS + timestamp * 1000 : 0,
  };
};

/**
 * A profile's display name, from the node's own user data, cached.
 *
 * `/v1/userDataByFid` answers a page of `userDataBody` records; the display name
 * is `type: 'USER_DATA_TYPE_DISPLAY'` and the handle `USER_DATA_TYPE_USERNAME`.
 * A FID with neither is still a person: the copy says "Someone" rather than
 * showing a number.
 */
export const createNameReader = ({ nodeGet, now = () => Date.now(), ttlMs = NAME_TTL_MS }) => {
  const cache = new Map();
  return async (fid) => {
    if (!Number.isSafeInteger(fid) || fid <= 0) {
      return undefined;
    }
    const hit = cache.get(fid);
    if (hit && now() - hit.at < ttlMs) {
      return hit.name;
    }
    const page = await nodeGet('/v1/userDataByFid', { fid, pageSize: 50 });
    let display;
    let username;
    for (const message of messagesOf(page)) {
      const body = asObject(asObject(asObject(message).data).userDataBody);
      if (String(body.type ?? '') === 'USER_DATA_TYPE_DISPLAY' && !display) {
        display = String(body.value ?? '').trim();
      }
      if (String(body.type ?? '') === 'USER_DATA_TYPE_USERNAME' && !username) {
        username = String(body.value ?? '').trim();
      }
    }
    const name = display || username || undefined;
    if (cache.size >= 2000) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(fid, { at: now(), name });
    return name;
  };
};

/**
 * The derivation, for one FID.
 *
 * Every read is best-effort: a node that cannot answer one of the five reads
 * still yields the other four, because a silent feature is worse than a partial
 * one. What is never done is GUESSING: an item is only emitted when a message
 * was actually in the answer.
 */
export const createActivityReader = ({
  nodeGet,
  nameOf = async () => undefined,
  ownCastLimit = OWN_CAST_LIMIT,
  pageSize = PAGE_SIZE,
  now = () => Date.now(),
}) => {
  const withName = async (fid) => ({
    fid,
    name: await nameOf(fid),
  });

  return {
    async activity(fid) {
      if (!Number.isSafeInteger(fid) || fid <= 0) {
        return [];
      }

      const ownPage = await nodeGet('/v1/castsByFid', {
        fid,
        pageSize: ownCastLimit,
        reverse: true,
      });
      const ownCasts = messagesOf(ownPage)
        .map(castAddOf)
        .filter((cast) => cast && cast.fid === fid)
        .slice(0, ownCastLimit);
      const ownHashes = ownCasts.map((cast) => cast.hash).filter(Boolean);

      // The four reads all go out together: one slow node read must not make
      // four ticks of latency for a burst that already happened.
      const [mentionPage, followPage, replyPages, likePages] = await Promise.all([
        nodeGet('/v1/castsByMention', { fid, pageSize, reverse: true }),
        nodeGet('/v1/linksByTargetFid', {
          target_fid: fid,
          link_type: 'follow',
          pageSize,
          reverse: true,
        }),
        Promise.all(
          ownHashes.map((hash) =>
            nodeGet('/v1/castsByParent', { fid, hash, pageSize, reverse: true }),
          ),
        ),
        Promise.all(
          ownHashes.map((hash) =>
            nodeGet('/v1/reactionsByCast', {
              target_fid: fid,
              target_hash: hash,
              reaction_type: 'Like',
              pageSize,
              reverse: true,
            }),
          ),
        ),
      ]);

      /** @type {Array<any>} */
      const items = [];

      for (const message of messagesOf(mentionPage)) {
        const cast = castAddOf(message);
        if (!cast || cast.fid === fid || !cast.hash) {
          continue;
        }
        items.push({
          id: `cast:${cast.hash}`,
          kind: 'mention',
          at: cast.at,
          actor: await withName(cast.fid),
          castHash: cast.hash,
          castText: cast.text,
        });
      }

      for (const page of replyPages) {
        for (const message of messagesOf(page)) {
          const cast = castAddOf(message);
          // A reply to your own cast by yourself is not a notification.
          if (!cast || cast.fid === fid || !cast.hash) {
            continue;
          }
          items.push({
            id: `cast:${cast.hash}`,
            kind: 'reply',
            at: cast.at,
            actor: await withName(cast.fid),
            castHash: cast.hash,
            castText: cast.text,
          });
        }
      }

      for (const message of messagesOf(followPage)) {
        const follow = followOf(message);
        if (!follow || follow.fid === fid || !Number.isSafeInteger(follow.fid)) {
          continue;
        }
        items.push({
          id: `follow:${follow.fid}`,
          kind: 'follow',
          at: follow.at,
          actor: await withName(follow.fid),
        });
      }

      // Likes are keyed by the cast they are on, so a burst on one cast groups
      // into one line and two casts stay two lines.
      for (let index = 0; index < likePages.length; index += 1) {
        const hash = ownHashes[index];
        for (const message of messagesOf(likePages[index])) {
          const reaction = reactionOf(message);
          if (!reaction || reaction.actor === fid || !Number.isSafeInteger(reaction.actor)) {
            continue;
          }
          items.push({
            id: `reaction:${hash}:${reaction.actor}`,
            kind: 'like',
            at: reaction.at,
            actor: await withName(reaction.actor),
            castHash: hash,
          });
        }
      }

      // A mention and a reply can be the same cast (a reply that @-names you).
      // One cast is one notification; the reply wins because it is the truer
      // description of what happened.
      const byId = new Map();
      for (const item of items) {
        const seen = byId.get(item.id);
        if (!seen || (seen.kind === 'mention' && item.kind === 'reply')) {
          byId.set(item.id, item);
        }
      }
      return [...byId.values()];
    },

    /** The reader's own recent casts, for the panel's "what we watch" line. */
    async ownCasts(fid) {
      const page = await nodeGet('/v1/castsByFid', {
        fid,
        pageSize: ownCastLimit,
        reverse: true,
      });
      return messagesOf(page)
        .map(castAddOf)
        .filter(Boolean)
        .slice(0, ownCastLimit);
    },

    now,
  };
};