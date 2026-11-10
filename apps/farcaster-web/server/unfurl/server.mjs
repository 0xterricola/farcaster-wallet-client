/**
 * fiddy-unfurl: the server that answers a cast or profile URL as itself.
 *
 *   node server.mjs        (loopback only; nginx is the only caller)
 *
 * It ships inside the client release (`release/server/unfurl/`) and runs from
 * `current`, so the shell it serves and the shell nginx serves are the same
 * bytes from the same release — a page and its metadata cannot drift apart.
 *
 * Everything with a decision in it lives in `handler.mjs`; this file is wiring:
 * read the environment, load the release's own assets, listen, and log.
 *
 * ENVIRONMENT
 *   PORT                  default 3220 (loopback)
 *   FIDDY_WEB_ROOT        the release's web root; default ../../web
 *   FIDDY_SHELL           the shell to answer with; default <web root>/index.html
 *   FIDDY_ORIGIN          the public origin in the tags; default https://fiddy.fun
 *   SNAPCHAIN_HTTP_URL    the node the reads go to
 *   NEYNAR_API_KEY        the cast-hash -> author index. Without it a cast page
 *                         still answers, as the shell: nothing is invented.
 *   PYTHON                default python3, running render-card.py
 *   READ_TIMEOUT_MS       default 8000, for every upstream read
 *   FIDDY_PUBLIC_FEED     "off" disables the server-drawn /feed and serves the
 *                         ordinary shell (a host that wants the SPA only)
 *   FIDDY_PUBLIC_FEED_FIRST_WAIT_MS
 *                         default 2000, how long a cold /feed waits for the
 *                         node before answering the shell while the read keeps
 *                         going in the background
 *   FIDDY_LOOKS_DIR       where shared looks are kept (see looks.mjs). Absent
 *                         means this host stores none: a look it already holds
 *                         still renders, and a share request refuses in one
 *                         sentence rather than failing silently.
 *   FIDDY_FEED_REMOVED_JSON
 *                         a quilcast-shaped takedown list
 *                         (`{"casts":["0x…"],"fids":[3]}`) filtered out of
 *                         every RSS feed. Absent means this host keeps no
 *                         list, and every cast it can read is shown.
 *   FIDDY_TRANSLATIONS_DIR
 *                         where cast translations are kept (server/translate/),
 *                         and the switch that makes this host able to translate
 *                         at all: absent means `GET /api/translate` answers
 *                         `{on:false}` and the client draws no Translate control.
 *   OPENROUTER_API_KEY    the model credential for translations. Without it the
 *                         capability answers `{on:false}` (a kept translation is
 *                         still served), and asks refuse in one sentence rather
 *                         than reaching anywhere.
 *   OPENROUTER_URL        an OpenAI-compatible completion endpoint, if not
 *                         OpenRouter's own (a self-hoster's own model).
 *   OPENROUTER_MODELS     comma-separated model ids; `:free` only, and every
 *                         request caps the price at zero.
 *   FIDDY_IMG_PROXY       "on" makes this host fetch other sites' pictures
 *                         itself and serve them from its own origin
 *                         (`GET /api/img?u=…`, `../img/`). Absent means the
 *                         browser keeps loading them directly, and the route
 *                         answers one sentence saying so.
 *   FIDDY_IMG_CACHE_BYTES / _COUNT / _BIG_BYTES / _TTL_MS / _MISS_MS
 *                         the picture cache's budget: 64 MB, 20000 entries,
 *                         nothing over 2 MB kept, a day, a miss ten minutes.
 *   FIDDY_IMG_MAX_BYTES   the biggest picture fetched at all (5 MB).
 *   FIDDY_IMG_TIMEOUT_MS  the deadline for one fetch, redirects included (8 s).
 *   FIDDY_ALERTS_DIR      the state directory for phone alerts
 *                         (`server/alerts/`): subscriptions, one file per
 *                         reader, plus this host's own `vapid.json` push
 *                         identity. ABSENT is the default and means this host
 *                         does not run alerts: the capability route answers
 *                         `not-configured` and the browser draws no toggle.
 *                         The identity is generated ON THIS HOST (a setup
 *                         command, never a request), and a host that has the
 *                         directory without `vapid.json` answers `no-keys`
 *                         rather than borrowing fiddy.fun's.
 *   FIDDY_ALERTS_INTERVAL_MS
 *                         the floor between two consultations of one reader
 *                         (default 60000; 1 is a test, not a deployment).
 */

import { statSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callerAddress } from './callerAddress.mjs';
import { createCardRenderer } from './cards.mjs';
import {
  ALERTS_BODY_BYTES,
  carriesApiBody,
  LOOK_SHARE_PATH,
  readLookBody,
} from './lookBody.mjs';
import { createLookStore, LOOK_LIMITS } from './looks.mjs';
import { createUnfurlHandler } from './handler.mjs';
import { createLinkReader } from './reader.mjs';
import { createImageCache, CACHE_DEFAULTS } from '../img/cache.mjs';
import { createSafeGet } from '../img/fetch.mjs';
import { createImageProxy } from '../img/proxy.mjs';
import { createActivityReader, createNameReader, createNodeGet } from '../alerts/derive.mjs';
import { createAlertStore } from '../alerts/store.mjs';
import { createSubscribeGuard } from '../alerts/subscribe.mjs';
import { createAlertService } from '../alerts/service.mjs';
import { createVapidStore } from '../alerts/vapid.mjs';
import { createPublicFeedService } from '../public-feed/service.mjs';
import {
  createRateLimiter,
  createTranslationStore,
  createTranslator,
  TRANSLATION_BODY_BYTES,
} from '../translate/translate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot =
  process.env.FIDDY_WEB_ROOT ?? path.resolve(here, '..', '..', 'web');
const shellPath = process.env.FIDDY_SHELL ?? path.join(webRoot, 'index.html');
const siteCardPath = path.join(webRoot, 'fiddy-share-card.png');
const mascotPath = path.join(webRoot, 'fiddy-mark-poster.png');
const port = Number(process.env.PORT ?? 3220);
const host = process.env.HOST ?? '127.0.0.1';
const timeoutMs = Number(process.env.READ_TIMEOUT_MS ?? 8000);

/**
 * The shell, re-read when it changes on disk.
 *
 * A release cuts `current` to a new directory: a service that cached the shell
 * at boot would answer with the previous release's document, whose entry chunk
 * no longer exists. The release restarts this service, and this is what keeps
 * that from being the only thing standing between a release and a 404 — the
 * check is a `stat` at most once every 30 seconds, not per request.
 */
const shellState = { html: undefined, mtimeMs: 0, checkedAt: 0 };
const loadShell = () => {
  const now = Date.now();
  if (shellState.html !== undefined && now - shellState.checkedAt < 30_000) {
    return shellState.html;
  }
  const stat = statSync(shellPath);
  if (shellState.html === undefined || stat.mtimeMs !== shellState.mtimeMs) {
    shellState.html = readFileSync(shellPath, 'utf8');
    shellState.mtimeMs = stat.mtimeMs;
  }
  shellState.checkedAt = now;
  return shellState.html;
};

const siteCardState = { bytes: undefined, checkedAt: 0 };
const loadSiteCard = () => {
  const now = Date.now();
  if (siteCardState.bytes && now - siteCardState.checkedAt < 30_000) {
    return siteCardState.bytes;
  }
  try {
    siteCardState.bytes = readFileSync(siteCardPath);
  } catch {
    siteCardState.bytes = undefined;
  }
  siteCardState.checkedAt = now;
  return siteCardState.bytes;
};

// A service that cannot find the shell it ships with is not a service that can
// answer anything: refuse to start rather than serve a document from nowhere.
loadShell();

const origin = process.env.FIDDY_ORIGIN ?? 'https://fiddy.fun';

const reader = createLinkReader({
  fetchImpl: (...args) => fetch(...args),
  nodeBaseUrl: process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com',
  appOrigin: origin,
  neynarApiKey: process.env.NEYNAR_API_KEY,
  timeoutMs,
});

const renderCard = createCardRenderer({
  pythonPath: process.env.PYTHON ?? 'python3',
  scriptPath: path.join(here, 'render-card.py'),
  mascotPath,
}).render;

const looksDir = process.env.FIDDY_LOOKS_DIR;
const looks = looksDir ? createLookStore({ dir: looksDir }) : undefined;

/**
 * The server-drawn public feed. It reads the SAME public window the client
 * reads, behind a one-entry stale-while-refresh cache, and falls back to the
 * ordinary shell whenever the node cannot answer honestly.
 */
