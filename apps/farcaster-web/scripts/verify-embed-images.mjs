// End-to-end: does a photo in a cast render as a PHOTO, from the live node?
//
//   SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//   npx vite --config scripts/probe.vite.config.mjs --port 5174
//   EMBED_SERVER=https://localhost:5174 node scripts/verify-embed-images.mjs
//
// BOTH variables, MEASURED: `SNAPCHAIN_HTTP_URL` points the dev server's
// `/snapchain-api` relay at the node, but the shell only runs the node-backed
// client when the *build* names a server (`isNodeConfigured()` reads
// `VITE_SNAPCHAIN_HTTP_URL`), and with only the first one a completed sign-in
// lands on the device-only landing — zero casts read, no photo to check.
//
// The bug this measures (user-reported, screenshot verified): a cast whose embed
// is a Cloudflare image-delivery URL — `https://imagedelivery.net/<account>/
// <id>/original`, which carries NO file extension — rendered as a link card:
// a chain-link icon above a blank meta box. The protocol sends a bare URL, so
// the adapter has to establish the media type itself, and extension sniffing
// cannot see one of these.
//
// The probe signs in as the account whose cast was reported and reads its HOME
// FEED from the live node — the same surface, the same session shape, the same
// read as the report. Only the SIWF relay is stubbed (a REAL SIWE message
// signed by a throwaway key, so the app's own verifier accepts the sign-in for
// real), exactly as scripts/verify-node-backed-client.mjs does. Nothing here
// writes: every read is the node's own.
//
// WHAT IT ASSERTS (each one measured in the DOM of the running client)
//   1. sign-in lands in the client
//   2. the reported cast renders its Cloudflare photo as an <img> whose src is
//      that very URL, and that <img> really loaded (a drawn box, not a broken
//      one)
//   3. the embeds the node returned that are NOT media are NOT drawn as images:
//      the classifier must not call every URL a photo
//   4. profile avatars render as <img>, against the pfp URL the node's own
//      user-data read returned (not against one this probe invented)
//   5. the mechanism is visible: the client asked the image host what the URL
//      was (a HEAD) before the photo was drawn
//
// Screenshots land in $EMBED_SHOT_DIR (default: the system temp dir).

import os from 'node:os';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.EMBED_SERVER ?? 'https://localhost:5174';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.EMBED_SHOT_DIR ?? os.tmpdir();
/** The node this dev server proxies to — reads may go direct or via the relay. */
const NODE_ORIGIN = new URL(
  process.env.SNAPCHAIN_HTTP_URL ?? 'https://haatz.quilibrium.com',
).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'EMBEDIMG1';

/** The account from the report, the cast it posted, and the photo in it. */
const REPORTED_FID = Number(process.env.EMBED_FID ?? 191554);
const REPORTED_USERNAME = process.env.EMBED_USERNAME ?? 'ivc';
const REPORTED_PHOTO_ID = 'a62d038c-974d-4c48-a658-c764f4205c00';
const REPORTED_CAST_TEXT = 'notifications come through via the NS app';

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

/** Everything the DOM can say about pictures, in one round trip. */
const imageProbe = () => {
  const images = Array.from(document.querySelectorAll('img')).map((img) => ({
    src: img.currentSrc || img.src || '',
    naturalWidth: img.naturalWidth,
    naturalHeight: img.naturalHeight,
    width: Math.round(img.getBoundingClientRect().width),
    height: Math.round(img.getBoundingClientRect().height),
    alt: img.getAttribute('alt') ?? '',
  }));
  // A read taken mid-navigation can find no body at all; the caller retries.
  const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
  return {
    path: window.location.pathname,
    text,
    images,
    deviceOnlyLanding: Boolean(
      document.querySelector('[data-fiddy="device-only-session"]'),
    ),
    onboardingSheet: Boolean(document.querySelector('[data-fiddy="onboarding"]')),
    errorText:
      /Could not reach Farcaster|Error retrieving data|Something went wrong/i.test(
        text,
      ),
  };
};

const readImages = async (page) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await page.evaluate(imageProbe);
    } catch (error) {
      // A destroyed context, a closed target, or a read that landed between
      // documents: all three mean "ask again", not "the app is broken".
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
  return { path: '', text: '', images: [] };
};

const withSrc = (surface, needle) =>
  surface.images.filter((image) => image.src.includes(needle));
const loaded = (image) => image.naturalWidth > 0;

/**
 * Bring a picture on screen. The feed is long and a cast card's photo is lazily
 * loaded, so an off-screen <img> is in the DOM with `naturalWidth` 0 because its
 * bytes were never requested — MEASURED: without this the reported cast's photo
 * sat at 0x0 for the whole two-minute wait while the very same URL served
 * `image/jpeg` to `curl`, and the first cast on screen (a poidh.xyz link) is not
 * the one being looked for.
 */
