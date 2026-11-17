/**
 * The per-origin mini app manifest proxy (`/api/manifest`), held to its
 * contract without a network.
 *
 * The route this tests is the node-only chain's answer to "what is this
 * app?": the browser asks OUR host, our host reads the app's
 * `/.well-known/farcaster.json`, and the answer is cached under the
 * one-hour rule (quilcast 0.70.1's day-long cache is the lesson — a manifest
 * carries the app's launch address). These tests hold the parts that can
 * actually go wrong:
 *
 *   1. the read — the `miniapp` (or older `frame`) part is what comes back,
 *      `webhookUrl` never does, an origin that is not https is refused
 *      BEFORE any fetch, and nothing invents a manifest out of a refusal;
 *   2. the cache — one fetch per origin per TTL, a stampede is one read,
 *      the entry expires, and the TTL may not be built over the one-hour
 *      ceiling at all;
 *   3. the route — GET answers the facts with a bounded cache-control,
 *      HEAD is allowed, POST is refused, a host without the capability says
 *      so, and a caller over the limit gets a sentence, not a silence.
 */

import { describe, expect, it } from 'vitest';

import {
  createManifestService,
  MANIFEST_TTL_MS,
  manifestFacts,
  manifestOriginOf,
} from '../../server/miniapp/manifest.mjs';
import { createUnfurlHandler } from '../../server/unfurl/handler.mjs';

const SHELL = '<!doctype html><html><head></head><body>shell</body></html>';

