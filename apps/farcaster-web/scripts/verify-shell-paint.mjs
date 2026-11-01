// What a signed-in reader sees while the app loads, and what they see when they
// change server in Advanced, driven in a real browser.
//
//   HTTPS=true SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     npx vite --port 5177 --strictPort
//   FIDDY_SHELL_SERVER=https://localhost:5177 node scripts/verify-shell-paint.mjs
//
// The shell is meant to be painted by the document itself, so these are the
// claims, and each one is measured rather than asserted in prose:
//
//   (1) with JavaScript switched off entirely — no bundle, no feed, no read —
//       the document still paints the shell: the top bar, the rail, the page
//       column and the phone's tab bar, at the sizes the app's own shell uses.
//   (2) signed in, the shell is on screen from the document's first paint and
//       never leaves: no animation frame, from that paint until the feed has
//       settled, has neither the document's shell nor the app's own on screen.
//       React clears its container before it paints, so this is measured rather
//       than assumed.
//   (3) the app's own chrome lands while the feed's reads are still in flight:
//       the shell does not wait for the feed's data.
//   (4) the document hands the shell over — the app's chrome is up and the
//       document's own copy is gone, so nothing is left covering the app.
//   (5) nothing loses the shell when a node choice is saved in Advanced, where
//       the node client is rebuilt, and a save never reloads the page.
//   (6) a reload of the settings page paints the shell again at
//       `domcontentloaded`, so a refresh is never a picture of the background.
//
// Screenshots land in $FIDDY_SHELL_SHOT_DIR (default: the system temp dir).
//
// Requires a dev server with a node configured (any live read node): a session
// with nowhere to read lands on the device-only shell instead. The sign-in is
// the same seeded SIWF session the other probes use: only the relay is stubbed,
// and it names a real account (fid 3).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.FIDDY_SHELL_SERVER ?? 'https://localhost:5177';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.FIDDY_SHELL_SHOT_DIR ?? os.tmpdir();
const NONCE = 'f'.repeat(128);
const SIGNED_IN_FID = 3;
const SETTINGS_PATH = '/~/settings/node';

/** The chrome the document must paint on its own, and where it must sit. */
const SHELL = '[data-fiddy="shell-skeleton"]';
/** The app's own top bar: what replaces the skeleton on the app's first commit. */
const APP_TOPBAR = '[data-fiddy="topbar"]';

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

/** What the shell looks like from the page itself, in the page's own words. */
const readShell = (page) =>
  page.evaluate(() => {
    const size = (selector) => {
      const el = document.querySelector(selector);
      if (!el) {
        return null;
      }
      const rect = el.getBoundingClientRect();
      const style = globalThis.getComputedStyle(el);
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: style.display !== 'none' && style.visibility !== 'hidden',
      };
    };
    return {
      skeleton: size('[data-fiddy="shell-skeleton"]'),
      topbar: size('.fiddy-skeleton-topbar'),
      nav: size('.fiddy-skeleton-nav'),
      column: size('.fiddy-skeleton-col'),
      rail: size('.fiddy-skeleton-rail'),
      tabs: size('.fiddy-skeleton-tabs'),
      appTopbar: Boolean(document.querySelector('[data-fiddy="topbar"]')),
      // The document's copy carries this id; the app's fallback does not, so
      // this is the one that says whether the handover happened.
      documentSkeleton: Boolean(document.getElementById('shell-skeleton')),
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
    };
  });

/**
 * Watch every animation frame from before the app's script runs: when the
 * shell was first on screen, and every frame after that on which it was gone.
 */
