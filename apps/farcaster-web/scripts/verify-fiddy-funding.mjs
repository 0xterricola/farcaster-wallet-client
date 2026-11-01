// The Fiddy balance and the add-funds flow, driven in a real browser at both
// widths.
//
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com HTTPS=true \
//     npx vite --config scripts/probe.vite.config.mjs --port 5211 --strictPort
//   FUNDING_ORIGIN=https://localhost:5211 node scripts/verify-fiddy-funding.mjs
//
// WHAT IT MEASURES, AND WHY
//
// The funding surface is the only thing in this client that can move somebody's
// money, so the claims worth holding it to are the ones that decide whether it
// moves ANY: what the balance chip shows (a number, or nothing at all), whether
// the amount step refuses to offer a send the service cannot credit, and what
// the review sheet says before a wallet is asked to approve anything.
//
//   1. THE CHIP SHOWS THE SERVER'S NUMBER, OR NOTHING. With a balance the chip
//      carries the server's own `availableUsdc` — not a zero, not a placeholder,
//      not a re-derived sum — and it is a link to the balance home. With no
//      balance it renders nothing at all, because a chip reading "$0.00" for
//      "this browser has no balance here" is a claim about somebody's money.
//
//   2. THE SEND IS NEVER OFFERED WHEN IT CANNOT LAND. A top-up is a real USDC
//      transfer to Fiddy's treasury; if the balance route refuses this session
//      (signed out, or an account that cannot hold a credit) the flow says so
//      and the press that would start a transfer is disabled. This is the check
//      that fails if somebody ever makes the send unconditional.
//
//   3. THE REVIEW NAMES THE THREE THINGS THAT MATTER: the amount in dollars, the
//      asset and the network ("USDC on Base"), and the treasury address — short
//      on screen, full in the copy control, and the SAME address the config
//      route published. Nothing here is invented client-side.
//
//   4. THE MONEY IS THE SERVER'S, NOT THE BROWSER'S. The stubbed config and
//      balance come from real route payloads (captured from the funding routes),
//      and the numbers the page shows are read back from the DOM: the $5 preset
//      really is `5.00`, the $1 floor really is the server's `minimum`, and no
//      amount the person typed is rounded (12.505 is refused, not sent as 12.50).
//
//   5. NOTHING CALLS IT A WALLET BALANCE OR A DEPOSIT. The copy rule the server
//      enforces has a client half; this sweeps the rendered words for the
//      vocabulary that would break it, and for the infrastructure jargon the
//      product bans.
//
//   6. THE WAY IN'S STEP IS SKIPPABLE. On `/welcome/funds` one press ("Add this
//      later") walks to the last step — the step cannot gate an account.
//
// WHAT IT CANNOT SAY: it never sends a transfer and never approves one. The
// press that would move money is asserted to exist and is never taken, which is
// deliberate: this probe has no funded wallet and must not need one.
//
// Screenshots land in $FUNDING_SHOT_DIR (default: the system temp dir).
import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const OUT = process.env.FUNDING_SHOT_DIR ?? os.tmpdir();
const ORIGIN = process.env.FUNDING_ORIGIN ?? 'https://localhost:5211';
const DOMAIN = new URL(ORIGIN).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'FUNDINGTOK1';
const WIDTHS = (process.env.FUNDING_WIDTHS ?? '390,1440')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
const BOOT_TIMEOUT = Number(process.env.FUNDING_BOOT_TIMEOUT ?? 90_000);

const TREASURY = '0xe4c848a6fa503762e95ad862cd1e5f7f9f0aab5f';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** The config route's own answer, field for field. */
const CONFIG = {
  ok: true,
  chain: { id: 8453, name: 'Base', caip2: 'eip155:8453' },
  asset: { symbol: 'USDC', address: USDC, decimals: 6 },
  treasury: { address: TREASURY, short: '0xe4c8\u2026ab5f' },
  minimum: { usdc: '1.00', baseUnits: '1000000' },
  confirmations: 5,
  presets: [
    { usd: 5, label: 'Top up $5', usdc: '5.00', baseUnits: '5000000' },
    { usd: 10, label: 'Top up $10', usdc: '10.00', baseUnits: '10000000' },
    { usd: 25, label: 'Top up $25', usdc: '25.00', baseUnits: '25000000' },
  ],
  creditNote:
    'A top-up becomes a Fiddy balance once Fiddy has checked the transfer on Base.',
};

