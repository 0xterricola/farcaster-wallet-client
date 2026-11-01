// A tab that was open before a deploy heals itself — once, and only when a
// reload can actually help.
//
//   pnpm build && node scripts/verify-stale-chunk-reload.mjs
//
// WHY IT EXISTS
//
// A release replaces the hashed chunks and the host serves only the current
// build, so a tab loaded before the cutover still holds the previous build's
// module graph: the first `React.lazy` surface it opens afterwards asks for a
// chunk file that is no longer served, the import rejects, and with nothing
// listening the click does nothing at all. `~/init/initReloadOnStaleChunks`
// listens for vite's `vite:preloadError` and reloads the page once per 30 s.
// This probe measures that from a browser: the REAL 404, the REAL reload, and
// the guard that has to survive a chunk which is genuinely gone.
//
// THE HARNESS, HONESTLY
//
// One build, served twice. Before the deploy the server answers 404 for every
// chunk the document does not itself name — the shape a stale tab meets — and
// the first such request IS the deploy landing (the server switches to serving
// the build's chunks from that moment on, which is what a cutover does to a
// chunk URL: dead before, alive after). The two "releases" are therefore the
// same bytes; what the tab experiences does not depend on them differing, and
// a second build would take minutes to produce byte-identical output.
//
// After the deploy the host serves its chunks again — EXCEPT the second
// distinct chunk this session asks for, which is 404ed on purpose. That is the
// "a chunk is really missing" case: the listener must have spent itself on the
// first reload and must NOT reload again. One build, two halves of the rule.
//
// Nothing is posted, signed in, or sent anywhere: the app is served from this
// machine and only read from a browser.
//
// WHAT IT ASSERTS
//   1. a tab from before a deploy asks for a chunk the host no longer serves
//      (a lazy chunk 404, and the tab was loaded before it)
//   2. the tab reloads itself, exactly once, and the stamp in sessionStorage
//      proves it was this listener rather than something that looked like it
//   3. the chunk that was dead loads from the new build (the same URL, 200)
//   4. the surface that was waiting on it is not the end of the road: the
//      preloader carries on past it into further chunks
//   5. a chunk that IS really gone does not reload the page again — the tab
//      stays where it is instead of looping

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const DIST = process.env.STALE_CHUNK_DIST ?? resolve(appRoot, 'dist');
const BOOT_TIMEOUT_MS = Number(
  process.env.STALE_CHUNK_BOOT_TIMEOUT ?? 120_000,
);
/** How long to wait, after the reload, to be sure no second one is coming. */
const SETTLE_MS = Number(process.env.STALE_CHUNK_SETTLE_MS ?? 9_000);
const STAMP_KEY = 'fiddy:stale-chunk-reload';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

