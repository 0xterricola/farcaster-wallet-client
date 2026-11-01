// End-to-end check of the two ways in that do not involve scanning a code.
//
//   HTTPS=true npx vite --port 5179
//   PROBE_SERVER=https://localhost:5179 node scripts/verify-miniapp-autologin.mjs
//
// This measures, in a real browser, the two things this card shipped:
//
//   A. ON A PHONE (iPhone UA, 390x844): the sign-in modal leads with one tap
//      into the Farcaster app, pointing at the exact URL the QR would carry,
//      and the code is NOT on screen — because a phone cannot scan the code its
//      own screen is showing. The code is one tap away behind the disclosed
//      toggle, for the person who wants to sign in on another device.
//
//   B. INSIDE A FARCASTER CLIENT (a Mini App): the app signs itself in from the
//      host's own context, with no modal, no code and nothing typed. The host
//      in part B is REAL host code — this repo's own `@farcaster/miniapp-host`
//      package (`scripts/probe-miniapp-host.ts`), the same one the client uses
//      to run other people's Mini Apps — exposing a fake user to the real
//      app-side SDK (`@farcaster/miniapp-sdk`) across comlink, and signing a
//      real SIWE message with a throwaway key so the app's own verifier has to
//      accept it. Only the person is fake.
//
// Everything it records is printed; the assertions are the checks at the end.
// Nothing here writes to the network: the SIWF relay is the only stub in part
// A, and part B does not talk to the relay at all.
//
// Screenshots land in $PROBE_SHOT_DIR (default: a temp directory).

import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';

const SERVER = process.env.PROBE_SERVER ?? 'https://localhost:5179';
const OUT = process.env.PROBE_SHOT_DIR ?? path.join(os.tmpdir(), 'miniapp-autologin');
const CHANNEL_TOKEN = process.env.PROBE_CHANNEL_TOKEN ?? 'PROBE001';
const RELAY_URL = `https://farcaster.xyz/~/siwf?channelToken=${CHANNEL_TOKEN}`;
const HOST_FID = Number(process.env.PROBE_HOST_FID ?? 191554);
const HOST_USERNAME = process.env.PROBE_HOST_USERNAME ?? 'probe-host';

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const browser = await chromium.launch({
  channel: 'chrome',
  ignoreHTTPSErrors: true,
  args: ['--ignore-certificate-errors'],
});

// ---------------------------------------------------------------------------
// A. On a phone.
// ---------------------------------------------------------------------------
console.log('\nA. logo in on a phone (390x844, iPhone Safari)');

const phoneContext = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },
  userAgent: IPHONE_UA,
  hasTouch: true,
  isMobile: true,
});
const phone = await phoneContext.newPage();

const relayCalls = [];
await phone.route('https://relay.farcaster.xyz/**', async (route) => {
  const method = route.request().method();
  relayCalls.push(`${method} ${new URL(route.request().url()).pathname}`);

  if (method === 'OPTIONS') {
    return route.fulfill({ status: 204, headers: CORS, body: '' });
  }

  if (method === 'POST') {
    return route.fulfill({
      status: 201,
      headers: CORS,
      body: JSON.stringify({
        channelToken: CHANNEL_TOKEN,
        url: RELAY_URL,
        nonce: 'e'.repeat(128),
      }),
    });
  }

  // Nobody ever approves this code, so the modal stays exactly where a phone
  // visitor would see it.
  return route.fulfill({
    status: 202,
    headers: CORS,
    body: JSON.stringify({ state: 'pending', nonce: 'e'.repeat(128) }),
  });
});

// MEASURED (2026-10-22, load average ~45 on 10 cores, dozens of sibling dev
// servers on this machine): a cold dev-server route compiles on first visit, and
// a 30s wait reported an empty body for a landing that was merely still
// compiling. The budgets are generous on purpose and env-settable, so a busier
// machine can say so rather than report a client that never painted.
const BOOT_BUDGET_MS = Number(process.env.PROBE_BOOT_BUDGET_MS ?? 180_000);

await phone.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
await phone.setDefaultTimeout(BOOT_BUDGET_MS);
await phone.waitForFunction(
  () => (document.body?.innerText ?? '').trim().length > 60,
  { timeout: BOOT_BUDGET_MS },
  );