/** A balance with one top-up and one spend in it: $5.00 credited, $1.50 spent. */
const BALANCE = {
  ok: true,
  credit: {
    availableUsdc: '3.50',
    availableBaseUnits: '3500000',
    creditedUsdc: '5.00',
    creditedBaseUnits: '5000000',
    spentUsdc: '1.50',
    spentBaseUnits: '1500000',
  },
  entries: [
    {
      id: 2,
      kind: 'spend',
      status: 'spent',
      amount: { usdc: '1.50', baseUnits: '1500000' },
      txHashShort: null,
      time: '2026-10-23T11:20:00.000Z',
    },
    {
      id: 1,
      kind: 'top-up',
      status: 'credited',
      amount: { usdc: '5.00', baseUnits: '5000000' },
      txHashShort: '0x9f2c1ab4\u2026e7d310',
      time: '2026-10-23T11:00:00.000Z',
    },
  ],
  note: 'Your Fiddy balance is a credit you spend inside Fiddy.',
};

/** What the balance route answers a session it will not place. */
const REFUSED = {
  ok: false,
  code: 'AUTH_REQUIRED',
  message: 'Sign in to Fiddy first.',
};

/** The words that would break the copy rule, or the product's jargon ban. */
const FORBIDDEN = [
  'deposit',
  'gasless',
  'allowance',
  'chain id',
  'chain-id',
  'custody',
  'your funds',
  'wallet balance',
  'balance in your wallet',
  'held by fiddy',
];

/** What a browser logs that is not this surface's problem. */
const IGNORED_CONSOLE = [
  // The probe's own stubs answer 401/500 on purpose, and the browser logs every
  // non-2xx fetch as a console error: the run's own 401 is not the page's fault.
  /Failed to load resource/i,
  // Public reads the app fires at Farcaster's own hosts, which a local probe
  // origin is not allowed to make.
  /warpcast\.com|haste\.|farcaster\.xyz/i,
  // The embedded-wallet SDK's own note about a stubbed session.
  /User deemed not signed in/i,
  // A bare format placeholder. Measured 2026-10-23 (card t_10519e32): a `%o`
  // message arrives with no text, no location and no arguments, and the probe's
  // own wrapper around the page's `console.error` recorded nothing for it — so
  // it is not a page-level console call and names nothing anyone can act on.
  // The funding code always logs a sentence, never a bare placeholder.
  /^%[a-z]$/i,
  // The provider seam's own HANDLED refusals. Measured on this probe: the shell
  // prefetches an explore window, and the local provider chain answers 501 for
  // it ("explore is a ranking, and ranking is an indexer's job"), which the seam
  // logs as a handled error with the endpoint named. That is the app being
  // honest about a surface its node does not serve — not this surface's, and it
  // predates the funding work.
  /HandledFetchError/,
];

const isNoise = (message) =>
  IGNORED_CONSOLE.some((pattern) => pattern.test(message));

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
 * An EIP-6963 wallet the page can find, so "there is a wallet in this browser"
 * is a real state rather than a named string. It answers reads only: this probe
 * never asks it to send, and the press that would is never taken.
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
      throw new Error(`probe wallet: ${method} is not supported`);
    },
    on: () => undefined,
    removeListener: () => undefined,
    removeAllListeners: () => undefined,
  };
  const info = {
    uuid: '00000000-0000-4000-8000-00000000f00d',
    name: 'Probe Wallet',
    icon: 'data:image/svg+xml;base64,PHN2Zy8+',
    rdns: 'fun.fiddy.funding-probe',
  };
  const announce = () =>
    window.dispatchEvent(
      new window.CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info, provider }),
      }),
    );

  window.ethereum = provider;
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};

