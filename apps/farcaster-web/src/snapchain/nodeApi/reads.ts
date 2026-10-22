/**
 * The node-backed readers: the hosted API's answers, read from your own node.
 *
 * Every method here answers a request the fork's data layer would have sent to
 * `farcaster.xyz`, using only what a Snapchain read node serves: `/v1/castsByFid`,
 * `/v1/castsByParent`, `/v1/castById`, `/v1/userDataByFid`, `/v1/linksByFid`,
 * `/v1/linksByTargetFid`, `/v1/reactionsByCast`, `/v1/castsByMention`,
 * `/v1/userNameProofByName`, `/v1/verificationsByFid`.
 *
 * MEASURED THINGS THIS FILE DEPENDS ON (probed against a live read node, not
 * assumed — see docs/CLIENT-PARITY.md for the raw evidence):
 *
 *   - `pageSize` is a *minimum*. Asking for 3 returns 6; asking for 1000
 *     returns 2000. So a paged count stops when a page comes back empty, not
 *     when it came back shorter than asked.
 *   - A page token of `[null,null]` (base64 `W251bGwsbnVsbF0=`) means the end
 *     of the results, and it is repeated on an empty page rather than omitted.
 *   - `castsByFid` without `reverse` serves the *oldest* page first.
 *
 * WHAT IS NOT HERE
 *
 * A read node shards by FID, so a cast can only be addressed by (author, hash)
 * — there is no hash-only lookup. Cast detail pages carry a hash only, so the
 * reader remembers the author of every cast it has served (`castFidMemo`) and
 * says so plainly when a hash has never been seen. That is a structural
 * property of the node's API, not a bug being hidden.
 */

import {
  ApiBlockedUser,
  ApiCast,
  ApiCastReaction,
  ApiFeedItemsResult,
  ApiGetUnseen200Response,
  ApiNotificationCastMention,
  ApiNotificationCastReaction,
  ApiNotificationCastReply,
  ApiNotificationFollow,
  ApiNotificationGroup,
  ApiStorageUtilization,
  ApiThreadResult,
  ApiUser,
  ApiVerification,
} from 'farcaster-client-data';
import {
  fetchFollowing,
  isMissingOnNode,
  isTerminalPageToken,
  mapWithConcurrency,
  type NodeCastAddBody,
  type NodeMessage,
  type NodeMessagesPage,
  SnapchainNodeClient,
} from 'farcaster-node-client';

import { fetchCastAuthorFromOrigin } from '~/snapchain/providers/castAuthorHandoff';

import {
  createEmbedCardResolver,
  type EmbedCard,
  type EmbedCardResolver,
} from './embedCards';
import {
  createEmbedKindResolver,
  type EmbedKindAnswer,
  type EmbedKindResolver,
} from './embedKinds';
import {
  apiCastFeedItemFromNode,
  apiCastFromNode,
  apiUserFromNode,
  castEmbedsFromNode,
  exactCount,
  floorCount,
  NodeCount,
  userMinimalFrom,
} from './fromNode';

/** Raised when the node genuinely cannot answer a request the app made. */
export class NodeCannotAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeCannotAnswerError';
  }
}

const DEFAULT_COUNT_CAP = 6000;
const COUNT_PAGE_SIZE = 1000;
/**
 * How many reads this reader keeps in flight at once.
 *
 * MEASURED (2026-10-22, the live client against a public read node, 10-core
 * laptop under load ~9): a home feed's first page is ~62 per-author reads and
 * they answer in p50 ~250ms / p95 ~1s, so the fan-out is where the first cast's
 * wall clock goes — and 12 at a time turns 62 reads into six waves of waiting
 * for no reason. 24 halves the waves; the fan-out stays bounded, and the node
 * is asked no more often than before.
 */
const RESOLVE_CONCURRENCY = 24;
/** Walk at most this far up a thread looking for its root. */
const MAX_ANCESTOR_HOPS = 20;
/**
 * How far a hash-prefix lookup walks one account's casts before it gives up.
 *
 * A node can only be asked for a cast by its author, so a page that carries a
 * hash prefix (a cast permalink) has to be resolved by walking that account's
 * casts. Four pages of 100 is deep enough for the prefix of a cast that was
 * posted in the last few months, and bounded on purpose: a prefix that is not
 * there must cost a page walk, not an unbounded crawl.
 */
const PREFIX_SEARCH_PAGES = 4;
const PREFIX_SEARCH_PAGE_SIZE = 100;

/**
 * hash → the FID that authored it: the index that makes a hash-only page
 * answerable at all.
 *
 * A Snapchain node shards by FID, so `castById` needs the author as well as the
 * hash, while the fork's client asks for threads and reactions by hash alone.
 * Every cast this client has served is therefore remembered here by the reader
 * that served it — see `readThread`.
 *
 * ONE index for the whole client, not one per reader, and that is load-bearing
 * now that writes exist: a cast is normally READ through the node that serves
 * the feed and WRITTEN through whichever server answers that account's writes
 * (they can be different servers — a Neynar key answers profiles and writes
 * while the feed comes from a node). The author of a cast is a fact about the
 * network, not about which server told us, so a like must not fail because the
 * server that will carry it never served the page it was pressed on.
 */
const castFidIndex = new Map<string, number>();

/** Remember who wrote a cast, so a hash-only request can be resolved later. */
export const rememberCastAuthor = (hash: string, fid: number): void => {
  if (hash.length > 0) {
    castFidIndex.set(hash, fid);
  }
};

/** The author of a cast this client has seen, or undefined when never seen. */
export const castAuthorOf = (hash: string): number | undefined =>
  castFidIndex.get(hash);

/** Forget the shared index (sign-out, and tests). */
export const forgetCastAuthors = (): void => {
  castFidIndex.clear();
};
const USER_DATA_PAGE_SIZE = 100;
const SEEN_STORAGE_PREFIX = 'fiddy:node-seen';

/** `[null,null]` — measured as "there is nothing after this page". Shared with
 * the node client so the browser and the library stop for the same reason. */

const fcTimestampToMs = (timestamp: number): number =>
  timestamp * 1000 + 1609459200000;

/**
 * The embed URLs a cast body carries, in the order it carries them.
 *
 * Only `url` embeds: a quote addresses another cast and is resolved by hash,
 * not by fetching anything here.
 */
const embedUrlsOf = (body: NodeCastAddBody | undefined): string[] => {
  if (!body?.embeds) {
    return [];
  }
  const urls: string[] = [];
  for (const embed of body.embeds) {
    if ('url' in embed && typeof embed.url === 'string' && embed.url !== '') {
      urls.push(embed.url);
    }
  }
  return urls;
};

