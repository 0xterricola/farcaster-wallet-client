/**
 * Feeds built from your own node's reads.
 *
 * A read node has no "home feed" endpoint — that is an indexer's job, and not
 * having one is the price of not asking anyone's permission. What the node does
 * have is everything needed to build one locally:
 *
 *   1. `GET /v1/linksByFid?fid=<you>&link_type=follow` — who you follow;
 *   2. `GET /v1/castsByFid?fid=<them>` — their casts, newest first;
 *   3. merge on the Farcaster timestamp, de-duplicate, cap.
 *
 * Both reads are paged with `nextPageToken`, and the fan-out is bounded so a
 * few hundred follows do not become a few hundred sockets at once.
 */

import type { SnapchainNodeClient } from './http';
import type { NodeMessage } from './types';
import { isTerminalPageToken } from './wire';

export interface FetchFollowingOptions {
  node: SnapchainNodeClient;
  fid: number;
  /** Stop after this many follows. */
  limit?: number;
  pageSize?: number;
  /** Protocol link type; `follow` is the follow graph. */
  linkType?: string;
}

/** The FIDs this account follows, read straight from its own node. */
export const fetchFollowing = async ({
  node,
  fid,
  limit = 500,
  pageSize = 100,
  linkType = 'follow',
}: FetchFollowingOptions): Promise<number[]> => {
  const following = new Set<number>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  do {
    // The node pages ascending unless asked otherwise (measured against a live
    // read node: `castsByFid` without `reverse` returns the *oldest* page). The
    // follow graph is capped, so take the most recent follows rather than the
    // first ones ever recorded.
    const page = await node.linksByFid({ fid, linkType, pageSize, pageToken, reverse: true });
    for (const message of page.messages) {
      const targetFid = message.link?.targetFid;
      if (typeof targetFid === 'number') {
        following.add(targetFid);
      }
    }
    pageToken = page.nextPageToken;
    // `isTerminalPageToken` is load-bearing, not tidiness: a live node answers
    // the terminal token `[null,null]` with the FIRST page again, so a loop
    // that only checks "is there a token" never ends.
    //
    // The token memory below is the second guard, for the other way a node can
    // stop making progress: it hands back the SAME cursor twice (a page whose
    // next request repeats it). Without this, a wedged node turns the follow
    // graph into an unbounded loop in the browser tab.
    if (pageToken !== undefined && seenTokens.has(pageToken)) {
      break;
    }
    if (pageToken !== undefined) {
      seenTokens.add(pageToken);
    }
  } while (pageToken && !isTerminalPageToken(pageToken) && following.size < limit);

  return [...following].slice(0, limit);
};

export interface FetchCastsOptions {
  node: SnapchainNodeClient;
  fid: number;
  limit?: number;
  pageSize?: number;
}

/** One FID's own casts, newest first. */
export const fetchCastsByFid = async ({
  node,
  fid,
  limit = 25,
  pageSize,
}: FetchCastsOptions): Promise<NodeMessage[]> => {
  const page = await node.castsByFid({
    fid,
    pageSize: pageSize ?? Math.max(limit, 25),
    // Without this the node serves the *oldest* page first, so a client that
    // sorted client-side would show a years-old "newest first" feed. Measured
    // against a live read node, not assumed.
    reverse: true,
  });
  return page.messages
    .filter((message) => message.castAdd)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
};

/** Run `worker` over `items` with a bounded number in flight. */
export const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.max(1, Math.min(concurrency, items.length)))
    .fill(undefined)
    .map(async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]);
      }
    });
  await Promise.all(runners);
  return results;
};

export interface FollowingFeedOptions {
  node: SnapchainNodeClient;
  fid: number;
  /** Total casts to return. */
  limit?: number;
  /** How many follows to read. */
  followingLimit?: number;
  /** Casts fetched per followed account. */
  castsPerAccount?: number;
  /** Parallel `castsByFid` reads. */
  concurrency?: number;
  /** Include your own casts in the feed. */
  includeSelf?: boolean;
  /** Called after the follow graph is read, for progress UI. */
  onFollowing?: (following: number[]) => void;
}

/**
 * A home feed assembled on the client from your node: follow graph, their
 * casts, merged by timestamp. No third-party indexer, no API key.
 */
export const fetchFollowingFeed = async ({
  node,
  fid,
  limit = 50,
  followingLimit = 150,
  castsPerAccount = 10,
  concurrency = 6,
  includeSelf = true,
  onFollowing,
}: FollowingFeedOptions): Promise<NodeMessage[]> => {
  const following = await fetchFollowing({ node, fid, limit: followingLimit });
  onFollowing?.(following);

  const fids = includeSelf ? [fid, ...following] : following;
  const perAccount = await mapWithConcurrency(
    fids,
    concurrency,
    async (authorFid) => {
      try {
        return await fetchCastsByFid({
          node,
          fid: authorFid,
          limit: castsPerAccount,
        });
      } catch {
        // One unreachable author must not blank the feed.
        return [] as NodeMessage[];
      }
    },
  );

  const byHash = new Map<string, NodeMessage>();
  for (const cast of perAccount.flat()) {
    byHash.set(`${cast.fid}:${cast.hash}`, cast);
  }

  return [...byHash.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
};

export interface ThreadOptions {
  node: SnapchainNodeClient;
  /** The addressing pair: parent author + cast hash, or a channel URL. */
  parentCastId?: { fid: number; hash: string };
  parentUrl?: string;
  limit?: number;
}

/** Replies to a cast (or casts in a channel) straight from the node. */
export const fetchReplies = async ({
  node,
  parentCastId,
  parentUrl,
  limit = 50,
}: ThreadOptions): Promise<NodeMessage[]> => {
  const page = await node.castsByParent({
    ...(parentCastId ? { fid: parentCastId.fid, hash: parentCastId.hash } : {}),
    ...(parentUrl ? { url: parentUrl } : {}),
    pageSize: limit,
  });
  return page.messages
    .filter((message) => message.castAdd)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, limit);
};
