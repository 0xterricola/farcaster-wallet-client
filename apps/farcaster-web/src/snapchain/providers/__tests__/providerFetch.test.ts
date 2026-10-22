/**
 * The routing fetch, as tests — including the one thing that must never happen.
 *
 * The live provider decides where a request goes, and the ways of answering are
 * each checked here: a node-backed read goes to the node the live provider
 * names, Neynar gets its mapped call (and none of this device's session), and
 * Farcaster's own public server — which a page cannot read at all, measured
 * 2026-10-21 — is refused in place instead of being asked. The last test is the
 * security one: this device's session headers are never replayed to a
 * third-party server.
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalDraftStore } from '~/snapchain/nodeApi/localDrafts';
import {
  mediaUploadAnswer,
  type RequestLogEntry,
} from '~/snapchain/nodeApi/nodeBackedFetch';
import {
  farcasterPublicProvider,
  neynarProvider,
  ownNodeProvider,
  publicNodeProvider,
} from '~/snapchain/providers/catalog';
import { createProviderBackedFetch } from '~/snapchain/providers/providerFetch';
import type { NodeProvider } from '~/snapchain/providers/providerTypes';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** A stand-in for the node-backed adapter, so no node client is constructed. */
const stubNodeAdapter = () => {
  const calls: string[] = [];
  const factory = (({ nodeBaseUrl }: { nodeBaseUrl: string }) => {
    return {
      fetch: (async (url: string) => {
        calls.push(url);
        return jsonResponse({ result: { from: nodeBaseUrl } });
      }) as typeof fetch,
      reads: {} as never,
      log: [],
      nodeBaseUrl,
    };
  }) as unknown as typeof import('~/snapchain/nodeApi/nodeBackedFetch').createNodeBackedFetch;
  return { calls, factory };
};

