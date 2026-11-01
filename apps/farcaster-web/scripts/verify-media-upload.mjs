// End-to-end: a photo picked in the real composer reaches OUR own media host,
// comes back as a URL, and that URL is what the cast payload carries.
//
//   node scripts/verify-media-upload.mjs
//
// Preconditions - the media host and the client on the SAME page origin, which
// is how production is shaped (fiddy.fun serves the client and the bytes). A
// second localhost port would make the browser refuse the upload: an https page
// may not POST to an http URL, and the composer's own error copy is exactly what
// that looks like from the outside ("we couldn't reach the photo host"). So the
// client's dev server proxies the media path through to the service:
//
//   1. the media service (the repo with app/api/fiddy/media):
//        cd /Users/lc/legitmate-farcaster
//        FIDDY_MEDIA_DIR=$HOME/.fiddy-media-dev \
//        FIDDY_MEDIA_PUBLIC_URL=https://localhost:5174 \
//        npx next dev --port 3217
//
//   2. the client, built with the media host it should upload to, a server
//      actually named (the shell only runs the node-backed client when one is —
//      `isNodeConfigured()`, so `VITE_SNAPCHAIN_HTTP_URL` or a chosen server in
//      storage; without it a signed-in session lands on the device-only
//      landing), and with `/api/fiddy/media` proxied to the service (see
//      `scripts/probe.vite.config.mjs`: the app's config plus a `cacheDir` of
//      its own and this proxy):
//        cd apps/farcaster-web
//        SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//        VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//        VITE_FIDDY_MEDIA_URL=https://localhost:5174 VITE_SNAPCHAIN_DEBUG=true \
//        npx vite --config scripts/probe.vite.config.mjs --port 5174
//
//      (without the proxy: MEDIA_SERVER and VITE_FIDDY_MEDIA_URL both point at
//      the service's own origin, which only works when neither side is https)
//
// Only the SIWF relay is stubbed (with a REAL SIWE message signed by a throwaway
// key, so the app's own verifier accepts the sign-in for real), exactly as
// scripts/verify-node-backed-client.mjs does. Nothing here posts to Farcaster:
// the cast submission is answered by the adapter inside the page, which is why
// the payload is read from the adapter's own log.
//
// WHAT IT ASSERTS (each one a real observation, not a shape guess)
//   1. the composer's upload-URL request went to the MEDIA route: the adapter
//      answered `POST /v1/generate-image-upload-url` with our media host
//      (kind 'media') - the request that used to be a 501
//   2. the browser really POSTed the picked bytes to our host and got a 201
//      carrying a URL on that host
//   3. the URL round-trips from a different client: 200, the content type the
//      bytes really are, an immutable cache header, and served bytes whose
//      sha256 is the name in the URL
//   4. a picture with a see-through pixel keeps it: the opaque photo above comes
//      back a JPEG (the control - PNG is chosen only when something IS
//      see-through), while a sticker with a transparent border is stored as a
//      PNG, and the bytes the URL serves are still see-through at the border
//      and opaque in the middle, read back through a browser canvas rather than
//      guessed from the content type
//   5. the composer rendered the photo, with no upload-failure copy
//   6. the payload the composer handed to the adapter (the write that carries
//      the uploaded URL — the composer's own `POST /v2/draft-caststorms`, which
//      is this device's state and is answered 200 from the local store) carries
//      that URL as an embed
//   7. nothing was posted to Farcaster from this probe (posting stays behind
//      the existing app-key flow). The submit itself is not this probe's
//      subject: `scripts/verify-cast-submit.mjs` measures the whole compose →
//      Cast path, including the refusal it ends at.
//
// Screenshots land in $MEDIA_SHOT_DIR (default: the system temp dir).

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { chromium } from 'playwright';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