const installFrameWatch = (page) =>
  page.addInitScript(
    ([skeletonSelector]) => {
      const state = {
        frames: 0,
        // Frames where neither the document's shell nor the app's own was on
        // screen: the blank page these checks exist for.
        blankFrames: 0,
        // Frames where both were, i.e. the handover from one to the other.
        handoverFrames: 0,
        firstShellMs: null,
        firstAppChromeMs: null,
        blankSamples: [],
      };
      globalThis.__shellWatch = state;
      const tick = () => {
        state.frames += 1;
        const t = Math.round(performance.now());
        const documentShell = Boolean(document.querySelector(skeletonSelector));
        const appChrome = Boolean(
          document.querySelector('[data-fiddy="topbar"]'),
        );
        if (documentShell || appChrome) {
          if (state.firstShellMs === null) state.firstShellMs = t;
        } else {
          state.blankFrames += 1;
          if (state.blankSamples.length < 5) {
            state.blankSamples.push({
              t,
              rootChildren:
                document.getElementById('root')?.childElementCount ?? -1,
            });
          }
        }
        if (documentShell && appChrome) {
          state.handoverFrames += 1;
        }
        if (appChrome && state.firstAppChromeMs === null) {
          state.firstAppChromeMs = t;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    [SHELL],
  );

const readWatch = (page) =>
  page.evaluate(() => globalThis.__shellWatch ?? null);

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
          channelToken: 'SHELLPAINT',
          url: `https://farcaster.xyz/~/siwf?channelToken=SHELLPAINT`,
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

  /**
   * One handshake, driven from the setup screen's own control.
   *
   * The control is waited for by name rather than by "the body has some text
   * in it": the shell the document paints carries a line of text of its own, so
   * a text-length wait is satisfied before the app has rendered anything and
   * the click below would find no button and silently do nothing.
   */
  const inClient = () =>
    page.waitForFunction(
      () =>
        window.location.pathname === '/' &&
        !document.querySelector('[data-fiddy="device-only-session"]') &&
        !document.querySelector('[data-fiddy="onboarding"]'),
      { timeout: 45000 },
    );

  const attemptSignIn = async () => {
    await page.goto(`${SERVER}/welcome/ready`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    const goSocial = page
      .locator('button, a, [role=button]')
      .filter({ hasText: /go social/i })
      .first();
    await goSocial.waitFor({ state: 'visible', timeout: 60000 });
    await goSocial.click();
    try {
      await inClient();
      return true;
    } catch {
      return false;
    }
  };

  // The stubbed handshake polls a channel and is occasionally dropped by the
  // dev server under load, which lands the setup screen on its own "Try again"
  // surface. That is the harness, not the app, so it is retried here — every
  // measurement this probe makes happens after a handshake that landed.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await attemptSignIn()) {
      return;
    }
    console.log(`the stubbed sign-in did not land (attempt ${attempt} of 3)`);
  }
  throw new Error('the stubbed sign-in never landed in the client');
};

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });

  // ── 1. the document alone paints the shell ────────────────────────────────
  // No JavaScript at all: if the shell needs the bundle or a read to exist, it
  // does not exist here.
  const noJs = await browser.newContext({
    ignoreHTTPSErrors: true,
    javaScriptEnabled: false,
    viewport: { width: 1440, height: 900 },
  });
  const stillPage = await noJs.newPage();
  await stillPage.goto(`${SERVER}/`, { waitUntil: 'load', timeout: 60000 });
  const still = await readShell(stillPage);
  await stillPage.screenshot({ path: `${OUT}/shell-no-js-1440.png` });
  check(
    'with JavaScript off, the document paints the shell itself',
    // Nothing runs here, so `#root` is empty: that is the whole point. What
    // has to exist is the document's own copy, outside the root, at size.
    still.skeleton?.visible === true &&
      still.documentSkeleton === true &&
      still.skeleton.height > 300,
    JSON.stringify({ root: still.rootChildren, ...still.skeleton }),
  );
  check(
    'the top bar and the page column are drawn at the shell’s own sizes',
    still.topbar?.visible === true &&
      still.topbar.height === 60 &&
      still.column?.visible === true &&
      still.column.width === 620,
    `topbar=${JSON.stringify(still.topbar)} column=${JSON.stringify(still.column)}`,
  );
  check(
    'the rail is drawn on a wide screen, the tab bar on a phone',
    still.nav?.visible === true &&
      Math.round(still.nav.width) === 220 &&
      still.rail?.visible === true,
    `nav=${JSON.stringify(still.nav)} rail=${JSON.stringify(still.rail)}`,
  );
  const phone = await noJs.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${SERVER}/`, { waitUntil: 'load', timeout: 60000 });
  const stillPhone = await readShell(phone);
  await phone.screenshot({ path: `${OUT}/shell-no-js-390.png` });
  check(
    'on a phone the shell is the column and the tab bar, with no rail',
    stillPhone.tabs?.visible === true &&
      stillPhone.column?.visible === true &&
      stillPhone.nav?.visible !== true &&
      stillPhone.rail?.visible !== true,
    JSON.stringify(stillPhone),
  );
  await noJs.close();

  // ── 2-4. signed in, on a cold load of the feed ────────────────────────────
  const desktop = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  const page = await desktop.newPage();
  const inflightReads = new Set();
  const isRead = (url) =>
    /\/(v1|v2|fc)\//.test(new URL(url).pathname) ||
    url.includes('haatz.quilibrium.com') ||
    url.includes('/snapchain-api/');
  page.on('request', (request) => {
    if (isRead(request.url())) inflightReads.add(request.url());
  });
  page.on('requestfinished', (request) => inflightReads.delete(request.url()));
  page.on('requestfailed', (request) => inflightReads.delete(request.url()));
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

  await installFrameWatch(page);
  await signIn(page);

  const started = Date.now();
  await page.goto(`${SERVER}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const atContentLoaded = await readShell(page);
  // What a reader is looking at while the feed's reads are still out: the shell
  // the document painted, before any of the app owns the screen.
  await page.screenshot({ path: `${OUT}/shell-at-domcontentloaded-1440.png` });
  check(
    'a signed-in load has the shell on screen at domcontentloaded',
    atContentLoaded.skeleton !== null &&
      atContentLoaded.skeleton.visible &&
      atContentLoaded.skeleton.height > 300,
    JSON.stringify(atContentLoaded.skeleton),
  );

  const shellAt = Date.now() - started;
  await page.waitForSelector(APP_TOPBAR, { timeout: 60000 });
  const appChromeAt = Date.now() - started;
  const readsInFlightAtShell = inflightReads.size;
  await page.waitForTimeout(3000);
  const watch = await readWatch(page);
  const settled = await readShell(page);
  await page.screenshot({ path: `${OUT}/shell-signed-in-1440.png` });

  console.log(
    `domcontentloaded after ${shellAt} ms (the shell is in the document by then); the app's own chrome after ${appChromeAt} ms; ${readsInFlightAtShell} of the feed's reads were still unanswered when it landed`,
  );
  console.log(
    `frames=${watch.frames} blankFrames=${watch.blankFrames} handoverFrames=${watch.handoverFrames} firstShellMs=${watch.firstShellMs} firstAppChromeMs=${watch.firstAppChromeMs}`,
  );

  check(
    'the body is never empty, from the document’s first paint on',
    watch.blankFrames === 0,
    `${watch.blankFrames} of ${watch.frames} frames had neither shell on screen${watch.blankSamples.length > 0 ? ` — ${JSON.stringify(watch.blankSamples)}` : ''}`,
  );
  check(
    'the shell is up while the feed’s own reads are still in flight',
    readsInFlightAtShell > 0,
    `${readsInFlightAtShell} reads unanswered at ${appChromeAt} ms`,
  );
  check(
    'the document hands the shell over to the app’s own',
    settled.appTopbar && !settled.documentSkeleton,
    `appTopbar=${settled.appTopbar} documentSkeleton=${settled.documentSkeleton} (a leftover skeleton would be covering the app)`,
  );
  check(
    'the shell painted without a page error',
    pageErrors.length === 0,
    pageErrors.join(' | ') || 'no page errors',
  );

  // ── 4-5. a save in Advanced, and a reload ─────────────────────────────────
  await page.goto(`${SERVER}${SETTINGS_PATH}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  const settingsAtContentLoaded = await readShell(page);
  check(
    'a reload of a settings page paints the shell at domcontentloaded',
    settingsAtContentLoaded.skeleton !== null &&
      settingsAtContentLoaded.skeleton.visible,
    JSON.stringify(settingsAtContentLoaded.skeleton),
  );
  await page.waitForSelector('[data-fiddy="node-choice"]', { timeout: 60000 });
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    globalThis.__shellWatch.blankFrames = 0;
    globalThis.__shellWatch.blankSamples = [];
    globalThis.__shellWatch.frames = 0;
  });

  // Frames, not just the DOM: the blank this card is about was a screenshot of
  // one colour, so a shot is taken as fast as the browser will take them right
  // after the save, and each one is read back through the browser's own PNG
  // decoder. A uniform shot is a blank page whatever the DOM says.
  const decoder = await browser.newPage();
  await decoder.goto('about:blank');
  const readShot = async (base64) =>
    decoder.evaluate(async (b64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${b64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const seen = new Set();
      // Every third pixel is enough to tell one colour from a page.
      for (let i = 0; i < data.length; i += 12) {
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        if (seen.size > 24) break;
      }
      return {
        distinct: seen.size,
        colours: [...seen]
          .slice(0, 4)
          .map((v) => `#${v.toString(16).padStart(6, '0')}`),
      };
    }, base64);

  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  const shotFrames = [];
  await page.click(
    '[data-fiddy="node-choice"] button:has-text("Use this one")',
  );
  for (let i = 0; i < 14; i += 1) {
    const png = await page.screenshot();
    const stats = await readShot(png.toString('base64'));
    shotFrames.push({ i, ...stats });
    if (i === 0) {
      await page.screenshot({ path: `${OUT}/shell-after-save-1440.png` });
    }
  }
  const uniform = shotFrames.filter((f) => f.distinct <= 1);

  // The DOM-level half: a frame with no top bar and an empty root is the same
  // blank, and this catches it even if the compositor kept the last picture.
  const blank = [];
  for (let i = 0; i < 15; i += 1) {
    const read = await readShell(page);
    if (!read.appTopbar || read.rootChildren < 1) {
      blank.push({ i, ...read });
    }
    await page.waitForTimeout(200);
  }
  const afterSave = await readWatch(page);
  const navigationsDuringSave = navigations;

  console.log(
    `right after the save: ${shotFrames.length} frames shot, distinct colours ${JSON.stringify(shotFrames.map((f) => f.distinct))}`,
  );

  check(
    'saving a node choice never leaves a blank frame — no frame of one colour',
    uniform.length === 0,
    uniform.length > 0
      ? `${uniform.length} of ${shotFrames.length} frames were a single colour: ${JSON.stringify(uniform.slice(0, 3))}`
      : `all ${shotFrames.length} frames had a picture (${shotFrames[0]?.distinct} colours in the first)`,
  );
  check(
    'no frame loses the shell when a node choice is saved',
    afterSave.blankFrames === 0 && blank.length === 0,
    `blankFrames=${afterSave.blankFrames} blankReads=${JSON.stringify(blank.slice(0, 3))} of ${afterSave.frames} frames`,
  );
  check(
    'saving a choice does not reload the page under the reader',
    navigationsDuringSave === 0,
    `${navigationsDuringSave} main-frame navigations during and after the save`,
  );

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

await run();
