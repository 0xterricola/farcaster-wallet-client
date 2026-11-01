/**
 * The recasts and likes a conversation's action row paints, read from a node.
 *
 * MEASURED (t_fb198c05, a live public read node): `/v1/reactionsByCast` pages
 * both kinds — a terminal page of 186 recast messages, like pages of 200 with
 * more to follow — so "who recast this" and "who liked this" are node reads,
 * and the two tabs a focused cast paints have real readers. These tests hold
 * that contract against recorded node pages:
 *
 *   - the lists come back in the hosted API's shape, paged by the node's own
 *     page token;
 *   - a hash the reader has no author for is said in words, not answered with
 *     a list that would read as "nobody reacted";
 *   - quotes stay refused with the sentence that names whose job they are —
 *     a node keeps no reverse index from a cast to its quoters (every such
 *     shape answered 404 on the same probe), and an honest "no" beats a fake
 *     list.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createNodeBackedFetch, forgetCastAuthors } from '~/snapchain/nodeApi';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import { createFixtureNodeFetch } from './fakeNodeFetch';

type Json = Record<string, unknown>;

const fixture = (name: string): Json =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Json;

/** The cast the origin's author index knows: the recorded cast, fid 3. */
const RECORDED_CAST_HASH = '0x0256ae66308d546514fa666cda44052abbfea066';
const BASE = 'https://farcaster.xyz/~api';

interface Harness {
  fetch: typeof fetch;
  nodeLog: string[];
}

const buildHarness = (): Harness => {
  const nodeLog: string[] = [];
  const handle = createNodeBackedFetch({
    nodeBaseUrl: 'http://node.test',
    embedKinds: offlineEmbedKinds(),
    getSignedInFid: () => 3,
    fetchImpl: createFixtureNodeFetch({ log: nodeLog }),
  });
  return { fetch: handle.fetch, nodeLog };
};

const json = async (response: Response): Promise<Json> =>
  (await response.json()) as Json;

const errorMessages = async (response: Response): Promise<string[]> =>
  ((await json(response)).errors as { message: string }[]).map(
    (error) => error.message,
  );

const reactorFidsOf = (name: string): number[] =>
  (
    fixture(name).messages as {
      data: { fid: number; reactionBody: { type: string } };
    }[]
  ).map((message) => message.data.fid);

