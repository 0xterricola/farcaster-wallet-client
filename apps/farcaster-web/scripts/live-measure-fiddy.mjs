// Measure the LIVE client at https://fiddy.fun — the release check that asks
// whether the account-creation entry is reachable from the sign-in modal, and
// whether the account switcher is reachable from the rail and from the mobile
// menu. This is the probe from t_451ad931 / t_c6256597, with the three driver
// defects filed on t_c50646cc fixed. What is ASSERTED is unchanged: the same
// seven rows, the same selectors, the same in-modal test
// (closest('[role=dialog], #modal-root, [data-radix-portal]')), the same SIWF
// relay stub, fid 3 / 'dwr', the same cross-origin write abort.
//
// The three fixes are in how the driver drives:
//
//   1. BOOT — the probe slept a fixed 3-6 s after each navigation and then read
//      the DOM. The deployed SPA is 7.7 MB and this box runs at load 30-175, so
//      the app needs 30-60 s to boot and its rows read "" or "Loading Fiddy…".
//      Every step below now waits for a POSITIVE ELEMENT SIGNAL instead: the
//      onboarding surface, the in-modal entry with a real box, the creation
//      sheet marker, the rail switcher with a real box, the switcher sheet, the
//      mobile menu toggle. No fixed sleep decides a verdict.
//      (A wait on `body.innerText.length > 0` is NOT enough — it passes on an
//      intermediate render and read 3/7 in the parent's run. Hence per-step
//      element signals.)
//
//   2. THE SHEET ROW CLICKS THE RIGHT NODE — the probe called
//      document.querySelector('[data-fiddy="create-account-entry"]').click() and
//      clicked the FIRST match in the document. This build has two: the
//      onboarding screen's own entry (hidden, 0x0) and the one inside the
//      sign-in modal (259x40). The row meant to prove "the entry inside the
//      sign-in modal opens the creation sheet" was clicking the hidden one. This
//      driver scopes the click to the in-modal node the row above already tests
//      for, and waits for [data-fiddy="create-account"] instead of sleeping.
//      The same first-match bug is fixed on the rail click and on the mobile
//      read: the node with a real box is the one meant, not the first in the DOM.
//
//   3. THE RELAY POLL IS HELD PENDING — the stub answers the status poll with
//      credentials at once, so the client signs itself in and the sign-in modal
//      closes ~1 s after opening, which races the two modal rows. The poll stays
//      `pending` until the creation sheet has been read, then releases.
//
// The `no write left the machine` row is kept and made to say what it means. It
// used to fail on ANY cross-origin POST, which reds on the page's own telemetry
// (Neynar PostHog `flags/`, wallet.farcaster.xyz/cdn-cgi/rum,
// privy.farcaster.xyz/api/v1/analytics_events, a Datadog CSP report). Now:
// writes to the Farcaster node / relay are one row, named beacon hosts are
// reported separately, and a POST to a host on NEITHER list still reds the row.
// The write-abort itself is unchanged — nothing leaves the browser either way.
//
// One sequencing fact the next reader will hit: opening the creation sheet from
// inside the sign-in modal tears down the SIWF poll (the sheet replaces the
// dialog), so after the two modal rows are read the client is NOT signed in.
// The rail phase therefore starts the sign-in again from the setup screen, the
// way the probe already did — and its wait is two-way (an entry with a box, or
// a shell that has booted and is signed out), so a signed-out shell costs
// seconds instead of a full wait ceiling.
//
// Run it from the client repo, against whatever https://fiddy.fun/release.json names:
//   node apps/farcaster-web/scripts/live-measure-fiddy.mjs
// `playwright` and (for the SIWF signer) `viem` resolve from the app's own
// node_modules; when the viem specifier does not resolve directly, the driver falls
// back to <repo>/apps/farcaster-web/node_modules/viem/_esm.
// (LIVE_SITE=… overrides the site; LIVE_BOOT_MS=… the per-step wait ceiling;
// FIDDY_REPO=… where to find viem if it is not resolvable directly;
// LIVE_SELFCHECK=1 exercises the write row's classifier and exits. The run
// records the revision it measured, read before AND after, so a mid-run cutover
// cannot be mistaken for a verdict on the sha it started on.)
//
// Landed in the repo on t_f0c9d881 (2026-10-22). Between the fix and the landing,
// three lines moved for lint hygiene only — the unused locals (`setup`, the sheet
// wait's binding) dropped, the wait ceiling quoted in the failure note, and
// Uint8Array where Node's Buffer was used (AbortSignal.timeout is declared for
// scripts/ in eslint.config.mjs) — because a probe the app's own lint refuses is a
// probe that reddens the repo's gate. No assertion, selector or threshold moved: the
// row-by-row parity is in live-measure-fiddy.PARITY.md, and this file's own run from
// the repo reads 7/7 on the revision release.json names.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SITE = process.env.LIVE_SITE ?? 'https://fiddy.fun';
const DOMAIN = new URL(SITE).host;
const FIDDY_REPO = process.env.FIDDY_REPO ?? '/Users/lc/Projects/fiddy';
const CHANNEL_TOKEN = 'LIVEMEAS';
const NONCE = 'c'.repeat(128);
const FID = 3;
const HANDLE = 'dwr';
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Where a write is a WRITE (t_be74ab52's classification, kept).
const CHAIN_HOSTS = ['haatz.quilibrium.com', 'relay.farcaster.xyz', 'api.neynar.com', 'hub.farcaster'];
// Known non-write telemetry: the page's own beacons. Reported, never counted as a write.
const TELEMETRY_HOSTS = [
  'ph.neynar.com',
  'wallet.farcaster.xyz',
  'privy.farcaster.xyz',
  'csp-report.browser-intake-datadoghq.com',
];
// Per-step wait ceiling. This box needs 30-60 s to boot the deployed SPA.
const BOOT = Number(process.env.LIVE_BOOT_MS ?? 180_000);

// ── the SIWF signer ─────────────────────────────────────────────────────────
// Same key, same SIWE message shape as the probe. viem is resolved from the
// client repo when the driver's own node_modules cannot see it, so the file runs
// from a scratch dir unchanged.
const loadSigner = async () => {
  const attempts = [];
  try {
    const accounts = await import('viem/accounts');
    const siwe = await import('viem/siwe');
    return { ...accounts, ...siwe };
  } catch (error) {
    attempts.push(String(error).slice(0, 120));
  }
  const root = `${FIDDY_REPO}/apps/farcaster-web/node_modules/viem/_esm`;
  try {
    const accounts = await import(`file://${root}/accounts/index.js`);
    const siwe = await import(`file://${root}/siwe/index.js`);
    return { ...accounts, ...siwe };
  } catch (error) {
    attempts.push(String(error).slice(0, 120));
  }
  throw new Error(`viem could not be resolved (tried node_modules, ${root}): ${attempts.join(' | ')}`);
};

const { privateKeyToAccount, createSiweMessage } = await loadSigner();
const signer = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const message = createSiweMessage({
  address: signer.address,
  chainId: 10,
  domain: DOMAIN,
  nonce: NONCE,
  uri: `${SITE}/login`,
  version: '1',
});
const signature = await signer.signMessage({ message });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'content-type': 'application/json',
};

