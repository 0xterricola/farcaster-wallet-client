/**
 * Reading a Farcaster Article from a chain of casts.
 *
 * The fixture is a real article read from a live Snapchain read node (see
 * `fixtures/articleChain.json` and the note inside it), not a hand-built string:
 * the field names, the omitted zeros and the part-to-root shape are the node's,
 * not this repo's guess at them. Everything else here is the FIP's reader rules,
 * which a node only enforces once the feature is active.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  articleCover,
  articleOpening,
  articlePartCount,
  articleTitle,
  assembleArticle,
  createArticleClassifier,
  fetchArticleChain,
  isLaterArticlePart,
} from '../article';
import type { SnapchainNodeClient } from '../http';
import type { NodeCastMessage, NodeMessagesPage } from '../types';
import { decodeNodeMessage } from '../wire';
import fixture from './fixtures/articleChain.json';

type RawCast = Record<string, unknown>;

const rawCast = (options: {
  fid?: number;
  hash?: string;
  timestamp?: number;
  text?: string;
  formatVersion?: number;
  chain?: Record<string, unknown> | null;
  embeds?: unknown[];
}): RawCast => ({
  data: {
    type: 'MESSAGE_TYPE_CAST_ADD',
    fid: options.fid ?? 1,
    timestamp: options.timestamp ?? 100,
    network: 'FARCASTER_NETWORK_MAINNET',
    castAddBody: {
      text: options.text ?? 'A part',
      type: 'CAST',
      embeds: options.embeds ?? [],
      embedsDeprecated: [],
      mentions: [],
      mentionsPositions: [],
      ...(options.formatVersion === undefined
        ? {}
        : { formatVersion: options.formatVersion }),
      ...(options.chain === undefined ? {} : { chain: options.chain }),
    },
  },
  hash: options.hash ?? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: '',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: '0x0',
});

const decode = (raw: RawCast): NodeCastMessage =>
  decodeNodeMessage(raw) as NodeCastMessage;

const realCasts = (): NodeCastMessage[] =>
  (fixture.castsByFid as unknown as RawCast[]).map(decode);

describe('decode: the two article fields', () => {
  it('reads format_version and chain off a real node message', () => {
    const [root, part] = realCasts();

    expect(root.castAdd.formatVersion).toBe(1);
    expect(root.castAdd.chain).toEqual({ index: 0, count: 2 });
    expect(part.castAdd.chain).toEqual({
      root: { fid: fixture.rootFid, hash: fixture.rootHash },
      index: 1,
      count: 2,
    });
  });

  it('reads a cast from before the FIP as a plain cast, not an error', () => {
    // An older node simply leaves both fields out. Absence is "plain text".
    const cast = decode(rawCast({ text: 'gm' }));

    expect(cast.castAdd.formatVersion).toBe(0);
    expect(cast.castAdd.chain).toBeUndefined();
    expect(cast.castAdd.text).toBe('gm');
  });

  it('treats a missing index as 0, because protobuf JSON omits zeros', () => {
    const root = decode(rawCast({ formatVersion: 1, chain: { count: 3 } }));

    expect(root.castAdd.chain).toEqual({ index: 0, count: 3 });
  });
});

describe('the FIP’s reader rules', () => {
  const author = 7;
  const rootId = { fid: author, hash: '0x' + '1'.repeat(40) };
  const chainOf = (chain: Record<string, unknown>) =>
    decode(rawCast({ fid: author, formatVersion: 1, chain })).castAdd.chain;

  it('drops a first cast that carries a root', () => {
    expect(chainOf({ root: rootId, index: 0, count: 2 })).toBeUndefined();
  });

  it('drops a later cast with no root', () => {
    expect(chainOf({ index: 1, count: 2 })).toBeUndefined();
  });

  it('drops an index at or past the declared count', () => {
    expect(chainOf({ root: rootId, index: 2, count: 2 })).toBeUndefined();
    expect(chainOf({ root: rootId, index: 5, count: 2 })).toBeUndefined();
  });

  it('drops a chain longer than 100 casts, or with an index past 99', () => {
    expect(chainOf({ index: 0, count: 101 })).toBeUndefined();
    expect(chainOf({ root: rootId, index: 100, count: 101 })).toBeUndefined();
  });

  it('drops a root authored by somebody else', () => {
    expect(
      chainOf({
        root: { fid: author + 1, hash: rootId.hash },
        index: 1,
        count: 2,
      }),
    ).toBeUndefined();
  });

  it('keeps a chain that says nothing about its length (count 0)', () => {
    expect(chainOf({ index: 0 })).toEqual({ index: 0, count: 0 });
    expect(chainOf({ root: rootId, index: 3 })).toEqual({
      root: rootId,
      index: 3,
      count: 0,
    });
  });
});

describe('assembleArticle', () => {
  it('reads the real chain as two parts, complete', () => {
    const [root, part] = realCasts();
    const article = assembleArticle(root, [part, root]);

    expect(article.count).toBe(2);
    expect(article.complete).toBe(true);
    expect(article.loaded).toHaveLength(2);
    expect(article.parts[1]?.hash).toBe(part.hash);
  });

  it('reports an incomplete chain instead of inventing the missing part', () => {
    const [root] = realCasts();
    // The author's casts came back, but index 1 did not: the root says two.
    const article = assembleArticle(root, []);

    expect(article.complete).toBe(false);
    expect(article.parts).toHaveLength(2);
    expect(article.parts[1]).toBeUndefined();
    expect(article.loaded).toHaveLength(1);
  });

  it('resolves a duplicate index by later timestamp, then greater hash', () => {
    const [root] = realCasts();
    const part = (timestamp: number, hash: string) =>
      decode(
        rawCast({
          fid: fixture.rootFid,
          timestamp,
          hash,
          formatVersion: 1,
          chain: {
            root: { fid: fixture.rootFid, hash: fixture.rootHash },
            index: 1,
            count: 2,
          },
        }),
      );

    const older = part(10, '0x' + 'f'.repeat(40));
    const newer = part(11, '0x' + '0'.repeat(40));
    // Same second: the greater hash wins, which is the protocol's own order.
    const sameSecondHigher = part(11, '0x' + '1'.repeat(40));

    expect(assembleArticle(root, [newer, older]).parts[1]?.hash).toBe(
      newer.hash,
    );
    expect(
      assembleArticle(root, [newer, sameSecondHigher]).parts[1]?.hash,
    ).toBe(sameSecondHigher.hash);
    expect(
      assembleArticle(root, [sameSecondHigher, newer]).parts[1]?.hash,
    ).toBe(sameSecondHigher.hash);
  });

  it('ignores casts whose declared count differs from the root’s', () => {
    const [root] = realCasts();
    const stray = decode(
      rawCast({
        fid: fixture.rootFid,
        formatVersion: 1,
        chain: {
          root: { fid: fixture.rootFid, hash: fixture.rootHash },
          index: 1,
          count: 3,
        },
      }),
    );

    expect(assembleArticle(root, [stray]).complete).toBe(false);
  });

  it('marks a growing chain (count 0) complete when every index it names is present', () => {
    const root = decode(rawCast({ formatVersion: 1, chain: { index: 0 } }));
    const first = decode(
      rawCast({
        fid: 1,
        timestamp: 101,
        formatVersion: 1,
        chain: { root: { fid: 1, hash: root.hash }, index: 1 },
      }),
    );

    const article = assembleArticle(root, [first]);
    expect(article.count).toBe(0);
    expect(article.complete).toBe(true);
    expect(article.parts).toHaveLength(2);
  });
});

describe('fetchArticleChain', () => {
  const [root, part] = realCasts();

  type ReadOptions = {
    fid?: number;
    startTimestamp?: number;
    pageSize?: number;
    pageToken?: string;
    reverse?: boolean;
  };

  const stub = (pages: NodeMessagesPage[]) => {
    const castsByFid = vi.fn(
      async (_options: ReadOptions = {}) => pages.shift() ?? { messages: [] },
    );
    return {
      node: { castsByFid } as unknown as SnapchainNodeClient,
      castsByFid,
    };
  };

  it('reads the chain in one pass, starting at the root’s timestamp', async () => {
    const { node, castsByFid } = stub([
      {
        messages: (fixture.castsByFid as unknown as RawCast[]).map((raw) =>
          decodeNodeMessage(raw),
        ),
      },
    ]);

    const article = await fetchArticleChain({ node, root });

    expect(article.complete).toBe(true);
    expect(article.loaded.map((cast) => cast.hash)).toEqual([
      root.hash,
      part.hash,
    ]);
    expect(castsByFid).toHaveBeenCalledTimes(1);
    expect(castsByFid).toHaveBeenCalledWith({
      fid: fixture.rootFid,
      startTimestamp: fixture.rootTimestamp,
      pageSize: 100,
      pageToken: undefined,
      reverse: false,
    });
  });

  it('asks for the next page when the first one does not finish the chain', async () => {
    const { node, castsByFid } = stub([
      {
        messages: [decodeNodeMessage(fixture.castsByFid[0])],
        nextPageToken: 'AAAA',
      },
      { messages: [decodeNodeMessage(fixture.castsByFid[1])] },
    ]);

    const article = await fetchArticleChain({ node, root });

    expect(article.complete).toBe(true);
    expect(castsByFid).toHaveBeenCalledTimes(2);
    expect(castsByFid.mock.calls[1][0]).toMatchObject({ pageToken: 'AAAA' });
  });

  it('returns the parts it has, with the error, when a later page fails', async () => {
    const castsByFid = vi
      .fn<(options: ReadOptions) => Promise<NodeMessagesPage>>()
      .mockResolvedValueOnce({
        messages: [decodeNodeMessage(fixture.castsByFid[0])],
        nextPageToken: 'AAAA',
      })
      .mockRejectedValueOnce(new Error('node went away'));
    const node = { castsByFid } as unknown as SnapchainNodeClient;

    const article = await fetchArticleChain({ node, root });

    expect(article.complete).toBe(false);
    expect(article.loaded).toHaveLength(1);
    expect(article.error).toContain('node went away');
  });

  it('throws when the first page fails, because nothing is known', async () => {
    const node = {
      castsByFid: vi.fn().mockRejectedValue(new Error('unreachable')),
    } as unknown as SnapchainNodeClient;

    await expect(fetchArticleChain({ node, root })).rejects.toThrow(
      'unreachable',
    );
  });

  it('stops at its page cap rather than walking the author’s whole history', async () => {
    // A cursor the node would actually send: base64, and not the terminal
    // `[null,null]` token (which `isTerminalPageToken` reads as the end).
    const castsByFid = vi.fn(async (options: ReadOptions) => ({
      messages: [decodeNodeMessage(fixture.castsByFid[0])],
      nextPageToken: options.pageToken === 'AAAA' ? 'AAAB' : 'AAAA',
    }));
    const node = { castsByFid } as unknown as SnapchainNodeClient;

    await fetchArticleChain({ node, root, pages: 3 });

    expect(castsByFid).toHaveBeenCalledTimes(3);
  });
});

describe('classifyArticleCast', () => {
  const [root, part] = realCasts();

  it('knows the first cast of an article by what it says itself', async () => {
    const node = { castById: vi.fn() } as unknown as SnapchainNodeClient;
    const classify = createArticleClassifier(node);

    expect(await classify(root)).toBe('root');
    expect(node.castById).not.toHaveBeenCalled();
  });

  it('says unknown for a cast with no chain, without asking the node', async () => {
    const node = { castById: vi.fn() } as unknown as SnapchainNodeClient;
    const classify = createArticleClassifier(node);

    // Plain casts on a new node and every cast on an old provider look the
    // same here, so the classifier refuses to call either one "not an article".
    expect(await classify(decode(rawCast({ text: 'a reply' })))).toBe(
      'unknown',
    );
    expect(node.castById).not.toHaveBeenCalled();
  });

  it('yields unknown, not plain, for a provider that omits the fields', async () => {
    // MEASURED shape of a v0.14.x provider (Neynar's snapchain-api,
    // api.farcaster.xyz): the same article part, with both fields dropped.
    const partFromOldProvider = decode(
      rawCast({ fid: fixture.rootFid, text: 'the second half of an article' }),
    );
    expect(partFromOldProvider.castAdd.chain).toBeUndefined();

    const classify = createArticleClassifier({
      castById: vi.fn(),
    } as unknown as SnapchainNodeClient);

    expect(await classify(partFromOldProvider)).toBe('unknown');
  });

  it('asks about a part’s root once, and remembers the answer', async () => {
    const castById = vi.fn(async () => decodeNodeMessage(fixture.castById));
    const classify = createArticleClassifier({
      castById,
    } as unknown as SnapchainNodeClient);

    expect(await classify(part)).toBe('part');
    expect(await classify(part)).toBe('part');
    expect(castById).toHaveBeenCalledTimes(1);
    expect(castById).toHaveBeenCalledWith({
      fid: fixture.rootFid,
      hash: fixture.rootHash,
    });
  });

  it('calls a part of a chain that is not an article plain', async () => {
    const plainRoot = decode(rawCast({ fid: 1, text: 'not an article' }));
    const classify = createArticleClassifier({
      castById: vi.fn(async () => plainRoot),
    } as unknown as SnapchainNodeClient);

    expect(await classify(part)).toBe('plain');
  });

  it('says unknown, never plain, when the root cannot be read', async () => {
    // A provider that predates the FIP omits the fields, so absence is not an
    // answer: a lookup that fails leaves the question open.
    const classify = createArticleClassifier({
      castById: vi
        .fn()
        .mockRejectedValue(new Error('provider has no such read')),
    } as unknown as SnapchainNodeClient);

    expect(await classify(part)).toBe('unknown');
  });
});

describe('what a reader shows', () => {
  const [root] = realCasts();

  it('takes the title from the first line of the first cast', () => {
    expect(articleTitle(root)).toBe('Introducing Farcaster Articles!');
    expect(articleOpening(root).startsWith('## The Basics')).toBe(true);
  });

  it('takes the cover from the first cast’s single URL embed', () => {
    expect(articleCover(root)).toBe(
      'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/6ba9fa33-3176-4dd6-2125-35136071dc00/original',
    );
  });

  it('does not call a multi-embed cast’s first embed a cover', () => {
    const [cast] = realCasts();
    const twoEmbeds = {
      ...cast,
      castAdd: {
        ...cast.castAdd,
        embeds: [
          { url: 'https://example.com/a.png' },
          { url: 'https://example.com/b.png' },
        ],
      },
    };
    expect(articleCover(twoEmbeds)).toBeUndefined();
  });

  it('counts the declared parts, and marks later parts as feed-suppressed', () => {
    const [rootCast, part] = realCasts();
    expect(articlePartCount(rootCast)).toBe(2);
    expect(isLaterArticlePart(rootCast)).toBe(false);
    expect(isLaterArticlePart(part)).toBe(true);
    expect(isLaterArticlePart(decode(rawCast({ text: 'plain' })))).toBe(false);
  });
});
