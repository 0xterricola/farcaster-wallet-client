/**
 * The window a signed-out visitor browses: real casts, read from the network.
 *
 * WHY IT IS ASSEMBLED THIS WAY
 *
 * A browser page cannot read Farcaster's own client API (it permits its own
 * origins only) and it holds no session for anything else, so a visitor with no
 * account has exactly one place to read from: a public Snapchain node, through
 * the same provider chain every other read in this client goes through.
 *
 * A node keeps protocol messages, not rankings. It has no "what is happening
 * now" endpoint, its channel index is not trustworthy on the public relay (a
 * `castsByParent` page for a channel comes back unordered and, asked for the
 * newest page, empty), and its ranked feeds are an indexer's job. Two reads DO
 * answer honestly with no account at all, and they are the two this window is
 * built from:
 *
 *   GET /v1/linksByFid?fid=&linkType=follow&reverse=true   who an account follows
 *   GET /v1/castsByFid?fid=&reverse=true                   that account's newest casts
 *
 * So the window is a follow-graph read with a public anchor instead of the
 * viewer's: the newest casts from the accounts that a handful of named, public
 * Farcaster accounts follow, merged on the protocol timestamp. That is the same
 * shape as the signed-in home feed (`reads.ts`, `followingFeedMessages`), which
 * is the point: the browse surface is the client's own reader, pointed at a
 * public anchor, and nothing about it is invented. Every cast carries its real
 * author and its real timestamp.
 *
 * The anchors are HANDLES, not FIDs, and they are resolved at read time through
 * the node's own name resolution (`userNameProofByName`). A handle is a name
 * the protocol resolves to whoever holds it today, so this list cannot go stale
 * by pointing at a FID that has changed hands.
 *
 * WHAT THIS IS NOT
 *
 * It is not "trending on Farcaster". Ranking the whole network needs an indexer
 * this client does not have. `trending` here ranks THIS window by the likes and
 * recasts the node really holds for those casts, and the surface says so.
 */

import { type ApiCast } from 'farcaster-client-data';
import { type NodeMessage } from 'farcaster-node-client';

/** How the browse surface shapes the window. */
export type PublicFeedKind = 'recent' | 'trending';

/**
 * The feed key the browse surfaces ask with.
 *
 * The page talks to the client's own data layer (`useFeedItems`), which posts
 * to `/v2/feed-items`; the node adapter answers this key from the public window
 * instead of the follow graph (`nodeBackedFetch.ts`). One seam, one hook, one
 * set of loading and paging rules.
 */
export const PUBLIC_FEED_KEY = 'public';

/** A feed type that asks for one topic of the window: `topic:basefriend`. */
export const PUBLIC_FEED_TOPIC_PREFIX = 'topic:';

/**
 * The accounts the window is anchored on, by name.
 *
 * Long-standing public Farcaster accounts that post often, so the accounts they
 * follow are a live slice of the network rather than a museum. They are read as
 * a UNION: nothing here is a feed of one person's taste.
 *
 * This list is the one product decision in this file, and it is deliberately
 * small and visible. Replacing it with the app's own index (a real ranking
 * service behind `/api/fiddy/*`) is the follow-up; until that exists, an
 * anchored follow-graph read is the honest way to show a visitor what Farcaster
 * is saying right now.
 */
export const PUBLIC_WINDOW_ANCHORS: readonly string[] = [
  'dwr',
  'farcaster',
  'jacek',
  'linda',
  'samantha',
];

/** How many of an anchor's newest follows are read. */
export const AUTHORS_PER_ANCHOR = 8;

/**
 * The most authors a window is assembled from, across every anchor.
 *
 * Bounds the fan-out: the window costs one read per author, and this is what
 * keeps a signed-out page's first paint around a second on the public relay.
 */
export const MAX_WINDOW_AUTHORS = 32;

/** How many of an author's newest casts join the window. */
export const CASTS_PER_AUTHOR = 8;

/** Casts per author when an older slice is asked for ("show more"). */
export const CASTS_PER_AUTHOR_PAGED = 20;

/** How many casts the window returns. */
export const PUBLIC_WINDOW_LIMIT = 30;

/**
 * How many casts the engagement ranking looks at before it takes its page.
 *
 * Ranking needs the counts of everything it might show, so `trending` builds
 * twice the page and then takes the top. Two count reads per cast is the
 * expensive part of any page here, which is why this is bounded and not "the
 * whole window".
 */
export const TRENDING_CANDIDATES = PUBLIC_WINDOW_LIMIT * 2;

/** The topics the surface offers: a channel key, and how many casts it has. */
export interface PublicWindowTopic {
  key: string;
  count: number;
}

/** A request for one window, as the surface asks for it. */
export interface PublicWindowRequest {
  kind: PublicFeedKind;
  topic: string | null;
  limit: number;
  olderThan?: number;
}

