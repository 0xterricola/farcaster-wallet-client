/**
 * What the viewer's own reaction set must do when THIS SESSION writes one: draw
 * it, inside the minute the set is reused for.
 *
 * THE BUG THESE TESTS WERE WRITTEN AGAINST (t_4c990a3b, live at release 2b620c3)
 *
 * `viewerReactionHashes` memoises the viewer's whole like/recast log for 60 s
 * (`VIEWER_REACTION_CACHE_MS`) because reading it costs 1.4–5.5 s a page. Nothing
 * invalidated it, and the comment above it claimed something did — the fork's
 * like hooks (`packages/farcaster-client-hooks/…/useCreateCastLike.ts`) paint the
 * heart optimistically and call the API; they run in another package and clear no
 * query key this reader answers. So: like a cast in the feed, open its
 * conversation inside the minute, and `viewerContext.reacted` was rebuilt from
 * the pre-like set — the heart came back un-liked while the like itself had
 * landed. Self-healed after 60 s, which is why it needed a test rather than a
 * pair of eyes.
 *
 * WHAT IS CHECKED, AND HOW
 *
 * The reader is driven directly, the way `feedPageReads.test.ts` does it: the
 * node is a fake (`fakeNodeFetch`'s recorded pages for every read, plus the
 * viewer's own log and the write's read-back), and the like goes through the real
 * write path — `createNodeBackedFetch` signs it with a signer key, the fake node
 * merges it, and the writer only says it landed once the node's own state shows
 * it. Nothing here is invented: the cast is the recorded fixture cast, and the
 * message the client signs is decoded with the protocol library it signed with.
 *
 * Three things are pinned:
 *   1. a like written now is drawn by the next thread read, inside the window;
 *   2. an undo written now is drawn too — the mirror of the same bug;
 *   3. the viewer's own log is STILL read once per page read, not once per write
 *      (the cache the fix must not pay for), and a write that did not land
 *      changes nothing at all.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  bytesToHex,
  decodeMessageBytes,
  type FetchLike,
  messageTypeName,
  reactionTypeName,
  SnapchainNodeClient,
} from 'farcaster-node-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { createNodeBackedFetch, NodeBackedReads } from '~/snapchain/nodeApi';
import {
  createEmbedCardResolver,
  type EmbedCardResolver,
} from '~/snapchain/nodeApi/embedCards';
import { rememberCastAuthor } from '~/snapchain/nodeApi/reads';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch, TERMINAL_PAGE_TOKEN } from './fakeNodeFetch';

const NODE = 'http://node.test';
const FID = 3;
/** The recorded fixture cast, and its author: fid 3's own. */
const TARGET_HASH = (
  JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'castById.sample.json'), 'utf8'),
  ) as { hash: string }
).hash;
const TARGET_FID = FID;
const SIGNER_KEY =
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

type ReactionKind = 'Like' | 'Recast';

/** The card resolver a test uses: it asks nothing, and says so. */
const offlineEmbedCards = (): EmbedCardResolver =>
  createEmbedCardResolver({
    storage: null,
    fetchImpl: (async () => {
      throw new TypeError('probes are offline in tests');
    }) as typeof fetch,
  });

const reactionJson = ({
  fid,
  hash,
  reactionType,
  targetHash,
}: {
  fid: number;
  hash: string;
  reactionType: ReactionKind;
  targetHash: string;
}) => ({
  data: {
    type: 'MESSAGE_TYPE_REACTION_ADD',
    fid,
    timestamp: 183107142,
    network: 'FARCASTER_NETWORK_MAINNET',
    reactionBody: {
      type:
        reactionType === 'Like' ? 'REACTION_TYPE_LIKE' : 'REACTION_TYPE_RECAST',
      targetCastId: { fid: TARGET_FID, hash: targetHash },
    },
  },
  hash,
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: 'c2lnbmF0dXJl',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: `0x${'11'.repeat(32)}`,
});

/**
 * A node that holds the viewer's reactions as merged state, so the write's own
 * read-back is answered from the same fact the write changed — an ADD is only
 * shown once it is in, and a REMOVE only absent once it is out.
 */
