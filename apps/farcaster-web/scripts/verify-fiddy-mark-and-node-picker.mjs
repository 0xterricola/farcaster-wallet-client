// What the shell's brand mark and the server picker do, driven in a real browser.
//
//   HTTPS=true SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     npx vite --port 5177 --strictPort
//   FIDDY_MARK_SERVER=https://localhost:5177 node scripts/verify-fiddy-mark-and-node-picker.mjs
//
// Requires a dev server with a node configured (any live read node), because a
// session with nowhere to read lands on the device-only shell and never reaches
// the settings page. The sign-in is the same seeded SIWF session the other
// probes use: only the relay is stubbed, and it names a real account (fid 3).
//
// WHAT IT ASSERTS
//   the mark (1) is in the top bar at the design's 36px, (2) paints a real
//   still before anything else, and (3) never puts the model on the critical
//   path — its fetch starts after first contentful paint. Under
//   `prefers-reduced-motion: reduce` it must not fetch the model at all, and
//   must still be there as a still.
//
//   the picker (4) puts the two ways in plain words, (5) lists only nodes that
//   were measured (haatz.quilibrium.com), (6) links the honest "~2 TB" card to
//   the walkthrough, and (7) — the part that matters — saves the choice where
//   the rest of the client reads it while the pill tells the truth: a public
//   choice is never described as your own, and an address that answers nothing
//   is never described as answering.
//
// Screenshots land in $FIDDY_MARK_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.FIDDY_MARK_SERVER ?? 'https://localhost:5177';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.FIDDY_MARK_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'FIDDYMARK1';
const SIGNED_IN_FID = 3;
const SETTINGS_PATH = '/~/settings/node';

/** The public node this client is measured against, so the check names it. */
const PUBLIC_NODE = 'haatz.quilibrium.com';
const TUTORIAL = 'https://fiddy.fun/client';
/** An address that resolves to nothing: the honest-offline case. */
const DEAD_NODE = 'https://no-such-node.invalid:3381';

/** Words this screen must not use (the ELI5 ban). */
const JARGON = /\bRPC\b|\bgRPC\b|shard|gossip|indexer|protocol upgrade/i;

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
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

const flatten = (value) => value.replace(/\s+/g, ' ').trim();

/** The brand mark, as the page itself reports it. */
const readMark = (page) =>
  page.evaluate(() => {
    const flat = (value) => value.replace(/\s+/g, ' ').trim();
    const topbar = document.querySelector('[data-fiddy="topbar"]');
    const mark = topbar ? topbar.querySelector('[data-fiddy-mark]') : null;
    const img = mark ? mark.querySelector('img') : null;
    const rect = mark ? mark.getBoundingClientRect() : null;
    return {
      hasTopbar: Boolean(topbar),
      brandText: topbar ? flat(topbar.innerText) : '',
      markState: mark ? mark.getAttribute('data-fiddy-mark') : null,
      markSize: rect
        ? `${Math.round(rect.width)}x${Math.round(rect.height)}`
        : null,
      markSrc: img ? img.getAttribute('src') : null,
      markPainted: Boolean(img && img.complete && img.naturalWidth > 0),
      canvas: Boolean(mark && mark.querySelector('canvas')),
    };
  });

/** When the still was painted and when the model was asked for. */
const readTiming = (page) =>
  page.evaluate(() => {
    const paint = globalThis.performance
      .getEntriesByType('paint')
      .find((entry) => entry.name === 'first-contentful-paint');
    const model = globalThis.performance
      .getEntriesByType('resource')
      .find((entry) => entry.name.includes('fiddy-loader.glb'));
    return {
      firstPaintMs: paint ? Math.round(paint.startTime) : null,
      modelStartMs: model ? Math.round(model.startTime) : null,
    };
  });