/** Everything the surface says, and everything it put in the DOM to say it. */
const readFunding = (page) =>
  page.evaluate(() => {
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const pick = (selector) => document.querySelector(selector);
    const value = (selector, attribute) =>
      pick(selector)?.getAttribute(attribute) ?? null;
    const label = (selector) =>
      (pick(selector)?.textContent ?? '').replace(/\s+/g, ' ').trim() || null;

    const chip = pick('[data-fiddy="balance-chip"]');
    const recipient = pick('[data-fiddy="review-recipient"]');
    const copy = pick('[data-fiddy="copy-recipient"]');
    const reviewOpen = pick('[data-fiddy="top-up-review-open"]');
    const send = pick('[data-fiddy="top-up-send"]');

    return {
      path: window.location.pathname,
      text,
      chip: chip
        ? {
            balance: chip.getAttribute('data-fiddy-balance'),
            compact: chip.getAttribute('data-fiddy-compact'),
            label: (chip.textContent ?? '').replace(/\s+/g, ' ').trim(),
            href: chip.closest('a')?.getAttribute('href') ?? null,
            inHeader: chip.closest('header') !== null,
          }
        : null,
      home: Boolean(pick('[data-fiddy="balance-home"]')),
      available: label('[data-fiddy="balance-available"]'),
      sessionOnHome: pick('[data-fiddy="balance-session-line"]')
        ? label('[data-fiddy="balance-session-line"]')
        : null,
      movements: Array.from(
        document.querySelectorAll('[data-fiddy="balance-entries"] li'),
      ).map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim()),
      addFundsPage: Boolean(pick('[data-fiddy="add-funds-page"]')),
      amounts: Array.from(document.querySelectorAll('[data-fiddy-amount]')).map(
        (el) => ({
          usd: el.getAttribute('data-fiddy-amount'),
          label: (el.textContent ?? '').trim(),
          pressed: el.getAttribute('aria-pressed'),
        }),
      ),
      custom: Boolean(pick('[data-fiddy="top-up-custom"]')),
      problem: label('[data-fiddy="top-up-problem"]'),
      minimumLine: text.includes('Smallest top-up'),
      payer: value('[data-fiddy-payer="wallet"]', 'aria-pressed'),
      reviewOpen: reviewOpen
        ? {
            disabled: reviewOpen.disabled,
            label: (reviewOpen.textContent ?? '').replace(/\s+/g, ' ').trim(),
          }
        : null,
      review: Boolean(pick('[data-fiddy="top-up-review"]')),
      reviewAmount: label('[data-fiddy="review-amount"]'),
      reviewAsset: label('[data-fiddy="review-asset"]'),
      reviewRecipient: (recipient?.textContent ?? '').trim() || null,
      reviewRecipientFull: recipient?.getAttribute('title') ?? null,
      copy: copy
        ? {
            title: copy.getAttribute('title'),
            copied: copy.getAttribute('data-fiddy-copied'),
          }
        : null,
      reviewPayer: label('[data-fiddy="review-payer"]'),
      sendPresent: send !== null,
      sessionOnSheet: value(
        '[data-fiddy="top-up-session-line"]',
        'data-fiddy-session',
      ),
      sessionSheetLine: label('[data-fiddy="top-up-session-line"]'),
      later: label('[data-fiddy="top-up-later"]'),
      sheetStep: value('[data-fiddy="sheet"]', 'data-fiddy-step'),
      stepCount: label('[data-fiddy="step-count"]'),
      fundsTitle: label('.fiddy-top-up-title'),
    };
  });

const safeRead = async (page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readFunding(page);
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
  return await readFunding(page);
};

const appears = async (page, selector, timeout = BOOT_TIMEOUT) => {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
};

/**
 * Clear the shell's own floating cards before driving this surface.
 *
 * A signed-in session can carry the "Let Fiddy post as you?" card, which is
 * `fixed bottom-20 right-4 z-40` — over the bottom of ANY page in the authed
 * shell, including the one button this probe has to press. A person dismisses
 * it with "Not now", so that is what the probe presses first; anything still
 * floating afterwards is removed, because it belongs to another surface's
 * business and this probe is measuring the funding one.
 */
