// End-to-end check that a completed sign-in reaches the client.
//
//   node scripts/verify-post-signin-landing.mjs
//
// Needs the dev server on https://localhost:5173 (pnpm start) and, for the
// mock half, the fork's mock API on :8080 — the same harness the shell and
// sign-in probes use (see the dev escape hatch in src/constants/api.ts):
//
//   node <mock-api.cjs>
//
// Screenshots land in $POST_SIGNIN_SHOT_DIR (default: the system temp dir).
//
// WHAT IT REPRODUCES
// The user-reported bounce: walking the setup flow to its last screen, pressing
// "Go social — sign in with Farcaster", completing the handshake, and then
// being shown "Fiddy is ready." again instead of the client — before and after
// a reload. Only the SIWF relay is stubbed, and it is stubbed with a REAL SIWE
// message signed by a throwaway key, so the app's own verifier has to accept
// it. Everything else is the app.
//
// WHAT IT ASSERTS
//   1. the setup flow's last screen is what comes up at /welcome/ready signed
//      out ("Fiddy is ready."), so the flow the user walked is really the one
//      being driven
//   2. the handshake completes and names the account on the sign-in screen
//   3. once the post-sign-in reload has run, the browser is in the CLIENT —
//      never back on a setup screen:
//        - mock API: the home feed shell, with the signed-in account's avatar
//          and Profile link
//        - real API: the deliberate device-only landing naming the account
//          (this client cannot mint a farcaster.xyz token without a backend
//          exchange; see ~/lib/siwfSession). Needing a landing is honest and
//          is not this probe's business — bouncing back to the setup is
//   4. a second reload keeps the session: same client surface, still not the
//      setup screen
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const OUT = process.env.POST_SIGNIN_SHOT_DIR ?? os.tmpdir();
// The client under test. The default is the dev server the other probes use;
// the override exists so this can be pointed at a server that carries a
// particular revision (a worktree, a second port) instead of whichever client
// happens to be running on 5173. The SIWE domain follows the origin, because
// that is what the app's own verifier compares the message against.
const ORIGIN = process.env.POST_SIGNIN_ORIGIN ?? 'https://localhost:5173';
const READY_URL = `${ORIGIN}/welcome/ready`;
const DOMAIN = new URL(ORIGIN).host;
const NONCE = 'c'.repeat(128);
const CHANNEL_TOKEN = 'TESTTOK1';

const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: account.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `https://${DOMAIN}/login`,
  version: '1',
});
const signature = await account.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const readSurface = (page) =>
  page.evaluate(() => {
    // A read can land on a document the sign-in's own navigation is replacing,
    // and that document has no body yet. Guarded so a read in that instant is an
    // empty surface the caller polls again, not a dead run. MEASURED 2026-10-21
    // on the sibling probe: unguarded it threw `Cannot read properties of null
    // (reading 'innerText')` and the whole run printed nothing.
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const accountEl = document.querySelector(
      '[data-fiddy="device-only-account"]',
    );

    return {
      path: window.location.pathname,
      text: text.slice(0, 200),
      onboardingSheet: Boolean(
        document.querySelector('[data-fiddy="onboarding"]'),
      ),
      onboardingReady: /is ready\./.test(text) && /Go social/i.test(text),
      deviceOnlyLanding: Boolean(
        document.querySelector('[data-fiddy="device-only-session"]'),
      ),
      deviceOnlyAccount: accountEl ? accountEl.textContent : null,
      feedish: /Home|Following|For you|Trending|Feed/i.test(text),
      apiError: /Could not reach Farcaster|Error retrieving data/i.test(text),
      // "your profile is visible", in the two places the shell puts it: the
      // avatar (alt = display name or handle) and the Profile link, which
      // points at the signed-in account's own path.
      avatarAlts: Array.from(document.querySelectorAll('img[alt]'))
        .map((img) => img.getAttribute('alt'))
        .slice(0, 6),
      profileHref: (() => {
        for (const link of document.querySelectorAll('a[href]')) {
          if (/^Profile$/.test((link.textContent || '').trim())) {
            return link.getAttribute('href');
          }
        }
        return null;
      })(),
    };
  });

