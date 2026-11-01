/**
 * The embed classifier: what a bare URL's media type is, and how little it
 * costs to find out.
 *
 * These tests are about the three things that decide whether a photo renders:
 *   1. an extension or a content type is turned into the right answer,
 *   2. a probe is one bounded request (HEAD, then a ranged GET, then a browser
 *      image load), cached, concurrency-capped, and never a thrown error,
 *   3. "could not ask" is not an answer — the embed stays a link card.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  browserImageProbe,
  createEmbedKindResolver,
  EMBED_KIND_STORAGE_KEY,
  embedKindFromContentType,
  embedKindFromExtension,
  type EmbedKindResolver,
} from '~/snapchain/nodeApi/embedKinds';

/** The URL from the user's own cast: Cloudflare delivery, no extension at all. */
const CLOUDFLARE_PHOTO =
  'https://imagedelivery.net/BXluQx4ige9GuW0la56BHw/a62d038c-974d-4c48-a658-c764f4205c00/original';

/**
 * A response with a content type (and, when it matters, a status). `Response.ok`
 * follows from the status: a 404 or a 405 built here is already `ok === false`,
 * so there is nothing else to say about it.
 */
const responseWith = (
  contentType: string | null,
  { status = 200 }: { status?: number } = {},
): Response =>
  new Response(null, {
    status,
    headers: contentType === null ? {} : { 'content-type': contentType },
  });

const memoryStorage = (seed?: Record<string, string>) => {
  const entries = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    raw: entries,
  };
};

/** A resolver that answers from where a test says, with no browser probe. */
const testResolver = (
  fetchImpl: typeof fetch,
  extra: Partial<Parameters<typeof createEmbedKindResolver>[0]> = {},
): EmbedKindResolver =>
  createEmbedKindResolver({
    fetchImpl,
    storage: null,
    imageProbe: async () => undefined,
    ...extra,
  });

describe('an extension names a media type without any network', () => {
  it('reads the image extensions the hosted client rendered inline', () => {
    for (const url of [
      'https://a.test/photo.png',
      'https://a.test/photo.JPG',
      'https://a.test/photo.jpeg?w=600',
      'https://a.test/photo.gif#x',
      'https://a.test/photo.webp',
      'https://a.test/photo.avif',
    ]) {
      expect(embedKindFromExtension(url)).toBe('image');
    }
  });

  it('reads the video containers the renderer can play', () => {
    for (const url of ['https://a.test/clip.mp4', 'https://a.test/clip.webm']) {
      expect(embedKindFromExtension(url)).toBe('video');
    }
  });

  it('answers nothing for a URL that names no media type', () => {
    expect(embedKindFromExtension(CLOUDFLARE_PHOTO)).toBeUndefined();
    expect(embedKindFromExtension('https://a.test/post/1')).toBeUndefined();
    // HLS is deliberately not a video: this client has no player for it.
    expect(
      embedKindFromExtension(
        'https://stream.farcaster.xyz/v1/video/01a02c7e.m3u8',
      ),
    ).toBeUndefined();
  });
});

describe('a content type is an answer when it is one', () => {
  it('maps media types, with parameters and in any case', () => {
    expect(embedKindFromContentType('image/jpeg')).toBe('image');
    expect(embedKindFromContentType('IMAGE/PNG')).toBe('image');
    expect(embedKindFromContentType('image/webp; charset=binary')).toBe(
      'image',
    );
    expect(embedKindFromContentType('video/mp4')).toBe('video');
  });

  it('calls a non-media answer a link, and a missing header no answer', () => {
    expect(embedKindFromContentType('text/html; charset=utf-8')).toBe('link');
    expect(embedKindFromContentType('application/json')).toBe('link');
    expect(embedKindFromContentType(null)).toBeUndefined();
    expect(embedKindFromContentType(undefined)).toBeUndefined();
    expect(embedKindFromContentType('')).toBeUndefined();
  });
});

describe('a probe one URL at a time', () => {
  it('asks with HEAD and remembers the answer', async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? 'GET' });
        return responseWith('image/jpeg');
      },
    ) as unknown as typeof fetch;

    const resolver = testResolver(fetchImpl);
    expect(resolver.kindOf(CLOUDFLARE_PHOTO)).toBeUndefined();

    await resolver.classify([CLOUDFLARE_PHOTO]);

    expect(resolver.kindOf(CLOUDFLARE_PHOTO)).toBe('image');
    expect(calls).toEqual([{ url: CLOUDFLARE_PHOTO, method: 'HEAD' }]);
  });

  it('falls back to a ranged GET when HEAD is refused', async () => {
    const methods: string[] = [];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        methods.push(method);
        if (method === 'HEAD') {
          return responseWith(null, { status: 405 });
        }
        return responseWith('video/mp4');
      },
    ) as unknown as typeof fetch;

    const resolver = testResolver(fetchImpl);
    await resolver.classify([CLOUDFLARE_PHOTO]);

    expect(methods).toEqual(['HEAD', 'GET']);
    expect(resolver.kindOf(CLOUDFLARE_PHOTO)).toBe('video');
  });

  it('asks the browser image probe when no request can be made', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const imageProbe = vi.fn(async () => 'image' as const);

    const resolver = createEmbedKindResolver({
      fetchImpl,
      storage: null,
      imageProbe,
    });
    await resolver.classify([CLOUDFLARE_PHOTO]);

    expect(imageProbe).toHaveBeenCalledWith(
      CLOUDFLARE_PHOTO,
      expect.any(Number),
    );
    expect(resolver.kindOf(CLOUDFLARE_PHOTO)).toBe('image');
  });

  it('leaves an unanswerable URL a link, without throwing and without guessing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    const resolver = testResolver(fetchImpl);
    await expect(
      resolver.classify([CLOUDFLARE_PHOTO]),
    ).resolves.toBeUndefined();
    await resolver.settle();

    expect(resolver.kindOf(CLOUDFLARE_PHOTO)).toBeUndefined();
    // It was asked once, not in a loop.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a 404 as no answer rather than as a link', async () => {
    const fetchImpl = vi.fn(async () =>
      responseWith(null, { status: 404 }),
    ) as unknown as typeof fetch;

    const resolver = testResolver(fetchImpl);
    await resolver.classify(['https://gone.test/photo']);
    await resolver.settle();

    expect(resolver.kindOf('https://gone.test/photo')).toBeUndefined();
  });
});

