/**
 * The write half of the seam, as tests — the thing the reader reported broken.
 *
 * MEASURED BEFORE THIS (2026-10-21, the live client, signed in): pressing the
 * heart answered
 *
 *     UpdateCastLikeError — createCastLike 501
 *     "no node-backed reader has been written for this endpoint yet"
 *
 * These tests pin what happens instead, at the level where it can be checked
 * without mainnet: the *bytes that leave* are decoded with the protocol library
 * the client signed them with (never with a fixture, and never by trusting the
 * fake node's answer), and the answer is only a success when the fake node's own
 * state shows the write afterwards.
 *
 * The fake node's *state* is this test's to define — it is a fake. What is not
 * invented anywhere here is the client's half: the message is built by the real
 * builders in `farcaster-node-client`, and the answer shapes are the ones the
 * pages already read.
 */

import {
  buildReactionAddMessage,
  bytesToHex,
  decodeMessageBytes,
  hexToBytes,
  messageTypeName,
} from 'farcaster-node-client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNodeBackedFetch } from '~/snapchain/nodeApi/nodeBackedFetch';
import {
  approvalLabelFor,
  type ManagedWrite,
  NO_APP_KEY,
  UNKNOWN_CAST_AUTHOR,
  type WriteApprovalRequest,
  writeIntentFor,
} from '~/snapchain/nodeApi/nodeWrites';
import { rememberCastAuthor } from '~/snapchain/nodeApi/reads';

const FID = 3;
const TARGET = {
  fid: 37,
  hash: '0x50184b62b4c52fd76628713562e1eda3dccaf63d',
};
const SIGNER_KEY =
  '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

interface FakeNodeState {
  /** What the node's merged state says about the target cast's likes. */
  likedBy: number[];
  /**
   * The same list as the node's own *pages*, when a test needs more than one:
   * a node hands back at most 200 messages per page whichever `pageSize` asks,
   * and only says `nextPageToken` while another page really exists.
   */
  reactionPages?: number[][];
  /** Is the follow edge in the merged state? */
  following: boolean;
  /** Does the node accept the message at all (a signer it knows)? */
  accepts: boolean;
  /** Whether an accepted message becomes visible in the state. */
  merges: boolean;
}

const messageJson = ({
  type,
  fid,
  bodyKey,
  body,
  hash,
}: {
  type: string;
  fid: number;
  bodyKey: string;
  body: Record<string, unknown>;
  hash: string;
}) => ({
  data: {
    type,
    fid,
    timestamp: 183107142,
    network: 'FARCASTER_NETWORK_MAINNET',
    [bodyKey]: body,
  },
  hash,
  hashScheme: 'HASH_SCHEME_BLAKE3',
  signature: 'c2lnbmF0dXJl',
  signatureScheme: 'SIGNATURE_SCHEME_ED25519',
  signer: '0x' + '11'.repeat(32),
});

const reactionJson = (fid: number, hash: string) =>
  messageJson({
    type: 'MESSAGE_TYPE_REACTION_ADD',
    fid,
    bodyKey: 'reactionBody',
    body: {
      type: 'REACTION_TYPE_LIKE',
      targetCastId: { fid: TARGET.fid, hash: TARGET.hash },
    },
    hash,
  });

const linkJson = (fid: number, hash: string) =>
  messageJson({
    type: 'MESSAGE_TYPE_LINK_ADD',
    fid,
    bodyKey: 'linkBody',
    body: { type: 'follow', targetFid: 999, displayTimestamp: null },
    hash,
  });