/**
 * Read the surface, tolerating a page that is mid-navigation.
 *
 * MEASURED 2026-10-21: `page.evaluate` also throws `Execution context was
 * destroyed, most likely because of a navigation` — the sign-in IS a navigation,
 * and this probe's first post-click read lands inside it. A destroyed context is
 * "read again in a moment"; anything else still throws, so a real failure is
 * never hidden behind a retry.
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

/** Where the browser ended up, in the terms the bug is about. */
const verdict = (surface) => ({
  stillOnSetup: surface.onboardingReady || surface.onboardingSheet,
  inClient:
    !surface.onboardingSheet &&
    (surface.feedish || surface.deviceOnlyLanding) &&
    surface.path === '/',
  where: surface.deviceOnlyLanding
    ? `the device-only landing (${surface.deviceOnlyAccount})`
    : surface.feedish
      ? 'the client feed'
      : surface.onboardingSheet
        ? 'the setup screen'
        : 'neither — nothing is on screen',
  apiErrorPage: surface.apiError,
  avatarAlts: surface.avatarAlts,
  profileHref: surface.profileHref,
});

const run = async ({ label, mockApi }) => {
  const events = [];
  const relay = [];
  let statusCalls = 0;

  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  if (mockApi) {
    await ctx.addInitScript(() => {
      try {
        window.localStorage.setItem('farcasterApi.local', 'true');
      } catch {}
    });
  }
  const page = await ctx.newPage();

  page.on('console', (m) => {
    if (m.type() === 'error') events.push(`console.error: ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) => events.push(`pageerror: ${String(e).slice(0, 160)}`));

  await page.route('https://relay.farcaster.xyz/**', async (route) => {
    const method = route.request().method();
    relay.push(`${method} ${new URL(route.request().url()).pathname}`);
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
    statusCalls += 1;
    const pending = statusCalls <= 2;
    return route.fulfill({
      status: pending ? 202 : 200,
      headers: CORS,
      body: JSON.stringify(
        pending
          ? { state: 'pending', nonce: NONCE }
          : {
              state: 'completed',
              nonce: NONCE,
              message,
              signature,
              fid: 4242,
              username: 'fiddy',
              displayName: 'Fiddy',
              bio: 'your agent, living in your pocket',
              pfpUrl: 'https://example.com/pfp.png',
            },
      ),
    });
  });

  await page.goto(READY_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(
    () => (document.body?.innerText ?? '').trim().length > 40,
    { timeout: 60000 },
  );
  await page.waitForTimeout(500);
  const onSetupScreen = await readSurface(page);

  let clicked = null;
  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      clicked = text;
      break;
    }
  }

  const signedInNamed = await page
    .waitForFunction(() => /You're signed in/.test((document.body?.innerText ?? '')), {
      timeout: 30000,
    })
    .then(() => true)
    .catch(() => false);

  // A fresh boot takes as long as it takes; wait for a surface, not a stopwatch.
  const waitForSurface = async () => {
    for (let i = 0; i < 45; i += 1) {
      // The first of these reads lands inside the sign-in's own navigation, so
      // it goes through the tolerant reader (see safeReadSurface).
      const surface = await safeReadSurface(page);
      if (
        !surface.onboardingSheet &&
        (surface.feedish || surface.deviceOnlyLanding) &&
        surface.text.length > 40
      ) {
        return surface;
      }
      await page.waitForTimeout(1000);
    }
    return await safeReadSurface(page);
  };

  const afterSignIn = await waitForSurface();
  await page.screenshot({ path: `${OUT}/post-signin-${label}.png` });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  const afterSecondReload = await waitForSurface();
  await page.screenshot({ path: `${OUT}/post-signin-reload-${label}.png` });

  await browser.close();

  return {
    label,
    mockApi,
    setupScreenWasTheSetup:
      onSetupScreen.onboardingReady && onSetupScreen.path === '/welcome/ready',
    clicked,
    signedInNamed,
    afterSignIn: verdict(afterSignIn),
    afterSignInText: afterSignIn.text,
    afterReload: verdict(afterSecondReload),
    afterReloadText: afterSecondReload.text,
    relayCalls: relay.length,
    pageErrors: events.slice(0, 8),
  };
};

const withMock = await run({ label: 'mockapi', mockApi: true });
console.log('--- started from /welcome/ready, mock API on :8080 ---');
console.log(JSON.stringify(withMock, null, 1));

const realApi = await run({ label: 'realapi', mockApi: false });
console.log('--- started from /welcome/ready, real farcaster.xyz API ---');
console.log(JSON.stringify(realApi, null, 1));