const createFakeNode = ({ accepts = true }: { accepts?: boolean } = {}) => {
  const merged: Record<ReactionKind, Map<string, Set<number>>> = {
    Like: new Map(),
    Recast: new Map(),
  };
  /** Every node route served, so a test can count what a read cost. */
  const served: string[] = [];
  const reads = createFixtureNodeFetch();

  /** This reaction's reactors on that cast, as the node's merged state has it. */
  const reactorsOf = (reactionType: ReactionKind, targetHash: string) =>
    merged[reactionType].get(targetHash) ?? new Set<number>();

  const fetchImpl = (async (input: string, init?: { body?: unknown }) => {
    const url = new URL(input, NODE);
    served.push(`${url.pathname}${url.search}`);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname === '/v1/submitMessage') {
      if (!accepts) {
        // The node's own refusal for a message signed by a key it does not know
        // for that FID — the same bytes a live node answered in nodeWrites.test.
        return json(
          {
            error: 'Failed to submit message',
            error_detail:
              'status: InvalidArgument, message: "bad_request.validation_failure/invalid signer"',
          },
          400,
        );
      }
      const decoded = decodeMessageBytes(init?.body as Uint8Array);
      const data = decoded.data as unknown as {
        type: number;
        reactionBody?: {
          type: number;
          targetCastId: { hash: Uint8Array };
        };
      };
      const body = data.reactionBody;
      if (body === undefined) {
        return json({ error: 'this fake node carries reactions only' }, 400);
      }
      const reactionType: ReactionKind =
        reactionTypeName(body.type) === 'REACTION_TYPE_RECAST'
          ? 'Recast'
          : 'Like';
      const targetHash = bytesToHex(body.targetCastId.hash);
      const added =
        messageTypeName(data.type as Parameters<typeof messageTypeName>[0]) ===
        'MESSAGE_TYPE_REACTION_ADD';
      const held = new Set(reactorsOf(reactionType, targetHash));
      if (added) {
        held.add(FID);
      } else {
        held.delete(FID);
      }
      merged[reactionType].set(targetHash, held);

      return json(
        reactionJson({
          fid: FID,
          hash: bytesToHex(decoded.hash),
          reactionType,
          targetHash,
        }),
      );
    }

    if (url.pathname === '/v1/reactionsByCast') {
      // The write's read-back: the merged state, one page, and an empty next
      // token so "not in this list" really means absent rather than unsearched.
      const reactionType: ReactionKind =
        url.searchParams.get('reaction_type') === 'Recast' ? 'Recast' : 'Like';
      const targetHash = url.searchParams.get('target_hash') ?? '';
      return json({
        messages: [...reactorsOf(reactionType, targetHash)].map((reactor) =>
          reactionJson({
            fid: reactor,
            hash: `0x${'22'.repeat(32)}`,
            reactionType,
            targetHash,
          }),
        ),
        nextPageToken: '',
      });
    }

    if (url.pathname === '/v1/reactionsByFid') {
      // The viewer's OWN log — the read the cache exists for. It holds whatever
      // the node has merged, exactly as the real route does.
      const reactionType: ReactionKind =
        url.searchParams.get('reaction_type') === 'Recast' ? 'Recast' : 'Like';
      const held = [...merged[reactionType].entries()]
        .filter(([, reactors]) => reactors.has(FID))
        .map(([targetHash], at) =>
          reactionJson({
            fid: FID,
            hash: `0x${`${at}${'33'.repeat(31)}`}`,
            reactionType,
            targetHash,
          }),
        );
      return json({ messages: held, nextPageToken: TERMINAL_PAGE_TOKEN });
    }

    return reads(input, init as RequestInit);
  }) as unknown as typeof fetch;

  return { merged, fetchImpl, served };
};

