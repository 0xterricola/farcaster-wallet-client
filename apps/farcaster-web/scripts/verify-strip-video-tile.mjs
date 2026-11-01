// Does a VIDEO next to other embeds share the strip's tile height, and does its
// content fill that tile? Measured in the running client, not eyeballed.
//
//   STRIP_SERVER=https://localhost:5221 node scripts/verify-strip-video-tile.mjs
//
// Requires a dev server pointed at a live read node, signed in for real (only
// the SIWF relay is stubbed):
//
//   VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com \
//     HTTPS=true npx vite --config scripts/probe.vite.config.mjs --port 5221 --strictPort
//
// THE FIXTURES, and why these.
//
// A strip is what the client builds when a cast carries more than one
// carousel-eligible embed (`needsCarousel` in hooks/casts/useCastBody.tsx), and
// the rule under test is that every tile in it is the SAME height while the
// video's own content fills its tile (object-fit: cover at rest, contain only
// while playing — the video leg of quilcast's 0.10.7 + 0.10.13).
//
//   A. VIDEO + MINI APP, a real cast on the node: fid 294413
//      (`0xharryweb3.eth`) 0x84b6f5f59ea1300f1cc2dcbce92473c3a9ff3627 —
//      https://resources.cityprotocol.co/…/…mp4 (content-type `video/mp4`) plus
//      https://viral-city-baseapp.cityprotocol.co/ whose page carries
//      `fc:miniapp`. Both are the node's own bytes.
//   B. VIDEO + IMAGE: the SAME cast with its mini-app URL rewritten to a real
//      image URL of the same author's (imagedelivery, from their own cast
//      0x82ab4627…). MEASURED (2026-10-23, 1376 fids, ~16k casts): no cast on
//      the node carries an `.mp4`-classifiable video AND an image — this client
//      deliberately does not play HLS (`embedKinds.ts`), so video-bearing casts
//      are rare and video+image does not occur. The rewrite is one response in
//      flight; the cast, its author, the session, the layout and the classifier
//      are all the real thing.
//
// WHAT IT RECORDS (numbers, not a verdict), at 390px and 1440px, for each
// fixture, on the profile (feed variant) and the conversation (focused
// variant):
//   - every tile in the strip: its box, whether it holds the video, an image or
//     a mini-app card;
//   - the video element's own box, its computed `object-fit`, and the bands the
//     fit leaves (top/bottom = letterbox, left/right = pillarbox) computed from
//     its intrinsic size;
//   - the same video measured twice: at rest and while actually playing.
//
// WHY A THIRD FIXTURE. The node's own mp4 for this cast no longer serves bytes
// (MEASURED: `videoWidth`/`videoHeight` stay 0, so `play()` refuses and no fit
// bands can be computed) — the tile geometry is measured on it all the same,
// since that is the markup under test. To measure the rest/playing fit itself,
// a third fixture serves LOCAL bytes for that same embed URL:
//
//   STRIP_PLAYABLE_FILE=/path/to/small.mp4   (a local 640x360 h.264 file)
//
//   ~/.hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg -f lavfi \
//     -i "color=c=0xFF7A00:s=640x360:d=3,drawbox=x='mod(t*160\,560)':y=120:\
//         w=80:h=120:color=0x1A1A1A:t=fill" -c:v libx264 -pix_fmt yuv420p \
//     -movflags +faststart -y /tmp/strip-fixture.mp4
//
// Skipped when unset. Everything but the bytes is still the node's: the same
// cast, the same embed URL, the same classifier, the same strip.
//
// Screenshots land in $STRIP_SHOT_DIR (default: the system temp dir).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright';
import { privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const SERVER = process.env.STRIP_SERVER ?? 'https://localhost:5221';
const DOMAIN = new URL(SERVER).host;
const OUT = process.env.STRIP_SHOT_DIR ?? path.join(os.tmpdir(), 'strip-video-tile');
const NONCE = 'f'.repeat(128);
const CHANNEL_TOKEN = 'STRIPTILE1';

/** The account this probe signs in as (any signed-in session will do). */
const SIGNED_IN_FID = Number(process.env.STRIP_SIGNED_IN_FID ?? 191554);
const SIGNED_IN_USERNAME = process.env.STRIP_SIGNED_IN_USERNAME ?? 'ivc';

/** Local bytes for the fixture's own video URL, for the rest/playing fit. */
const PLAYABLE_FILE = process.env.STRIP_PLAYABLE_FILE ?? '';
const PLAYABLE_BYTES =
  PLAYABLE_FILE && fs.existsSync(PLAYABLE_FILE)
    ? fs.readFileSync(PLAYABLE_FILE)
    : null;

/** Fixture A — the node's own cast: a video next to a mini-app embed. */
const FIXTURE = {
  username: process.env.STRIP_FIXTURE_USERNAME ?? '0xharryweb3.eth',
  fid: Number(process.env.STRIP_FIXTURE_FID ?? 294413),
  hash:
    process.env.STRIP_FIXTURE_HASH ??
    '0x84b6f5f59ea1300f1cc2dcbce92473c3a9ff3627',
  text: process.env.STRIP_FIXTURE_TEXT ?? 'Merry Basemas',
  video:
    process.env.STRIP_FIXTURE_VIDEO ??
    'https://resources.cityprotocol.co/viral-city/template/result/ba4a9df9-e2b4-4011-ac8c-ae78a42a2c0f.mp4',
  miniapp:
    process.env.STRIP_FIXTURE_MINIAPP ??
    'https://viral-city-baseapp.cityprotocol.co/',
  /** The image fixture B is rewritten onto (the same author's own photo). */
  image:
    process.env.STRIP_FIXTURE_IMAGE ??
    // A URL the classifier NAMES as an image by its own extension, served by
    // the dev server itself. MEASURED (2026-10-23): the node's own
    // `imagedelivery.net/…/original` has no extension, and the extension-less
    // probe behind `embedKinds.ts` is CORS-refused from the dev origin, so that
    // URL stays a LINK CARD — a "video next to a link", not the video next to
    // an image this fixture is for.
    `${SERVER}/fiddy-share-card.png`,
};

const WIDTHS = [
  { name: '390px', width: 390, height: 844 },
  { name: '1440px', width: 1440, height: 900 },
];

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

/**
 * Every fact about the media strips on this page, read out of the live DOM.
 *
 * A strip is the flex row `CastAttachmentsSection` renders; a tile is one of
 * its children that carries media (the row also holds fixed-width spacers).
 * The video's box, its fit and the bands that fit leaves are what the card is
 * about, so they are measured on the drawn element rather than inferred.
 */
const readStrips = ({ marker, videoUrl }) => {
  const round = (n) => Math.round(n * 10) / 10;

  const fit = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const intrinsicW = el.videoWidth || el.naturalWidth || 0;
    const intrinsicH = el.videoHeight || el.naturalHeight || 0;
    let content = null;
    if (intrinsicW > 0 && intrinsicH > 0 && rect.height > 0) {
      const boxRatio = rect.width / rect.height;
      const mediaRatio = intrinsicW / intrinsicH;
      const cover = style.objectFit === 'cover';
      const wide = mediaRatio > boxRatio;
      const w = cover
        ? wide
          ? rect.height * mediaRatio
          : rect.width
        : wide
          ? rect.width
          : rect.height * mediaRatio;
      const h = cover
        ? wide
          ? rect.height
          : rect.width / mediaRatio
        : wide
          ? rect.width / mediaRatio
          : rect.height;
      content = { w: round(w), h: round(h) };
    }
    return {
      tag: el.tagName.toLowerCase(),
      box: { w: round(rect.width), h: round(rect.height) },
      objectFit: style.objectFit,
      position: style.position,
      intrinsic: { w: intrinsicW, h: intrinsicH },
      content,
      bands: content
        ? {
            topBottom: round(rect.height - content.h),
            leftRight: round(rect.width - content.w),
          }
        : null,
    };
  };

  const strips = [];
  for (const video of Array.from(document.querySelectorAll('video'))) {
    // Only the fixture's own strip: a feed page holds many players. `includes`
    // rather than `startsWith`: the client may hand the player a URL derived
    // from the embed's (a proxy or a signed variant), and the needle is long
    // enough that a substring match is still the fixture's own video.
    const src = video.currentSrc || video.src || '';
    if (videoUrl && !src.includes(videoUrl.slice(0, 60))) {
      continue;
    }

    // Walk out of the attachment to its tile: climb until the current
    // element's parent IS the strip's row — a flex row holding more than one
    // laid-out child. MEASURED (2026-10-23): the vidstack player renders its
    // own children (a provider wrapper and a layout element), so the first
    // ancestor with a sibling is the player's own box, not the tile; the row is
    // the first flex row above it.
    let tile = video;
    let climb = 0;
    while (tile.parentElement && climb < 20) {
      const parent = tile.parentElement;
      const parentStyle = getComputedStyle(parent);
      const laidOut = Array.from(parent.children).filter((child) => {
        const r = child.getBoundingClientRect();
        return r.height >= 24 && r.width >= 24;
      });
      if (
        parentStyle.display.includes('flex') &&
        parentStyle.flexDirection === 'row' &&
        laidOut.length > 1
      ) {
        break;
      }
      tile = parent;
      climb += 1;
    }
    const row = tile.parentElement;
    if (!row) continue;

    // The fixture's own strip: climb from the row to the first ancestor whose
    // text carries the cast's own text (this client renders casts without an
    // <article>, so the host is found by the text itself).
    let host = row;
    let hostClimb = 0;
    while (
      host.parentElement &&
      !(host.textContent ?? '').includes(marker) &&
      hostClimb < 20
    ) {
      host = host.parentElement;
      hostClimb += 1;
    }
    const rowText = marker ? (host.textContent ?? '') : '';
    if (marker && !rowText.includes(marker)) continue;

    const tiles = Array.from(row.children).map((child) => {
      const rect = child.getBoundingClientRect();
      const inner = child.querySelector('video, img, iframe, [data-miniapp-button]');
      const player = child.querySelector('[data-media-player]');
      return {
        w: round(rect.width),
        h: round(rect.height),
        top: round(rect.top),
        hasVideo: Boolean(child.querySelector('video')),
        hasImage: Boolean(child.querySelector('img')),
        hasIframe: Boolean(child.querySelector('iframe')),
        hasPlayer: Boolean(player),
        miniappButton: Boolean(
          child.querySelector('button, [role="button"], a[href]'),
        ),
        inner: inner ? fit(inner) : null,
      };
    });
    const media = tiles.filter((t) => t.w > 24 && t !== null);
    const videoTile = media.find((t) => t.hasVideo) ?? null;
    const siblings = media.filter((t) => !t.hasVideo);

    strips.push({
      row: {
        w: round(row.getBoundingClientRect().width),
        h: round(row.getBoundingClientRect().height),
        alignItems: getComputedStyle(row).alignItems,
      },
      tiles,
      mediaTileCount: media.length,
      videoTileHeight: videoTile ? videoTile.h : null,
      siblingTileHeights: siblings.map((t) => t.h),
      videoInner: videoTile ? videoTile.inner : null,
    });
  }

  const body = document.body?.innerText ?? '';
  return {
    path: window.location.pathname,
    strips,
    deviceOnlyLanding: Boolean(
      document.querySelector('[data-fiddy="device-only-session"]'),
    ),
    sawFixture: body.includes(marker),
    text: body.replace(/\s+/g, ' ').slice(0, 240),
  };
};