describe('createProviderBackedFetch: a node provider', () => {
  it('sends the read to the live provider’s own address', async () => {
    const { calls, factory } = stubNodeAdapter();
    const provider: NodeProvider = ownNodeProvider('https://mine.example');
    const handle = createProviderBackedFetch({
      getActiveProvider: () => provider,
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: fetch,
      createNodeAdapter: factory,
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/me');

    expect(calls[0]).toContain('/v2/me');
    expect(handle.log[0]).toEqual({
      path: '/v2/me',
      providerId: 'snapchain:https://mine.example',
      kind: 'snapchain',
    });
  });

  it('builds one adapter per address and reuses it', async () => {
    const factory = vi.fn(stubNodeAdapter().factory);
    const provider = ownNodeProvider('https://mine.example');
    const handle = createProviderBackedFetch({
      getActiveProvider: () => provider,
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: fetch,
      createNodeAdapter:
        factory as unknown as typeof import('~/snapchain/nodeApi/nodeBackedFetch').createNodeBackedFetch,
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/me');
    await handle.fetch('https://farcaster.xyz/~api/v2/verifications?fid=3');

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('falls back to the build’s own node before anything has been measured', async () => {
    const { calls, factory } = stubNodeAdapter();
    const handle = createProviderBackedFetch({
      getActiveProvider: () => null,
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: fetch,
      createNodeAdapter: factory,
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/me');

    expect(calls.length).toBe(1);
    expect(handle.log[0]!.providerId).toBe('build-configured');
  });
});

describe('createProviderBackedFetch: Farcaster’s own public server', () => {
  // MEASURED (2026-10-21, the live site): a page on another origin cannot read
  // that server at all — every `/v1/**` and `/v2/**` path answers `Vary: Origin`
  // and no `Access-Control-Allow-Origin`, so the client's reads came back CORS
  // failures ("Failed to fetch") twice a minute. The seam now refuses them in
  // place; the tests below are the ones that would catch a regression to asking.

  const handleWith = (
    fetchImpl: typeof fetch,
    onRead?: (providerId: string, ok: boolean) => void,
  ) =>
    createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl,
      ...(onRead ? { onRead } : {}),
    });

  // A route the table classifies `node` is a read a node assembles — and it is
  // read from a node, whichever server happens to be live. It used to be refused
  // in place while this server was live (with the honest sentence below, which
  // the reader cannot act on); the reader's own list holds a node behind this
  // one, so the read answers there instead.
  it('reads a route only a node can assemble from a node, and never asks this server', async () => {
    const { calls, factory } = stubNodeAdapter();
    const node = publicNodeProvider('https://relay.example');
    const direct: string[] = [];
    const reads: { providerId: string; ok: boolean }[] = [];
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async (url: string) => {
        direct.push(String(url));
        return jsonResponse({ result: {} });
      }) as unknown as typeof fetch,
      createNodeAdapter: factory,
      getProviderOrder: () => [farcasterPublicProvider(), node],
      onRead: (providerId, ok) => reads.push({ providerId, ok }),
    });

    const response = await handle.fetch('https://farcaster.xyz/~api/v2/unseen');

    expect(response.status).toBe(200);
    expect(calls[0]).toContain('/v2/unseen');
    // Nothing left the page for that server's origin: it cannot be read from a
    // page at all, which is what this test has always pinned.
    expect(direct).toEqual([]);
    expect(handle.log[0]).toEqual({
      path: '/v2/unseen',
      providerId: node.id,
      kind: 'snapchain',
    });
    // The engine is told which server really answered this read.
    expect(reads).toEqual([{ providerId: node.id, ok: true }]);
  });

  it('reads the sweep’s other node routes from a node too, and never asks this server', async () => {
    // The 501 sweep (2026-10-22) found these surfaces shrugging for want of a
    // reader. They are routes only a node assembles — follow links, reaction
    // messages, one account's cast and its thread — so a live server that is
    // not a node must not be asked for them, and the node behind it answers.
    const routes = [
      '/v2/followers?fid=3&limit=25',
      '/v2/following?fid=3&limit=25',
      '/v2/cast-likes?castHash=0x5018&limit=25',
      '/v2/cast-recasters?castHash=0x5018&limit=25',
      '/v2/user-thread-casts?username=dwr&castHashPrefix=0x5018',
    ];

    for (const route of routes) {
      const { calls, factory } = stubNodeAdapter();
      const node = publicNodeProvider('https://relay.example');
      const direct: string[] = [];
      const handle = createProviderBackedFetch({
        getActiveProvider: () => farcasterPublicProvider(),
        getSignedInFid: () => 3,
        nodeBaseUrl: '/snapchain-api',
        fetchImpl: (async (url: string) => {
          direct.push(String(url));
          return jsonResponse({ result: {} });
        }) as unknown as typeof fetch,
        createNodeAdapter: factory,
        getProviderOrder: () => [farcasterPublicProvider(), node],
      });

      const response = await handle.fetch(`https://farcaster.xyz/~api${route}`);
      const path = route.split('?')[0]!;

      expect(response.status).toBe(200);
      expect(calls[0]).toContain(path);
      expect(direct).toEqual([]);
      expect(handle.log[0]).toEqual({
        path,
        providerId: node.id,
        kind: 'snapchain',
      });
    }
  });

  it('does not ask it for a hosted feature either — the classification already says whose job it is', async () => {
    const calls: string[] = [];
    const handle = handleWith((async (url: string) => {
      calls.push(String(url));
      return jsonResponse({ result: {} });
    }) as unknown as typeof fetch);

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v1/audio-rooms',
    );

    expect(calls).toEqual([]);
    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain(
      'audio rooms are a hosted product, not protocol messages',
    );
    expect(body.errors[0]!.message).toContain('cannot be read from a web page');
  });

  it('counts the refusal as a read that did not answer, so the engine can move on', async () => {
    const reads: { providerId: string; ok: boolean }[] = [];
    const handle = handleWith(
      (async () => jsonResponse({})) as unknown as typeof fetch,
      (providerId, ok) => reads.push({ providerId, ok }),
    );

    // A read this server really would have been asked for: a node cannot serve
    // this one either (it is a hosted feature), so the refusal stands and the
    // engine is told the read did not answer. A route the table calls `node` is
    // no longer part of this list — it is answered from a node above.
    await handle.fetch('https://farcaster.xyz/~api/v1/audio-rooms');

    expect(reads).toEqual([{ providerId: 'farcaster-public', ok: false }]);
  });

  // The home feed is the read this server must never be asked to answer.
  //
  // MEASURED (2026-10-21, live public node, `farcaster-public` live): a cold load
  // or a reload of `/` put this server's own refusal — `POST /v2/feed-items is a
  // write, and Farcaster's own public server does not take writes from this
  // client` — where the whole home column should be, and it stayed there for the
  // whole 60s budget and 20s past it. `POST /v2/feed-items` is the feed the
  // hosted API spells as a write and the table classifies `node`, because it is
  // assembled from the follow graph (`linksByFid` → `castsByFid`) and from
  // nothing else. No other server in this catalog can serve it, so a provider's
  // refusal must not be able to stand in for it — whichever provider is live.
  it('answers the home feed from a node, not from this server, whichever server is live', async () => {
    const { calls, factory } = stubNodeAdapter();
    const node = ownNodeProvider('https://node.example');
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      createNodeAdapter: factory,
      getProviderOrder: () => [farcasterPublicProvider(), node],
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/feed-items',
      {
        method: 'POST',
        body: JSON.stringify({ feedKey: 'home' }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls[0]).toContain('/v2/feed-items');
    expect(handle.log[0]).toEqual({
      path: '/v2/feed-items',
      providerId: node.id,
      kind: 'snapchain',
    });
  });

  it('answers the home feed from the build’s own node when the list holds no node', async () => {
    const { calls, factory } = stubNodeAdapter();
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      createNodeAdapter: factory,
      getProviderOrder: () => [farcasterPublicProvider()],
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/feed-items',
      {
        method: 'POST',
        body: JSON.stringify({ feedKey: 'home' }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls[0]).toContain('/v2/feed-items');
    expect(handle.log[0]!.providerId).toBe('build-configured');
  });

  it('still refuses a write by name, without asking', async () => {
    const calls: string[] = [];
    const handle = handleWith((async (url: string) => {
      calls.push(String(url));
      return jsonResponse({});
    }) as unknown as typeof fetch);

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/cast-likes',
      {
        method: 'PUT',
        body: JSON.stringify({ castHash: '0x1', liked: true }),
      },
    );

    expect(calls).toEqual([]);
    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('does not take writes');
  });

  // The measurement itself, kept as a test: these are the eleven distinct reads
  // that actually left the live page (https://fiddy.fun, 89cdd01) for
  // api.farcaster.xyz, every one of them refused by the browser, twice a poll.
  // Not one of them may leave the page again — that is the whole fix, and a
  // regression to asking shows up here rather than as 66 console errors in a
  // release probe.
  it('fires nothing at all for the eleven reads the live page was refused', async () => {
    const calls: string[] = [];
    const handle = handleWith((async (url: string) => {
      calls.push(String(url));
      return jsonResponse({ result: {} });
    }) as unknown as typeof fetch);

    const measured = [
      '/v1/audio-rooms',
      '/v1/favorite-frames?limit=20',
      '/v1/get-trending-topics',
      '/v2/highlighted-channels',
      '/v2/direct-cast-inbox?limit=15&category=default',
      '/v2/explore-feed',
      '/v2/feeds',
      '/v2/channel-streaks?fid=3',
      '/v2/user-following-channels?forComposer=true&limit=50',
      // `/v2/unseen` was the eleventh of these, and it is not here any more: it
      // is a route the table classifies `node` (counts derived from mentions,
      // reactions and follows), so it is read from a node now rather than
      // refused — see the node-route test above. The ten left are the ones this
      // client has no other source for.
      //
      // `/v2/user-thread-casts` came off the same list in the 501 sweep
      // (2026-10-22): it is a cast page, and a cast page is one of that
      // account's own casts (`castsByFid`) plus its thread (`castsByParent`) —
      // the node has both, and the adapter now has a reader for it, so the
      // reader behind this server answers it instead of this server refusing.
    ];

    for (const path of measured) {
      const response = await handle.fetch(`https://farcaster.xyz/~api${path}`);
      const body = (await response.json()) as {
        errors: { message: string }[];
      };
      // Every read is answered with a sentence about the read itself…
      expect(body.errors[0]!.message).toContain(
        'cannot be read from a web page',
      );
      // …and never with the browser's own words for a refused request.
      expect(body.errors[0]!.message).not.toContain('Failed to fetch');
      expect(response.status).toBe(501);
    }

    expect(calls).toEqual([]);
    // Each one was routed to that provider and could not be answered by it, so
    // the failover engine still sees eleven failed reads and can move the reader.
    expect(handle.log).toHaveLength(measured.length);
    expect(
      handle.log.every((entry) => entry.providerId === 'farcaster-public'),
    ).toBe(true);
  });
});

describe('createProviderBackedFetch: Neynar', () => {
  it('refuses honestly when the build has no key, and names the setup script', async () => {
    const handle = createProviderBackedFetch({
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      neynarApiKey: null,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/user-by-fid?fid=3',
    );

    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('fiddy-setup.command');
  });

  it('routes the read through the mapper when a key is present', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        users: [{ fid: 3, username: 'dwr', follower_count: 1 }],
      });
    }) as unknown as typeof fetch;

    const handle = createProviderBackedFetch({
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl,
      neynarApiKey: 'a-key',
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/user-by-fid?fid=3',
    );

    expect(calls[0]!.url).toContain(
      'https://api.neynar.com/v2/farcaster/user/bulk?fids=3',
    );
    const body = (await response.json()) as {
      result: { user: { username?: string } };
    };
    expect(body.result.user.username).toBe('dwr');
    expect(handle.log[0]!.kind).toBe('neynar');
  });

  // The security invariant the whole seam exists to keep: this device's session
  // with Fiddy's own API is never replayed to a third-party server. (It used to
  // be checked through Farcaster's public server; that one is now refused in
  // place and asks nothing, so Neynar — the only third party a request still
  // reaches — is where it is checked.)
  it('replays no session to a third-party server', async () => {
    const calls: { init?: RequestInit }[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return jsonResponse({ users: [{ fid: 3, username: 'dwr' }] });
    }) as unknown as typeof fetch;

    const handle = createProviderBackedFetch({
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl,
      neynarApiKey: 'neynar-key',
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/user-by-fid?fid=3', {
      headers: {
        authorization: 'Bearer this-device-session-token',
        cookie: 'fiddy=1',
        'fc-device-id': 'device-1',
      },
    });

    const headers = new Headers(calls[0]!.init?.headers ?? undefined);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('fc-device-id')).toBeNull();
  });
});

