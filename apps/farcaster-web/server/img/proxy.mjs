/**
 * `GET /api/img?u=<encoded>`: somebody else's picture, fetched by this host
 * instead of by the reader's browser.
 *
 * WHY THIS EXISTS. Every avatar, embed picture and preview in a cast was
 * fetched by the reader's browser straight from the third-party host, so each
 * of those hosts learned the reader's address and referer on every render. This
 * route is the one place that can refuse (a private address, a non-picture, an
 * oversized one), cache (one fetch for every reader of one avatar), and answer
 * with headers that make a hostile picture inert.
 *
 * WHAT IT IS NOT. It is not a general proxy: https only, `GET`/`HEAD` only, no
 * request body, no cookies, no reader's referer, and a URL that names this host
 * is refused rather than looped back at itself. A response is served only when
 * the bytes are a picture this service can name (`pic.mjs`), sized within
 * `MAX_PIXELS`, and under the fetcher's byte cap.
 *
 * THE CACHE counts FETCHES, not hits, against the per-visitor limit: a reader
 * scrolling the same feed twice costs one fetch, and a hot avatar costs nothing
 * at all. That is the whole reason the limit can be this low.
 */

import { MAX_PIXELS, SVG_MAX_BYTES, picInfo, pixelCap } from './pic.mjs';
import { ImgFetchError } from './fetch.mjs';

/** A hostname on this machine or this network: never fetched, whoever asks. */
const isLocalHostname = (hostname) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    // Tailscale hands out 100.64/10.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^fe[89ab][0-9a-f]:/i.test(host)
  );
};

const text = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8', ...headers },
  body,
});

export const createImageProxy = ({
  safeGet,
  cache,
  limiter,
  /** The origins this host answers for: a URL naming one of them is refused, never fetched. */
  ownOrigins = [],
  log = () => {},
  logEvery = 500,
}) => {
  const own = new Set(
    ownOrigins
      .map((each) => {
        try {
          return new URL(each).host.toLowerCase();
        } catch {
          return undefined;
        }
      })
      .filter(Boolean),
  );
  /** Requests answered since the last hit-rate line. */
  let sinceLog = 0;

  const load = async (url, ip) => {
    if (limiter && limiter(ip)) {
      throw new ImgFetchError('IMG_RATE', 'too many pictures in a minute');
    }
    const answer = await safeGet(url);
    if (answer.status !== 200) {
      log(`img: ${url} answered ${answer.status}`);
      return null;
    }
    const info = picInfo(answer.body);
    if (!info) {
      log(`img: ${url} is not a picture`);
      return null;
    }
    if (!pixelCap(info)) {
      log(`img: ${url} is ${info.width}x${info.height}, past the ${MAX_PIXELS} pixel cap`);
      return null;
    }
    if (info.type === 'image/svg+xml' && answer.body.length > SVG_MAX_BYTES) {
      log(`img: ${url} is an SVG over ${SVG_MAX_BYTES} bytes`);
      return null;
    }
    return { info, body: answer.body, url: answer.url };
  };

  const served = (entry, cacheState) => ({
    status: 200,
    headers: {
      'content-type': entry.info.type,
      'content-length': String(entry.body.length),
      // Content-hashed by nobody, so a day is the ceiling; the cache is what
      // makes a repeat render free.
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      // An image is inert data. If a hostile one is opened as a page, it can
      // run nothing and reach nothing.
      'content-security-policy': "default-src 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-fiddy-img': cacheState,
    },
    body: entry.body,
  });

  return {
    /**
     * The answer for one request. `u` is the raw query value (already
     * URL-decoded by the caller), `ip` the rate-limit key.
     */
    async answer({ u, ip }) {
      sinceLog += 1;
      if (sinceLog >= logEvery) {
        sinceLog = 0;
        const stats = cache.stats();
        log(
          `img: ${stats.entries} kept, ${stats.bytes} bytes, hit rate ${stats.hitRate ?? 'n/a'} ` +
            `(${stats.hits} hits / ${stats.misses} misses), ${stats.bytesServed} bytes served`,
        );
      }
      if (typeof u !== 'string' || u === '' || u.length > 2048) {
        return text(400, 'A picture address is missing or too long.\n');
      }
      let url;
      try {
        url = new URL(u);
      } catch {
        return text(400, 'That is not a picture address.\n');
      }
      if (url.protocol !== 'https:') {
        return text(400, 'Only https pictures are loaded.\n');
      }
      const host = url.host.toLowerCase();
      if (own.has(host) || isLocalHostname(url.hostname)) {
        return text(400, 'That picture is on this host already.\n');
      }
      url.hash = '';
      const key = url.href;
      const cached = cache.stats();
      try {
        const entry = await cache.get(key, () => load(key, ip));
        if (!entry) {
          return text(404, 'That address has no picture this host can show.\n', {
            'cache-control': 'public, max-age=600',
            'x-fiddy-img': 'miss',
          });
        }
        const after = cache.stats();
        // A load that finished inside this call is a MISS; one that came from
        // the map is a HIT. `fetches` moving is the honest tell, and it is the
        // same counter the per-visitor limit uses.
        const state = after.fetches > cached.fetches ? 'miss' : 'hit';
        return served(entry, state);
      } catch (error) {
        const code = error?.code;
        if (code === 'IMG_RATE') {
          return text(429, 'Too many pictures at once. Try again in a minute.\n', {
            'retry-after': '60',
          });
        }
        if (code === 'IMG_ADDRESS_REFUSED') {
          // The reason is in the service log, not in the answer: a caller does
          // not get to learn what this host's network looks like.
          log(`img: refused ${host}: ${error.reason ?? error.message}`);
          return text(403, 'That address is not a place this host loads pictures from.\n');
        }
        if (code === 'IMG_TOO_BIG') {
          return text(502, 'That picture is too large to load here.\n');
        }
        if (code === 'IMG_INSECURE') {
          return text(400, 'Only https pictures are loaded.\n');
        }
        log(`img: ${url.href} failed: ${error?.message ?? error}`);
        return text(502, 'That picture could not be loaded.\n');
      }
    },

    stats: () => cache.stats(),
  };
};