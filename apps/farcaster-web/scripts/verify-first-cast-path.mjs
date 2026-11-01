// "I can't cast, and it tells me to go and find an app key" — the reader's path
// on a copy of Fiddy somebody runs themselves, measured in a browser.
//
//   cd apps/farcaster-web
//   SNAPCHAIN_HTTP_URL=https://<a public read node> \
//   VITE_SNAPCHAIN_HTTP_URL=https://<the same> \
//   npx vite --config scripts/probe.vite.config.mjs --port <port> --strictPort
//
//   FIRST_CAST_SERVER=https://localhost:<port> node scripts/verify-first-cast-path.mjs
//
// WHAT THIS IS FOR
//
// `fiddy client up` serves the client from the reader's own machine, so the
// origin is the reader's own address and `/api/fiddy/connect` (the one-tap
// approval's service, which lives on fiddy.fun) is NOT there. Measured
// 2026-10-23: pressing Cast on such a copy opened the approval sheet, whose
// request answered 404, so the sheet said "we couldn't reach the part of Fiddy
// that sets this up" and offered Try again / Close. Closing it left the
// composer with the write seam's own sentence — "Open Advanced → your setup and
// press "Issue app key" once" — while the control the sentence names sat behind
// a closed "developers only" disclosure on that page, and the posting-key card
// above it said "you can keep reading here and post in your Farcaster app as
// usual". A reader on that box therefore had no route to posting that the app
// named, and reported it as "the settings page isn't loading".
//
// So this probe asserts the two halves of the acceptance, at both widths:
//
//   A. pressing Cast with no posting key asks for the approval — the sheet, not
//      a sentence sending the reader off to find a key;
//   B. when nothing answers at this address, the sheet itself carries the slow
//      path (one press), that press lands on the page where the app key lives,
//      and the control is visible there rather than hidden.
//
// It also records what the three settings surfaces render, because the same
// report said the settings page did not load at all.
//
// Only the SIWF relay is stubbed (a REAL SIWE message signed by a throwaway key,
// exactly as scripts/verify-cast-submit.mjs does). Nothing here posts to
// Farcaster: the probe never reaches a submit, and asserts that no write left
// the page. Screenshots land in $FIRST_CAST_SHOT_DIR (default the system temp
// dir, never a directory inside the repo).

import os from 'node:os';

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.FIRST_CAST_SERVER ?? 'https://localhost:5231';
const OUT = process.env.FIRST_CAST_SHOT_DIR ?? os.tmpdir();
const DOMAIN = new URL(SERVER).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'FIRSTCAST';
const SIGNED_IN_FID = 3;
const MODAL_ROOT = '#modal-root';
const CAST_TEXT = 'a cast typed by the probe, never sent';

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

/** A read of the page that survives a navigation mid-read. */
const safe = async (page, fn, arg) => {
  let lastError;
  for (let i = 0; i < 20; i += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      lastError = error;
      if (
        !/Execution context was destroyed|Cannot find context|Target closed|navigating/i.test(
          String(error),
        )
      ) {
        throw error;
      }
      await page.waitForTimeout(250);
    }
  }
  throw lastError;
};

