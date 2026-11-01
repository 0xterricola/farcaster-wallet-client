// Probe: does a feed page's engagement count reach the screen after the paint?
//
//   node apps/farcaster-web/scripts/probe-counts-behind-paint.mjs
//
// The counts-behind-the-paint change (card t_0d0e9330) defers a feed page's
// per-cast like/recast reads so the page can paint without them. The claim it
// has to earn is two-sided: the page paints BEFORE its counts are read, AND the
// counts show up on screen a moment later. A feed that paints at 8 s and never
// draws an engagement number is not the fix.
//
// WHY THIS EXISTS BESIDE measure-first-cast.mjs
//
// That instrument answers the same question about the first visible cast in one
// narrow reading. This one asks it of the WHOLE PAGE, because that is where the
// numbers actually are: `CastDetails` is rendered by `FocusedCast` alone, so on
// the feed every cast's like/recast count is drawn ONLY beside its action icons
// (`CastReactionAction`), which carried no marker before this card and so were
// unreadable from the DOM. A feed that drew no counts at all, forever, and a
// feed whose counts arrived 2 s after the paint looked identical through the old
// detector — measured on release ce23b7b, where the counts were read and
// delivered and then dropped (see below).
//
// WHAT IT REPORTS
//
//   - every count on screen, by kind, at the paint and afterwards, read from the
//     `data-fiddy-count` markers (`CastReactionAction` and `CastDetails`);
//   - the first visible cast's own counts, so "the first cast is complete" can
//     be told from "some cast somewhere has a number";
//   - how long after the paint the first cast's DEFERRED counts (likes,
//     recasts) appear, and the reply count separately — replies arrive with the
//     page, so they are drawn at the paint and are not part of the wait;
//   - the read ordering: when the page's own reads ran, when the count wave ran,
//     and how many count reads were still in flight at the paint. Those survive
//     a loaded box, unlike absolute wall clock.
//
// AND THE SAME THING FOR A WARM RE-OPEN (`warm*` in the summary), which is the
// case a KEPT feed page belongs to: the page is restored from this browser's own
// storage, no page read happens, and before card t_43249104 no count was asked
// for on it either. The cold case is measured and mapped first and is not
// affected by it; the warm reads are counted in their own window, so "the kept
// page was not re-read" is a number here (`warmPageReads.count` 0) and not an
// assumption.
//
// `data-fiddy-count` is the contract this leans on: a surface that draws a count
// says which count it is, so "has the number arrived?" is a question with an
// answer instead of an inference from whatever text is in the block.
//
// Read-only: the SIWF relay is stubbed (the same throwaway key, fid 3 and
// channel token the other probes use) and every cross-origin write is aborted.
//
// Knobs: LIVE_SITE, PROBE_OUT, PROBE_VIEWS (default "390,1440"),
// PROBE_COUNT_MS (how long to keep watching for counts, default 45_000).
import { writeFileSync } from 'node:fs';
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SITE = process.env.LIVE_SITE ?? 'https://fiddy.fun';
const DOMAIN = new URL(SITE).host;
const CHANNEL_TOKEN = 'COUNTPRB';
const NONCE = 'p'.repeat(128);
const FID = 3;
const HANDLE = 'dwr';
const BOOT = Number(process.env.LIVE_BOOT_MS ?? 180_000);
const COUNT_BUDGET = Number(process.env.PROBE_COUNT_MS ?? 45_000);
const OUT =
  process.env.PROBE_OUT ?? `${process.cwd()}/counts-behind-paint.json`;
const VIEWS = (process.env.PROBE_VIEWS ?? '390,1440')
  .split(',')
  .map((label) => Number(label.trim()))
  .filter((width) => Number.isFinite(width) && width > 0);

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CAST_LINK = 'a[href]';
const CAST_HREF = /^\/~\/conversations\/0x[0-9a-f]{8,}$/i;