const clickByText = async (page, pattern) => {
  for (const element of await page.$$('button, a, [role=button]')) {
    const text = ((await element.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (pattern.test(text)) {
      await element.click();
      return text;
    }
  }
  return null;
};

const door = await clickByText(phone, /go social|sign in|log in/i);
await phone
  .waitForSelector('[data-fiddy="open-in-farcaster"]', { timeout: 60_000 })
  .catch(() => {});

const phoneState = await phone.evaluate(() => {
  const anchor = document.querySelector('[data-fiddy="open-in-farcaster"]');
  const toggle = document.querySelector('[data-fiddy="show-qr-code"]');
  const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();

  return {
    href: anchor?.getAttribute('href') ?? null,
    label: (anchor?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    toggleLabel: (toggle?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    canvases: document.querySelectorAll('canvas').length,
    bodyText: bodyText.slice(0, 400),
  };
});

console.log(`  door clicked: ${JSON.stringify(door)}`);
console.log(`  button: ${JSON.stringify(phoneState.label)} -> ${phoneState.href}`);
console.log(`  toggle: ${JSON.stringify(phoneState.toggleLabel)}`);
console.log(`  canvases on screen: ${phoneState.canvases}`);
console.log(`  text: ${phoneState.bodyText.slice(0, 240)}`);

await phone.screenshot({ path: `${OUT}/phone-login-door.png` });

const canvasesBeforeToggle = phoneState.canvases;
await phone.click('[data-fiddy="show-qr-code"]').catch(() => {});
await phone.waitForTimeout(1_500);

const afterToggle = await phone.evaluate(() => ({
  canvases: document.querySelectorAll('canvas').length,
  toggleStillThere: Boolean(
    document.querySelector('[data-fiddy="show-qr-code"]'),
  ),
  bodyText: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim(),
}));

console.log(
  `  after the toggle: canvases=${afterToggle.canvases} toggle still there=${afterToggle.toggleStillThere}`,
);

await phone.screenshot({ path: `${OUT}/phone-login-door-qr-disclosed.png` });

check(
  'A1 the modal opened on a phone',
  Boolean(phoneState.href),
  `door=${JSON.stringify(door)}`,
);
check(
  'A2 the primary button opens the Farcaster app at the very URL the QR encodes',
  phoneState.href === RELAY_URL,
  `href=${phoneState.href}`,
);
check(
  'A3 it says what it is, on the device it is for',
  /Open in Farcaster on this phone/i.test(phoneState.label),
  `label=${JSON.stringify(phoneState.label)}`,
);
check(
  'A4 no QR code is on screen for a phone to fail to scan',
  canvasesBeforeToggle === 0 && afterToggle.canvases > 0,
  `canvases before=${canvasesBeforeToggle} after=${afterToggle.canvases}`,
);
check(
  'A5 the code is still reachable, behind the disclosed toggle',
  phoneState.toggleLabel === 'Show QR code for another device' &&
    !afterToggle.toggleStillThere,
);
check(
  'A6 the relay channel behind it is the real one, created once',
  relayCalls.filter((call) => call.startsWith('POST')).length === 1,
  relayCalls.join(', '),
);

// ---------------------------------------------------------------------------
// B. Inside a Farcaster client (a Mini App).
// ---------------------------------------------------------------------------
console.log('\nB. opened inside a Mini App host (real host SDK, real app SDK)');

const hostContext = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1000, height: 900 },
  userAgent: DESKTOP_UA,
});
const hostPage = await hostContext.newPage();

const hostConsoleErrors = [];
hostPage.on('console', (message) => {
  if (message.type() === 'error') {
    hostConsoleErrors.push(message.text().slice(0, 200));
  }
});
hostPage.on('pageerror', (error) =>
  hostConsoleErrors.push(`pageerror: ${String(error).slice(0, 200)}`),
);

const hostUrl = new URL('/scripts/probe-miniapp-host.html', SERVER);
hostUrl.searchParams.set('fid', String(HOST_FID));
hostUrl.searchParams.set('username', HOST_USERNAME);

await hostPage.goto(hostUrl.href, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});

/** The host's own call log, as `probe-miniapp-host.ts` recorded it. */
const hostCalls = async () =>
  await hostPage.evaluate(() => window.__hostCalls ?? []);

