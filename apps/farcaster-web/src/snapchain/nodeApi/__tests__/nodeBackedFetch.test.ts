/**
 * The adapter's contract, against recorded real node pages.
 *
 * These tests assert the three things the signed-in surfaces need:
 *   1. a request the node can answer comes back in the hosted API's shape,
 *   2. a request the node cannot answer says so, and never pretends,
 *   3. the classification never sends a hosted-only read to the node at all.
 *
 * The fixtures are real pages from a live public read node (see fakeNodeFetch).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createNodeBackedFetch, forgetCastAuthors } from '~/snapchain/nodeApi';

import { offlineEmbedKinds } from './fakeEmbedKinds';
import {
  CAST_AUTHOR_PATH,
  createFixtureNodeFetch,
  TERMINAL_PAGE_TOKEN,
} from './fakeNodeFetch';

type Json = Record<string, unknown>;

const fixture = (name: string): Json =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as Json;

interface Harness {
  fetch: typeof fetch;
  log: string[];
}

const buildHarness = ({ fid }: { fid?: number } = { fid: 3 }): Harness => {
  const nodeLog: string[] = [];
  const handle = createNodeBackedFetch({
    nodeBaseUrl: 'http://node.test',
    embedKinds: offlineEmbedKinds(),
    getSignedInFid: () => fid,
    fetchImpl: createFixtureNodeFetch({ log: nodeLog }),
  });

  return { fetch: handle.fetch, log: nodeLog };
};

const json = async (response: Response): Promise<Json> =>
  (await response.json()) as Json;

const messagesOf = (
  name: string,
): { hash: string; text: string; timestampMs: number }[] =>
  (
    fixture(name).messages as {
      hash: string;
      data: { timestamp: number; castAddBody?: { text: string } };
    }[]
  )
    .filter((message) => message.data.castAddBody)
    .map((message) => ({
      hash: message.hash,
      text: message.data.castAddBody?.text ?? '',
      // Farcaster epoch (2021-01-01) seconds → Unix ms.
      timestampMs: message.data.timestamp * 1000 + 1609459200000,
    }));

describe('the node-backed fetch', () => {
  describe('the home feed', () => {
    it('answers POST /v2/feed-items with real casts from the node', async () => {
      const { fetch: nodeBackedFetch, log } = buildHarness();

      const response = await nodeBackedFetch(
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
      const body = await json(response);
      const result = body.result as { items: { id: string; cast: Json }[] };

      expect(result.items.length).toBeGreaterThan(0);

      const expected = messagesOf('castsByFid.fid3.json').sort(
        (a, b) => b.timestampMs - a.timestampMs,
      );
      const first = result.items[0]!;
      expect(first.id).toBe(expected[0]!.hash);
      expect((first.cast as { text: string }).text).toBe(expected[0]!.text);
      expect((first.cast as { author: { fid: number } }).author.fid).toBe(3);
      expect((first.cast as { timestamp: number }).timestamp).toBe(
        expected[0]!.timestampMs,
      );

      // The read really went to the node's own routes.
      // The feed's per-author read is bounded to 10 casts (measured: 25 was part
      // of a ~55s first page); the merge below still takes the newest 25.
      expect(log).toContain('/v1/castsByFid?fid=3&pageSize=10&reverse=true');
      expect(
        log.some((entry) => entry.startsWith('/v1/linksByFid?fid=3')),
      ).toBe(true);
    });

    it('refuses a ranked feed instead of serving the follow graph under its name', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const response = await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/feed-items',
        {
          method: 'POST',
          body: JSON.stringify({ feedKey: 'home', feedType: 'for-you' }),
        },
      );

      expect(response.status).toBe(501);
      const body = await json(response);
      expect(JSON.stringify(body)).toContain('ranking is the indexer’s job');
    });
  });

  describe('profiles', () => {
    it('answers GET /v2/user from user data plus counted links', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const response = await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/user?fid=3',
      );
      const body = await json(response);
      const user = (body.result as { user: Json }).user;

      expect(user.fid).toBe(3);
      // The handle and bio are the account's own user-data messages.
      expect(user.username).toBe('dwr');
      expect(
        (user.profile as { bio: { text: string } }).bio.text.length,
      ).toBeGreaterThan(0);

      // Counts are counted, not invented: they are what the fixture pages hold.
      const followers = fixture('linksByTargetFid.fid3.follow.json')
        .messages as unknown[];
      const following = fixture('linksByFid.fid3.follow.json')
        .messages as unknown[];
      expect(user.followerCount).toBe(followers.length);
      expect(user.followingCount).toBe(following.length);
    });

    it('resolves a handle through the node’s name proof', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const response = await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/user-by-username?username=dwr',
      );
      const body = await json(response);
      expect((body.result as { user: { fid: number } }).user.fid).toBe(3);
    });

    it('answers GET /v2/me with the signed-in account', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const body = await json(
        await nodeBackedFetch('https://farcaster.xyz/~api/v2/me'),
      );
      expect((body.result as { user: { fid: number } }).user.fid).toBe(3);
      expect(
        (body.result as { enabledFeatureFlags: string[] }).enabledFeatureFlags,
      ).toEqual([]);
    });
  });

  describe('verified addresses', () => {
    it('maps the node’s verification messages to the API’s shape', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const body = await json(
        await nodeBackedFetch(
          'https://farcaster.xyz/~api/v2/verifications?fid=2&limit=15',
        ),
      );
      const verifications = (body.result as { verifications: Json[] })
        .verifications;

      const recorded = fixture('verificationsByFid.fid2.json').messages as {
        data: { verificationAddAddressBody?: { address: string } };
      }[];
      expect(verifications.length).toBe(recorded.length);
      expect(verifications[0]!.protocol).toBe('ethereum');
      expect(verifications[0]!.address).toBe(
        recorded[0]!.data.verificationAddAddressBody?.address,
      );
      // The node does not rank them, so this is not claimed.
      expect(verifications[0]!.isPrimary).toBe(false);
    });
  });

  describe('a thread', () => {
    it('answers with the cast and its replies once the hash has been seen', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();

      // The feed is what teaches the adapter whose cast a hash is: a node
      // shards by FID, so a hash alone cannot be looked up.
      await nodeBackedFetch('https://farcaster.xyz/~api/v2/feed-items', {
        method: 'POST',
        body: JSON.stringify({ feedKey: 'home', feedType: 'default' }),
      });

      const hash = messagesOf('castsByFid.fid3.json')[0]!.hash;
      const response = await nodeBackedFetch(
        `https://farcaster.xyz/~api/v2/thread-casts?castHash=${hash}&limit=15`,
      );

      expect(response.status).toBe(200);
      const body = await json(response);
      const casts = (body.result as { casts: { hash: string }[] }).casts;
      expect(casts.some((cast) => cast.hash === hash)).toBe(true);
      expect(casts.length).toBeGreaterThan(1);
    });

    it('opens a shared cast link by asking this origin who wrote it', async () => {
      // Nothing has been read yet: this is a reader who just opened a link —
      // exactly the case the memo cannot cover, and the reason the origin has
      // an author index at all (`castAuthorHandoff.ts`, served by
      // `server/unfurl/` in the release). The memo is module-wide and the tests
      // above filled it by reading their feeds, so it is emptied first: a test
      // that claimed "a reader who has served nothing" without doing this would
      // pass on somebody else's read.
      forgetCastAuthors();
      const { fetch: nodeBackedFetch, log } = buildHarness();

      const hash = messagesOf('castsByFid.fid3.json')[0]!.hash;
      const response = await nodeBackedFetch(
        `https://farcaster.xyz/~api/v2/thread-casts?castHash=${hash}&limit=15`,
      );

      expect(log).toContain(`${CAST_AUTHOR_PATH}${hash}`);
      expect(response.status).toBe(200);
      const body = await json(response);
      const casts = (body.result as { casts: { hash: string }[] }).casts;
      expect(casts.some((cast) => cast.hash === hash)).toBe(true);
    });

    it('says why a hash it has never served cannot be opened', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const response = await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/thread-casts?castHash=0xdeadbeef&limit=15',
      );

      expect(response.status).toBe(501);
      const body = await json(response);
      expect(JSON.stringify(body)).toContain(
        'addresses a cast by its author and its hash',
      );
    });

    it('says the same when the hash is real but no index knows it', async () => {
      const { fetch: nodeBackedFetch, log } = buildHarness();
      const response = await nodeBackedFetch(
        `https://farcaster.xyz/~api/v2/thread-casts?castHash=0x${'9'.repeat(40)}&limit=15`,
      );

      // Asked, answered 404, and reported in words rather than as a blank page.
      expect(log).toContain(`${CAST_AUTHOR_PATH}0x${'9'.repeat(40)}`);
      expect(response.status).toBe(501);
      expect(JSON.stringify(await json(response))).toContain(
        'addresses a cast by its author and its hash',
      );
    });
  });

  describe('unseen counts', () => {
    it('derives them from mentions and follows, and sums the tab', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const body = await json(
        await nodeBackedFetch('https://farcaster.xyz/~api/v2/unseen'),
      );
      const result = body.result as {
        notificationsCount: number;
        notificationTabs: { tab: string; unseenCount: number }[];
        inboxCount: number;
      };

      const mentions = fixture('castsByMention.fid3.json')
        .messages as unknown[];
      expect(result.notificationsCount).toBeGreaterThanOrEqual(mentions.length);
      expect(
        result.notificationTabs.reduce((sum, tab) => sum + tab.unseenCount, 0),
      ).toBe(result.notificationsCount);
      // Direct messages are not on the node; the count is not invented.
      expect(result.inboxCount).toBe(0);
    });
  });

  describe('what is answered locally', () => {
    it('serves client capabilities and protocol limits', async () => {
      const { fetch: nodeBackedFetch, log } = buildHarness();
      const body = await json(
        await nodeBackedFetch('https://farcaster.xyz/~api/v2/user-app-context'),
      );
      const context = (body.result as { context: Json }).context;

      expect(context.regularCastByteLimit).toBe(320);
      expect(context.notificationTabsV2).toEqual([
        { id: 'default', name: 'All' },
      ]);
      // Nothing was asked of the node for this.
      expect(log).toEqual([]);
    });

    it('serves empty blocklists, because nothing is blocked locally', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const body = await json(
        await nodeBackedFetch('https://farcaster.xyz/~api/v2/snap/blocklist'),
      );
      expect(body.result).toEqual([]);
    });

    it('serves no email preferences rather than a fabricated set', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const body = await json(
        await nodeBackedFetch('https://farcaster.xyz/~api/v2/user-preferences'),
      );
      expect(body.result).toEqual({ preferences: {} });
    });
  });

  describe('what the node cannot answer', () => {
    it('names whose job the ranked feeds are, and touches no node route', async () => {
      const { fetch: nodeBackedFetch, log } = buildHarness();
      const response = await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/explore-feed',
      );

      expect(response.status).toBe(501);
      expect(JSON.stringify(await json(response))).toContain(
        'ranking is an indexer’s job',
      );
      expect(log).toEqual([]);
    });

    it('does not fake a direct-message inbox', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const response = await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/direct-cast-inbox?limit=15&category=default',
      );
      expect(response.status).toBe(501);
      expect(JSON.stringify(await json(response))).toContain('direct messages');
    });

    it('answers an unclassified endpoint honestly instead of with empty data', async () => {
      const { fetch: nodeBackedFetch } = buildHarness();
      const response = await nodeBackedFetch(
        'https://farcaster.xyz/~api/v1/creator-rewards',
      );
      expect(response.status).toBe(501);
      // The sentence is the routing table's own, and it is written for a reader:
      // it names what is missing and why, and never reads like a note to a
      // programmer (the sweep that found 48 shrug surfaces is what changed it).
      const body = JSON.stringify(await json(response));
      expect(body).toContain('Fiddy can’t read /v1/creator-rewards yet');
      expect(body).toContain('Nothing was faked');
    });
  });

  describe('the platform fetch', () => {
    it('gets called with its receiver, so a browser fetch is not an illegal invocation', async () => {
      // MEASURED: with `fetchImpl: fetch` passed straight through, every read
      // came back 502 "your node did not answer" and the console said
      // `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`
      // — `window.fetch` must run with `this === window`. A fake that refuses
      // any other receiver is how that cannot come back.
      const seen: string[] = [];
      const strictFetch = function (this: unknown, input: string) {
        if (this !== globalThis) {
          throw new TypeError(
            "Failed to execute 'fetch' on 'Window': Illegal invocation",
          );
        }
        seen.push(String(input));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [],
              nextPageToken: TERMINAL_PAGE_TOKEN,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      } as unknown as typeof fetch;

      const handle = createNodeBackedFetch({
        nodeBaseUrl: '/snapchain-api',
        embedKinds: offlineEmbedKinds(),
        getSignedInFid: () => 3,
        fetchImpl: strictFetch,
      });

      const response = await handle.fetch(
        'https://farcaster.xyz/~api/v2/user-casts?fid=3',
      );

      expect(response.status).toBe(200);
      expect(seen.length).toBeGreaterThan(0);
    });
  });

  describe('a node that never answers', () => {
    // A node that is black-holed does not refuse: the connection simply never
    // completes. That is the one failure a `fetch` reports only when something
    // aborts it, which is exactly what the adapter's deadlines are for.
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () =>
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener('abort', abort, { once: true });
      })) as unknown as typeof fetch;

    it('answers 502 with how long it waited, instead of leaving the read open', async () => {
      const handle = createNodeBackedFetch({
        nodeBaseUrl: '/snapchain-api',
        embedKinds: offlineEmbedKinds(),
        getSignedInFid: () => 3,
        fetchImpl: hangingFetch,
        readTimeoutMs: 1_000,
      });

      const startedAt = Date.now();
      const response = await handle.fetch(
        'https://farcaster.xyz/~api/v2/user?fid=3',
      );
      const elapsed = Date.now() - startedAt;

      expect(response.status).toBe(502);
      expect(JSON.stringify(await json(response))).toContain(
        'Your node did not answer this read within 1 s.',
      );
      // It waited for its own deadline and no longer.
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(3_000);
    });

    it('stops when the caller’s own deadline fires, without waiting for the node', async () => {
      // The fork's client times every endpoint out itself and passes the signal
      // in; before this change the adapter never looked at it, so the client's
      // promise never settled and the feed stayed in its loading state forever.
      const handle = createNodeBackedFetch({
        nodeBaseUrl: '/snapchain-api',
        embedKinds: offlineEmbedKinds(),
        getSignedInFid: () => 3,
        fetchImpl: hangingFetch,
        readTimeoutMs: 30_000,
      });

      const controller = new AbortController();
      const clientDeadline = setTimeout(() => controller.abort(), 150);

      const startedAt = Date.now();
      const response = await handle.fetch(
        'https://farcaster.xyz/~api/v2/user?fid=3',
        { signal: controller.signal },
      );
      const elapsed = Date.now() - startedAt;
      clearTimeout(clientDeadline);

      expect(response.status).toBe(502);
      expect(JSON.stringify(await json(response))).toContain(
        'did not answer this read within',
      );
      expect(elapsed).toBeLessThan(2_000);
    });

    it('does not answer the feed with an empty page when no account read succeeded', async () => {
      // MEASURED (the relay pointed at a refused port): every per-author read
      // came back 500, the fan-out swallowed all of them, and the feed answered
      // `200` with zero items — indistinguishable from a quiet follow graph.
      // MEASURED, and the reason this test uses the shared fake at all: the
      // recorded follow page carries a live `nextPageToken`, so a hand-rolled
      // stub that keeps answering with it makes the follow-graph read paginate
      // for ever — the test spun a core at ~95% and never finished.
      // `createFixtureNodeFetch` answers one page and then the terminal token,
      // which is what a real node does for an account whose log fits one page.
      const fixtureNode = createFixtureNodeFetch();
      const seen: string[] = [];
      const fetchImpl = ((input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url.slice(0, 90));
        if (url.includes('/v1/linksByFid')) {
          // The fake speaks node-relative paths ('/v1/…'); this adapter is
          // built on the browser's relay path, so strip it first (otherwise the
          // fake answers `404 Not Found` and the fan-out is never reached —
          // measured).
          return fixtureNode(url.replace('/snapchain-api', ''));
        }
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'nothing here' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }) as unknown as typeof fetch;

      const handle = createNodeBackedFetch({
        nodeBaseUrl: '/snapchain-api',
        embedKinds: offlineEmbedKinds(),
        getSignedInFid: () => 3,
        fetchImpl,
      });

      const response = await handle.fetch(
        'https://farcaster.xyz/~api/v2/feed-items',
        {
          method: 'POST',
          body: JSON.stringify({ feedKey: 'home', feedType: 'default' }),
        },
      );

      expect(response.status).toBe(502);
      const body = JSON.stringify(await json(response));
      expect(body, `reads made: ${seen.join(' | ')}`).toContain(
        'Your node did not answer this read',
      );
      expect(body, `reads made: ${seen.join(' | ')}`).toContain('none of the');
      expect(body).not.toContain('"items":[]');
    });
  });

  describe('with no account signed in', () => {
    it('says so, rather than answering with somebody else’s data', async () => {
      const { fetch: nodeBackedFetch } = buildHarness({ fid: undefined });
      const response = await nodeBackedFetch(
        'https://farcaster.xyz/~api/v2/me',
      );
      expect(response.status).toBe(501);
      expect(JSON.stringify(await json(response))).toContain(
        'No account is signed in',
      );
    });
  });
});