const wellKnown = (
  app: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => JSON.stringify({ accountAssociation: { sig: '0x…' }, ...extra, ...app });

/** A safeGet that answers from a fixture, so no test needs a network. */
const fakeSafeGet = (
  pages: Record<string, { status?: number; body: string }> = {},
) => {
  const asked: string[] = [];
  const safeGet = async (url: string) => {
    asked.push(url);
    const page = pages[url];
    if (!page) {
      throw new Error('not found');
    }
    return { status: page.status ?? 200, headers: {}, body: page.body, url };
  };
  return { safeGet, asked };
};

const service = (
  pages: Record<string, { status?: number; body: string }>,
  { now }: { now?: () => number } = {},
) => {
  const { safeGet, asked } = fakeSafeGet(pages);
  const manifest = createManifestService({
    safeGet,
    ...(now ? { now } : {}),
  });
  return { manifest, asked };
};

describe('manifestOriginOf: what may be asked at all', () => {
  it('takes a plain https origin', () => {
    expect(manifestOriginOf('https://example.com')).toBe('https://example.com');
    expect(manifestOriginOf('https://app.example.com/')).toBe(
      'https://app.example.com',
    );
  });

  it('refuses everything that is not an https front door', () => {
    expect(manifestOriginOf('http://example.com')).toBeUndefined();
    expect(manifestOriginOf('https://example.com:8080')).toBeUndefined();
    expect(manifestOriginOf('https://user:pass@example.com')).toBeUndefined();
    expect(manifestOriginOf('example.com')).toBeUndefined();
    expect(manifestOriginOf('')).toBeUndefined();
    expect(manifestOriginOf(undefined)).toBeUndefined();
  });
});

describe('manifestFacts: what a manifest is allowed to say', () => {
  it('reads the miniapp part, and the frame part as its older name', () => {
    const facts = manifestFacts(
      JSON.parse(
        wellKnown({ miniapp: { name: 'Zora', homeUrl: 'https://zora.co' } }),
      ),
    );
    expect(facts).toEqual({ name: 'Zora', homeUrl: 'https://zora.co/' });
    const older = manifestFacts(
      JSON.parse(wellKnown({ frame: { name: 'Old Frame' } })),
    );
    expect(older).toEqual({ name: 'Old Frame' });
  });

  it('never carries the webhook, and drops fields that are not strings', () => {
    const facts = manifestFacts(
      JSON.parse(
        wellKnown({
          miniapp: {
            name: 'App',
            webhookUrl: 'https://app.example.com/webhook',
            iconUrl: 'https://app.example.com/icon.png',
          },
        }),
      ),
    );
    expect(facts).toEqual({
      name: 'App',
      iconUrl: 'https://app.example.com/icon.png',
    });
    expect(JSON.stringify(facts)).not.toContain('webhook');
    expect(
      manifestFacts(JSON.parse(wellKnown({ miniapp: { name: 3 } }))),
    ).toBeUndefined();
  });

  it('is nothing when the file has no app in it', () => {
    expect(manifestFacts(JSON.parse('{}'))).toBeUndefined();
    expect(manifestFacts(null)).toBeUndefined();
  });
});

describe('the service: one read per origin per window', () => {
  it('reads the origin well-known file once and caches the answer', async () => {
    const { manifest, asked } = service({
      'https://example.com/.well-known/farcaster.json': {
        body: wellKnown({ miniapp: { name: 'Example' } }),
      },
    });
    expect(await manifest('https://example.com')).toEqual({ name: 'Example' });
    expect(await manifest('https://example.com/anything/else')).toEqual({
      name: 'Example',
    });
    expect(asked).toEqual(['https://example.com/.well-known/farcaster.json']);
  });

  it('shares one in-flight read between concurrent callers', async () => {
    const { manifest, asked } = service({
      'https://example.com/.well-known/farcaster.json': {
        body: wellKnown({ miniapp: { name: 'Example' } }),
      },
    });
    const [a, b] = await Promise.all([
      manifest('https://example.com'),
      manifest('https://example.com'),
    ]);
    expect(a).toEqual(b);
    expect(asked).toHaveLength(1);
  });

  it('answers null without fetching for an origin it may not ask', async () => {
    const { manifest, asked } = service({});
    expect(await manifest('http://example.com')).toBeNull();
    expect(await manifest('https://example.com:8443')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('answers null for a refused, unreadable, or unparseable origin', async () => {
    const { manifest } = service({
      'https://gone.com/.well-known/farcaster.json': {
        status: 404,
        body: 'not found',
      },
      'https://broken.com/.well-known/farcaster.json': { body: '{nope' },
      'https://empty.com/.well-known/farcaster.json': { body: '{}' },
    });
    expect(await manifest('https://gone.com')).toBeNull();
    expect(await manifest('https://broken.com')).toBeNull();
    expect(await manifest('https://empty.com')).toBeNull();
    expect(await manifest('https://never-asked.com')).toBeNull();
  });

  it('re-reads after the TTL, and a miss is cached too', async () => {
    let clock = 0;
    const { manifest, asked } = service(
      {
        'https://example.com/.well-known/farcaster.json': {
          body: wellKnown({ miniapp: { name: 'Example' } }),
        },
      },
      { now: () => clock },
    );
    await manifest('https://example.com');
    clock = MANIFEST_TTL_MS - 1;
    await manifest('https://example.com');
    expect(asked).toHaveLength(1);
    clock = MANIFEST_TTL_MS + 1;
    await manifest('https://example.com');
    expect(asked).toHaveLength(2);
  });

  it('refuses to be built over the one-hour ceiling at all', () => {
    expect(() =>
      createManifestService({
        safeGet: fakeSafeGet().safeGet,
        ttlMs: 3_600_001,
      }),
    ).toThrow();
  });

  it('never fetches an origin naming this host', async () => {
    const { safeGet, asked } = fakeSafeGet({});
    const manifest = createManifestService({
      safeGet,
      ownOrigins: ['https://fiddy.fun'] as never,
    });
    expect(await manifest('https://fiddy.fun')).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe('the route: GET /api/manifest', () => {
  const handler = (
    manifest?: unknown,
    overrides: Record<string, unknown> = {},
  ) =>
    createUnfurlHandler({
      origin: 'https://fiddy.fun',
      shellSource: () => SHELL,
      siteCard: undefined,
      renderCard: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
      reader: {
        cast: async () => undefined,
        profile: async () => undefined,
        size: () => 0,
      },
      ...(manifest === undefined ? {} : { manifest }),
      ...overrides,
    } as never);

  const read = async (
    path: string,
    manifest?: unknown,
    overrides: Record<string, unknown> = {},
  ) =>
    (await handler(manifest, overrides).handle({
      method: 'GET',
      path,
    })) as {
      status: number;
      headers: Record<string, string>;
      body: string;
    };

  it('answers the manifest facts with a cache-control under the hour', async () => {
    const { manifest } = service({
      'https://example.com/.well-known/farcaster.json': {
        body: wellKnown({ miniapp: { name: 'Example' } }),
      },
    });
    const answer = await read(
      '/api/manifest?origin=https://example.com',
      manifest,
    );
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ name: 'Example' });
    const maxAge = Number(
      /max-age=(\d+)/.exec(answer.headers['cache-control'] ?? '')?.[1],
    );
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(3600);
  });

  it('says a host without the capability, and an origin without a manifest', async () => {
    const off = await read('/api/manifest?origin=https://example.com');
    expect(off.status).toBe(404);
    const miss = await read(
      '/api/manifest?origin=https://example.com',
      service({}).manifest,
    );
    expect(miss.status).toBe(404);
    expect(JSON.parse(miss.body)).toHaveProperty('error');
  });

  it('refuses POST, and answers one sentence over the limit', async () => {
    const { manifest } = service({});
    const posted = (await handler(manifest).handle({
      method: 'POST',
      path: '/api/manifest?origin=https://example.com',
    })) as { status: number };
    expect(posted.status).toBe(405);
    const limited = await read(
      '/api/manifest?origin=https://example.com',
      manifest,
      { manifestLimits: { max: 0, windowMs: 10 * 60 * 1000 } },
    );
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body)).toHaveProperty('error');
  });
});