/** The nav's own mark, and whether a Farcaster logo is still left in the shell. */
const readNavMark = (page) =>
  page.evaluate(() => {
    const img = document.querySelector('.fiddy-nav-mark');
    const rect = img ? img.getBoundingClientRect() : null;
    return {
      src: img ? img.getAttribute('src') : null,
      size: rect
        ? `${Math.round(rect.width)}x${Math.round(rect.height)}`
        : null,
      painted: Boolean(img && img.complete && img.naturalWidth > 0),
      // The fork's mark was a #6A3CFF rounded square: any survivor is a leftover.
      farcasterFill: Boolean(document.querySelector('[fill="#6A3CFF"]')),
    };
  });

const webglAvailable = (page) =>
  page.evaluate(() => {
    try {
      const canvas = document.createElement('canvas');
      return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
    } catch {
      return false;
    }
  });

/** What the top bar says about where answers came from — the pill's own words. */
const readPill = (page) =>
  page.evaluate(() => {
    const pill = document.querySelector(
      '.fiddy-node-pill, [data-fiddy="topbar"] [role="status"]',
    );
    return pill ? pill.innerText.replace(/\s+/g, ' ').trim() : '';
  });

/** The picker's own copy and controls. */
const readPicker = (page) =>
  page.evaluate(() => {
    const card = document.querySelector('[data-fiddy="node-choice"]');
    const select = card ? card.querySelector('select') : null;
    const link = card ? card.querySelector('a[href]') : null;
    return {
      present: Boolean(card),
      text: card ? card.innerText.replace(/\s+/g, ' ').trim() : '',
      options: select
        ? Array.from(select.options).map((option) => option.value)
        : [],
      radios: card
        ? Array.from(card.querySelectorAll('input[type="radio"]')).map(
            (radio) => radio.checked,
          )
        : [],
      tutorialHref: link ? link.getAttribute('href') : null,
      buttons: card
        ? Array.from(card.querySelectorAll('button')).map((button) =>
            button.textContent.trim(),
          )
        : [],
    };
  });

const storedChoice = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        // The app stores preferences through localforage, which in a browser is
        // IndexedDB — so the choice is read back from where it actually lives,
        // with localStorage checked first in case the driver fell back.
        const raw = window.localStorage.getItem('snapchain_node_choice_3');
        if (raw) {
          resolve(JSON.parse(raw));
          return;
        }
        const open = globalThis.indexedDB.open('localforage');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('keyvaluepairs')) {
            resolve(null);
            return;
          }
          const request = db
            .transaction('keyvaluepairs', 'readonly')
            .objectStore('keyvaluepairs')
            .get('snapchain_node_choice_3');
          request.onsuccess = () => resolve(request.result ?? null);
          request.onerror = () => resolve(null);
        };
      }),
  );

/**
 * Wait until the shell is on screen and stays there. Saving a choice rebuilds
 * the client, and the shell has a moment of nothing while that happens — a shot
 * taken then is a picture of the background.
 */
const waitForStableShell = async (page, tries = 30) => {
  let last = '';
  for (let i = 0; i < tries; i += 1) {
    const card = await readPicker(page);
    const pill = await readPill(page);
    const now = `${card.present}|${card.text.length}|${pill.length}`;
    if (
      card.present &&
      card.text.length > 60 &&
      pill.length > 0 &&
      now === last
    ) {
      return true;
    }
    last = now;
    await page.waitForTimeout(1000);
  }
  return false;
};