const SERVER = process.env.NODE_BACKED_SERVER ?? 'https://localhost:5174';
// The media host is the client's own origin unless told otherwise: production
// serves both from fiddy.fun (see the header).
const MEDIA = (process.env.MEDIA_SERVER ?? SERVER).replace(/\/+$/, '');
const OUT = process.env.MEDIA_SHOT_DIR ?? os.tmpdir();
const DOMAIN = new URL(SERVER).host;
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'MEDIAUPLD';
const SIGNED_IN_FID = 3;
const MODAL_ROOT = '#modal-root';
const PLACEHOLDER = 'Start typing a new cast here...';

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

/** A real PNG of the size a photo would be — no image library needed. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
};

const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

const writeTestPhoto = (file) => {
  const width = 512;
  const height = 384;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = (x * 7 + y * 3) % 256;
      raw[at + 1] = Math.floor((y / height) * 255);
      raw[at + 2] = (x + y) % 256;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return { file, bytes: png.length };
};

/** A real PNG with an alpha channel: the case that must not become a JPEG.
 *
 *  A sticker, not a photo — an 8px border that is fully see-through around an
 *  opaque chartreuse middle, so "did anything fill the transparency with white"
 *  is answered by the bytes themselves rather than by a content type. */
const writeTransparentSticker = (file) => {
  const width = 512;
  const height = 384;
  const border = 8;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 4;
      const seeThrough =
        x < border || y < border || x >= width - border || y >= height - border;
      raw[at] = 212;
      raw[at + 1] = 255;
      raw[at + 2] = 63;
      raw[at + 3] = seeThrough ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return { file, bytes: png.length };
};

const readSurface = (page) =>
  page.evaluate(() => {
    // A read can land on a document that is mid-navigation, and the document
    // being replaced has no body yet. Signing in IS a navigation. MEASURED
    // 2026-10-21: unguarded, the read right after the "Go social" click threw
    // `Cannot read properties of null (reading 'innerText')` and the probe died
    // before check 1 was recorded — the client was fine the whole time.
    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    return {
      path: window.location.pathname,
      text,
      onboardingSheet: Boolean(
        document.querySelector('[data-fiddy="onboarding"]'),
      ),
      deviceOnlyLanding: Boolean(
        document.querySelector('[data-fiddy="device-only-session"]'),
      ),
      // The shell itself: a signed-in client draws its frame and a Cast
      // control. Without this a blank page would look like a landed sign-in.
      shellMounted: Boolean(document.querySelector('.fiddy-shell-frame')),
      castControl: Array.from(document.querySelectorAll('button')).some(
        (button) =>
          (button.innerText || '').trim() === 'Cast' && button.offsetParent,
      ),
    };
  });

const composer_text_of = (surface) => surface.text.slice(0, 160);

/**
 * `page.evaluate` also throws "Execution context was destroyed" whenever the app
 * is mid-navigation, which the null-body guard cannot catch — the read never
 * reaches the page. Every read of the surface goes through here, so a destroyed
 * context is "read again in a moment" rather than a dead run. Any other error is
 * let through untouched. MEASURED 2026-10-21: the poll right after the "Go
 * social" click hit exactly this window.
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

/** The launched browser, kept where the throw path can close it too. */
let browser;

