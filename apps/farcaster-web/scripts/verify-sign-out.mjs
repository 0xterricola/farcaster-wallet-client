// End-to-end check that signing out is findable and that it works.
//
//   HTTPS=true VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     VITE_FIDDY_MEDIA_URL=https://fiddy.fun \
//     npx vite --config scripts/probe.vite.config.mjs --port 5178 --strictPort
//   SIGN_OUT_SERVER=https://localhost:5178 node scripts/verify-sign-out.mjs
//
// Needs a dev server WITH a node configured: a session with nowhere to read
// from lands on the device-only screen and never reaches the shell where the
// avatar, its menu and the tab bar live.
//
// WHAT IT MEASURES, AND WHY IT IS THE CARD'S OWN ACCEPTANCE
// The card is "sign out is unfindable": one tap from the avatar menu, from any
// signed-in surface, at 390 and at 1440, with "Sign out" on screen without
// scrolling, and a sign-out that returns to the landing and clears the session.
// So for every surface it opens the menu the way a person does — a real mouse
// click on the avatar (the top bar at 1440, the "You" tab at 390) and then a
// real mouse click on the item — and it reads the geometry of the item, not
// just its text: a "Sign out" that exists below the fold is exactly the bug
// being fixed.
//
// The sign-in is the same fixture `verify-account-switching.mjs` uses: only the
// SIWF relay is stubbed, and it is stubbed with a REAL SIWE message signed by a
// throwaway key, so the app's own verifier accepts it for real. The FID it names
// is 3 (`dwr`), a real account, so the shell has a real feed to render.
//
// Nothing here writes to the network: every non-GET request to anything but the
// dev server is aborted and counted.
//
// Screenshots land in $SIGN_OUT_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.SIGN_OUT_SERVER ?? 'https://localhost:5178';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.SIGN_OUT_SHOT_DIR ?? os.tmpdir();
const NONCE = 'b'.repeat(128);
const CHANNEL_TOKEN = 'SIGNOUT1';

/** The account the stubbed sign-in names: a real, active one. */
const SIGNED_IN_FID = 3;
const SIGNED_IN_HANDLE = 'dwr';

/** Every signed-in surface the shell can be sitting on. */
const SURFACES = [
  { path: '/', name: 'home' },
  { path: '/~/agent', name: 'agent' },
  { path: '/~/wallet', name: 'wallet' },
  { path: '/~/settings', name: 'settings' },
  { path: '/~/settings/node', name: 'your own setup' },
];

const WIDTHS = [390, 1440];

