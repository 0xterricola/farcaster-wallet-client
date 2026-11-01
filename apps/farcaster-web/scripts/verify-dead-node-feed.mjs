// Does a signed-in client SAY ANYTHING when the node it reads from never answers?
//
//   DEAD_NODE_SERVER=https://localhost:5176 DEAD_NODE_ISOLATE=1 \
//     node scripts/verify-dead-node-feed.mjs
//
// Requires a dev server whose /snapchain-api relay points at a node that does
// not answer — a black-holed address (TCP connect never completes) is the case
// this probe exists for:
//
//   SNAPCHAIN_HTTP_URL=http://34.101.47.167:3381 npx vite --port 5176
//
// DEAD_NODE_ISOLATE=1 also aborts every *other* place the client could read
// from (Farcaster's own public server, Neynar, the public read node), so the
// dead node is the only source left. MEASURED (2026-10-21): without isolation
// this card's setup no longer reproduces a blank feed at all — the provider
// chain (`~/snapchain/providers`) moves to a server that answers and the column
// fills with real casts. That is the honest behaviour of the chain, not of a
// read that was never timed out, so the dead-node case is measured with every
// other server out of reach.
//
// The sign-in is the same real-SIWE stub the sibling probes use (only the SIWF
// relay is stubbed), so the client reaches its signed-in shell for real. Nothing
// here writes.
//
// WHAT IT ASSERTS
//   1. the sign-in lands in the client (so the blank surface below is the
//      feed's, not the setup flow's)
//   2. within DEAD_NODE_BUDGET_S seconds the FEED COLUMN carries an ANSWER: the
//      adapter's own sentence about the node not answering, with a retry — the
//      column, not the document: the rail has its own 501 panels, and a check
//      that accepts any panel on the page passes on the wrong surface
//      (MEASURED: it did, at the first version of this probe)
//   3. that answer is not an empty list and not a bare spinner: the column's own
//      words are checked, not just "something rendered"
//   4. the wall clock from landing in the client to that answer is reported, so
//      a timeout that is too tight or too loose is visible
//
// FAIL-CAPABLE: at the pre-fix state the feed column stays empty for the whole
// budget — measured at 75s+ on `d0eede6` (docs/CLIENT-PARITY.md), and re-measured
// at 30s here with the fix reverted.

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.DEAD_NODE_SERVER ?? 'https://localhost:5176';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.DEAD_NODE_SHOT_DIR ?? os.tmpdir();
const BUDGET_S = Number(process.env.DEAD_NODE_BUDGET_S ?? 90);
const ISOLATE = process.env.DEAD_NODE_ISOLATE === '1';
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'DEADNODE1';
const SIGNED_IN_FID = 3;

/** Every other server the provider chain could fall back to. */
const OTHER_SERVERS = [
  'https://api.farcaster.xyz/**',
  'https://api.neynar.com/**',
  'https://haatz.quilibrium.com/**',
  'http://34.101.47.167:**',
  'https://snapchain-api.neynar.com/**',
];

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

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

const EMPTY_SURFACE = {
  path: '',
  text: '',
  onboardingSheet: false,
  deviceOnlyLanding: false,
  answer: undefined,
  feedAnswer: undefined,
  feedColumn: '',
  spinner: false,
  feedSpinner: false,
  retryOffered: false,
  genericError: false,
  fullScreenError: false,
};

/**
 * Read the surface, tolerating a page that is mid-navigation.
 *
 * MEASURED: the first version of this probe read the page immediately after
 * clicking "Go social" and crashed the whole run with `Execution context was
 * destroyed, most likely because of a navigation` — a probe defect, not a client
 * one, and one that hides the checks it was about to make. A destroyed
 * execution context is retried (the loop below tolerates it: a surface it cannot
 * read yet is simply not "in the client" yet); anything else still throws.
 */
const readSurface = async (page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await page.evaluate(surfaceProbe);
    } catch (error) {
      if (!/Execution context was destroyed|Target closed|navigat/i.test(String(error))) {
        throw error;
      }
      await page.waitForTimeout(250);
    }
  }
  return { ...EMPTY_SURFACE };
};

