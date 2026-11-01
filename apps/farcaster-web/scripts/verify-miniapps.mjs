// End-to-end: do the mini apps work in a signed-in client?
//
//   SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//   VITE_SNAPCHAIN_DEBUG=true \
//   npx vite --config scripts/probe.vite.config.mjs --port 5175
//   MINIAPP_SERVER=https://localhost:5175 node scripts/verify-miniapps.mjs
//
// The report this measures (user, live, 2026-10-21): `/miniapps` answered
//   "This page isn't on your node — No node-backed reader has been written for
//    this endpoint yet."
// Two things have to be true for that report to be closed, and this probe
// measures both in the running client, signed in as a real account:
//
//   1. the mini-app surfaces (list, and the "your apps" strip) read their apps
//      from Neynar's catalog — asserted from the network: the catalog request
//      goes to api.neynar.com and NO catalog read is sent to the node, with the
//      live catalog's own app names on screen;
//   2. a cast that embeds a real mini-app URL renders the app's CARD (its own
//      art and button) instead of a plain link, and pressing it LAUNCHES the
//      app — asserted by the app's own address appearing in a frame.
//
// The fixture casts are the account's own (fid 191554): two casts embed
// `https://fiddy.fun/client/deploy` and `https://fiddy.fun/FSSC/`, both real
// mini apps with an fc:miniapp tag on the page and a manifest Neynar knows.
// Only the SIWF relay is stubbed (a REAL SIWE message signed by a throwaway
// key), exactly as scripts/verify-node-backed-client.mjs does. Nothing here
// writes: every read is the node's or Neynar's own.
//
// Screenshots land in $MINIAPP_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.MINIAPP_SERVER ?? 'https://localhost:5175';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.MINIAPP_SHOT_DIR ?? os.tmpdir();
const NODE_ORIGIN = new URL(
  process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com',
).host;
const NEYNAR_KEY = process.env.VITE_NEYNAR_API_KEY ?? '';
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'MINIAPP1';

const FID = Number(process.env.MINIAPP_FID ?? 191554);
const USERNAME = process.env.MINIAPP_USERNAME ?? 'ivc';
/** The account's own cast, embedding the deploy mini app. */
const FIXTURE_CAST =
  process.env.MINIAPP_CAST ??
  '0xacf6cf418b3d312cbbc9141d8540f265567e8428';
const FIXTURE_APP_HOST = 'fiddy.fun';

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

/** Everything the DOM can say about the surface in front of us. */
const surfaceProbe = () => {
  const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  // The centre column, where the surface being measured actually is: the right
  // sidebar carries its own app list, and counting that would let a broken
  // /miniapps pass on next-door's evidence.
  const mainText = ((document.querySelector('main') ?? document.body)?.innerText ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    path: window.location.pathname,
    text,
    mainText,
    images: Array.from(document.querySelectorAll('img')).map((img) => ({
      src: img.currentSrc || img.src || '',
      alt: img.getAttribute('alt') ?? '',
      naturalWidth: img.naturalWidth,
    })),
    buttons: Array.from(
      document.querySelectorAll('button, [role=button], a'),
    ).map((el) => ({
      text: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      href: el.getAttribute('href') ?? '',
    })),
    frames: Array.from(document.querySelectorAll('iframe')).map(
      (frame) => frame.getAttribute('src') ?? '',
    ),
    cannotAnswer: Boolean(
      // Scoped to the centre column: the right sidebar carries an honest
      // "Explore isn't on your node" panel of its own, and letting that count
      // would fail this surface for next-door's refusal.
      (document.querySelector('main') ?? document).querySelector(
        '[data-fiddy="node-cannot-answer"]',
      ),
    ),
    requests: Array.isArray(window.__nodeBackedRequests)
      ? window.__nodeBackedRequests.map((entry) => ({
          method: entry.method,
          path: entry.path,
          kind: entry.kind,
          status: entry.status,
        }))
      : null,
  };
};

const readSurface = async (page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await page.evaluate(surfaceProbe);
    } catch (error) {
      if (
        !/Execution context was destroyed|Target closed|navigat|Cannot read properties of null/i.test(
          String(error),
        )
      ) {
        throw error;
      }
      await page.waitForTimeout(250);
    }
  }
  return { path: '', text: '', images: [], buttons: [], frames: [] };
};