const read = async (page, { marker, videoUrl }) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await page.evaluate(readStrips, { marker, videoUrl });
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
  return { path: '', strips: [], sawFixture: false, text: '' };
};

/**
 * A dev server re-optimizes its deps on the first request of a new one, which
 * makes the browser reload out from under a read (MEASURED, twice in this
 * probe's first runs: "Execution context was destroyed"). That is the harness's
 * own event, not the client's, so an evaluate that lands in the middle of it is
 * retried rather than reported.
 */
const safeEval = async (page, fn, arg, tries = 8) => {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      if (
        !/Execution context was destroyed|Target closed|navigat|Cannot read properties of null|frame was detached/i.test(
          String(error),
        )
      ) {
        throw error;
      }
      await page.waitForTimeout(1000);
    }
  }
  return null;
};

/** Bring the fixture's cast (and its player) on screen. */
const revealCast = async (page, marker, videoUrl) => {
  // MEASURED (2026-10-23, this probe's own dumps): the feed paints its casts
  // before the strip's player mounts, and a player only mounts near the
  // viewport — a scroll on its own can land before the mount, and an early read
  // then sees the tile's loading state instead of the video. So wait for the
  // fixture's own <video> to exist AND to have a drawn box, scrolling each
  // second, rather than for the cast's text.
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const ready = await safeEval(
      page,
      ({ textNeedle, videoNeedle }) => {
        const walk = Array.from(
          document.querySelectorAll('article, [data-testid], div'),
        ).filter((el) => (el.textContent ?? '').includes(textNeedle));
        walk[walk.length - 1]?.scrollIntoView({ block: 'center' });
        const video = Array.from(document.querySelectorAll('video')).find((v) =>
          (v.currentSrc || v.src || '').includes(videoNeedle),
        );
        return Boolean(video && video.getBoundingClientRect().height >= 24);
      },
      { textNeedle: marker, videoNeedle: videoUrl.slice(0, 60) },
    );
    if (ready) return true;
    await page.waitForTimeout(1000);
  }
  return false;
};