const surfaceProbe = () => {
  const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
  // MEASURED 2026-10-21: a document the sign-in's own navigation is replacing
  // has no body for an instant, and a bare read there is `Cannot read properties
  // of null` — a different error from the destroyed execution context the retry
  // below tolerates, so it used to escape and kill the run. An empty string is
  // an empty surface, which the polls already handle.
  const text = norm(document.body?.innerText ?? '');
  const main = document.querySelector('main');
  const inMain = (selector) => {
    const el = main?.querySelector(selector);
    return el ? norm(el.innerText) : undefined;
  };
  const anyAnswer = document.querySelector('[data-fiddy="node-cannot-answer"]');
  return {
    path: window.location.pathname,
    text,
    onboardingSheet: Boolean(document.querySelector('[data-fiddy="onboarding"]')),
    deviceOnlyLanding: Boolean(document.querySelector('[data-fiddy="device-only-session"]')),
    // Anywhere on the page (the rail has these too — informational only).
    answer: anyAnswer ? norm(anyAnswer.innerText) : undefined,
    // The feed column's own answer: what this card is about.
    feedAnswer: inMain('[data-fiddy="node-cannot-answer"]'),
    feedDegraded: inMain('[data-fiddy="shell-section-degraded"]'),
    feedColumn: norm(main?.innerText),
    spinner: Boolean(document.querySelector('[role="progressbar"], .animate-spin')),
    feedSpinner: Boolean(main?.querySelector('[role="progressbar"], .animate-spin')),
    retryOffered: Boolean(
      inMain('[data-fiddy="node-cannot-answer"]') &&
        /\bTry again\b/i.test(inMain('[data-fiddy="node-cannot-answer"]') ?? ''),
    ),
    genericError: /Error retrieving data|Something went wrong/i.test(text),
    fullScreenError: /Could not reach Farcaster/i.test(text),
  };
};