describe('the recasts and likes tabs, answered by a node', () => {
  it('answers /v2/cast-recasters with the accounts that recast the cast', async () => {
    const { fetch: nodeBackedFetch } = buildHarness();
    const response = await nodeBackedFetch(
      `${BASE}/v2/cast-recasters?castHash=${RECORDED_CAST_HASH}&limit=15`,
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    const users = (body.result as { users: { fid: number }[] }).users;

    // The recorded recast page, in page order, one row per reactor.
    expect(users.map((user) => user.fid)).toEqual(
      reactorFidsOf('reactionsByCast.recast.sample.json'),
    );
    // The fixture's page has more to follow, so the answer carries the node's
    // own page token back to the client as its cursor.
    expect((body.next as { cursor?: string }).cursor).toBe(
      fixture('reactionsByCast.recast.sample.json').nextPageToken as string,
    );
  });

  it('answers /v2/cast-likes with the likes on the cast, in the fork shape', async () => {
    const { fetch: nodeBackedFetch } = buildHarness();
    const response = await nodeBackedFetch(
      `${BASE}/v2/cast-likes?castHash=${RECORDED_CAST_HASH}&limit=15`,
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    const likes = (
      body.result as {
        likes: {
          type: string;
          hash: string;
          castHash: string;
          timestamp: number;
          reactor: { fid: number };
        }[];
      }
    ).likes;

    const expected = reactorFidsOf('reactionsByCast.sample.json');
    expect(likes).toHaveLength(expected.length);
    for (const [index, like] of likes.entries()) {
      expect(like.type).toBe('like');
      expect(like.reactor.fid).toBe(expected[index]);
      expect(like.castHash).toBe(RECORDED_CAST_HASH);
      expect(typeof like.timestamp).toBe('number');
    }
  });

  it('pages a second request by the cursor the first one returned', async () => {
    const { fetch: nodeBackedFetch, nodeLog } = buildHarness();
    const first = await nodeBackedFetch(
      `${BASE}/v2/cast-likes?castHash=${RECORDED_CAST_HASH}&limit=15`,
    );
    const cursor = ((await json(first)).next as { cursor?: string }).cursor;
    expect(cursor).toBeTruthy();

    const second = await nodeBackedFetch(
      `${BASE}/v2/cast-likes?castHash=${RECORDED_CAST_HASH}&limit=15&cursor=${encodeURIComponent(cursor as string)}`,
    );
    const body = await json(second);

    // One page was recorded: the page after it is empty and terminal, so the
    // answer says there is nothing next — never a repeated page.
    expect((body.result as { likes: unknown[] }).likes).toEqual([]);
    expect((body.next as { cursor?: string }).cursor).toBeUndefined();
    expect(
      nodeLog.some((entry) =>
        entry.includes(`pageToken=${encodeURIComponent(cursor as string)}`),
      ),
    ).toBe(true);
  });

  it('asks the author once, then serves the other tab from memory', async () => {
    forgetCastAuthors();
    const { fetch: nodeBackedFetch, nodeLog } = buildHarness();
    for (const path of ['/v2/cast-recasters', '/v2/cast-likes']) {
      await nodeBackedFetch(
        `${BASE}${path}?castHash=${RECORDED_CAST_HASH}&limit=15`,
      );
    }

    const authorLookups = nodeLog.filter((entry) =>
      entry.includes('/unfurl/cast-author/'),
    );
    expect(authorLookups).toHaveLength(1);
    // And the cast itself was read once, not once per tab.
    expect(
      nodeLog.filter((entry) => entry.includes('/v1/castById')).length,
    ).toBe(1);
  });

  it('says in words when it has no author for a bare hash', async () => {
    forgetCastAuthors();
    const { fetch: nodeBackedFetch } = buildHarness();
    const neverServed = `0x${'f'.repeat(40)}`;
    const response = await nodeBackedFetch(
      `${BASE}/v2/cast-recasters?castHash=${neverServed}&limit=15`,
    );

    // The hosted API's error envelope, so the page's own words paint.
    expect(response.status).toBe(501);
    const [message] = await errorMessages(response);
    expect(message).toMatch(/only has the hash/i);
  });
});

describe('the prefix-addressed cast page, and the read no node keeps', () => {
  it('reads the cast a prefix page asks for from the account’s own casts', async () => {
    const { fetch: nodeBackedFetch } = buildHarness();
    const response = await nodeBackedFetch(
      `${BASE}/v2/user-cast?username=dwr&hashPrefix=0x0256ae66`,
    );

    // A node shards casts by author, so the account is resolved first and its
    // own casts walked for the prefix — the page's cast, not an invented one.
    expect(response.status).toBe(200);
    const body = await json(response);
    expect((body.result as { cast: { hash: string } }).cast.hash).toBe(
      RECORDED_CAST_HASH,
    );
  });

  it('says in words when no cast of that account starts with those characters', async () => {
    const { fetch: nodeBackedFetch } = buildHarness();
    const response = await nodeBackedFetch(
      `${BASE}/v2/user-cast?username=dwr&hashPrefix=0x${'f'.repeat(10)}`,
    );

    expect(response.status).toBe(404);
    const [message] = await errorMessages(response);
    expect(message).toMatch(
      /no cast of that account starting with those characters/i,
    );
  });

  it('refuses /v2/cast-quotes with the sentence that names whose job it is', async () => {
    const { fetch: nodeBackedFetch, nodeLog } = buildHarness();
    const response = await nodeBackedFetch(
      `${BASE}/v2/cast-quotes?castHash=${RECORDED_CAST_HASH}&limit=15`,
    );

    expect(response.status).toBe(501);
    const [message] = await errorMessages(response);
    // The sentence names the index that IS the right machine for this read, and
    // still says what a node keeps none of: the 501 sweep reclassified quotes as
    // an index read (`hostedRoutes.ts` INDEX_ROUTES), which is the same honest
    // "no" in words rather than the adapter's own shrug.
    expect(message).toMatch(/index of embeds|indexer/i);
    expect(message).not.toMatch(/no node-backed reader has been written yet/i);
    // Refused in place: nothing was asked of the node at all.
    expect(nodeLog).toEqual([]);
  });
});