/** The read of the player's own state, after a play/pause has been driven. */
const readPlayerState = async (page, videoUrl) =>
  safeEval(
    page,
    ({ needle }) => {
      const video = Array.from(document.querySelectorAll('video')).find((v) =>
        (v.currentSrc || v.src || '').includes(needle),
      );
      if (!video) return null;
      const player = video.closest('[data-media-player]');
      return {
        paused: video.paused,
        readyState: video.readyState,
        intrinsic: `${video.videoWidth}x${video.videoHeight}`,
        currentTime: Math.round(video.currentTime * 10) / 10,
        playerDataPlaying: player ? player.hasAttribute('data-playing') : null,
        playerDataPaused: player ? player.hasAttribute('data-paused') : null,
      };
    },
    { needle: videoUrl.slice(0, 60) },
  );

/**
 * The player's own state, driven from here so both fits can be measured.
 *
 * MEASURED (2026-10-23): a bare `video.pause()` does NOT produce the at-rest
 * state on a video the client is autoplaying — its autoplay queue replays the
 * tile within the second. The state a real pause lives in is the one
 * `VideoAttachment`'s own `onClick` creates: a TRUSTED click on the player
 * makes that video the app's active video and sets its manual override, after
 * which a pause holds. So the at-rest pass clicks the player for real and then
 * pauses; if it cannot hold the pause, the read says so rather than pretending.
 */