/** A node that records what it was asked to carry, and can be made to lie. */
const createFakeNode = (state: Partial<FakeNodeState> = {}) => {
  const node: FakeNodeState = {
    likedBy: [],
    following: false,
    accepts: true,
    merges: true,
    ...state,
  };
  const submitted: Uint8Array[] = [];

  const fetchImpl = (async (input: string, init?: { body?: unknown }) => {
    const url = new URL(input, 'http://node.test');
    const path = url.pathname;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (path === '/v1/submitMessage') {
      const bytes = init?.body as Uint8Array;
      submitted.push(bytes);
      if (!node.accepts) {
        // The node's own refusal for a message signed by a key it does not know
        // for that FID — MEASURED live, verbatim, on both a public read node and
        // Neynar's node.
        return json(
          {
            error: 'Failed to submit message',
            error_detail:
              'status: InvalidArgument, message: "bad_request.validation_failure/invalid signer"',
          },
          400,
        );
      }
      const decoded = decodeMessageBytes(bytes);
      const data = decoded.data as unknown as {
        type: number;
        reactionBody?: { type: number };
        linkBody?: { type: string };
      };
      const hash = bytesToHex(decoded.hash);
      if (data.reactionBody) {
        // A node merges what it accepted: an ADD puts this account's reaction
        // into its merged state, a REMOVE takes it back out. An undo is a
        // different *message type* with the same body, so the type — not the
        // body — is what decides, exactly as the protocol does.
        const added =
          messageTypeName(
            data.type as Parameters<typeof messageTypeName>[0],
          ) === 'MESSAGE_TYPE_REACTION_ADD';
        if (node.merges) {
          node.likedBy = added
            ? [...node.likedBy.filter((reactor) => reactor !== FID), FID]
            : node.likedBy.filter((reactor) => reactor !== FID);
        }
        return json(
          messageJson({
            type: added
              ? 'MESSAGE_TYPE_REACTION_ADD'
              : 'MESSAGE_TYPE_REACTION_REMOVE',
            fid: FID,
            bodyKey: 'reactionBody',
            body: {
              type: 'REACTION_TYPE_LIKE',
              targetCastId: { fid: TARGET.fid, hash: TARGET.hash },
            },
            hash,
          }),
        );
      }
      return json(linkJson(FID, hash));
    }

    if (path === '/v1/reactionsByCast') {
      // The node's own paging, as measured: one page at a time, and a
      // `nextPageToken` only while there is another page to ask for.
      const pages = node.reactionPages ?? [
        node.merges ? node.likedBy : (state.likedBy ?? []),
      ];
      const asked = url.searchParams.get('pageToken');
      const index = asked === null ? 0 : Number(asked);
      const fids = pages[index] ?? [];
      return json({
        messages: fids.map((fid, at) =>
          reactionJson(fid, `0x${`${index}${at}`.padStart(64, '0')}`),
        ),
        nextPageToken: index + 1 < pages.length ? String(index + 1) : '',
      });
    }

    if (path === '/v1/linkById') {
      if (!node.following) {
        return json(
          {
            error: 'Failed to get link',
            error_detail: 'status: NotFound, message: "cast not found"',
          },
          400,
        );
      }
      return json(linkJson(FID, `0x${'22'.repeat(32)}`));
    }

    if (path === '/v1/castById') {
      return json({ error: 'cast not found' }, 404);
    }

    return json({ messages: [], nextPageToken: 'W251bGwsbnVsbF0=' });
  }) as unknown as typeof fetch;

  return { node, submitted, fetchImpl };
};

const harness = (
  state: Partial<FakeNodeState> = {},
  appKeyHex = SIGNER_KEY,
) => {
  const fake = createFakeNode(state);
  const handle = createNodeBackedFetch({
    nodeBaseUrl: 'http://node.test',
    nodeLabel: 'Your node',
    getSignedInFid: () => FID,
    fetchImpl: fake.fetchImpl,
    getAppKeyHex: async () => appKeyHex,
  });
  return { ...fake, handle };
};

const messageOf = async (response: Response): Promise<string> => {
  const body = (await response.json()) as { errors: { message: string }[] };
  return body.errors[0]?.message ?? '';
};

beforeEach(() => {
  rememberCastAuthor(TARGET.hash, TARGET.fid);
});

