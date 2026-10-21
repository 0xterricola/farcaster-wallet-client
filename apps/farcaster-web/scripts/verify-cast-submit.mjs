// End-to-end: someone types a cast and presses Cast, with the node-backed
// client on a live public node and no hosted session. What happens, in order,
// and what the person is told when it does not post.
//
//   node scripts/verify-cast-submit.mjs
//
// Preconditions — one dev server, the app's own config plus a dep cache of its
// own (see `scripts/probe.vite.config.mjs`, which exists because several vite
// servers in one checkout invalidate each other's `node_modules/.vite`):
//
//   cd apps/farcaster-web
//   SNAPCHAIN_HTTP_URL=https://<a public read node> \
//   VITE_SNAPCHAIN_HTTP_URL=https://<the same> \
//   VITE_SNAPCHAIN_DEBUG=true \
//   npx vite --config scripts/probe.vite.config.mjs --port 5202 --strictPort
//
//   NODE_BACKED_SERVER=https://localhost:5202 node scripts/verify-cast-submit.mjs
//
// RESTART THE DEV SERVER BEFORE BELIEVING A RED RUN. MEASURED 2026-10-21: a
// server left up for five hours (HMR churn over the whole working clone) answered
// this probe 4/12 — the shell painted, the feed stayed empty and no Cast control
// was there to click — while the same tree on a server started seconds earlier
// answered 12/12. The app was never the difference; the server was.
//
// Only the SIWF relay is stubbed (with a REAL SIWE message signed by a throwaway
// key, so the app's own verifier accepts the sign-in for real), exactly as
// scripts/verify-media-upload.mjs and scripts/verify-node-backed-client.mjs do.
// No media service is needed: this probe never picks a photo.
//
// Nothing here posts to Farcaster, and nothing can: the submit is answered
// inside the page by the adapter, which is also why the payload is read from the
// adapter's own log rather than from a network trace. The parent card's rule
// holds — do not post to mainnet from a probe.
//
// WHAT IT ASSERTS (each one a real observation, not a shape guess)
//   1. a completed sign-in lands in the client shell
//   2. the composer opens over the feed and takes typed text
//   3. the pre-publish draft write (`POST /v2/draft-caststorms`) is answered by
//      the LOCAL route with 200 — it used to be a 501, retried twice, in front
//      of every Cast attempt
//   4. that draft is really kept on the device: this browser's storage holds the
//      text the composer saved, under this account's own key
//   5. the submit continues PAST the draft step and reaches `POST /v2/casts`,
//      carrying the same text (measured; the parent card assumed it did not)
//   6. that endpoint refuses with the adapter's named sentence, 501
//   7. the refusal is rendered to the person: "The cast didn't post." plus the
//      reason, on screen while the composer still holds their text
//   8. no success UI for a write that failed ("created successfully" never
//      appears), and the drafts list endpoint answers from the device too, so a
//      saved draft is not a 501 on the way back in
//   9. nothing was posted to Farcaster from this probe
//
// Screenshots land in $CAST_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5202';
const OUT = process.env.CAST_SHOT_DIR ?? os.tmpdir();
const DOMAIN = new URL(SERVER).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'CASTSUBMT';
const SIGNED_IN_FID = 3;
const MODAL_ROOT = '#modal-root';
const PLACEHOLDER = 'Start typing a new cast here...';
const CAST_TEXT = 'a cast typed by the probe, never sent';
/** Where the node adapter's own store keeps this device's drafts. */
const DRAFT_KEY_PREFIX = 'fiddy:node-drafts';

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

const readSurface = (page) =>
  page.evaluate(() => {
    // A read can land on a document that is mid-navigation, and a fresh document
    // has no body yet. Signing in IS a navigation. MEASURED 2026-10-21: without
    // this guard the read right after the "Go social" click threw
    // `Cannot read properties of null (reading 'innerText')` before check 1 could
    // be recorded — and, with no browser close on the throw path, the probe
    // process stayed alive for hours and blocked the shell that started it.
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    return {
      path: window.location.pathname,
      text,
      onboardingSheet: Boolean(
        document.querySelector('[data-fiddy="onboarding"]'),
      ),
      deviceOnlyLanding: Boolean(
        document.querySelector('[data-fiddy="device-only-session"]'),
      ),
      shellMounted: Boolean(document.querySelector('.fiddy-shell-frame')),
    };
  });

