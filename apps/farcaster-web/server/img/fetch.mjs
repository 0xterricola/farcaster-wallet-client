/**
 * The one fetcher `/api/img` uses, hardened where a fetcher that takes a
 * stranger's URL has to be.
 *
 * The rules, each of which has a test:
 *
 *   * **HTTPS only.** A plain-http URL is refused rather than upgraded: the
 *     caller can upgrade it (`proxiedExternalMediaUrl` does, in the browser)
 *     and this service should not be a reason for a picture to move over a
 *     cleartext hop.
 *   * **The address check runs inside the socket's DNS lookup.** `lookup` is
 *     passed to `connect`, which hands it to the socket. There is no "resolve,
 *     compare, then connect" step for a hostile resolver to answer twice.
 *   * **Every redirect hop is a new request, and so a new checked lookup.**
 *     At most `maxRedirects` hops; a hop to another scheme is refused.
 *   * **A deadline, and a byte cap.** The deadline covers the whole chain, not
 *     each hop. The cap is enforced while the body arrives (`connect` streams),
 *     and again on the finished body, so a fake transport in a test cannot
 *     slip past it either.
 *
 * `connect` and `lookup` are injectable, which is how the battery in
 * `src/__tests__/imageProxy.test.ts` exercises every rule without a network.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { guardedLookup } from './addresses.mjs';

/** A refusal with a code the route can turn into one honest sentence. */
export class ImgFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImgFetchError';
    this.code = code;
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The real transport: one node `http`/`https` request, streamed into a buffer
 * that stops at `maxBytes`.
 *
 * `lookup` is the socket's resolver, so the address guard is the connection's
 * own decision. A body that runs past the cap destroys the socket and rejects
 * with `IMG_TOO_BIG` — the connection is not read to its end on the promise
 * that the sender will stop.
 */
export const nodeConnect = ({ url, method, headers, body, lookup, signal, maxBytes }) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      target,
      {
        method,
        headers,
        lookup,
        // The socket is the only thing that should ever see this connection.
        agent: false,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            request.destroy();
            reject(new ImgFetchError('IMG_TOO_BIG', 'the picture is larger than this service keeps'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', (error) => reject(error));
      },
    );
    request.on('error', (error) => reject(error));
    if (signal) {
      signal.addEventListener('abort', () => {
        request.destroy();
        reject(new ImgFetchError('IMG_TIMEOUT', 'the picture did not arrive in time'));
      });
    }
    if (body) {
      request.write(body);
    }
    request.end();
  });

const DEADLINE = Symbol('deadline');

/**
 * `safeGet(url)` → `{ status, headers, body, url }`, or an `ImgFetchError`.
 *
 * `url` in the answer is the address that actually answered (after redirects),
 * which is what the cache keys and the log line name.
 */
export const createSafeGet = ({
  connect = nodeConnect,
  lookup = dnsLookup,
  timeoutMs = 8_000,
  maxBytes = 5_000_000,
  maxRedirects = 3,
  log = () => {},
}) => {
  const guarded = guardedLookup(lookup);

  const once = async (url, options) => {
    const controller = new AbortController();
    let timer;
    try {
      const answer = await Promise.race([
        connect({ ...options, url, lookup: guarded, signal: controller.signal, maxBytes }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(DEADLINE), timeoutMs);
        }),
      ]);
      if (answer === DEADLINE) {
        controller.abort();
        throw new ImgFetchError('IMG_TIMEOUT', 'the picture did not arrive in time');
      }
      if (answer.body.length > maxBytes) {
        throw new ImgFetchError('IMG_TOO_BIG', 'the picture is larger than this service keeps');
      }
      return answer;
    } finally {
      clearTimeout(timer);
    }
  };

  return async (rawUrl, { method = 'GET', headers = {} } = {}) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ImgFetchError('IMG_BAD_URL', 'that address is not a URL');
    }
    const sent = {
      method,
      headers: {
        // Never the reader's referer: the whole point is that the host does not
        // learn who asked.
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml;q=0.9,*/*;q=0.1',
        'accept-encoding': 'identity',
        'user-agent': 'FiddyImageProxy/1.0 (+https://fiddy.fun)',
        ...headers,
      },
    };
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (url.protocol !== 'https:') {
        throw new ImgFetchError('IMG_INSECURE', 'only https pictures are loaded');
      }
      const answer = await once(url.href, sent);
      const location = answer.headers?.location;
      if (!REDIRECTS.has(answer.status) || typeof location !== 'string' || location === '') {
        return { ...answer, url: url.href };
      }
      let next;
      try {
        next = new URL(location, url.href);
      } catch {
        throw new ImgFetchError('IMG_BAD_URL', 'that address redirected nowhere usable');
      }
      log(`redirect ${hop + 1}: ${url.host} -> ${next.host}`);
      url = next;
    }
    throw new ImgFetchError('IMG_TOO_MANY_HOPS', 'that address redirected too many times');
  };
};