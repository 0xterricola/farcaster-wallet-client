/**
 * The app catalog, as the client actually routes it — the acceptance test for
 * the user-reported failure: "the miniapps surface says this page isn't on your
 * node".
 *
 * Three facts are pinned here, in the order they matter to a reader:
 *
 *   1. the four catalog reads are classified as the app catalog, not as "no
 *      reader has been written yet";
 *   2. a node cannot answer them and says so in plain words, while Neynar can;
 *   3. with a Neynar key, the seam answers them from Neynar even when the
 *      reader's live server is their own node — and without a key, the node's
 *      own sentence is what the reader gets, not an empty list.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  catalogRoutes,
  classifyHostedRequest,
} from '~/snapchain/nodeApi/hostedRoutes';
import {
  createNodeBackedFetch,
  NODE_CANNOT_LIST_APPS,
} from '~/snapchain/nodeApi/nodeBackedFetch';
import { providerCanServe } from '~/snapchain/providers/capabilities';
import {
  farcasterPublicProvider,
  neynarProvider,
  ownNodeProvider,
} from '~/snapchain/providers/catalog';
import { createProviderBackedFetch } from '~/snapchain/providers/providerFetch';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** One frame as Neynar publishes it, trimmed to what the mapper reads. */
const NEYNAR_FRAME = {
  version: 'next',
  frames_url: 'https://app.example',
  image: 'https://app.example/image.png',
  manifest: {
    miniapp: {
      name: 'Example App',
      home_url: 'https://app.example',
      icon_url: 'https://app.example/icon.png',
      primary_category: 'social',
    },
  },
};

describe('the app catalog is its own kind of request', () => {
  it('classifies every catalog read the mini-app surfaces make', () => {
    for (const path of [
      '/v1/top-mini-apps',
      '/v1/new-frameapps',
      '/v1/favorite-frames',
      '/v1/search-miniapps',
    ]) {
      const route = classifyHostedRequest({ method: 'GET', path });
      expect(route.kind).toBe('catalog');
      expect(route.why).toContain('Neynar');
    }
    expect(catalogRoutes).toHaveLength(4);
  });

  it('does not classify a favourites *write* as a catalog read', () => {
    const route = classifyHostedRequest({
      method: 'PUT',
      path: '/v1/favorite-frames',
    });

    expect(route.kind).not.toBe('catalog');
    expect(route.why).toContain('nothing was signed and nothing was sent');
  });

  it('finds the endpoint behind the relay prefix a build puts in front of it', () => {
    const route = classifyHostedRequest({
      method: 'GET',
      path: '/~api/v1/top-mini-apps',
    });

    expect(route.kind).toBe('catalog');
    expect(route.path).toBe('/v1/top-mini-apps');
  });
});

describe('who may answer the app catalog', () => {
  it('is not a node, and the reason names the real limitation', () => {
    const decision = providerCanServe({
      provider: ownNodeProvider('https://mine.example'),
      kind: 'catalog',
      path: '/v1/top-mini-apps',
    });

    expect(decision.can).toBe(false);
    expect(decision.why).toContain('no app catalog');
  });

  it('is not Farcaster’s own public server either', () => {
    const decision = providerCanServe({
      provider: farcasterPublicProvider(),
      kind: 'catalog',
      path: '/v1/top-mini-apps',
    });

    expect(decision.can).toBe(false);
    expect(decision.why).toContain('index of apps');
  });

  it('is the index', () => {
    expect(
      providerCanServe({
        provider: neynarProvider(),
        kind: 'catalog',
        path: '/v1/top-mini-apps',
      }).can,
    ).toBe(true);
  });
});

describe('a node asked for the app catalog', () => {
  it('says in plain words that a node keeps no list of apps', async () => {
    const handle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      getSignedInFid: () => 3,
      fetchImpl: (async () => {
        throw new Error('the node must not be asked for a catalog');
      }) as typeof fetch,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v1/top-mini-apps?limit=50',
    );
    const body = (await response.json()) as { errors: { message: string }[] };

    expect(response.status).toBe(501);
    expect(body.errors[0]?.message).toBe(NODE_CANNOT_LIST_APPS);
    // The reader is told what is missing and what to do, not that a reader has
    // not been written — the sentence that was the whole bug report.
    expect(body.errors[0]?.message).toContain('Neynar');
    expect(body.errors[0]?.message).not.toContain('no node-backed reader');
  });
});

describe('the seam, with a reader on their own node', () => {
  const nodePreferred = ownNodeProvider('https://mine.example');

  const buildSeam = ({
    key,
    order,
    fetchImpl,
  }: {
    key: string | null;
    order: ReturnType<typeof neynarProvider>[];
    fetchImpl: typeof fetch;
  }) => {
    const nodeCalls: string[] = [];
    const handle = createProviderBackedFetch({
      getActiveProvider: () => nodePreferred,
      getSignedInFid: () => 191554,
      nodeBaseUrl: '/snapchain-api',
      neynarApiKey: key,
      fetchImpl,
      getProviderOrder: () => order,
      createNodeAdapter: (({ nodeBaseUrl }: { nodeBaseUrl: string }) => ({
        fetch: (async (url: string) => {
          nodeCalls.push(url);
          return jsonResponse({ result: { from: nodeBaseUrl } });
        }) as typeof fetch,
        reads: {} as never,
        log: [],
        nodeBaseUrl,
      })) as unknown as typeof createNodeBackedFetch,
    });
    return { handle, nodeCalls };
  };

  it('reads the catalog from Neynar, not from the node the reader is on', async () => {
    const neynarFetch = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          frames: [NEYNAR_FRAME],
          next: { cursor: null },
          // A wrong answer would be obvious in the assertion below.
          requested: String(input),
        }),
    );
    const { handle, nodeCalls } = buildSeam({
      key: 'test-key',
      order: [neynarProvider()],
      fetchImpl: neynarFetch as unknown as typeof fetch,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v1/top-mini-apps?limit=50',
    );
    const body = (await response.json()) as {
      result: { miniApps: { rank: number; miniApp: { name: string } }[] };
    };

    expect(response.status).toBe(200);
    expect(body.result.miniApps[0]?.miniApp.name).toBe('Example App');
    expect(nodeCalls).toEqual([]);
    expect(String(neynarFetch.mock.calls[0]?.[0])).toContain(
      '/v2/farcaster/frame/catalog/',
    );
    expect(neynarFetch.mock.calls[0]?.[1]?.headers).toEqual({
      'x-api-key': 'test-key',
    });
    expect(handle.log[0]?.providerId).toBe('neynar');
  });

  it('answers app search from Neynar with the query the surface typed', async () => {
    const neynarFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ frames: [NEYNAR_FRAME], next: { cursor: null } }),
    );
    const { handle } = buildSeam({
      key: 'test-key',
      order: [neynarProvider()],
      fetchImpl: neynarFetch as unknown as typeof fetch,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v1/search-miniapps?query=fiddy.fun&limit=20',
    );
    const body = (await response.json()) as { result: { apps: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.result.apps).toHaveLength(1);
    expect(String(neynarFetch.mock.calls[0]?.[0])).toContain('q=fiddy.fun');
  });

  it('with no key anywhere, the reader gets the node’s own sentence', async () => {
    const { handle, nodeCalls } = buildSeam({
      key: null,
      order: [],
      fetchImpl: (async () => {
        throw new Error('nothing should be fetched');
      }) as typeof fetch,
    });

    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v1/top-mini-apps?limit=50',
    );

    expect(nodeCalls).toHaveLength(1);
    expect(response.status).toBe(200);
  });
});
