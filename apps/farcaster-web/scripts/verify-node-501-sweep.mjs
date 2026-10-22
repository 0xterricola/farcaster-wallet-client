// Every signed-in surface, visited, with every honest-501 it hits recorded.
//
//   SWEEP_SERVER=https://localhost:5199 node scripts/verify-node-501-sweep.mjs
//   ... --record          write scripts/node-501-sweep.expectations.json
//
// WHY THIS PROBE EXISTS
//
// The node adapter refuses any hosted-API read it has no real source for, in
// place, with a sentence saying whose job that read is (`hostedRoutes.ts`). That
// is the honest fallback — but it has two very different flavours, and they look
// identical to a reader:
//
//   - a DELIBERATE refusal: the endpoint is in the routing table and the
//     sentence names the real reason ("a read node keeps no search index");
//   - an UNCLASSIFIED endpoint: the sentence is the adapter's own shrug —
//     "no node-backed reader has been written for this endpoint yet" — which is
//     a note to a programmer, shown to a user, on a page that should work. That
//     is the bug this probe exists to find (user-reported 2026-10-22: it was on
//     settings surfaces and all over the app).
//
// So the probe walks the app's own route table (`src/constants/routes.ts`), opens
// every route at both widths with a real seeded session, and records — per
// surface — every request the adapter actually classified
// (`window.__nodeBackedRequests`, on with VITE_SNAPCHAIN_DEBUG=true), every
// refusal sentence the surface was shown, and whether the shell degraded. The
// verdict per surface is read from `scripts/node-501-sweep.expectations.json`,
// which is checked in and reviewable: `works` means the surface must render its
// content with no refusal; `refused` means it must say why, in place, and must
// never show the shrug.
//
// Nothing here is a mock: the session is a real SIWF message, the relay is the
// dev server's own `/snapchain-api` proxy to a live read node, and the adapter
// runs its real provider chain.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(HERE, '..');

const SERVER = process.env.SWEEP_SERVER ?? 'https://localhost:5199';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.SWEEP_OUT ?? os.tmpdir();
const WIDTHS = (process.env.SWEEP_WIDTHS ?? '390,1440')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));
const SETTLE_MS = Number(process.env.SWEEP_SETTLE_MS ?? 12000);
const QUIET_MS = Number(process.env.SWEEP_QUIET_MS ?? 1500);
const ONLY = process.env.SWEEP_ONLY ?? '';
const RECORD = process.argv.includes('--record');

const EXPECTATIONS_FILE = path.join(HERE, 'node-501-sweep.expectations.json');

const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'SWEEPTOK1';
const SIGNED_IN_FID = 3;

/**
 * The sentences that mean "nobody classified this endpoint" — the adapter's own
 * fallback, in both of the flavours it has ever had. The old wording is kept in
 * the pattern on purpose: the string this sweep is famous for (2026-10-22) is
 * the one it was reported with, and a surface that still says it is a miss.
 *
 * The two extra rows are what the fallback says AFTER the first pass of this
 * fix: `hostedRoutes.ts`'s last resort for an endpoint no table names, and
 * `nodeBackedFetch.ts`'s sentence for a route a node carries but this build has
 * no reader for. Both of those are the same bug to a reader — a page that says
 * "this isn't on your node" because a programmer has not been here yet — so
 * they are asserted here, not reasoned away. A DELIBERATE refusal names a real
 * reason (the routing table's own sentence: whose job the read is), and is not
 * matched by any of these.
 */
const SHRUG =
  /no node-backed reader has been written|isn’t something your node keeps, and no reader here answers it|this read has no reader wired up in this app/i;

/**
 * Concrete values for the route table's parameters, so a route like
 * `/~/profiles/:fid` can be opened at all. The session is fid 3 (`dwr`).
 */
