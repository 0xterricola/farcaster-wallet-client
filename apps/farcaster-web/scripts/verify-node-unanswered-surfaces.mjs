// What the surfaces the NODE CANNOT ANSWER actually do in the client.
//
//   NODE_BACKED_SERVER=https://localhost:5174 \
//     node scripts/verify-node-unanswered-surfaces.mjs
//
// Requires a dev server whose /snapchain-api relay points at a live read node
// (the setup scripts/verify-node-backed-client.mjs documents). The sign-in is
// the same seeded SIWF session: only the relay is stubbed, and it names a real
// active account (fid 3, `dwr`).
//
// WHY THIS PROBE EXISTS
// verify-node-backed-client.mjs proves the surfaces the node CAN answer. This
// one drives the surfaces it CANNOT answer — search, the channel directory,
// direct messages, explore/trending — and holds each one to three rules:
//
//   1. never a crash      — no full-screen error page, no uncaught page error
//   2. never a fake       — the surface must not read as "there is nothing
//                           here" when the truth is "your node cannot answer
//                           this". An empty list, or a "try again" that can
//                           never work, is a fake.
//   3. say why, in place  — the adapter's own sentence ("a read node keeps no
//                           search index") has to reach the user inside the
//                           page column, with the shell still standing.
//
// Each surface's landing path, the page column's own copy, the 501 sentence the
// adapter wrote for it and any uncaught error are printed, so the run is the
// evidence. Screenshots land in $NODE_UNANSWERED_SHOT_DIR (default: temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5174';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.NODE_UNANSWERED_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'UNANSWERED1';
const SIGNED_IN_FID = 3;

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

/**
 * The surfaces the node cannot answer, and the honest thing each one owes the
 * user.
 *
 *   honestFromRefusal — the page column has to carry the adapter's own 501
 *                       sentence, matched against the refusals this very visit
 *                       produced (so the check cannot pass on copy that came
 *                       from somewhere else). Used by the surfaces whose reads
 *                       are classified `hosted` and refused.
 *   honest            — for a surface that is not refused at all: the copy the
 *                       column has to carry in place of a fake empty state.
 *   fake              — copy that reads as "there is nothing here". Absent when
 *                       the surface has no such empty state.
 */
const SURFACES = [
  {
    name: 'search',
    path: '/~/search?q=farcaster',
    shot: 'unanswered-search.png',
    honestFromRefusal: true,
    fake: /couldn't find any matches|no results/i,
  },
  {
    name: 'channel directory',
    path: '/~/channels',
    shot: 'unanswered-channels-browse.png',
    honestFromRefusal: true,
    fake: /no channels|no channel found/i,
  },
  {
    // Direct messages are not refused per-read: the route has no inbox to read
    // at all, so the honest thing is the note, not a 501.
    name: 'direct messages',
    path: '/~/inbox',
    shot: 'unanswered-inbox.png',
    honestFromRefusal: false,
    honest: /direct messages are not on a read node/i,
    fake: /no direct casts|no requests/i,
  },
  {
    name: 'explore / trending',
    path: '/~/apps/trending',
    shot: 'unanswered-trending.png',
    honestFromRefusal: true,
    fake: undefined,
  },
];

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

/** Collapse runs of whitespace without a backslash escape in the pattern. */
const flatten = (value) => value.replace(/[ \t\r\n]+/g, ' ').trim();

const readSurface = (page) =>
  page.evaluate(() => {
    const flattenInPage = (value) => value.replace(/[ \t\r\n]+/g, ' ').trim();
    const column = document.querySelector('main');
    const degraded = document.querySelector(
      '[data-fiddy="shell-section-degraded"], [data-fiddy="node-cannot-answer"]',
    );
    return {
      path: window.location.pathname,
      text: flattenInPage(document.body.innerText),
      column: flattenInPage(column ? column.innerText : ''),
      deviceOnlyLanding: Boolean(document.querySelector('[data-fiddy="device-only-session"]')),
      onboardingSheet: Boolean(document.querySelector('[data-fiddy="onboarding"]')),
      degraded: Boolean(degraded),
      degradedKind: degraded ? degraded.getAttribute('data-fiddy') : '',
      degradedText: degraded ? flattenInPage(degraded.innerText) : '',
      genericErrorCopy:
        /Could not reach Farcaster|Error retrieving data|Something went wrong|unexpected error/i.test(
          flattenInPage(document.body.innerText),
        ),
    };
  });