describe('the cost of asking', () => {
  it('asks each URL once, however many times it is classified', async () => {
    const fetchImpl = vi.fn(async () =>
      responseWith('image/jpeg'),
    ) as unknown as typeof fetch;
    const resolver = testResolver(fetchImpl);

    await resolver.classify([CLOUDFLARE_PHOTO, CLOUDFLARE_PHOTO]);
    await resolver.classify([CLOUDFLARE_PHOTO]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('batches a page with a concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return responseWith('image/jpeg');
    }) as unknown as typeof fetch;

    const resolver = testResolver(fetchImpl, { concurrency: 2 });
    const urls = Array.from(
      { length: 8 },
      (_, index) => `https://a.test/photo-${index}/original`,
    );
    await resolver.classify(urls);
    await resolver.settle();

    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('returns within its deadline when a host does not answer', async () => {
    // A server that accepts the request and never replies, which is the shape
    // that used to hold a feed open.
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    ) as unknown as typeof fetch;

    const resolver = testResolver(fetchImpl, {
      probeTimeoutMs: 5_000,
      concurrency: 4,
    });
    const started = Date.now();
    await resolver.classify(
      Array.from({ length: 12 }, (_, i) => `https://slow.test/${i}/original`),
      { waitMs: 40 },
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1_000);
    expect(resolver.kindOf('https://slow.test/0/original')).toBeUndefined();
  });

  it('does not re-ask a URL that could not be answered, until it is worth it', async () => {
    let clock = 0;
    const spy = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const fetchImpl = spy as unknown as typeof fetch;

    const resolver = testResolver(fetchImpl, {
      now: () => clock,
      retryAfterMs: 1_000,
    });
    await resolver.classify(['https://flaky.test/photo']);
    await resolver.settle();
    await resolver.classify(['https://flaky.test/photo']);
    await resolver.settle();
    const afterFirst = spy.mock.calls.length;

    clock = 2_000;
    await resolver.classify(['https://flaky.test/photo']);
    await resolver.settle();

    expect(afterFirst).toBe(2);
    expect(spy.mock.calls.length).toBe(4);
  });
});

describe('remembering across a session (and beyond it)', () => {
  it('writes what it learned where the next load can read it', async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () =>
      responseWith('image/jpeg'),
    ) as unknown as typeof fetch;

    const resolver = createEmbedKindResolver({
      fetchImpl,
      storage,
      imageProbe: async () => undefined,
    });
    await resolver.classify([CLOUDFLARE_PHOTO]);

    const written = JSON.parse(
      storage.raw.get(EMBED_KIND_STORAGE_KEY) ?? '{}',
    ) as Record<string, string>;
    expect(written[CLOUDFLARE_PHOTO]).toBe('image');

    // A fresh resolver over the same storage answers with no network at all.
    const next = createEmbedKindResolver({
      fetchImpl: (async () => {
        throw new Error('the persisted answer should have been enough');
      }) as unknown as typeof fetch,
      storage,
      imageProbe: async () => undefined,
    });
    expect(next.kindOf(CLOUDFLARE_PHOTO)).toBe('image');
  });

  it('survives a cache that is corrupt or unwritable', async () => {
    const broken = {
      getItem: () => '{not json',
      setItem: () => {
        throw new Error('quota');
      },
    };
    const fetchImpl = vi.fn(async () =>
      responseWith('image/jpeg'),
    ) as unknown as typeof fetch;

    const resolver = createEmbedKindResolver({
      fetchImpl,
      storage: broken,
      imageProbe: async () => undefined,
    });
    await expect(
      resolver.classify([CLOUDFLARE_PHOTO]),
    ).resolves.toBeUndefined();
    expect(resolver.kindOf(CLOUDFLARE_PHOTO)).toBe('image');
  });
});

describe('the browser image probe', () => {
  it('answers nothing outside a browser', async () => {
    // The test runner has no `Image`; the probe says so rather than throwing.
    expect(await browserImageProbe('https://a.test/photo', 10)).toBeUndefined();
  });
});