describe('a like, through the node-backed writer', () => {
  it('signs a REACTION_ADD for that cast and reads the node’s state back', async () => {
    const { handle, submitted, node } = harness();

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      { method: 'PUT', body: JSON.stringify({ castHash: TARGET.hash }) },
    );

    expect(response.status).toBe(200);
    // What left: a real signed message, decoded with the protocol library the
    // client signed it with, addressed to the cast the heart was pressed on.
    const expected = await buildReactionAddMessage({
      fid: FID,
      signerPrivateKey: hexToBytes(SIGNER_KEY),
      reactionType: 'like',
      targetCastId: { fid: TARGET.fid, hash: TARGET.hash },
    });
    const actual = decodeMessageBytes(submitted[0]!);
    const want = decodeMessageBytes(expected.bytes);
    expect(actual.data!.type).toBe(want.data!.type);
    expect((actual.data as never as { fid: number }).fid).toBe(FID);
    expect(
      bytesToHex(
        (
          actual.data as never as {
            reactionBody: { targetCastId: { hash: Uint8Array } };
          }
        ).reactionBody.targetCastId.hash,
      ),
    ).toBe(TARGET.hash);
    // The signer is the public key of this device's app key: the same bytes as
    // the message built independently, not merely a non-empty field.
    expect(bytesToHex(actual.signer)).toBe(bytesToHex(want.signer));

    // The state really shows it afterwards, and the answer carries the shapes
    // the hook reads (`result.like`).
    expect(node.likedBy).toContain(FID);
    const body = (await response.json()) as {
      result: { like: { type: string; castHash: string } };
    };
    expect(body.result.like.type).toBe('like');
    expect(body.result.like.castHash).toBe(TARGET.hash);
    expect(handle.log.at(-1)).toMatchObject({
      kind: 'write',
      status: 200,
      write: { accepted: true, landed: true, node: 'Your node' },
    });
  });

  it('undoes it: signs a REACTION_REMOVE and says so only once the state shows it gone', async () => {
    const { handle, submitted, node } = harness({ likedBy: [FID] });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      { method: 'DELETE', body: JSON.stringify({ castHash: TARGET.hash }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { success: true } });
    // What leaves for an unlike is the *remove* message — same body as the like,
    // and only the message type says which of the two it is.
    expect(messageTypeName(decodeMessageBytes(submitted[0]!).data!.type)).toBe(
      'MESSAGE_TYPE_REACTION_REMOVE',
    );
    // And the node's own state really stopped showing this account's like.
    expect(node.likedBy).not.toContain(FID);
    expect(handle.log.at(-1)).toMatchObject({
      kind: 'write',
      status: 200,
      write: {
        accepted: true,
        landed: true,
        readbackPath: '/v1/reactionsByCast',
      },
    });
  });

  it('will not call an undo done while the node still shows the like', async () => {
    // `merges: false` is a node that took the message but has not folded it into
    // its state: the like is still there afterwards, so the undo did not land.
    // Answering 200 here is the exact lie this writer exists to avoid.
    const { handle } = harness({ likedBy: [FID], merges: false });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      { method: 'DELETE', body: JSON.stringify({ castHash: TARGET.hash }) },
    );

    expect(response.status).toBe(502);
    expect(await messageOf(response)).toContain('is not showing it');
    expect(handle.log.at(-1)?.write).toMatchObject({
      accepted: true,
      landed: false,
    });
  });

  it('finds a like the node pages out of its first page', async () => {
    // MEASURED live: a node hands back at most 200 reactions per page and does
    // not order them newest-first, so on a popular cast this account's own like
    // can sit on page 3. A read-back that only ever looked at page one would
    // call that like "not showing".
    const { handle } = harness({
      likedBy: [FID],
      reactionPages: [[], [], [FID]],
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      { method: 'PUT', body: JSON.stringify({ castHash: TARGET.hash }) },
    );

    expect(response.status).toBe(200);
    expect(handle.log.at(-1)?.write).toMatchObject({
      accepted: true,
      landed: true,
      readbackPath: '/v1/reactionsByCast',
    });
  });

  it('never calls an undo done when it could not search the list to the end', async () => {
    // Six pages, the walk is allowed five, and this account's reaction is in
    // none of them: the list was not searched to its end, so "it is gone" is not
    // something this client can honestly say.
    const { handle } = harness({
      likedBy: [FID],
      reactionPages: [[], [], [], [], [], []],
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      { method: 'DELETE', body: JSON.stringify({ castHash: TARGET.hash }) },
    );

    expect(response.status).toBe(502);
    expect(handle.log.at(-1)?.write).toMatchObject({
      accepted: true,
      landed: false,
    });
  });

  it('answers a like it cannot address with the page that would fix it', async () => {
    const fake = createFakeNode();
    const handle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      getSignedInFid: () => FID,
      fetchImpl: fake.fetchImpl,
      getAppKeyHex: async () => SIGNER_KEY,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      {
        method: 'PUT',
        body: JSON.stringify({ castHash: `0x${'ab'.repeat(32)}` }),
      },
    );

    expect(response.status).toBe(501);
    expect(await messageOf(response)).toBe(UNKNOWN_CAST_AUTHOR);
    // Nothing was signed and nothing was sent.
    expect(fake.submitted).toEqual([]);
  });

  it('says which one-time step is missing when this device has no key', async () => {
    const { handle, submitted } = harness({}, null as unknown as string);

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      { method: 'PUT', body: JSON.stringify({ castHash: TARGET.hash }) },
    );

    expect(response.status).toBe(501);
    const message = await messageOf(response);
    expect(message).toBe(NO_APP_KEY);
    expect(message).toContain('Issue app key');
    expect(submitted).toEqual([]);
  });

  it('keeps the node’s own words when it refuses the signature', async () => {
    const { handle, submitted } = harness({ accepts: false });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      { method: 'PUT', body: JSON.stringify({ castHash: TARGET.hash }) },
    );

    // The message was built and really submitted — the node is what refused it,
    // in its own words, with what that means appended.
    expect(submitted.length).toBe(1);
    expect(response.status).toBe(501);
    const message = await messageOf(response);
    expect(message).toContain('invalid signer');
    expect(message).toContain('not one this account has authorised');
    expect(handle.log.at(-1)?.write).toMatchObject({ accepted: false });
  });
});