const run = async () => {
  const consoleErrors = [];
  const pageErrors = [];

  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(flatten(m.text()).slice(0, 300));
  });
  page.on('pageerror', (e) => pageErrors.push(flatten(String(e)).slice(0, 300)));

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

  // ── sign in ───────────────────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.trim().length > 40, { timeout: 60000 });
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = flatten((await el.innerText()) || '');
    if (/go social/i.test(text)) {
      await el.click();
      break;
    }
  }
  // The session has to be a real signed-in client before any of this is about
  // the surfaces rather than about the landing.
  await page.waitForFunction(
    () =>
      window.location.pathname === '/' &&
      !document.querySelector('[data-fiddy="device-only-session"]') &&
      !document.querySelector('[data-fiddy="onboarding"]'),
    { timeout: 60000 },
  );

  const seen = [];
  const inClient = (surface) =>
    surface.path !== '/welcome/ready' && !surface.deviceOnlyLanding && !surface.onboardingSheet;

  for (const surface of SURFACES) {
    const errorsMark = consoleErrors.length;
    const pageErrorsMark = pageErrors.length;

    await page.goto(`${SERVER}${surface.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Give the surface's reads time to be refused and the column time to answer.
    await page.waitForTimeout(9000);
    const now = await readSurface(page);
    await page.screenshot({ path: `${OUT}/${surface.shot}` });

    const newErrors = consoleErrors.slice(errorsMark);
    const newPageErrors = pageErrors.slice(pageErrorsMark);
    const refusalLines = newErrors.filter((line) => /HandledFetchError: .* 501/.test(line));
    const refusalSentences = refusalLines
      .map((line) => /HandledFetchError: [A-Za-z]+ 501 - (.*) Details:/.exec(line))
      .filter(Boolean)
      .map((found) => found[1].trim());

    // The sentence the column has to be carrying: compared word-for-word (with
    // punctuation and case flattened), so a check cannot pass on a sentence the
    // page wrote for itself.
    const flattenForCompare = (value) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    const columnFlat = flattenForCompare(now.column);
    const refusalsOnScreen = refusalSentences.filter((sentence) => {
      const flat = flattenForCompare(sentence);
      return flat.length > 24 && columnFlat.includes(flat.slice(0, 40));
    });

    seen.push({
      surface: surface.name,
      path: surface.path,
      landed: now.path,
      degradedKind: now.degradedKind,
      degradedText: now.degradedText,
      genericErrorCopy: now.genericErrorCopy,
      pageErrors: newPageErrors,
      refusals: refusalSentences,
      onScreen: refusalsOnScreen,
      column: now.column.slice(0, 400),
    });

    check(
      `${surface.name}: opens inside the shell, without a crash`,
      inClient(now) && newPageErrors.length === 0,
      `landed=${now.path} deviceOnly=${now.deviceOnlyLanding} onboarding=${now.onboardingSheet} pageErrors=${newPageErrors.length}`,
    );
    check(
      `${surface.name}: no generic 'error retrieving data, try again' copy`,
      !now.genericErrorCopy,
      now.genericErrorCopy ? now.column.slice(0, 160) : 'no generic error copy',
    );
    if (surface.honestFromRefusal) {
      check(
        `${surface.name}: the node refused the read, and the sentence is on screen`,
        refusalSentences.length > 0 && refusalsOnScreen.length > 0,
        refusalSentences.length === 0
          ? 'no 501 at all on this surface'
          : `refused with "${refusalSentences[0]}" — on screen: ${refusalsOnScreen.length > 0}`,
      );
    }
    const honest = surface.honestFromRefusal
      ? refusalsOnScreen.length > 0
      : surface.honest.test(now.column);
    const fake = surface.fake ? surface.fake.test(now.column) : false;
    check(
      `${surface.name}: the column says why, in place, and shows no empty success`,
      honest && !fake,
      `says-why=${honest} fake=${fake} :: ${(now.degradedText || now.column).slice(0, 170)}`,
    );
  }

  await browser.close();

  const refusals = new Map();
  for (const line of consoleErrors) {
    const found = /HandledFetchError: ([A-Za-z]+) 501 - (.*) Details:/.exec(line);
    if (found && !refusals.has(found[1])) refusals.set(found[1], found[2]);
  }
  const failed = checks.filter((c) => !c.ok);

  console.log('── the surfaces the node CANNOT answer, driven with a real session ──');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }

  console.log('\n── what each surface did ──');
  for (const s of seen) console.log(JSON.stringify(s, null, 1));

  console.log(`\n── the adapter's own 501 sentences (${refusals.size}) ──`);
  for (const [name, why] of refusals) console.log(`  ${name}: ${why}`);
  if (refusals.size === 0) console.log('  (none)');

  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; ` +
      `console errors: ${consoleErrors.length}; page errors: ${pageErrors.length}; screenshots in ${OUT}`,
  );

  if (failed.length > 0) process.exitCode = 1;
};

await run();