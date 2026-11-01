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
 *   FIDDY_LOOKS_DIR       where shared looks are kept (see looks.mjs). Absent
 *                         means this host stores none: a look it already holds
 *                         still renders, and a share request refuses in one
 *                         sentence rather than failing silently.
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
 */

import { statSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callerAddress } from './callerAddress.mjs';
import { createCardRenderer } from './cards.mjs';
import { carriesApiBody, LOOK_SHARE_PATH, readLookBody } from './lookBody.mjs';
import { createLookStore, LOOK_LIMITS } from './looks.mjs';
import { createUnfurlHandler } from './handler.mjs';
import { createLinkReader } from './reader.mjs';
import {
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

const reader = createLinkReader({
  fetchImpl: (...args) => fetch(...args),
  nodeBaseUrl: process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com',
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

const handler = createUnfurlHandler({
  origin: process.env.FIDDY_ORIGIN ?? 'https://fiddy.fun',
  shellSource: loadShell,
  siteCard: loadSiteCard,
  renderCard,
  reader,
  looks,
  translator,
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
    // own: a look share is 8 KB by `LOOK_LIMITS.bytes`, a translation ask 4 KB.
    const body = carriesApiBody(method, path)
      ? await readLookBody(
          request,
          path.split('?')[0] === LOOK_SHARE_PATH
            ? LOOK_LIMITS.bytes
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
  process.stdout.write(
    `${request.method} ${path} ${answer.status} ${note}${cause ? ` (${cause})` : ''}\n`,
  );
});

server.listen(port, host, () => {
  process.stdout.write(
    `fiddy-unfurl on ${host}:${port} | shell ${shellPath} (${loadShell().length} bytes) | ` +
      `site card ${loadSiteCard() ? 'yes' : 'NO'} | node ${process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com'} | ` +
      `cast-hash index ${process.env.NEYNAR_API_KEY ? 'keyed' : 'unconfigured'} | ` +
      `translations ${translator ? (translator.available() ? 'on' : 'no key') : 'off'}\n`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