/**
 * The media pipeline, where the user-visible failure was.
 *
 * MEASURED (2026-10-21, headless Chrome, the real composer): when the failover
 * engine's live provider was not a node, `POST /v1/generate-image-upload-url`
 * hit that provider's write guard and answered 501 — so the `media` route in the
 * node adapter was never reached and "post a photo" failed exactly as it did
 * before that route existed. These tests hold the answer where it can no longer
 * depend on which provider happens to be live.
 */
describe('createProviderBackedFetch: the media pipeline', () => {
  const MINT = 'https://farcaster.xyz/~api/v1/generate-image-upload-url';

  it('mints OUR upload URL when the live server is one that takes no writes', async () => {
    vi.stubEnv('VITE_FIDDY_MEDIA_URL', 'https://media.test');
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const requestLog: RequestLogEntry[] = [];
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl,
      requestLog,
    });

    const response = await handle.fetch(MINT, { method: 'POST' });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { url: string; optimisticImageId: string };
    };
    expect(body.result.url).toBe('https://media.test/api/fiddy/media');
    expect(typeof body.result.optimisticImageId).toBe('string');
    // The provider was never asked: this is not one of its reads, and its own
    // write guard is exactly what produced the user-visible 501.
    expect(calls).toEqual([]);
    expect(requestLog.at(-1)).toMatchObject({
      method: 'POST',
      path: '/~api/v1/generate-image-upload-url',
      kind: 'media',
      status: 200,
    });
    vi.unstubAllEnvs();
  });

  it('answers the mint itself even when a node is live, so the bytes always reach the same host', async () => {
    const { calls, factory } = stubNodeAdapter();
    const handle = createProviderBackedFetch({
      getActiveProvider: () => ownNodeProvider('https://mine.example'),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: fetch,
      createNodeAdapter: factory,
    });

    const response = await handle.fetch(MINT, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it('both layers give the same mint answer, from one function', async () => {
    const response = mediaUploadAnswer('https://media.test/api/fiddy/media');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: { url: 'https://media.test/api/fiddy/media' },
    });
  });

  it('still refuses a write no reader has been written for, keeping what it carried on the debug surface', async () => {
    vi.stubEnv('VITE_SNAPCHAIN_DEBUG', 'true');
    const embed = 'https://media.test/api/fiddy/media/abc123.png';
    const requestLog: RequestLogEntry[] = [];
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      requestLog,
    });

    const response = await handle.fetch('https://farcaster.xyz/~api/v2/casts', {
      method: 'POST',
      body: JSON.stringify({ text: 'a photo', embeds: [embed] }),
    });

    expect(response.status).toBe(501);
    // The submit is a real write now (it used to be a `hosted` refusal), and
    // this server cannot carry one — so the refusal is that server's own, not a
    // sentence about a reader. What it carried is still on the log, which is
    // what scripts/verify-media-upload.mjs reads.
    expect(requestLog.at(-1)).toMatchObject({
      method: 'POST',
      path: '/~api/v2/casts',
      kind: 'write',
      status: 501,
    });
    // This is how scripts/verify-media-upload.mjs reads the payload a composer
    // built: the request never leaves the page, so the log is the only trace.
    expect(requestLog.at(-1)?.bodyPreview).toContain(embed);
    expect(
      (globalThis as unknown as Record<string, unknown>).__nodeBackedRequests,
    ).toBe(requestLog);
    vi.unstubAllEnvs();
  });
});

