// Measure the LIVE client: sign-in complete -> first cast painted (cold), and a
// warm re-open -> first cast painted. This is the before/after instrument for
// the "casts take long to load after sign-in" report.
//
//   node apps/farcaster-web/scripts/measure-first-cast.mjs
//
// It prints the run as JSON to stdout and writes the whole run (including the
// request timeline) to MEASURE_OUT.
//
// Only the SIWF relay is stubbed — the same throwaway key, SIWE message, fid 3
// (`dwr`) and channel token the other probes use, so the app's own verifier
// accepts the sign-in for real — and every cross-origin write is aborted, so a
// run is a measurement and never a write.
//
// WHAT IS MEASURED, and why it is measured this way:
//
//   - "a cast is painted" is a VISIBLE link to a cast's own conversation route
//     (`a[href*="/conversations/"]` with a real box) — the permalink every
//     UnfocusedCast renders. The first paint of the feed is the first moment one
//     of those exists, whatever is still in flight behind it.
//   - cold is a FRESH browser context: no HTTP cache, no localStorage, no
//     session. That is the first-ever sign-in case.
//   - warm is the same context after the cold run, re-opening the app: the
//     browser's HTTP cache and the app's own storage are both warm, and only
//     the app's data cache is in question.
//   - every request the page makes is timestamped relative to the case's own
//     start, with its duration, so the wait can be attributed (the bundle, the
//     sign-in handshake, the node reads) instead of described.
//   - the engagement counts are checked TWICE per case: at the paint, and again
//     after waiting for them. A count can arrive behind a paint now (the
//     node-backed client answers a feed page before its counts are read), so
//     "the page paints early AND the numbers show up a moment later" is the
//     claim to measure — with `null` for counts that never appear, which is what
//     a feed stuck at no engagement numbers would report.
//   - the cold/warm read ordering says whether the count wave (`reactionsByCast`)
//     was still running when the first cast appeared, and when the page's own
//     reads (`castsByFid`) ended. Those two facts are what the card turns on and
//     they survive a loaded box, unlike absolute wall clock.
//
// Knobs: LIVE_SITE, LIVE_BOOT_MS (per-step ceiling), MEASURE_VIEWS (default
// "390,1440"), MEASURE_OUT, MEASURE_COUNT_MS (how long to wait for the counts).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SITE = process.env.LIVE_SITE ?? 'https://fiddy.fun';
const DOMAIN = new URL(SITE).host;
const CHANNEL_TOKEN = 'FIRSTCST';
const NONCE = 'c'.repeat(128);
const FID = 3;
const HANDLE = 'dwr';
const BOOT = Number(process.env.LIVE_BOOT_MS ?? 180_000);
/** How long the run waits for the first cast's counts after the paint. A feed
 * that paints early and shows no engagement numbers forever is not the fix, so
 * this wait exists to be able to say that. */
const COUNT_BUDGET = Number(process.env.MEASURE_COUNT_MS ?? 45_000);
const OUT =
  process.env.MEASURE_OUT ?? `${process.cwd()}/first-cast-measure.json`;
const VIEWS = (process.env.MEASURE_VIEWS ?? '390,1440')
  .split(',')
  .map((label) => Number(label.trim()))
  .filter((width) => Number.isFinite(width) && width > 0);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The permalink every cast in the feed paints: `/~/conversations/<full hash>`,
 * the timestamp link inside each cast. A cast is on screen when one of those has
 * a real box. Kept as one expression so the cold and warm waits cannot drift
 * apart.
 *
 * It used to be the `/<handle>/<0x prefix>` route, which the node-backed client
 * answers with "This page isn't on your node" — that is the read
 * `/v2/user-thread-casts` and a Snapchain node cannot address a hash prefix at
 * all. The feed now paints the full-hash route (card t_5068bb26), so this
 * detector names the page a node can answer rather than one it cannot. */
const CAST_LINK = 'a[href]';
const CAST_HREF = /^\/~\/conversations\/0x[0-9a-f]{8,}$/i;