/**
 * `page.evaluate` throws "Execution context was destroyed" whenever the app is
 * mid-navigation, and a sign-in IS a navigation. Every read of the surface goes
 * through here, so a destroyed context is "read again in a moment" rather than
 * a dead run. MEASURED 2026-10-21: unguarded, the read right after clicking
 * "Go social" killed the whole probe before check 1 could be recorded.
 */
const safeReadSurface = async (page) => {
  let lastError;
  for (let i = 0; i < 20; i += 1) {
    try {
      return await readSurface(page);
    } catch (e) {
      lastError = e;
      if (
        !/Execution context was destroyed|Cannot find context|Target closed|navigating/i.test(
          String(e),
        )
      ) {
        throw e;
      }
      await page.waitForTimeout(250);
    }
  }
  throw lastError;
};

/** The launched browser, kept where the throw path can close it too. */
let browser;

const run = async () => {
  const consoleErrors = [];

  browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  // Every call that leaves the page. The adapter's own answers are not among
  // them — which is the point: a request the page answers never reaches a
  // network, and that is what check 9 reads.
  await ctx.addInitScript(() => {
    const orig = window.fetch;
    window.__castFetchLog = [];
    window.fetch = async (...args) => {
      const url =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] && args[0].url) || String(args[0]);
      const method = (args[1] && args[1].method) || 'GET';
      const response = await orig(...args);
      window.__castFetchLog.push(
        `${method} ${response.status} ${String(url).slice(0, 200)}`,
      );
      return response;
    };
  });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 240));
    }
  });
  page.on('pageerror', (e) =>
    consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`),
  );

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

  // ── 1. a signed-in client ─────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // Wait for the ready step's OWN control, not for "there is text on the page":
  // the document paints its own skeleton first (the shell-paint work), so a
  // length check returns while the step has not rendered yet, the click below
  // finds nothing, and the run stalls for its full minute looking like a
  // sign-in failure. MEASURED 2026-10-21: that is exactly how a re-run of this
  // probe read 3/12 on a quiet tree.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
        /go social/i.test(el.innerText || ''),
      ),
    { timeout: 60000 },
  );
  let startedSignIn = false;
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      startedSignIn = true;
      break;
    }
  }
  if (!startedSignIn) {
    throw new Error(
      'the ready step never offered "Go social — sign in with Farcaster"',
    );
  }
  let surface = await safeReadSurface(page);
  for (let i = 0; i < 60; i += 1) {
    if (
      surface.path === '/' &&
      surface.shellMounted &&
      !surface.onboardingSheet &&
      !surface.deviceOnlyLanding
    ) {
      break;
    }
    await page.waitForTimeout(1000);
    surface = await safeReadSurface(page);
  }
  check(
    'a completed sign-in lands in the client',
    surface.path === '/' &&
      surface.shellMounted &&
      !surface.onboardingSheet &&
      !surface.deviceOnlyLanding,
    `path=${surface.path} shell=${surface.shellMounted} onboarding=${surface.onboardingSheet} deviceOnly=${surface.deviceOnlyLanding}`,
  );

  // ── 2. the composer ───────────────────────────────────────────────────────
  // The shell keeps a second Cast control in the DOM for narrow screens; only
  // one of them is on screen, so ask for the visible one.
  const castButtons = await page.locator('button:has-text("Cast"):visible').all();
  let opened = false;
  for (const button of castButtons) {
    const text = ((await button.innerText()) || '').trim();
    if (text === 'Cast') {
      await button.click();
      opened = true;
      break;
    }
  }
  if (!opened) {
    await page.keyboard.press('n');
  }

  let editorOpen = false;
  let placeholderSeen = false;
  try {
    await page.waitForSelector(`${MODAL_ROOT} [contenteditable="true"]`, {
      timeout: 30000,
    });
    editorOpen = true;
    placeholderSeen = await page
      .locator(MODAL_ROOT)
      .getByText(PLACEHOLDER)
      .first()
      .isVisible()
      .catch(() => false);
  } catch {
    editorOpen = false;
  }

  const editor = page.locator(`${MODAL_ROOT} [contenteditable="true"]`).first();
  let typed = false;
  if (editorOpen) {
    await editor.click();
    await page.keyboard.type(CAST_TEXT);
    await page.waitForTimeout(800);
    typed = await page.evaluate(
      (root) => (document.querySelector(root)?.innerText ?? '').includes('a cast typed by the probe'),
      MODAL_ROOT,
    );
  }

  await page.screenshot({ path: `${OUT}/cast-composer-open.png` });
  check(
    'the composer opens over the feed and takes typed text',
    editorOpen && typed,
    `clicked=${opened} editor=${editorOpen} placeholderSeen=${placeholderSeen} typed=${typed}`,
  );

  // The Cast control the composer itself submits with: read again *after*
  // typing, because before there is text it is disabled.
  const composer = await page.evaluate((root) => {
    const container = document.querySelector(root);
    return {
      text: (container?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
      buttons: Array.from(container?.querySelectorAll('button') ?? []).map(
        (button) => ({
          label: (button.innerText || '').trim(),
          disabled: button.disabled,
          y: button.getBoundingClientRect().top,
        }),
      ),
    };
  }, MODAL_ROOT);
  const submit = composer.buttons
    .filter((button) => button.label === 'Cast' && !button.disabled)
    .sort((a, b) => b.y - a.y)[0];
  check(
    'the cast button is ready to submit',
    Boolean(submit),
    JSON.stringify(composer.buttons),
  );

  // ── 3-8. press it, and watch ───────────────────────────────────────────────
  const adapterEntries = () =>
    page.evaluate(() => window.__nodeBackedRequests ?? []);

  if (submit) {
    await page.evaluate((y) => {
      const container = document.querySelector('#modal-root');
      const buttons = Array.from(
        container ? container.querySelectorAll('button') : [],
      );
      const target = buttons
        .filter((button) => (button.innerText || '').trim() === 'Cast')
        .sort(
          (a, b) =>
            b.getBoundingClientRect().top - a.getBoundingClientRect().top,
        )
        .find((button) => Math.abs(button.getBoundingClientRect().top - y) < 1);
      target?.click();
    }, submit.y);
  }

  const writes = [];
  let refusalOnScreen = '';
  let saidCreated = false;
  let composerTextAfter = '';
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(250);
    for (const entry of await adapterEntries()) {
      if (entry.method !== 'POST') {
        continue;
      }
      if (
        !writes.some(
          (seen) =>
            seen.path === entry.path &&
            seen.status === entry.status &&
            seen.bodyPreview === entry.bodyPreview,
        )
      ) {
        writes.push(entry);
      }
    }
    const onScreen = await page.evaluate((root) => ({
      body: (document.body?.innerText ?? '').replace(/\s+/g, ' '),
      modal: (document.querySelector(root)?.innerText ?? '').replace(
        /\s+/g,
        ' ',
      ),
    }), MODAL_ROOT);
    composerTextAfter = onScreen.modal;
    if (!refusalOnScreen) {
      // The toast is transient (react-hot-toast's own duration), so the words
      // are read while they are up rather than after they are gone.
      const at = onScreen.body.search(/The cast didn'?t post/);
      if (at >= 0) {
        refusalOnScreen = onScreen.body.slice(at, at + 400).trim();
      }
    }
    if (/created successfully/i.test(onScreen.body)) {
      saidCreated = true;
    }
    if (refusalOnScreen && writes.some((entry) => /\/v2\/casts$/.test(entry.path))) {
      break;
    }
  }

  await page.screenshot({ path: `${OUT}/cast-submit-refused.png` });

  const draftWrite = writes.find((entry) => /\/v2\/draft-caststorms$/.test(entry.path));
  const castWrite = writes.find((entry) => /\/v2\/casts$/.test(entry.path));

  check(
    'the pre-publish draft write is answered by the LOCAL route, not a 501',
    draftWrite?.kind === 'local' && draftWrite?.status === 200,
    draftWrite
      ? `${draftWrite.method} ${draftWrite.path} kind=${draftWrite.kind} status=${draftWrite.status}`
      : 'no draft write ever reached the adapter',
  );

  // The draft has to be *somewhere*: a 200 that stored nothing would be a lie.
  const deviceDrafts = await page.evaluate(
    ({ prefix, fid }) =>
      Object.keys(window.localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, value: window.localStorage.getItem(key) ?? '' }))
        .map((entry) => ({ ...entry, forThisAccount: entry.key.endsWith(`:${fid}`) })),
    { prefix: DRAFT_KEY_PREFIX, fid: SIGNED_IN_FID },
  );
  const thisAccountsDrafts = deviceDrafts.find((entry) => entry.forThisAccount);
  check(
    'the draft the composer saved is really on this device',
    Boolean(thisAccountsDrafts?.value.includes(CAST_TEXT)),
    deviceDrafts.length > 0
      ? `keys=${JSON.stringify(deviceDrafts.map((entry) => entry.key))} holdsText=${Boolean(
          thisAccountsDrafts?.value.includes(CAST_TEXT),
        )}`
      : `no ${DRAFT_KEY_PREFIX}:* key in this browser's storage`,
  );

  check(
    'the submit continues past the draft step and reaches POST /v2/casts',
    castWrite?.path === '/~api/v2/casts' || castWrite?.path === '/v2/casts',
    castWrite
      ? `${castWrite.method} ${castWrite.path} kind=${castWrite.kind} status=${castWrite.status} body=${(castWrite.bodyPreview ?? '').slice(0, 160)}`
      : `the submit never reached /v2/casts; writes seen: ${JSON.stringify(
          writes.map((entry) => `${entry.method} ${entry.path} ${entry.status}`),
        )}`,
  );

  check(
    'that endpoint refuses with the adapter’s own sentence (501), not silence',
    castWrite?.kind === 'hosted' && castWrite?.status === 501,
    castWrite
      ? `kind=${castWrite.kind} status=${castWrite.status}`
      : 'no entry for /v2/casts',
  );

  check(
    'the refusal is rendered to the person in plain words',
    /The cast didn'?t post\./.test(refusalOnScreen) &&
      /app key/i.test(refusalOnScreen),
    refusalOnScreen
      ? JSON.stringify(refusalOnScreen)
      : 'the words "The cast didn\'t post." were never on screen (the toast may have come and gone before it could be read)',
  );

  check(
    'the composer still holds what they typed, so nothing was lost',
    composerTextAfter.includes('a cast typed by the probe'),
    JSON.stringify(composerTextAfter.slice(0, 200)),
  );

  check(
    'no success UI for a write that failed',
    !saidCreated,
    saidCreated
      ? 'the page said "created successfully" while nothing was posted'
      : 'never said "created successfully"',
  );

  // The drafts list is the way back in: a failed cast leaves a real draft, and
  // the surface that offers it must not be a 501 either.
  const listEntry = (await adapterEntries()).find(
    (entry) => /\/v2\/draft-caststorms$/.test(entry.path) && entry.method === 'GET',
  );
  check(
    'the drafts list is answered from the device too (no 501 on the way back in)',
    listEntry === undefined || (listEntry.kind === 'local' && listEntry.status === 200),
    listEntry
      ? `GET ${listEntry.path} kind=${listEntry.kind} status=${listEntry.status}`
      : 'the drafts list was not requested in this run',
  );

  const leftThePage = await page.evaluate(() => window.__castFetchLog ?? []);
  check(
    'nothing was posted to Farcaster from this probe',
    !leftThePage.some(
      (line) => /farcaster\.xyz|api\.farcaster\.xyz/.test(line) && /POST/.test(line),
    ),
    leftThePage.filter((line) => line.includes('/v2/casts')).join(' | ') ||
      'no cast request left the page',
  );

  await ctx.request.dispose();
  await browser.close();

  console.log('── a cast, typed and pressed, with no hosted session ──');
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`,
    );
  }
  console.log('\n── every write the adapter answered, in order ──');
  for (const entry of writes) {
    console.log(
      `  ${entry.method} ${entry.path} kind=${entry.kind} status=${entry.status} body=${(entry.bodyPreview ?? '').slice(0, 120)}`,
    );
  }
  console.log('\n── requests that left the page ──');
  for (const line of leftThePage.slice(-15)) console.log(`  ${line}`);
  console.log(
    `\nconsole errors: ${consoleErrors.length}${consoleErrors.length ? ` (first: ${consoleErrors[0]})` : ''}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

try {
  await run();
} catch (error) {
  console.log(`\nPROBE threw before finishing: ${String(error).slice(0, 300)}`);
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`,
    );
  }
  process.exitCode = 1;
} finally {
  // A probe that throws must still let go of its browser. MEASURED 2026-10-21:
  // with the close on the success path only, a thrown read left a Chrome-less
  // node process alive for five hours and the shell that started it blocked for
  // the whole of it — the run that timed this card out died that way.
  await browser?.close().catch(() => {});
  console.log('probe done');
}