/**
 * The channel a cast was posted to, from its parent URL, or null.
 *
 * A cast to a channel carries that channel's URL as its parent; a cast to a
 * person (a reply) carries the cast it answers instead, and a cast to nothing
 * in particular carries no parent at all. Only the channel form is a topic.
 */
export const channelKeyFromParentUrl = (
  parentUrl: string | null | undefined,
): string | null => {
  if (typeof parentUrl !== 'string' || parentUrl.length === 0) {
    return null;
  }
  const match = /\/~\/channel\/([^/?#]+)/.exec(parentUrl);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
};

/**
 * The feed type that asks for a window.
 *
 * `recent`, `trending`, or `topic:<key>` — one string, because the feed layer
 * takes one string and the node adapter has to be able to tell them apart.
 */
export const feedTypeForWindow = ({
  kind,
  topic,
}: {
  kind: PublicFeedKind;
  topic?: string | null;
}): string => (topic ? `${PUBLIC_FEED_TOPIC_PREFIX}${topic}` : kind);

/** The window a feed type asks for. An unknown type is the recent window. */
export const windowFromFeedType = (
  feedType: string | undefined,
): PublicWindowRequest => {
  const raw = typeof feedType === 'string' ? feedType.trim() : '';
  if (raw.startsWith(PUBLIC_FEED_TOPIC_PREFIX)) {
    const topic = raw.slice(PUBLIC_FEED_TOPIC_PREFIX.length);
    // A topic window is a recent one, narrowed: "what this channel is saying".
    return { kind: 'recent', topic: topic.length > 0 ? topic : null, limit: 0 };
  }
  if (raw === 'trending') {
    return { kind: 'trending', topic: null, limit: 0 };
  }
  return { kind: 'recent', topic: null, limit: 0 };
};

/** Is this the browse surface's feed key? */
export const isPublicFeedKey = (feedKey: string | undefined): boolean =>
  feedKey === PUBLIC_FEED_KEY;

/**
 * Newest first, no duplicates, and nothing newer than `olderThan`.
 *
 * A node's `castsByFid` page is per account, so the same cast can arrive twice
 * only if two authors somehow share a hash; the key is author and hash anyway,
 * because that is what addresses a cast on this network.
 */
export const mergeWindowMessages = ({
  messages,
  olderThan,
}: {
  messages: NodeMessage[];
  olderThan?: number;
}): NodeMessage[] => {
  const byAuthorAndHash = new Map<string, NodeMessage>();
  for (const message of messages) {
    if (!message.castAdd) {
      continue;
    }
    if (olderThan !== undefined && message.timestampMs >= olderThan) {
      continue;
    }
    byAuthorAndHash.set(`${message.fid}:${message.hash}`, message);
  }
  return [...byAuthorAndHash.values()].sort(
    (a, b) => b.timestampMs - a.timestampMs,
  );
};

/** A cast's engagement as this network really counts it: likes + recasts. */
export const engagementOfCast = (cast: ApiCast): number =>
  (cast.reactions?.count ?? 0) + (cast.recasts?.count ?? 0);

/**
 * The window ranked by engagement, newest winning a tie.
 *
 * A cast whose counts were never read is not ranked as if it had none
 * (`ApiCast.reactions` is absent when the count was not read), so it sorts
 * below everything that was measured rather than being buried at zero.
 */
export const rankWindowByEngagement = (casts: ApiCast[]): ApiCast[] => {
  const measured = (cast: ApiCast): number =>
    typeof cast.reactions?.count === 'number' ||
    typeof cast.recasts?.count === 'number'
      ? engagementOfCast(cast)
      : -1;

  return [...casts].sort((a, b) => {
    const difference = measured(b) - measured(a);
    return difference !== 0 ? difference : b.timestamp - a.timestamp;
  });
};

/**
 * The topics a window holds, most-used first.
 *
 * What a visitor can filter by is what the window really contains, rather than
 * a directory this client would have to invent (a node keeps no channel list,
 * and the hosted channel directory is unreadable from a page).
 */
export const topicsFromCasts = (casts: ApiCast[]): PublicWindowTopic[] => {
  const counts = new Map<string, number>();
  for (const cast of casts) {
    const key = channelKeyFromParentUrl(cast.parentUrl);
    if (key !== null) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) =>
      b.count !== a.count ? b.count - a.count : a.key.localeCompare(b.key),
    );
};

/** Narrow a window to one topic (its channel key). */
export const castsInTopic = (
  casts: ApiCast[],
  topic: string | null,
): ApiCast[] =>
  topic === null
    ? casts
    : casts.filter((cast) => channelKeyFromParentUrl(cast.parentUrl) === topic);