const setPlaying = async (page, videoUrl, playing) => {
  const needle = videoUrl.slice(0, 60);
  if (playing) {
    const state = await safeEval(
      page,
      async ({ needle: n }) => {
        const video = Array.from(document.querySelectorAll('video')).find((v) =>
          (v.currentSrc || v.src || '').includes(n),
        );
        if (!video) return null;
        video.muted = true;
        try {
          await video.play();
        } catch {
          return 'play-refused';
        }
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        return true;
      },
      { needle },
    );
    if (state !== true) return state;
    return readPlayerState(page, videoUrl);
  }

  const box = await safeEval(
    page,
    ({ needle: n }) => {
      const video = Array.from(document.querySelectorAll('video')).find((v) =>
        (v.currentSrc || v.src || '').includes(n),
      );
      if (!video) return null;
      const r = video.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    },
    { needle },
  );
  if (box) {
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(400);
  }
  await safeEval(
    page,
    async ({ needle: n }) => {
      const video = Array.from(document.querySelectorAll('video')).find((v) =>
        (v.currentSrc || v.src || '').includes(n),
      );
      video?.pause();
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    },
    { needle },
  );
  return readPlayerState(page, videoUrl);
};

const measureAt = async (page, fixture, { marker, videoUrl }, width) => {
  const shot = async (name) =>
    page.screenshot({ path: `${OUT}/${fixture}-${width.name}-${name}.png` });

  await revealCast(page, marker, videoUrl);
  const atRestState = await setPlaying(page, videoUrl, false);
  const atRest = await read(page, { marker, videoUrl });
  await shot('rest');

  const playingState = await setPlaying(page, videoUrl, true);
  const playing = await read(page, { marker, videoUrl });
  await shot('playing');

  return { atRestState, atRest, playingState, playing };
};