const results = [];
const record = (n, ok, detail) => {
  results.push({ n, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`);
  if (detail) console.log(`        ${detail}`);
};

const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');

/** The chunks the document itself names: the entry and its modulepreloads. */
const documentChunks = new Set(
  [...indexHtml.matchAll(/assets\/([A-Za-z0-9._-]+\.js)/g)].map((m) => m[1]),
);

/** Every request the browser made, in order. */
const requests = [];
/** The deploy that lands mid-session. */
let deployed = false;
/** Distinct lazy chunks the browser has asked for since the deploy. */
const chunksSinceDeploy = new Map();
/** HTML documents served — one per navigation, so the reload counter. */
let documents = 0;

const isAssetPath = (name) =>
  name.startsWith('assets/') || /\.[a-z0-9]+$/i.test(name);

const isLazyChunk = (name) =>
  name.startsWith('assets/') &&
  name.endsWith('.js') &&
  !documentChunks.has(name.slice('assets/'.length));

const notFound = (res, name, reason) => {
  requests.push({ name, status: 404, kind: isLazyChunk(name) ? 'lazy-chunk' : 'asset', deployed, reason });
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`not found: ${name}`);
};

const serveShell = (res, pathname) => {
  documents += 1;
  requests.push({ name: 'index.html', status: 200, kind: 'document', deployed, pathname });
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    // A shell that cannot be cached cannot hide a cutover behind a TTL.
    'cache-control': 'no-store',
  });
  res.end(indexHtml);
};

/** This machine, standing in for the host: one build, two policies. */
const serve = () =>
  new Promise((done) => {
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(
        new URL(req.url, 'http://localhost').pathname,
      );
      const name = pathname.replace(/^\//, '');
      const file = path.join(DIST, pathname);
      const exists =
        name.length > 0 && fs.existsSync(file) && fs.statSync(file).isFile();

      if (!exists && isAssetPath(name)) {
        notFound(res, name);
        return;
      }

      if (!exists) {
        // Anything else is a route the app owns.
        serveShell(res, pathname);
        return;
      }

      if (isLazyChunk(name)) {
        if (!deployed) {
          // The release this tab was loaded from is no longer what the host
          // serves: its chunks are gone the moment the deploy lands, and this
          // request is where it lands. The answer is recorded against the build
          // the tab was actually loaded from, so the check can tell the dead
          // chunk from a chunk that is missing afterwards.
          notFound(res, name, 'the build this tab was loaded from is gone');
          deployed = true;
          return;
        }

        const previous = chunksSinceDeploy.get(name);
        chunksSinceDeploy.set(name, (previous ?? 0) + 1);

        // The second distinct chunk this session asks for is missing for real.
        if (previous === undefined && chunksSinceDeploy.size === 2) {
          notFound(res, name, 'this chunk is genuinely missing');
          return;
        }
      }

      const body = fs.readFileSync(file);
      requests.push({ name, status: 200, kind: isLazyChunk(name) ? 'lazy-chunk' : 'asset', deployed });
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
    });

    server.listen(0, '127.0.0.1', () => {
      done({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });

const until = async (what, predicate, timeoutMs = BOOT_TIMEOUT_MS) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(100);
  }
  console.log(`        timed out waiting for ${what}`);
  return false;
};

const run = async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`no build at ${DIST} — run \`pnpm build\` first`);
  }

  console.log(`serving ${DIST} (${documentChunks.size} document chunks, the rest lazy)`);
  const { server, origin } = await serve();
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: BOOT_TIMEOUT_MS });

    // 1. the stale chunk, which is also the moment the deploy lands.
    const deadChunk = () =>
      requests.find(
        (entry) => entry.kind === 'lazy-chunk' && entry.status === 404 && !entry.deployed,
      );
    const dead = await until('the stale tab to ask for a chunk that is gone', () => Boolean(deadChunk()));
    const deadName = deadChunk()?.name ?? '';
    // Read the ORDER back out of the log rather than off a live counter: the
    // reload can land between two polls, and the claim is about before/after.
    const deadAt = requests.findIndex(
      (entry) => entry.kind === 'lazy-chunk' && entry.status === 404 && !entry.deployed,
    );
    const documentsBefore = requests.filter(
      (entry, index) => entry.kind === 'document' && index < deadAt,
    ).length;
    const documentsAfter = requests.filter(
      (entry, index) => entry.kind === 'document' && index > deadAt,
    ).length;
    record(
      '1. a tab from before a deploy asks for a chunk the host no longer serves',
      // One document had loaded when it asked, and the reload that follows is
      // still ahead of it in this log — which is the whole shape being claimed.
      dead && documentsBefore === 1,
      dead
        ? `${deadName} -> 404, with ${documentsBefore} document(s) loaded before it and the reload ${documentsAfter === 1 ? 'after it' : `(${documentsAfter})`}`
        : 'no lazy chunk was ever 404ed',
    );

    // 2. the reload, exactly once.
    const reloaded = await until('the page to reload itself', () => documents >= 2);
    const stamp = await page
      .evaluate((key) => window.sessionStorage.getItem(key), STAMP_KEY)
      .catch(() => null);
    const stampAge = stamp === null ? null : Date.now() - Number(stamp);
    record(
      '2. the tab reloads itself, exactly once, on this listener',
      reloaded &&
        documents === 2 &&
        navigations >= 2 &&
        stamp !== null &&
        stampAge !== null &&
        stampAge >= 0 &&
        stampAge < 30_000,
      `documents=${documents} navigations=${navigations} ${STAMP_KEY}=${stamp} (${stampAge}ms old)`,
    );

    // 3. the same URL, alive on the other side of the deploy.
    const revived = await until(
      'the dead chunk to come back from the new build',
      () =>
        requests.some(
          (entry) =>
            entry.name === deadName && entry.status === 200 && entry.deployed,
        ),
    );
    record(
      '3. the chunk that was dead loads from the new build',
      revived,
      requests
        .filter((entry) => entry.name === deadName)
        .map((entry) => `${entry.status}${entry.deployed ? ' (new build)' : ''}`)
        .join(' -> ') || `${deadName} was never asked for again`,
    );

    // 4. the preloader carries on past it, so the dead chunk was not the end.
    const carriedOn = await until(
      'the preloader to move past the chunk that had died',
      () =>
        requests.filter(
          (entry) =>
            entry.kind === 'lazy-chunk' && entry.status === 200 && entry.deployed,
        ).length >= 2,
    );
    const alive = await page
      .evaluate(() => {
        const root = document.getElementById('root');
        return {
          mounted: Boolean(root && root.childElementCount > 0),
          body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
        };
      })
      .catch(() => ({ mounted: false, body: '' }));
    record(
      '4. the surface that was waiting on it is not the end of the road',
      carriedOn && alive.mounted,
      `chunks served after the deploy: ${
        requests
          .filter((entry) => entry.kind === 'lazy-chunk' && entry.status === 200 && entry.deployed)
          .map((entry) => entry.name)
          .join(', ') || 'none'
      }; root mounted=${alive.mounted} body="${alive.body}"`,
    );

    // 5. a chunk that is really missing must not reload the page again.
    const secondGone = await until(
      'a chunk that is genuinely missing',
      () =>
        requests.filter(
          (entry) =>
            entry.kind === 'lazy-chunk' && entry.status === 404 && entry.deployed,
        ).length >= 1,
    );
    const documentsAtThe404 = documents;
    await delay(SETTLE_MS);
    record(
      '5. a chunk that is really gone does not reload the page again',
      secondGone && documents === documentsAtThe404 && documents === 2,
      `${documentsAtThe404} document(s) when the second chunk 404ed, ${documents} after ${SETTLE_MS}ms — the guard held`,
    );

    console.log('\n── every request, in order ──');
    for (const entry of requests) {
      console.log(
        `  ${entry.deployed ? 'after ' : 'before'} ${entry.status} ${entry.name}${entry.reason ? `  (${entry.reason})` : ''}`,
      );
    }
    if (consoleErrors.length) {
      console.log('\n── console errors (the app\'s own) ──');
      for (const line of consoleErrors.slice(0, 10)) console.log(`  ${line}`);
    }
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks pass against ${origin}`);
  if (failed.length) {
    console.log(`FAILED: ${failed.map((entry) => entry.n).join(', ')}`);
    process.exitCode = 1;
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});