/** The reader, and the write seam that shares it — one client, as in the app. */
const harness = ({ accepts = true }: { accepts?: boolean } = {}) => {
  const node = createFakeNode({ accepts });
  const reader = new NodeBackedReads({
    node: new SnapchainNodeClient({
      baseUrl: NODE,
      fetch: node.fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl: NODE,
    fetchImpl: node.fetchImpl,
    embedKinds: offlineEmbedKinds(),
    embedCards: offlineEmbedCards(),
    getSignedInFid: () => FID,
  });
  const handle = createNodeBackedFetch({
    nodeBaseUrl: NODE,
    nodeLabel: 'Your node',
    getSignedInFid: () => FID,
    getAppKeyHex: async () => SIGNER_KEY,
    fetchImpl: node.fetchImpl,
    // The very same reader the adapter reads through: one client, one cache.
    reads: reader,
  });
  return { ...node, reader, handle };
};

/** One reaction's write, through the adapter exactly as the client makes it. */
const writeReaction = (
  handle: { fetch: typeof fetch },
  { kind, add }: { kind: 'cast-likes' | 'recasts'; add: boolean },
) =>
  handle.fetch(`https://farcaster.xyz/~api/v2/${kind}`, {
    method: add ? 'PUT' : 'DELETE',
    body: JSON.stringify({ castHash: TARGET_HASH }),
  });

/** The recorded cast, as the thread read draws it. */
const recordedCastIn = async (
  reads: NodeBackedReads,
): Promise<{ reacted?: boolean; recast?: boolean } | undefined> => {
  const thread = await reads.readThread({ castHash: TARGET_HASH });
  return thread.casts.find((cast) => cast.hash === TARGET_HASH)?.viewerContext;
};

const viewerLogReads = (log: string[]) =>
  log.filter((entry) => entry.startsWith('/v1/reactionsByFid'));

beforeEach(() => {
  rememberCastAuthor(TARGET_HASH, TARGET_FID);
});

describe('a reaction this session writes is drawn inside the cache window', () => {
  it('draws the heart the person just pressed, and still reads the log once a page', async () => {
    const { handle, reader, served } = harness();

    // A page read first, so the viewer's own log is memoised with the pre-like
    // answer — the state the bug was reported from.
    expect((await recordedCastIn(reader))?.reacted).toBeUndefined();
    const logReadsBefore = viewerLogReads(served).length;
    expect(logReadsBefore).toBeGreaterThan(0);

    const like = await writeReaction(handle, { kind: 'cast-likes', add: true });
    expect(like.status).toBe(200);

    // Inside the minute: the conversation of a cast this person just liked.
    expect((await recordedCastIn(reader))?.reacted).toBe(true);

    // And the minute still pays for itself: not one more read of the viewer's
    // whole like and recast history, however many page reads follow.
    await recordedCastIn(reader);
    expect(viewerLogReads(served).length).toBe(logReadsBefore);
  });

  it('takes the heart back off when this session undoes the like', async () => {
    const { handle, reader } = harness();

    await writeReaction(handle, { kind: 'cast-likes', add: true });
    expect((await recordedCastIn(reader))?.reacted).toBe(true);

    const undo = await writeReaction(handle, {
      kind: 'cast-likes',
      add: false,
    });
    expect(undo.status).toBe(200);

    // The mirror of the reported bug: un-like, then open the conversation while
    // the set is still the one from before the undo.
    expect((await recordedCastIn(reader))?.reacted).toBeUndefined();
  });

  it('draws a recast the same way, and keeps the two reaction types apart', async () => {
    const { handle, reader } = harness();

    await recordedCastIn(reader);
    const recast = await writeReaction(handle, { kind: 'recasts', add: true });
    expect(recast.status).toBe(200);

    const drawn = await recordedCastIn(reader);
    expect(drawn?.recast).toBe(true);
    // A recast is not a like: the heart stays where the node's log has it.
    expect(drawn?.reacted).toBeUndefined();
  });
});

describe('a write that did not land changes nothing', () => {
  it('does not draw a like the node refused to carry', async () => {
    const { handle, reader } = harness({ accepts: false });

    expect((await recordedCastIn(reader))?.reacted).toBeUndefined();

    const refused = await writeReaction(handle, {
      kind: 'cast-likes',
      add: true,
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    // The client's own optimistic patch is reverted on a failed write for the
    // same reason (see `useCreateCastLike`): nothing was liked.
    expect((await recordedCastIn(reader))?.reacted).toBeUndefined();
  });
});