/**
 * In-page: the first visible cast, and the engagement counts drawn on it RIGHT
 * NOW. Returns `{ cast, method, likes, recasts, replies, page, pageNumbers }`,
 * where the three kinds are the numbers on screen (empty when the count is not
 * drawn at all).
 *
 * Two ways of reading it, because two builds exist:
 *
 *   - `markers` — the count spans carry `data-fiddy-count`, which is how a build
 *     that knows a count can arrive LATE says which count it is. This is the
 *     exact answer. The markers live on `CastDetails` AND on the count beside a
 *     cast's action icons (`CastReactionAction`, added for this card): the
 *     action bar is the only place a non-focused cast draws a number, so
 *     without it the feed's numbers were unreadable from the DOM and a count
 *     that arrived behind the paint could not be told from one that never
 *     arrived.
 *   - `titles` — a build from before those markers: every count the fork draws
 *     is a span whose `title` is the number, sitting beside a label naming it
 *     ("likes"), so that pair is what is looked for. Coarser, but it makes a
 *     before/after comparison possible against a release already deployed.
 *
 * `scope` is walked up from the permalink to the ancestor that actually holds
 * the cast's counts, and not `closest('div[class]')`: the permalink sits in the
 * cast's header and the counts are siblings under a common ancestor, so the old
 * one-level scope saw none of them and answered "no counts" for a cast with
 * 1,664 likes (measured, card t_0d0e9330).
 *
 * `page`/`pageNumbers` are the same question for the WHOLE page — how many
 * counts, of which kind, the feed is drawing at this moment. A wall of "0"s
 * that never becomes numbers is what those two are there to show.
 *
 * Self-contained on purpose: it is stringified into the page (`evaluate`, and
 * `waitForFunction` for the wait), so it closes over nothing.
 */
const COUNTS_DETECT = ({ link, pattern }) => {
  const re = new RegExp(pattern, 'i');
  const first = Array.from(document.querySelectorAll(link)).find(
    (node) =>
      re.test(node.getAttribute('href') ?? '') &&
      node.getBoundingClientRect().width > 0,
  );

  const pageMarks = Array.from(document.querySelectorAll('[data-fiddy-count]'));
  const page = {};
  for (const node of pageMarks) {
    const kind = node.getAttribute('data-fiddy-count');
    page[kind] = (page[kind] ?? 0) + 1;
  }
  // Every bare number the page is drawing (a count with no label of its own:
  // the action bar's).
  const pageNumbers = Array.from(document.querySelectorAll('span'))
    .filter(
      (node) =>
        /^[\d.,]+ ?(K|M)?$/.test((node.textContent ?? '').trim()) &&
        node.getBoundingClientRect().width > 0 &&
        (node.textContent ?? '').trim() !== '',
    )
    .map((node) => (node.textContent ?? '').trim());

  if (!first) {
    return {
      cast: null,
      method: 'none',
      likes: [],
      recasts: [],
      replies: [],
      page,
      pageNumbers,
      reason: 'no cast link is visible',
    };
  }

  const href = first.getAttribute('href');
  let scope = first;
  for (let i = 0; i < 12 && scope.parentElement; i += 1) {
    scope = scope.parentElement;
    if (scope.querySelector('[data-fiddy-count]')) {
      break;
    }
    if ((scope.innerText ?? '').length > 120) {
      break;
    }
  }
  const marks = Array.from(scope.querySelectorAll('[data-fiddy-count]'));

  if (marks.length > 0) {
    const held = (kind) =>
      marks
        .filter((node) => node.getAttribute('data-fiddy-count') === kind)
        .map((node) => node.getAttribute('title') ?? node.textContent);
    return {
      cast: href,
      method: 'markers',
      likes: held('likes'),
      recasts: held('recasts'),
      replies: held('replies'),
      page,
      pageNumbers,
    };
  }

  const labels = {
    likes: /likes?/i,
    recasts: /recasts?/i,
    replies: /repl(y|ies)/i,
  };
  const labeled = Array.from(scope.querySelectorAll('span[title]'));
  const named = (kind) =>
    labeled
      .filter((node) =>
        labels[kind].test(node.parentElement?.textContent ?? ''),
      )
      .map((node) => node.getAttribute('title'));
  // A build with no markers at all (before card t_0d0e9330) draws its counts as
  // bare numbers in the action bar too, so those are reported as well rather
  // than leaving `likes: []` to mean both "no count" and "cannot see it".
  const bare = Array.from(scope.querySelectorAll('span'))
    .filter((node) => /^[\d.,]+ ?(K|M)?$/.test((node.textContent ?? '').trim()))
    .map((node) => (node.textContent ?? '').trim());
  return {
    cast: href,
    method: 'titles',
    likes: named('likes'),
    recasts: named('recasts'),
    replies: named('replies'),
    bareNumbers: bare,
    page,
    pageNumbers,
  };
};

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SITE}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const result = {
  site: SITE,
  ranAt: new Date().toISOString(),
  driver: createHash('sha256')
    .update(readFileSync(new URL(import.meta.url)))
    .digest('hex'),
  host: {
    cpus: os.cpus().length,
    load: os.loadavg().map((n) => Math.round(n * 10) / 10),
  },
  notes: [],
  runs: [],
};
const note = (...parts) => result.notes.push(parts.join(' '));