describe('a follow, through the node-backed writer', () => {
  it('signs a LINK_ADD and confirms it against the node’s own edge', async () => {
    const { handle, submitted, node } = harness({ following: false });
    const fetchImpl = handle.fetch;

    // First: the edge is absent, and the node no longer answers for it. The
    // writer has to read that 400 `NotFound` as "no", not as a failure.
    node.following = false;
    const refused = await fetchImpl('https://farcaster.xyz/~api/v2/follows', {
      method: 'PUT',
      body: JSON.stringify({ targetFid: 999 }),
    });
    expect(submitted.length).toBe(1);
    expect(refused.status).toBe(502);
    expect(await messageOf(refused)).toContain('is not showing it yet');

    // Then: the node shows the edge, and the same call is a success.
    const second = harness({ following: true });
    const response = await second.handle.fetch(
      'https://farcaster.xyz/~api/v2/follows',
      { method: 'PUT', body: JSON.stringify({ targetFid: 999 }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { success: true, userAppContext: { canAddLinks: true } },
    });
    expect(second.handle.log.at(-1)?.write).toMatchObject({ landed: true });
  });

  it('never invents a FID: no key means nothing is signed', async () => {
    const fake = createFakeNode();
    const handle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      getSignedInFid: () => undefined,
      fetchImpl: fake.fetchImpl,
      getAppKeyHex: async () => SIGNER_KEY,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/follows',
      {
        method: 'DELETE',
        body: JSON.stringify({ targetFid: 999 }),
      },
    );

    expect(response.status).toBe(501);
    expect(await messageOf(response)).toContain('nobody to write as');
    expect(fake.submitted).toEqual([]);
  });
});