const clearOverlays = async (page) => {
  const notNow = await page.$('[data-fiddy="post-for-you-not-now"]');
  if (notNow !== null && (await notNow.isVisible())) {
    await notNow.click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => {
    document
      .querySelectorAll('[data-fiddy="post-for-you"]')
      .forEach((element) => element.remove());
  });
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

  // The button first, on a page that has really painted: the shell writes text
  // before it, so an early press lands on nothing and the run then fails ten
  // checks later as "not signed in" — a harness race that reads as a bug.
  const buttonUp = await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('button, a, [role=button]')).some(
          (element) => /go social/i.test(element.innerText ?? ''),
        ),
      { timeout: BOOT_TIMEOUT },
    )
    .then(() => true)
    .catch(() => false);
  if (!buttonUp) {
    return { pressed: null, signedIn: false };
  }

  const pressed = await pressByText(page, /go social/i);
  if (!pressed) {
    return { pressed: null, signedIn: false };
  }

  // Signed in means the app really left the setup route with a session, not
  // that a sentence appeared.
  const signedIn = await page
    .waitForFunction(() => !window.location.pathname.startsWith('/welcome'), {
      timeout: 90_000,
    })
    .then(() => true)
    .catch(() => false);

  return { pressed, signedIn };
};

/** Wait for a funding surface to report the session state it should. */
const waitForSession = async (page, selector, expected, timeout = 30_000) =>
  page
    .waitForFunction(
      ({ selector: target, expected: want }) =>
        document.querySelector(target)?.getAttribute('data-fiddy-session') ===
        want,
      { selector, expected },
      { timeout },
    )
    .then(() => true)
    .catch(() => false);

const sweepCopy = (at, surface) =>
  FORBIDDEN.forEach((word) =>
    check(
      `${at}: the copy never says "${word}"`,
      !surface.text.toLowerCase().includes(word),
      surface.text.toLowerCase().includes(word)
        ? surface.text.slice(0, 120)
        : 'absent',
    ),
  );

/**
 * Record where every `console.error` came from.
 *
 * Some loggers pass an object and no text, and the browser reports the call as a
 * bare format placeholder (`%o`) with no location and no arguments — a message
 * that names nothing and cannot be chased from the outside. Wrapping the call
 * inside the page is what turns it into a stack someone can act on: it is how
 * the one unattributable message this probe tolerates was shown NOT to be a page
 * console call at all (the trace list came back empty). The wrapper only
 * observes: it still calls the original.
 */
const traceConsoleErrors = () => {
  window.__fundingProbeConsoleErrors = [];
  const original = console.error.bind(console);
  console.error = (...args) => {
    try {
      window.__fundingProbeConsoleErrors.push({
        args: args
          .map((value) =>
            typeof value === 'string'
              ? value.slice(0, 120)
              : Object.prototype.toString.call(value),
          )
          .join(' '),
        stack: String(new Error('console.error').stack ?? '')
          .split('\n')
          .slice(1, 4)
          .join(' | '),
      });
    } catch {
      // A trace that cannot be recorded is not a reason to break the page.
    }
    return original(...args);
  };
};

const newPage = async ({ browser, injected }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  if (injected) {
    await context.addInitScript(announceProbeWallet, TREASURY);
  }
  const page = await context.newPage();
  await page.addInitScript(traceConsoleErrors);
  const consoleErrors = [];
  const rawConsole = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') {
      return;
    }
    rawConsole.push(message);
    // Judged on the message's OWN text: the location suffix this adds is for a
    // human reading a failure, not for deciding whether it is noise.
    const raw = message.text();
    if (isNoise(raw)) {
      return;
    }
    const where = message.location();
    consoleErrors.push(
      `${raw.slice(0, 120)} @ ${where?.url ?? '?'}:${where?.lineNumber ?? 0}`,
    );
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

  return { context, page, consoleErrors, rawConsole };
};

/**
 * Say what the browser actually logged, arguments and all.
 *
 * A message can arrive as a bare format placeholder (`%o`) when the logger
 * passes an object, and then the text alone names nothing. Resolving the
 * arguments is what turns "something was logged" into a fact someone can act
 * on, and it is done while the page is still open.
 */
