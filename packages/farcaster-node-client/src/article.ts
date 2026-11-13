/**
 * Read a Farcaster Article: a chain of casts by one author, read as one piece.
 *
 * The protocol half is in `castFormat.ts` (the two `CastAddBody` fields and the
 * FIP's reader rules); this module is what a reader does with them:
 *
 *   - `assembleArticle` applies the FIP's reading rules to a bag of the author's
 *     casts and says which part is which, and whether the chain is complete;
 *   - `fetchArticleChain` reads the chain in one pass — the author's casts from
 *     the root's timestamp on, paged forward, capped, stopping when complete;
 *   - `classifyArticleCast` answers "is this cast part of an article?" by asking
 *     about its root once, and remembering the answer (`partNow`/`classifyPart`
 *     in backmeupplz/quilcast's `src/article.ts`, MIT).
 *
 * A later part does not have to declare article Markdown itself (the FIP only
 * says it SHOULD), so `classifyArticleCast` is what tells a plain reply apart
 * from a part of an article. Nothing here writes: Fiddy mobile v1 cannot sign.
 */

import {
  ARTICLE_FORMAT_VERSION,
  isArticlePart,
  isArticleRoot,
  MAX_ARTICLE_PARTS,
} from './castFormat';
import type { SnapchainNodeClient } from './http';
import type {
  NodeCastId,
  NodeCastMessage,
  NodeMessage,
  NodeMessagesPage,
} from './types';
import { isTerminalPageToken } from './wire';

/** Upstream reads at most five pages of 100 when it looks for a chain. */
export const MAX_ARTICLE_PAGES = 5;

export interface ArticleChain {
  /** The chain's first cast. */
  root: NodeCastMessage;
  /**
   * `parts[i]` is the cast at index i. A missing index is `undefined` — the
   * chain is incomplete, and a reader says so rather than inventing a part.
   */
  parts: (NodeCastMessage | undefined)[];
  /** The count the chain declares; 0 where the author's client left it unset. */
  count: number;
  /** Every index below the declared count is present. */
  complete: boolean;
  /** The parts that did arrive, in order: what a reader can show today. */
  loaded: NodeCastMessage[];
  /** Set when a later page failed, so a reader shows the parts it has. */
  error?: string;
}

const castIdOf = (cast: NodeCastMessage): NodeCastId => ({
  fid: cast.fid,
  hash: cast.hash,
});

/** Whether `a` replaces `b` at the same index: later timestamp, then greater hash. */
const later = (a: NodeCastMessage, b: NodeCastMessage): boolean =>
  a.timestamp > b.timestamp ||
  (a.timestamp === b.timestamp &&
    a.hash.replace(/^0x/i, '').toLowerCase() >
      b.hash.replace(/^0x/i, '').toLowerCase());

/**
 * The FIP's reading rules over `casts` (the author's casts from the root's
 * timestamp on): the root at index 0, then at each index the latest cast by the
 * same author whose root it is and whose count is the root's.
 *
 * Two parts can share a second, which is why a duplicate index is resolved by
 * timestamp *and then* hash rather than by arrival order.
 */
export const assembleArticle = (
  root: NodeCastMessage,
  casts: readonly NodeCastMessage[],
): ArticleChain => {
  const rootId = castIdOf(root);
  const count = root.castAdd.chain?.count ?? 0;
  const best = new Map<number, NodeCastMessage>();

  for (const cast of casts) {
    const chain = cast.castAdd.chain;
    if (
      !chain?.root ||
      cast.fid !== root.fid ||
      chain.root.fid !== rootId.fid ||
      chain.root.hash.toLowerCase() !== rootId.hash.toLowerCase() ||
      chain.count !== count
    ) {
      continue;
    }
    if (count > 0 && chain.index >= count) {
      continue;
    }
    const previous = best.get(chain.index);
    if (!previous || later(cast, previous)) {
      best.set(chain.index, cast);
    }
  }

  const length =
    count > 0 ? count : Math.max(0, ...Array.from(best.keys())) + 1;
  const parts: (NodeCastMessage | undefined)[] = [
    root,
    ...Array.from({ length: Math.max(0, length - 1) }, (_, i) =>
      best.get(i + 1),
    ),
  ];
  return {
    root,
    parts,
    count,
    complete: parts.every(Boolean),
    loaded: parts.filter((part): part is NodeCastMessage => !!part),
  };
};

export interface FetchArticleChainOptions {
  node: SnapchainNodeClient;
  /** The chain's first cast, as a read returned it. */
  root: NodeCastMessage;
  /** Pages of 100 to read at most (upstream stops at five). */
  pages?: number;
}

/**
 * The whole article that starts at `root`, read in one pass.
 *
 * One pass, not one read per part: the author's casts from the root's
 * timestamp on, paged forward, capped, stopping as soon as every declared index
 * has arrived. The same node answers every page, so a mid-read failover cannot
 * mix two indexes — there is no failover here at all.
 *
 * A failure after the first page does not throw: it returns the parts that did
 * arrive with `error` set, so a reader can show an incomplete article honestly
 * instead of an empty screen. A failure on the first page throws.
 */