/** What the hosted app is showing, read through the same-origin frame. */
const hostedApp = async () =>
  await hostPage.evaluate(() => {
    const frame = document.querySelector('[data-fiddy="hosted-app"]');
    const doc = frame?.contentDocument;
    if (!doc) {
      return { readable: false };
    }

    const text = (doc.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const shell = new Set();
    doc.querySelectorAll('[class]').forEach((element) => {
      String(element.className)
        .split(/\s+/)
        .forEach((name) => {
          if (/^fiddy-/.test(name)) {
            shell.add(name);
          }
        });
    });

    return {
      readable: true,
      url: doc.location.pathname,
      text: text.slice(0, 400),
      shellClasses: Array.from(shell).slice(0, 12),
      signInDoor: Boolean(doc.querySelector('[data-fiddy="open-in-farcaster"]')),
      autoSignInOverlay: Boolean(
        doc.querySelector('[data-fiddy="miniapp-auto-sign-in"]'),
      ),
      refusedNotice: Boolean(
        doc.querySelector('[data-fiddy="miniapp-auto-sign-in-refused"]'),
      ),
      attemptMarker:
        frame?.contentWindow?.sessionStorage?.getItem(
          'fiddy.miniapp.auto-sign-in',
        ) ?? null,
      landing: /Meet Fiddy|Go social/i.test(text),
    };
  });

// The app booting inside the frame makes its own calls; `ready` and `signIn`
// are the two this flow exists to make.
let calls = [];
let sawReady = false;
let sawSignIn = false;
const deadline = Date.now() + Number(process.env.PROBE_AUTOLOGIN_BUDGET_MS ?? 180_000);
let surface = { readable: false };

while (Date.now() < deadline) {
  calls = await hostCalls();
  sawReady = calls.some((call) => call === 'ready');
  sawSignIn = calls.some((call) => call.startsWith('signIn '));

  if (sawReady && sawSignIn) {
    surface = await hostedApp();

    // The sign-in ends in a reload of the hosted app, so wait for it to come
    // back and read what it came back as.
    if (surface.readable && !surface.landing && !surface.autoSignInOverlay) {
      break;
    }
  }

  await hostPage.waitForTimeout(2_000);
}

// Give the post-sign-in reload the moment it needs, then read the settled
// surface: the thing the person actually ends up looking at.
await hostPage.waitForTimeout(12_000);
surface = await hostedApp();
calls = await hostCalls();

console.log(`  host calls: ${JSON.stringify(calls)}`);
console.log(`  hosted app: ${JSON.stringify(surface)}`);
console.log(
  `  host console errors: ${hostConsoleErrors.length ? JSON.stringify(hostConsoleErrors) : 'none'}`,
);

await hostPage.screenshot({ path: `${OUT}/miniapp-host-autologin.png` });

check('B1 the hosted app told the host it is ready', sawReady, calls.join(', '));
check(
  'B2 the app asked the host to sign in, with a nonce of its own',
  calls.some((call) => /^signIn nonce=[0-9a-f]{64}$/.test(call)),
  calls.find((call) => call.startsWith('signIn ')) ?? 'no signIn call',
);
check(
  'B3 the app came back up inside the host, signed in — not on the landing',
  surface.readable && surface.landing === false,
  `landing=${surface.landing} text=${String(surface.text).slice(0, 160)}`,
);
check(
  'B4 no sign-in door and no code was shown inside the host',
  !surface.signInDoor && surface.autoSignInOverlay === false,
  `door=${surface.signInDoor} overlay=${surface.autoSignInOverlay}`,
);
check(
  'B5 the host refused nothing, so nothing was left half-signed-in',
  surface.refusedNotice === false,
);
check(
  'B6 one attempt only, marked for this tab session',
  surface.attemptMarker === 'true',
  `marker=${surface.attemptMarker}`,
);

await hostContext.close();
await phoneContext.close();
await browser.close();

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
console.log(`screenshots: ${OUT}`);

if (failed.length) {
  console.log('\nFAILED:');
  for (const entry of failed) {
    console.log(`  - ${entry.name}: ${entry.detail}`);
  }
  process.exit(1);
}