const seenStore = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export interface NodeBackedReadsOptions {
  node: SnapchainNodeClient;
  /** Where the node answers, for the one route the typed client does not cover. */
  nodeBaseUrl: string;
  /** Requests to the node. Same seam the client uses, so tests can fake it. */
  fetchImpl: typeof fetch;
  /** The signed-in account, or undefined when this device has no identity yet. */
  getSignedInFid: () => number | undefined;
  /** Above this, a paged count is reported as a floor. */
  countCap?: number;
  /**
   * What each embed URL's media type is (image / video / link), so a photo is
   * rendered as a photo rather than as a link card. Defaults to the real thing:
   * one bounded, cached probe per URL (`embedKinds.ts`). Injectable so a test
   * can answer without a network.
   */
  embedKinds?: EmbedKindResolver;
  /**
   * What each link embed's own page says about itself — its title, its picture,
   * and the mini-app card whose button launches it (`embedCards.ts`). Defaults
   * to the real thing: one bounded, cached read of the URL. Injectable so a
   * test can answer without a network.
   */
  embedCards?: EmbedCardResolver;
  /**
   * Which account wrote a cast, when this reader has never served it — the
   * shared-link case (`castAuthorHandoff.ts`). Defaults to the real thing: one
   * same-origin read of this host's own author index. Injectable so a test can
   * answer without a server, and so a build with no such service can be wired
   * to answer `undefined` rather than reaching for one.
   */
  resolveCastAuthor?: (hash: string) => Promise<number | undefined>;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

const USER_CACHE_MS = 60_000;
const COUNT_CACHE_MS = 60_000;
/**
 * How long the viewer's own reaction logs are reused.
 *
 * MEASURED (2026-10-22, the live client, box load ~5): `/v1/reactionsByFid` at
 * `pageSize: 1000` answers with 2000 messages and took 1.4–5.5s, and it was
 * asked TWICE per feed read and twice again per thread — every read of a page
 * paid for the viewer's whole like and recast history to answer one question
 * per cast ("did I like this one?"). The answer to that question is stable on
 * the order of a page read, so it is read once and reused.
 */
const VIEWER_REACTION_CACHE_MS = 60_000;

/**
 * A channel's parent URL from its key.
 *
 * MEASURED: a consolidated channel is addressed on chain by
 * `https://farcaster.xyz/~/channel/<key>` and the node serves its casts by
 * that URL (`/v1/castsByParent?url=…`, verified against a live node). A channel
 * owned by an NFT is addressed `chain://eip155:7777777/erc721:0x…` and its
 * short key lives only in Warpcast's directory — the node cannot turn one into
 * the other, which is why that case is an honest error, not an empty feed.
 *
 * A module function as well as a reader method because a *write* needs it too:
 * a channel cast is a cast to this URL, so the writer must speak it without
 * owning a reader (a Neynar-themed client writes through a different server
 * than the one that served the channel page).
 */
export const channelParentUrlFor = (key: string): string => {
  if (/^(https?:\/\/|chain:\/\/)/.test(key)) {
    return key;
  }
  return `https://farcaster.xyz/~/channel/${key}`;
};

/**
 * The spelling a set of cast hashes holds `hash` under, if it holds it at all.
 *
 * The node serves hashes as lowercase hex, and a hash this session wrote comes
 * from the message that very node served, so the two match exactly in practice.
 * This is belt and braces for the comparisons below: a reaction the viewer just
 * pressed must never be missed, or drawn twice, over a difference in casing.
 */
const heldHash = (hashes: Set<string>, hash: string): string | undefined => {
  if (hashes.has(hash)) {
    return hash;
  }
  const wanted = hash.toLowerCase();
  for (const held of hashes) {
    if (held.toLowerCase() === wanted) {
      return held;
    }
  }
  return undefined;
};

/**
 * The snaps channel, as the network actually carries it.
 *
 * MEASURED (2026-10-22, a live public read node):
 *
 *   GET /v1/castsByParent?url=https://warpcast.com/~/channel/snaps → casts
 *   GET /v1/castsByParent?url=https://farcaster.xyz/~/channel/snaps → none
 *
 * A snap is an ordinary cast whose parent URL is this channel, so an account's
 * snaps are its own casts with this parent — the same `castsByFid` page every
 * other cast list on a profile comes from, filtered. `channelParentUrlFor`
 * would spell the same channel the farcaster.xyz way, which answers empty, so
 * the spelling is written down here rather than derived.
 */
export const SNAPS_CHANNEL_PARENT_URL = 'https://warpcast.com/~/channel/snaps';

/**
 * Reads the hosted API's answers out of a Snapchain node, with the caches a
 * browser client needs (one page of feed asks for ~25 authors).
 */
export class NodeBackedReads {
  private readonly node: SnapchainNodeClient;
  private readonly nodeBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly getSignedInFid: () => number | undefined;
  private readonly countCap: number;
  private readonly embedKinds: EmbedKindResolver;
  private readonly embedCards: EmbedCardResolver;

  /** The author index for a hash this reader has never served. */
  private readonly resolveCastAuthor: (
    hash: string,
  ) => Promise<number | undefined>;

  private readonly userCache = new Map<number, CacheEntry<ApiUser>>();
  private readonly userPromiseCache = new Map<number, Promise<ApiUser>>();
  /**
   * The cast-shaped account cache. Separate from `userCache` on purpose: the two
   * hold different answers (see `readAuthor`), and a cast-shaped read must never
   * satisfy a profile-shaped one.
   */
  private readonly authorCache = new Map<number, CacheEntry<ApiUser>>();
  private readonly authorPromiseCache = new Map<number, Promise<ApiUser>>();
  private readonly countCache = new Map<string, CacheEntry<NodeCount>>();
  private readonly castCache = new Map<string, CacheEntry<NodeMessage>>();
  /** The viewer's own like/recast hashes, one entry per reaction type. */
  private readonly viewerReactionCache = new Map<
    'Like' | 'Recast',
    CacheEntry<Set<string>>
  >();
  private readonly viewerReactionPromiseCache = new Map<
    'Like' | 'Recast',
    Promise<Set<string>>
  >();
  /**
   * The reactions written through this client since it was built — see
   * `noteViewerReaction`, which the write half of the seam calls. Applied ON TOP
   * of `viewerReactionCache`, never instead of it, so the minute of reuse still
   * pays for itself.
   */
  private readonly writtenReactions = new Map<
    'Like' | 'Recast',
    Map<string, boolean>
  >();

  constructor({
    node,
    nodeBaseUrl,
    fetchImpl,
    getSignedInFid,
    countCap = DEFAULT_COUNT_CAP,
    embedKinds = createEmbedKindResolver(),
    embedCards,
    resolveCastAuthor,
  }: NodeBackedReadsOptions) {
    this.node = node;
    this.nodeBaseUrl = nodeBaseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.getSignedInFid = getSignedInFid;
    this.countCap = countCap;
    this.embedKinds = embedKinds;
    // The page reads go through the same fetch seam as everything else, so a
    // test that fakes the node's fetch does not quietly reach the open web.
    this.embedCards = embedCards ?? createEmbedCardResolver({ fetchImpl });
    // The author index goes through that same seam: it is this origin, but it
    // is still a read, and a test that fakes reads must not reach it either.
    this.resolveCastAuthor =
      resolveCastAuthor ??
      ((hash: string) => fetchCastAuthorFromOrigin({ hash, fetchImpl }));
  }

  /**
   * What a URL is, as far as anything has been able to establish. Passed to the
   * cast translator, which is the only other place that decides which bucket an
   * embed lands in.
   */
  private readonly embedKindLookup = (
    url: string,
  ): EmbedKindAnswer | undefined => this.embedKinds.kindOf(url);

  /**
   * What a link's own page said about it, as far as it could be read. The cast
   * translator turns this into the open-graph a card is drawn from — and into
   * the mini-app embed whose button launches the app.
   */
  private readonly cardLookup = (url: string): EmbedCard | undefined =>
    this.embedCards.cardOf(url);

  /**
   * Ask what this page's embed URLs are, together, before any cast is built.
   *
   * One batch per page rather than per cast: the probes share one concurrency
   * pool and one deadline, and the answer is cached, so the per-cast call in
   * `buildCast` is a lookup rather than a second round of network.
   *
   * Two questions, in this order, because the second one is about links: what
   * each URL *is* (`embedKinds`, a HEAD/ranged GET/`Image()` probe), then what
   * each URL that turned out to be a page *says* (`embedCards`, one bounded
   * read of the page's tags). A URL already known to be an image or a video is
   * never asked the second question — reading a photo's bytes as HTML would
   * cost a download and answer nothing.
   */
  private async classifyEmbeds(messages: NodeMessage[]): Promise<void> {
    await this.prepareEmbeds(
      messages.flatMap((message) => embedUrlsOf(message.castAdd)),
    );
  }

  /** The two batched questions, for any set of embed URLs (one cast or one page). */
  private async prepareEmbeds(urls: string[]): Promise<void> {
    if (urls.length === 0) {
      return;
    }
    await this.embedKinds.classify(urls);
    const links = urls.filter((url) => {
      const kind = this.embedKinds.kindOf(url);
      return kind !== 'image' && kind !== 'video';
    });
    if (links.length > 0) {
      await this.embedCards.resolve(links);
    }
  }

  /** The account every signed-in read is relative to. */
  requireFid(): number {
    const fid = this.getSignedInFid();
    if (fid === undefined) {
      throw new NodeCannotAnswerError(
        'No account is signed in on this device, so there is nothing to read for it.',
      );
    }
    return fid;
  }

  /** The account every signed-in read is relative to, or undefined. */
  signedInFid(): number | undefined {
    return this.getSignedInFid();
  }

  // ---------------------------------------------------------------- user reads

  private async userDataMessages(fid: number): Promise<NodeMessage[]> {
    const page = await this.node.userDataByFid({
      fid,
      pageSize: USER_DATA_PAGE_SIZE,
    });
    // User data is a log; the newest message for each field is the current
    // value, which is why they are handed over oldest-first.
    return [...page.messages].sort((a, b) => a.timestamp - b.timestamp);
  }

  private async countLinkDirection({
    fid,
    targetFid,
  }: {
    fid?: number;
    targetFid?: number;
  }): Promise<NodeCount> {
    const key = fid !== undefined ? `from:${fid}` : `to:${targetFid}`;
    const cached = this.countCache.get(key);
    if (cached && Date.now() - cached.at < COUNT_CACHE_MS) {
      return cached.value;
    }

    let count = 0;
    let pageToken: string | undefined;
    let isFloor = false;

    for (;;) {
      const page =
        fid !== undefined
          ? await this.node.linksByFid({
              fid,
              linkType: 'follow',
              pageSize: COUNT_PAGE_SIZE,
              pageToken,
            })
          : await this.node.linksByTargetFid({
              targetFid: targetFid as number,
              linkType: 'follow',
              pageSize: COUNT_PAGE_SIZE,
              pageToken,
            });

      count += page.messages.length;
      pageToken = page.nextPageToken;

      if (page.messages.length === 0 || isTerminalPageToken(pageToken)) {
        break;
      }
      if (count >= this.countCap) {
        isFloor = true;
        break;
      }
    }

    const value = isFloor ? floorCount(count) : exactCount(count);
    this.countCache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * A PROFILE-shaped account: the one a profile header, a search result or
   * `useUser` shows. Counts are counted by paging the follow graph, so they are
   * exact below the cap and a floor above it — `NodeCount.isFloor` says which.
   *
   * Cast-shaped surfaces (a card in the feed, a thread, a notification's actor)
   * must NOT come here: see `readAuthor` for what they need, and for the
   * measurement that says why counting followers is not part of drawing a cast.
   */
  async readUser(fid: number): Promise<ApiUser> {
    const cached = this.userCache.get(fid);
    if (cached && Date.now() - cached.at < USER_CACHE_MS) {
      return cached.value;
    }

    const inFlight = this.userPromiseCache.get(fid);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const [userData, followerCount, followingCount] = await Promise.all([
        this.userDataMessages(fid),
        this.countLinkDirection({ targetFid: fid }),
        this.countLinkDirection({ fid }),
      ]);

      const following = await this.viewerFollows(fid);
      const viewerContext = following === undefined ? undefined : { following };

      const user = apiUserFromNode({
        fid,
        userData,
        followerCount,
        followingCount,
        ...(viewerContext ? { viewerContext } : {}),
      });

      this.userCache.set(fid, { at: Date.now(), value: user });
      return user;
    })();

    this.userPromiseCache.set(fid, promise);
    try {
      return await promise;
    } finally {
      this.userPromiseCache.delete(fid);
    }
  }

  /**
   * Is there a follow edge from the viewer to this account?
   *
   * `/v1/linkById` asks the question itself, so the answer is one small message
   * or a "no such link". This used to page `/v1/linksByFid` with
   * `pageSize: 1000` and look for the target among the links that came back —
   * which is both a large response per account (the node treats `pageSize` as a
   * minimum and answers 2000) and wrong for a viewer who follows more accounts
   * than one page holds. A not-found link is `false`; a node that cannot answer
   * at all leaves the field out rather than claiming either way.
   */
  private async viewerFollows(targetFid: number): Promise<boolean | undefined> {
    const viewerFid = this.getSignedInFid();
    if (viewerFid === undefined || viewerFid === targetFid) {
      return undefined;
    }
    try {
      await this.node.linkById({
        fid: viewerFid,
        targetFid,
        linkType: 'follow',
      });
      return true;
    } catch (error) {
      // A missing edge is the answer "no"; anything else leaves the field out.
      return isMissingOnNode(error) ? false : undefined;
    }
  }

  /**
   * An account as a CAST-SHAPED surface needs it: who they are, and whether the
   * viewer follows them. Never the follower/following counts.
   *
   * WHY THIS EXISTS (MEASURED, 2026-10-22, the live client, a real follow graph)
   *
   * The counts are not free: the node serves them as a *paged log*, so counting
   * a popular account's followers means several responses of 2000 links each,
   * and `pageSize` is a minimum. Building a 25-cast home feed through the
   * profile-shaped read therefore cost, before this change, 98
   * `/v1/linksByTargetFid` and 120 `/v1/linksByFid` requests — 232 seconds of
   * request time across the run, and the slowest account's count paging was
   * still in flight when the first cast finally painted at 29.4s. Nothing on a
   * cast card (or in a notification, or on a quoted cast) renders either count;
   * the surfaces that do — a profile header, a search result, `useUser` — read
   * the account through `readUser`, which is unchanged and still counts for
   * real.
   *
   * The consequence is deliberate and worth stating: the account object this
   * returns carries `0` for both counts, because the fork's `ApiUser` type has
   * no way to say "not read". A surface that renders a count must therefore use
   * `readUser`, never a cast's author.
   */
  async readAuthor(fid: number): Promise<ApiUser> {
    const cached = this.authorCache.get(fid);
    if (cached && Date.now() - cached.at < USER_CACHE_MS) {
      return cached.value;
    }

    const inFlight = this.authorPromiseCache.get(fid);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      // Two small reads, together: the account's own user data, and the one
      // follow edge the viewer may or may not have to them.
      const [userData, following] = await Promise.all([
        this.userDataMessages(fid),
        this.viewerFollows(fid),
      ]);

      const user = apiUserFromNode({
        fid,
        userData,
        ...(following !== undefined ? { viewerContext: { following } } : {}),
      });

      this.authorCache.set(fid, { at: Date.now(), value: user });
      return user;
    })();

    this.authorPromiseCache.set(fid, promise);
    try {
      return await promise;
    } finally {
      this.authorPromiseCache.delete(fid);
    }
  }

  /**
   * The profiles of the accounts a read's casts mention.
   *
   * A cast's mentions are FIDs, and the handle that belongs where each one sits
   * in the text is the mentioned account's own user data — so every tagged
   * account has to be read, not only the signed-in one. Asked for together and
   * deduped: a page asks once per distinct FID and shares the authors' cache and
   * in-flight reads, so a cast that tags six people is six reads for the whole
   * page, not six on every re-render.
   *
   * A FID the node cannot answer for is left out of the map rather than failing
   * the read: the cast then renders the fid floor for it and the rest of the page
   * is unaffected.
   */
  private async resolveMentionUsers(
    mentionedFids: number[],
  ): Promise<Map<number, ApiUser>> {
    const distinct = [...new Set(mentionedFids)];
    if (distinct.length === 0) {
      return new Map();
    }

    const read = await mapWithConcurrency(
      distinct,
      RESOLVE_CONCURRENCY,
      async (fid) => {
        try {
          return [fid, await this.readAuthor(fid)] as const;
        } catch {
          return undefined;
        }
      },
    );

    return new Map(
      read.filter(
        (entry): entry is readonly [number, ApiUser] => entry !== undefined,
      ),
    );
  }

  /** Every FID a set of casts mentions, page order preserved. */
  private static mentionedFidsOf(messages: NodeMessage[]): number[] {
    return messages.flatMap((message) => message.castAdd?.mentions ?? []);
  }

  async readUserByUsername(username: string): Promise<ApiUser | undefined> {
    const proof = (await this.node.userNameProofByName(username)) as
      | { fid?: number }
      | undefined;
    if (!proof || typeof proof.fid !== 'number') {
      return undefined;
    }
    return await this.readUser(proof.fid);
  }

  /** Verified addresses, straight from the node's verification messages. */
  async readVerifications(fid: number): Promise<ApiVerification[]> {
    const url = `${this.nodeBaseUrl}/v1/verificationsByFid?fid=${fid}&pageSize=${USER_DATA_PAGE_SIZE}`;
    const response = await this.fetchImpl(url, { method: 'GET' });
    if (!response.ok) {
      throw new NodeCannotAnswerError(
        `Your node refused the verification read (${response.status}).`,
      );
    }

    const body = (await response.json()) as {
      messages?: {
        data?: {
          type?: string;
          fid?: number;
          timestamp?: number;
          verificationAddAddressBody?: { address?: string; protocol?: string };
        };
      }[];
    };

    return (body.messages ?? []).flatMap((message) => {
      const data = message.data;
      const address = data?.verificationAddAddressBody?.address;
      if (!data || !address) {
        return [];
      }
      const isSolana = (data.type ?? '').includes('SOLANA');
      return [
        {
          fid: data.fid ?? fid,
          address,
          timestamp: fcTimestampToMs(data.timestamp ?? 0),
          version: 'v1' as const,
          protocol: isSolana ? ('solana' as const) : ('ethereum' as const),
          // `isPrimary` is a hosted statement about which address a profile
          // shows first. The node does not rank them, so this is not claimed.
          isPrimary: false,
        },
      ];
    });
  }

  // ---------------------------------------------------------------- settings reads

  /**
   * The accounts this one has blocked, read from the node's own block links.
   *
   * MEASURED (a live public read node, 2026-10-22) — a block is a protocol
   * message, not a hosted list:
   *
   *   GET /v1/linksByFid?fid=3&link_type=block
   *     → MESSAGE_TYPE_LINK_ADD, linkBody { type: 'block', targetFid: 15156 }
   *
   * So the settings page's blocked list is answerable from your own node: the
   * links ARE the list, and each blocked account's profile is read the way every
   * other profile in this client is. Before this reader existed the page asked
   * for a reader that had never been written and said so on screen.
   */
  async readBlockedUsers({
    fid,
    limit,
  }: {
    fid: number;
    limit: number;
  }): Promise<{ blockedUsers: ApiBlockedUser[]; cursor?: string }> {
    const pageSize = Math.min(
      Math.max(Math.trunc(limit) || 1, 1),
      COUNT_PAGE_SIZE,
    );
    const url = `${this.nodeBaseUrl}/v1/linksByFid?fid=${fid}&link_type=block&pageSize=${pageSize}`;
    const response = await this.fetchImpl(url, { method: 'GET' });
    if (!response.ok) {
      throw new NodeCannotAnswerError(
        `Your node refused the blocked-accounts read (${response.status}).`,
      );
    }

    const body = (await response.json()) as {
      messages?: {
        data?: {
          timestamp?: number;
          linkBody?: { type?: string; targetFid?: number };
        };
      }[];
      nextPageToken?: string;
    };

    // One row per block link this account wrote. A link of any other type in
    // this page is not a block and is not claimed as one.
    const blocks = (body.messages ?? []).flatMap((message) => {
      const link = message.data?.linkBody;
      if (link?.type !== 'block' || link.targetFid === undefined) {
        return [];
      }
      return [
        { targetFid: link.targetFid, timestamp: message.data?.timestamp ?? 0 },
      ];
    });

    const profiles = new Map(
      (
        await mapWithConcurrency(
          [...new Set(blocks.map((block) => block.targetFid))],
          RESOLVE_CONCURRENCY,
          async (targetFid) => {
            try {
              return [targetFid, await this.readUser(targetFid)] as const;
            } catch {
              return undefined;
            }
          },
        )
      ).filter(
        (entry): entry is readonly [number, ApiUser] => entry !== undefined,
      ),
    );

    const blockedUsers: ApiBlockedUser[] = blocks.flatMap((block) => {
      const user = profiles.get(block.targetFid);
      // A block whose account could not be read is still a real block: the
      // fid is the fact, the profile is decoration. The page renders a row
      // only when it has the profile, so the row is dropped rather than
      // drawn with an invented name.
      if (!user) {
        return [];
      }
      return [
        {
          blockerFid: fid,
          blockedFid: block.targetFid,
          blockedUser: userMinimalFrom(user),
          createdAt: fcTimestampToMs(block.timestamp),
        },
      ];
    });

    const nextPageToken = body.nextPageToken;
    return {
      blockedUsers,
      ...(nextPageToken && !isTerminalPageToken(nextPageToken)
        ? { cursor: nextPageToken }
        : {}),
    };
  }

  /**
   * What this account may store, and what it is using — the node's own numbers.
   *
   * MEASURED (2026-10-22, `GET /v1/storageLimitsByFid?fid=3` on a live read
   * node):
   *
   *   casts  limit 108000  used 51340
   *   links  limit  54000  used  4660
   *   reactions limit 54000 used 53162     … plus `units: 30`
   *
   * Two honest translations, and no invented ones:
   *
   *   - `used` is the node's own count of this account's messages in that store;
   *   - `rented` is the node's own allowance for the store. The hosted page
   *     draws that column as "used / rented" with the percentage in use, and
   *     the allowance is exactly the denominator a reader cares about. It is the
   *     protocol's base plus whatever units this account has bought — the node
   *     computed it, this client did not guess it.
   *
   * `rentedUnits` is the node's `units`, the same storage-unit count the hosted
   * page shows next to "Buy more storage".
   */
  async readStorageUtilization({
    fid,
  }: {
    fid: number;
  }): Promise<ApiStorageUtilization> {
    const url = `${this.nodeBaseUrl}/v1/storageLimitsByFid?fid=${fid}`;
    const response = await this.fetchImpl(url, { method: 'GET' });
    if (!response.ok) {
      throw new NodeCannotAnswerError(
        `Your node refused the storage read (${response.status}).`,
      );
    }

    const body = (await response.json()) as {
      limits?: {
        name?: string;
        storeType?: string;
        limit?: number;
        used?: number;
      }[];
      units?: number;
    };

    const store = (name: string) => {
      const entry = (body.limits ?? []).find(
        (candidate) =>
          (candidate.name ?? candidate.storeType ?? '').toLowerCase() === name,
      );
      return { used: entry?.used ?? 0, rented: entry?.limit ?? 0 };
    };

    return {
      rentedUnits: typeof body.units === 'number' ? body.units : 0,
      casts: store('casts'),
      reactions: store('reactions'),
      links: store('links'),
    };
  }

  // ---------------------------------------------------------------- cast reads

  private rememberCasts(messages: NodeMessage[]): void {
    for (const message of messages) {
      if (message.castAdd) {
        rememberCastAuthor(message.hash, message.fid);
        this.castCache.set(`${message.fid}:${message.hash}`, {
          at: Date.now(),
          value: message,
        });
      }
    }
  }

  /**
   * One cast, as the hosted shapes — for a caller that already holds a node
   * message (the writer, answering `POST /v2/casts` with the cast it just got
   * the node to store). Counts are not read: a cast that was just accepted has
   * no reactions to report, and the client re-reads it as soon as the composer
   * invalidates its queries.
   */
  async apiCastFor(message: NodeMessage): Promise<ApiCast | undefined> {
    return this.buildCast({ message, withCounts: false });
  }

  private async castById(
    fid: number,
    hash: string,
  ): Promise<NodeMessage | undefined> {
    const cached = this.castCache.get(`${fid}:${hash}`);
    if (cached) {
      return cached.value;
    }
    try {
      const message = await this.node.castById({ fid, hash });
      this.rememberCasts([message]);
      return message;
    } catch {
      return undefined;
    }
  }

  private async countReactions({
    targetFid,
    targetHash,
    reactionType,
  }: {
    targetFid: number;
    targetHash: string;
    reactionType: 'Like' | 'Recast';
  }): Promise<NodeCount> {
    const key = `${reactionType}:${targetFid}:${targetHash}`;
    const cached = this.countCache.get(key);
    if (cached && Date.now() - cached.at < COUNT_CACHE_MS) {
      return cached.value;
    }

    let count = 0;
    let pageToken: string | undefined;
    let isFloor = false;

    for (;;) {
      const page = await this.node.reactionsByCast({
        targetFid,
        targetHash,
        reactionType,
        pageSize: COUNT_PAGE_SIZE,
        pageToken,
      });
      count += page.messages.length;
      pageToken = page.nextPageToken;
      if (page.messages.length === 0 || isTerminalPageToken(pageToken)) {
        break;
      }
      if (count >= this.countCap) {
        isFloor = true;
        break;
      }
    }

    const value = isFloor ? floorCount(count) : exactCount(count);
    this.countCache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Which casts the signed-in account has already liked / recast.
   *
   * Cached, because the question ("which of my likes do I hold?") is answered by
   * paging the viewer's WHOLE reaction log — 2000 messages per page, measured at
   * 1.4–5.5s — and every page read and every thread read used to ask it again
   * from scratch, twice (once per reaction type). The set only grows as the
   * viewer likes things, and a minute of reuse pays for itself on the second
   * read of any page.
   *
   * WHAT KEEPS THAT MINUTE HONEST — and this is the part a comment here got
   * wrong once (t_4c990a3b): nothing invalidates this cache. The fork's like and
   * recast hooks paint the heart optimistically and call the API; they run in
   * another package, know nothing about a node-side reader, and clear no query
   * key this cache answers. So a write is folded in HERE instead, by
   * `noteViewerReaction`, which the write half of the seam calls once the node
   * has really merged the reaction. Without that fold, liking a cast and opening
   * its conversation inside the minute rebuilt `viewerContext.reacted` from the
   * pre-like set and drew the heart un-liked while the like itself had landed.
   */
  private async viewerReactionHashes(
    reactionType: 'Like' | 'Recast',
  ): Promise<Set<string>> {
    const fid = this.getSignedInFid();
    if (fid === undefined) {
      return new Set();
    }

    const cached = this.viewerReactionCache.get(reactionType);
    if (cached && Date.now() - cached.at < VIEWER_REACTION_CACHE_MS) {
      return this.withSessionWrites(reactionType, cached.value);
    }

    const inFlight = this.viewerReactionPromiseCache.get(reactionType);
    if (inFlight) {
      // A read that was already on its way when this session wrote a reaction
      // answers with the pre-write log; folding here is what stops the write
      // disappearing for the life of the window.
      return this.withSessionWrites(reactionType, await inFlight);
    }

    const promise = (async () => {
      try {
        const page = await this.node.reactionsByFid({
          fid,
          reactionType,
          pageSize: COUNT_PAGE_SIZE,
        });
        const hashes = new Set(
          page.messages
            .map((message) => message.reaction?.targetCastId?.hash)
            .filter((hash): hash is string => typeof hash === 'string'),
        );
        this.viewerReactionCache.set(reactionType, {
          at: Date.now(),
          value: hashes,
        });
        return hashes;
      } catch {
        // A node that cannot answer must not be remembered as "you liked
        // nothing": the empty set is for this read only.
        return new Set<string>();
      }
    })();

    this.viewerReactionPromiseCache.set(reactionType, promise);
    try {
      return this.withSessionWrites(reactionType, await promise);
    } finally {
      this.viewerReactionPromiseCache.delete(reactionType);
    }
  }

  /**
   * The memoised set, with the reactions THIS session has written folded in.
   *
   * The overlay is last-write-wins per hash, and it is applied to whichever base
   * a read got — the cached set, an in-flight fetch, or a page just read — so a
   * reaction written while a read was on its way is drawn too. No writes is the
   * common case: one comparison, and the base set is returned as it was.
   */
  private withSessionWrites(
    reactionType: 'Like' | 'Recast',
    base: Set<string>,
  ): Set<string> {
    const written = this.writtenReactions.get(reactionType);
    if (written === undefined || written.size === 0) {
      return base;
    }
    const answer = new Set(base);
    for (const [hash, added] of written) {
      const held = heldHash(answer, hash);
      if (added) {
        if (held === undefined) {
          answer.add(hash);
        }
      } else if (held !== undefined) {
        answer.delete(held);
      }
    }
    return answer;
  }

  /**
   * Note a like or recast THIS SESSION has just written, so the set above draws
   * it before the node's own log is read again.
   *
   * Called by the write half of the seam (`nodeBackedFetch`) once the node has
   * really merged the reaction — never before, and never for a write that
   * failed. The node's `/v1/reactionsByFid` log stays the source of truth and is
   * read again when the window above runs out; this only closes the gap between
   * the write and that re-read, which is up to a minute wide. Both directions
   * matter: un-liking a cast and opening it inside the window must not draw a
   * heart the person just took back.
   *
   * A session fact, not a node fact, so it lives as long as this reader does and
   * a sign-out drops it with the caches (see `clearCaches`).
   */
  noteViewerReaction({
    castHash,
    reactionType,
    added,
  }: {
    castHash: string;
    reactionType: 'Like' | 'Recast';
    /** True for the reaction written, false for the one taken back. */
    added: boolean;
  }): void {
    if (castHash.length === 0) {
      return;
    }
    const written =
      this.writtenReactions.get(reactionType) ?? new Map<string, boolean>();
    written.set(castHash, added);
    this.writtenReactions.set(reactionType, written);
  }

  /** Resolve one node cast into the API's cast shape, with its counts. */
  private async buildCast({
    message,
    likedHashes,
    recastHashes,
    parentAuthor,
    threadHash,
    ancestors,
    replies,
    withCounts = true,
    embedsAsked = false,
    mentionUsers,
  }: {
    message: NodeMessage;
    likedHashes?: Set<string>;
    recastHashes?: Set<string>;
    parentAuthor?: ApiUser;
    threadHash?: string;
    ancestors?: { count: number; casts?: ApiCast[] };
    replies?: { count: number; casts?: ApiCast[] };
    withCounts?: boolean;
    /**
     * True when the caller already asked about this page's embed URLs as one
     * batch (`classifyEmbeds`), so this cast only looks the answers up. One
     * wait per read, not one per cast.
     */
    embedsAsked?: boolean;
    /**
     * The mentioned accounts' profiles, when the caller already read them for a
     * whole page (`buildCasts`, `readThread`). A cast built on its own — the
     * reply a notification names, the cast a write just stored — reads its own
     * mentions instead, so no path renders bare placeholders.
     */
    mentionUsers?: Map<number, ApiUser>;
  }): Promise<ApiCast | undefined> {
    const body = message.castAdd;
    if (!body) {
      return undefined;
    }

    // Which of this cast's URLs are media. The page's own batch already asked
    // when this cast came out of a feed; a cast read on its own (a thread root
    // by hash, say) asks here, so a photo is a photo on the first paint either
    // way. Either way it is one bounded wait, never two.
    if (!embedsAsked) {
      await this.prepareEmbeds(embedUrlsOf(body));
    }

    const mentionUsersPromise =
      mentionUsers !== undefined
        ? Promise.resolve(mentionUsers)
        : this.resolveMentionUsers(body.mentions);

    const [author, reactions, recasts, mentioned] = await Promise.all([
      this.readAuthor(message.fid),
      withCounts
        ? this.countReactions({
            targetFid: message.fid,
            targetHash: message.hash,
            reactionType: 'Like',
          })
        : Promise.resolve(exactCount(0)),
      withCounts
        ? this.countReactions({
            targetFid: message.fid,
            targetHash: message.hash,
            reactionType: 'Recast',
          })
        : Promise.resolve(exactCount(0)),
      mentionUsersPromise,
    ]);

    // Quoted casts are resolved for real (they address their parent), so a
    // quote renders as a quote rather than an empty box.
    const { quoteTargets } = castEmbedsFromNode({ body });
    const quoted = await mapWithConcurrency(
      quoteTargets,
      RESOLVE_CONCURRENCY,
      async (target) => {
        const quotedMessage = await this.castById(target.fid, target.hash);
        if (!quotedMessage?.castAdd) {
          return undefined;
        }
        const quotedAuthor = await this.readAuthor(quotedMessage.fid);
        return {
          hash: quotedMessage.hash,
          threadHash: quotedMessage.hash,
          author: quotedAuthor,
          text: quotedMessage.castAdd.text,
          timestamp: quotedMessage.timestampMs,
        };
      },
    );

    const viewerContext =
      likedHashes || recastHashes
        ? {
            ...(likedHashes?.has(message.hash) ? { reacted: true } : {}),
            ...(recastHashes?.has(message.hash) ? { recast: true } : {}),
          }
        : undefined;

    return apiCastFromNode({
      message,
      body,
      author,
      ...(parentAuthor ? { parentAuthor } : {}),
      ...(threadHash ? { threadHash } : {}),
      ...(ancestors ? { ancestors } : {}),
      ...(replies ? { replies } : {}),
      reactions,
      recasts,
      quotedCasts: quoted.filter((cast) => cast !== undefined),
      embedKind: this.embedKindLookup,
      cardOf: this.cardLookup,
      mentionUsers: mentioned,
      ...(viewerContext && Object.keys(viewerContext).length > 0
        ? { viewerContext }
        : {}),
    });
  }

  /** Assemble a page of casts from raw node messages, order preserved. */
  private async buildCasts(
    messages: NodeMessage[],
    {
      withCounts = true,
      withViewer = true,
    }: { withCounts?: boolean; withViewer?: boolean } = {},
  ): Promise<ApiCast[]> {
    this.rememberCasts(messages);
    // Three independent questions about the page, asked together.
    //
    // They used to be answered one after another, and each one has its own
    // bounded wait, so a page's first paint paid the SUM of three network waits
    // that have nothing to do with each other:
    //
    //   - what each embed URL IS and what each link SAYS (`classifyEmbeds`,
    //     bounded probes of pages this client does not own);
    //   - who the accounts the page mentions are (`resolveMentionUsers`);
    //   - which of the page's casts the viewer has already liked / recast
    //     (`viewerReactionHashes`, which reads the viewer's whole reaction log).
    //
    // MEASURED (2026-10-22, the live client, box load ~11): the embeds' bounded
    // waits (1.5s + 2s) ran to their deadline first, the viewer's two reaction
    // logs only STARTED at 12.6s and each took 5.3s — and the first cast painted
    // at 17.4s. Nothing below depends on the others, so they run at once and the
    // wait is the slowest of the three, not their sum.
    const [mentionUsers, [likedHashes, recastHashes]] = await Promise.all([
      this.resolveMentionUsers(NodeBackedReads.mentionedFidsOf(messages)),
      withViewer
        ? Promise.all([
            this.viewerReactionHashes('Like'),
            this.viewerReactionHashes('Recast'),
          ])
        : Promise.resolve([undefined, undefined] as [
            Set<string> | undefined,
            Set<string> | undefined,
          ]),
      // The page's embed URLs are asked about together, before any cast is built:
      // a photo is drawn as a photo on the first paint rather than after a
      // reload, and a link's own title, picture and mini-app card are in hand
      // before the card is drawn (`preparedEmbeds`).
      this.classifyEmbeds(messages),
    ]);

    const casts = await mapWithConcurrency(
      messages,
      RESOLVE_CONCURRENCY,
      (message) =>
        this.buildCast({
          message,
          likedHashes,
          recastHashes,
          withCounts,
          embedsAsked: true,
          mentionUsers,
        }),
    );

    return casts.filter((cast): cast is ApiCast => cast !== undefined);
  }

  // ---------------------------------------------------------------- feed reads

  /**
   * A channel's parent URL from its key — `channelParentUrlFor` is the one
   * implementation; this is the reader-shaped door onto it.
   */
  channelParentUrl(key: string): string {
    return channelParentUrlFor(key);
  }

  private async followingFeedMessages({
    fid,
    olderThan,
    limit,
    includeSelf,
  }: {
    fid: number;
    olderThan?: number;
    limit: number;
    includeSelf: boolean;
  }): Promise<NodeMessage[]> {
    // MEASURED (a real follow graph, a real node, a browser): reading 200
    // accounts' casts at 25 each took ~55s to answer the feed's first page —
    // long past the point a user believes the client is working. The read is
    // therefore bounded twice over: 60 accounts (the most recently followed,
    // which is the freshest slice of a large follow graph) and 10 casts each,
    // with the merge below taking the newest 25. Same shape as before, roughly
    // an order of magnitude less wall clock.
    const following = await fetchFollowing({ node: this.node, fid, limit: 60 });
    const authorFids = includeSelf ? [fid, ...following] : following;

    // The feed is assembled locally, so a page is: the newest few casts from
    // each followed account, merged on the protocol timestamp.
    //
    // One unreachable account must not blank the feed — but "no account
    // answered" is not an empty feed, it is an unreadable one. MEASURED (the
    // relay pointed at a refused port): every per-author read came back 500,
    // every one was swallowed by the `catch` below, and the feed answered `200`
    // with zero items — the same "there is nothing here" a genuinely quiet
    // follow graph produces. Counted, so the two can be told apart.
    let answered = 0;
    let lastFailure: unknown;
    const perAuthor = await mapWithConcurrency(
      authorFids,
      RESOLVE_CONCURRENCY,
      async (authorFid) => {
        try {
          const page = await this.node.castsByFid({
            fid: authorFid,
            pageSize: Math.min(limit, 10),
            reverse: true,
          });
          answered += 1;
          return page.messages.filter((message) => message.castAdd);
        } catch (error) {
          // One unreachable account must not blank the feed.
          lastFailure = error;
          return [] as NodeMessage[];
        }
      },
    );

    if (answered === 0 && authorFids.length > 0) {
      const message =
        lastFailure instanceof Error
          ? lastFailure.message
          : String(lastFailure);
      throw new Error(
        `none of the ${authorFids.length} accounts this read asked answered (${message})`,
      );
    }

    const byHash = new Map<string, NodeMessage>();
    for (const message of perAuthor.flat()) {
      if (message.castAdd?.parentCastId || message.castAdd?.parentUrl) {
        // Replies and channel posts belong to their own surfaces; the home
        // feed is the accounts' own casts, the way the hosted feed reads.
        continue;
      }
      if (olderThan !== undefined && message.timestampMs >= olderThan) {
        continue;
      }
      byHash.set(`${message.fid}:${message.hash}`, message);
    }

    return [...byHash.values()]
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, limit);
  }

  private async channelFeedMessages({
    key,
    olderThan,
    limit,
  }: {
    key: string;
    olderThan?: number;
    limit: number;
  }): Promise<NodeMessage[]> {
    const page = await this.node.castsByParent({
      url: this.channelParentUrl(key),
      pageSize: Math.min(limit * 2, 50),
      reverse: true,
    });
    return page.messages
      .filter((message) => message.castAdd)
      .filter(
        (message) => olderThan === undefined || message.timestampMs < olderThan,
      )
      .sort((a, b) => b.timestampMs - a.timestampMs)
      .slice(0, limit);
  }

  /**
   * `POST /v2/feed-items`. The feed the app asks for decides the source:
   * `home` and `following` are your follow graph, anything else is treated as
   * a channel key (the app passes `feed.key` for channel feeds).
   */
  async readFeed({
    feedKey,
    feedType,
    olderThan,
    limit = 25,
    updateState = false,
  }: {
    feedKey: string;
    feedType?: string;
    olderThan?: number;
    limit?: number;
    updateState?: boolean;
  }): Promise<ApiFeedItemsResult> {
    const fid = this.requireFid();

    const isHome = feedKey === 'home';
    const isFollowing = feedKey === 'following';
    if (
      feedType === 'for-you' ||
      feedType === 'trending' ||
      feedType === 'curated'
    ) {
      // Ranking is an indexer's job; saying so is better than serving the
      // follow graph under a "For you" label.
      throw new NodeCannotAnswerError(
        `“${feedType}” is a ranked feed, and ranking is the indexer’s job. Your node can build the following feed.`,
      );
    }

    const messages =
      isHome || isFollowing
        ? await this.followingFeedMessages({
            fid,
            olderThan,
            limit,
            includeSelf: isHome,
          })
        : await this.channelFeedMessages({ key: feedKey, olderThan, limit });

    const casts = await this.buildCasts(messages);

    if (updateState) {
      this.markSeen(fid, isHome || isFollowing ? 'home' : feedKey);
    }

    return {
      items: casts.map((cast) => apiCastFeedItemFromNode({ cast })),
      latestMainCastTimestamp: casts[0]?.timestamp ?? Date.now(),
    };
  }

  // -------------------------------------------------------------- thread reads

  /**
   * `GET /v2/thread-casts`: the ancestors, the cast, then its replies.
   *
   * The request carries only a hash. A Snapchain node shards by FID, so a hash
   * alone cannot be looked up — the author comes from the memo filled by every
   * cast this reader has served (your feed, a profile, a channel), or, when
   * this page IS the first thing the reader has opened (a shared cast link),
   * from this origin's own index of authors (`castAuthorHandoff.ts`), which is
   * the server half of the same fact that drew the link's card. When neither
   * can say who wrote it, that is reported in plain words.
   */
  async readThread({
    castHash,
    limit = 15,
    replyPreviewLimit = 25,
  }: {
    castHash: string;
    limit?: number;
    replyPreviewLimit?: number;
  }): Promise<ApiThreadResult> {
    const fid =
      castAuthorOf(castHash) ?? (await this.resolveCastAuthor(castHash));
    if (fid === undefined) {
      throw new NodeCannotAnswerError(
        'Your node addresses a cast by its author and its hash, and this page only has the hash. Open the cast from your feed or a profile and it will load.',
      );
    }
    // Remembered for the rest of the session: every reaction, reply and quote
    // read of this thread would otherwise ask the same question again.
    rememberCastAuthor(castHash, fid);

    const root = await this.castById(fid, castHash);
    if (!root?.castAdd) {
      throw new NodeCannotAnswerError('Your node does not have that cast.');
    }

    // Walk up to the thread root. Bounded, because a deep thread should not
    // turn into an unbounded walk on a click.
    const ancestors: NodeMessage[] = [];
    let cursor = root;
    for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop += 1) {
      const parent = cursor.castAdd?.parentCastId;
      if (!parent) {
        break;
      }
      const parentMessage = await this.castById(parent.fid, parent.hash);
      if (!parentMessage?.castAdd) {
        break;
      }
      ancestors.unshift(parentMessage);
      cursor = parentMessage;
    }

    const repliesPage = await this.node.castsByParent({
      fid,
      hash: castHash,
      pageSize: Math.min(replyPreviewLimit, 50),
      reverse: false,
    });
    const replies = repliesPage.messages.filter((message) => message.castAdd);

    this.rememberCasts([...ancestors, root, ...replies]);
    const [likedHashes, recastHashes] = await Promise.all([
      this.viewerReactionHashes('Like'),
      this.viewerReactionHashes('Recast'),
    ]);

    const castMessages = [...ancestors, root, ...replies];
    // One batch of profiles for every account the thread's casts mention.
    const mentionUsers = await this.resolveMentionUsers(
      NodeBackedReads.mentionedFidsOf(castMessages),
    );
    const built = await mapWithConcurrency(
      castMessages,
      RESOLVE_CONCURRENCY,
      (message) =>
        this.buildCast({
          message,
          likedHashes,
          recastHashes,
          mentionUsers,
          threadHash: ancestors[0]?.hash ?? root.hash,
          ...(message.hash === root.hash
            ? {
                ancestors: { count: ancestors.length },
                // Only the page we fetched is claimed: a floor, not a total.
                replies: { count: replies.length },
              }
            : {}),
        }),
    );

    const casts = built.filter((cast): cast is ApiCast => cast !== undefined);
    return {
      casts: casts.slice(0, limit + ancestors.length + 1),
      ...(repliesPage.nextPageToken &&
      !isTerminalPageToken(repliesPage.nextPageToken)
        ? { hasHiddenReplies: false }
        : {}),
    };
  }

  /** `GET /v2/user-casts`: one account's own casts, newest first. */
  async readUserCasts({
    fid,
    limit = 25,
    olderThan,
  }: {
    fid: number;
    limit?: number;
    olderThan?: number;
  }): Promise<ApiCast[]> {
    const page = await this.node.castsByFid({
      fid,
      pageSize: Math.min(limit * 2, 100),
      reverse: true,
    });
    const messages = page.messages
      .filter((message) => message.castAdd)
      .filter(
        (message) => olderThan === undefined || message.timestampMs < olderThan,
      )
      .slice(0, limit);
    return await this.buildCasts(messages);
  }

  // -------------------------------------------------------- the follow graph

  /**
   * The accounts that follow this one — the node's own follow links.
   *
   * MEASURED (a live public read node, 2026-10-22):
   *
   *   GET /v1/linksByTargetFid?target_fid=3&link_type=follow&pageSize=2
   *     → MESSAGE_TYPE_LINK_ADD, data.fid 6, linkBody { type: 'follow', targetFid: 3 }
   *
   * The *author* of the edge is the follower, so the page's edges are the page's
   * accounts: each one is read the way every other account in this client is.
   * Before this reader existed the profile's Followers tab asked for a reader
   * that had never been written and said so on screen.
   */
  async readFollowers({
    fid,
    limit,
    cursor,
  }: {
    fid: number;
    limit?: number;
    cursor?: string;
  }): Promise<{ users: ApiUser[]; cursor?: string }> {
    const page = await this.node.linksByTargetFid({
      targetFid: fid,
      linkType: 'follow',
      pageSize: this.pageSizeFor(limit),
      ...(cursor === undefined ? {} : { pageToken: cursor }),
    });
    // The edge's author is the follower; the link's own target is the account
    // that was followed, which is already known.
    return await this.usersOfLinks(page, (message) => message.fid);
  }

  /**
   * The accounts this one follows — the same edges, read from the other side.
   *
   * MEASURED (a live public read node, 2026-10-22):
   *
   *   GET /v1/linksByFid?fid=3&link_type=follow&pageSize=2
   *     → MESSAGE_TYPE_LINK_ADD, linkBody { type: 'follow', targetFid: 3 }
   *
   * The account is the *target* of the edge here, so each row's profile is the
   * one the link points at. A link of another type in the same page is not a
   * follow and is never claimed as one.
   */
  async readFollowing({
    fid,
    limit,
    cursor,
  }: {
    fid: number;
    limit?: number;
    cursor?: string;
  }): Promise<{ users: ApiUser[]; cursor?: string }> {
    const page = await this.node.linksByFid({
      fid,
      linkType: 'follow',
      pageSize: this.pageSizeFor(limit),
      ...(cursor === undefined ? {} : { pageToken: cursor }),
    });
    return await this.usersOfLinks(page, (message) => message.link?.targetFid);
  }

  /**
   * The accounts one account follows that also follow a second — a "followers
   * you know" tab.
   *
   * WHY THIS EXISTS: both halves are already node state — the reader's own
   * follow edges (`linksByFid`) and the other account's followers
   * (`linksByTargetFid`) — so a tab that said a node kept nothing for this read
   * was wrong about the node. MEASURED (2026-10-22, a live public read node):
   * one page of `linksByFid?link_type=follow` for the seeded account is 79
   * edges of exactly the shape `readFollowing` reads.
   *
   * BOUND, SAID OUT LOUD: each side is ONE page (`pageSizeFor`), newest first,
   * so this is the intersection of the pages the node gave rather than of two
   * unbounded sets. `totalCount` is the number of rows in this answer, counted
   * — never a total inferred from a page, which would be a number nobody
   * measured.
   */
  async readFollowersYouKnow({
    fid,
    limit,
  }: {
    fid: number;
    limit?: number;
  }): Promise<{ users: ApiUser[]; totalCount: number }> {
    const viewerFid = this.requireFid();
    const [mine, theirs] = await Promise.all([
      this.node.linksByFid({
        fid: viewerFid,
        linkType: 'follow',
        pageSize: this.pageSizeFor(limit),
      }),
      this.node.linksByTargetFid({
        targetFid: fid,
        linkType: 'follow',
        pageSize: this.pageSizeFor(limit),
      }),
    ]);
    const followed = new Set(
      mine.messages.flatMap((message) => {
        const target = message.link?.targetFid;
        return target === undefined ? [] : [target];
      }),
    );
    const known = theirs.messages.filter((message) =>
      followed.has(message.fid),
    );
    const profiles = await this.profilesOf(known.map((message) => message.fid));
    // The page's order is the node's order, and an account that could not be
    // read is dropped rather than drawn with an invented name.
    const users = known.flatMap((message) => {
      const user = profiles.get(message.fid);
      return user === undefined ? [] : [user];
    });
    return { users, totalCount: users.length };
  }

  /**
   * `GET /v2/profile-snap-casts`: one account's casts to the snaps channel.
   *
   * The node holds them (see `SNAPS_CHANNEL_PARENT_URL`): this is the same
   * `castsByFid` page `/v2/user-casts` serves, kept to the casts whose parent
   * URL is that channel. The page asks for more than it draws, because most of
   * an account's casts are not snaps.
   */
  async readSnapCasts({
    fid,
    limit = 15,
  }: {
    fid: number;
    limit?: number;
  }): Promise<ApiCast[]> {
    const page = await this.node.castsByFid({
      fid,
      pageSize: Math.min(limit * 4, 100),
      reverse: true,
    });
    const messages = page.messages
      .filter((message) => message.castAdd)
      .filter(
        (message) => message.castAdd?.parentUrl === SNAPS_CHANNEL_PARENT_URL,
      )
      .slice(0, limit);
    return await this.buildCasts(messages);
  }

  /**
   * The accounts that liked one cast — its own reaction messages.
   *
   * MEASURED (a live public read node, 2026-10-22):
   *
   *   GET /v1/reactionsByCast?target_fid=37&target_hash=0x5018…&reaction_type=Like
   *     → MESSAGE_TYPE_REACTION_ADD, reactionBody { type: REACTION_TYPE_LIKE,
   *       targetCastId { fid: 37, hash: 0x5018… } }
   *
   * A node addresses a reaction at its target cast by *author and hash*, so the
   * author has to be known before the node can be asked. That memo is filled by
   * every cast this reader has served; when the hash has never been seen, this
   * says so in plain words rather than guessing an author (the same rule
   * `readThread` follows).
   */
  async readCastLikes({
    castHash,
    limit,
    cursor,
  }: {
    castHash: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ likes: ApiCastReaction[]; cursor?: string }> {
    const page = await this.reactionsOnCast({
      castHash,
      reactionType: 'Like',
      limit,
      cursor,
    });
    const reactors = await this.reactorsOf(page.messages);
    const likes = page.messages.flatMap((message) => {
      const reactor = reactors.get(message.fid);
      const target = message.reaction?.targetCastId;
      // A reaction whose account or cast could not be read is not drawn as a
      // row: the fact is the fid, and nothing is invented to fill the gap.
      if (reactor === undefined || target === undefined) {
        return [];
      }
      return [
        {
          type: 'like' as const,
          hash: message.hash,
          reactor,
          timestamp: fcTimestampToMs(message.timestamp),
          castHash: target.hash,
        },
      ];
    });
    return { likes, ...this.cursorOf(page) };
  }

  /**
   * The accounts that recast one cast — the same read, the other reaction type.
   *
   * MEASURED (2026-10-22, `reaction_type=Recast` against the same node): the
   * message shape is identical apart from the variant, so the two reads share
   * one implementation and differ only in what they return — this one answers
   * with accounts, which is what the recasts surface draws.
   */
  async readCastRecasters({
    castHash,
    limit,
    cursor,
  }: {
    castHash: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ users: ApiUser[]; cursor?: string }> {
    const page = await this.reactionsOnCast({
      castHash,
      reactionType: 'Recast',
      limit,
      cursor,
    });
    const reactors = await this.reactorsOf(page.messages);
    const users = page.messages.flatMap((message) => {
      const reactor = reactors.get(message.fid);
      return reactor === undefined ? [] : [reactor];
    });
    return { users, ...this.cursorOf(page) };
  }

  /**
   * One account's cast, found by the first characters of its hash.
   *
   * The hosted route takes a username and a hash prefix, and a node cannot
   * answer either on its own: `castsByFid` is the only way in, so the account's
   * pages are walked (bounded) until a hash with that prefix is found. Nothing
   * is guessed from a near miss — a prefix that matches nothing is reported as
   * not found, and the caller says so in its own words.
   */
  async readUserCastByHashPrefix({
    fid,
    hashPrefix,
  }: {
    fid: number;
    hashPrefix: string;
  }): Promise<ApiCast | undefined> {
    const wanted = hashPrefix.toLowerCase();
    if (wanted.length === 0) {
      return undefined;
    }
    let pageToken: string | undefined;
    for (let page = 0; page < PREFIX_SEARCH_PAGES; page += 1) {
      const casts = await this.node.castsByFid({
        fid,
        pageSize: PREFIX_SEARCH_PAGE_SIZE,
        reverse: true,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      const match = casts.messages.find(
        (message) =>
          message.castAdd && message.hash.toLowerCase().startsWith(wanted),
      );
      if (match) {
        return (await this.buildCasts([match])).at(0);
      }
      pageToken = casts.nextPageToken;
      if (casts.messages.length === 0 || isTerminalPageToken(pageToken)) {
        break;
      }
    }
    return undefined;
  }

  /** The page size a paged read asks a node for. */
  private pageSizeFor(limit: number | undefined): number {
    return Math.min(Math.max(Math.trunc(limit ?? 25) || 1, 1), COUNT_PAGE_SIZE);
  }

  /** The next-page cursor, or nothing when the node's page was the last. */
  private cursorOf(page: { nextPageToken?: string }): { cursor?: string } {
    const next = page.nextPageToken;
    return next && !isTerminalPageToken(next) ? { cursor: next } : {};
  }

  /**
   * One reaction page on one cast, with the author resolved from the memo.
   *
   * Shared by the likes and the recasts read: both ask the same node route with
   * a different `reaction_type`, and both are refused in the same plain words
   * when the cast's author is not known to this reader yet.
   */
  private async reactionsOnCast({
    castHash,
    reactionType,
    limit,
    cursor,
  }: {
    castHash: string;
    reactionType: 'Like' | 'Recast';
    limit?: number;
    cursor?: string;
  }): Promise<NodeMessagesPage> {
    const author = castAuthorOf(castHash);
    if (author === undefined) {
      throw new NodeCannotAnswerError(
        'Your node addresses a cast by its author and its hash, and this page only has the hash. Open the cast from your feed or a profile and its reactions will load.',
      );
    }
    return await this.node.reactionsByCast({
      targetFid: author,
      targetHash: castHash,
      reactionType,
      pageSize: this.pageSizeFor(limit),
      ...(cursor === undefined ? {} : { pageToken: cursor }),
    });
  }

  /** The accounts behind a page of reaction messages, one read each. */
  private async reactorsOf(
    messages: NodeMessage[],
  ): Promise<Map<number, ApiUser>> {
    return await this.profilesOf([
      ...new Set(messages.map((message) => message.fid)),
    ]);
  }

  /** The accounts a page of follow edges points at, with the page's cursor. */
  private async usersOfLinks(
    page: NodeMessagesPage,
    accountFid: (message: NodeMessage) => number | undefined,
  ): Promise<{ users: ApiUser[]; cursor?: string }> {
    const profiles = await this.profilesOf([
      ...new Set(
        page.messages.flatMap((message) => {
          const fid = accountFid(message);
          return fid === undefined ? [] : [fid];
        }),
      ),
    ]);
    // The page's order is the node's order, and a row without a profile is
    // dropped rather than drawn with an invented name.
    const users = page.messages.flatMap((message) => {
      const fid = accountFid(message);
      const user = fid === undefined ? undefined : profiles.get(fid);
      return user === undefined ? [] : [user];
    });
    return { users, ...this.cursorOf(page) };
  }

  /** Read a set of accounts, once each, tolerating the ones that cannot be read. */
  private async profilesOf(fids: number[]): Promise<Map<number, ApiUser>> {
    return new Map(
      (
        await mapWithConcurrency(fids, RESOLVE_CONCURRENCY, async (fid) => {
          try {
            return [fid, await this.readUser(fid)] as const;
          } catch {
            return undefined;
          }
        })
      ).filter(
        (entry): entry is readonly [number, ApiUser] => entry !== undefined,
      ),
    );
  }

  // -------------------------------------------------- notifications, derived

  private seenKey(fid: number): string {
    return `${SEEN_STORAGE_PREFIX}:${fid}`;
  }

  /** Read the local watermark (ms) for a feed key. */
  readSeen(fid: number, feedKey: string): number {
    const store = seenStore();
    if (!store) {
      return 0;
    }
    try {
      const raw = store.getItem(this.seenKey(fid));
      if (!raw) {
        return 0;
      }
      const parsed = JSON.parse(raw) as Record<string, number>;
      return parsed[feedKey] ?? 0;
    } catch {
      return 0;
    }
  }

  /** Record that the account has now seen this feed. Local, and said so. */
  markSeen(fid: number, feedKey: string): void {
    const store = seenStore();
    if (!store) {
      return;
    }
    try {
      const raw = store.getItem(this.seenKey(fid));
      const parsed: Record<string, number> = raw
        ? (JSON.parse(raw) as Record<string, number>)
        : {};
      parsed[feedKey] = Date.now();
      store.setItem(this.seenKey(fid), JSON.stringify(parsed));
    } catch {
      // A full or unavailable localStorage must not break a read.
    }
  }

  private async myRecentCastHashes(fid: number, limit = 25): Promise<string[]> {
    try {
      const page = await this.node.castsByFid({
        fid,
        pageSize: Math.min(limit, 50),
        reverse: true,
      });
      const messages = page.messages.filter((message) => message.castAdd);
      this.rememberCasts(messages);
      return messages.map((message) => message.hash);
    } catch {
      return [];
    }
  }

  /**
   * Notifications derived from the node, grouped the way the tab view groups
   * them: mentions, replies, reactions and follows aimed at the signed-in FID.
   *
   * The hosted API also sends invites, wallet activity, streak updates, tips
   * and mini-app news; none of those are protocol messages, so they cannot be
   * derived here and are simply absent rather than faked.
   *
   * `previewLimit` is how many items each group carries. The tab draws three,
   * and a group's own page asks for the group itself
   * (`readNotificationGroup`) — same build, deeper list.
   */
  async readNotifications({
    fid,
    limit = 15,
    previewLimit = 3,
  }: {
    fid?: number;
    limit?: number;
    previewLimit?: number;
  } = {}): Promise<ApiNotificationGroup[]> {
    const accountFid = fid ?? this.requireFid();
    const myHashes = await this.myRecentCastHashes(accountFid);

    const [mentions, repliesByCast, reactionsByCast, follows] =
      await Promise.all([
        this.node
          .castsByMention({
            fid: accountFid,
            pageSize: Math.min(limit, 50),
            reverse: true,
          })
          .catch(() => ({ messages: [] as NodeMessage[] })),
        mapWithConcurrency(myHashes.slice(0, 10), RESOLVE_CONCURRENCY, (hash) =>
          this.node
            .castsByParent({
              fid: accountFid,
              hash,
              pageSize: 10,
              reverse: true,
            })
            .then((page) => page.messages.filter((message) => message.castAdd))
            .catch(() => [] as NodeMessage[]),
        ),
        mapWithConcurrency(
          myHashes.slice(0, 10),
          RESOLVE_CONCURRENCY,
          async (hash) => {
            const page = await this.node
              .reactionsByCast({
                targetFid: accountFid,
                targetHash: hash,
                reactionType: 'Like',
                pageSize: 10,
                reverse: true,
              })
              .catch(() => ({ messages: [] as NodeMessage[] }));
            return { hash, messages: page.messages };
          },
        ),
        this.node
          .linksByTargetFid({
            targetFid: accountFid,
            linkType: 'follow',
            pageSize: Math.min(limit, 50),
            reverse: true,
          })
          .catch(() => ({ messages: [] as NodeMessage[] })),
      ]);

    const groups: ApiNotificationGroup[] = [];

    const mentionMessages = mentions.messages.filter(
      (message) => message.castAdd,
    );
    if (mentionMessages.length > 0) {
      this.rememberCasts(mentionMessages);
      const items = await mapWithConcurrency(
        mentionMessages.slice(0, previewLimit),
        RESOLVE_CONCURRENCY,
        async (message) => {
          const cast = await this.buildCast({ message, withCounts: false });
          const actor = await this.readAuthor(message.fid);
          if (!cast) {
            return undefined;
          }
          return {
            type: 'cast-mention' as const,
            id: `mention:${message.hash}`,
            timestamp: message.timestampMs,
            actor,
            content: { cast },
          } satisfies ApiNotificationCastMention;
        },
      );

      groups.push({
        id: `mentions:${accountFid}`,
        type: 'cast-mention',
        latestTimestamp: mentionMessages[0]!.timestampMs,
        totalItemCount: mentionMessages.length,
        previewItems: items.filter((item) => item !== undefined),
        isUnread: mentionMessages.some(
          (message) =>
            message.timestampMs > this.readSeen(accountFid, 'notifications'),
        ),
      });
    }

    const replyMessages = repliesByCast
      .flat()
      .filter((message) => message.castAdd);
    if (replyMessages.length > 0) {
      this.rememberCasts(replyMessages);
      const items = await mapWithConcurrency(
        replyMessages.slice(0, previewLimit),
        RESOLVE_CONCURRENCY,
        async (message) => {
          const cast = await this.buildCast({ message, withCounts: false });
          const actor = await this.readAuthor(message.fid);
          if (!cast) {
            return undefined;
          }
          return {
            type: 'cast-reply' as const,
            id: `reply:${message.hash}`,
            timestamp: message.timestampMs,
            actor,
            content: { cast },
          } satisfies ApiNotificationCastReply;
        },
      );

      groups.push({
        id: `replies:${accountFid}`,
        type: 'cast-reply',
        latestTimestamp: replyMessages[0]!.timestampMs,
        totalItemCount: replyMessages.length,
        previewItems: items.filter((item) => item !== undefined),
        isUnread: replyMessages.some(
          (message) =>
            message.timestampMs > this.readSeen(accountFid, 'notifications'),
        ),
      });
    }

    const reactionMessages = reactionsByCast
      .map((entry) => ({
        hash: entry.hash,
        messages: entry.messages.filter((m) => m.reaction),
      }))
      .filter((entry) => entry.messages.length > 0);
    if (reactionMessages.length > 0) {
      const items: ApiNotificationCastReaction[] = [];
      for (const entry of reactionMessages.slice(0, previewLimit)) {
        const target = castAuthorOf(entry.hash);
        const targetMessage =
          target !== undefined
            ? await this.castById(target, entry.hash)
            : undefined;
        if (!targetMessage?.castAdd) {
          continue;
        }
        const cast = await this.buildCast({
          message: targetMessage,
          withCounts: false,
        });
        const reactionMessage = entry.messages[0]!;
        const actor = await this.readAuthor(reactionMessage.fid);
        if (!cast) {
          continue;
        }
        const reaction: ApiCastReaction = {
          type: 'like',
          hash: reactionMessage.hash,
          reactor: actor,
          timestamp: reactionMessage.timestampMs,
          castHash: entry.hash,
        };
        items.push({
          type: 'cast-reaction',
          id: `reaction:${reactionMessage.hash}`,
          timestamp: reactionMessage.timestampMs,
          actor,
          content: { cast, reaction },
        });
      }

      if (items.length > 0) {
        groups.push({
          id: `reactions:${accountFid}`,
          type: 'cast-reaction',
          latestTimestamp: Math.max(...items.map((item) => item.timestamp)),
          totalItemCount: reactionMessages.reduce(
            (sum, entry) => sum + entry.messages.length,
            0,
          ),
          previewItems: items,
          isUnread: items.some(
            (item) =>
              item.timestamp > this.readSeen(accountFid, 'notifications'),
          ),
        });
      }
    }

    const followMessages = follows.messages.filter((message) => message.link);
    if (followMessages.length > 0) {
      const items = await mapWithConcurrency(
        followMessages.slice(0, previewLimit),
        RESOLVE_CONCURRENCY,
        async (message) => {
          const actor = await this.readAuthor(message.fid);
          return {
            type: 'follow' as const,
            id: `follow:${message.fid}`,
            timestamp: message.timestampMs,
            actor,
          } satisfies ApiNotificationFollow;
        },
      );

      groups.push({
        id: `follows:${accountFid}`,
        type: 'follow',
        latestTimestamp: followMessages[0]!.timestampMs,
        totalItemCount: followMessages.length,
        previewItems: items,
        isUnread: followMessages.some(
          (message) =>
            message.timestampMs > this.readSeen(accountFid, 'notifications'),
        ),
      });
    }

    return groups.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
  }

  /**
   * `GET /v2/notification-group`: the items of one group the notifications tab
   * drew.
   *
   * WHY THIS EXISTS: the groups this client shows ARE the node's own messages,
   * and each carries the id this reader made for it (`mentions:<fid>`,
   * `replies:<fid>`, `reactions:<fid>`, `follows:<fid>`) — so a group a reader
   * opened is a group this reader can fill. The tab asks for three-item
   * previews; a group's own page asks for the group, so the same build runs with
   * a deeper preview limit rather than a second implementation.
   *
   * The kinds a node holds nothing for — frame and mini-app notifications,
   * channel role invites — are refused in words that name the missing service,
   * never as an empty list that would read as "there is nothing here".
   */
  async readNotificationGroup({
    groupId,
    limit = 25,
  }: {
    groupId: string;
    limit?: number;
  }): Promise<ApiNotificationGroup['previewItems']> {
    if (groupId.length === 0) {
      throw new NodeCannotAnswerError(
        'This read needs a notification group id: open a group from your notifications and its items load from your node.',
      );
    }
    const fid = this.requireFid();
    const groups = await this.readNotifications({
      fid,
      limit: Math.max(limit, 25),
      previewLimit: limit,
    });
    const group = groups.find((candidate) => candidate.id === groupId);
    if (group === undefined) {
      throw new NodeCannotAnswerError(
        `Your node has no group “${groupId}” to open. It carries mentions, replies, likes and follows; the other kinds of notification group come from Warpcast’s own notification service, which a read node does not hold.`,
      );
    }
    return group.previewItems;
  }

  /**
   * `GET /v2/unseen`, derived. `notificationTabs` names the one tab this client
   * serves, and `inboxCount` stays zero because direct messages are not on the
   * node's read API — the DM surface says so rather than showing an empty inbox.
   */
  async readUnseen(): Promise<ApiGetUnseen200Response['result']> {
    const fid = this.requireFid();
    const seenAt = this.readSeen(fid, 'notifications');

    const [mentions, follows] = await Promise.all([
      this.node
        .castsByMention({ fid, pageSize: 50, reverse: true })
        .catch(() => ({
          messages: [] as NodeMessage[],
        })),
      this.node
        .linksByTargetFid({
          targetFid: fid,
          linkType: 'follow',
          pageSize: 50,
          reverse: true,
        })
        .catch(() => ({ messages: [] as NodeMessage[] })),
    ]);

    const unreadMentions = mentions.messages.filter(
      (message) => message.timestampMs > seenAt,
    ).length;
    const unreadFollows = follows.messages.filter(
      (message) => message.timestampMs > seenAt,
    ).length;

    return {
      notificationsCount: unreadMentions + unreadFollows,
      notificationTabs:
        unreadMentions + unreadFollows > 0
          ? [{ tab: 'default', unseenCount: unreadMentions + unreadFollows }]
          : [],
      inboxCount: 0,
      channelFeeds: [],
      warpTransactionCount: 0,
      articlesCount: 0,
    };
  }

  /** Forget the per-session caches (used by tests and on sign-out). */
  clearCaches(): void {
    this.userCache.clear();
    this.userPromiseCache.clear();
    this.countCache.clear();
    this.castCache.clear();
    this.authorCache.clear();
    this.authorPromiseCache.clear();
    this.viewerReactionCache.clear();
    this.viewerReactionPromiseCache.clear();
    // A sign-out must not carry this account's writes into the next one: the
    // overlay is session state, and the log behind it is read again from the
    // node anyway.
    this.writtenReactions.clear();
    forgetCastAuthors();
  }
}