export const fetchArticleChain = async ({
  node,
  root,
  pages = MAX_ARTICLE_PAGES,
}: FetchArticleChainOptions): Promise<ArticleChain> => {
  const casts: NodeCastMessage[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let failure: string | undefined;

  for (let page = 0; page < Math.max(1, pages); page += 1) {
    let answer: NodeMessagesPage;
    try {
      answer = await node.castsByFid({
        fid: root.fid,
        startTimestamp: root.timestamp,
        pageSize: 100,
        pageToken,
        // The node pages ascending by default; say so, because a chain read
        // only makes sense forwards from the root.
        reverse: false,
      });
    } catch (error) {
      if (page === 0) {
        throw error;
      }
      failure = error instanceof Error ? error.message : String(error);
      break;
    }

    for (const message of answer.messages) {
      if (message.castAdd) {
        casts.push(message as NodeCastMessage);
      }
    }

    const assembled = assembleArticle(root, casts);
    if (assembled.complete) {
      return assembled;
    }

    pageToken = answer.nextPageToken;
    // The terminal token `[null,null]` replays the first page on a live node
    // (see `isTerminalPageToken`), and a wedged node can hand back the same
    // cursor twice. Both end the read.
    if (
      !pageToken ||
      isTerminalPageToken(pageToken) ||
      seenTokens.has(pageToken)
    ) {
      break;
    }
    seenTokens.add(pageToken);
  }

  const assembled = assembleArticle(root, casts);
  return failure ? { ...assembled, error: failure } : assembled;
};

/** What a cast says by itself, before its root has been asked. */
export type ArticleCastKind = 'root' | 'part' | 'plain' | 'unknown';

const LOOKUPS = 2000;

/**
 * A classifier for one session: it asks the node about a chain's root once and
 * remembers the answer.
 *
 * Only a node that carries the fields can say a cast is an article. A provider
 * that omits them (Neynar's snapchain-api and `api.farcaster.xyz` are pinned at
 * a v0.14.x node, which predates the FIP) returns casts with no `chain` at all,
 * and absence there means *unknown*, never *not an article* — which is why a
 * failed root lookup is `unknown` and not `plain`.
 */
export const createArticleClassifier = (node: SnapchainNodeClient) => {
  const roots = new Map<string, Promise<boolean>>();

  const isArticleRootId = async (root: NodeCastId): Promise<boolean> => {
    const key = `${root.fid}:${root.hash.toLowerCase()}`;
    const cached = roots.get(key);
    if (cached) {
      return cached;
    }
    const lookup = node
      .castById({ fid: root.fid, hash: root.hash })
      .then((message) => isArticleRoot(message as NodeCastMessage));
    if (roots.size >= LOOKUPS) {
      const oldest = roots.keys().next().value;
      if (oldest) {
        roots.delete(oldest);
      }
    }
    roots.set(key, lookup);
    // A lookup that failed is not an answer: let the next ask try again.
    lookup.catch(() => {
      if (roots.get(key) === lookup) {
        roots.delete(key);
      }
    });
    return lookup;
  };

  return async (cast: NodeMessage | undefined): Promise<ArticleCastKind> => {
    if (isArticleRoot(cast)) {
      return 'root';
    }
    if (!isArticlePart(cast)) {
      // No chain at all. On a node that carries the fields this is an ordinary
      // cast — but a provider pinned before the FIP (Neynar's snapchain-api,
      // api.farcaster.xyz at v0.14.x) omits them from *every* cast, including
      // an article's parts. Those two look identical from here, so the honest
      // answer is "unknown", never "not an article".
      return 'unknown';
    }
    try {
      return (await isArticleRootId(cast.castAdd.chain.root))
        ? 'part'
        : 'plain';
    } catch {
      // The root could not be read: the question stays open.
      return 'unknown';
    }
  };
};

/** The title: the first line of the chain's first cast. */
export const articleTitle = (root: NodeCastMessage): string => {
  const text = root.castAdd.text ?? '';
  const newline = text.indexOf('\n');
  return (newline < 0 ? text : text.slice(0, newline)).trim();
};

/** The body a part carries: everything after the title, for the root. */
export const articleOpening = (root: NodeCastMessage): string => {
  const text = root.castAdd.text ?? '';
  const newline = text.indexOf('\n');
  return newline < 0 ? '' : text.slice(newline + 1).replace(/^\n/, '');
};

/** The cover: the first cast's single URL embed, and nothing else. */
export const articleCover = (root: NodeCastMessage): string | undefined => {
  const embeds = root.castAdd.embeds ?? [];
  return embeds.length === 1 && 'url' in embeds[0] ? embeds[0].url : undefined;
};

/** How many parts a chain claims, for the "Article · N parts" affordance. */
export const articlePartCount = (root: NodeCastMessage): number =>
  Math.min(root.castAdd.chain?.count ?? 0, MAX_ARTICLE_PARTS);

/**
 * Whether a feed row is a later part of an article rather than something to
 * show on its own: parts after index 0 must not each become a row.
 */
export const isLaterArticlePart = (cast: NodeMessage | undefined): boolean => {
  const chain = cast?.castAdd?.chain;
  return !!chain && chain.index > 0;
};

/** Re-exported so a caller can build an article from its own reads. */
export { ARTICLE_FORMAT_VERSION, isArticlePart, isArticleRoot };