const run = async () => {
  const photo = writeTestPhoto(path.join(os.tmpdir(), 'fiddy-media-probe.png'));
  const mediaRequests = [];
  const consoleErrors = [];

  browser = await chromium.launch({
    channel: 'chrome',
    ignoreHTTPSErrors: true,
    args: ['--ignore-certificate-errors'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  // Every call that leaves the page. The media upload is one of them (it is a
  // plain fetch to our host); the adapter's own answers are not, which is why
  // the cast payload is read from the adapter's log instead.
  await ctx.addInitScript(() => {
    const orig = window.fetch;
    window.__mediaFetchLog = [];
    window.fetch = async (...args) => {
      const url =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] && args[0].url) || String(args[0]);
      const method = (args[1] && args[1].method) || 'GET';
      const response = await orig(...args);
      window.__mediaFetchLog.push(
        `${method} ${response.status} ${String(url).slice(0, 200)}`,
      );
      return response;
    };
  });

  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') {
      consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 240));
    }
  });
  page.on('pageerror', (e) =>
    consoleErrors.push(`pageerror: ${String(e).slice(0, 240)}`),
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
        message,
        signature,
        fid: SIGNED_IN_FID,
        username: 'dwr',
        displayName: 'dwr',
      }),
    });
  });

  // ── 1. a signed-in client ─────────────────────────────────────────────────
  await page.goto(`${SERVER}/welcome/ready`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // Wait for the ready step's OWN control, not for "there is text on the page":
  // the document paints its own skeleton ("Loading Fiddy…") first, so a length
  // check returns before the step has rendered, the click below finds nothing,
  // and the run spends its whole minute looking like a failed sign-in.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, a, [role=button]')].some((el) =>
        /go social/i.test(el.innerText || ''),
      ),
    { timeout: 60000 },
  );

  for (const el of await page.$$('button, a, [role=button]')) {
    const text = ((await el.innerText()) || '').replace(/\s+/g, ' ').trim();
    if (/go social/i.test(text)) {
      await el.click();
      break;
    }
  }

  // The sign-in IS a navigation: this first read lands inside it, so it goes
  // through the guarded reader and a torn-down document is simply read again.
  let surface = await safeReadSurface(page);
  for (let i = 0; i < 60; i += 1) {
    if (
      surface.path === '/' &&
      surface.shellMounted &&
      !surface.onboardingSheet &&
      !surface.deviceOnlyLanding
    ) {
      break;
    }
    await page.waitForTimeout(1000);
    surface = await safeReadSurface(page);
  }
  check(
    'a completed sign-in lands in the client',
    surface.path === '/' &&
      surface.shellMounted &&
      !surface.onboardingSheet &&
      !surface.deviceOnlyLanding,
    `path=${surface.path} shell=${surface.shellMounted} onboarding=${surface.onboardingSheet} deviceOnly=${surface.deviceOnlyLanding}`,
  );

  // ── 2. the composer ───────────────────────────────────────────────────────
  // The shell's frame and its Cast control do not arrive in the same instant on
  // a cold dev build. MEASURED 2026-10-21: the shell was mounted while the
  // control was still a moment away, which read as "the composer never opened".
  // Ask for the control itself (bounded, and a no-op when it is already there)
  // instead of assuming the frame brought it; if it never comes, the checks
  // below still say so in their own words.
  await page
    .waitForFunction(
      () =>
        [...document.querySelectorAll('button')].some(
          (b) => (b.innerText || '').trim() === 'Cast' && b.offsetParent,
        ),
      { timeout: 30000 },
    )
    .catch(() => {});

  // The shell keeps a second Cast control in the DOM for narrow screens; only
  // one of them is on screen, and clicking the hidden one would never open
  // anything, so ask for the visible one.
  const castButtons = await page
    .locator('button:has-text("Cast"):visible')
    .all();
  let opened = false;
  for (const button of castButtons) {
    const text = ((await button.innerText()) || '').trim();
    if (text === 'Cast') {
      await button.click();
      opened = true;
      break;
    }
  }
  if (!opened) {
    await page.keyboard.press('n');
  }

  let editorOpen = false;
  let placeholderSeen = false;
  try {
    await page.waitForSelector(`${MODAL_ROOT} [contenteditable="true"]`, {
      timeout: 30000,
    });
    editorOpen = true;
    placeholderSeen = await page
      .locator(`${MODAL_ROOT}`)
      .getByText(PLACEHOLDER)
      .first()
      .isVisible()
      .catch(() => false);
  } catch {
    editorOpen = false;
  }
  // The composer's own file input is asked for before it is judged, so the
  // measure and the assertion cannot disagree (and so the check can report
  // what it found either way).
  const scopedInput = page.locator(`${MODAL_ROOT} input[type=file]`);
  const anywhereInput = page.locator('input[type=file]');
  const picks = {
    scoped: await scopedInput.count(),
    anywhere: await anywhereInput.count(),
  };

  await page.screenshot({ path: `${OUT}/media-composer-open.png` });
  check(
    'the composer opens over the feed',
    editorOpen && picks.scoped > 0,
    `clicked=${opened} editor=${editorOpen} placeholderSeen=${placeholderSeen} fileInputs=${JSON.stringify(
      picks,
    )} composerText=${JSON.stringify(composer_text_of(await safeReadSurface(page)))}`,
  );

  // ── 3. pick a photo: the mint, then the upload ─────────────────────────────
  // A missing upload must be a reported failure, not an unhandled rejection
  // that takes the whole probe down before it prints anything.
  const uploadResponse = page
    .waitForResponse(
      (response) =>
        response.url().includes('/api/fiddy/media') &&
        response.request().method() === 'POST',
      { timeout: 45000 },
    )
    .catch(() => null);
  const fileInput =
    picks.scoped > 0 ? scopedInput.first() : anywhereInput.first();
  let uploaded = null;
  // Pick the photo the way a person does: press the composer's Media button and
  // answer the file dialog it opens. Setting the input directly misses the
  // picker's own click step (the mint it prefetches), and a pick can land on a
  // node React is about to replace.
  const mediaButton = page
    .locator(`${MODAL_ROOT} button[title="Media"]`)
    .first();
  try {
    let picked = false;
    if ((await mediaButton.count()) > 0) {
      await mediaButton.waitFor({ state: 'visible', timeout: 30000 });
      // Wait for the dialog the click is about to open, but never let that wait
      // become an unhandled rejection. MEASURED 2026-10-21: the promise was
      // created bare, the click's own auto-wait outlasted its 20s timeout, and
      // the rejection killed the process where it stood — no checks printed,
      // nothing to read, which reads exactly like a broken client. A dialog that
      // never comes is now the same "not picked" the fallback below already
      // handles.
      const chooser = page
        .waitForEvent('filechooser', { timeout: 20000 })
        .catch(() => null);
      await mediaButton.click();
      try {
        const dialog = await chooser;
        if (!dialog) throw new Error('the Media button opened no file dialog');
        await dialog.setFiles(photo.file);
        picked = true;
      } catch {
        picked = false;
      }
    }
    if (!picked) {
      await fileInput.setInputFiles(photo.file);
    }
    uploaded = await uploadResponse;
  } catch (error) {
    check(
      'the composer accepts a picked photo',
      false,
      `picking the photo threw: ${String(error).slice(0, 200)}`,
    );
  }
  if (!uploaded) {
    const adapterLog = await page.evaluate(
      () => window.__nodeBackedRequests ?? [],
    );
    const mint = adapterLog.find((entry) =>
      /generate-image-upload-url$/.test(entry.path),
    );
    check(
      'the upload-URL request the composer made was answered by the MEDIA route, not a 501',
      mint?.kind === 'media' && mint?.status === 200,
      `mint entry: ${JSON.stringify(mint)?.slice(0, 240) ?? 'never seen'}`,
    );
    check(
      'the browser POSTed the picked bytes to OUR media host',
      false,
      mediaRequests.join(' | ') ||
        'no POST to the media host within 90s of picking the photo',
    );
    const left = await page.evaluate(() => window.__mediaFetchLog ?? []);
    console.log('\n── failed run: what the adapter classified ──');
    for (const entry of adapterLog.slice(-14)) {
      console.log(
        `  ${entry.method} ${entry.path} kind=${entry.kind} status=${entry.status}`,
      );
    }
    console.log('\n── failed run: requests that left the page ──');
    for (const line of left.slice(-20)) console.log(`  ${line}`);
    console.log('\n── failed run: console errors ──');
    for (const line of consoleErrors.slice(0, 8)) console.log(`  ${line}`);
    await page.screenshot({ path: `${OUT}/media-upload-failed.png` });
    await browser.close();
    throw new Error(
      'no upload to the media host — the checks and dump above are the evidence',
    );
  }
  const uploadedBody = await uploaded.json().catch(() => ({}));
  const mediaRequest = uploaded.request();

  mediaRequests.push(
    `${mediaRequest.method()} ${uploaded.status()} ${mediaRequest.url()}`,
  );
  check(
    'the browser POSTed the picked bytes to OUR media host',
    mediaRequest.url().startsWith(`${MEDIA}/api/fiddy/media`) &&
      uploaded.status() === 201,
    mediaRequests.join(' | ') || 'no request seen',
  );
  const mediaUrl = typeof uploadedBody.url === 'string' ? uploadedBody.url : '';
  check(
    'the upload came back with a URL on that host',
    mediaUrl.startsWith(`${MEDIA}/api/fiddy/media/`),
    mediaUrl || JSON.stringify(uploadedBody).slice(0, 200),
  );
  check(
    'the media host reported the type it really stored',
    uploadedBody.contentType === 'image/jpeg' ||
      uploadedBody.contentType === 'image/png',
    `contentType=${uploadedBody.contentType} ext=${uploadedBody.ext} bytes=${uploadedBody.bytes}`,
  );

  // ── 4. the URL round-trips from another client ─────────────────────────────
  const fetched = await ctx.request.get(mediaUrl);
  const served = await fetched.body();
  const nameHash =
    /\/api\/fiddy\/media\/([0-9a-f]{64})\./.exec(mediaUrl)?.[1] ?? '';
  const servedHash = createHash('sha256').update(served).digest('hex');
  check(
    'the stored photo is readable at that URL by anyone, with the honest type',
    fetched.status() === 200 &&
      (fetched.headers()['content-type'] ?? '').startsWith('image/'),
    `status=${fetched.status()} type=${fetched.headers()['content-type']} bytes=${served.length}`,
  );
  check(
    'the served bytes hash to the name in the URL (the file is its own address)',
    nameHash.length === 64 &&
      nameHash === servedHash &&
      nameHash === uploadedBody.sha256,
    `name=${nameHash.slice(0, 12)}… served=${servedHash.slice(0, 12)}… reported=${String(
      uploadedBody.sha256,
    ).slice(0, 12)}…`,
  );
  check(
    'the photo is served immutable, with nosniff',
    /immutable/.test(fetched.headers()['cache-control'] ?? '') &&
      fetched.headers()['x-content-type-options'] === 'nosniff',
    `cache-control=${fetched.headers()['cache-control']} nosniff=${fetched.headers()['x-content-type-options']}`,
  );

  // ── 5. the see-through picture keeps its transparency ──────────────────────
  //
  // WHAT WENT WRONG: the re-encode drew every photo onto a canvas it had filled
  // white first, and always encoded a JPEG — so a PNG or WebP with anything
  // transparent in it (a sticker, a logo, a cut-out) came back an opaque JPEG
  // with a white box baked behind it. The photo above is the control: nothing in
  // it is see-through, so JPEG is the right answer for it and always was.
  //
  // The same composer picks a second file here, because the claim is about this
  // pipeline and not about a module: the bytes have to survive the pick, the
  // re-encode, the POST and the host's storage. The alpha is read back through a
  // canvas in the page, which is the only way to answer "is it actually still
  // see-through" rather than "does the host call it a PNG".
  const sticker = writeTransparentSticker(
    path.join(OUT, 'fiddy-see-through-sticker.png'),
  );
  const stickerUpload = page
    .waitForResponse(
      (response) =>
        response.url().includes('/api/fiddy/media') &&
        response.request().method() === 'POST',
      { timeout: 45000 },
    )
    .catch(() => null);
  let stickerStored = null;
  try {
    // The same dance the first pick used (Media button, then the dialog it
    // opens), with the input as the fallback that pick already established.
    const mediaButton = page.locator(`${MODAL_ROOT} button[title="Media"]`).first();
    let pickedSticker = false;
    if ((await mediaButton.count()) > 0) {
      await mediaButton.waitFor({ state: 'visible', timeout: 30000 });
      const chooser = page
        .waitForEvent('filechooser', { timeout: 20000 })
        .catch(() => null);
      await mediaButton.click();
      const dialog = await chooser;
      if (dialog) {
        await dialog.setFiles(sticker.file);
        pickedSticker = true;
      }
    }
    if (!pickedSticker) {
      await fileInput.setInputFiles(sticker.file);
    }
    stickerStored = await stickerUpload;
  } catch (error) {
    check(
      'the composer accepts a picked see-through picture',
      false,
      `picking the sticker threw: ${String(error).slice(0, 200)}`,
    );
  }
  check(
    'the composer accepts a picked see-through picture',
    Boolean(stickerStored),
    stickerStored
      ? `${stickerStored.status()} ${stickerStored.request().url()}`
      : 'no second POST to the media host within 45s of picking the sticker',
  );

  const stickerBody = stickerStored
    ? await stickerStored.json().catch(() => ({}))
    : {};
  const stickerUrl = typeof stickerBody.url === 'string' ? stickerBody.url : '';
  check(
    'a photo with nothing see-through in it is still a JPEG',
    uploadedBody.contentType === 'image/jpeg',
    `the opaque photo above came back contentType=${uploadedBody.contentType} — PNG is chosen only when something IS see-through`,
  );
  check(
    'the see-through picture is stored as a PNG, not an opaque JPEG',
    stickerBody.contentType === 'image/png',
    `contentType=${stickerBody.contentType} ext=${stickerBody.ext} bytes=${stickerBody.bytes} url=${stickerUrl || 'none'}`,
  );

  const stickerFetched = stickerUrl ? await ctx.request.get(stickerUrl) : null;
  const stickerBytes = stickerFetched ? await stickerFetched.body() : Buffer.alloc(0);
  let stickerAlpha = null;
  if (stickerBytes.length > 0) {
    try {
      stickerAlpha = await page.evaluate(async (dataUrl) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0);
        const at = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data);
        return {
          width: image.naturalWidth,
          height: image.naturalHeight,
          border: at(2, 2),
          centre: at(
            Math.floor(image.naturalWidth / 2),
            Math.floor(image.naturalHeight / 2),
          ),
        };
      }, `data:image/png;base64,${stickerBytes.toString('base64')}`);
    } catch (error) {
      stickerAlpha = { threw: String(error).slice(0, 200) };
    }
  }
  check(
    'the stored bytes are still see-through at the border and opaque in the middle',
    Boolean(stickerAlpha?.border && stickerAlpha.border[3] === 0) &&
      Boolean(stickerAlpha?.centre && stickerAlpha.centre[3] === 255),
    stickerAlpha
      ? `corner rgba=${JSON.stringify(stickerAlpha.border)} centre rgba=${JSON.stringify(stickerAlpha.centre)} (${stickerAlpha.width}x${stickerAlpha.height}, ${stickerBytes.length} bytes served)`
      : `nothing was served at ${stickerUrl || 'no URL'} — transparency cannot be claimed`,
  );

  // ── 6. the composer embedded it ────────────────────────────────────────────
  const composer = await page.evaluate((root) => {
    const container = document.querySelector(root);
    const text = container ? container.innerText.replace(/\s+/g, ' ') : '';
    const images = Array.from(
      container ? container.querySelectorAll('img') : [],
    ).map((img) => img.currentSrc || img.src);
    const buttons = Array.from(
      container ? container.querySelectorAll('button') : [],
    ).map((button) => ({
      label: (button.innerText || '').trim(),
      disabled: button.disabled,
      y: button.getBoundingClientRect().top,
    }));
    return { text, images, buttons };
  }, MODAL_ROOT);

  const previewed = composer.images.some(
    (src) =>
      src.startsWith('blob:') ||
      src.startsWith(mediaUrl) ||
      src.startsWith(MEDIA),
  );
  check(
    'the composer shows the photo it uploaded',
    previewed,
    `${composer.images.length} image(s) in the composer: ${JSON.stringify(composer.images.slice(0, 3))}`,
  );
  check(
    'the composer shows no upload-failure copy',
    !/didn't make it|could not upload|Failed to upload|Image upload failed|Cloudflare/i.test(
      composer.text,
    ),
    composer.text.slice(0, 200),
  );

  // ── 7. the cast payload references it ──────────────────────────────────────
  const editor = page.locator(`${MODAL_ROOT} [contenteditable="true"]`).first();
  await editor.click();
  await page.keyboard.type('a photo from our own media host');
  await page.waitForTimeout(500);

  const submit = composer.buttons
    .filter((button) => button.label === 'Cast' && !button.disabled)
    .sort((a, b) => b.y - a.y)[0];
  check(
    'the cast button is ready to submit',
    Boolean(submit),
    JSON.stringify(composer.buttons),
  );

  let castEntry;
  let payloadEntry;
  if (submit) {
    await page.evaluate((y) => {
      const container = document.querySelector('#modal-root');
      const buttons = Array.from(
        container ? container.querySelectorAll('button') : [],
      );
      const target = buttons
        .filter((button) => (button.innerText || '').trim() === 'Cast')
        .sort(
          (a, b) =>
            b.getBoundingClientRect().top - a.getBoundingClientRect().top,
        )
        .find((button) => Math.abs(button.getBoundingClientRect().top - y) < 1);
      target?.click();
    }, submit.y);

    for (let i = 0; i < 60; i += 1) {
      const seen = await page.evaluate((url) => {
        const log = window.__nodeBackedRequests ?? [];
        const writes = log.filter(
          (entry) =>
            entry.method === 'POST' &&
            typeof entry.bodyPreview === 'string' &&
            entry.bodyPreview.includes(url),
        );
        return {
          cast: writes.find((entry) => /\/v2\/casts$/.test(entry.path)) ?? null,
          // The fork's composer stores the whole caststorm as a DRAFT before
          // anything is cast (`POST /v2/draft-caststorms`), and a draft is this
          // device's own state, so that write is answered 200 from the local
          // store — it is the first write to carry the uploaded URL, which is
          // what this check wants. MEASURED (2026-10-21): a client with no
          // hosted session *does* go on to reach `POST /v2/casts`; that submit
          // and its refusal are measured by scripts/verify-cast-submit.mjs.
          // The payload is the same either way — this is the last write that
          // carried it.
          payload: writes.at(-1) ?? null,
        };
      }, mediaUrl);
      castEntry = seen.cast;
      payloadEntry = seen.payload;
      if (payloadEntry) {
        break;
      }
      await page.waitForTimeout(500);
    }
  }
  await page.screenshot({ path: `${OUT}/media-composer-submitted.png` });

  // A submit that never reached the adapter has to say why: the adapter's own
  // log (every write that was answered inside the page) and what the composer
  // said afterwards. Without this the only report is "never built a cast
  // payload", which names the symptom and none of the cause.
  if (!payloadEntry) {
    const writes = await page.evaluate(() =>
      (window.__nodeBackedRequests ?? []).map(
        (entry) =>
          `${entry.method} ${entry.path} kind=${entry.kind} status=${entry.status} body=${(entry.bodyPreview ?? '').slice(0, 120)}`,
      ),
    );
    console.log(
      '\n── the composer never built a cast payload: every adapter entry ──',
    );
    for (const line of writes.slice(-20)) console.log(`  ${line}`);
    const afterClick = await page.evaluate((root) => {
      const container = document.querySelector(root);
      return (container ? container.innerText : '')
        .replace(/\s+/g, ' ')
        .slice(0, 400);
    }, MODAL_ROOT);
    console.log(
      `── the composer after the click ──\n  ${JSON.stringify(afterClick)}`,
    );
    console.log('── console errors after the click ──');
    for (const line of consoleErrors.slice(-6)) console.log(`  ${line}`);
  }

  const mintEntry = await page.evaluate(() => {
    const log = window.__nodeBackedRequests ?? [];
    return log.find((entry) => /generate-image-upload-url$/.test(entry.path));
  });
  check(
    'the upload-URL request the composer made was answered by the MEDIA route, not a 501',
    mintEntry?.kind === 'media' && mintEntry?.status === 200,
    `log entry: ${JSON.stringify(mintEntry)?.slice(0, 200)}`,
  );

  /** The embeds of either shape the composer submits: a cast, or its caststorm. */
  const embedsIn = (body) => {
    try {
      const parsed = JSON.parse(body ?? '{}');
      if (Array.isArray(parsed.embeds)) {
        return parsed.embeds;
      }
      const cast = parsed?.caststorm?.casts?.[0];
      return Array.isArray(cast?.embeds) ? cast.embeds : [];
    } catch {
      return [];
    }
  };
  const payloadEmbeds = embedsIn(payloadEntry?.bodyPreview);
  check(
    'the cast payload the composer built references the media URL',
    payloadEmbeds.includes(mediaUrl),
    payloadEntry
      ? `${payloadEntry.method} ${payloadEntry.path} (status ${payloadEntry.status}) embeds=${JSON.stringify(payloadEmbeds)}${castEntry ? ' — and the submit reached POST /v2/casts' : ''}`
      : 'the composer never handed a payload to the adapter',
  );

  const leftThePage = await page.evaluate(() => window.__mediaFetchLog ?? []);
  check(
    'nothing was posted to Farcaster from this probe (posting stays behind the app-key flow)',
    !leftThePage.some((line) => /farcaster\.xyz.*\/v2\/casts/.test(line)),
    leftThePage.filter((line) => line.includes('/v2/casts')).join(' | ') ||
      'no cast request left the page',
  );

  // Read the adapter's own tally while the page is still alive.
  const adapterWrites = await page.evaluate(
    () => (window.__nodeBackedRequests ?? []).length,
  );

  await ctx.request.dispose();
  await browser.close();

  console.log('── a photo, from the composer, to our own media host ──');
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`,
    );
  }
  const clip = (line) => line.replace(/([0-9a-f]{12})[0-9a-f]{40,}/, '$1…');
  console.log('\n── requests that left the page ──');
  for (const line of leftThePage) {
    console.log(`  ${clip(line)}`);
  }
  console.log('\n── media requests ──');
  for (const line of mediaRequests) {
    console.log(`  ${clip(line)}`);
  }
  console.log(
    `\nadapter classifications this run: ${adapterWrites} (debug surface)`,
  );
  console.log(
    `\nconsole errors: ${consoleErrors.length}${consoleErrors.length ? ` (first: ${consoleErrors[0]})` : ''}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; screenshots in ${OUT}`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
};

try {
  await run();
} catch (error) {
  console.log(`\nPROBE threw before finishing: ${String(error).slice(0, 300)}`);
  for (const c of checks) {
    console.log(
      `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`,
    );
  }
  process.exitCode = 1;
} finally {
  // A probe that throws must still let go of its browser. MEASURED 2026-10-21:
  // with the close on the success path only, a thrown read left the node
  // process alive (holding its Chrome) until it was killed by hand, and the
  // shell that started it waited with it.
  await browser?.close().catch(() => {});
}
