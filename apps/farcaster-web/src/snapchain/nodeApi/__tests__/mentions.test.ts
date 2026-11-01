/**
 * The user-reported bug, at the two layers that had it.
 *
 * REPORTED (2026-10-21, on the live site): in Mentions, a cast that tags the
 * viewer *and* other accounts shows only the viewer; the official client shows
 * everyone tagged.
 *
 * WHAT IS ACTUALLY STORED (protocol specification, and 50 successive
 * mention-casts read off a live node): a cast carries the mentioned FIDs and a
 * byte position for each, and a placeholder character where each handle belongs.
 * The handles are not in the text at all. The adapter kept the FIDs and wrote
 * `fid N` as every mention's name, so no tagged account had a handle and the text
 * kept its placeholders — a cast tagging six people read as six spaces.
 *
 * These tests drive the real read path (pages recorded from a live node, the real
 * `GET /v2/user-casts` route, the real cast translator) over a real cast that
 * tags six accounts — the viewer among them — and assert:
 *
 *   - every tagged account is read and rendered with the node's own handle,
 *   - the text reads the way the official client renders it,
 *   - the reads are batched and cached: one `userDataByFid` per distinct FID,
 *   - a mention the node cannot answer for stays a fid, never a wrong name.
 */

import type { ApiUser } from 'farcaster-client-data';
import type { NodeCastAddBody, NodeMessage } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { createEmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';
import {
  apiCastFromNode,
  castTextWithMentions,
  mentionFloorUser,
} from '~/snapchain/nodeApi/fromNode';
import { createNodeBackedFetch } from '~/snapchain/nodeApi/nodeBackedFetch';

import { createFixtureNodeFetch } from './fakeNodeFetch';

type Json = Record<string, unknown>;

/** A mentioned account, as far as rendering is concerned. */
const named = (fid: number, username: string): ApiUser => ({
  fid,
  username,
  displayName: username,
  followerCount: 0,
  followingCount: 0,
  profile: { bio: { text: '', mentions: [] } },
});

describe('a cast’s text carries placeholders, not handles', () => {
  it('renders a handle at the position the protocol names', () => {
    // The protocol specification's own example: "🤓@farcaster can mention
    // immediately after emoji" is stored with position 4 — the byte after the
    // four-byte emoji, where the space placeholder sits.
    expect(
      castTextWithMentions({
        text: '🤓 can mention immediately after emoji',
        mentions: [1],
        mentionsPositions: [4],
        mentionUsers: new Map([[1, named(1, 'farcaster')]]),
      }),
    ).toBe('🤓@farcaster can mention immediately after emoji');
  });

  it('counts positions in bytes, so an emoji does not shift a later mention', () => {
    // '😀 and 🚀 go' in bytes: 😀 is 0…3, the space after it is 4, 🚀 is 9…12 and
    // the space after that one is 13. In UTF-16 units those spaces sit at 1 and
    // 7 — so reading a byte position as a character index would land in the
    // middle of a word, which is exactly what this asserts against.
    expect(
      castTextWithMentions({
        text: '😀 and 🚀 go',
        mentions: [10, 20],
        mentionsPositions: [4, 13],
        mentionUsers: new Map([
          [10, named(10, 'one')],
          [20, named(20, 'two')],
        ]),
      }),
    ).toBe('😀@one and 🚀@two go');
  });

  it('reads a run of consecutive mentions the way a live cast is stored', () => {
    // Recorded shape (fid 327154, live node): six leading spaces, positions
    // 0…5. Each placeholder is what separates the handles.
    expect(
      castTextWithMentions({
        text: '      make sure to share your vouch link',
        mentions: [1, 2, 3, 4, 5, 6],
        mentionsPositions: [0, 1, 2, 3, 4, 5],
        mentionUsers: new Map([
          [1, named(1, 'a')],
          [2, named(2, 'b')],
          [3, named(3, 'c')],
          [4, named(4, 'd')],
          [5, named(5, 'e')],
          [6, named(6, 'f')],
        ]),
      }),
    ).toBe('@a @b @c @d @e @f make sure to share your vouch link');
  });

  it('leaves the placeholder when no handle was read for that fid', () => {
    expect(
      castTextWithMentions({
        text: 'hello  and  everyone',
        mentions: [1, 2],
        mentionsPositions: [6, 12],
        mentionUsers: new Map([[1, named(1, 'known')]]),
      }),
    ).toBe('hello @known and  everyone');
  });

  it('does not write a handle the text already carries', () => {
    // MEASURED in the wild: a bot writes "@ivc" into the text *and* registers the
    // mention, so inserting would read "@ivcivc".
    expect(
      castTextWithMentions({
        text: 'Hey @ivc — breathe in 4',
        mentions: [191554],
        mentionsPositions: [4],
        mentionUsers: new Map([[191554, named(191554, 'ivc')]]),
      }),
    ).toBe('Hey @ivc — breathe in 4');
  });

  it('ignores a position outside the text, which the wild also carries', () => {
    // MEASURED: 9 of 50 successive mention-casts on a live node name a position
    // past the end of their own text. The cast still renders.
    expect(
      castTextWithMentions({
        text: 'short',
        mentions: [1],
        mentionsPositions: [99],
        mentionUsers: new Map([[1, named(1, 'late')]]),
      }),
    ).toBe('short');
  });

  it('inserts a final mention at the end of the text', () => {
    expect(
      castTextWithMentions({
        text: 'cc ',
        mentions: [1],
        mentionsPositions: [3],
        mentionUsers: new Map([[1, named(1, 'you')]]),
      }),
    ).toBe('cc @you');
  });
});

describe('a cast as the fork’s ApiCast', () => {
  const message: NodeMessage = {
    hash: '0x' + 'ab'.repeat(20),
    fid: 5,
    timestamp: 1,
    timestampMs: 1_700_000_000_000,
  } as NodeMessage;
  // 'gm  and ' — a placeholder space after "gm" and one at the end, which is
  // where the two mentions belong (positions 3 and 8, in bytes).
  const body = {
    text: 'gm  and ',
    castType: 'CAST',
    embeds: [],
    embedsDeprecated: [],
    mentions: [191554, 2],
    mentionsPositions: [3, 8],
  } as unknown as NodeCastAddBody;

  it('names every mention it was given a profile for, and keeps the other as a fid', () => {
    const cast = apiCastFromNode({
      message,
      body,
      author: named(5, 'author'),
      mentionUsers: new Map([
        [191554, named(191554, 'ivc')],
        [2, named(2, 'v')],
      ]),
    });

    expect(cast.mentions?.map((mention) => mention.fid)).toEqual([191554, 2]);
    expect(cast.mentions?.map((mention) => mention.username)).toEqual([
      'ivc',
      'v',
    ]);
    expect(cast.mentions?.map((mention) => mention.displayName)).toEqual([
      'ivc',
      'v',
    ]);
    expect(cast.text).toBe('gm @ivc and @v');
  });

  it('falls back to the fid floor rather than to a wrong handle', () => {
    const cast = apiCastFromNode({
      message,
      body,
      author: named(5, 'author'),
      mentionUsers: new Map([[191554, named(191554, 'ivc')]]),
    });

    expect(cast.mentions?.[0]?.username).toBe('ivc');
    expect(cast.mentions?.[1]).toEqual(mentionFloorUser(2));
    expect(cast.text).toBe('gm @ivc and ');
  });

  it('renders nothing into the text when no profile was read at all', () => {
    const cast = apiCastFromNode({
      message,
      body,
      author: named(5, 'author'),
    });

    expect(cast.text).toBe('gm  and ');
    expect(cast.mentions?.map((mention) => mention.displayName)).toEqual([
      'fid 191554',
      'fid 2',
    ]);
  });
});

/**
 * The reported cast, read the way the client reads it: the page recorded from a
 * live node, through the real hosted route, with the node's answers logged so a
 * test can say *what was read*, not only what came out.
 */
const REPORTED_CAST = '0xfbd7304f8394a8d00f5d6d83c83bc278f05525d8';
const AUTHOR_FID = 327154;
/** The viewer — the account the report came from, and one of the six tagged. */
const VIEWER_FID = 191554;
/** Every fid the report's cast tags, with the handle the node gives it. */
const TAGGED: [number, string][] = [
  [1918, '0xzoz'],
  [191554, 'ivc'],
  [381353, 'aap'],
  [440212, 'mobeen02'],
  [3326491, 'nashrad'],
  [3355244, 'sats100m'],
];
const RENDERED_TEXT = `@${TAGGED.map(([, username]) => username).join(
  ' @',
)} make sure to share your human vouch post link before the deadline (~3 days left)!`;

const buildHarness = () => {
  const nodeLog: string[] = [];
  const handle = createNodeBackedFetch({
    nodeBaseUrl: 'http://node.test',
    getSignedInFid: () => VIEWER_FID,
    fetchImpl: createFixtureNodeFetch({ log: nodeLog }),
    // No embed probe here: this test is about mentions, and a real probe would
    // reach a real image host from a unit test.
    embedKinds: createEmbedKindResolver({
      storage: null,
      imageProbe: async () => undefined,
      fetchImpl: (async () =>
        new Response(null, { status: 404 })) as typeof fetch,
    }),
  });
  return { handle, nodeLog };
};

const authorCasts = async (): Promise<Json[]> => {
  const { handle } = buildHarness();
  const response = await handle.fetch(
    `https://farcaster.xyz/~api/v2/user-casts?fid=${AUTHOR_FID}&limit=25`,
    { method: 'GET' },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as Json;
  return ((body.result as { casts: Json[] }).casts ?? []) as Json[];
};

describe('every tagged account is resolved, not only the viewer', () => {
  it('reads and names all six accounts the reported cast tags', async () => {
    const casts = await authorCasts();
    const cast = casts.find((entry) => entry.hash === REPORTED_CAST);
    expect(cast, `cast ${REPORTED_CAST} should be in the page`).toBeDefined();

    expect(cast!.text).toBe(RENDERED_TEXT);

    const mentions = cast!.mentions as ApiUser[];
    expect(mentions.map((mention) => mention.fid)).toEqual(
      TAGGED.map(([fid]) => fid),
    );
    expect(mentions.map((mention) => mention.username)).toEqual(
      TAGGED.map(([, username]) => username),
    );
    // The handles came from the node's own user data, avatars included — the
    // renderer has no other source for them.
    for (const mention of mentions) {
      expect(mention.pfp?.url).toBeTruthy();
      expect(mention.displayName).not.toMatch(/^fid \d+$/);
    }
  });

  it('reads each distinct tagged account once, through one batched read', async () => {
    const { handle, nodeLog } = buildHarness();
    // Warm the author's own profile first, so what this asserts is the mentions
    // and nothing else.
    await handle.fetch(
      `https://farcaster.xyz/~api/v2/user-by-fid?fid=${AUTHOR_FID}`,
      {
        method: 'GET',
      },
    );
    const page = await handle.fetch(
      `https://farcaster.xyz/~api/v2/user-casts?fid=${AUTHOR_FID}&limit=25`,
      { method: 'GET' },
    );
    expect(page.status).toBe(200);

    const read = nodeLog.filter(
      (url) => url.startsWith('/v1/userDataByFid') && url.includes('191554'),
    );
    // The viewer is read like every other tagged account — one read, because the
    // page is deduped by FID — and never because a mention names the viewer.
    expect(read).toHaveLength(1);

    for (const [fid] of TAGGED) {
      const reads = nodeLog.filter((url) =>
        url.startsWith(`/v1/userDataByFid?fid=${fid}`),
      );
      expect(reads, `fid ${fid} should have been read`).toHaveLength(1);
    }
  });

  it('renders a cast with no mentions exactly as the node stores it', async () => {
    const casts = await authorCasts();
    const plain = casts.find(
      (entry) => entry.hash === '0x53c43981950dbc71203604e48e0aa67efb14d0a2',
    );
    expect(plain?.text).toBe(
      'Habitat 67 by Moshe Safdie in Montreal. \n\nSomewhat miraculously it came from a Master\'s thesis. The idea was to merge the benefits of suburban life (fresh air, personal "back yard") with that of city life.',
    );
    expect(plain?.mentions).toBeUndefined();
  });
});