/** The live catalog, fetched here so the expectation is not from memory. */
const fetchCatalogNames = async () => {
  if (!NEYNAR_KEY) {
    return [];
  }
  try {
    const response = await fetch(
      'https://api.neynar.com/v2/farcaster/frame/catalog/?limit=20',
      { headers: { 'x-api-key': NEYNAR_KEY } },
    );
    const body = await response.json();
    return (body.frames ?? [])
      .map(
        (frame) =>
          frame?.manifest?.miniapp?.name ?? frame?.manifest?.frame?.name,
      )
      .filter((name) => typeof name === 'string' && name.length > 2);
  } catch {
    return [];
  }
};

const run = async () => {
  const consoleErrors = [];
  /** Every request the page made, and where it went. */
  const requests = [];
  const browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 240));
    }
  });
  page.on('request', (request) => {
    requests.push({ method: request.method(), url: request.url() });
  });
  page.on('response', (response) => {
    const entry = requests.find(
      (r) => r.url === response.url() && r.status === undefined,
    );
    if (entry) {
      entry.status = response.status();
    }
  });

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
        fid: FID,
        username: USERNAME,
        displayName: USERNAME,
      }),
    });
  });

  // ── 1. sign in ────────────────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(() => /go social/i.test(document.body.innerText), null, {
    timeout: 90000,
  });
  let clicked = null;
  for (let attempt = 0; attempt < 20 && clicked === null; attempt += 1) {
    for (const el of await page.$$('button, a, [role=button]')) {
      const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
      if (/go social/i.test(text)) {
        await el.click();
        clicked = text;
        break;
      }
    }
    if (clicked === null) {
      await page.waitForTimeout(500);
    }
  }
  let after = await readSurface(page);
  for (let i = 0; i < 60; i += 1) {
    after = await readSurface(page);
    if (after.path === '/' && after.text.length > 40) {
      break;
    }
    await page.waitForTimeout(1000);
  }
  check(
    'a completed sign-in lands in the client',
    clicked !== null && after.path === '/',
    `clicked="${clicked}" path=${after.path}`,
  );

  // ── 2. /miniapps ──────────────────────────────────────────────────────────
  requests.length = 0;
  const catalogNames = await fetchCatalogNames();
  await page.goto(`${SERVER}/miniapps`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  let miniApps = await readSurface(page);
  for (let i = 0; i < 45; i += 1) {
    miniApps = await readSurface(page);
    if (
      /Top mini apps/i.test(miniApps.mainText ?? '') &&
      miniApps.images.some((image) => image.naturalWidth > 0)
    ) {
      break;
    }
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: `${OUT}/miniapps-surface.png`, fullPage: false });

  const catalogRequests = requests.filter((r) =>
    r.url.includes('/v2/farcaster/frame/catalog'),
  );
  const nodeCatalogRequests = requests.filter(
    (r) =>
      r.url.includes('/v1/top-mini-apps') &&
      (r.url.includes(NODE_ORIGIN) || r.url.includes('/snapchain-api')),
  );
  const namesOnScreen = catalogNames.filter((name) =>
    (miniApps.mainText ?? '').includes(name),
  );

  check(
    'the mini-apps surface does NOT show “isn’t on your node”',
    !miniApps.cannotAnswer &&
      !/no node-backed reader has been written|isn’t on your node/i.test(
        miniApps.mainText ?? '',
      ),
    miniApps.cannotAnswer
      ? 'the node-cannot-answer panel is in the centre column'
      : `no refusal panel in the centre column; centre text: ${(miniApps.mainText ?? '').slice(0, 120)}`,
  );
  check(
    'the list is read from Neynar’s catalog, and not from the node',
    catalogRequests.length > 0 &&
      catalogRequests.every((r) => (r.status ?? 0) === 200) &&
      nodeCatalogRequests.length === 0,
    `${catalogRequests.length} catalog request(s) to api.neynar.com (status ${catalogRequests
      .map((r) => r.status)
      .join(',')}); ${nodeCatalogRequests.length} sent to the node`,
  );
  check(
    'the ranked list is ON the page itself, not only in the sidebar',
    /Top mini apps/i.test(miniApps.mainText ?? '') && namesOnScreen.length >= 3,
    `${namesOnScreen.length}/${catalogNames.length} of the live catalog's names in the main content: ${namesOnScreen
      .slice(0, 5)
      .join(' | ')}`,
  );
  check(
    'the surface is not the empty-list fallback',
    !/No mini apps available/i.test(miniApps.mainText ?? ''),
    (miniApps.mainText ?? '').slice(0, 160),
  );

  // ── 3. a cast that embeds a mini app ──────────────────────────────────────
  requests.length = 0;
  await page.goto(`${SERVER}/~/conversations/${FIXTURE_CAST}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  let castPage = await readSurface(page);
  for (let i = 0; i < 45; i += 1) {
    castPage = await readSurface(page);
    if (
      castPage.images.some(
        (image) =>
          image.src.includes(FIXTURE_APP_HOST) && image.naturalWidth > 0,
      )
    ) {
      break;
    }
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: `${OUT}/miniapp-embed-card.png`, fullPage: false });

  /** The card: an image that is the app's own art, with a button beside it. */
  const cardImages = castPage.images.filter(
    (image) =>
      image.src.includes(FIXTURE_APP_HOST) &&
      !image.src.includes('/icon') &&
      !image.src.includes('/pfp'),
  );
  const cardImage = cardImages[0];
  /**
   * The button's words. The card draws the button title the mini app itself
   * declared — the same string the app's art carries as its alt text — so the
   * label is taken off the live card rather than guessed at from this file.
   */
  const cardButtonLabel = (cardImage?.alt ?? '').trim();
  const cardButton = cardButtonLabel
    ? castPage.buttons.find((b) => b.text === cardButtonLabel)
    : undefined;
  check(
    'the cast’s mini app renders as its CARD, with the app’s own art',
    cardImage !== undefined,
    cardImage !== undefined
      ? cardImage.src.slice(0, 110)
      : `no app-art image; ${castPage.images.length} images on the cast page`,
  );
  check(
    'the card carries a button that opens the app',
    Boolean(cardButton),
    cardButton
      ? `button "${cardButton.text}"`
      : `no button labelled "${cardButtonLabel}”; no launch-looking element`,
  );

  // Press it: the app must actually launch.
  let launched = false;
  let frames = [];
  if (cardButton) {
    const clickedButton = await page.evaluateHandle((label) => {
      const els = Array.from(
        document.querySelectorAll('button, [role=button], a, div'),
      );
      return els.find(
        (el) =>
          (el.innerText ?? '').replace(/\s+/g, ' ').trim() === label &&
          el.getBoundingClientRect().width > 0,
      );
    }, cardButton.text);
    if (clickedButton) {
      await clickedButton.asElement().click();
    }
    for (let i = 0; i < 30; i += 1) {
      await page.waitForTimeout(1000);
      const now = await readSurface(page);
      frames = now.frames;
      if (frames.some((src) => src.includes(FIXTURE_APP_HOST))) {
        launched = true;
        break;
      }
    }
    await page.screenshot({ path: `${OUT}/miniapp-launched.png`, fullPage: false });
  }
  check(
    'pressing it launches the app in the client’s mini-app host',
    launched,
    launched
      ? frames.filter((src) => src.includes(FIXTURE_APP_HOST))[0]
      : `no frame pointing at ${FIXTURE_APP_HOST}; frames: ${JSON.stringify(frames).slice(0, 200)}`,
  );

  await browser.close();

  const passed = checks.filter((c) => c.ok).length;
  console.log(`\nminiapps probe: ${passed}/${checks.length} checks passed`);
  for (const c of checks) {
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`);
  }
  if (consoleErrors.length > 0) {
    console.log(`\n${consoleErrors.length} console error(s), first few:`);
    for (const line of consoleErrors.slice(0, 6)) {
      console.log(`  - ${line}`);
    }
  }
  process.exit(passed === checks.length ? 0 : 1);
};

await run();