const scrollToPhoto = async (page, needle) => {
  await page.evaluate((asset) => {
    const img = Array.from(document.querySelectorAll('img')).find((el) =>
      (el.currentSrc || el.src || '').includes(asset),
    );
    if (img) {
      img.scrollIntoView({ block: 'center', inline: 'center' });
    }
  }, needle);
};

/**
 * Wait until a picture whose src carries `needle` is in the DOM *and* loaded,
 * having first brought it on screen so the browser actually asks for it.
 */
const waitForPhoto = async (page, needle, tries = 60) => {
  let surface = await readImages(page);
  for (let i = 0; i < tries; i += 1) {
    surface = await readImages(page);
    const matches = withSrc(surface, needle);
    if (matches.length > 0 && matches.some(loaded)) {
      return { surface, matches };
    }
    if (matches.length > 0) {
      await scrollToPhoto(page, needle);
      await page.waitForTimeout(1000);
      continue;
    }
    await page.waitForTimeout(2000);
  }
  return { surface, matches: withSrc(surface, needle) };
};

const run = async () => {
  const consoleErrors = [];
  /** Requests the browser made to the image host — the classifier at work. */
  const imageHostRequests = [];
  /** pfp URLs the node's own user-data reads returned, by fid. */
  const pfpByFid = new Map();
  /** Every embed URL the node's casts actually carried. */
  const nodeEmbedUrls = new Set();
  const nodeCastTexts = [];
  const nodeRoutes = [];

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
  page.on('pageerror', (e) =>
    consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`),
  );
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('imagedelivery.net')) {
      imageHostRequests.push({ method: request.method(), url });
    }
  });
  page.on('response', async (response) => {
    const url = response.url();
    // The provider ladder can reach the node either way: directly (the node
    // answers plain GETs cross-origin with `*`) or through this dev server's
    // `/snapchain-api` relay. Both are the node's own routes.
    const viaRelay = url.includes('/snapchain-api/');
    const viaNode = url.includes(NODE_ORIGIN);
    if (!viaRelay && !viaNode) {
      return;
    }
    const path = viaRelay
      ? new URL(url).pathname.replace(/^\/snapchain-api/, '')
      : new URL(url).pathname;
    nodeRoutes.push(`${response.status()} ${path.split('?')[0]}`);

    if (path.startsWith('/v1/castsByFid') && response.status() === 200) {
      try {
        const body = await response.json();
        for (const msg of body.messages ?? []) {
          const castAddBody = msg?.data?.castAddBody;
          if (typeof castAddBody?.text === 'string' && castAddBody.text) {
            nodeCastTexts.push(castAddBody.text);
          }
          for (const embed of castAddBody?.embeds ?? []) {
            if (typeof embed?.url === 'string') {
              nodeEmbedUrls.add(embed.url);
            }
          }
        }
      } catch {
        /* the read is still evidence through the request log */
      }
    }

    if (path.startsWith('/v1/userDataByFid') && response.status() === 200) {
      try {
        const body = await response.json();
        const fid = Number(new URL(url).searchParams.get('fid'));
        for (const msg of body.messages ?? []) {
          const userData = msg?.data?.userDataBody;
          if (userData?.type === 'USER_DATA_TYPE_PFP' && userData.value) {
            pfpByFid.set(fid, userData.value);
          }
        }
      } catch {
        /* as above */
      }
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
        fid: REPORTED_FID,
        username: REPORTED_USERNAME,
        displayName: REPORTED_USERNAME,
      }),
    });
  });

  // ── 1. sign in as the account from the report ─────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // MEASURED: `/welcome/ready` renders its steps in sequence, so "the page has
  // text" is already true while an earlier step is still on screen and the
  // sign-in button does not exist yet. Wait for the button itself. The deadline
  // is Playwright's THIRD argument: passed second it is read as the page
  // function's argument and the wait silently falls back to 30s, which a cold
  // dev server on the first request can exceed while it compiles the app.
  await page.waitForFunction(
    () => /go social/i.test(document.body.innerText),
    null,
    { timeout: 90000 },
  );

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

  let afterSignIn = await readImages(page);
  for (let i = 0; i < 60; i += 1) {
    afterSignIn = await readImages(page);
    if (
      afterSignIn.path === '/' &&
      !afterSignIn.deviceOnlyLanding &&
      !afterSignIn.onboardingSheet &&
      afterSignIn.text.length > 40
    ) {
      break;
    }
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: `${OUT}/embed-after-signin.png` });
  check(
    'a completed sign-in lands in the client, on the feed',
    clicked !== null && afterSignIn.path === '/' && !afterSignIn.deviceOnlyLanding,
    `clicked="${clicked}" path=${afterSignIn.path} deviceOnly=${afterSignIn.deviceOnlyLanding} onboarding=${afterSignIn.onboardingSheet}`,
  );

  // ── 2. the reported cast's photo, on the home feed ────────────────────────
  const reported = await waitForPhoto(page, REPORTED_PHOTO_ID, 60);
  await page.screenshot({ path: `${OUT}/embed-report-photo.png` });

  check(
    'the reported cast renders its Cloudflare photo as an <img> (no extension, so nothing to sniff)',
    reported.matches.length > 0,
    reported.matches.length > 0
      ? `${reported.matches.length} img(s): ${reported.matches[0].src.slice(0, 130)}`
      : `no img carrying ${REPORTED_PHOTO_ID}; page has ${reported.surface.images.length} imgs, ${reported.surface.images.filter(loaded).length} loaded`,
  );
  check(
    'that photo really loaded (a drawn box, not a broken image)',
    reported.matches.some(loaded),
    reported.matches.map((i) => `${i.naturalWidth}x${i.naturalHeight}`).join(',') ||
      'no match',
  );
  const castTextFromNode = nodeCastTexts.some((text) =>
    text.includes(REPORTED_CAST_TEXT),
  );
  check(
    "the reported cast's text is on screen, and the node's own bytes carried it",
    castTextFromNode && reported.surface.text.includes(REPORTED_CAST_TEXT),
    `${nodeCastTexts.length} casts read from the node; reported cast among them=${castTextFromNode}`,
  );

  // ── 3. nothing that is a page is drawn as a photo ─────────────────────────
  const pageUrls = [...nodeEmbedUrls].filter(
    (url) => !url.includes('imagedelivery.net') && !url.includes('farcaster.xyz/'),
  );
  const pageUrlsDrawn = pageUrls.filter((url) =>
    reported.surface.images.some((image) => image.src.includes(url)),
  );
  check(
    'a URL that is a page is NOT drawn as an image',
    pageUrlsDrawn.length === 0,
    `${nodeEmbedUrls.size} embed URLs read from the node, ${pageUrls.length} of them pages (${pageUrls
      .slice(0, 3)
      .map((u) => u.slice(0, 60))
      .join(' ')}); drawn as images: ${pageUrlsDrawn.length}`,
  );

  // ── 4. avatars ────────────────────────────────────────────────────────────
  const pfp = pfpByFid.get(REPORTED_FID);
  // The renderer draws images through its own transform host (`wrpcd.net/.../
  // <id>/rectcontain3`), so match the asset's id rather than the host it was
  // served from.
  const pfpId = pfp?.split('/').slice(-2)[0];
  const avatars = pfpId ? withSrc(reported.surface, pfpId) : [];
  check(
    "the account's avatar renders as the pfp image the node returned",
    Boolean(pfp) && avatars.length > 0,
    pfp
      ? `${avatars.length} img(s) for ${pfp.slice(0, 110)}`
      : `the node read returned no pfp user-data message (pfps seen: ${pfpByFid.size})`,
  );
  check(
    'avatar images are loaded, not placeholders',
    avatars.some(loaded),
    avatars.map((i) => `${i.width}x${i.height}`).join(',') || 'none',
  );

  // ── 5. the mechanism, as the browser saw it ───────────────────────────────
  const heads = imageHostRequests.filter((r) => r.method === 'HEAD');
  const gets = imageHostRequests.filter((r) => r.method === 'GET');
  check(
    'the client asked the image host what the URL was (HEAD) before drawing it',
    heads.length > 0,
    `${heads.length} HEAD, ${gets.length} GET to imagedelivery.net`,
  );
  check(
    'the photo came back without the client asking the node for anything new',
    !reported.surface.errorText,
    reported.surface.errorText
      ? reported.surface.text.slice(0, 160)
      : 'no error copy on the feed',
  );

  await browser.close();

  const failed = checks.filter((c) => !c.ok);
  const routeReport = [...new Set(nodeRoutes)].sort();
  console.log('── embed rendering, on the live node, signed in as the reporter ──');
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`,
    );
  }
  console.log(`\n── node routes the read used (${routeReport.length}) ──`);
  for (const route of routeReport.slice(0, 20)) {
    console.log(`  ${route}`);
  }
  console.log(
    `\nconsole errors: ${consoleErrors.length}${
      consoleErrors.length ? ` — first: ${consoleErrors[0]}` : ''
    }`,
  );
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.map((c) => c.name).join(' | ')}`);
    process.exitCode = 1;
  }
};

await run();