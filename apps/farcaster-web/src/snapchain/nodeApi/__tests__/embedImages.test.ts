/**
 * The user-reported bug, at the layer that caused it.
 *
 * A cast whose embed is a Cloudflare image-delivery URL
 * (`https://imagedelivery.net/<account>/<id>/original` — no file extension)
 * rendered as a link card: a chain-link icon above a blank meta box. The
 * protocol sends a bare URL, the node adapter had only the URL text to go on,
 * and extension sniffing says "not an image" about every one of them.
 *
 * These tests drive the real read path (fixtures recorded from a live node, the
 * real `POST /v2/feed-items` route, the real cast translator) and assert where
 * each embed lands once the URL's own media type has been asked for:
 *
 *   - the photo is in `embeds.images`, which is the bucket the renderer draws
 *     as a picture (`getRenderableEmbeds`, `~/utils/castUtils.ts`),
 *   - the link next to it is still a link (an embed list is not all-or-nothing),
 *   - when nothing can answer for a URL, it stays a link card and the read still
 *     succeeds — a guessed image would be worse than an honest link.
 */

import { describe, expect, it, vi } from 'vitest';

import { createEmbedKindResolver } from '~/snapchain/nodeApi/embedKinds';
import { createNodeBackedFetch } from '~/snapchain/nodeApi/nodeBackedFetch';

import { createFixtureNodeFetch } from './fakeNodeFetch';

type Json = Record<string, unknown>;

/** The URL the user's own cast carries — Cloudflare delivery, no extension. */
const CLOUDFLARE_PHOTO =
  'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/9f4bda20-a039-4770-5605-8eb24d259e00/original';
/** The cast that carries it (fid 3, from the recorded page). */
const CAST_WITH_PHOTO = '0x0256ae66308d546514fa666cda44052abbfea066';
/** ...and the cast that carries a photo *and* a link, for the mixed case. */
const CAST_WITH_PHOTO_AND_LINK = '0xc73059b4d38a31f2a702957a674e09494b527633';
const GITHUB_LINK = 'https://github.com/danromero/farcaster-client-agent-guide';

interface Harness {
  fetch: typeof fetch;
  /** Every probe the classifier made: what it asked, and how. */
  probes: { url: string; method: string }[];
  /** Every route served by the node. */
  nodeLog: string[];
}

const buildHarness = ({
  contentTypeFor = (url: string) =>
    url.startsWith('https://imagedelivery.net/') ? 'image/jpeg' : 'text/html',
  fail = false,
}: {
  contentTypeFor?: (url: string) => string | null;
  fail?: boolean;
} = {}): Harness => {
  const probes: { url: string; method: string }[] = [];
  const nodeLog: string[] = [];

  const embedKinds = createEmbedKindResolver({
    // No session/session-storage cache and no browser probe: a test asserts
    // exactly which requests the classifier made.
    storage: null,
    imageProbe: async () => undefined,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      probes.push({ url, method: init?.method ?? 'GET' });
      if (fail) {
        throw new TypeError('Failed to fetch');
      }
      const contentType = contentTypeFor(url);
      return new Response(null, {
        status: contentType === null ? 404 : 200,
        headers: contentType === null ? {} : { 'content-type': contentType },
      });
    }) as typeof fetch,
  });

  const handle = createNodeBackedFetch({
    nodeBaseUrl: 'http://node.test',
    getSignedInFid: () => 3,
    fetchImpl: createFixtureNodeFetch({ log: nodeLog }),
    embedKinds,
  });

  return { fetch: handle.fetch, probes, nodeLog };
};