const accountSigner = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const message = createSiweMessage({
  address: accountSigner.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SERVER}/login`,
  version: '1',
});
const signature = await accountSigner.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

const startedAt = Date.now();
const stage = (step) =>
  console.log(
    `[${String(Math.round((Date.now() - startedAt) / 1000)).padStart(3)}s] ${step}`,
  );

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail });
};

/** Sign in through the stubbed relay, and wait for the signed-in chrome. */
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
        username: SIGNED_IN_HANDLE,
        displayName: SIGNED_IN_HANDLE,
      }),
    });
  });

  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForSelector('button', { timeout: 60_000 });
  await page.waitForTimeout(1_500);

  const clicked = await page.evaluate(() => {
    for (const element of document.querySelectorAll('button, a, [role=button]')) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (/go social/i.test(text)) {
        element.click();
        return text;
      }
    }
    return null;
  });

  if (clicked === null) {
    throw new Error('the sign-in button was not on the setup screen');
  }

  // The shell's own top bar cannot render before the session exists, so waiting
  // for it is waiting for the whole handshake.
  await page.waitForFunction(
    () => document.querySelector('[data-fiddy="topbar"]') !== null,
    undefined,
    { timeout: 180_000 },
  );
  await page.waitForTimeout(2_000);
};

/** The one-time "Let Fiddy post as you?" card floats over the page's bottom
 *  right at 390 and would intercept a tap meant for anything under it. A real
 *  person presses "Not now"; this does too, and removes a leftover node. */
const dismissPostForYou = async (page) => {
  await page.evaluate(() => {
    const notNow = document.querySelector('[data-fiddy="post-for-you-not-now"]');
    notNow?.click();
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    document.querySelector('[data-fiddy="post-for-you"]')?.remove();
  });
};

/** Click the first visible match, with a real mouse, at its centre: a hit test
 *  is part of the check, so a panel under something else fails here.
 *
 *  The visibility test is written out in the page rather than passed in: this
 *  app's CSP has no `unsafe-eval`, so a probe may not hand the page a string to
 *  evaluate (the same reason a `waitForFunction` predicate must be a function).
 *  A probe also may not use `:visible` in `querySelector` — the chrome mounts
 *  some of its parts at both widths and hides them with CSS, so the first match
 *  can be the desktop avatar while the browser is 390px wide.
 */
const clickVisible = async (page, selector, label) => {
  const box = await page.evaluate((sel) => {
    const target = Array.from(document.querySelectorAll(sel)).find((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0.01 &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    if (!target) {
      return null;
    }

    const rect = target.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      text: (target.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      width: rect.width,
      height: rect.height,
    };
  }, selector);

  if (box === null) {
    throw new Error(`${label} (${selector}) is not visible on this surface`);
  }

  await page.mouse.click(box.x, box.y);
  return box;
};

/** Everything one read of the page needs: the panel's geometry, its words, and
 *  the session the client is holding. */
const readMenu = (page) =>
  page.evaluate(async () => {
    const dash = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const storage = await import('/src/utils/storageUtils.ts');

    const token = await storage.getItem({ key: 'auth-token', fallback: null });
    const panel = document.querySelector('[data-fiddy="account-menu"]');
    const item = document.querySelector('[data-fiddy="account-menu-sign-out"]');
    const identity = document.querySelector('[data-fiddy="account-menu-identity"]');
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    const geometry = (node) => {
      if (!node) {
        return null;
      }
      const rect = node.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        fullyInViewport:
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= viewportHeight &&
          rect.right <= viewportWidth,
      };
    };

    return {
      hasSession: Boolean(token?.secret),
      sessionFid: token?.secret
        ? Number(String(token.secret).split(':')[1])
        : null,
      panelText: panel ? dash(panel.innerText) : null,
      panelGeometry: geometry(panel),
      itemText: item ? dash(item.innerText) : null,
      itemGeometry: geometry(item),
      identityText: identity ? dash(identity.innerText) : null,
      itemColor: item ? getComputedStyle(item).color : null,
      viewport: { width: viewportWidth, height: viewportHeight },
      scrollY: window.scrollY,
    };
  });

const readSession = (page) =>
  page.evaluate(async () => {
    const storage = await import('/src/utils/storageUtils.ts');
    const token = await storage.getItem({ key: 'auth-token', fallback: null });

    return {
      hasSession: Boolean(token?.secret),
      onboardingOnScreen:
        document.querySelector('[data-fiddy="onboarding"]') !== null,
      pathname: window.location.pathname,
      cookieCount: document.cookie.length,
    };
  });

const run = async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });

  const writes = [];
  const pageErrors = [];

  for (const width of WIDTHS) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height: width === 390 ? 844 : 900 },
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 200)));

    // Reads are allowed (the shell needs a feed to render); writes are counted
    // and aborted, so this probe can never sign anybody out anywhere real.
    await page.route('**', async (route) => {
      const request = route.request();
      const method = request.method();

      if (
        ['GET', 'HEAD', 'OPTIONS'].includes(method) ||
        request.url().startsWith(SERVER)
      ) {
        return route.continue();
      }

      writes.push(`${method} ${request.url().slice(0, 110)}`);
      return route.abort();
    });

    stage(`signing in at ${width}px through the stubbed relay`);
    await signIn(page);
    await dismissPostForYou(page);

    const opener =
      width < 640
        ? {
            selector: '[data-fiddy="mobile-account-tab"]',
            label: "the phone's You tab",
          }
        : {
            selector: '[data-fiddy="account-menu-button"]',
            label: 'the top bar avatar',
          };

    for (const surface of SURFACES) {
      const where = `${surface.name} (${surface.path}) at ${width}px`;
      stage(`opening the account menu on ${where}`);

      await page.goto(`${SERVER}${surface.path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 90_000,
      });
      await page.waitForFunction(
        () => document.querySelector('[data-fiddy="topbar"]') !== null,
        undefined,
        { timeout: 120_000 },
      );
      await page.waitForTimeout(2_000);
      await dismissPostForYou(page);

      // The opener itself has to be there, and reachable, for the tap to work.
      const opened = await clickVisible(page, opener.selector, opener.label).catch(
        (error) => {
          check(`the menu opens from ${opener.label} on ${where}`, false, String(error));
          return null;
        },
      );

      if (opened === null) {
        continue;
      }

      const menuAppeared = await page
        .waitForSelector('[data-fiddy="account-menu"]', { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

      check(
        `the menu opens from ${opener.label} on ${where}`,
        menuAppeared,
        menuAppeared ? `opener "${opened.text}"` : 'no panel appeared',
      );

      if (!menuAppeared) {
        continue;
      }

      await page.screenshot({
        path: `${OUT}/sign-out-${width}-${surface.name}.png`,
      });

      const menu = await readMenu(page);

      check(
        `the panel carries "Sign out" in plain words on ${where}`,
        menu.itemText === 'Sign out' && menu.panelText.includes('Sign out'),
        `item "${menu.itemText}" in panel "${menu.panelText}"`,
      );
      check(
        `"Sign out" is on screen without scrolling on ${where}`,
        menu.itemGeometry !== null &&
          menu.itemGeometry.fullyInViewport &&
          menu.scrollY === 0,
        `${JSON.stringify(menu.itemGeometry)} scrollY ${menu.scrollY} viewport ${JSON.stringify(menu.viewport)}`,
      );
      check(
        `the whole panel fits the viewport on ${where}`,
        menu.panelGeometry !== null && menu.panelGeometry.fullyInViewport,
        JSON.stringify(menu.panelGeometry),
      );
      check(
        `the panel names the account on ${where}`,
        menu.identityText !== null && menu.identityText.includes(`@${SIGNED_IN_HANDLE}`),
        `identity "${menu.identityText}"`,
      );
      check(
        `Profile and Settings stay one press away on ${where}`,
        /Profile/.test(menu.panelText) && /Settings/.test(menu.panelText),
        menu.panelText,
      );

      // Pressing it must ASK. A destructive action that fires on the first tap
      // is the other half of "easy to find".
      stage(`pressing Sign out on ${where}, then cancelling it`);
      await clickVisible(page, '[data-fiddy="account-menu-sign-out"]', 'Sign out');

      const confirmAppeared = await page
        .waitForSelector('[data-fiddy="sign-out-modal"]', { timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

      const confirmRead = await page.evaluate(() => {
        const modal = document.querySelector('[data-fiddy="sign-out-modal"]');
        const confirm = document.querySelector('[data-fiddy="sign-out-confirm"]');
        const cancel = document.querySelector('[data-fiddy="sign-out-cancel"]');
        const panel = document.querySelector('[data-fiddy="account-menu"]');

        return {
          modalText: modal ? modal.innerText.replace(/\s+/g, ' ').trim() : null,
          confirmText: confirm ? confirm.innerText.replace(/\s+/g, ' ').trim() : null,
          cancelText: cancel ? cancel.innerText.replace(/\s+/g, ' ').trim() : null,
          panelStillOpen: panel !== null,
        };
      });

      check(
        `pressing Sign out asks first on ${where}`,
        confirmAppeared && confirmRead.confirmText === 'Sign out',
        `modal "${confirmRead.modalText}" confirm "${confirmRead.confirmText}"`,
      );
      check(
        `the confirmation gets out of the panel's way on ${where}`,
        confirmAppeared && confirmRead.panelStillOpen === false,
        `panel still open: ${confirmRead.panelStillOpen}`,
      );

      await clickVisible(page, '[data-fiddy="sign-out-cancel"]', 'Cancel');

      const cancelled = await page
        .waitForSelector('[data-fiddy="sign-out-modal"]', { state: 'detached', timeout: 15_000 })
        .then(() => true)
        .catch(() => false);

      const afterCancel = await readSession(page);

      check(
        `cancelling signs nobody out on ${where}`,
        cancelled && afterCancel.hasSession,
        `modal gone: ${cancelled}, session held: ${afterCancel.hasSession}`,
      );
    }

    // Settings keeps its own way out — the card asks for both doors.
    stage(`checking Settings still carries its own Sign out at ${width}px`);
    await page.goto(`${SERVER}/~/settings`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => document.querySelector('[data-fiddy="topbar"]') !== null,
      undefined,
      { timeout: 120_000 },
    );
    await page.waitForTimeout(2_500);
    await dismissPostForYou(page);

    const settingsOwn = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('a, button, [role=button]'));

      const inSettings = candidates.filter(
        (node) =>
          !node.closest('[data-fiddy="account-menu"]') &&
          getComputedStyle(node).display !== 'none' &&
          node.getBoundingClientRect().width > 0 &&
          /^sign out$/i.test((node.innerText ?? '').replace(/\s+/g, ' ').trim()),
      );

      return {
        count: inSettings.length,
        text: inSettings.length > 0 ? inSettings[0].innerText.trim() : null,
      };
    });

    check(
      `Settings keeps its own "Sign out" at ${width}px`,
      settingsOwn.count > 0,
      `${settingsOwn.count} entries: ${JSON.stringify(settingsOwn.text)}`,
    );

    // ── and finally: a real sign-out, from a surface that is NOT settings ───
    stage(`signing out for real from the wallet at ${width}px`);
    await page.goto(`${SERVER}/~/wallet`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => document.querySelector('[data-fiddy="topbar"]') !== null,
      undefined,
      { timeout: 120_000 },
    );
    await page.waitForTimeout(2_000);
    await dismissPostForYou(page);

    const beforeSignOut = await readSession(page);
    check(
      `a session exists before signing out at ${width}px`,
      beforeSignOut.hasSession,
      JSON.stringify(beforeSignOut),
    );

    await clickVisible(page, opener.selector, opener.label);
    await page.waitForSelector('[data-fiddy="account-menu"]', { timeout: 15_000 });
    await clickVisible(page, '[data-fiddy="account-menu-sign-out"]', 'Sign out');
    await page.waitForSelector('[data-fiddy="sign-out-modal"]', { timeout: 15_000 });
    await clickVisible(page, '[data-fiddy="sign-out-confirm"]', 'the real Sign out');

    // The client reloads when it signs out; the landing is what a signed-out
    // visitor gets at `/`, and the guard sends a deep URL there.
    const landed = await page
      .waitForFunction(
        () => document.querySelector('[data-fiddy="onboarding"]') !== null,
        undefined,
        { timeout: 180_000 },
      )
      .then(() => true)
      .catch(() => false);

    await page.screenshot({ path: `${OUT}/sign-out-${width}-after.png` });

    const after = await readSession(page);

    check(
      `signing out returns to the landing at ${width}px`,
      landed && after.onboardingOnScreen,
      `landing on screen: ${landed}, pathname ${after.pathname}`,
    );
    check(
      `signing out clears the session at ${width}px`,
      after.hasSession === false,
      `session held: ${after.hasSession}, pathname ${after.pathname}`,
    );

    await context.close();
  }

  await browser.close();

  const failed = checks.filter((entry) => !entry.ok);
  const passed = checks.length - failed.length;

  console.log(
    JSON.stringify(
      {
        server: SERVER,
        account: { fid: SIGNED_IN_FID, handle: SIGNED_IN_HANDLE },
        widths: WIDTHS,
        surfaces: SURFACES.map((surface) => `${surface.name} ${surface.path}`),
        writesAborted: writes,
        pageErrors,
        checks,
      },
      null,
      2,
    ),
  );
  console.log(`\n${passed}/${checks.length} checks passed`);
  for (const entry of failed) {
    console.log(`FAIL: ${entry.name} — ${entry.detail}`);
  }

  process.exit(failed.length === 0 ? 0 : 1);
};

await run();