const feed =
  process.env.FIDDY_PUBLIC_FEED === 'off'
    ? undefined
    : createPublicFeedService({
        nodeBaseUrl: process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com',
        readTimeoutMs: timeoutMs,
        waitMs: Number(
          process.env.FIDDY_PUBLIC_FEED_FIRST_WAIT_MS ?? 2_000,
        ),
      });

/**
 * Cast translations (`../translate/translate.mjs`), or nothing.
 *
 * Nothing is a real state, not a broken one: a host with no state directory and
 * no model key answers `GET /api/translate` with `{on:false}`, and the client
 * draws no Translate control at all. Two halves, and either alone is enough to
 * be honest about it — the directory is where answers are kept, the key is what
 * reaches a model.
 */
const translationsDir = process.env.FIDDY_TRANSLATIONS_DIR;
const translator = translationsDir
  ? createTranslator({
      store: createTranslationStore({ dir: translationsDir }),
      // The cast's words come from the node, HERE. The browser may name the
      // author (it knows every cast's fid) because a node shards by FID — an
      // address, never the text: a caller cannot ask this service to translate
      // words of its own.
      getCastText: async (fid, hash) => {
        if (Number.isSafeInteger(fid)) {
          return reader.castText(fid, hash);
        }
        const author = await reader.authorOf(hash);
        return author === undefined ? undefined : reader.castText(author, hash);
      },
      key: process.env.OPENROUTER_API_KEY,
      models: process.env.OPENROUTER_MODELS?.split(',')
        .map((each) => each.trim())
        .filter(Boolean),
      url: process.env.OPENROUTER_URL,
      site: process.env.FIDDY_ORIGIN ?? 'https://fiddy.fun',
    })
  : undefined;

/**
 * The feeds' takedown list, or nothing. Read once at boot: it is a file a
 * person edits, not a read that can fail a request, and a malformed one is
 * IGNORED (with a line in the log) rather than served as a list nobody
 * checked — an unread list must not become "nothing is taken down" silently.
 */
const feedRemoved = (() => {
  const pathFromEnv = process.env.FIDDY_FEED_REMOVED_JSON;
  if (!pathFromEnv) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(pathFromEnv, 'utf8'));
    if (
      Array.isArray(parsed?.casts) &&
      Array.isArray(parsed?.fids) &&
      parsed.casts.every((hash) => typeof hash === 'string') &&
      parsed.fids.every((fid) => typeof fid === 'number')
    ) {
      return parsed;
    }
    process.stderr.write(
      `feeds: ${pathFromEnv} is not a removed list (needs casts[] and fids[])\n`,
    );
  } catch (error) {
    process.stderr.write(`feeds: could not read ${pathFromEnv}: ${error?.message ?? error}\n`);
  }
  return undefined;
})();

/**
 * The picture proxy (`../img/`), or nothing.
 *
 * ON means this host fetches other sites' pictures itself, caches them and
 * serves them from its own origin (`FIDDY_IMG_PROXY=on`). ABSENT is the default
 * and a real state, not a broken one: a self-hosted copy that has not opted in
 * keeps loading pictures from where they live, and `GET /api/img` answers one
 * sentence saying so. The browser's half of this is a build-time flag
 * (`VITE_IMAGE_PROXY`), set by the release that ships both halves together.
 *
 * Every number below is env overridable on purpose: the cache's size is what
 * the box can afford, and the fetcher's caps are what its operator will defend.
 */
const imageProxy =
  process.env.FIDDY_IMG_PROXY === 'on'
    ? createImageProxy({
        safeGet: createSafeGet({
          timeoutMs: Number(process.env.FIDDY_IMG_TIMEOUT_MS ?? 8_000),
          maxBytes: Number(process.env.FIDDY_IMG_MAX_BYTES ?? 5_000_000),
          maxRedirects: Number(process.env.FIDDY_IMG_MAX_REDIRECTS ?? 3),
          log: (message) => process.stderr.write(`${message}\n`),
        }),
        cache: createImageCache({
          bytes: Number(process.env.FIDDY_IMG_CACHE_BYTES ?? CACHE_DEFAULTS.bytes),
          count: Number(process.env.FIDDY_IMG_CACHE_COUNT ?? CACHE_DEFAULTS.count),
          big: Number(process.env.FIDDY_IMG_BIG_BYTES ?? CACHE_DEFAULTS.big),
          ttl: Number(process.env.FIDDY_IMG_TTL_MS ?? CACHE_DEFAULTS.ttl),
          miss: Number(process.env.FIDDY_IMG_MISS_MS ?? CACHE_DEFAULTS.miss),
        }),
        // Fetches, not hits, count: the proxy asks this only inside a load.
        // 120 fetches a minute is a lease of one full cold feed per visitor.
        limiter: createRateLimiter({ max: 120, windowMs: 60 * 1000 }),
        ownOrigins: [origin],
        log: (message) => process.stderr.write(`${message}\n`),
      })
    : undefined;