// A deployment answers release.json; a locally served build does not, and that
// is a note rather than a failure.
let release = null;
try {
  release = await fetch(`${SITE}/release.json`, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(30_000),
  }).then((response) => response.json());
} catch (error) {
  note(
    `release.json: ${String(error).slice(0, 120)} (a locally served build has none)`,
  );
}
const shell = await fetch(`${SITE}/`, {
  signal: AbortSignal.timeout(60_000),
}).then((response) => response.text());
const entryMatch = shell.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
const entryChunk = entryMatch
  ? {
      path: entryMatch[0],
      bytes:
        Number(
          (
            await fetch(`${SITE}${entryMatch[0]}`, {
              signal: AbortSignal.timeout(180_000),
            })
          ).headers.get('content-length'),
        ) || null,
    }
  : null;
result.release = {
  ...(release ?? {
    revision: null,
    note: 'no release.json (a locally served build)',
  }),
  entryChunk,
};

const browser = await chromium.launch({ channel: 'chrome' });

for (const view of VIEWS.map((width) => ({
  label: String(width),
  width,
  height: width < 500 ? 844 : 900,
}))) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    ignoreHTTPSErrors: true,
    deviceScaleFactor: 1,
    isMobile: view.width < 500,
  });
  const page = await context.newPage();

  // ── the timeline: every request this page makes, with when it started and
  // how long the answer took. This is what attributes the wait.
  let timeline = [];
  let open = new Map();
  page.on('request', (request) => {
    open.set(request, {
      method: request.method(),
      url: request.url(),
      start: Date.now(),
      end: null,
      status: null,
      failed: null,
    });
  });
  const close = (request, failed) => {
    const entry = open.get(request);
    if (!entry) return;
    entry.end = Date.now();
    entry.failed = failed ?? null;
    timeline.push(entry);
  };
  page.on('requestfinished', async (request) => {
    close(request);
    const entry = timeline[timeline.length - 1];
    if (entry) {
      try {
        entry.status = (await request.response())?.status() ?? null;
      } catch {
        entry.status = null;
      }
    }
  });
  page.on('requestfailed', (request) =>
    close(request, request.failure()?.errorText ?? 'failed'),
  );

  const abortedWrites = [];
  const signIns = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();
    if (url.startsWith('https://relay.farcaster.xyz')) {
      if (method === 'OPTIONS')
        return route.fulfill({ status: 204, headers: CORS, body: '' });
      if (method === 'POST') {
        return route.fulfill({
          status: 201,
          headers: CORS,
          body: JSON.stringify({
            channelToken: CHANNEL_TOKEN,
            url: `https://farcaster.xyz/~/siwf?channelToken=${CHANNEL_TOKEN}`,
            nonce: NONCE,
          }),
        });
      }
      signIns.push(Date.now());
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify({
          state: 'completed',
          nonce: NONCE,
          message,
          signature,
          fid: FID,
          username: HANDLE,
          displayName: HANDLE,
        }),
      });
    }
    if (WRITE_METHODS.has(method) && !url.startsWith(SITE)) {
      abortedWrites.push(`${method} ${url}`);
      return route.abort();
    }
    return route.continue();
  });

  const run = {
    viewport: view.label,
    cold: {},
    warm: {},
    abortedWrites,
    timeline: [],
    warmTimeline: [],
  };

  /** Everything a cast-bearing page can be read from, for the report. */
  const sample = async () => {
    try {
      return await page.evaluate(
        ({ link, pattern }) => {
          const re = new RegExp(pattern, 'i');
          const visible = Array.from(document.querySelectorAll(link)).filter(
            (node) =>
              re.test(node.getAttribute('href') ?? '') &&
              node.getBoundingClientRect().width > 0,
          );
          const first = visible[0];
          const block = first
            ? (first.closest('div[class]')?.innerText ?? first.innerText)
            : '';
          return {
            casts: visible.length,
            href: first?.getAttribute('href') ?? null,
            text: (block ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
            body: (document.body?.innerText ?? '')
              .replace(/\s+/g, ' ')
              .slice(0, 220),
          };
        },
        { link: CAST_LINK, pattern: CAST_HREF.source },
      );
    } catch (error) {
      return { error: String(error).slice(0, 120) };
    }
  };

  /** Wait for the first cast, tolerating the sign-in's own navigation. The
   * predicate is self-contained and takes its pattern as an argument: a function
   * that closes over a module binding is serialized into the page without it. */
  const waitForFirstCast = async (budgetMs) => {
    const started = Date.now();
    await page
      .waitForFunction(
        ({ link, pattern }) => {
          const re = new RegExp(pattern, 'i');
          return Array.from(document.querySelectorAll(link)).filter(
            (node) =>
              re.test(node.getAttribute('href') ?? '') &&
              node.getBoundingClientRect().width > 0,
          ).length;
        },
        { link: CAST_LINK, pattern: CAST_HREF.source },
        { timeout: budgetMs, polling: 100 },
      )
      .catch((error) =>
        note(`first cast wait: ${String(error).slice(0, 140)}`),
      );
    return Date.now() - started;
  };

  /** The first visible cast's engagement counts, as they are on screen now.
   *
   * The counts carry `data-fiddy-count` markers (`CastDetails`), because a
   * count can arrive AFTER the cast was painted: the node-backed client answers
   * a feed page as soon as the page's own reads are done and reads its counts
   * behind it. So "is the like count on screen yet?" is a question with a real
   * answer, and this is what asks it — separate from whatever text the block
   * happens to hold.
   *
   * A build from before those markers existed is read the older way: a numeric
   * `title` on a span (which is how the fork renders every count) whose
   * neighbours name it ("likes"). `method` says which of the two answered, so a
   * comparison never mixes them silently.
   */
  const countsSample = async () => {
    try {
      return await page.evaluate(COUNTS_DETECT, {
        link: CAST_LINK,
        pattern: CAST_HREF.source,
      });
    } catch (error) {
      return { error: String(error).slice(0, 120) };
    }
  };

  /** How long after the paint the first cast's DEFERRED counts (its likes and
   * recasts) appear on screen.
   *
   * The two kinds a feed page now reads behind its paint. The reply count is
   * deliberately not part of the question: it arrives WITH the page, so it is
   * already drawn at the paint and waiting for it would answer instantly and
   * tell us nothing (and a focused cast's zero replies draws a "0" with a
   * marker of its own).
   *
   * `null` when neither appears inside the budget — a feed that paints early and
   * shows no engagement numbers at all is not the fix this measures, so the
   * wait has to be able to say so rather than time out silently.
   *
   * POLLED with `page.evaluate`, and never `page.waitForFunction` with a string
   * predicate: a string is evaluated with `eval` in the page, and the deployed
   * client's CSP has no `unsafe-eval`, so the wait died 260 ms after the paint
   * with "EvalError: Evaluating a string as JavaScript violates the following
   * Content Security Policy directive" — measured against live, twice
   * (2026-10-23, card t_b0291522). It reported `countsAfterPaintMs: null` and
   * then sampled the DOM ~300 ms after the paint, which is BEFORE the counts
   * (they land 1.5–2.0 s behind the paint), so a working feed read as a feed
   * that never drew a number. This instrument and
   * `probe-counts-behind-paint.mjs` disagree about what a user sees no longer:
   * a real function is passed over CDP (`Runtime.callFunctionOn`), which no CSP
   * blocks, and that is how the probe has always asked.
   */
  const waitForCountAfterPaint = async (budgetMs) => {
    const started = Date.now();
    const args = { link: CAST_LINK, pattern: CAST_HREF.source };
    try {
      while (Date.now() - started < budgetMs) {
        const sample = await page.evaluate(COUNTS_DETECT, args);
        if ((sample?.likes?.length ?? 0) + (sample?.recasts?.length ?? 0) > 0) {
          return Date.now() - started;
        }
        await page.waitForTimeout(250);
      }
    } catch (error) {
      note(
        `counts wait after paint: gave up after ${Date.now() - started} ms — ${String(error).slice(0, 140)}`,
      );
      return null;
    }
    note(
      `counts wait after paint: no deferred count on screen after ${Date.now() - started} ms`,
    );
    return null;
  };

  /** When the feed stopped asking for things after that first paint. */
  const waitForSettled = async () => {
    const started = Date.now();
    await page
      .waitForLoadState('networkidle', { timeout: 60_000 })
      .catch(() => {});
    return Date.now() - started;
  };

  // ── COLD: a fresh browser (no storage at all) signs in and waits for a cast.
  const coldStart = Date.now();
  try {
    await page.goto(`${SITE}/welcome/ready`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    });
    await page.waitForSelector('[data-fiddy="onboarding"]', { timeout: BOOT });
    const signIn = page
      .locator('button:has-text("sign in with Farcaster")')
      .first();
    await signIn.waitFor({ state: 'visible', timeout: BOOT });
    const clickedAt = Date.now();
    await signIn.click({ timeout: 60_000, force: true });
    const waited = await waitForFirstCast(BOOT);
    const paintedAt = Date.now();
    const inFlightAtPaint = open.size;
    const countsAtPaint = await countsSample();
    const countsAfterPaintMs = await waitForCountAfterPaint(COUNT_BUDGET);
    const countsAfterPaint = await countsSample();
    const sink = await page.evaluate(
      () => globalThis.__fiddyCountsBehind ?? null,
    );
    const settled = await waitForSettled();
    const signedInAt = signIns.length ? signIns[signIns.length - 1] : null;
    run.cold = {
      paintedAtEpoch: paintedAt,
      sink,
      readyMs: clickedAt - coldStart,
      signInCompletedMs: signedInAt ? signedInAt - clickedAt : null,
      firstCastMs: paintedAt - clickedAt,
      firstCastFromSignInMs: signedInAt ? paintedAt - signedInAt : null,
      countsAtPaint,
      countsAfterPaintMs,
      countsAfterPaint,
      settledAfterPaintMs: settled,
      inFlightAtPaint,
      waitedMs: waited,
      sample: await sample(),
      url: page.url(),
    };
  } catch (error) {
    run.cold = { error: String(error).slice(0, 300), url: page.url() };
  }
  run.timeline = timeline.map((entry) => ({
    method: entry.method,
    url: entry.url,
    fromMs: entry.start - coldStart,
    ms: entry.end === null ? null : entry.end - entry.start,
    status: entry.status,
    failed: entry.failed,
  }));
  timeline = [];
  open = new Map();

  // ── WARM: the same browser, with whatever the cold run left behind.
  const warmStart = Date.now();
  try {
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForFirstCast(BOOT);
    const paintedAt = Date.now();
    const inFlightAtPaint = open.size;
    const countsAtPaint = await countsSample();
    const countsAfterPaintMs = await waitForCountAfterPaint(COUNT_BUDGET);
    const countsAfterPaint = await countsSample();
    const sink = await page.evaluate(
      () => globalThis.__fiddyCountsBehind ?? null,
    );
    const settled = await waitForSettled();
    run.warm = {
      paintedAtEpoch: paintedAt,
      sink,
      firstCastMs: paintedAt - warmStart,
      countsAtPaint,
      countsAfterPaintMs,
      countsAfterPaint,
      inFlightAtPaint,
      settledAfterPaintMs: settled,
      sample: await sample(),
      url: page.url(),
      storage: await page.evaluate(() => {
        const keys = Object.keys(window.localStorage);
        return {
          count: keys.length,
          keys: keys.slice(0, 40),
          bytes: keys.reduce(
            (total, key) =>
              total + (window.localStorage.getItem(key)?.length ?? 0),
            0,
          ),
        };
      }),
    };
  } catch (error) {
    run.warm = { error: String(error).slice(0, 300), url: page.url() };
  }
  run.warmTimeline = timeline.map((entry) => ({
    method: entry.method,
    url: entry.url,
    fromMs: entry.start - warmStart,
    ms: entry.end === null ? null : entry.end - entry.start,
    status: entry.status,
    failed: entry.failed,
  }));

  result.runs.push(run);
  await context.close();
}