const surface = (page) =>
  safe(page, (root) => {
    const gate = document.querySelector('[data-fiddy="signer-approval-gate"]');
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
    const modal = document.querySelector(root);
    const appKeyDisclosure = document.querySelector(
      '[data-fiddy="advanced-app-key"]',
    );
    return {
      path: window.location.pathname,
      title: document.title,
      gate: Boolean(gate),
      gateText: (gate?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400),
      gateActions: Array.from(gate?.querySelectorAll('button') ?? []).map((b) =>
        (b.innerText || '').trim(),
      ),
      ownSetupAction: Boolean(
        document.querySelector('[data-fiddy="connect-own-setup"]'),
      ),
      approvalLink: Boolean(
        document.querySelector('[data-fiddy="connect-approval-link"]'),
      ),
      qr: Boolean(document.querySelector('[data-fiddy="connect-qr"]')),
      modalText: (modal?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300),
      // The write seam's own sentence, the one the reader quoted back.
      noKeySentence:
        (text.match(/This device has no key[^”"]*“(?:Issue app key)”[^.]*\./) ??
          [])[0] ?? (text.match(/This device has no key/g) ? 'present' : ''),
      appKeyDisclosure: Boolean(appKeyDisclosure),
      appKeyDisclosureOpen: appKeyDisclosure?.hasAttribute('open') ?? false,
      appKeyControl: Boolean(
        document.querySelector(
          '[data-fiddy="advanced-app-key"] button, [data-fiddy="posting-key-card"]',
        ),
      ),
      postingKeyCard: Boolean(
        document.querySelector('[data-fiddy="posting-key-card"]'),
      ),
      postingKeyOwnAppKey: Boolean(
        document.querySelector('[data-fiddy="posting-key-use-own-app-key"]'),
      ),
      errorBoundary: /something went wrong|unexpected error occurred/i.test(
        text,
      ),
      text,
    };
  });

const openComposer = async (page) => {
  for (let i = 0; i < 30; i += 1) {
    for (const button of await page
      .locator('button:has-text("Cast"):visible')
      .all()) {
      if (((await button.innerText()) || '').trim() === 'Cast') {
        await button.click();
        try {
          await page.waitForSelector(`${MODAL_ROOT} [contenteditable="true"]`, {
            timeout: 8000,
          });
          return true;
        } catch {
          break;
        }
      }
    }
    await page.waitForTimeout(1000);
  }
  // The shell also opens the composer on `n`.
  await page.keyboard.press('n');
  try {
    await page.waitForSelector(`${MODAL_ROOT} [contenteditable="true"]`, {
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
};

const whereAmI = (page) =>
  safe(page, () => ({
    path: window.location.pathname,
    title: document.title,
  }));

let browser;

const runWidth = async (width, height) => {
  const consoleErrors = [];
  const pageErrors = [];
  const connectAnswers = [];
  const writes = [];

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height },
  });
  const page = await context.newPage();

  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 200));
    }
  });
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 240)));
  page.on('request', (request) => {
    if (/\/v1\/(submitMessage|validateMessage)/.test(request.url())) {
      writes.push(`${request.method()} ${request.url().slice(0, 100)}`);
    }
  });
  page.on('response', (response) => {
    if (/\/api\/fiddy\/connect/.test(response.url())) {
      connectAnswers.push(
        `${response.request().method()} ${response.url().slice(0, 80)} ${response.status()}`,
      );
    }
  });

  // The sign-in: a real SIWE message, a stubbed relay.
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
    timeout: 60_000,
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
        /go social/i.test(el.innerText || ''),
      ),
    { timeout: 120_000 },
  );
  let clicked = false;
  for (const el of await page.$$('button, a, [role=button]')) {
    const label = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(label)) {
      await el.click();
      clicked = true;
      break;
    }
  }
  let signedIn = false;
  for (let i = 0; i < 45; i += 1) {
    await page.waitForTimeout(1000);
    const state = await safe(page, () => ({
      path: window.location.pathname,
      shell: Boolean(document.querySelector('.fiddy-shell-frame')),
    }));
    if (state.path === '/' && state.shell) {
      signedIn = true;
      break;
    }
  }
  check(
    `${width}: a completed sign-in lands in the client shell`,
    signedIn,
    `clickedGoSocial=${clicked}`,
  );
  if (!signedIn) {
    await context.close();
    return;
  }

  // ── the press ───────────────────────────────────────────────────────────
  const composerOpened = await openComposer(page);
  if (!composerOpened) {
    const where = await whereAmI(page);
    check(
      `${width}: the composer opens for a signed-in reader`,
      false,
      `no composer at ${where.path} (${where.title})`,
    );
    await context.close();
    return;
  }
  check(`${width}: the composer opens for a signed-in reader`, true, '');
  await page.locator(`${MODAL_ROOT} [contenteditable="true"]`).first().click();
  await page.keyboard.type(CAST_TEXT);
  await page.waitForTimeout(900);

  const submitTop = await page.evaluate((root) => {
    const buttons = Array.from(
      document.querySelectorAll(`${root} button`),
    ).filter((b) => (b.innerText || '').trim() === 'Cast' && !b.disabled);
    return buttons.length
      ? Math.max(...buttons.map((b) => b.getBoundingClientRect().top))
      : null;
  }, MODAL_ROOT);
  if (submitTop !== null) {
    await page.evaluate(
      ({ root, top }) => {
        const buttons = Array.from(
          document.querySelectorAll(`${root} button`),
        ).filter((b) => (b.innerText || '').trim() === 'Cast');
        buttons
          .find((b) => Math.abs(b.getBoundingClientRect().top - top) < 1)
          ?.click();
      },
      { root: MODAL_ROOT, top: submitTop },
    );
  }

  // The sheet is what answers the press. Give it the four seconds the approval
  // call and its own screen need.
  let pressed = await surface(page);
  for (let i = 0; i < 20 && !pressed.gate; i += 1) {
    await page.waitForTimeout(500);
    pressed = await surface(page);
  }
  await page.screenshot({ path: `${OUT}/first-cast-${width}-1-pressed.png` });

  check(
    `${width}: pressing Cast with no posting key opens the approval sheet`,
    pressed.gate,
    `path=${pressed.path} gate=${pressed.gate} composer=${pressed.modalText.slice(0, 120)}`,
  );
  check(
    `${width}: the press does not answer with the "find an app key" sentence`,
    !/This device has no key/.test(pressed.text),
    `noKeyOnScreen=${/This device has no key/.test(pressed.text)}`,
  );
  check(
    `${width}: the sheet says what it is doing, in its own words`,
    pressed.approvalLink ||
      pressed.qr ||
      /couldn.t reach|did not go through/i.test(pressed.gateText),
    `gateText=${pressed.gateText.slice(0, 200)}`,
  );

  // Is there a USABLE approval service at this address? The whole point of the
  // fallback. Two answers both mean "not here": 404 (a client served as static
  // files, with no service at all) and the refusal a copy of Fiddy's own
  // service gives when it has no Farcaster account of its own to ask with
  // (`server/instance/connect.mjs`, `CONNECT_UNAVAILABLE`, 501 — card
  // t_745ed5be). Both are the self-hosted case, and both must offer the reader
  // the way forward this probe asserts.
  const serviceAbsent = connectAnswers.some((line) =>
    / (404|501)$/.test(line),
  );
  check(
    `${width}: this origin serves no usable approval service (the self-hosted case)`,
    serviceAbsent,
    connectAnswers.join(' | ') || 'no /api/fiddy/connect call was made',
  );

  if (serviceAbsent) {
    check(
      `${width}: the failed sheet carries a one-press way to the reader's own setup`,
      pressed.ownSetupAction,
      `gateActions=${JSON.stringify(pressed.gateActions)}`,
    );

    // ── the press itself walks them there ─────────────────────────────────
    const took = await page.evaluate(() => {
      const action = document.querySelector('[data-fiddy="connect-own-setup"]');
      if (!action) return null;
      action.click();
      return true;
    });
    if (took) {
      await page
        .waitForFunction(
          () => window.location.pathname === '/~/settings/node',
          { timeout: 20_000 },
        )
        .catch(() => undefined);
      await page.waitForTimeout(6000);
    }
    const onSetup = await surface(page);
    await page.screenshot({
      path: `${OUT}/first-cast-${width}-2-own-setup.png`,
    });

    check(
      `${width}: that press lands on the page where the app key lives`,
      onSetup.path === '/~/settings/node' &&
        /Your own setup/.test(onSetup.text),
      `path=${onSetup.path} title=${onSetup.title}`,
    );
    check(
      `${width}: the app key control is visible there, not behind a closed disclosure`,
      onSetup.appKeyDisclosure && onSetup.appKeyDisclosureOpen,
      `disclosure=${onSetup.appKeyDisclosure} open=${onSetup.appKeyDisclosureOpen}`,
    );
    check(
      `${width}: the posting-key card offers the same way while the service is away`,
      onSetup.postingKeyOwnAppKey,
      `card=${onSetup.postingKeyCard} offer=${onSetup.postingKeyOwnAppKey}`,
    );
    check(
      `${width}: the page that would not load renders its own controls`,
      onSetup.errorBoundary === false &&
        /Where Fiddy reads from/.test(onSetup.text) &&
        onSetup.title.startsWith('Your own setup'),
      `title=${onSetup.title} boundary=${onSetup.errorBoundary}`,
    );
  }

  // ── the composer's own refusal, after the sheet is dismissed ────────────
  // This is the sentence the tester quoted back ("it says I should go to
  // settings in order to issue the app key"). It has to name the place the
  // failed sheet just walked them to, in the app's own words.
  if (serviceAbsent) {
    await page.goto(`${SERVER}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(6000);
    const reopened = await openComposer(page);
    if (!reopened) {
      check(
        `${width}: the composer reopens after the sheet is dismissed`,
        false,
        '',
      );
      await context.close();
      return;
    }
    await page
      .locator(`${MODAL_ROOT} [contenteditable="true"]`)
      .first()
      .click();
    await page.keyboard.type(CAST_TEXT);
    await page.waitForTimeout(900);
    const againTop = await page.evaluate((root) => {
      const buttons = Array.from(
        document.querySelectorAll(`${root} button`),
      ).filter((b) => (b.innerText || '').trim() === 'Cast' && !b.disabled);
      return buttons.length
        ? Math.max(...buttons.map((b) => b.getBoundingClientRect().top))
        : null;
    }, MODAL_ROOT);
    if (againTop !== null) {
      await page.evaluate(
        ({ root, top }) => {
          const buttons = Array.from(
            document.querySelectorAll(`${root} button`),
          ).filter((b) => (b.innerText || '').trim() === 'Cast');
          buttons
            .find((b) => Math.abs(b.getBoundingClientRect().top - top) < 1)
            ?.click();
        },
        { root: MODAL_ROOT, top: againTop },
      );
    }
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      const gate = document.querySelector(
        '[data-fiddy="signer-approval-gate"]',
      );
      const quiet = Array.from(gate?.querySelectorAll('button') ?? []).find(
        (b) => /^close$/i.test((b.innerText || '').trim()),
      );
      quiet?.click();
    });
    // The toast is transient: read it while it is up.
    let refusal = '';
    for (let i = 0; i < 20 && refusal === ''; i += 1) {
      await page.waitForTimeout(500);
      const text = await page.evaluate(() =>
        (document.body?.innerText ?? '').replace(/\s+/g, ' '),
      );
      const at = text.search(/The cast didn.t post/);
      if (at >= 0) {
        refusal = text.slice(at, at + 400);
      }
    }
    await page.screenshot({ path: `${OUT}/first-cast-${width}-3-refused.png` });
    check(
      `${width}: the refusal names "Your own setup", where the app key lives`,
      /Your own setup/.test(refusal) && /Issue app key/.test(refusal),
      refusal.slice(0, 220) || 'no refusal was rendered',
    );
    check(
      `${width}: the cast the reader typed is still in the composer`,
      /a cast typed by the probe, never sent/.test(
        await page.evaluate(
          (root) =>
            (document.querySelector(root)?.innerText ?? '').replace(
              /\s+/g,
              ' ',
            ),
          MODAL_ROOT,
        ),
      ),
      'text preserved after a refused write',
    );
  }

  // ── the other settings surfaces ─────────────────────────────────────────
  const surfaces = {};
  for (const path of [
    '/~/settings',
    '/~/settings/node',
    '/~/settings/advanced',
  ]) {
    await page.goto(`${SERVER}${path}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(5000);
    surfaces[path] = await surface(page);
  }
  const everySurfaceLoads = Object.entries(surfaces).every(
    ([, s]) => s.errorBoundary === false && s.text.length > 200,
  );
  check(
    `${width}: /~/settings, /~/settings/node and /~/settings/advanced all load`,
    everySurfaceLoads,
    Object.entries(surfaces)
      .map(([p, s]) => `${p} title="${s.title}" boundary=${s.errorBoundary}`)
      .join(' | '),
  );

  check(
    `${width}: nothing was posted to Farcaster by this run`,
    writes.length === 0,
    writes.join(' | ') || 'no submitMessage left the page',
  );
  // The provider seam logs its own HANDLED refusals through the error channel
  // (`HandledFetchError: … 501`), deliberately and with a sentence beside it.
  // They are not uncaught errors — the app was told and answered. Count them
  // apart rather than letting them fail this run (see the probe notes in the
  // skill: this is expected noise on a local probe of the authed shell).
  const handled = pageErrors.filter((e) => /HandledFetchError/.test(e));
  const uncaught = pageErrors.filter((e) => !/HandledFetchError/.test(e));
  check(
    `${width}: no uncaught page error anywhere in the run`,
    uncaught.length === 0,
    uncaught.join(' | ') ||
      `${handled.length} handled refusal${handled.length === 1 ? '' : 's'} from the adapter (expected)`,
  );

  if (consoleErrors.length > 0) {
    console.log(
      `  ${width}: console errors seen (${consoleErrors.length}):`,
      consoleErrors.slice(-3).join(' | '),
    );
  }

  await context.close();
};

browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});

try {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    try {
      await runWidth(width, height);
    } catch (error) {
      // A timeout is a fact about the run, not a reason to lose the other
      // width's evidence.
      check(`${width}: the run completes`, false, String(error).slice(0, 220));
    }
  }
} finally {
  await browser.close();
}

const passed = checks.filter((c) => c.ok).length;
for (const c of checks) {
  console.log(
    `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`,
  );
}
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