/** In-page: every engagement count this page is drawing right now.
 *
 * Document-wide, and per kind: `marksByKind` is how many counts of each kind are
 * on screen, `casts` groups them by the cast they belong to, and `numbers` is
 * every bare number drawn (a count with no label of its own — the action bar's —
 * in a build from before the markers existed).
 *
 * The first visible cast's block is found by walking UP from its permalink to
 * the ancestor that holds the cast's counts. `closest('div[class]')` stops one
 * level too early: the permalink lives in the cast's header and the counts are
 * siblings under a common ancestor.
 */
const READ_COUNTS = () => {
  const marks = Array.from(document.querySelectorAll('[data-fiddy-count]'));
  const marksByKind = {};
  const values = (kind) =>
    marks
      .filter((node) => node.getAttribute('data-fiddy-count') === kind)
      .map(
        (node) => node.getAttribute('title') ?? (node.textContent ?? '').trim(),
      );
  for (const node of marks) {
    const kind = node.getAttribute('data-fiddy-count');
    marksByKind[kind] = (marksByKind[kind] ?? 0) + 1;
  }

  const links = Array.from(document.querySelectorAll('a[href]')).filter(
    (node) =>
      /^\/~\/conversations\/0x[0-9a-f]{8,}$/i.test(
        node.getAttribute('href') ?? '',
      ) && node.getBoundingClientRect().width > 0,
  );

  const blockOf = (link) => {
    let scope = link;
    for (let i = 0; i < 12 && scope.parentElement; i += 1) {
      scope = scope.parentElement;
      if (scope.querySelector('[data-fiddy-count]')) return scope;
      if ((scope.innerText ?? '').length > 120) return scope;
    }
    return scope;
  };

  const first = links[0] ?? null;
  const firstBlock = first ? blockOf(first) : null;
  const firstMarks = firstBlock
    ? Array.from(firstBlock.querySelectorAll('[data-fiddy-count]'))
    : [];
  const firstByKind = {};
  for (const node of firstMarks) {
    const kind = node.getAttribute('data-fiddy-count');
    (firstByKind[kind] ??= []).push(
      node.getAttribute('title') ?? (node.textContent ?? '').trim(),
    );
  }

  const visibleNumbers = Array.from(document.querySelectorAll('span'))
    .filter(
      (node) =>
        /^[\d.,]+ ?(K|M)?$/.test((node.textContent ?? '').trim()) &&
        node.getBoundingClientRect().width > 0,
    )
    .map((node) => (node.textContent ?? '').trim());

  return {
    at: Date.now(),
    marks: {
      total: marks.length,
      byKind: marksByKind,
      likes: values('likes').slice(0, 8),
      recasts: values('recasts').slice(0, 8),
      replies: values('replies').slice(0, 8),
    },
    firstCast: {
      href: first?.getAttribute('href') ?? null,
      counts: firstByKind,
      text: firstBlock
        ? (firstBlock.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
        : null,
    },
    casts: links
      .map((link) => {
        const block = blockOf(link);
        return {
          href: link.getAttribute('href'),
          counts: Array.from(block.querySelectorAll('[data-fiddy-count]')).map(
            (node) => ({
              kind: node.getAttribute('data-fiddy-count'),
              value:
                node.getAttribute('title') ?? (node.textContent ?? '').trim(),
            }),
          ),
        };
      })
      .slice(0, 4),
    pageNumbers: visibleNumbers.length,
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
  host: {
    cpus: os.cpus().length,
    load: os.loadavg().map((n) => Math.round(n * 10) / 10),
  },
  release: null,
  runs: [],
};

try {
  result.release = await fetch(`${SITE}/release.json`, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(30_000),
  }).then((response) => response.json());
} catch {
  result.release = {
    note: 'no release.json (a locally served build has none)',
  };
}

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

  /** The deferred kinds: the two a feed page now reads behind its paint. */
  const deferredOnScreen = (sample) =>
    (sample?.firstCast?.counts?.likes?.length ?? 0) +
    (sample?.firstCast?.counts?.recasts?.length ?? 0);

  let timeline = [];
  let open = new Map();
  page.on('request', (request) => {
    open.set(request, {
      method: request.method(),
      url: request.url(),
      start: Date.now(),
      end: null,
      status: null,
    });
  });
  const close = (request) => {
    const entry = open.get(request);
    if (!entry) return;
    entry.end = Date.now();
    timeline.push(entry);
  };
  page.on('requestfinished', close);
  page.on('requestfailed', close);

  const abortedWrites = [];
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

  const run = { viewport: view.label, abortedWrites, timeline: [] };
  const start = Date.now();

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
    await signIn.click({ timeout: 60_000, force: true });
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
        { timeout: BOOT, polling: 100 },
      )
      .catch(() => {});
    const paintedAt = Date.now();
    const countsAtPaint = await page.evaluate(READ_COUNTS);

    // ── the watch: when do the first cast's deferred counts reach the screen?
    // Polled rather than waited on, so the answer carries a timestamp and the
    // shape of what was on screen before and after.
    const polls = [];
    let firstDeferredCountMs = null;
    let firstAnyCountMs = null;
    const deadline = Date.now() + COUNT_BUDGET;
    while (Date.now() < deadline) {
      const sample = await page.evaluate(READ_COUNTS);
      if (firstDeferredCountMs === null && deferredOnScreen(sample) > 0) {
        firstDeferredCountMs = sample.at - paintedAt;
      }
      if (
        firstAnyCountMs === null &&
        sample.marks.likes.length + sample.marks.recasts.length > 0
      ) {
        firstAnyCountMs = sample.at - paintedAt;
      }
      polls.push({
        fromPaintMs: sample.at - paintedAt,
        marksTotal: sample.marks.total,
        byKind: sample.marks.byKind,
        firstCastDeferred:
          (sample.firstCast.counts.likes?.length ?? 0) +
          (sample.firstCast.counts.recasts?.length ?? 0),
        pageNumbers: sample.pageNumbers,
      });
      if (firstDeferredCountMs !== null && sample.marks.likes.length > 2) break;
      await page.waitForTimeout(500);
    }
    const countsAfter = await page.evaluate(READ_COUNTS);
    // The sink's own view of the delivery (`window.__fiddyCountsBehind`, filled
    // only when the build sets `VITE_SNAPCHAIN_DEBUG=true`): what the count wave
    // was handed, what landed, and how many casts were cached when it ran. The
    // DOM cannot tell "the counts have not arrived yet" from "the counts were
    // delivered onto nothing", and this is the difference.
    const sink = await page.evaluate(
      () => globalThis.__fiddyCountsBehind ?? null,
    );

    run.cold = {
      paintedAtEpoch: paintedAt,
      sink,
      paintFromCaseStartMs: paintedAt - start,
      countsAtPaint,
      firstDeferredCountAfterPaintMs: firstDeferredCountMs,
      firstAnyCountAfterPaintMs: firstAnyCountMs,
      watchedForMs: Date.now() - paintedAt,
      polls: polls.length,
      firstPoll: polls[0] ?? null,
      lastPoll: polls[polls.length - 1] ?? null,
      countsAfter,
      url: page.url(),
    };
  } catch (error) {
    run.cold = { error: String(error).slice(0, 400), url: page.url() };
  }

  run.timeline = timeline.map((entry) => ({
    method: entry.method,
    url: entry.url,
    fromMs: entry.start - start,
    ms: entry.end === null ? null : entry.end - entry.start,
    status: entry.status,
  }));
  run.countReads = run.timeline.filter((entry) =>
    entry.url.includes('/v1/reactionsByCast'),
  );
  run.pageReads = run.timeline.filter((entry) =>
    entry.url.includes('/v1/castsByFid'),
  );

  // ── WARM: the same browser, re-opening the app on what the cold run left
  // behind — the HTTP cache and the app's own storage both warm.
  //
  // THIS is the case a KEPT feed page belongs to. `~/lib/feedCache` keeps one
  // page of `feedItems` per account and `~/contexts/FeedQueryCacheProvider`
  // restores it, so inside the three-minute staleness window a re-open paints
  // the stored page and reads nothing: no page read, no count wave, and — before
  // card t_43249104 — no engagement numbers on any cast, ever. The question this
  // case answers is the one the card turns on: does the restored page ask for its
  // counts, and do they reach the screen?
  //
  // Deliberately its own window: everything above is mapped before this runs, so
  // the cold numbers this probe has always reported are untouched by it, and the
  // warm reads are counted from `warmStart` in `warmTimeline` below.
  const warmStart = Date.now();
  const warmPolls = [];
  let warmDeferredMs = null;
  let warmAnyMs = null;
  try {
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 120_000 });
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
        { timeout: BOOT, polling: 100 },
      )
      .catch(() => {});
    const warmPaintedAt = Date.now();
    const warmCountsAtPaint = await page.evaluate(READ_COUNTS);

    const warmDeadline = Date.now() + COUNT_BUDGET;
    while (Date.now() < warmDeadline) {
      const sample = await page.evaluate(READ_COUNTS);
      if (warmDeferredMs === null && deferredOnScreen(sample) > 0) {
        warmDeferredMs = sample.at - warmPaintedAt;
      }
      if (
        warmAnyMs === null &&
        sample.marks.likes.length + sample.marks.recasts.length > 0
      ) {
        warmAnyMs = sample.at - warmPaintedAt;
      }
      warmPolls.push({
        fromPaintMs: sample.at - warmPaintedAt,
        marksTotal: sample.marks.total,
        byKind: sample.marks.byKind,
        firstCastDeferred:
          (sample.firstCast.counts.likes?.length ?? 0) +
          (sample.firstCast.counts.recasts?.length ?? 0),
        pageNumbers: sample.pageNumbers,
      });
      if (warmDeferredMs !== null && sample.marks.likes.length > 2) break;
      await page.waitForTimeout(500);
    }

    const warmCountsAfter = await page.evaluate(READ_COUNTS);
    // The sink's own view, for the warm case alone: this is a fresh document, so
    // the log holds what THIS re-open's counts did and nothing from the cold run.
    const warmSink = await page.evaluate(
      () => globalThis.__fiddyCountsBehind ?? null,
    );

    run.warm = {
      paintedAtEpoch: warmPaintedAt,
      sink: warmSink,
      paintFromCaseStartMs: warmPaintedAt - warmStart,
      countsAtPaint: warmCountsAtPaint,
      firstDeferredCountAfterPaintMs: warmDeferredMs,
      firstAnyCountAfterPaintMs: warmAnyMs,
      watchedForMs: Date.now() - warmPaintedAt,
      polls: warmPolls.length,
      firstPoll: warmPolls[0] ?? null,
      lastPoll: warmPolls[warmPolls.length - 1] ?? null,
      countsAfter: warmCountsAfter,
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
    run.warm = { error: String(error).slice(0, 400), url: page.url() };
  }
  run.warmTimeline = timeline
    .filter((entry) => entry.start >= warmStart)
    .map((entry) => ({
      method: entry.method,
      url: entry.url,
      fromMs: entry.start - warmStart,
      ms: entry.end === null ? null : entry.end - entry.start,
      status: entry.status,
    }));
  run.warmCountReads = run.warmTimeline.filter((entry) =>
    entry.url.includes('/v1/reactionsByCast'),
  );
  run.warmPageReads = run.warmTimeline.filter((entry) =>
    entry.url.includes('/v1/castsByFid'),
  );

  result.runs.push(run);
  await context.close();
}

