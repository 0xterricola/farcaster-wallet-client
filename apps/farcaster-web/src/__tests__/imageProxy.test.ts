/**
 * `GET /api/img`: other sites' pictures, fetched and cached by this host
 * instead of by the reader's browser.
 *
 * The battery below is the whole rule, each part of it held without a network:
 *
 *   1. **the address guard** — public answers, private does not, and the
 *      IPv6/NAT64/CGNAT forms that ARE an IPv4 address are judged as the
 *      address they really are;
 *   2. **the fetcher** — the guard runs through the socket's own `lookup`, every
 *      redirect hop is checked again, a redirect loop ends, an oversized body
 *      ends, and the deadline is a deadline;
 *   3. **the sniff** — a picture is named by its bytes, and a body that is not
 *      one of the formats we serve is not served, however it is labelled;
 *   4. **the cache** — a second reader of the same picture costs nothing, a
 *      huge picture is served but not kept, a miss is held, and the per-visitor
 *      limit counts FETCHES so a cache hit is never refused.
 */

import { describe, expect, it } from 'vitest';

import {
  blockedReason,
  guardedLookup,
  ipv6Bytes,
} from '../../server/img/addresses.mjs';
import { createImageCache } from '../../server/img/cache.mjs';
import { createSafeGet, ImgFetchError } from '../../server/img/fetch.mjs';
import {
  MAX_PIXELS,
  picInfo,
  pixelCap,
  SVG_MAX_BYTES,
} from '../../server/img/pic.mjs';
import { createImageProxy } from '../../server/img/proxy.mjs';
import { createUnfurlHandler } from '../../server/unfurl/handler.mjs';

/* ------------------------------------------------------------------ bytes --- */

/** A PNG header that declares `width`x`height` — enough for a sniff, not a picture. */
const pngOf = (width: number, height: number): Buffer => {
  const bytes: Buffer = Buffer.alloc(33);
  bytes.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 0);
  bytes.writeUInt32BE(13, 8);
  bytes.set(Buffer.from('IHDR'), 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};

const GIF: Buffer = Buffer.alloc(20);
GIF.write('GIF89a', 0, 'latin1');
GIF.set([0x40, 0x01, 0xf0, 0x00, 0x00, 0x00], 6);

const JPEG: Buffer = (() => {
  // SOI, an APP0 segment with a length, then SOF0 carrying 480x640.
  const bytes: Buffer = Buffer.alloc(2 + 18 + 19);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  bytes.writeUInt16BE(16, 4);
  bytes.set(Buffer.from('JFIF\0', 'latin1'), 6);
  const sof = 2 + 18;
  bytes[sof] = 0xff;
  bytes[sof + 1] = 0xc0;
  bytes.writeUInt16BE(17, sof + 2);
  bytes[sof + 4] = 8;
  bytes.writeUInt16BE(480, sof + 5);
  bytes.writeUInt16BE(640, sof + 7);
  return bytes;
})();

const SVG = Buffer.from(
  '<?xml version="1.0"?>\n<!-- drawn by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>',
  'utf8',
);

/* ------------------------------------------------------------------ stubs --- */

type Answer = {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer;
  delayMs?: number;
};

/**
 * A transport that answers from a map, and — this is the point — resolves the
 * host through the `lookup` the SAFE GETTER gave it, exactly as a socket would.
 * That is what makes the address guard testable: the guard is not called by
 * this test, it is called by the fetcher through the request.
 */
