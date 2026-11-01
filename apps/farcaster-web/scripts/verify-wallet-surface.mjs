// The wallet page, in a browser, with and without a wallet to connect.
//
//   pnpm --filter farcaster-web start          # https://localhost:5173
//   node apps/farcaster-web/scripts/verify-wallet-surface.mjs
//
// Point it at another client under test:
//
//   WALLET_ORIGIN=https://localhost:5199 node apps/farcaster-web/scripts/verify-wallet-surface.mjs
//
// The page's address is /~/wallet: the client's app routes all live behind the
// `/~` prefix (see src/constants/routePrefixes.ts), and the bare /wallet is a
// different route entirely.
//
// Screenshots land in $WALLET_SHOT_DIR (default: the system temp dir).
//
// WHAT IT MEASURES, AND WHY
// The wallet page used to be one sentence — "Farcaster Wallet is available on
// Farcaster mobile" — which is true of the fork it was inherited from and false
// of this client, where the wallet is a real thing you can connect and pay from.
// So the page is walked in the states a visitor can actually be in, at both
// widths, and each one is held to the same two claims:
//
//   1. nothing on the page says the wallet lives on Farcaster mobile, and the
//      page says what the wallet is FOR in plain words;
//   2. the state it reports is the state the browser is really in — a wallet
//      that is merely AVAILABLE (announced by the page, never connected) is not
//      reported as connected, and a wallet that IS connected is named, with its
//      address, and can pay.
//
// HOW EACH STATE IS REACHED
//   signed out          the app, cold, with no session
//   signed in           the SIWF relay stubbed with a REAL SIWE signature made
//                       by a throwaway key — the same technique as
//                       verify-post-signin-landing.mjs, and the app's own
//                       verifier has to accept it, so this is a real sign-in
//                       rather than a planted session
//   injected present    an EIP-6963 wallet ("Probe Wallet") announced before the
//                       page runs, which answers eth_requestAccounts itself — so
//                       the connect press is exercised end to end and no real
//                       wallet (and no real key) is needed
//
// WHAT IT CANNOT SAY: it never signs with a real key and never pays anything.
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const OUT = process.env.WALLET_SHOT_DIR ?? os.tmpdir();
const ORIGIN = process.env.WALLET_ORIGIN ?? 'https://localhost:5173';
const DOMAIN = new URL(ORIGIN).host;
const NONCE = 'w'.repeat(128);
const CHANNEL_TOKEN = 'WALLETTOK1';
const WIDTHS = [390, 1440];
const PROBE_ADDRESS = '0x1111111111111111111111111111111111111111';
const PROBE_WALLET_NAME = 'Probe Wallet';
const BOOT_TIMEOUT = Number(process.env.WALLET_BOOT_TIMEOUT ?? 90_000);

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

const throwaway = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const siweMessage = createSiweMessage({
  address: throwaway.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `https://${DOMAIN}/login`,
  version: '1',
});
const siweSignature = await throwaway.signMessage({ message: siweMessage });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

/**
 * An EIP-6963 wallet the page can find and use.
 *
 * Announced before any page script runs, and answering the two requests the
 * connect path makes, so "there is an injected wallet in this browser" is a real
 * state and not a named string.
 */
const announceProbeWallet = (address) => {
  const provider = {
    isProbeWallet: true,
    request: async ({ method }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        return [address];
      }
      if (method === 'eth_chainId') {
        return '0x2105';
      }
      if (method === 'net_version') {
        return '8453';
      }
      if (method === 'wallet_switchEthereumChain') {
        return null;
      }
      if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData') {
        return `0x${'ab'.repeat(65)}`;
      }
      throw new Error(`probe wallet: ${method} is not supported`);
    },
    on: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
  };
  const info = {
    uuid: '00000000-0000-4000-8000-00000000f1dd',
    name: 'Probe Wallet',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    rdns: 'fun.fiddy.probe',
  };
  const announce = () =>
    window.dispatchEvent(
      new window.CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );

  // Two entry points on purpose: `window.ethereum` is what a wallet that never
  // learned EIP-6963 looks like, and the announcement is what the client's own
  // discovery listens for.
  window.ethereum = provider;
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};