const run = async () => {
  const relayStatuses = [];
  const consoleErrors = [];
  const blocked = [];

  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  if (ISOLATE) {
    // Out of reach, so the dead node is the only server left to read from.
    for (const pattern of OTHER_SERVERS) {
      await ctx.route(pattern, (route) => {
        blocked.push(route.request().url());
        return route.abort();
      });
    }
  }

  // Every /snapchain-api request the page made, and how it ended: this is the
  // evidence for "the read never resolved" versus "the read was answered".
  await ctx.addInitScript(() => {
    const orig = window.fetch;
    window.__nodeBackedFetchLog = [];
    window.fetch = async (...args) => {
      const url =
        typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || String(args[0]);
      const method = (args[1] && args[1].method) || 'GET';
      const startedAt = Date.now();
      try {
        const response = await orig(...args);
        window.__nodeBackedFetchLog.push(
          `${method} ${response.status} +${Date.now() - startedAt}ms ${String(url).slice(0, 140)}`,
        );
        return response;
      } catch (error) {
        window.__nodeBackedFetchLog.push(
          `${method} THREW +${Date.now() - startedAt}ms ${String(url).slice(0, 140)} :: ${String(
            error,
          ).slice(0, 120)}`,
        );
        throw error;
      }
    };
  });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 200));
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('response', (response) => {
    const url = response.url();
    if (!url.includes('/snapchain-api/')) return;
    relayStatuses.push(`${response.status()} ${new URL(url).pathname.replace('/snapchain-api', '')}`);
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (!url.includes('/snapchain-api/')) return;
    relayStatuses.push(
      `FAILED ${new URL(url).pathname.replace('/snapchain-api', '')} :: ${
        request.failure()?.errorText ?? 'no reason'
      }`,
    );
  });

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
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

  const inClient = (surface) =>
    !surface.onboardingSheet && !surface.deviceOnlyLanding && surface.path === '/';

  // ── 1. sign in ────────────────────────────────────────────────────────────
  // The dev server compiles routes on demand, so the first visit to a route on
  // a cold server is slow for reasons that have nothing to do with the node.
  // Warm the onboarding route first, then drive it.
  page.setDefaultTimeout(180000);
  await page.goto(`${SERVER}/welcome`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 40, { timeout: 180000 });
  await page.goto(`${SERVER}/welcome/ready`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 40, { timeout: 180000 });

  let clicked = null;
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      clicked = text;
      break;
    }
  }

  const startedAt = Date.now();
  let surface = await readSurface(page);
  for (let i = 0; i < 60 && !inClient(surface); i += 1) {
    await page.waitForTimeout(1000);
    surface = await readSurface(page);
  }
  check(
    'a completed sign-in lands in the client',
    inClient(surface) && clicked !== null,
    `clicked="${clicked}" path=${surface.path} onboarding=${surface.onboardingSheet} deviceOnly=${surface.deviceOnlyLanding}`,
  );

  // ── 2. how long until the FEED COLUMN answers ─────────────────────────────
  let answeredAfterMs;
  const tries = Math.max(1, Math.round((BUDGET_S * 1000) / 500));
  for (let i = 0; i < tries; i += 1) {
    surface = await readSurface(page);
    // With every other server blocked the sentence is the only honest answer;
    // without isolation a backup server answering is an answer too (measured).
    if (surface.feedAnswer || (!ISOLATE && surface.feedColumn.length > 200)) {
      answeredAfterMs = Date.now() - startedAt;
      break;
    }
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: `${OUT}/dead-node-feed.png` });

  const feedCasts = surface.feedColumn.length > 200;
  const sentenceNamesTheDeadNode = /did not answer this read/i.test(surface.feedAnswer ?? '');
  check(
    `the feed column is not blank within ${BUDGET_S}s`,
    Boolean(surface.feedAnswer) || (!ISOLATE && feedCasts),
    surface.feedAnswer
      ? `the adapter's sentence at +${Math.round(answeredAfterMs / 1000)}s: ${surface.feedAnswer.slice(0, 160)}`
      : feedCasts
        ? `casts rendered instead (a server that answers took over): ${JSON.stringify(
            surface.feedColumn.slice(0, 160),
          )}`
        : `${JSON.stringify(surface.feedColumn.slice(0, 200))} spinner=${surface.feedSpinner}`,
  );
  check(
    ISOLATE
      ? 'the column names the node not answering (not an empty list, not a bare spinner)'
      : 'the column says why, or casts render (a dead node with a live backup is not a blank feed)',
    ISOLATE ? sentenceNamesTheDeadNode : sentenceNamesTheDeadNode || feedCasts,
    surface.feedAnswer
      ? surface.feedAnswer.slice(0, 200)
      : `answer="${surface.answer ?? 'none'}" casts=${feedCasts} spinner=${surface.spinner} generic=${surface.genericError}`,
  );
  check(
    'the answer offers the retry a down node deserves',
    surface.retryOffered || (!ISOLATE && feedCasts && !surface.feedAnswer),
    `retryOffered=${surface.retryOffered} generic=${surface.genericError} fullScreen=${surface.fullScreenError}`,
  );

  const fetchLog = await page.evaluate(() => window.__nodeBackedFetchLog ?? []);
  const nodeLines = fetchLog.filter((line) => line.includes('/snapchain-api'));
  await browser.close();

  console.log(
    `── a signed-in client pointed at a node that never answers (${SERVER}${
      ISOLATE ? ', every other server blocked' : ''
    }) ──`,
  );
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(`\n── reads that left the page (${nodeLines.length} of ${fetchLog.length}) ──`);
  for (const line of nodeLines.slice(0, 8)) console.log(`  ${line}`);
  console.log(`\n── every fetch the page made (last 12) ──`);
  for (const line of fetchLog.slice(-12)) console.log(`  ${line}`);
  console.log(`\n── relay outcomes (${relayStatuses.length}) ──`);
  for (const line of [...new Set(relayStatuses)].slice(0, 8)) console.log(`  ${line}`);
  if (ISOLATE) {
    console.log(`\n── other servers blocked (${blocked.length}) ──`);
    for (const line of [...new Set(blocked)].slice(0, 8)) console.log(`  ${line}`);
  }
  console.log(`\nconsole errors: ${consoleErrors.length}`);
  for (const line of consoleErrors.slice(0, 5)) console.log(`  ${line}`);
  console.log(`\nscreenshot: ${OUT}/dead-node-feed.png`);

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
};

await run();