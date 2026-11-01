/**
 * What a cast-shaped read is allowed to ask the node, and what a profile-shaped
 * read is still allowed to ask — measured, not asserted in prose.
 *
 * THE USER REPORT (2026-10-22, the live client): after a sign-in, casts took
 * ~29s at 1440 and ~27s at 390 to paint. The timeline of that run says where the
 * wall clock went: 98 `/v1/linksByTargetFid` and 120 `/v1/linksByFid` requests —
 * 232 seconds of request time — all of it the per-author follower/following
 * *counting* that the feed did to draw casts that render neither number.
 *
 * So the split these tests pin is:
 *
 *   - a cast-shaped account (a feed author, a mention, a notification's actor,
 *     a quoted cast's author) is read with its user data and ONE `/v1/linkById`
 *     for the viewer's follow edge, and its followers are never counted;
 *   - a profile-shaped account (`/v2/user`, `/v2/me`, a search result, `useUser`)
 *     still counts, exactly as before, because those surfaces render the number.
 *
 * If a future change lets counting back into the cast path, the first test here
 * goes red rather than the feed going slow again.
 */

import { type FetchLike, SnapchainNodeClient } from 'farcaster-node-client';
import { describe, expect, it } from 'vitest';

import { createNodeBackedFetch, NodeBackedReads } from '~/snapchain/nodeApi';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch, type FakeNodeRequest } from './fakeNodeFetch';

type Json = Record<string, unknown>;

/** An account nobody signed in as, so the follow edge is a real question. */
const OTHER_AUTHOR = 327154;

const buildHarness = ({
  fid = 3,
  answerFollowEdge = false,
}: {
  fid?: number;
  answerFollowEdge?: boolean;
} = {}) => {
  const log: string[] = [];
  const fetchImpl = createFixtureNodeFetch({
    log,
    // `/v1/linkById` has no recorded page: a node answers 404 (or a 400 whose
    // detail says NotFound) for an edge that is not in its state, which is the
    // answer "no". `answerFollowEdge` turns it into a real link-add message.
    fallback: (request: FakeNodeRequest) =>
      answerFollowEdge && request.path === '/v1/linkById'
        ? { data: { type: 'MESSAGE_TYPE_LINK_ADD', fid } }
        : undefined,
  });

  const nodeBaseUrl = 'http://node.test';
  const reads = new NodeBackedReads({
    // The node client's fetch signature is narrower than the platform's (a
    // string URL, a `Uint8Array` body); a platform `fetch` satisfies it at
    // runtime, and the fake does here. Same cast as the real seam.
    node: new SnapchainNodeClient({
      baseUrl: nodeBaseUrl,
      fetch: fetchImpl as unknown as FetchLike,
    }),
    nodeBaseUrl,
    fetchImpl,
    embedKinds: offlineEmbedKinds(),
    getSignedInFid: () => fid,
  });

  return { log, reads };
};

/**
 * The reads that COUNT a follow graph, as opposed to the read that IS one.
 *
 * `/v1/linksByFid` appears in both, so the page size is what tells them apart:
 * the follow graph is read at 100 (the read the feed legitimately needs), and a
 * count pages at 1000 until it reaches the cap. A follower count is always
 * `/v1/linksByTargetFid`.
 */
const countingReads = (log: string[]) =>
  log.filter(
    (entry) =>
      entry.startsWith('/v1/linksByTargetFid') ||
      (entry.startsWith('/v1/linksByFid') && entry.includes('pageSize=1000')),
  );

describe('a cast-shaped account is not counted', () => {
  it('reads a cast author with user data and one follow-edge lookup', async () => {
    const { log, reads } = buildHarness();
    const user = await reads.readAuthor(OTHER_AUTHOR);

    // Who they are, from their own user-data messages.
    expect(user.fid).toBe(OTHER_AUTHOR);
    // The handle is the account's own, from the recorded user-data page.
    expect(user.username).toBe('chancetaken');
    expect(
      log.some((entry) => entry.startsWith('/v1/userDataByFid?fid=327154')),
    ).toBe(true);

    // The viewer's follow edge, asked as the question it is.
    expect(
      log.some(
        (entry) =>
          entry.startsWith('/v1/linkById') &&
          entry.includes('fid=3') &&
          entry.includes('target_fid=327154'),
      ),
    ).toBe(true);

    // And no counting, on either side of the edge.
    expect(countingReads(log)).toEqual([]);

    // The number is not read, so it is not claimed: the fork's `ApiUser` type
    // has no way to say "not read", and no surface that renders a count may use
    // a cast's author (see readAuthor).
    expect(user.followerCount).toBe(0);
    expect(user.followingCount).toBe(0);
  });

  it('carries the follow edge the node answered', async () => {
    const followed = buildHarness({ answerFollowEdge: true });
    expect(
      (await followed.reads.readAuthor(OTHER_AUTHOR)).viewerContext,
    ).toEqual({
      following: true,
    });

    // A node that has no such edge says "no" (the fake answers 404 here, which
    // is what a live node answers for a link that is not in its state).
    const absent = buildHarness();
    expect((await absent.reads.readAuthor(OTHER_AUTHOR)).viewerContext).toEqual(
      {
        following: false,
      },
    );
  });

  it('reads an author once, then answers from memory', async () => {
    const { log, reads } = buildHarness();
    await reads.readAuthor(OTHER_AUTHOR);
    const afterFirst = log.length;
    await reads.readAuthor(OTHER_AUTHOR);

    expect(log.length).toBe(afterFirst);
  });

  it('never asks the same author’s follow edge of itself', async () => {
    const { log, reads } = buildHarness();
    await reads.readAuthor(3);

    expect(log.some((entry) => entry.startsWith('/v1/linkById'))).toBe(false);
    expect(countingReads(log)).toEqual([]);
  });
});

describe('a profile-shaped account is still counted', () => {
  it('counts followers and following for /v2/user', async () => {
    const { log, reads } = buildHarness();
    const user = await reads.readUser(OTHER_AUTHOR);

    expect(log.some((entry) => entry.startsWith('/v1/linksByTargetFid'))).toBe(
      true,
    );
    expect(log.some((entry) => entry.startsWith('/v1/linksByFid'))).toBe(true);
    expect(user.followerCount).toBeGreaterThanOrEqual(0);
  });

  it('keeps the two answers apart: a counted profile is not a cast author', async () => {
    const { log, reads } = buildHarness();
    await reads.readAuthor(OTHER_AUTHOR);
    const afterAuthor = log.length;

    // The profile-shaped read does its own counting rather than being served the
    // cast-shaped answer from the author cache.
    await reads.readUser(OTHER_AUTHOR);
    expect(countingReads(log.slice(afterAuthor)).length).toBeGreaterThan(0);
  });
});

describe('the home feed does not count the accounts it draws', () => {
  it('answers POST /v2/feed-items without one counting read', async () => {
    const nodeLog: string[] = [];
    const handle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      embedKinds: offlineEmbedKinds(),
      getSignedInFid: () => 3,
      fetchImpl: createFixtureNodeFetch({ log: nodeLog }),
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/feed-items',
      {
        method: 'POST',
        body: JSON.stringify({
          feedKey: 'home',
          feedType: 'default',
          updateState: true,
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;
    const items = (body.result as { items: { cast: Json }[] }).items;
    expect(items.length).toBeGreaterThan(0);

    // The read really happened (so an empty log cannot pass this by accident)…
    expect(nodeLog.some((entry) => entry.startsWith('/v1/castsByFid'))).toBe(
      true,
    );
    // …and none of it was counting followers.
    expect(countingReads(nodeLog)).toEqual([]);
  });
});