/**
 * A cast's submit, at the seam. Both writes of that flow are answered without a
 * provider: the draft is this device's own state, and the refusal to post is
 * one sentence, not whichever write guard the live server happens to have.
 */
describe('createProviderBackedFetch: pressing Cast', () => {
  const STORM = 'https://farcaster.xyz/~api/v2/draft-caststorms';
  const CASTS = 'https://farcaster.xyz/~api/v2/casts';

  const draftStore = () => {
    const map = new Map<string, string>();
    const storage = {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => Array.from(map.keys())[index] ?? null,
      removeItem: (key: string) => {
        map.delete(key);
      },
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    } as Storage;
    return new LocalDraftStore({ storage });
  };

  it('answers the draft write itself when the live server takes no writes', async () => {
    const calls: string[] = [];
    const drafts = draftStore();
    const requestLog: RequestLogEntry[] = [];
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async (url: string) => {
        calls.push(url);
        return jsonResponse({});
      }) as unknown as typeof fetch,
      requestLog,
      drafts,
    });

    const response = await handle.fetch(STORM, {
      method: 'POST',
      body: JSON.stringify({ caststorm: { casts: [{ text: 'kept here' }] } }),
    });

    expect(response.status).toBe(200);
    expect(drafts.caststorms(3)[0]?.casts[0]?.text).toBe('kept here');
    // That provider's own write guard — "POST … is a write" — is exactly what
    // used to run in front of every Cast attempt for a local draft.
    expect(calls).toEqual([]);
    expect(requestLog.at(-1)).toMatchObject({
      method: 'POST',
      path: '/~api/v2/draft-caststorms',
      kind: 'local',
      status: 200,
    });
  });

  it('hands a node that answers the feed the same draft store', async () => {
    const { calls, factory } = stubNodeAdapter();
    const drafts = draftStore();
    const handle = createProviderBackedFetch({
      getActiveProvider: () => ownNodeProvider('https://mine.example'),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: fetch,
      createNodeAdapter: factory,
      drafts,
    });

    // Written while a node was live, read back once the provider changed.
    await handle.fetch(STORM, {
      method: 'POST',
      body: JSON.stringify({
        caststorm: { casts: [{ text: 'mine either way' }] },
      }),
    });

    expect(drafts.caststorms(3)[0]?.casts[0]?.text).toBe('mine either way');
    expect(calls).toEqual([]);
  });

  it('hands a cast to the live server when that server can carry one', async () => {
    // The seam no longer answers the submit itself: a node can carry a write, so
    // the request goes to that node's adapter, which signs it. The signing half
    // is `nodeWrites.test.ts`; this is the routing half.
    const { calls, factory } = stubNodeAdapter();
    const handle = createProviderBackedFetch({
      getActiveProvider: () => ownNodeProvider('https://mine.example'),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      createNodeAdapter: factory,
    });

    await handle.fetch(CASTS, {
      method: 'POST',
      body: JSON.stringify({ text: 'anything' }),
    });

    // It reached a node's own adapter, and nothing refused it on the way.
    expect(calls.length).toBe(1);
  });

  it('refuses a cast on a server that takes no writes, in that server’s own words', async () => {
    const handle = createProviderBackedFetch({
      getActiveProvider: () => farcasterPublicProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });

    const response = await handle.fetch(CASTS, {
      method: 'POST',
      body: JSON.stringify({ text: 'anything' }),
    });

    expect(response.status).toBe(501);
    const body = (await response.json()) as { errors: { message: string }[] };
    expect(body.errors[0]!.message).toContain('does not take writes');
  });
});