const describeConsole = async (raw, page) => {
  const out = [];
  for (const message of raw) {
    const parts = [];
    for (const argument of message.args()) {
      parts.push(await argument.jsonValue().catch(() => null));
    }
    out.push(
      `${message.text()} :: ${JSON.stringify(parts).slice(0, 240)} @ ${
        message.location()?.url ?? '?'
      }`,
    );
  }
  const traced = await page
    .evaluate(() => window.__fundingProbeConsoleErrors ?? [])
    .catch(() => []);
  for (const entry of traced) {
    out.push(`traced ${entry.args} <- ${entry.stack}`);
  }
  return out;
};

/**
 * The funding routes, stubbed with real payloads. `balanceState` decides what
 * the balance route answers: `ready` (a credit) or `refused` (a session the
 * service will not place).
 */
const stubFunding = async (page, balanceState) => {
  await page.route('**/api/fiddy/funding/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/funding/config')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        body: JSON.stringify(CONFIG),
      });
    }
    if (url.includes('/funding/balance')) {
      return balanceState === 'ready'
        ? route.fulfill({
            status: 200,
            headers: CORS,
            body: JSON.stringify(BALANCE),
          })
        : route.fulfill({
            status: 401,
            headers: CORS,
            body: JSON.stringify(REFUSED),
          });
    }
    // A credit is never submitted by this probe: if one ever is, the route
    // answers 500 so the run fails loudly rather than pretending it landed.
    return route.fulfill({
      status: 500,
      headers: CORS,
      body: JSON.stringify({ ok: false, code: 'PROBE_DOES_NOT_CREDIT' }),
    });
  });
};

// ---------------------------------------------------------------------------
// 1. A balance, and the flow that adds to it
// ---------------------------------------------------------------------------