/**
 * Phone alerts (`../alerts/`), or nothing.
 *
 * Three states, each honest, and the browser is told which one it is standing
 * in before it draws anything:
 *
 *   * `FIDDY_ALERTS_DIR` ABSENT — this host does not run alerts at all. The
 *     capability route answers `not-configured`, and the settings copy explains
 *     the preference a self-hoster makes by NOT setting it: one more file of
 *     state, and a key that must be their own.
 *   * the directory without `vapid.json` — the host opted in but never made a
 *     push identity. `no-keys` is the answer, and a setup command generates it;
 *     a host's readers are never pointed at fiddy.fun's identity instead.
 *   * both — alerts are on, the loop starts, and the number of subscribers is
 *     in the health line, because a feature nobody can see working is a feature
 *     nobody can see broken.
 */
const alertsDir = process.env.FIDDY_ALERTS_DIR;
const alerts = alertsDir
  ? (() => {
      const nodeGet = createNodeGet({
        nodeBaseUrl:
          process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com',
        // None of the derivation's reads is on a request path, so the queueing
        // delay of a burst of subscribers is elastic. The named exceptions
        // (`AbortError`) still surface in `derive.mjs`'s own catches.
        timeoutMs: timeoutMs,
      });
      const store = createAlertStore({ dir: alertsDir });
      const vapid = createVapidStore({ dir: alertsDir });
      const guard = createSubscribeGuard({ nodeGet });
      const activityReader = createActivityReader({
        nodeGet,
        nameOf: createNameReader({ nodeGet }),
      });
      const service = createAlertService({
        store,
        vapid,
        activityReader,
        intervalMs: Number(process.env.FIDDY_ALERTS_INTERVAL_MS ?? 60_000),
        now: () => Date.now(),
      });
      service.start();
      return {
        service,
        store,
        vapid,
        guard,
        async capability() {
          const keys = await vapid.read();
          return keys
            ? {
                on: true,
                publicKey: keys.publicKey,
                kinds: ['mentions', 'replies', 'likes', 'follows'],
              }
            : { on: false, reason: 'no-keys' };
        },
        /**
         * The subscribe request a browser signs. The claim binds the reader to
         * THE PHONE'S OWN PUSH ADDRESS (`subscribe.mjs`), so a witnessed request
         * cannot re-point anybody's notifications.
         */
        async subscribe(body) {
          const subscription = body?.subscription ?? body;
          const checked = await guard.check({
            fid: body?.fid,
            signer: body?.signer,
            signature: body?.signature,
            endpoint: subscription?.endpoint,
            issuedAt: body?.issuedAt,
          });
          if (!checked.ok) {
            return {
              status: 403,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                error: 'That did not prove this key belongs to you.',
                reason: checked.reason,
              }),
            };
          }
          try {
            const stored = await store.write(Number(body.fid), {
              endpoint: subscription.endpoint,
              keys: subscription.keys,
              kinds: body.kinds,
              language: body.language,
              // Muted FIDs only — number for number. Words never leave the
              // browser, and the settings copy says so in plain text.
              mutedFids: body.mutedFids,
            });
            return {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                ok: true,
                createdAt: stored.createdAt,
                kinds: stored.kinds,
              }),
            };
          } catch {
            return {
              status: 400,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ error: 'This host could not store that.' }),
            };
          }
        },
        /**
         * Turning alerts OFF is the same proof with the claim bound to the word
         * `off` — the reader is removing a subscription, not pointing one, so
         * there is no phone address to bind to and nothing weaker is accepted.
         */
        async off(body) {
          const checked = await guard.check({
            fid: body?.fid,
            signer: body?.signer,
            signature: body?.signature,
            endpoint: 'off',
            issuedAt: body?.issuedAt,
          });
          if (!checked.ok) {
            return {
              status: 403,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: JSON.stringify({
                error: 'That did not prove this key belongs to you.',
                reason: checked.reason,
              }),
            };
          }
          await store.remove(Number(body.fid));
          return {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: true }),
          };
        },
      };
    })()
  : undefined;