const readSurface = (page) =>
  page.evaluate(() => {
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const summary = document.querySelector('[data-fiddy-wallet-summary]');
    const connect = document.querySelector('[data-fiddy="wallet-connect"]');
    const rows = Array.from(document.querySelectorAll('button'))
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    return {
      path: window.location.pathname,
      text,
      pageStep:
        document
          .querySelector('[data-fiddy="wallet-page"]')
          ?.getAttribute('data-step') ?? null,
      walletHome: Boolean(document.querySelector('[data-fiddy="wallet-home"]')),
      summaryState:
        summary?.getAttribute('data-fiddy-wallet-summary') ?? null,
      summaryText: (summary?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      connectLabel: (connect?.textContent ?? '').trim() || null,
      connectionState:
        document
          .querySelector('[data-fiddy="wallet-connection"]')
          ?.getAttribute('data-fiddy-wallet-connection') ?? null,
      signedOutNote: Boolean(
        document.querySelector('[data-fiddy="wallet-signed-out"]'),
      ),
      chooser: Boolean(document.querySelector('[data-fiddy="chooser"]')),
      accountWallet:
        document
          .querySelector('[data-fiddy="account-wallet"]')
          ?.getAttribute('data-state') ?? null,
      rows,
    };
  });

const safeRead = async (page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readSurface(page);
    } catch (error) {
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
  return await readSurface(page);
};

const appears = async (page, selector, timeout = BOOT_TIMEOUT) => {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
};

const pressByText = async (page, pattern) => {
  for (const element of await page.$$('button, a, [role=button]')) {
    const label = ((await element.innerText()) || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (pattern.test(label) && (await element.isVisible())) {
      await element.click();
      return label;
    }
  }
  return null;
};

/** Walk the real sign-in, with only the relay stubbed. */
const signIn = async (page) => {
  await page.goto(`${ORIGIN}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: BOOT_TIMEOUT,
  });
  await page
    .waitForFunction(
      () => (document.body?.innerText ?? '').trim().length > 40,
      { timeout: BOOT_TIMEOUT },
    )
    .catch(() => undefined);

  const pressed = await pressByText(page, /go social/i);
  if (!pressed) {
    return { pressed: null, signedIn: false };
  }

  await page
    .waitForFunction(() => /You're signed in/i.test(document.body?.innerText ?? ''), {
      timeout: 60_000,
    })
    .catch(() => undefined);

  return {
    pressed,
    signedIn: await page.evaluate(
      () => !window.location.pathname.startsWith('/welcome'),
    ),
  };
};

const run = async ({ label, injected, signedIn: wantsSignIn, width }) => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: width < 600 ? 844 : 900 },
  });

  if (injected) {
    await context.addInitScript(announceProbeWallet, PROBE_ADDRESS);
  }

  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text().slice(0, 160));
    }
  });
  page.on('pageerror', (error) =>
    consoleErrors.push(`pageerror: ${String(error).slice(0, 160)}`),
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
        message: siweMessage,
        signature: siweSignature,
        fid: 4242,
        username: 'fiddy',
        displayName: 'Fiddy',
      }),
    });
  });

  const at = `${label} @${width}`;
  let session = { signedIn: !wantsSignIn, pressed: null };
  if (wantsSignIn) {
    session = await signIn(page);
    check(
      `${at}: the relay-stubbed sign-in completes`,
      session.signedIn,
      `pressed ${session.pressed ?? '(nothing)'}`,
    );
  }

  await page.goto(`${ORIGIN}/~/wallet`, {
    waitUntil: 'domcontentloaded',
    timeout: BOOT_TIMEOUT,
  });
  const home = await appears(page, '[data-fiddy="wallet-home"]');
  await page.screenshot({
    path: `${OUT}/wallet-${label}-${width}-1-page.png`,
    fullPage: true,
  });
  const surface = await safeRead(page);

  check(`${at}: the wallet page renders its own surface`, home, surface.path);
  check(
    `${at}: nothing says the wallet lives on Farcaster mobile`,
    !/farcaster mobile/i.test(surface.text),
    surface.text.slice(0, 90),
  );
  check(
    `${at}: the page says what the wallet is for`,
    /pays for what your agent uses/.test(surface.text) &&
      /signs every payment you approve/.test(surface.text),
    surface.text.slice(0, 90),
  );
  check(
    `${at}: the wallet home is on the page`,
    surface.walletHome && surface.accountWallet !== null,
    `home ${surface.walletHome}, account ${surface.accountWallet ?? '(still reading)'}`,
  );

  if (!wantsSignIn) {
    // Signed out: there is no wallet surface in this layout, so the page must
    // say so — and an announced wallet does NOT make it connected.
    check(
      `${at}: signed out, the page says sign in rather than offering a dead button`,
      surface.signedOutNote && surface.connectLabel === null,
      surface.connectLabel ?? '(no button)',
    );
    check(
      `${at}: no wallet is claimed, whatever the browser has announced`,
      surface.summaryState === 'cannot-pay' && surface.connectionState === null,
      `${surface.summaryState} / ${surface.connectionState}`,
    );
    check(
      `${at}: the wallet it names is the one from the page's own words`,
      /No wallet is connected yet/.test(surface.summaryText),
      surface.summaryText.slice(0, 80),
    );
    await browser.close();
    return consoleErrors;
  }

  // Signed in: the page can connect a wallet.
  check(
    `${at}: connecting is offered`,
    surface.connectLabel === 'Connect a wallet',
    surface.connectLabel ?? '(no button)',
  );

  await pressByText(page, /^Connect a wallet$/);
  const chooserUp = await appears(page, '[data-fiddy="chooser"]', 30_000);
  const connectStep = await safeRead(page);
  await page.screenshot({
    path: `${OUT}/wallet-${label}-${width}-2-connect.png`,
    fullPage: true,
  });
  check(
    `${at}: the connect step opens the full chooser`,
    chooserUp && connectStep.pageStep === 'connect',
    connectStep.pageStep ?? '(no step)',
  );
  check(
    `${at}: the chooser offers a wallet to a browser that has one`,
    injected
      ? connectStep.rows.some((row) => row.includes(PROBE_WALLET_NAME))
      : !connectStep.rows.some((row) => row.includes(PROBE_WALLET_NAME)),
    connectStep.rows.slice(0, 6).join(' | '),
  );

  if (injected) {
    const pressed = await pressByText(page, new RegExp(PROBE_WALLET_NAME));
    const back =
      pressed !== null &&
      (await page
        .waitForFunction(
          () =>
            document
              .querySelector('[data-fiddy="wallet-page"]')
              ?.getAttribute('data-step') === 'wallet',
          { timeout: 30_000 },
        )
        .then(() => true)
        .catch(() => false));
    await page.screenshot({
      path: `${OUT}/wallet-${label}-${width}-3-connected.png`,
      fullPage: true,
    });
    const connected = await safeRead(page);

    check(
      `${at}: pressing the detected wallet connects it`,
      back && connected.summaryState === 'can-pay',
      `${connected.summaryState} (${pressed ?? 'not found'})`,
    );
    check(
      `${at}: the wallet that pays is named, with its address`,
      connected.summaryText.includes(PROBE_WALLET_NAME) &&
        connected.summaryText.includes('0x1111'),
      connected.summaryText.slice(0, 90),
    );
  }

  await browser.close();
  return consoleErrors;
};

const states = [
  { label: 'signed-out', injected: false, signedIn: false },
  { label: 'signed-out-injected', injected: true, signedIn: false },
  { label: 'signed-in', injected: false, signedIn: true },
  { label: 'signed-in-injected', injected: true, signedIn: true },
];

for (const state of states) {
  for (const width of WIDTHS) {
    const errors = await run({ ...state, width });
    check(
      `${state.label} @${width}: no console errors`,
      errors.length === 0,
      errors.slice(0, 3).join(' | ') || 'none',
    );
  }
}

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(
    `${entry.ok ? 'ok  ' : 'RED '} ${entry.name}${entry.detail ? `  — ${entry.detail}` : ''}`,
  );
}
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed. Screenshots in ${OUT}.`,
);
process.exit(failed.length ? 1 : 0);