await browser.close();
writeFileSync(OUT, JSON.stringify(result, null, 2));

/** What the summary says: enough to compare two runs, nothing to interpret. */
const isNodeRead = (url) =>
  url.includes('haatz') ||
  url.includes('/snapchain-api/') ||
  url.includes('/v1/') ||
  url.includes('/v2/');

/** When a set of reads ran, relative to the case's own start. */
const readWindow = (list, needle) => {
  const reads = list
    .filter((entry) => entry.url.includes(needle))
    .map((entry) => ({
      from: entry.fromMs,
      to: entry.ms === null ? null : entry.fromMs + entry.ms,
    }));
  const ends = reads.map((read) => read.to).filter((to) => to !== null);
  return {
    count: reads.length,
    firstStartMs: reads.length
      ? Math.min(...reads.map((read) => read.from))
      : null,
    lastStartMs: reads.length
      ? Math.max(...reads.map((read) => read.from))
      : null,
    lastEndMs: ends.length ? Math.max(...ends) : null,
  };
};

/** The page's own reads vs the count wave, against the paint they used to hold
 * up: whether a count read was still running when the first cast appeared is
 * the fact this card turns on, and it is a fact that survives a loaded box. */
const readOrdering = ({ timeline: list, paintMs }) => {
  const page = readWindow(list, '/v1/castsByFid');
  const counts = readWindow(list, '/v1/reactionsByCast');
  const openAtPaint =
    paintMs === null
      ? null
      : list.filter(
          (entry) =>
            entry.url.includes('/v1/reactionsByCast') &&
            entry.fromMs <= paintMs &&
            (entry.ms === null || entry.fromMs + entry.ms >= paintMs),
        ).length;
  return {
    paintFromCaseStartMs: paintMs,
    pageReads: page,
    countReads: counts,
    countReadsStillRunningAtPaint: openAtPaint,
  };
};