const handler = createUnfurlHandler({
  origin,
  shellSource: loadShell,
  siteCard: loadSiteCard,
  renderCard,
  reader,
  feed,
  looks,
  translator,
  imageProxy,
  alerts,
  feedRemoved,
});

/**
 * The body of a share request, read by `lookBody.mjs`.
 *
 * Why it is a module of its own: what happens to a body PAST the cap is the
 * whole contract (read and drop, never destroy the socket — see that file's
 * header for the 405 this service used to answer with), and a rule that lives
 * inside this wiring file can only be exercised by a real socket. Everything
 * else the module needs is the model's own cap.
 */

/**
 * Who to count a request against.
 *
 * nginx is the only caller that matters and it forwards the proxy hop it saw in
 * `x-forwarded-for`. When that hop is Cloudflare, `callerAddress` uses the
 * visitor address Cloudflare proves; otherwise a forwarded visitor header is
 * ignored. This is only a rate-limit key, never identity or a log field.
 */
const server = createServer(async (request, response) => {
  const path = request.url ?? '/';
  let answer;
  try {
    const method = request.method ?? 'GET';
    // Only the POSTs that carry a JSON body have one worth reading; everything
    // else is answered without one, exactly as before. The cap is the model's
    // own: a look share is 8 KB by `LOOK_LIMITS.bytes`, a translation ask 4 KB,
    // a phone-alerts claim 32 KB (the hidden-people list rides with it).
    const body = carriesApiBody(method, path)
      ? await readLookBody(
          request,
          path.split('?')[0] === LOOK_SHARE_PATH
            ? LOOK_LIMITS.bytes
            : path.split('?')[0] === '/api/alerts' || path.split('?')[0] === '/api/alerts/off'
              ? ALERTS_BODY_BYTES
              : TRANSLATION_BODY_BYTES,
        )
      : undefined;
    answer = await handler.handle({
      method,
      path,
      body,
      ip: callerAddress(request),
    });
  } catch (error) {
    // Nothing a request can do should reach here; if something does, the answer
    // is still the app rather than a stack trace in a crawler's face.
    process.stderr.write(`unfurl: ${path} failed: ${error?.stack ?? error}\n`);
    answer = {
      status: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'unfurl failed\n',
    };
  }
  response.writeHead(answer.status, answer.headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(answer.body);
  const note = answer.headers['x-unfurl'] ?? '-';
  // A card on the fallback path says WHY in the same line the service logs, so
  // the host's log answers the question a refused release used to leave open.
  const cause = answer.headers['x-unfurl-note'];
  // A feed names the server that answered its read, in the log line too: the
  // chain is only honest if a person can see which link held it.
  const readFrom = answer.headers['x-fiddy-feed-read'];
  process.stdout.write(
    `${request.method} ${path} ${answer.status} ${note}${cause ? ` (${cause})` : ''}${readFrom ? ` [${readFrom}]` : ''}\n`,
  );
});

server.listen(port, host, () => {
  process.stdout.write(
    `fiddy-unfurl on ${host}:${port} | shell ${shellPath} (${loadShell().length} bytes) | ` +
      `site card ${loadSiteCard() ? 'yes' : 'NO'} | node ${process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com'} | ` +
      `cast-hash index ${process.env.NEYNAR_API_KEY ? 'keyed' : 'unconfigured'} | ` +
      `translations ${translator ? (translator.available() ? 'on' : 'no key') : 'off'} | ` +
      `pictures ${imageProxy ? 'proxied + cached' : 'direct (FIDDY_IMG_PROXY is not on)'} | ` +
      `alerts ${alerts ? 'loop running (FIDDY_ALERTS_DIR)' : 'off'} | ` +
      `feeds /~/profiles/<fid>/rss + /~/channel/<id>/rss (removed list ${feedRemoved ? 'on' : 'none'})\n`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