const feed = async (harness: Harness) => {
  const response = await harness.fetch(
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
  const result = body.result as { items: { cast: Json }[] };
  return result.items;
};

const castIn = (items: { cast: Json }[], hash: string): Json => {
  const found = items.find((item) => item.cast.hash === hash);
  expect(found, `cast ${hash} should be in the feed page`).toBeDefined();
  return found!.cast;
};

interface CastEmbeds {
  images: { url: string }[];
  urls: { openGraph: { url: string } }[];
  videos?: { url: string }[];
}

/** The embeds a cast carries, with the two required buckets always present. */
const embedsOf = (cast: Json): CastEmbeds => {
  const embeds = (cast.embeds ?? {}) as Partial<CastEmbeds>;
  return {
    images: embeds.images ?? [],
    urls: embeds.urls ?? [],
    ...(embeds.videos ? { videos: embeds.videos } : {}),
  };
};

describe('an image embed from the node renders as an image', () => {
  it('puts the Cloudflare photo in the image bucket, not the url bucket', async () => {
    const harness = buildHarness();
    const items = await feed(harness);
    const embeds = embedsOf(castIn(items, CAST_WITH_PHOTO));

    expect(embeds.images.map((image) => image.url)).toEqual([CLOUDFLARE_PHOTO]);
    expect(embeds.urls).toEqual([]);
  });

  it('keeps the link beside a photo a link', async () => {
    const harness = buildHarness();
    const items = await feed(harness);
    const embeds = embedsOf(castIn(items, CAST_WITH_PHOTO_AND_LINK));

    expect(embeds.images).toHaveLength(1);
    expect(embeds.images[0]!.url).toMatch(/^https:\/\/imagedelivery\.net\//);
    expect(embeds.urls.map((url) => url.openGraph.url)).toEqual([GITHUB_LINK]);
  });

  it('asks each embed URL once for the whole page, with HEAD', async () => {
    const harness = buildHarness();
    const items = await feed(harness);

    const asked = harness.probes.map((probe) => probe.url);
    const carried = new Set<string>();
    for (const item of items) {
      const embeds = embedsOf(item.cast);
      for (const image of embeds.images) {
        carried.add(image.url);
      }
      for (const url of embeds.urls) {
        carried.add(url.openGraph.url);
      }
      for (const video of embeds.videos ?? []) {
        carried.add(video.url);
      }
    }

    // One probe per distinct URL the page carries — not one per cast, not one
    // per embed, and nothing asked twice.
    expect(new Set(asked).size).toBe(asked.length);
    expect([...asked].sort()).toEqual([...carried].sort());
    expect(harness.probes.every((probe) => probe.method === 'HEAD')).toBe(true);
  });

  it('leaves the URL a link card when nothing can answer for it', async () => {
    const harness = buildHarness({ fail: true });
    const items = await feed(harness);
    const embeds = embedsOf(castIn(items, CAST_WITH_PHOTO));

    expect(embeds.images).toEqual([]);
    expect(embeds.urls.map((url) => url.openGraph.url)).toEqual([
      CLOUDFLARE_PHOTO,
    ]);
  });

  it('never calls a page an image, whatever the host answers', async () => {
    const harness = buildHarness({
      contentTypeFor: () => 'text/html; charset=utf-8',
    });
    const items = await feed(harness);
    const embeds = embedsOf(castIn(items, CAST_WITH_PHOTO));

    expect(embeds.images).toEqual([]);
    expect(embeds.urls).toHaveLength(1);
  });
});

describe('profile pictures come out of the same mapping as pictures', () => {
  it('gives the cast author a pfp url the renderer can draw', async () => {
    const harness = buildHarness();
    const items = await feed(harness);
    const cast = castIn(items, CAST_WITH_PHOTO);
    const author = cast.author as {
      username?: string;
      pfp?: { url: string };
      profile?: { bannerImageUrl?: string };
    };

    expect(author.username).toBe('dwr');
    // The account's own USER_DATA_TYPE_PFP message, which is what every avatar
    // in the fork's components reads (`user.pfp.url`).
    expect(author.pfp?.url).toBe(
      'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/bc698287-5adc-4cc5-a503-de16963ed900/original',
    );
    // The hosted API marks a pfp `verified`; nothing here has checked that, so
    // the client must not claim it.
    expect((author.pfp as { verified?: boolean }).verified).toBe(false);
  });
});

describe('the probe budget', () => {
  it('does not hold a read open behind a host that never answers', async () => {
    // A server that accepts the connection and never replies. Whatever it does,
    // the read has to finish: an embed that cannot be classified is a link.
    const probes: string[] = [];
    const embedKinds = createEmbedKindResolver({
      storage: null,
      imageProbe: async () => undefined,
      probeTimeoutMs: 5_000,
      concurrency: 4,
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        probes.push(String(input));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }) as typeof fetch,
    });
    const handle = createNodeBackedFetch({
      nodeBaseUrl: 'http://node.test',
      getSignedInFid: () => 3,
      fetchImpl: createFixtureNodeFetch({}),
      embedKinds,
    });

    const started = Date.now();
    const response = await handle.fetch(
      'https://farcaster.xyz/~api/v2/feed-items',
      {
        method: 'POST',
        body: JSON.stringify({ feedKey: 'home', feedType: 'default' }),
      },
    );
    const elapsed = Date.now() - started;

    expect(response.status).toBe(200);
    // One bounded wait for the page's batch — not one per cast, and not the
    // probe's own (5s) deadline.
    expect(elapsed).toBeLessThan(4_000);
    expect(probes.length).toBeGreaterThan(0);
    const body = (await response.json()) as Json;
    const items = (body.result as { items: { cast: Json }[] }).items;
    expect(embedsOf(items[0]!.cast).images).toEqual([]);
  }, 15_000);
});

describe('the resolver the adapter builds for itself', () => {
  it('is wired in when the caller injects none, and its failures never fail a read', async () => {
    // No `embedKinds` here: the adapter builds the real one, whose probes go to
    // the page's own `fetch`. Stub that out to fail and nothing about the read
    // may change — a URL nobody can classify is a link card, not an error.
    const probeFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', probeFetch);
    try {
      const handle = createNodeBackedFetch({
        nodeBaseUrl: 'http://node.test',
        getSignedInFid: () => 3,
        fetchImpl: createFixtureNodeFetch({}),
      });

      const response = await handle.fetch(
        'https://farcaster.xyz/~api/v2/feed-items',
        {
          method: 'POST',
          body: JSON.stringify({ feedKey: 'home', feedType: 'default' }),
        },
      );

      expect(response.status).toBe(200);
      expect(probeFetch).toHaveBeenCalled();

      const body = (await response.json()) as Json;
      const items = (body.result as { items: { cast: Json }[] }).items;
      const embeds = embedsOf(castIn(items, CAST_WITH_PHOTO));
      expect(embeds.images).toEqual([]);
      expect(embeds.urls.map((url) => url.openGraph.url)).toEqual([
        CLOUDFLARE_PHOTO,
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);
});
