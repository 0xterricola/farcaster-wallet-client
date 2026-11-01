/**
 * The four reads the 501 sweep left unwired, and the sentences the adapter must
 * never show again.
 *
 * The first pass of the sweep (2026-10-22) classified more endpoints than it
 * wired, so three surfaces still answered with the adapter's own fallback
 * ("this read has no reader wired up in this app") — which is the same bug to a
 * reader as the sentence that was reported, in new words. These tests hold each
 * of those reads to what it actually returns, and hold the fallback out of the
 * routing table.
 *
 * The node is the fixture-backed fake (`fakeNodeFetch`): real recorded pages for
 * fid 3, plus a declared fallback wherever a test needs a page the recordings do
 * not contain. Nothing here invents a node answer to make a test pass — the
 * fallback is stated at the call site.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createNodeBackedFetch } from '~/snapchain/nodeApi';
import { classifyHostedRequest } from '~/snapchain/nodeApi/hostedRoutes';
import { SNAPS_CHANNEL_PARENT_URL } from '~/snapchain/nodeApi/reads';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import {
  createFixtureNodeFetch,
  type FixtureNodeOptions,
} from './fakeNodeFetch';

type Json = Record<string, unknown>;

const fixture = (name: string): Json =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Json;

/** The fids of a recorded page of link messages, by the field that matters. */
const linkFids = (name: string, field: 'author' | 'target'): number[] =>
  (
    fixture(name).messages as {
      data: { fid: number; linkBody?: { targetFid?: number } };
    }[]
  )
    .filter((message) => message.data.linkBody)
    .map((message) =>
      field === 'author'
        ? message.data.fid
        : (message.data.linkBody?.targetFid ?? 0),
    );

const buildHarness = ({
  fid = 3,
  fallback,
}: {
  fid?: number;
  fallback?: FixtureNodeOptions['fallback'];
} = {}) => {
  const log: string[] = [];
  const handle = createNodeBackedFetch({
    nodeBaseUrl: 'http://node.test',
    embedKinds: offlineEmbedKinds(),
    getSignedInFid: () => fid,
    fetchImpl: createFixtureNodeFetch({ log, fallback }),
  });
  return { fetch: handle.fetch, log };
};

const json = async (response: Response): Promise<Json> =>
  (await response.json()) as Json;

const usersOf = (body: Json): { fid: number }[] =>
  (body.result as { users: { fid: number }[] }).users;