describe('createProviderBackedFetch: which server can answer', () => {
  it('sends a read the preferred server cannot serve to one that can', async () => {
    // The heart of "Neynar is the default": Neynar's index has profiles and
    // threads, and no follow-graph feed at all. Rather than fail the feed on the
    // default server, the seam sends it to the node behind it — and says which
    // one answered.
    const { calls, factory } = stubNodeAdapter();
    const relay = publicNodeProvider('https://relay.example');
    const handle = createProviderBackedFetch({
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      neynarApiKey: 'a-key',
      createNodeAdapter: factory,
      getProviderOrder: () => [
        neynarProvider(),
        relay,
        farcasterPublicProvider(),
      ],
    });

    await handle.fetch('https://farcaster.xyz/~api/v2/feed-items', {
      method: 'POST',
      body: JSON.stringify({ feedKey: 'home' }),
    });

    expect(calls.length).toBe(1);
    expect(handle.log.at(-1)).toMatchObject({ providerId: relay.id });
  });

  // The other preference the card names: Neynar live as the default, because the
  // wizard's key exists. The capability rule judges a route by what the table
  // calls it, not by its HTTP method — `POST /v2/feed-items` is a node *read* the
  // hosted API spells as a write — so Neynar's index (which keeps no follow
  // graph, and is never asked for one) is skipped and a node answers.
  it('answers the home feed from a node when Neynar is the live default, and never asks the index', async () => {
    const { calls, factory } = stubNodeAdapter();
    const relay = publicNodeProvider('https://relay.example');
    const direct: string[] = [];
    const handle = createProviderBackedFetch({
      getActiveProvider: () => neynarProvider(),
      getSignedInFid: () => 3,
      nodeBaseUrl: '/snapchain-api',
      fetchImpl: (async (url: string) => {
        direct.push(String(url));
        return jsonResponse({});
      }) as unknown as typeof fetch,
      neynarApiKey: 'a-key-this-test-provides',
      createNodeAdapter: factory,
      getProviderOrder: () => [
        neynarProvider(),
        relay,
        farcasterPublicProvider(),
      ],
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/feed-items',
      {
        method: 'POST',
        body: JSON.stringify({ feedKey: 'home' }),
      },
    );

    expect(response.status).toBe(200);
    expect(calls[0]).toContain('/v2/feed-items');
    expect(handle.log.at(-1)).toMatchObject({
      providerId: relay.id,
      kind: 'snapchain',
    });
    // Neither the index nor Farcaster's own server was asked for a read that is
    // assembled from the follow graph: no request left this page for a
    // third-party origin at all.
    expect(direct).toEqual([]);
  });
});