const PARAMS = [
  [/:channelKey/g, 'ai'],
  [/:castHash/g, '0x50184b62b4c52fd76628713562e1eda3dccaf63d'],
  [/:fid/g, String(SIGNED_IN_FID)],
  [/:username/g, 'dwr'],
  [/:roomId/g, '1'],
  [/:section/g, 'general'],
  [/:tab/g, 'casts'],
  [/:id/g, '1'],
  [/:slug?/g, ''],
  [/:code/g, 'SWEEPCODE1'],
];

/** Routes that are not a surface a person opens (redirect-only, or a debug toy). */
const SKIP = [
  /^\/$/, // the home column is covered by the shell's own landing
  /:param/,
  /^\*$/,
  /\/developers\/.*(manifest|embed|preview)/, // developer tools that need an app id
];

/**
 * The app's own route table, as surfaces.
 *
 * Read out of `src/constants/routes.ts` rather than typed here on purpose: a
 * route added to the app is a route this probe visits, so "every user-reachable
 * surface" cannot drift away from the code the way a hand-kept list does.
 */
const surfacesFromRouteTable = () => {
  const source = fs.readFileSync(
    path.join(WEB_ROOT, 'src/constants/routes.ts'),
    'utf8',
  );
  // The prefix constants the table interpolates (`routePrefixes.ts`), so
  // `${appPathPrefix}/settings` becomes a path this page can be opened at.
  const PREFIXES = {
    appPathPrefix: '/~',
    appSettingsPathPrefix: '/~/settings',
    appExplorePathPrefix: '/~/explore',
    appInboxPathPrefix: '/~/inbox',
    appDevelopersPathPrefix: '/~/developers',
    appSearchPathPrefix: '/~/search',
    appSupportPathPrefix: '/~/support',
    appTermsOfUsePathPrefix: '/~/terms-of-use',
    appPrivayPolicyPathPrefix: '/~/privacy-policy',
  };
  const paths = new Set();
  for (const match of source.matchAll(/path:\s*(?:`([^`]+)`|'([^']+)')/g)) {
    let route = match[1] ?? match[2];
    let known = true;
    route = route.replace(/\$\{(\w+)\}/g, (_whole, name) => {
      if (PREFIXES[name] === undefined) known = false;
      return PREFIXES[name] ?? '';
    });
    if (!known || !route.startsWith('/')) continue;
    for (const [pattern, value] of PARAMS)
      route = route.replace(pattern, value);
    route = route.replace(/\/+$/, '') || '/';
    if (route.includes(':')) continue;
    if (SKIP.some((pattern) => pattern.test(route))) continue;
    paths.add(route);
  }
  return [...paths].sort();
};

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SERVER}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const flatten = (value) => value.replace(/[ \t\r\n]+/g, ' ').trim();

/**
 * `page.evaluate`, with a page that navigates itself tolerated.
 *
 * MEASURED (2026-10-22, the first full sweep): the run died with "Execution
 * context was destroyed, most likely because of a navigation" inside `settle` —
 * a surface that redirects itself (the search tabs land on an explore column,
 * and a session hand-off can replace the document) destroys its own JS context
 * mid-read. That is the app's business and not a crash, so every read of a page
 * after a navigation goes through here: the fallback is used, and the surface is
 * recorded with what could be read rather than killing the sweep.
 */
const safeEvaluate = async (page, fn, arg, fallback) => {
  try {
    return await page.evaluate(fn, arg);
  } catch {
    return fallback;
  }
};

/** What the page says about itself: the refusal panels, the copy, the errors. */
const readSurface = (page) =>
  safeEvaluate(
    page,
    () => {
      const flatInPage = (value) => value.replace(/[ \t\r\n]+/g, ' ').trim();
      const panels = [
        ...document.querySelectorAll(
          '[data-fiddy="node-cannot-answer"], [data-fiddy="shell-section-degraded"]',
        ),
      ].map((panel) => ({
        kind: panel.getAttribute('data-fiddy'),
        title: flatInPage(
          panel.querySelector('.fiddy-degrade-title')?.textContent ?? '',
        ),
        body: flatInPage(
          panel.querySelector('.fiddy-degrade-body')?.textContent ?? '',
        ),
      }));
      const column = document.querySelector('main');
      return {
        path: window.location.pathname,
        text: flatInPage(document.body.innerText),
        column: flatInPage(column ? column.innerText : ''),
        panels,
        deviceOnly: Boolean(
          document.querySelector('[data-fiddy="device-only-session"]'),
        ),
        onboarding: Boolean(
          document.querySelector('[data-fiddy="onboarding"]'),
        ),
        genericErrorCopy:
          /Could not reach Farcaster|Error retrieving data|Something went wrong|unexpected error/i.test(
            flatInPage(document.body.innerText),
          ),
      };
    },
    undefined,
    {
      path: '',
      text: '',
      column: '',
      panels: [],
      deviceOnly: false,
      onboarding: false,
      genericErrorCopy: false,
    },
  );

/** Every request the adapter classified since a marker: the sweep's raw data. */
const readLog = (page, marker) =>
  safeEvaluate(
    page,
    (from) => {
      const log = Array.isArray(window.__nodeBackedRequests)
        ? window.__nodeBackedRequests
        : [];
      return { length: log.length, entries: log.slice(from) };
    },
    marker,
    { length: 0, entries: [] },
  );

/** Wait until the adapter has been quiet, so a surface's reads are all in. */
const settle = async (page, marker) => {
  const started = Date.now();
  let last = marker;
  let quietSince = Date.now();
  while (Date.now() - started < SETTLE_MS) {
    await page.waitForTimeout(400);
    const now = await safeEvaluate(
      page,
      () => {
        const log = Array.isArray(window.__nodeBackedRequests)
          ? window.__nodeBackedRequests
          : [];
        return log.length;
      },
      undefined,
      null,
    );
    // A null means the document was replaced mid-read: this surface has
    // navigated itself, and what it says now is what it says.
    if (now === null) return;
    if (now !== last) {
      last = now;
      quietSince = Date.now();
      continue;
    }
    if (Date.now() - quietSince >= QUIET_MS) return;
  }
};

const loadExpectations = () => {
  try {
    return JSON.parse(fs.readFileSync(EXPECTATIONS_FILE, 'utf8'));
  } catch {
    return { surfaces: {} };
  }
};

const run = async () => {
  const surfaces = surfacesFromRouteTable().filter((route) =>
    ONLY ? route.includes(ONLY) : true,
  );
  const consoleErrors = [];
  const pageErrors = [];
  const report = [];

  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error')
      consoleErrors.push(flatten(m.text()).slice(0, 400));
  });
  page.on('pageerror', (e) =>
    pageErrors.push(flatten(String(e)).slice(0, 300)),
  );

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
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
        fid: SIGNED_IN_FID,
        username: 'dwr',
        displayName: 'dwr',
      }),
    });
  });

  // ── sign in, once ─────────────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  // NOTE: `page.waitForFunction(fn, arg, options)` — the second parameter is the
  // function's ARGUMENT, not its options. Passing `{ timeout }` there silently
  // uses Playwright's 30 s default, which is not enough for a cold vite build.
  await page.waitForFunction(
    () => document.body.innerText.trim().length > 40,
    null,
    { timeout: 90000 },
  );
  /** The one button that starts the SIWF hand-off. */
  const clickGoSocial = async () => {
    for (const el of await page.$$('button, a, [role=button]')) {
      const text = flatten((await el.innerText()) || '');
      if (/go social/i.test(text)) {
        await el.click();
        return true;
      }
    }
    return false;
  };
  const signedIn = () =>
    page.evaluate(
      () =>
        window.location.pathname === '/' &&
        !document.querySelector('[data-fiddy="device-only-session"]') &&
        !document.querySelector('[data-fiddy="onboarding"]'),
    );

  // The setup screen's own animation has to have settled before the button is
  // the real one (`verify-node-unanswered-surfaces.mjs` waits the same way).
  await page.waitForTimeout(6000);
  let clicked = await clickGoSocial();
  for (let attempt = 0; attempt < 6 && !(await signedIn()); attempt += 1) {
    await page.waitForTimeout(6000);
    if (!clicked) clicked = await clickGoSocial();
  }
  if (!(await signedIn())) {
    const state = await page.evaluate(() => ({
      url: window.location.pathname,
      text: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400),
      controls: [...document.querySelectorAll('button, a, [role=button]')]
        .map((el) =>
          (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        )
        .slice(0, 20),
    }));
    console.log('SIGN-IN FAILED', JSON.stringify(state, null, 1));
    console.log('console:', consoleErrors.slice(-8));
    throw new Error('the seeded session never reached the signed-in shell');
  }

  const expectations = loadExpectations();
  const proposed = {};
  const endpoints = new Map();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });

    for (const route of surfaces) {
      const errorsMark = consoleErrors.length;
      const pageErrorsMark = pageErrors.length;
      // The marker is taken INSIDE the page being measured, and the log is
      // emptied before leaving the previous one.
      //
      // MEASURED (2026-10-22, the first full sweep): taking the mark off the
      // page we are about to leave — `window.__nodeBackedRequests.length` — and
      // slicing the next page's log from it returned `[]` for every surface
      // whose predecessor had logged more requests. A page reload builds a new
      // array, so a surface's own refusals begin at 0; the stale mark hid the
      // very 501s this probe exists to find (the shrug panels were still read
      // correctly off the DOM, which is why the sweep's verdicts held while its
      // per-surface refusal list did not).
      await safeEvaluate(
        page,
        () => {
          if (Array.isArray(window.__nodeBackedRequests)) {
            window.__nodeBackedRequests.length = 0;
          }
        },
        undefined,
        undefined,
      );
      const logMark = 0;

      // A navigation that the page itself supersedes (its own redirect) makes
      // Playwright throw `ERR_ABORTED`. That is the app moving the reader to the
      // surface it really serves, so it is recorded as a note and not as a
      // crash — the shares of this that are real are the panel and the errors.
      let navigationNote;
      await page
        .goto(`${SERVER}${route}`, {
          waitUntil: 'domcontentloaded',
          timeout: 90000,
        })
        .catch((error) => {
          navigationNote = flatten(String(error)).slice(0, 200);
        });
      await page
        .waitForFunction(
          () => document.body.innerText.trim().length > 40,
          null,
          {
            timeout: 45000,
          },
        )
        .catch(() => {});
      await settle(page, logMark);

      const now = await readSurface(page);
      const { entries } = await readLog(page, logMark);
      const newErrors = consoleErrors.slice(errorsMark);
      const newPageErrors = pageErrors.slice(pageErrorsMark);

      const refusals = entries
        .filter((entry) => entry.status === 501)
        .map((entry) => ({
          method: entry.method,
          path: entry.path,
          kind: entry.kind,
        }));
      for (const refusal of refusals) {
        const key = `${refusal.method} ${refusal.path}`;
        if (!endpoints.has(key)) endpoints.set(key, refusal);
      }

      const shrugOnScreen = now.panels.some((panel) => SHRUG.test(panel.body));
      // What this run SAW is what gets recorded — `--record` re-baselines the
      // gate, it does not merely fill in the surfaces nobody wrote a verdict
      // for. (Until 2026-10-22 it kept an existing verdict and only filled the
      // gaps, so a surface recorded as `refused-shrug` during the broken build
      // could never be tightened by a run that proved it fixed: the file the
      // probe compares against would have been write-only in the same
      // direction as the bug. Review the diff before checking it in.)
      proposed[route] = {
        verdict: shrugOnScreen
          ? 'refused-shrug'
          : refusals.length > 0
            ? 'refused'
            : now.panels.length > 0
              ? 'degraded'
              : 'works',
        refusals: refusals.map(
          (refusal) => `${refusal.method} ${refusal.path}`,
        ),
        panels: now.panels.map((panel) => panel.title),
      };

      // A line per visit: a full sweep is 312 navigations and takes tens of
      // minutes on a loaded machine, and a run that prints nothing until the end
      // cannot be told from one that has hung.
      console.log(
        `  ${width}px ${route} → ${now.path}  ${now.panels.length > 0 ? `[${now.panels.map((panel) => panel.title).join(' | ')}]` : ''}${shrugOnScreen ? '  ← FALLBACK' : ''}`,
      );

      report.push({
        width,
        route,
        landed: now.path,
        deviceOnly: now.deviceOnly,
        onboarding: now.onboarding,
        panels: now.panels,
        shrugOnScreen,
        genericErrorCopy: now.genericErrorCopy,
        refusals,
        requests: entries.map(
          (entry) =>
            `${entry.method} ${entry.path} → ${entry.kind}/${entry.status ?? 200}`,
        ),
        ...(navigationNote === undefined ? {} : { navigationNote }),
        pageErrors: newPageErrors,
        // EVERY console error this surface raised, not only the 501s: a surface
        // that breaks in another way (an error boundary, a thrown component)
        // says so here, and the first pass's filter hid exactly that.
        consoleErrors: newErrors.slice(0, 6),
        column: now.column.slice(0, 240),
      });
    }
  }

  await browser.close();

  const reportFile = path.join(OUT, 'node-501-sweep-report.json');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));

  const shrugs = report.filter((entry) => entry.shrugOnScreen);
  const crashes = report.filter((entry) => entry.pageErrors.length > 0);
  const wrong = [];
  for (const entry of report) {
    // The shrug is never an acceptable answer on a surface a person can reach:
    // it is the adapter telling the reader that a programmer has not got to this
    // endpoint yet. It is asserted for EVERY surface, whatever that surface's
    // expectation says — the fix this probe measures (2026-10-22) is that the
    // sentence appears nowhere, and a surface that shows it is a miss even if
    // its recorded verdict would have tolerated it.
    if (entry.shrugOnScreen) {
      wrong.push({
        route: entry.route,
        width: entry.width,
        why: 'the shrug sentence is on screen',
      });
      continue;
    }
    const expectation = expectations.surfaces?.[entry.route];
    if (!expectation) continue;
    if (expectation.verdict === 'works' && entry.panels.length > 0) {
      wrong.push({
        route: entry.route,
        width: entry.width,
        why: `expected content, saw "${entry.panels[0].title}"`,
      });
    }
  }

  console.log('── the sweep ──');
  console.log(`surfaces: ${surfaces.length} × widths ${WIDTHS.join('/')}`);
  console.log(`shrug sentences on screen: ${shrugs.length}`);
  for (const entry of shrugs) {
    console.log(
      `  ${entry.width}px ${entry.route} → ${entry.panels[0]?.title ?? ''} :: ${entry.panels[0]?.body ?? ''}`,
    );
  }
  console.log(`page crashes: ${crashes.length}`);
  for (const entry of crashes) {
    console.log(`  ${entry.width}px ${entry.route} → ${entry.pageErrors[0]}`);
  }
  console.log(`expectation misses: ${wrong.length}`);
  for (const miss of wrong) {
    console.log(`  ${miss.width}px ${miss.route} → ${miss.why}`);
  }

  console.log(`\n── refusals the app really makes (${endpoints.size}) ──`);
  for (const key of [...endpoints.keys()].sort()) console.log(`  ${key}`);

  console.log(`\n── surfaces that degrade, and how ──`);
  for (const entry of report.filter((item) => item.panels.length > 0)) {
    console.log(
      `  ${entry.width}px ${entry.route} → ${entry.panels
        .map((panel) => `${panel.title} :: ${panel.body.slice(0, 90)}`)
        .join(' | ')}`,
    );
  }

  console.log(`\nreport: ${reportFile}`);
  if (RECORD) {
    const proposedFile = path.join(OUT, 'node-501-sweep.expectations.json');
    fs.writeFileSync(
      proposedFile,
      `${JSON.stringify({ surfaces: proposed }, null, 1)}\n`,
    );
    console.log(`proposed expectations: ${proposedFile}`);
  }

  if (shrugs.length > 0 || crashes.length > 0 || wrong.length > 0) {
    process.exitCode = 1;
  }
};

await run();