const runReady = async ({ width }) => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const { page, consoleErrors, rawConsole } = await newPage({
    browser,
    injected: true,
  });
  await stubFunding(page, 'ready');
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });

  const at = `balance @${width}`;
  const session = await signIn(page);
  check(
    `${at}: the relay-stubbed sign-in completes`,
    session.signedIn,
    `pressed ${session.pressed ?? '(nothing)'}`,
  );

  await page.goto(`${ORIGIN}/~/wallet`, {
    waitUntil: 'domcontentloaded',
    timeout: BOOT_TIMEOUT,
  });
  const home = await appears(page, '[data-fiddy="balance-home"]');
  await page
    .waitForSelector('[data-fiddy="balance-chip"]', { timeout: 30_000 })
    .catch(() => undefined);
  await page.screenshot({
    path: `${OUT}/funding-${width}-1-balance.png`,
    fullPage: true,
  });
  const surface = await safeRead(page);
  await clearOverlays(page);

  check(`${at}: the balance home is on the wallet page`, home, surface.path);
  check(
    `${at}: the chip carries the server's own number`,
    surface.chip !== null && surface.chip.balance === '3.50',
    surface.chip === null
      ? '(no chip)'
      : `${surface.chip.balance} / ${surface.chip.label}`,
  );
  check(
    `${at}: the chip sits in the shell header, beside the mark`,
    surface.chip !== null && surface.chip.inHeader,
    surface.chip?.inHeader ? 'in header' : '(not in a header)',
  );
  check(
    `${at}: the chip is a link to the balance home`,
    surface.chip?.href?.endsWith('/wallet') === true,
    surface.chip?.href ?? '(no link)',
  );
  check(
    `${at}: the balance home agrees with the chip`,
    surface.available === '$3.50',
    surface.available ?? '(nothing)',
  );
  check(
    `${at}: a top-up is in the recent movements`,
    surface.movements.some((row) => row.includes('Top-up')) &&
      surface.movements.some((row) => row.includes('+$5.00')) &&
      surface.movements.some((row) => row.includes('Spent')),
    surface.movements.join(' | ') || '(none)',
  );
  check(
    `${at}: the home says what a Fiddy balance is`,
    /credit you spend inside Fiddy/i.test(surface.text) &&
      /does not hold money in your wallet/i.test(surface.text),
    surface.text.slice(0, 100),
  );
  sweepCopy(at, surface);

  // The one press that adds funds.
  await page.click('[data-fiddy="balance-add-funds"]');
  const onAddFunds = await appears(
    page,
    '[data-fiddy="add-funds-page"]',
    30_000,
  );
  await page
    .waitForSelector('[data-fiddy="top-up-review-open"]', { timeout: 30_000 })
    .catch(() => undefined);
  // Offered means the config AND the balance have answered: the press is only
  // there once both have, so the wait is for the enabled state and not the node.
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-fiddy="top-up-review-open"]')
          ?.disabled === false,
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  await page.screenshot({
    path: `${OUT}/funding-${width}-2-add-funds.png`,
    fullPage: true,
  });
  const sheet = await safeRead(page);
  await clearOverlays(page);

  check(
    `${at}: adding funds is its own address, one press from the balance`,
    onAddFunds && sheet.path === '/~/wallet/add-funds',
    sheet.path,
  );
  check(
    `${at}: the server's presets are the ones on screen`,
    sheet.amounts.length === 3 &&
      sheet.amounts.map((entry) => entry.label).join(',') === '$5,$10,$25',
    sheet.amounts.map((entry) => entry.label).join(',') || '(none)',
  );
  check(
    `${at}: the first preset is chosen for the person`,
    sheet.amounts[0]?.pressed === 'true',
    `pressed=${sheet.amounts[0]?.pressed ?? 'none'}`,
  );
  check(
    `${at}: there is a field for another amount`,
    sheet.custom && sheet.minimumLine,
    `field ${sheet.custom}, floor line ${sheet.minimumLine}`,
  );
  check(
    `${at}: with a balance behind it, the review is offered`,
    sheet.reviewOpen?.disabled === false,
    sheet.reviewOpen?.label ?? '(no button)',
  );
  check(
    `${at}: the wallet in this browser is the one offered to pay`,
    sheet.payer === 'true',
    `aria-pressed=${sheet.payer ?? 'none'}`,
  );

  // The review: the three lines, and the address one press away.
  await page.click('[data-fiddy="top-up-review-open"]');
  const reviewUp = await appears(page, '[data-fiddy="top-up-review"]', 30_000);
  await page.screenshot({
    path: `${OUT}/funding-${width}-3-review.png`,
    fullPage: true,
  });
  const review = await safeRead(page);

  check(
    `${at}: the review opens before anything is asked of a wallet`,
    reviewUp,
  );
  check(
    `${at}: the review names the amount in dollars`,
    review.reviewAmount === '$5.00',
    review.reviewAmount ?? '(nothing)',
  );
  check(
    `${at}: the review names the asset and the network`,
    review.reviewAsset === 'USDC on Base',
    review.reviewAsset ?? '(nothing)',
  );
  check(
    `${at}: the recipient is the treasury the server published, short on screen`,
    review.reviewRecipient === '0xe4c8\u2026ab5f',
    review.reviewRecipient ?? '(nothing)',
  );
  check(
    `${at}: the copy control holds the full treasury address`,
    review.reviewRecipientFull === TREASURY && review.copy?.title === TREASURY,
    `${review.reviewRecipientFull ?? '(none)'} / copy ${review.copy?.title ?? '(none)'}`,
  );
  check(
    `${at}: the review names the wallet that will pay`,
    (review.reviewPayer ?? '').length > 0,
    review.reviewPayer ?? '(nothing)',
  );
  check(
    `${at}: the review says Fiddy checks the transfer and holds no keys`,
    /Base has settled the transfer/i.test(review.text) &&
      /never\s+holds your wallet or its keys/i.test(review.text),
    review.text.slice(0, 120),
  );
  check(
    `${at}: the send press exists (and this probe never takes it)`,
    review.sendPresent,
    review.sendPresent ? 'present, not pressed' : '(missing)',
  );

  await page.click('[data-fiddy="copy-recipient"]');
  const copied = await page
    .waitForFunction(
      () =>
        document
          .querySelector('[data-fiddy="copy-recipient"]')
          ?.getAttribute('data-fiddy-copied') === 'true',
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  check(`${at}: pressing copy reports that it copied`, copied);
  sweepCopy(at, review);

  // The amount field: the floor, a rounding refusal, and a real amount.
  await page.click('[data-fiddy="review-back"]');
  await appears(page, '[data-fiddy="top-up-custom"]', 30_000);
  await page.fill('[data-fiddy="top-up-custom"]', '0.50');
  const under = await page
    .waitForFunction(
      () =>
        (document.querySelector('[data-fiddy="top-up-problem"]')?.textContent ??
          '') !== '',
      { timeout: 10_000 },
    )
    .then(() => safeRead(page))
    .catch(() => null);
  check(
    `${at}: an amount under the floor is refused, in the server's own words`,
    under?.problem !== null &&
      under?.problem?.includes('$1.00') === true &&
      under?.reviewOpen?.disabled === true,
    `${under?.problem ?? '(nothing)'} / disabled ${under?.reviewOpen?.disabled}`,
  );

  await page.fill('[data-fiddy="top-up-custom"]', '12.505');
  const rounded = await page
    .waitForFunction(
      () =>
        /Enter an amount in dollars/i.test(
          document.querySelector('[data-fiddy="top-up-problem"]')
            ?.textContent ?? '',
        ),
      { timeout: 10_000 },
    )
    .then(() => safeRead(page))
    .catch(() => null);
  check(
    `${at}: an amount it would have to round is refused, not rounded`,
    rounded?.reviewOpen?.disabled === true,
    rounded?.problem ?? '(nothing)',
  );

  await page.fill('[data-fiddy="top-up-custom"]', '10');
  await page
    .waitForFunction(
      () => document.querySelector('[data-fiddy="top-up-problem"]') === null,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  const ten = await safeRead(page);
  check(
    `${at}: a real amount re-enables the review, named with that amount`,
    ten.problem === null &&
      ten.reviewOpen?.disabled === false &&
      ten.reviewOpen?.label === 'Review $10.00',
    ten.reviewOpen?.label ?? '(nothing)',
  );
  await page.screenshot({
    path: `${OUT}/funding-${width}-4-custom.png`,
    fullPage: true,
  });

  console.log(
    `CONSOLE ${at}: ${(await describeConsole(rawConsole, page)).join(' || ') || 'none'}`,
  );
  await browser.close();
  return consoleErrors;
};

// ---------------------------------------------------------------------------
// 2. A session the balance route will not place: the send is never offered
// ---------------------------------------------------------------------------

const runRefused = async ({ width }) => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const { page, consoleErrors, rawConsole } = await newPage({
    browser,
    injected: true,
  });
  await stubFunding(page, 'refused');
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });

  const at = `no-balance @${width}`;
  const session = await signIn(page);
  check(
    `${at}: the relay-stubbed sign-in completes`,
    session.signedIn,
    `pressed ${session.pressed ?? '(nothing)'}`,
  );

  await page.goto(`${ORIGIN}/~/wallet`, {
    waitUntil: 'domcontentloaded',
    timeout: BOOT_TIMEOUT,
  });
  await appears(page, '[data-fiddy="balance-home"]');
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-fiddy="balance-session-line"]') !== null,
      { timeout: 30_000 },
    )
    .catch(() => undefined);
  await page.screenshot({
    path: `${OUT}/funding-${width}-5-refused-home.png`,
    fullPage: true,
  });
  const home = await safeRead(page);

  check(
    `${at}: no balance means no chip, rather than a zero`,
    home.chip === null,
    home.chip === null ? 'absent' : `${home.chip.balance} / ${home.chip.label}`,
  );
  check(
    `${at}: the home says why there is nothing to show, and names the code`,
    (home.sessionOnHome ?? '').includes('AUTH_REQUIRED'),
    home.sessionOnHome ?? '(no line)',
  );

  await page.goto(`${ORIGIN}/~/wallet/add-funds`, {
    waitUntil: 'domcontentloaded',
    timeout: BOOT_TIMEOUT,
  });
  await appears(page, '[data-fiddy="add-funds-page"]');
  await waitForSession(page, '[data-fiddy="top-up-session-line"]', 'refused');
  await page
    .waitForSelector('[data-fiddy="top-up-review-open"]', { timeout: 30_000 })
    .catch(() => undefined);
  await page.screenshot({
    path: `${OUT}/funding-${width}-6-refused-flow.png`,
    fullPage: true,
  });
  const flow = await safeRead(page);

  check(
    `${at}: the sheet reports the refusal in its own state`,
    flow.sessionOnSheet === 'refused',
    flow.sessionOnSheet ?? '(nothing)',
  );
  check(
    `${at}: it says sign in, and names the code`,
    (flow.sessionSheetLine ?? '').includes('AUTH_REQUIRED') &&
      /sign in to fiddy/i.test(flow.sessionSheetLine ?? ''),
    flow.sessionSheetLine ?? '(no line)',
  );
  check(
    `${at}: THE SEND IS NOT OFFERED when it could not be credited`,
    flow.reviewOpen?.disabled === true,
    `disabled=${flow.reviewOpen?.disabled ?? 'missing'}`,
  );
  check(
    `${at}: the amounts are still explained, so the flow is not a dead end`,
    flow.amounts.length === 3 && flow.minimumLine,
    `${flow.amounts.length} presets / floor line ${flow.minimumLine}`,
  );
  sweepCopy(at, flow);

  console.log(
    `CONSOLE ${at}: ${(await describeConsole(rawConsole, page)).join(' || ') || 'none'}`,
  );
  await browser.close();
  return consoleErrors;
};

