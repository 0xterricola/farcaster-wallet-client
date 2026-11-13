/**
 * The two optional `CastAddBody` fields that make a cast part of an article.
 *
 * FIP "Cast Format and Chained Casts" (farcasterxyz/protocol discussion 278;
 * consensus in farcasterxyz/snapchain#1074, shipped in v0.16.0):
 *
 *   - `format_version = 9`: how to read `text`. 0 (absent) = plain text, 1 =
 *     article Markdown.
 *   - `chain = 10`: `{ root, index, count }`. Index 0 is the first cast and has
 *     no root; every later cast names the first cast as its root, and each part
 *     replies to the one before it, so a client that doesn't know articles sees
 *     a thread.
 *
 * These are protocol fields, not a quilcast invention. This module is the reader
 * side only, and it is deliberately strict: nodes enforce the chain rules only
 * once the feature is active, so a reader checks them again before believing a
 * cast. A chain that breaks one is dropped, and the cast reads as an ordinary
 * one.
 */

import type {
  NodeCastAddBody,
  NodeCastChain,
  NodeCastId,
  NodeCastMessage,
  NodeMessage,
} from './types';

/** `format_version` 1: the text is article Markdown. */
export const ARTICLE_FORMAT_VERSION = 1;

/** MAX_CHAIN_PARTS: a chain has at most 100 casts. */
export const MAX_ARTICLE_PARTS = 100;

/** Proto uint64 as JSON may be a decimal string; anything else is not a uint. */
const asUint = (value: unknown): number | undefined => {
  const numeric =
    typeof value === 'string' && /^\d{1,15}$/.test(value)
      ? Number(value)
      : value;
  return typeof numeric === 'number' &&
    Number.isSafeInteger(numeric) &&
    numeric >= 0
    ? numeric
    : undefined;
};

/**
 * `chain` when it obeys the FIP's reader rules, `undefined` when it does not.
 *
 * The rules (protocol discussion 278, section 5):
 *   - at most 100 casts, an index below 100, and an index below `count` when
 *     `count` is set;
 *   - index 0 carries no root;
 *   - index > 0 carries a root, and the root's author is this cast's author.
 *
 * protobuf JSON leaves out zeros, so a missing `index` means 0 and a missing
 * `count` means 0 ("the chain still says nothing about its length").
 */
export const decodeCastChain = (
  value: unknown,
  authorFid: number,
): NodeCastChain | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const json = value as Record<string, unknown>;
  const index =
    json.index === null || json.index === undefined ? 0 : asUint(json.index);
  const count =
    json.count === null || json.count === undefined ? 0 : asUint(json.count);
  if (
    index === undefined ||
    count === undefined ||
    count > MAX_ARTICLE_PARTS ||
    index >= MAX_ARTICLE_PARTS ||
    (count > 0 && index >= count)
  ) {
    return undefined;
  }
  if (index === 0) {
    return json.root ? undefined : { index, count };
  }
  const root = json.root as
    | { fid?: unknown; hash?: unknown }
    | null
    | undefined;
  if (!root || typeof root !== 'object') {
    return undefined;
  }
  const rootFid = asUint(root.fid);
  if (rootFid !== authorFid || typeof root.hash !== 'string' || !root.hash) {
    return undefined;
  }
  return {
    root: { fid: rootFid, hash: root.hash } satisfies NodeCastId,
    index,
    count,
  };
};

/** The first cast of an article: article Markdown, index 0. */
export const isArticleRoot = (
  cast: NodeMessage | undefined,
): cast is NodeCastMessage & {
  castAdd: NodeCastAddBody & { chain: NodeCastChain };
} => {
  const body = cast?.castAdd;
  return (
    !!body &&
    body.formatVersion === ARTICLE_FORMAT_VERSION &&
    body.chain?.index === 0
  );
};

/**
 * A later cast of some chain. It does not have to declare article Markdown
 * itself (the FIP only says it SHOULD), which is why only its root can say
 * whether the chain is an article: see `classifyArticleCast`.
 */
export const isArticlePart = (
  cast: NodeMessage | undefined,
): cast is NodeCastMessage & {
  castAdd: NodeCastAddBody & { chain: NodeCastChain & { root: NodeCastId } };
} => {
  const body = cast?.castAdd;
  return !!body && !!body.chain?.root && body.chain.index > 0;
};