// Held pending until the creation sheet has been read (fix 3). Released
// explicitly, and on a 90 s fuse so the client's own 120 s channel timeout is
// never the thing that decides this run.
let holdSignInUntil = Date.now() + 90_000;

const result = {
  site: SITE,
  ranAt: new Date().toISOString(),
  driver: (() => {
    try {
      const file = fileURLToPath(import.meta.url);
      return { file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
    } catch {
      return { file: 'measure/live-measure-fiddy.mjs' };
    }
  })(),
  release: { url: `${SITE}/release.json`, atStart: null, atEnd: null, entryChunk: null },
  checks: [],
  abortedWrites: [],
  chainWrites: [],
  telemetryWrites: [],
  unclassifiedWrites: [],
  notes: [],
  timings: {},
};
const check = (name, ok, detail = '') => result.checks.push({ name, ok: Boolean(ok), detail });
const note = (...parts) => result.notes.push(parts.join(' '));

const readRelease = async () => {
  const response = await fetch(`${SITE}/release.json`, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(30_000),
  });
  return response.json();
};

// The served entry chunk, by name, length and sha256 — the same bytes the
// measurement below drove. Cheap enough to leave in, and it is what lets a
// reader tell "the client was slow" from "the client changed under me".
const readEntryChunk = async () => {
  const html = await (await fetch(`${SITE}/`, { signal: AbortSignal.timeout(60_000) })).text();
  const match = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/);
  if (!match) return null;
  const url = `${SITE}${match[0]}`;
  // Uint8Array, not Buffer: the byte count and the sha are all this needs, and a
  // probe that reaches for Node's Buffer is a probe the app's lint refuses.
  const bytes = new Uint8Array(
    await (await fetch(url, { signal: AbortSignal.timeout(180_000) })).arrayBuffer(),
  );
  return {
    path: match[0],
    url,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

const hostOf = (entry) => {
  const url = entry.split(' ').slice(1).join(' ');
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
const hostMatches = (hostname, pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`);

// What a cross-origin write IS. 'chain' = a write to the Farcaster node or
// relay; 'telemetry' = a named non-write beacon; 'unclassified' = anything
// else, which reds the write row exactly as an unknown POST should.
const classifyWrite = (entry) => {
  const hostname = hostOf(entry);
  if (CHAIN_HOSTS.some((pattern) => hostMatches(hostname, pattern))) return 'chain';
  if (TELEMETRY_HOSTS.some((pattern) => hostMatches(hostname, pattern))) return 'telemetry';
  return 'unclassified';
};

// The write row's own honesty check, runnable without waiting for a beacon to
// fire: does it still red for a write, and for a host nobody has classified?
//   LIVE_SELFCHECK=1 node measure/live-measure-fiddy.mjs
if (process.env.LIVE_SELFCHECK === '1') {
  const cases = [
    'POST https://ph.neynar.com/flags/',
    'POST https://wallet.farcaster.xyz/cdn-cgi/rum',
    'POST https://privy.farcaster.xyz/api/v1/analytics_events',
    'POST https://csp-report.browser-intake-datadoghq.com/api/v2/logs',
    'POST https://haatz.quilibrium.com/v1/submitMessage',
    'POST https://relay.farcaster.xyz/v1/channel',
    'PUT https://api.neynar.com/v2/farcaster/cast',
    'POST https://some.unknown.example/collect',
  ].map((entry) => {
    const kind = classifyWrite(entry);
    return { entry, kind, row: kind === 'telemetry' ? 'green' : 'red' };
  });
  console.log(JSON.stringify({ selfCheck: 'the write row', cases }, null, 2));
  process.exit(0);
}

// What release this run measures, read before and after (see the footer).
try {
  result.release.atStart = await readRelease();
  result.timings.entryChunk_ms = Date.now();
  result.release.entryChunk = await readEntryChunk();
  result.timings.entryChunk_ms = Date.now() - result.timings.entryChunk_ms;
} catch (error) {
  note(`release.json / entry chunk read failed: ${String(error).slice(0, 200)}`);
}

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();

// One route table for the whole context: the stub, and the write abort. Applied
// per-context so the mobile page (if a second one is needed) is covered too.
await context.route('**/*', async (route) => {
  const request = route.request();
  const url = request.url();
  const method = request.method();

  if (url.startsWith('https://relay.farcaster.xyz')) {
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
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
        state: Date.now() < holdSignInUntil ? 'pending' : 'completed',
        nonce: NONCE,
        message,
        signature,
        fid: FID,
        username: HANDLE,
        displayName: HANDLE,
      }),
    });
  }

  if (WRITE_METHODS.has(method) && !url.startsWith(SITE)) {
    result.abortedWrites.push(`${method} ${url}`);
    return route.abort();
  }
  return route.continue();
});

const bodyText = (target, length = 240) =>
  target.evaluate(
    (n) => (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, n),
    length,
  );

const waitFor = async (promise, label, timeout = BOOT) =>
  promise.then(
    () => true,
    (error) => {
      note(`${label}: ${String(error).slice(0, 140)} (ceiling ${timeout} ms)`);
      return false;
    },
  );

// Every account-switcher entry on the page, with the box it actually occupies
// and whether it belongs to the mobile chrome ('.sm:hidden') or to the rail.
const readEntries = (target) =>
  target.evaluate(() => {
    const inMobileChrome = (node) => {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (parent.classList?.contains('sm:hidden')) return true;
        if (parent.classList?.contains('sm:flex') || parent.classList?.contains('sm:flex-row'))
          return false;
      }
      return false;
    };
    const nodes = Array.from(document.querySelectorAll('[data-fiddy="account-switcher-entry"]'));
    return {
      count: nodes.length,
      entries: nodes.map((node) => {
        const box = node.getBoundingClientRect();
        return {
          text: (node.innerText ?? '').replace(/\s+/g, ' ').trim(),
          w: Math.round(box.width),
          h: Math.round(box.height),
          inMobileChrome: inMobileChrome(node),
        };
      }),
      visibleCount: nodes.filter((node) => node.getBoundingClientRect().width > 0).length,
      firstMatchWidth: nodes[0] ? Math.round(nodes[0].getBoundingClientRect().width) : null,
    };
  });

// A positive signal, shared by the rail and the mobile rows: an entry that
// occupies a real box. The probe read `document.querySelector(...)`, i.e. the
// first node in the DOM, which is the hidden copy of whichever chrome is not in
// use — the same first-match defect as the sheet row.
const waitForVisibleEntry = (target, timeout = BOOT) =>
  waitFor(
    target.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-fiddy="account-switcher-entry"]')).some(
          (node) => node.getBoundingClientRect().width > 0,
        ),
      undefined,
      { timeout },
    ),
    'account-switcher entry with a box',
    timeout,
  );

const clickVisibleEntry = (target) =>
  target.evaluate(() => {
    const node = Array.from(
      document.querySelectorAll('[data-fiddy="account-switcher-entry"]'),
    ).find((candidate) => candidate.getBoundingClientRect().width > 0);
    if (!node) return 'no-visible-entry';
    node.click();
    return 'clicked';
  });

// The sign-in itself: from the setup screen, press the button whose copy says
// what it does, then wait for the shell the session unlocks.
const startSignIn = async (target) => {
  await target.goto(`${SITE}/welcome/ready`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  const onboarding = await waitFor(
    target.waitForSelector('[data-fiddy="onboarding"]', { timeout: BOOT }),
    '/welcome/ready onboarding surface',
    BOOT,
  );
  const signIn = target.locator('button:has-text("sign in with Farcaster")').first();
  const seen = await target
    .locator('button:has-text("sign in with Farcaster")')
    .first()
    .waitFor({ state: 'visible', timeout: BOOT })
    .then(() => true)
    .catch(() => false);
  const label = seen ? (await signIn.innerText()).replace(/\s+/g, ' ').trim() : null;
  if (seen) {
    await signIn.click({ timeout: 60_000, force: true }).catch((error) => note(`sign-in click: ${String(error).slice(0, 120)}`));
  }
  return { onboarding, seen, label, body: await bodyText(target) };
};

// ── 1. the sign-in modal on the deployed setup screen ───────────────────────
try {
  const opened = await startSignIn(page);
  check('the sign-in entry is on the deployed setup screen', opened.seen, JSON.stringify(opened));
  note(`/welcome/ready: ${opened.body}`);

  // ── 2. the entry inside the sign-in modal ────────────────────────────────
  const inModalSelector =
    '[role=dialog] [data-fiddy="create-account-entry"], #modal-root [data-fiddy="create-account-entry"], [data-radix-portal] [data-fiddy="create-account-entry"]';
  const modalEntry = page.locator(inModalSelector).first();
  const modalEntryBoxed = await waitFor(
    modalEntry.waitFor({ state: 'visible', timeout: BOOT }),
    'the in-modal create-account entry with a box',
    BOOT,
  );
  const modalState = await page.evaluate(() => {
    const entries = Array.from(document.querySelectorAll('[data-fiddy="create-account-entry"]'));
    const inModal = entries.filter((element) =>
      Boolean(element.closest('[role=dialog], #modal-root, [data-radix-portal]')),
    );
    return {
      entries: entries.length,
      entriesInModal: inModal.length,
      all: entries.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          w: Math.round(box.width),
          h: Math.round(box.height),
          inModal: Boolean(element.closest('[role=dialog], #modal-root, [data-radix-portal]')),
        };
      }),
      entryText: inModal[0] ? inModal[0].textContent.replace(/\s+/g, ' ').trim() : null,
      body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
    };
  });
  check(
    'the create-account entry is reachable from the sign-in modal',
    modalState.entriesInModal > 0,
    JSON.stringify({ ...modalState, inModalEntryHasBox: modalEntryBoxed }),
  );

  // ── 3. that entry opens the creation sheet ──────────────────────────────
  // The in-modal node, clicked where it is, then a wait for the sheet marker.
  // A Playwright click is tried first (it is the honest "a user clicked it"),
  // and a DOM click on the same in-modal node is the fallback: the sheet is
  // animated, and Playwright's actionability wait can refuse a moving target.
  const marked = Date.now();
  let mechanism = 'playwright-click';
  let raised = '';
  if (modalEntryBoxed) {
    try {
      await modalEntry.click({ timeout: 30_000, force: true });
    } catch (error) {
      raised = String(error).slice(0, 120);
    }
  }
  let sheetOpened = await waitFor(
    page.waitForSelector('[data-fiddy="create-account"]', { timeout: 20_000 }),
    'creation sheet after the playwright click',
    20_000,
  );
  let domClicked = null;
  if (!sheetOpened) {
    domClicked = await page.evaluate(() => {
      const node = Array.from(
        document.querySelectorAll('[data-fiddy="create-account-entry"]'),
      ).find((element) =>
        Boolean(element.closest('[role=dialog], #modal-root, [data-radix-portal]')),
      );
      if (!node) return false;
      node.click();
      return true;
    });
    mechanism = `dom-click on the in-modal node (playwright click ${raised ? 'raised' : 'missed'})`;
    sheetOpened = await waitFor(
      page.waitForSelector('[data-fiddy="create-account"]', { timeout: BOOT }),
      'creation sheet after the DOM click',
      BOOT,
    );
  }
  result.timings.creationSheetFromClick_ms = Date.now() - marked;
  const sheetState = await page.evaluate(() => {
    const sheet = document.querySelector('[data-fiddy="create-account"]');
    return {
      sheet: Boolean(sheet),
      headline: sheet ? sheet.innerText.replace(/\s+/g, ' ').slice(0, 200) : null,
      body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
    };
  });
  check(
    'the entry opens the account-creation sheet',
    sheetOpened && sheetState.sheet,
    JSON.stringify({ ...sheetState, mechanism, domClicked }),
  );
  note(`creation sheet headline: ${sheetState.headline}`);

  // The modal has been read; let the client finish signing in.
  holdSignInUntil = 0;

  // ── 4. the rail's switcher, signed in through the stubbed relay ─────────
  // Two-way signal per attempt: an entry that occupies a box (the signed-in
  // rail — what the row asserts) OR a shell that has finished booting and is
  // signed out. Without the second half, a signed-out shell can only be told
  // apart from a slow boot by waiting the whole ceiling out — which is what
  // cost the first version of this driver 180 s. The row still asserts the box.
  let rail = { found: false };
  for (let attempt = 0; attempt < 3 && !rail.found; attempt += 1) {
    await page.goto(`${SITE}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    const decided = await waitFor(
      page.waitForFunction(
        () => {
          const boxed = Array.from(
            document.querySelectorAll('[data-fiddy="account-switcher-entry"]'),
          ).some((node) => node.getBoundingClientRect().width > 0);
          const text = (document.body?.innerText ?? '').trim();
          return boxed || (text.length > 0 && !text.startsWith('Loading Fiddy'));
        },
        undefined,
        { timeout: BOOT },
      ),
      `the shell on / (attempt ${attempt})`,
      BOOT,
    );
    const state = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('[data-fiddy="account-switcher-entry"]'));
      const text = (document.body?.innerText ?? '').trim();
      return {
        boxed: nodes.some((node) => node.getBoundingClientRect().width > 0),
        booted: text.length > 0 && !text.startsWith('Loading Fiddy'),
        body: text.replace(/\s+/g, ' ').slice(0, 240),
      };
    });
    if (state.boxed) {
      rail = { found: true, attempt, ...(await readEntries(page)), body: state.body };
    } else {
      rail = { found: false, attempt, decided, ...state };
      // Not signed in (the creation sheet interrupted the sign-in poll, or the
      // shell never drew): start the sign-in again — the probe's own retry —
      // then come back to the shell.
      holdSignInUntil = 0;
      await startSignIn(page);
    }
  }
  check('the rail carries the account switcher on the deployed build', rail.found, JSON.stringify(rail));

  // ── 5. the switcher sheet opens from the rail ───────────────────────────
  let switcher = { open: false };
  if (rail.found) {
    let clicked = 'not-clicked';
    for (let attempt = 0; attempt < 4 && !switcher.open; attempt += 1) {
      clicked = await clickVisibleEntry(page);
      await waitFor(
        page.waitForSelector('[data-fiddy="account-switcher"]', { timeout: 20_000 }),
        `switcher sheet (attempt ${attempt})`,
        20_000,
      );
      switcher = await page.evaluate((value) => {
        const sheet = document.querySelector('[data-fiddy="account-switcher"]');
        return {
          open: Boolean(sheet),
          text: sheet ? sheet.innerText.replace(/\s+/g, ' ').slice(0, 300) : null,
          clicked: value,
        };
      }, clicked);
    }
    check('the switcher sheet opens from the rail', switcher.open, JSON.stringify(switcher));
    note(`switcher sheet: ${switcher.text}`);
  } else {
    note(`rail read: ${JSON.stringify(rail)}`);
  }

  // ── 6. the mobile menu ─────────────────────────────────────────────────
  // The session is real on this page, and the mobile chrome is CSS-hidden at
  // desktop width and appears when the page is sized down — so: close the
  // switcher sheet if it is open, size the SIGNED-IN page down, then click the
  // menu toggle by its label. The toggle is the nav button whose label is
  // `currentPageTitle ?? 'Menu'` (src/layouts/MobileHeader.tsx) — 'Home' on
  // this route, and it carries no aria-label, which is why the probe's scan of
  // `header button`s came back empty ("tried": []) — the mobile chrome lives in
  // a <nav> inside <main>, not in a <header>.
  if (switcher.open) {
    await page.evaluate(() => {
      const sheet = document.querySelector('[data-fiddy="account-switcher"]');
      const close = Array.from(sheet?.querySelectorAll('button') ?? []).find((button) =>
        /^close$/i.test((button.innerText ?? '').trim()),
      );
      close?.click();
    });
    await waitFor(
      page.waitForSelector('[data-fiddy="account-switcher"]', { state: 'detached', timeout: 30_000 }),
      'the switcher sheet closing',
      30_000,
    );
  }

  const markedMobile = Date.now();
  await page.setViewportSize({ width: 390, height: 844 });
  const toggleSelector = 'nav button:has(span.font-semibold):visible';
  const toggle = page.locator(toggleSelector).first();
  let toggleVisible = await waitFor(
    toggle.waitFor({ state: 'visible', timeout: BOOT }),
    'the mobile menu toggle',
    BOOT,
  );
  let toggleLabel = null;
  let mobilePage = page;
  let mobileReload = false;
  if (!toggleVisible) {
    // Fallback, still the same page-under-test: a fresh load in the same signed-in
    // context at phone size. (The probe used a second page; this keeps the
    // session that was just proven.)
    mobileReload = true;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => {});
    toggleVisible = await waitFor(
      toggle.waitFor({ state: 'visible', timeout: BOOT }),
      'the mobile menu toggle after reload',
      BOOT,
    );
  }
  if (toggleVisible) toggleLabel = (await toggle.innerText()).replace(/\s+/g, ' ').trim();

  // Before the toggle is pressed: the switcher must NOT already be showing — a
  // row called "the mobile menu carries the account switcher" that passes with
  // the menu shut is the green-void this probe exists to avoid. Read first,
  // click second, and require the change.
  const beforeMenu = await readEntries(page);

  let clickedBy = null;
  if (toggleVisible) {
    const byLabel = mobilePage.getByRole('button', { name: toggleLabel, exact: true });
    const labelled = await byLabel.count().catch(() => 0);
    try {
      if (labelled === 1) {
        await byLabel.click({ timeout: 60_000 });
        clickedBy = `role:${toggleLabel}`;
      } else {
        await toggle.click({ timeout: 60_000, force: true });
        clickedBy = `structure:${toggleLabel} (role matched ${labelled})`;
      }
    } catch (error) {
      await toggle.click({ timeout: 60_000, force: true }).catch(() => {});
      clickedBy = `structure:${toggleLabel} (role click: ${String(error).slice(0, 80)})`;
    }
  }

  // Positive signal: an entry that occupies a real box = the open menu sheet.
  const entryVisible = toggleVisible ? await waitForVisibleEntry(page) : false;
  const mobileState = await readEntries(page);
  const menus = await page.evaluate(() => ({
    navButtons: Array.from(document.querySelectorAll('nav button')).map((button) => {
      const box = button.getBoundingClientRect();
      return {
        label: (button.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
        aria: button.getAttribute('aria-label'),
        w: Math.round(box.width),
        y: Math.round(box.y),
      };
    }),
    body: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 240),
  }));
  result.timings.mobileMenu_ms = Date.now() - markedMobile;
  check(
    'the mobile menu carries the account switcher',
    mobileState.visibleCount > 0 && beforeMenu.visibleCount === 0,
    JSON.stringify({
      ...mobileState,
      switcherVisibleBeforeTheMenu: beforeMenu.visibleCount,
      beforeMenu,
      menuToggle: { found: toggleVisible, label: toggleLabel, clickedBy },
      menuOpenBackedByBox: entryVisible,
      reloadedAtPhoneSize: mobileReload,
      ...menus,
    }),
  );
  note(`mobile: toggle=${toggleLabel ?? 'not found'} clickedBy=${clickedBy} entries=${JSON.stringify(mobileState.entries)}`);
} catch (error) {
  note(`flow stopped: ${String(error).slice(0, 400)}`);
}