/** What the counts sink did, per call, relative to the paint it belongs to.
 *
 * `updated` is what the sink filled; `missed` counts are the ones it could not
 * place because the cast was not in the query cache at that moment. Read from
 * `window.__fiddyCountsBehind`, which only a build with
 * `VITE_SNAPCHAIN_DEBUG=true` fills — `null` on a release, and that is a note
 * rather than a failure. */
const sinkSummary = (sample) => {
  const calls = sample?.sink;
  if (!Array.isArray(calls)) {
    return null;
  }
  const paintedAt = sample?.paintedAtEpoch;
  return calls.map((entry) => ({
    fromPaintMs: typeof paintedAt === 'number' ? entry.at - paintedAt : null,
    received: entry.received,
    updated: entry.updated,
    missed: entry.missed.length,
    cachedCasts: entry.cachedCasts,
  }));
};

const summary = result.runs.map((run) => {
  const nodeAt = (list) =>
    list.filter((entry) => isNodeRead(entry.url)).map((entry) => entry.fromMs);
  const coldNode = nodeAt(run.timeline).sort((a, b) => a - b);
  const warmNode = nodeAt(run.warmTimeline).sort((a, b) => a - b);
  const coldPaintMs =
    typeof run.cold.readyMs === 'number' &&
    typeof run.cold.firstCastMs === 'number'
      ? run.cold.readyMs + run.cold.firstCastMs
      : null;
  return {
    viewport: run.viewport,
    coldFirstCastMs: run.cold.firstCastMs ?? null,
    coldFromSignInMs: run.cold.firstCastFromSignInMs ?? null,
    coldError: run.cold.error ?? null,
    coldCasts: run.cold.sample?.casts ?? null,
    coldInFlightAtPaint: run.cold.inFlightAtPaint ?? null,
    coldCountsAtPaint: run.cold.countsAtPaint ?? null,
    coldCountsAfterPaintMs: run.cold.countsAfterPaintMs,
    coldCountsAfterPaint: run.cold.countsAfterPaint ?? null,
    /** The sink's own view: what the count wave was handed, how much of it
     * landed, and how many casts were cached when it ran. A wave that arrives
     * before the feed has cached its page reports `missed > 0` here — the
     * numbers never reach the screen and only this says why. */
    coldSink: sinkSummary(run.cold),
    /** How many counts the whole feed is drawing at the paint and after
     * waiting, by kind — a feed whose every number is absent at the paint and
     * present later is the shape this card claims. */
    coldPageAtPaint: run.cold.countsAtPaint?.page ?? null,
    coldPageNumberCountAtPaint:
      run.cold.countsAtPaint?.pageNumbers?.length ?? null,
    coldPageAfter: run.cold.countsAfterPaint?.page ?? null,
    coldPageNumberCountAfter:
      run.cold.countsAfterPaint?.pageNumbers?.length ?? null,
    coldText: run.cold.sample?.text ?? null,
    warmFirstCastMs: run.warm.firstCastMs ?? null,
    warmError: run.warm.error ?? null,
    warmCasts: run.warm.sample?.casts ?? null,
    warmInFlightAtPaint: run.warm.inFlightAtPaint ?? null,
    warmCountsAtPaint: run.warm.countsAtPaint ?? null,
    warmCountsAfterPaintMs: run.warm.countsAfterPaintMs,
    warmCountsAfterPaint: run.warm.countsAfterPaint ?? null,
    warmSink: sinkSummary(run.warm),
    warmPageAtPaint: run.warm.countsAtPaint?.page ?? null,
    warmPageAfter: run.warm.countsAfterPaint?.page ?? null,
    warmText: run.warm.sample?.text ?? null,
    warmStorageKeys: run.warm.storage?.keys ?? null,
    warmStorageBytes: run.warm.storage?.bytes ?? null,
    coldRequests: run.timeline.length,
    coldNodeReads: coldNode.length,
    coldFirstNodeReadMs: coldNode[0] ?? null,
    warmRequests: run.warmTimeline.length,
    warmNodeReads: warmNode.length,
    warmFirstNodeReadMs: warmNode[0] ?? null,
    abortedWrites: run.abortedWrites.length,
    coldReadOrdering: readOrdering({
      timeline: run.timeline,
      paintMs: coldPaintMs,
    }),
    warmReadOrdering: readOrdering({
      timeline: run.warmTimeline,
      paintMs: run.warm.firstCastMs ?? null,
    }),
  };
});
console.log(
  JSON.stringify(
    {
      out: OUT,
      driver: result.driver,
      release: result.release,
      host: result.host,
      notes: result.notes,
      runs: summary,
    },
    null,
    2,
  ),
);