describe('a cast, through the node-backed writer', () => {
  it('signs the text as CAST_ADD, submits it, and says so only once it is stored', async () => {
    const castFetch = (async (input: string) => {
      const url = new URL(input, 'http://node.test');
      if (url.pathname === '/v1/submitMessage') {
        return new Response(
          JSON.stringify(
            messageJson({
              type: 'MESSAGE_TYPE_CAST_ADD',
              fid: FID,
              bodyKey: 'castAddBody',
              body: {
                text: 'a cast from the probe',
                embeds: [],
                embedsDeprecated: [],
                mentions: [],
                mentionsPositions: [],
                type: 'CAST',
              },
              hash: `0x${'33'.repeat(32)}`,
            }),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.pathname === '/v1/castById') {
        return new Response(
          JSON.stringify(
            messageJson({
              type: 'MESSAGE_TYPE_CAST_ADD',
              fid: FID,
              bodyKey: 'castAddBody',
              body: {
                text: 'a cast from the probe',
                embeds: [],
                embedsDeprecated: [],
                mentions: [],
                mentionsPositions: [],
                type: 'CAST',
              },
              hash: `0x${'33'.repeat(32)}`,
            }),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const castHandle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      getSignedInFid: () => FID,
      fetchImpl: castFetch,
      getAppKeyHex: async () => SIGNER_KEY,
    });

    const response = await castHandle.fetch(
      'https://farcaster.xyz/~api/v2/casts',
      {
        method: 'POST',
        body: JSON.stringify({ text: 'a cast from the probe' }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { cast: { text: string; author: { fid: number } } };
    };
    expect(body.result.cast.text).toBe('a cast from the probe');
    expect(body.result.cast.author.fid).toBe(FID);
    expect(castHandle.log.at(-1)?.write).toMatchObject({
      accepted: true,
      landed: true,
      readbackPath: '/v1/castById',
    });
  });

  it('refuses an empty cast rather than signing one', async () => {
    const { handle, submitted } = harness();
    const response = await handle.fetch('https://farcaster.xyz/~api/v2/casts', {
      method: 'POST',
      body: JSON.stringify({ text: '   ' }),
    });
    expect(response.status).toBe(400);
    expect(submitted).toEqual([]);
  });
});

describe('the classification this all hangs off', () => {
  it('reads the fork’s own write paths as writes', async () => {
    const { classifyHostedRequest } =
      await import('~/snapchain/nodeApi/hostedRoutes');
    for (const [method, path] of [
      ['PUT', '/v2/cast-likes'],
      ['DELETE', '/v2/cast-likes'],
      ['PUT', '/v2/recasts'],
      ['DELETE', '/v2/recasts'],
      ['PUT', '/v2/follows'],
      ['DELETE', '/v2/follows'],
      ['POST', '/v2/casts'],
    ] as const) {
      expect(
        classifyHostedRequest({ method, path: `/~api${path}` }),
      ).toMatchObject({ kind: 'write', path });
    }
    // An unclassified write explains itself as a *writer* gap, which is the
    // sentence the reader actually hit on `PUT /v2/cast-likes`.
    expect(
      classifyHostedRequest({ method: 'PUT', path: '/v2/unheard-of' }),
    ).toMatchObject({ kind: 'hosted' });
    expect(
      classifyHostedRequest({ method: 'PUT', path: '/v2/unheard-of' }).why,
    ).toContain('nothing was signed and nothing was sent');
  });
});

describe('the app key store', () => {
  it('turns a storage that cannot be read into the sentence about the key', async () => {
    const fake = createFakeNode();
    const handle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      getSignedInFid: () => FID,
      fetchImpl: fake.fetchImpl,
      getAppKeyHex: vi.fn(async () => {
        throw new Error('No available storage method found.');
      }),
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      { method: 'PUT', body: JSON.stringify({ castHash: TARGET.hash }) },
    );

    expect(response.status).toBe(501);
    expect(await messageOf(response)).toContain('Issue app key');
    expect(fake.submitted).toEqual([]);
  });
});

/**
 * The write that has no key yet — and the approval asked for in place.
 *
 * This is the half of onboarding card 4/5 that lives in the writer: pressing the
 * heart, or sending a cast, before this device holds any posting key must not
 * answer with a sentence about a screen two taps away. The pending write itself
 * is handed to the asker (`~/snapchain/accounts/postingKeyApproval`, in the app),
 * and the *same request* is answered again once the person has approved — so the
 * reader gets the like they pressed, and the caller gets the answer a like
 * always gets.
 *
 * What is pinned here, without a browser and without a service:
 *
 *   - the asker is asked once, with the write's own name attached ("like"), and
 *     the carried write is the same one (the reaction really goes out, and the
 *     node's own state is read back before the answer says it landed);
 *   - a decline, an asker that cannot be reached, and an approval that did not
 *     really happen all leave the refusal *exactly* as it was — the same status,
 *     the same sentence, nothing signed;
 *   - a retry never asks the same person twice, so a broken approval cannot
 *     loop the screen.
 */
describe('a write with no posting key yet', () => {
  const likeRequestBody = JSON.stringify({ castHash: TARGET.hash });

  const writerWithApproval = ({
    state = {},
    appKeyHex = null as unknown as string,
    ask,
    granted,
  }: {
    state?: Partial<FakeNodeState>;
    appKeyHex?: string | null;
    ask?: (request: WriteApprovalRequest) => Promise<Response | null>;
    /** The granted poster's answer, when the approval really produced a key. */
    granted?: { available: () => boolean; post: (write: ManagedWrite) => void };
  } = {}) => {
    const fake = createFakeNode(state);
    const handle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      nodeLabel: 'Your node',
      getSignedInFid: () => FID,
      fetchImpl: fake.fetchImpl,
      getAppKeyHex: async () => appKeyHex,
      ...(granted === undefined
        ? {}
        : {
            managedPoster: {
              available: async () => granted.available(),
              post: async (write: ManagedWrite) => {
                granted.post(write);
                return { ok: true as const, hash: null };
              },
            },
          }),
      ...(ask === undefined ? {} : { askForPostingKey: ask }),
    });
    return { ...fake, handle };
  };

  const pressLike = (handle: { fetch: typeof fetch }) =>
    handle.fetch('https://farcaster.xyz/~api/v2/cast-likes', {
      method: 'PUT',
      body: likeRequestBody,
    });

  it('names the write in the person’s own word, from the intent it classified', () => {
    const labelOf = (method: string, path: string, body: unknown) =>
      approvalLabelFor(writeIntentFor({ method, path, body })!);

    expect(labelOf('PUT', '/v2/cast-likes', { castHash: TARGET.hash })).toBe(
      'like',
    );
    expect(labelOf('DELETE', '/v2/cast-likes', { castHash: TARGET.hash })).toBe(
      'change',
    );
    expect(labelOf('PUT', '/v2/recasts', { castHash: TARGET.hash })).toBe(
      'recast',
    );
    expect(labelOf('PUT', '/v2/follows', { targetFid: 999 })).toBe('follow');
    expect(labelOf('DELETE', '/v2/follows', { targetFid: 999 })).toBe('change');
    expect(labelOf('POST', '/v2/casts', { text: 'hello' })).toBe('post');
  });

  it('asks where the person is, and carries the very same like with the key they granted', async () => {
    // The state shows the like afterwards: the service that holds the granted
    // posting key really posted it, and this writer still reads the node's own
    // state back before it says so.
    const asked: WriteApprovalRequest[] = [];
    const posted: ManagedWrite[] = [];
    let keyExists = false;
    const fake = writerWithApproval({
      state: { likedBy: [FID] },
      ask: async (request) => {
        asked.push(request);
        keyExists = true;
        return request.carry();
      },
      granted: {
        available: () => keyExists,
        post: (write) => posted.push(write),
      },
    });

    const response = await pressLike(fake.handle);

    expect(asked.length).toBe(1);
    expect(asked[0]!.fid).toBe(FID);
    expect(asked[0]!.label).toBe('like');
    // The carried write is the same write: one like, on the same cast.
    expect(posted).toEqual([
      { kind: 'reaction', add: true, reaction: 'like', castHash: TARGET.hash },
    ]);
    expect(response.status).toBe(200);
    // Nothing was signed by this device — the granted key did it.
    expect(fake.submitted).toEqual([]);
  });

  it('keeps the old sentence, and signs nothing, when the person says not now', async () => {
    const asked: WriteApprovalRequest[] = [];
    const fake = writerWithApproval({
      ask: async (request) => {
        asked.push(request);
        return null;
      },
    });

    const response = await pressLike(fake.handle);

    expect(asked.length).toBe(1);
    expect(response.status).toBe(501);
    expect(await messageOf(response)).toBe(NO_APP_KEY);
    expect(fake.submitted).toEqual([]);
    // The request log says what happened, so a probe can read it.
    expect(fake.handle.log.at(-1)).toMatchObject({
      kind: 'write',
      status: 501,
      write: { accepted: false, landed: null, refusal: NO_APP_KEY },
    });
  });

  it('asks once: an approval that did not really happen cannot loop the screen', async () => {
    const asked: WriteApprovalRequest[] = [];
    const fake = writerWithApproval({
      // An approval that leaves no key anywhere: the retry finds nothing.
      ask: async (request) => {
        asked.push(request);
        return request.carry();
      },
    });

    const response = await pressLike(fake.handle);

    expect(asked.length).toBe(1);
    expect(response.status).toBe(501);
    expect(await messageOf(response)).toBe(NO_APP_KEY);
    expect(fake.submitted).toEqual([]);
  });

  it('is unchanged with nobody to ask, and with an asker that cannot be reached', async () => {
    const silent = writerWithApproval({ ask: undefined });
    const refused = await pressLike(silent.handle);
    expect(refused.status).toBe(501);
    expect(await messageOf(refused)).toBe(NO_APP_KEY);
    expect(silent.submitted).toEqual([]);

    const broken = writerWithApproval({
      ask: async () => {
        throw new Error('no storage method found');
      },
    });
    const answered = await pressLike(broken.handle);
    expect(answered.status).toBe(501);
    expect(await messageOf(answered)).toContain('could not build');
    expect(broken.submitted).toEqual([]);
  });
});