await browser.close();
writeFileSync(OUT, JSON.stringify(result, null, 2));

const window_ = (reads) => ({
  count: reads.length,
  firstStartMs: reads.length ? Math.min(...reads.map((r) => r.fromMs)) : null,
  lastStartMs: reads.length ? Math.max(...reads.map((r) => r.fromMs)) : null,
  lastEndMs: reads.length
    ? Math.max(
        ...reads.map((r) => (r.ms === null ? r.fromMs : r.fromMs + r.ms)),
      )
    : null,
});

const summary = result.runs.map((run) => {
  const paint = run.cold?.paintFromCaseStartMs ?? null;
  const sinkCalls = run.cold?.sink;
  const paintedAt = run.cold?.paintedAtEpoch;
  /** One case's sink log, relative to that case's own paint. */
  const sinkWaves = (sink, at) =>
    Array.isArray(sink)
      ? sink.map((entry) => ({
          fromPaintMs: typeof at === 'number' ? entry.at - at : null,
          received: entry.received,
          updated: entry.updated,
          missed: entry.missed.length,
          retried: entry.retry === true,
          cachedCasts: entry.cachedCasts,
        }))
      : null;
  return {
    viewport: run.viewport,
    error: run.cold?.error ?? null,
    release: result.release?.revision ?? result.release?.note ?? null,
    hostLoad: result.host.load,
    paintFromCaseStartMs: paint,
    /** What the sink did, per count wave: handed / filled / missed, and how many
     * casts were in the cache at that moment. `null` when the build has no
     * `VITE_SNAPCHAIN_DEBUG=true` (a release), which is the one fact behind the
     * DOM this probe cannot read by itself. */
    sinkCalls: Array.isArray(sinkCalls) ? sinkWaves(sinkCalls, paintedAt) : null,
    // The page's own reads vs the count wave, against the paint they used to
    // hold up.
    pageReads: window_(run.pageReads ?? []),
    countReads: window_(run.countReads ?? []),
    countReadsStillRunningAtPaint:
      paint === null
        ? null
        : (run.countReads ?? []).filter(
            (r) =>
              r.fromMs <= paint && (r.ms === null || r.fromMs + r.ms >= paint),
          ).length,
    // What was drawn, when.
    marksAtPaint: run.cold?.countsAtPaint?.marks ?? null,
    firstCastAtPaint: run.cold?.countsAtPaint?.firstCast ?? null,
    firstDeferredCountAfterPaintMs:
      run.cold?.firstDeferredCountAfterPaintMs ?? null,
    firstAnyCountAfterPaintMs: run.cold?.firstAnyCountAfterPaintMs ?? null,
    marksAfter: run.cold?.countsAfter?.marks ?? null,
    firstCastAfter: run.cold?.countsAfter?.firstCast ?? null,
    pageNumbersAtPaint: run.cold?.countsAtPaint?.pageNumbers ?? null,
    pageNumbersAfter: run.cold?.countsAfter?.pageNumbers ?? null,
    watchedForMs: run.cold?.watchedForMs ?? null,
    // ── WARM: a re-open on the page this browser kept (card t_43249104). The
    // cold numbers above are unchanged by it; these are the warm case's own.
    warmError: run.warm?.error ?? null,
    warmPaintFromCaseStartMs: run.warm?.paintFromCaseStartMs ?? null,
    /** What the sink did on the re-open's own count wave. `null` on a build with
     * no `VITE_SNAPCHAIN_DEBUG=true` (a release), where the DOM reading below is
     * the whole evidence. */
    warmSinkCalls: sinkWaves(run.warm?.sink, run.warm?.paintedAtEpoch),
    /** A kept page is not re-read: `pageReads.count` 0 with the counts drawn is
     * the shape only the restored-page path produces. */
    warmPageReads: window_(run.warmPageReads ?? []),
    warmCountReads: window_(run.warmCountReads ?? []),
    warmMarksAtPaint: run.warm?.countsAtPaint?.marks ?? null,
    warmFirstCastAtPaint: run.warm?.countsAtPaint?.firstCast ?? null,
    warmFirstDeferredCountAfterPaintMs:
      run.warm?.firstDeferredCountAfterPaintMs ?? null,
    warmFirstAnyCountAfterPaintMs: run.warm?.firstAnyCountAfterPaintMs ?? null,
    warmMarksAfter: run.warm?.countsAfter?.marks ?? null,
    warmFirstCastAfter: run.warm?.countsAfter?.firstCast ?? null,
    warmPageNumbersAtPaint: run.warm?.countsAtPaint?.pageNumbers ?? null,
    warmPageNumbersAfter: run.warm?.countsAfter?.pageNumbers ?? null,
    warmWatchedForMs: run.warm?.watchedForMs ?? null,
    warmStorageKeys: run.warm?.storage?.keys ?? null,
    warmStorageBytes: run.warm?.storage?.bytes ?? null,
    out: OUT,
  };
});

console.log(JSON.stringify({ out: OUT, summary }, null, 2));