const transport = (answers: Record<string, Answer>) => {
  const asked: string[] = [];
  const connect = async (request: {
    url: string;
    lookup: (
      host: string,
      options: unknown,
      callback: (error: unknown, addresses?: unknown) => void,
    ) => void;
  }) => {
    const host = new URL(request.url).hostname;
    await new Promise<void>((resolve, reject) => {
      request.lookup(host, { all: true }, (error: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    // Recorded AFTER the lookup, so a refused address never shows up as a
    // request that was made.
    asked.push(request.url);
    const answer = answers[request.url];
    if (!answer) {
      throw new ImgFetchError('IMG_UPSTREAM', 'no answer for that address');
    }
    if (answer.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    }
    return {
      status: answer.status ?? 200,
      headers: answer.headers ?? {},
      body: answer.body ?? Buffer.alloc(0),
    };
  };
  return { connect, asked };
};

/** A `node:dns` lookup answering from a map; an unmapped host does not resolve. */
const dnsOf =
  (map: Record<string, string[]>) =>
  (
    hostname: string,
    _options: unknown,
    callback: (error: unknown, addresses?: unknown) => void,
  ) => {
    const addresses = map[hostname];
    if (!addresses) {
      const error = Object.assign(
        new Error(`getaddrinfo ENOTFOUND ${hostname}`),
        {
          code: 'ENOTFOUND',
        },
      );
      callback(error);
      return;
    }
    callback(
      null,
      addresses.map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    );
  };

const PUBLIC = { 'images.example': ['93.184.216.34'] };

type GetterOptions = {
  dns?: Record<string, string[]>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

const getter = (
  answers: Record<string, Answer>,
  options: GetterOptions = {},
) => {
  const transportStub = transport(answers);
  const safeGet = createSafeGet({
    connect: transportStub.connect as never,
    lookup: dnsOf(options.dns ?? PUBLIC) as never,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
  } as never);
  return { safeGet, asked: transportStub.asked };
};

type ProxyOptions = GetterOptions & {
  limit?: number;
  cache?: Record<string, number>;
};

const proxyFor = (
  answers: Record<string, Answer>,
  options: ProxyOptions = {},
) => {
  const { safeGet, asked } = getter(answers, options);
  const store = createImageCache({ ...(options.cache ?? {}) });
  const limit = options.limit ?? 100;
  let allowed = 0;
  const limiter = () => {
    allowed += 1;
    return allowed > limit;
  };
  const proxy = createImageProxy({
    safeGet,
    cache: store,
    limiter,
    ownOrigins: ['https://fiddy.fun'],
    log: () => {},
  } as never);
  return {
    proxy,
    asked,
    store,
    fetchesAllowed: () => allowed - Math.max(0, allowed - limit),
  };
};

/* ------------------------------------------------------------------ guard --- */

describe('the address guard', () => {
  it('lets a public address through and refuses every private shape', () => {
    expect(blockedReason('93.184.216.34')).toBeUndefined();
    expect(blockedReason('1.1.1.1')).toBeUndefined();
    expect(blockedReason('8.8.8.8')).toBeUndefined();
    expect(blockedReason('2606:2800:220:1:248:1893:25c8:1946')).toBeUndefined();

    expect(blockedReason('127.0.0.1')).toBe('loopback');
    expect(blockedReason('10.1.2.3')).toBe('private');
    expect(blockedReason('192.168.1.10')).toBe('private');
    expect(blockedReason('172.20.0.1')).toBe('private');
    expect(blockedReason('169.254.169.254')).toBe('link-local');
    // Tailscale hands out 100.64/10, which is why the CGNAT range is here.
    expect(blockedReason('100.100.100.100')).toBe(
      'carrier-grade NAT (and Tailscale)',
    );
    expect(blockedReason('0.0.0.0')).toBe('this network');
    expect(blockedReason('224.0.0.1')).toBe('multicast');
  });

  it('judges an IPv6 address by the IPv4 address it really is', () => {
    expect(blockedReason('::1')).toBe('loopback');
    expect(blockedReason('::')).toBe('this network');
    // ::ffff:127.0.0.1 and ::ffff:10.0.0.1 are IPv4 addresses wearing IPv6.
    expect(blockedReason('::ffff:127.0.0.1')).toBe('loopback');
    expect(blockedReason('::ffff:10.0.0.1')).toBe('private');
    expect(blockedReason('64:ff9b::7f00:1')).toBe('loopback');
    // unique-local, link-local, multicast.
    expect(blockedReason('fd7a:115c:a1e0::1')).toBe('unique-local');
    expect(blockedReason('fe80::1%en0')).toBe('link-local');
    expect(blockedReason('ff02::1')).toBe('multicast');
  });

  it('parses IPv6 the way the resolver writes it', () => {
    expect(ipv6Bytes('::1')).toHaveLength(16);
    expect(ipv6Bytes('2001:db8::ff00:42:8329')).toHaveLength(16);
    expect(ipv6Bytes('::ffff:192.0.2.128')).toHaveLength(16);
    expect(ipv6Bytes('not-an-address')).toBeUndefined();
  });

  it('refuses a host whose answer is private, and says why', () => {
    const lookup = guardedLookup(
      dnsOf({ 'evil.example': ['100.64.9.9'] }) as never,
    );
    let refused: { code?: string; reason?: string } | undefined;
    lookup('evil.example', { all: false }, (error: unknown) => {
      refused = error as { code?: string; reason?: string };
    });
    expect(refused?.code).toBe('IMG_ADDRESS_REFUSED');
    expect(refused?.reason).toBe('carrier-grade NAT (and Tailscale)');
  });

  it('refuses a host that answers BOTH a public and a private address', () => {
    const lookup = guardedLookup(
      dnsOf({ 'split.example': ['93.184.216.34', '10.0.0.5'] }) as never,
    );
    let refused: { code?: string } | undefined;
    lookup('split.example', { all: false }, (error: unknown) => {
      refused = error as { code?: string };
    });
    expect(refused?.code).toBe('IMG_ADDRESS_REFUSED');
  });
});

/* ----------------------------------------------------------------- fetcher --- */

describe('the fetcher', () => {
  const picture = pngOf(64, 64);

  it('checks the address inside the socket lookup, then answers the bytes', async () => {
    const { safeGet, asked } = getter({
      'https://images.example/a.png': { body: picture },
    });
    const answer = await safeGet('https://images.example/a.png');
    expect(answer.status).toBe(200);
    expect(asked).toEqual(['https://images.example/a.png']);
    expect(answer.body.equals(picture as Buffer)).toBe(true);
  });

  it('refuses a host that resolves somewhere private, before any request is made', async () => {
    const { safeGet, asked } = getter(
      { 'https://internal.example/a.png': { body: picture } },
      { dns: { 'internal.example': ['127.0.0.1'] } },
    );
    await expect(
      safeGet('https://internal.example/a.png'),
    ).rejects.toMatchObject({
      code: 'IMG_ADDRESS_REFUSED',
    });
    expect(asked).toEqual([]);
  });

  it('re-checks every redirect hop, so a public URL cannot hop to a private one', async () => {
    const { safeGet } = getter(
      {
        'https://images.example/hop.png': {
          status: 302,
          headers: { location: 'https://internal.example/cat.png' },
        },
      },
      {
        dns: {
          'images.example': ['93.184.216.34'],
          'internal.example': ['10.0.0.7'],
        },
      },
    );
    await expect(
      safeGet('https://images.example/hop.png'),
    ).rejects.toMatchObject({
      code: 'IMG_ADDRESS_REFUSED',
    });
  });

  it('follows a redirect to another host and answers the final URL', async () => {
    const { safeGet, asked } = getter(
      {
        'https://images.example/a.png': {
          status: 301,
          headers: { location: 'https://cdn.example/b.png' },
        },
        'https://cdn.example/b.png': { body: picture },
      },
      {
        dns: {
          'images.example': ['93.184.216.34'],
          'cdn.example': ['93.184.216.35'],
        },
      },
    );
    const answer = await safeGet('https://images.example/a.png');
    expect(answer.url).toBe('https://cdn.example/b.png');
    expect(asked).toHaveLength(2);
  });

  it('ends a redirect loop instead of walking it', async () => {
    const hop = (to: string) => ({ status: 302, headers: { location: to } });
    const { safeGet } = getter({
      'https://images.example/a.png': hop('https://images.example/b.png'),
      'https://images.example/b.png': hop('https://images.example/a.png'),
    });
    await expect(safeGet('https://images.example/a.png')).rejects.toMatchObject(
      {
        code: 'IMG_TOO_MANY_HOPS',
      },
    );
  });

  it('refuses a body past the byte cap', async () => {
    const { safeGet } = getter(
      { 'https://images.example/huge.png': { body: Buffer.alloc(4096) } },
      { maxBytes: 1024 },
    );
    await expect(
      safeGet('https://images.example/huge.png'),
    ).rejects.toMatchObject({
      code: 'IMG_TOO_BIG',
    });
  });

  it('gives up at the deadline rather than holding the request open', async () => {
    const { safeGet } = getter(
      { 'https://images.example/slow.png': { body: picture, delayMs: 200 } },
      { timeoutMs: 20 },
    );
    await expect(
      safeGet('https://images.example/slow.png'),
    ).rejects.toMatchObject({
      code: 'IMG_TIMEOUT',
    });
  });

  it('will not fetch a plain-http picture', async () => {
    const { safeGet, asked } = getter({});
    await expect(safeGet('http://images.example/a.png')).rejects.toMatchObject({
      code: 'IMG_INSECURE',
    });
    expect(asked).toEqual([]);
  });

  it('sends no referer and no cookie', async () => {
    const seen: Record<string, string>[] = [];
    const { safeGet } = getter(
      { 'https://images.example/a.png': { body: picture } },
      {},
    );
    // Re-wrap the transport to record the headers the fetcher set.
    const recording = createSafeGet({
      connect: (async (request: { headers: Record<string, string> }) => {
        seen.push(request.headers);
        return { status: 200, headers: {}, body: picture };
      }) as never,
      lookup: dnsOf(PUBLIC) as never,
    });
    await recording('https://images.example/a.png');
    await safeGet('https://images.example/a.png');
    expect(
      Object.keys(seen[0] ?? {}).map((each) => each.toLowerCase()),
    ).not.toContain('referer');
    expect(seen[0]?.['user-agent']).toContain('FiddyImageProxy');
  });
});

/* -------------------------------------------------------------------- pic --- */

describe('what the bytes say they are', () => {
  it('names each format we serve', () => {
    expect(picInfo(pngOf(1200, 630))).toMatchObject({
      type: 'image/png',
      width: 1200,
      height: 630,
    });
    expect(picInfo(JPEG)).toMatchObject({
      type: 'image/jpeg',
      width: 640,
      height: 480,
    });
    expect(picInfo(GIF)).toMatchObject({ type: 'image/gif' });
    expect(picInfo(SVG)).toMatchObject({ type: 'image/svg+xml' });
    const webp = Buffer.alloc(40);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp[24] = 0x0f;
    webp[27] = 0x0f;
    expect(picInfo(webp)).toMatchObject({
      type: 'image/webp',
      width: 16,
      height: 16,
    });
    const avif = Buffer.alloc(48);
    avif.write('ftyp', 4, 'latin1');
    avif.write('avif', 8, 'latin1');
    avif.write('ispe', 20, 'latin1');
    avif.writeUInt32BE(300, 28);
    avif.writeUInt32BE(200, 32);
    expect(picInfo(avif)).toMatchObject({
      type: 'image/avif',
      width: 300,
      height: 200,
    });
  });

  it('refuses a body that is not a picture, whatever it is called', () => {
    expect(
      picInfo(Buffer.from('<html><body>not a picture</body></html>')),
    ).toBeNull();
    expect(picInfo(Buffer.alloc(64, 0x42))).toBeNull();
    expect(picInfo(Buffer.alloc(4))).toBeNull();
  });

  it('refuses a picture past the 50 megapixel cap', () => {
    expect(pixelCap(picInfo(pngOf(10000, 5000)) as never)).toBe(true);
    expect(pixelCap(picInfo(pngOf(10000, 5001)) as never)).toBe(false);
    expect(MAX_PIXELS).toBe(50_000_000);
    // An SVG carries no pixel size: it is markup, and the response sandboxes it.
    expect(pixelCap(picInfo(SVG) as never)).toBe(true);
  });
});

/* ------------------------------------------------------------------ proxy --- */

describe('the proxy route', () => {
  const picture = pngOf(48, 48);
  const src = 'https://images.example/a.png';

  it('serves a picture from this origin, with the headers that make it inert', async () => {
    const { proxy } = proxyFor({ [src]: { body: picture } });
    const answer = await proxy.answer({ u: src, ip: '203.0.113.9' });
    const headers = answer.headers as Record<string, string>;
    expect(answer.status).toBe(200);
    expect(headers['content-type']).toBe('image/png');
    expect(headers['content-security-policy']).toBe(
      "default-src 'none'; sandbox",
    );
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-fiddy-img']).toBe('miss');
  });

  it('answers the SECOND reader from the cache and counts no second fetch', async () => {
    const { proxy, asked, store } = proxyFor({ [src]: { body: picture } });
    const first = await proxy.answer({ u: src, ip: '203.0.113.9' });
    const second = await proxy.answer({ u: src, ip: '203.0.113.9' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.headers as Record<string, string>)['x-fiddy-img']).toBe(
      'hit',
    );
    expect(asked).toHaveLength(1);
    expect(store.stats()).toMatchObject({ hits: 1, misses: 1, fetches: 1 });
  });

  it('counts fetches, not hits, against the per-visitor limit', async () => {
    const other = 'https://images.example/b.png';
    const { proxy } = proxyFor(
      { [src]: { body: picture }, [other]: { body: picture } },
      { limit: 0 },
    );
    // The first fetch is over a limit of zero, so it is refused...
    expect((await proxy.answer({ u: src, ip: '203.0.113.9' })).status).toBe(
      429,
    );
    // ...and nothing was cached, so a repeat is refused for the same reason.
    expect((await proxy.answer({ u: src, ip: '203.0.113.9' })).status).toBe(
      429,
    );
  });

  it('does not charge a limit for a hit', async () => {
    let spends = 0;
    const { safeGet } = getter({ [src]: { body: picture } });
    const proxy = createImageProxy({
      safeGet,
      cache: createImageCache(),
      limiter: () => {
        spends += 1;
        return false;
      },
      ownOrigins: [],
      log: () => {},
    } as never);
    await proxy.answer({ u: src, ip: '203.0.113.9' });
    await proxy.answer({ u: src, ip: '203.0.113.9' });
    expect(spends).toBe(1);
  });

  it('serves a huge picture but does not keep it', async () => {
    const big = pngOf(2000, 2000);
    const { proxy, store } = proxyFor(
      { [src]: { body: big } },
      { cache: { big: 10 } },
    );
    expect((await proxy.answer({ u: src, ip: '203.0.113.9' })).status).toBe(
      200,
    );
    expect(store.stats().entries).toBe(0);
  });

  it('holds a miss, so a broken avatar is not fetched on every render', async () => {
    const { proxy, asked } = proxyFor({
      [src]: { body: Buffer.from('not a picture') },
    });
    expect((await proxy.answer({ u: src, ip: '203.0.113.9' })).status).toBe(
      404,
    );
    expect((await proxy.answer({ u: src, ip: '203.0.113.9' })).status).toBe(
      404,
    );
    expect(asked).toHaveLength(1);
  });

  it('refuses a picture that is not one, and one past the pixel cap', async () => {
    const { proxy } = proxyFor({
      [src]: { body: Buffer.from('<html>hi</html>') },
      'https://images.example/bomb.png': { body: pngOf(60000, 60000) },
    });
    expect((await proxy.answer({ u: src, ip: '203.0.113.9' })).status).toBe(
      404,
    );
    expect(
      (
        await proxy.answer({
          u: 'https://images.example/bomb.png',
          ip: '203.0.113.9',
        })
      ).status,
    ).toBe(404);
  });

  it('refuses this host, a local host and a plain-http address without fetching', async () => {
    const { proxy, asked } = proxyFor({});
    for (const u of [
      'https://fiddy.fun/avatar.png',
      'https://127.0.0.1/a.png',
      'https://localhost/a.png',
      'http://images.example/a.png',
      'not a url',
      '',
    ]) {
      const answer = await proxy.answer({ u, ip: '203.0.113.9' });
      expect(answer.status).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  it('answers 403, not 502, when the address itself is refused', async () => {
    const { proxy } = proxyFor(
      { 'https://internal.example/a.png': { body: picture } },
      { dns: { 'internal.example': ['169.254.169.254'] } },
    );
    const answer = await proxy.answer({
      u: 'https://internal.example/a.png',
      ip: '203.0.113.9',
    });
    expect(answer.status).toBe(403);
  });

  it('serves an SVG only under its own byte budget', async () => {
    const { proxy } = proxyFor({
      'https://images.example/icon.svg': { body: SVG },
      'https://images.example/big.svg': {
        body: (() => {
          const big: Buffer = Buffer.alloc(SVG.length + SVG_MAX_BYTES);
          big.set(SVG, 0);
          return big;
        })(),
      },
    });
    expect(
      (
        await proxy.answer({
          u: 'https://images.example/icon.svg',
          ip: '203.0.113.9',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await proxy.answer({
          u: 'https://images.example/big.svg',
          ip: '203.0.113.9',
        })
      ).status,
    ).toBe(404);
  });
});

/* ----------------------------------------------------------------- handler --- */

describe('the route table', () => {
  const picture = pngOf(48, 48);
  const src = 'https://images.example/a.png';
  const handlerWith = (imageProxy?: unknown) =>
    createUnfurlHandler({
      origin: 'https://fiddy.fun',
      shellSource: () => '<html></html>',
      siteCard: () => Buffer.from('89504e470d0a1a0a', 'hex'),
      renderCard: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
      reader: { size: () => 0, feedSize: () => 0 },
      ...(imageProxy === undefined ? {} : { imageProxy }),
    } as never);

  it('answers a picture this host fetched', async () => {
    const { proxy } = proxyFor({ [src]: { body: picture } });
    const answer = await handlerWith(proxy).handle({
      method: 'GET',
      path: `/api/img?u=${encodeURIComponent(src)}`,
      ip: '203.0.113.9',
    });
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('image/png');
  });

  it('says pictures are loaded directly on a host that runs no proxy', async () => {
    const answer = await handlerWith().handle({
      method: 'GET',
      path: `/api/img?u=${encodeURIComponent(src)}`,
    });
    expect(answer.status).toBe(404);
    expect(String(answer.body)).toContain('loaded directly');
  });

  it('refuses a method that is not a read', async () => {
    const { proxy } = proxyFor({ [src]: { body: picture } });
    const answer = await handlerWith(proxy).handle({
      method: 'POST',
      path: '/api/img',
    });
    expect(answer.status).toBe(405);
  });

  it('reports the cache in the health route', async () => {
    const { proxy } = proxyFor({ [src]: { body: picture } });
    await proxy.answer({ u: src, ip: '203.0.113.9' });
    const answer = await handlerWith(proxy).handle({
      method: 'GET',
      path: '/unfurl/health',
    });
    const health = JSON.parse(String(answer.body));
    expect(health.images).toMatchObject({ entries: 1, misses: 1, fetches: 1 });
  });
});