// ── 7. writes: the chain, and the telemetry that is not a write ────────────
for (const entry of result.abortedWrites) {
  const kind = classifyWrite(entry);
  if (kind === 'chain') result.chainWrites.push(entry);
  else if (kind === 'telemetry') result.telemetryWrites.push(entry);
  else result.unclassifiedWrites.push(entry);
}
check(
  'no write left the machine during this measurement',
  result.chainWrites.length === 0 && result.unclassifiedWrites.length === 0,
  JSON.stringify({
    meaning:
      'writes to the Farcaster node/relay (and any POST to a host that is not a named beacon) — the page’s own telemetry is reported separately',
    chainWrites: result.chainWrites,
    unclassifiedWrites: result.unclassifiedWrites,
    telemetry: result.telemetryWrites,
  }),
);

try {
  result.release.atEnd = await readRelease();
} catch (error) {
  note(`release.json at end failed: ${String(error).slice(0, 200)}`);
}
result.sha = result.release.atStart?.revision ?? null;
if (
  result.release.atStart?.revision &&
  result.release.atEnd?.revision &&
  result.release.atStart.revision !== result.release.atEnd.revision
) {
  note(
    `CUTOVER MID-RUN: ${result.release.atStart.revision} → ${result.release.atEnd.revision}: this run's verdict is on ${result.release.atStart.revision} only`,
  );
}
result.timings.total_ms = Date.now() - Date.parse(result.ranAt);

await browser.close();

const passed = result.checks.filter((entry) => entry.ok).length;
result.summary = `${passed}/${result.checks.length} checks passed on ${result.sha ?? 'unknown sha'}`;
console.log(JSON.stringify(result, null, 2));
console.log(`\n${result.summary}`);
process.exit(0);