const run = async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const consoleErrors = [];
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
      consoleErrors.push(m.text().replace(/\s+/g, ' ').slice(0, 200));
    }
  });
  page.on('pageerror', (e) =>
    consoleErrors.push(`pageerror: ${String(e).slice(0, 200)}`),
  );
  page.on('response', (response) => {
    const url = response.url();
    if (/\/v1\/(castsByFid|castById|userDataByFid)/.test(url)) {
      nodeRoutes.push(`${response.status()} ${new URL(url).pathname}`);
    }
  });

  // ── the sign-in: a real SIWE message, stubbed relay ────────────────────────
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
        username: SIGNED_IN_USERNAME,
        displayName: SIGNED_IN_USERNAME,
      }),
    });
  });

  /**
   * Fixture B's one rewrite: the meta of the cast's own embed pair would be
   * wrong before its bytes did not work — the miniapp URL is replaced by an
   * image URL, so the strip is a video next to a photo. Everything else in the
   * response (author, hash, text, timestamp, signature) is the node's.
   */
  let rewriteToImage = false;
  const rewrite = (body) => {
    if (!rewriteToImage) return false;
    let changed = false;
    for (const message of body?.messages ?? []) {
      const castAddBody = message?.data?.castAddBody;
      if (!castAddBody || message.hash !== FIXTURE.hash) continue;
      for (const embed of castAddBody.embeds ?? []) {
        if (embed.url === FIXTURE.miniapp) {
          embed.url = FIXTURE.image;
          changed = true;
        }
      }
    }
    return changed;
  };
  for (const pattern of ['**/v1/castsByFid*', '**/v1/castById*']) {
    await page.route(pattern, async (route) => {
      if (!rewriteToImage) {
        return route.continue();
      }
      const response = await route.fetch();
      const body = await response.json();
      rewrite(body);
      return route.fulfill({ response, json: body });
    });
  }

  // The deployed origin answers "which account wrote this hash" from its own
  // unfurl service (castAuthorHandoff.ts); the dev server has no such service,
  // so the probe answers it with the fixture's fid the node's own read gives.
  await page.route('**/unfurl/cast-author/**', (route) =>
    route.fulfill({
      status: 200,
      headers: CORS,
      body: JSON.stringify({ fid: FIXTURE.fid }),
    }),
  );

  /**
   * The fixture's own video URL, answered with local bytes while the playable
   * fixture runs, so the fit can be measured against a real intrinsic size
   * (the embed URL, the cast and the classifier all stay the node's). Ranges
   * are answered as ranges: a media element asks for them.
   */
  let servePlayableBytes = false;
  await page.route(
    (url) => url.href.startsWith(FIXTURE.video.slice(0, 60)),
    async (route) => {
      if (!servePlayableBytes || !PLAYABLE_BYTES) return route.continue();
      const headers = {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      };
      const range = route.request().headers().range;
      if (!range) {
        return route.fulfill({
          status: 200,
          headers: {
            ...headers,
            'content-length': String(PLAYABLE_BYTES.length),
          },
          body: PLAYABLE_BYTES,
        });
      }
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = Number(match?.[1] ?? 0);
      const end = Math.min(
        match?.[2] ? Number(match[2]) : PLAYABLE_BYTES.length - 1,
        PLAYABLE_BYTES.length - 1,
      );
      const slice = PLAYABLE_BYTES.subarray(start, end + 1);
      return route.fulfill({
        status: 206,
        headers: {
          ...headers,
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${PLAYABLE_BYTES.length}`,
        },
        body: slice,
      });
    },
  );

  const signedIn = async () => {
    await page.goto(`${SERVER}/welcome/ready`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForFunction(
      () => /go social/i.test(document.body?.innerText ?? ''),
      null,
      { timeout: 120000 },
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
      if (clicked === null) await page.waitForTimeout(500);
    }
    for (let i = 0; i < 60; i += 1) {
      const surface = await read(page, {});
      if (surface.path === '/' && !surface.deviceOnlyLanding) break;
      await page.waitForTimeout(1000);
    }
    return clicked;
  };

  const clicked = await signedIn();
  console.log(`signed in as ${SIGNED_IN_USERNAME} (button: ${clicked})`);

  const report = { server: SERVER, signedInAs: SIGNED_IN_FID, fixtures: {} };

  const VARIANTS = [
    { name: 'video+miniapp', image: false, playable: false },
    { name: 'video+image', image: true, playable: false },
  ];
  if (PLAYABLE_BYTES) {
    // Same cast, same embed URL, image rewrite as above — the video answered
    // with local bytes so its fit can be measured at rest and while playing.
    VARIANTS.push({ name: 'video+image-playable', image: true, playable: true });
  }

  for (const variant of VARIANTS) {
    rewriteToImage = variant.image;
    servePlayableBytes = variant.playable;
    report.fixtures[variant.name] = {};

    for (const surface of ['profile', 'conversation']) {
      const url =
        surface === 'profile'
          ? `${SERVER}/~/profiles/${FIXTURE.fid}`
          : `${SERVER}/~/conversations/${FIXTURE.hash}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

      report.fixtures[variant.name][surface] = {};
      for (const width of WIDTHS) {
        await page.setViewportSize({ width: width.width, height: width.height });
        const measured = await measureAt(
          page,
          `${variant.name}-${surface}`,
          { marker: FIXTURE.text, videoUrl: FIXTURE.video },
          width,
        );
        report.fixtures[variant.name][surface][width.name] = measured;
        const tile = measured.atRest.strips[0] ?? null;
        console.log(
          `\n${variant.name} / ${surface} / ${width.name}: strips=${measured.atRest.strips.length} sawFixture=${measured.atRest.sawFixture}`,
        );
        if (tile) {
          console.log(
            `  row h=${tile.row.h} align=${tile.row.alignItems} tiles=${tile.mediaTileCount}`,
          );
          for (const t of tile.tiles.filter((t) => t.w > 24)) {
            console.log(
              `   tile ${t.w}x${t.h} video=${t.hasVideo} image=${t.hasImage} iframe=${t.hasIframe} player=${t.hasPlayer}`,
            );
          }
          console.log(
            `  video tile h=${tile.videoTileHeight} sibling tile h=[${tile.siblingTileHeights.join(',')}]`,
          );
          console.log(
            `  video inner (rest): ${JSON.stringify(tile.videoInner)}`,
          );
          console.log(
            `  video inner (playing): ${JSON.stringify(measured.playing.strips[0]?.videoInner ?? null)}`,
          );
          console.log(
            `  rest state=${JSON.stringify(measured.atRestState)} playing state=${JSON.stringify(measured.playingState)}`,
          );
        } else {
          console.log(`  no strip carrying the fixture video was on screen`);
        }
      }
    }
  }

  fs.writeFileSync(
    `${OUT}/strip-video-tile.json`,
    JSON.stringify(report, null, 1),
  );
  console.log(`\nscreenshots + json: ${OUT}`);
  console.log(`node routes seen: ${nodeRoutes.slice(0, 8).join(', ')}`);
  if (consoleErrors.length > 0) {
    console.log(`console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(' | ')}`);
  }

  await browser.close();
};

await run();