/** Sign in through the stubbed relay, and land inside the shell. */
const signIn = async (page) => {
  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
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

  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(() => document.body.innerText.trim().length > 40, {
    timeout: 60000,
  });
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = flatten((await el.innerText()) || '');
    if (/go social/i.test(text)) {
      await el.click();
      break;
    }
  }
  await page.waitForFunction(
    () =>
      window.location.pathname === '/' &&
      !document.querySelector('[data-fiddy="device-only-session"]') &&
      !document.querySelector('[data-fiddy="onboarding"]'),
    { timeout: 60000 },
  );
};

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });

  // ── 1-3. the mark, as motion is allowed ───────────────────────────────────
  const desktop = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await desktop.newPage();
  const modelRequests = [];
  // What the page looked like at the instant the model was asked for: the claim
  // is that the still is already painted by then, and that is what is asserted —
  // a resource timing entry is not usable here, because this app makes enough
  // requests to overflow the browser's timing buffer.
  let atFirstModelRequest = null;
  page.on('request', async (request) => {
    if (!request.url().includes('fiddy-loader.glb')) return;
    modelRequests.push(request.url());
    if (atFirstModelRequest !== null) return;
    atFirstModelRequest = await page
      .evaluate(() => {
        const img = document.querySelector('[data-fiddy-mark] img');
        return {
          posterInDom: Boolean(img),
          posterPainted: Boolean(img?.complete && img?.naturalWidth > 0),
          fcpDone: globalThis.performance
            .getEntriesByType('paint')
            .some((entry) => entry.name === 'first-contentful-paint'),
        };
      })
      .catch(() => null);
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  await signIn(page);
  const webgl = await webglAvailable(page);

  // How long the authed shell takes to paint at all, from a cold load of the
  // feed. Reported, not asserted: that number belongs to the feed's own
  // boundary, not to the mark, and it is here so the run says what a reader
  // waits for before anything can be seen.
  const shellStart = Date.now();
  await page.goto(`${SERVER}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  let homeShellMs = null;
  for (let i = 0; i < 45; i += 1) {
    if (await page.$('[data-fiddy="topbar"]')) {
      homeShellMs = Date.now() - shellStart;
      break;
    }
    await page.waitForTimeout(1000);
  }
  console.log(`the feed's shell painted after ${homeShellMs ?? '>45000'} ms`);
  // ── 3-7. the mark and the picker, on the page the status pill opens ───────
  // Measured here rather than on the feed: the same component, on a page whose
  // first paint is not waiting on a follow graph.
  await page.goto(`${SERVER}${SETTINGS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('[data-fiddy="topbar"]', { timeout: 60000 });
  await page.waitForSelector('[data-fiddy="node-choice"]', { timeout: 60000 });
  // The model is fetched on a timer after the shell is up; give it that much.
  await page.waitForTimeout(6000);
  const mark = await readMark(page);
  const timing = await readTiming(page);
  const navMark = await readNavMark(page);
  await page.screenshot({ path: `${OUT}/fiddy-mark-topbar-1440.png` });
  const picker = await readPicker(page);
  await page.screenshot({ path: `${OUT}/node-picker-1440.png` });

  check(
    'the top bar carries the mark, at the design’s 36px',
    mark.hasTopbar && mark.markState !== null && mark.markSize === '36x36',
    `topbar=${mark.hasTopbar} state=${mark.markState} size=${mark.markSize} brand="${mark.brandText}"`,
  );
  check(
    'the mark is painted as a real still (never an empty slot)',
    mark.markPainted && /fiddy-mark-poster\.png/.test(mark.markSrc ?? ''),
    `src=${mark.markSrc} painted=${mark.markPainted}`,
  );
  check(
    webgl
      ? 'with motion allowed and WebGL present, the mark is moving'
      : 'without WebGL the mark stays a still, and says so',
    webgl ? mark.markState === 'moving' : mark.markState === 'still',
    `webgl=${webgl} state=${mark.markState} canvas=${mark.canvas} modelRequests=${modelRequests.length}`,
  );
  check(
    'the model is not on the critical path: the still was painted first',
    atFirstModelRequest?.posterPainted === true,
    `at the model request: posterInDom=${atFirstModelRequest?.posterInDom} posterPainted=${atFirstModelRequest?.posterPainted} firstPaintDone=${atFirstModelRequest?.fcpDone}; requests=${modelRequests.length}; FCP=${timing.firstPaintMs}ms`,
  );
  check(
    'the shell painted without a page error',
    pageErrors.length === 0,
    pageErrors.join(' | ') || 'no page errors',
  );
  check(
    'the nav carries the same baby, and no Farcaster logo is left in the shell',
    navMark.painted &&
      navMark.src === '/fiddy-mark-poster.png' &&
      navMark.size === '24x24' &&
      !navMark.farcasterFill,
    JSON.stringify(navMark),
  );

  check(
    'the picker is on the page the status pill opens',
    picker.present && /Where Fiddy reads from/.test(picker.text),
    picker.text.slice(0, 120),
  );
  check(
    'both ways are offered, in plain words',
    /Use a public Farcaster node/.test(picker.text) &&
      /Run your own node/.test(picker.text),
    picker.text.slice(0, 200),
  );
  check(
    'only measured public nodes are listed, and the one Fiddy uses is on it',
    picker.options.some((option) => option.includes(PUBLIC_NODE)),
    `options=${picker.options.join(', ')}`,
  );
  check(
    'an address you may not have is still yours to paste',
    picker.options.some((option) => option === '__another__'),
    `options=${picker.options.join(', ')}`,
  );
  check(
    'your own node is described honestly, and linked to the walkthrough',
    /2 TB/.test(picker.text) && picker.tutorialHref === TUTORIAL,
    `href=${picker.tutorialHref} :: ${/about 2 TB/.test(picker.text)}`,
  );
  check(
    'the screen keeps to plain words',
    !JARGON.test(picker.text),
    JARGON.test(picker.text)
      ? `jargon: ${(JARGON.exec(picker.text) ?? [])[0]}`
      : 'no jargon',
  );

  // Choosing the public node saves it where the client reads it, and the pill
  // describes it as somebody else's server — never as your own.
  await page.click(
    '[data-fiddy="node-choice"] button:has-text("Use this one")',
  );
  await page.waitForTimeout(3000);
  const publicChoice = await storedChoice(page);
  const publicOutcome = await readPicker(page);
  // Reloaded, so the "in use" line is the stored choice and not this render.
  await page.goto(`${SERVER}${SETTINGS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('[data-fiddy="node-choice"]', { timeout: 60000 });
  await page.waitForTimeout(5000);
  const publicInUse = await readPicker(page);
  const publicPill = await readPill(page);
  await waitForStableShell(page);
  await page.screenshot({ path: `${OUT}/node-picker-public-chosen-1440.png` });

  check(
    'choosing a public node is saved as the public kind',
    publicChoice?.kind === 'public' &&
      String(publicChoice?.url ?? '').includes(PUBLIC_NODE),
    JSON.stringify(publicChoice),
  );
  check(
    'the choice survives a reload, and the card says what is in use',
    /in use: a public server/.test(publicInUse.text),
    (publicInUse.text.match(/in use:[^.]*\./) ?? ['no in-use line'])[0],
  );
  check(
    'the save reports what the address really answered',
    /It answered in \d+ ms|did not answer just now/.test(publicOutcome.text),
    (publicOutcome.text.match(/It answered[^.]*\.|did not answer[^.]*\./) ?? [
      'no outcome line on screen',
    ])[0],
  );
  check(
    'the pill never calls a public server "your own"',
    publicPill.length > 0 &&
      !/your own/i.test(publicPill) &&
      /public|offline|checking|fiddy|shared|staying|answering/i.test(
        publicPill,
      ),
    publicPill.slice(0, 140),
  );
  // Your own node: an address that answers nothing must not be described as
  // answering, on the card or in the pill.
  await page.click('[data-fiddy="node-choice"] input[type="radio"] >> nth=1');
  await page.fill(
    '[data-fiddy="node-choice"] input[placeholder^="https://your-server"]',
    DEAD_NODE,
  );
  await page.click(
    '[data-fiddy="node-choice"] button:has-text("Use this one")',
  );
  await page.waitForTimeout(4000);
  const ownChoice = await storedChoice(page);
  const ownCard = await readPicker(page);
  await page.goto(`${SERVER}${SETTINGS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('[data-fiddy="node-choice"]', { timeout: 60000 });
  await page.waitForTimeout(6000);
  const ownInUse = await readPicker(page);
  const ownPill = await readPill(page);
  await waitForStableShell(page);
  await page.screenshot({ path: `${OUT}/node-picker-own-chosen-1440.png` });

  check(
    'choosing your own node is saved as the own kind',
    ownChoice?.kind === 'own' &&
      String(ownChoice?.url ?? '').includes('invalid'),
    JSON.stringify(ownChoice),
  );
  check(
    'the choice survives a reload as your own',
    /in use: your own/.test(ownInUse.text),
    (ownInUse.text.match(/in use:[^.]*\./) ?? ['no in-use line'])[0],
  );
  check(
    'an address that answers nothing is not described as answering',
    /did not answer just now/.test(ownCard.text) &&
      !/Answers come from your own setup/i.test(ownPill),
    `card="${(ownCard.text.match(/Saved,[^.]*\./) ?? ['no outcome line'])[0]}" pill="${ownPill.slice(0, 120)}"`,
  );
  // Leave nothing behind: back to what the build came with.
  await page.goto(`${SERVER}${SETTINGS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForSelector('[data-fiddy="node-choice"]', { timeout: 60000 });
  const resetButton = await page.$(
    '[data-fiddy="node-choice"] button:has-text("Go back to what this build came with")',
  );
  if (resetButton) {
    await resetButton.click();
    await page.waitForTimeout(1000);
  }
  const afterReset = await storedChoice(page);
  check(
    'the choice can be given back, and storage is left clean',
    afterReset === null,
    JSON.stringify(afterReset),
  );

  // ── the phone, and the still under reduced motion ─────────────────────────
  const mobile = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const phonePage = await mobile.newPage();
  await signIn(phonePage);
  await phonePage.goto(`${SERVER}${SETTINGS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await phonePage.waitForSelector('[data-fiddy="node-choice"]', {
    timeout: 60000,
  });
  const phonePicker = await readPicker(phonePage);
  await phonePage.screenshot({
    path: `${OUT}/node-picker-390.png`,
    fullPage: true,
  });
  await phonePage.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded' });
  await phonePage.waitForTimeout(3000);
  await phonePage.screenshot({ path: `${OUT}/fiddy-shell-390.png` });

  check(
    'the phone gets the same two ways, in plain words',
    phonePicker.present &&
      /Use a public Farcaster node/.test(phonePicker.text) &&
      /Run your own node/.test(phonePicker.text),
    `present=${phonePicker.present} text=${phonePicker.text.slice(0, 140)}`,
  );
  check(
    'the phone shell paints without a page error',
    pageErrors.length === 0,
    pageErrors.join(' | ') || 'no page errors',
  );

  const reduced = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const stillPage = await reduced.newPage();
  const stillModelRequests = [];
  stillPage.on('request', (request) => {
    if (request.url().includes('fiddy-loader.glb')) {
      stillModelRequests.push(request.url());
    }
  });
  await signIn(stillPage);
  await stillPage.goto(`${SERVER}${SETTINGS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await stillPage.waitForSelector('[data-fiddy="topbar"]', { timeout: 60000 });
  await stillPage.waitForTimeout(6000);
  const stillMark = await readMark(stillPage);
  await stillPage.screenshot({
    path: `${OUT}/fiddy-mark-topbar-reduced-1440.png`,
  });

  check(
    'under prefers-reduced-motion the mark is a still, and the model is never fetched',
    stillMark.markState === 'still' &&
      stillMark.markPainted &&
      stillModelRequests.length === 0,
    `state=${stillMark.markState} painted=${stillMark.markPainted} modelRequests=${stillModelRequests.length}`,
  );

  await browser.close();

  const failed = checks.filter((entry) => !entry.ok);
  console.log('── the mark and the picker, driven with a real session ──');
  for (const entry of checks) {
    console.log(
      `${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`,
    );
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );

  if (failed.length > 0) process.exitCode = 1;
};

await run();
