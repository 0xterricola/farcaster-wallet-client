// End-to-end check of Sign In With Farcaster in this client.
//
//   node scripts/verify-siwf-login.mjs
//
// Needs the dev server on https://localhost:5173 (pnpm start) and, for the
// "after the reload" half, the fork's mock API on :8080 — the same harness the
// shell verification used (see the dev escape hatch in src/constants/api.ts):
//
//   node <mock-api.cjs>
//
// Screenshots land in $SIWF_SHOT_DIR (default: the system temp dir).
//
// It exercises: the QR, the approval handshake, the signed-in state, the
// absence of the dead legacy sync-channel flow, and what the app looks like
// once the reload that follows a sign-in has run.
//
// Only the SIWF relay is stubbed, and it is stubbed with a REAL SIWE message
// signed by a throwaway key, so the app's own verifier has to genuinely accept
// it. Everything else is the app.
//
//   1. the QR renders and points at the SIWF relay URL, not the dead legacy link
//   2. approval lands a signed-in state that names the account and the fid
//   3. no legacy sync-channel traffic exists at all any more
//   4. no /v2/me probe with a local token, no sign-out
//   5a. with the fork's mock API (dev escape hatch): after the reload the authed
//       Fiddy shell is up
//   5b. with the real API (farcaster.xyz): still no ejection to the welcome —
//       the surfaces themselves error out, which is recorded, not hidden
//   6. the two surfaces that landing offers ("Add a brain", "Connect apps") are
//      reached by CLICKING them, and the screens that come up are those screens
//      — not the landing again. The landing claims they need no account; a
//      button that only changes the URL is the same dishonesty it exists to
//      remove, and reading the label cannot tell the two apart
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const OUT = process.env.SIWF_SHOT_DIR ?? os.tmpdir();
// Same override, same reason as the post-sign-in probe: the SIWE domain is
// derived from the origin under test, so the app's verifier sees a message
// that names the host it is actually running on.
const ORIGIN = process.env.SIWF_ORIGIN ?? 'https://localhost:5173';
const DOMAIN = new URL(ORIGIN).host;
const NONCE = 'c'.repeat(128);
const CHANNEL_TOKEN = 'TESTTOK1';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address, chainId: 10, domain: DOMAIN, nonce: NONCE,
  uri: `https://${DOMAIN}/login`, version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const run = async ({ label, mockApi }) => {
  const relay = [];
  const farcasterApi = [];
  const consoleErrors = [];
  let statusCalls = 0;

  const browser = await chromium.launch({
    channel: 'chrome', ignoreHTTPSErrors: true, args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  if (mockApi) {
    await ctx.addInitScript(() => { try { window.localStorage.setItem('farcasterApi.local', 'true'); } catch {} });
  }
  const page = await ctx.newPage();

  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('farcaster.xyz/~api')) farcasterApi.push(`${r.method()} ${new URL(u).pathname}`);
  });

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    relay.push(`${method} ${new URL(route.request().url()).pathname}`);
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    if (method === 'POST') {
      return route.fulfill({ status: 201, headers: CORS, body: JSON.stringify({
        channelToken: CHANNEL_TOKEN,
        url: `https://farcaster.xyz/~/siwf?channelToken=${CHANNEL_TOKEN}`,
        nonce: NONCE,
      }) });
    }
    statusCalls += 1;
    const pending = statusCalls <= 2;
    return route.fulfill({ status: pending ? 202 : 200, headers: CORS, body: JSON.stringify(pending
      ? { state: 'pending', nonce: NONCE }
      : { state: 'completed', nonce: NONCE, message, signature, fid: 4242, username: 'fiddy', displayName: 'Fiddy', bio: 'your agent, living in your pocket', pfpUrl: 'https://example.com/pfp.png' }) });
  });

  await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => (document.body?.innerText ?? '').trim().length > 60, { timeout: 60000 });

  for (const el of await page.$$('button, a, [role=button]')) {
    const txt = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(txt)) { await el.click(); break; }
  }

  await page.waitForFunction(() => /channelToken=/.test((document.body?.innerText ?? '')), { timeout: 30000 }).catch(() => {});
  // `page.innerText('body')` throws outright on a document whose body has not
  // been created yet — the instant the sign-in's own navigation passes through.
  // MEASURED shape (2026-10-21, the sibling composer probe): a bare read there
  // is `Cannot read properties of null (reading 'innerText')` and the whole run
  // dies with nothing printed. An empty string keeps the report honest: the
  // verdicts below are made on the text, and no text is no text.
  const bodyText = () =>
    page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const qrText = await bodyText();
  const svgCount = await page.$$eval('svg', (els) => els.length).catch(() => 0);
  await page.screenshot({ path: `${OUT}/login-qr-${label}.png` });

  const signedIn = await page
    .waitForFunction(() => /You're signed in/.test((document.body?.innerText ?? '')), { timeout: 30000 })
    .then(() => true).catch(() => false);
  const signedInText = await bodyText();
  await page.screenshot({ path: `${OUT}/login-signed-in-${label}.png` });

  await page.waitForTimeout(13000);
  const after = await page.evaluate(() => {
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const shell = new Set();
    document.querySelectorAll('[class]').forEach((el) => {
      String(el.className).split(/\s+/).forEach((c) => { if (/^fiddy-/.test(c)) shell.add(c); });
    });
    return {
      text,
      shellClasses: Array.from(shell).slice(0, 12),
      welcome: /Meet Fiddy|Go social/i.test(text),
      apiError: /Could not reach Farcaster|Error retrieving data/i.test(text),
    };
  });
  await page.screenshot({ path: `${OUT}/after-reload-${label}.png` });

  // Read what is on screen now, in the same terms the landing is judged by.
  const readSurface = () =>
    page.evaluate(() => ({
      url: window.location.pathname,
      landing: Boolean(
        document.querySelector('[data-fiddy="device-only-session"]'),
      ),
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    }));

  const clickByText = async (re) => {
    for (const el of await page.$$('a, button')) {
      const txt = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
      if (re.test(txt)) {
        await el.click();
        return txt;
      }
    }
    return null;
  };

  // Only meaningful where the landing is what came up: with the mock API the
  // session is real enough for the shell, and the buttons live on the agent
  // screen instead.
  let accountFreeSurfaces = null;
  if (!mockApi) {
    const errorsBefore = consoleErrors.length;
    const landedText = after.text;

    const brainsLabel = await clickByText(/^Add a brain/i);
    await page.waitForTimeout(2000);
    const brains = await readSurface();
    await page.screenshot({ path: `${OUT}/device-only-brains-${label}.png` });

    await page.goto(`${ORIGIN}/~/agent/apps`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForFunction(
      () => (document.body?.innerText ?? '').trim().length > 60,
      { timeout: 30000 },
    );
    await page.waitForTimeout(1500);
    const apps = await readSurface();
    await page.screenshot({ path: `${OUT}/device-only-apps-${label}.png` });

    accountFreeSurfaces = {
      landedOn: landedText,
      brains: {
        clicked: brainsLabel !== null,
        url: brains.url,
        // The screen itself, not just its label: the copy under the heading is
        // the sheet's own and the landing does not carry it.
        rendered:
          !brains.landing &&
          /Add a brain/.test(brains.text) &&
          /think with anything you already have/i.test(brains.text),
        landingAgain: brains.landing,
        text: brains.text,
      },
      apps: {
        url: apps.url,
        rendered:
          !apps.landing &&
          /Connect apps/.test(apps.text) &&
          /apps your agent is allowed to help with/i.test(apps.text),
        landingAgain: apps.landing,
        text: apps.text,
      },
      newConsoleErrors: consoleErrors.slice(errorsBefore),
      // Console noise from the app's other background calls is not the signal
      // here; an uncaught error is, because that is how a surface is lost.
      newUncaughtErrors: consoleErrors
        .slice(errorsBefore)
        .filter((e) => e.startsWith('pageerror:')),
    };
  }

  await browser.close();

  return {
    accountFreeSurfaces,
    qrRendered: svgCount > 0,
    qrPointsAtSiwf: /farcaster\.xyz\/~\/siwf\?channelToken=/.test(qrText),
    legacyLinkGone: !/farcaster\.xyz\/login-web\?channel-id=/.test(qrText),
    signedInStateRendered: signedIn,
    handleNamed: /@fiddy/.test(signedInText),
    fidShown: /fid 4242/.test(signedInText),
    relayPolledWithChannel: relay.filter((r) => r.startsWith('GET')).length >= 3,
    noSyncChannelTraffic: !farcasterApi.some((u) => u.includes('sync-channel')),
    noMeProbeWithLocalToken: !farcasterApi.some((u) => u.includes('/v2/me')),
    afterReload: {
      shellClasses: after.shellClasses.length,
      welcomeBack: after.welcome,
      apiErrorPage: after.apiError,
      text: after.text.slice(0, 160),
    },
  };
};

const withMock = await run({ label: 'mockapi', mockApi: true });
console.log('--- with the fork mock API ---');
console.log(JSON.stringify(withMock, null, 1));

const realApi = await run({ label: 'realapi', mockApi: false });
console.log('--- with the real farcaster.xyz API ---');
console.log(JSON.stringify(realApi, null, 1));

// The card's own conditions, as pass/fail rather than prose, so this script can
// be the gate it is meant to be instead of something a reader has to grade.
const checks = {
  'qr renders': realApi.qrRendered && withMock.qrRendered,
  'qr points at the SIWF relay': realApi.qrPointsAtSiwf && withMock.qrPointsAtSiwf,
  'the dead legacy link is gone': realApi.legacyLinkGone && withMock.legacyLinkGone,
  'sign-in names the account and the fid': realApi.signedInStateRendered &&
    realApi.handleNamed && realApi.fidShown && withMock.handleNamed && withMock.fidShown,
  'no sync-channel traffic': realApi.noSyncChannelTraffic && withMock.noSyncChannelTraffic,
  'no /v2/me probe with a device-only token': realApi.noMeProbeWithLocalToken && withMock.noMeProbeWithLocalToken,
  'the reload never lands on the bare error page or the welcome':
    (!realApi.afterReload.apiErrorPage && !realApi.afterReload.welcomeBack) &&
    (!withMock.afterReload.apiErrorPage && !withMock.afterReload.welcomeBack),
  'the mock API still gets the full shell': withMock.afterReload.shellClasses >= 10,
  'the landing\'s own two buttons reach their screens':
    realApi.accountFreeSurfaces.brains.clicked &&
    realApi.accountFreeSurfaces.brains.rendered &&
    realApi.accountFreeSurfaces.apps.rendered,
  'reaching them adds no page errors':
    realApi.accountFreeSurfaces.newUncaughtErrors.length === 0,
};

console.log('--- checks ---');
let failed = 0;
for (const [name, passed] of Object.entries(checks)) {
  if (!passed) failed += 1;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`PROBE_EXIT=${failed === 0 ? 0 : 1} (${failed} failed)`);
process.exitCode = failed === 0 ? 0 : 1;