// ---------------------------------------------------------------------------
// 3. The way in's step: skippable, and never a gate
// ---------------------------------------------------------------------------

const runOnboarding = async ({ width }) => {
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const { page, consoleErrors, rawConsole } = await newPage({
    browser,
    injected: false,
  });
  await stubFunding(page, 'refused');
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });

  const at = `way-in @${width}`;
  await page.goto(`${ORIGIN}/welcome/funds`, {
    waitUntil: 'domcontentloaded',
    timeout: BOOT_TIMEOUT,
  });
  const stepUp = await appears(page, '[data-fiddy-step="funds"]');
  await waitForSession(page, '[data-fiddy="top-up-session-line"]', 'refused');
  await page
    .waitForSelector('[data-fiddy="top-up-later"]', { timeout: 30_000 })
    .catch(() => undefined);
  await page.screenshot({
    path: `${OUT}/funding-${width}-7-welcome-funds.png`,
    fullPage: true,
  });
  const step = await safeRead(page);

  check(
    `${at}: adding funds is a step of its own, after the brain pick`,
    stepUp && step.sheetStep === 'funds',
    step.sheetStep ?? '(no step)',
  );
  check(
    `${at}: it is numbered as the middle step of three`,
    step.stepCount === 'Step 2 of 3',
    step.stepCount ?? '(nothing)',
  );
  check(
    `${at}: the step offers the real flow, not a picture of one`,
    step.amounts.length === 3,
    `${step.amounts.length} presets`,
  );
  check(
    `${at}: signed out, the step cannot send — and says so`,
    step.reviewOpen?.disabled === true && step.sessionOnSheet === 'refused',
    `${step.sessionOnSheet ?? '(nothing)'} / disabled ${step.reviewOpen?.disabled}`,
  );
  check(
    `${at}: the step can be left in one press`,
    step.later === 'Add this later',
    step.later ?? '(no quiet action)',
  );
  sweepCopy(at, step);

  await page.click('[data-fiddy="top-up-later"]');
  const moved = await page
    .waitForFunction(
      () =>
        document
          .querySelector('[data-fiddy="sheet"]')
          ?.getAttribute('data-fiddy-step') === 'ready',
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false);
  const after = await safeRead(page);
  check(
    `${at}: "Add this later" walks to the last step, so it gates nothing`,
    moved && after.stepCount === 'Step 3 of 3',
    `${after.path} ${after.stepCount ?? '(no count)'}`,
  );

  console.log(
    `CONSOLE ${at}: ${(await describeConsole(rawConsole, page)).join(' || ') || 'none'}`,
  );
  await browser.close();
  return consoleErrors;
};

const states = [
  { label: 'ready', run: runReady },
  { label: 'refused', run: runRefused },
  { label: 'welcome', run: runOnboarding },
].filter(
  (state) =>
    process.env.FUNDING_STATES === undefined ||
    process.env.FUNDING_STATES.split(',').includes(state.label),
);

for (const state of states) {
  for (const width of WIDTHS) {
    const errors = await state.run({ width });
    check(
      `${state.label} @${width}: no console errors`,
      errors.length === 0,
      errors.slice(0, 2).join(' | ').slice(0, 240) || 'none',
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