describe('the reads the sweep left unwired', () => {
  it('answers /v2/followers-you-know with the intersection of two node reads', async () => {
    // The viewer is fid 3, and who it follows is the recorded `linksByFid` page
    // — the same read /v2/following is served from. The recorded page of fid
    // 3's own followers (`linksByTargetFid.fid3.follow.json`) shares no account
    // with it (MEASURED on the fixtures: 20 follows, 40 followers, empty
    // intersection), so the second half is a page this test states: two of the
    // accounts the viewer follows, plus one account that follows fid 3 and the
    // viewer does not follow.
    const iFollow = linkFids('linksByFid.fid3.follow.json', 'target');
    expect(iFollow.length).toBeGreaterThan(2);
    const both = iFollow.slice(0, 2);
    const followerOnly = 999_999;
    const followerPage = {
      messages: [...both, followerOnly].map((fid) => ({
        hash: `0x${String(fid).padStart(8, '0')}`,
        data: {
          type: 'MESSAGE_TYPE_LINK_ADD',
          fid,
          timestamp: 100,
          linkBody: { type: 'follow', targetFid: 3 },
        },
      })),
      nextPageToken: 'W251bGwsbnVsbF0=',
    };

    const { fetch: nodeBackedFetch } = buildHarness({
      // One page, stated twice over: the follower half above, and the same
      // account's user data for every account the intersection holds (the
      // readings carry one account's user data; the fid on each answer is the
      // account asked about, so nothing borrows another account's identity).
      fallback: ({ path, params }) =>
        path === '/v1/linksByTargetFid'
          ? followerPage
          : path === '/v1/userDataByFid' && params.get('fid') !== null
            ? fixture('userDataByFid.fid3.json')
            : undefined,
    });

    const response = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/followers-you-know?fid=3&limit=25',
    );
    expect(response.status).toBe(200);

    const body = await json(response);
    const returned = usersOf(body).map((user) => user.fid);
    // Both halves of every answer are the node's own edges: each account
    // returned is followed by fid 3 AND follows fid 3 — so the account that
    // only follows fid 3 is not among them, and neither is anyone else.
    expect(returned).toEqual(both);
    expect((body.result as { totalCount: number }).totalCount).toBe(
      both.length,
    );
  });

  it('answers /v2/profile-snap-casts with the casts whose parent is the snaps channel', async () => {
    const snap = {
      hash: '0xsnap',
      data: {
        type: 'MESSAGE_TYPE_CAST_ADD',
        fid: 3,
        timestamp: 100,
        castAddBody: { text: 'a snap', parentUrl: SNAPS_CHANNEL_PARENT_URL },
      },
    };
    const ordinary = {
      hash: '0xordinary',
      data: {
        type: 'MESSAGE_TYPE_CAST_ADD',
        fid: 3,
        timestamp: 200,
        castAddBody: { text: 'just a cast' },
      },
    };

    const { fetch: nodeBackedFetch } = buildHarness({
      fallback: ({ path, params }) =>
        path === '/v1/castsByFid' && params.get('fid') === '3'
          ? { messages: [snap, ordinary], nextPageToken: 'W251bGwsbnVsbF0=' }
          : path === '/v1/userDataByFid' && params.get('fid') !== null
            ? fixture('userDataByFid.fid3.json')
            : undefined,
    });

    const body = await json(
      await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/profile-snap-casts?fid=3&limit=15',
      ),
    );
    const casts = (body.result as { casts: { hash: string }[] }).casts;
    expect(casts.map((cast) => cast.hash)).toEqual(['0xsnap']);
  });

  it('fills a notification group the notifications tab itself builds', async () => {
    const { fetch: nodeBackedFetch } = buildHarness();

    const body = await json(
      await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/notification-group?groupId=mentions:3&type=cast-mention',
      ),
    );
    const notifications = (body.result as { notifications: { type: string }[] })
      .notifications;
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.every((item) => item.type === 'cast-mention')).toBe(
      true,
    );
  });

  it('refuses a group the node cannot hold, in words naming the missing service', async () => {
    const { fetch: nodeBackedFetch } = buildHarness();

    const empty = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/notification-group?type=mini-app',
    );
    expect(empty.status).toBe(501);
    const emptyBody = await json(empty);
    const emptyMessage = (emptyBody.errors as { message: string }[])[0]
      ?.message;
    expect(emptyMessage).toContain('needs a notification group id');

    const hosted = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v2/notification-group?groupId=mini-app:3&type=mini-app',
    );
    expect(hosted.status).toBe(501);
    const hostedMessage = (
      (await json(hosted)).errors as { message: string }[]
    )[0]?.message;
    expect(hostedMessage).toContain('Warpcast’s own notification service');
  });
});

describe('the adapter never has an unclassified endpoint to fall back to', () => {
  const FALLBACK =
    /no node-backed reader has been written|isn’t something your node keeps, and no reader here answers it|this has no reader wired up in this app|this read has no reader wired up in this app/i;

  // Every endpoint the second full sweep watched, including the ones that were
  // still wearing the fallback sentence when it ran.
  const SWEPT: [string, string][] = [
    ['GET', '/v2/followers-you-know'],
    ['GET', '/v2/channel-followers-you-know'],
    ['GET', '/v2/notification-group'],
    ['GET', '/v2/profile-snap-casts'],
    ['GET', '/v2/rent-storage-offerings'],
    ['GET', '/v2/starter-packs/suggested'],
    ['GET', '/v1/audio-room'],
    ['GET', '/v1/domain-manifest'],
    ['PATCH', '/v2/user-preferences'],
    ['POST', '/v1/analytics-events'],
  ];

  it.each(SWEPT)('names %s %s in the routing table', (method, path) => {
    const classified = classifyHostedRequest({ method, path });
    expect(classified.kind).not.toBeUndefined();
    expect(classified.why).not.toMatch(FALLBACK);
  });

  it('holds the fallback out of a path nobody has classified at all', () => {
    // The last resort still exists — it must, or an unknown endpoint would be
    // answered with an invented payload — but it is the only path that wears
    // this sentence, and no surface's own endpoint is it any more.
    const unknown = classifyHostedRequest({
      method: 'GET',
      path: '/v2/nothing-here',
    });
    expect(unknown.why).toMatch(FALLBACK);
  });
});
