// The cards fiddy.fun draws with, rendered from the repo's own art.
//
//   node scripts/render-share-card.mjs            # the og card  -> public/fiddy-share-card.png
//   node scripts/render-share-card.mjs embed      # the embed    -> public/fiddy-embed.png
//   node scripts/render-share-card.mjs splash     # the splash   -> public/fiddy-splash.png
//   node scripts/render-share-card.mjs all        # all three
//
// Why this exists, and why it is a script rather than a checked-in drawing:
//
//   * `index.html` is the only thing a crawler reads on this site — the client
//     is an SPA, so every cast, profile and mini app URL answers with the same
//     shell. Until this file existed the shell carried no `og:` tag at all, and
//     the one 1200x630 image on the host was `opengraph.png`: upstream
//     Farcaster's purple brand card, a different product's art.
//   * So the shell points at `/fiddy-share-card.png`, and this is what draws
//     it: the owner's mascot (the same still the chrome paints before the GLB
//     arrives, `fiddy-mark-poster.png`, which already carries its own alpha),
//     the brand's dark ground (#161715), the chartreuse accent (#d4ff3f) and
//     the copy the live mini app poster already ships — no new claim is
//     invented here.
//   * The mascot is the only illustration; the layout is a poster: mark, one
//     line of context, and the address. An unfurl already prints the page's
//     title and description next to this image, so repeating them in the art
//     would read as duplication.
//
// Three cards, one art system, because the three surfaces want different shapes:
//
//   * `share` (1200x630) is the `og:image` / `twitter:image` a crawler lays
//     out — the ratio social platforms expect (1.91:1);
//   * `embed` (1200x800, 3:2) is the `imageUrl` the `fc:miniapp` tag and the
//     app-list manifest both name — the ratio the mini app spec asks of an
//     embed. Measured 2026-10-22 (card t_90a2eee2): that URL was
//     `fiddy.fun/image.png`, an exact-match nginx alias into
//     `/var/www/fiddy-fssc/assets/fiddy-card.png` — the *sibling* FSSC app's
//     asset directory, carrying FSSC's "Network Court" judge art. So Fiddy's
//     app-list icon and every fiddy.fun cast card sat one FSSC art edit away
//     from being repainted. Both surfaces now come from files this repo owns,
//     and this script is where the embed one can be redrawn rather than only
//     replaced by hand.
//   * `splash` (200x200) is the `splashImageUrl` the manifest and the shell's
//     `fc:miniapp` embed both name: the picture the host centres over
//     `splashBackgroundColor` while the mini app launches. It is a different
//     composition, not the poster with knobs turned down — one thing in the
//     square (the mark, no wordmark, no address, no glow), so it is its own
//     template below rather than a share of the poster's CSS. It exists because
//     the art that shipped there was off-centre: measured 2026-10-22 (card
//     t_28b3612c), the drawing's box was (29,16)-(118,117) on the 200x200 canvas
//     — centre (73.5,66.5) against a canvas centre of (100,100) — so the first
//     frame of every launch painted Fiddy's mascot up and to the left with the
//     empty ground stacked to its right and below. A splash is 200x200
//     whatever the pixels say, so nothing in the release could see it; the
//     scale the mark is given here is the app icon's own (its drawing is
//     499x550 of 1024, i.e. about half the square), and the placement is
//     checked by BOTH halves of this pair: this script refuses to write a
//     splash whose drawing is not centred, and `check-manifest.mjs` refuses to
//     ship one.
//
// It uses the Playwright Chromium this repo already installs for its probes, so
// there is nothing extra to fetch, and it needs no network. The font stack is
// the system sans the live mini app card was drawn with; the output is a
// committed PNG, so a machine with different fonts redraws a card only when
// somebody runs this on purpose.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  boxCentre,
  decodePng,
  dominantColour,
  hex,
  rgbOf,
  visibleBox,
} from './lib/png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const mascotPath = path.join(webRoot, 'public', 'fiddy-mark-poster.png');

/**
 * The three cards, in the poster language the brand already ships: the mascot on
 * #161715, the wordmark in chartreuse, one line of context, the address.
 *
 * `share`'s numbers are the committed og card's — leave them alone unless the
 * og card is meant to change. `embed` is the same composition given the 3:2
 * canvas the spec asks for, with the extra height spent on a bigger mascot and
 * a lower text block rather than on a band of empty ground (dead space in the
 * frame reads as broken formatting in a feed).
 *
 * `splash` is the third surface and the odd one out: 200x200, one thing in the
 * square. Its `mark.size` is the drawing's own width and height on the canvas —
 * 100px in a 200px square, which is the share the app icon gives its own mark.
 */
const CARDS = {
  share: {
    file: 'fiddy-share-card.png',
    width: 1200,
    height: 630,
    glow: { size: 560, at: '81% 72%', alpha: 0.2 },
    mascot: { size: 434, right: 54, bottom: 26 },
    text: {
      left: 92,
      top: 132,
      maxWidth: 620,
      wordmark: 34,
      headline: 76,
      line: 30,
      gapWordmark: 18,
      gapLine: 22,
    },
    address: { left: 92, bottom: 62, size: 26 },
  },
  embed: {
    file: 'fiddy-embed.png',
    width: 1200,
    height: 800,
    glow: { size: 660, at: '80% 70%', alpha: 0.2 },
    mascot: { size: 570, right: 34, bottom: 6 },
    text: {
      left: 92,
      top: 214,
      maxWidth: 650,
      wordmark: 36,
      headline: 88,
      line: 34,
      gapWordmark: 20,
      gapLine: 26,
    },
    address: { left: 92, bottom: 74, size: 28 },
  },
  splash: {
    layout: 'splash',
    file: 'fiddy-splash.png',
    width: 200,
    height: 200,
    mark: { size: 100 },
  },
};

const card = (spec, mascotUrl) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${spec.width}px; height: ${spec.height}px; overflow: hidden; }
      body {
        position: relative;
        background: #161715;
        color: #eef0e8;
        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .glow {
        position: absolute;
        inset: 0;
        background: radial-gradient(
          ${spec.glow.size}px ${spec.glow.size}px at ${spec.glow.at},
          rgba(212, 255, 63, ${spec.glow.alpha}),
          rgba(212, 255, 63, 0) 66%
        );
      }
      .mascot {
        position: absolute;
        right: ${spec.mascot.right}px;
        bottom: ${spec.mascot.bottom}px;
        width: ${spec.mascot.size}px;
        height: ${spec.mascot.size}px;
        object-fit: contain;
      }
      .text {
        position: absolute;
        left: ${spec.text.left}px;
        top: ${spec.text.top}px;
        max-width: ${spec.text.maxWidth}px;
      }
      .wordmark {
        font-size: ${spec.text.wordmark}px;
        font-weight: 800;
        letter-spacing: -0.02em;
        color: #d4ff3f;
      }
      .headline {
        margin-top: ${spec.text.gapWordmark}px;
        font-size: ${spec.text.headline}px;
        line-height: 1.02;
        font-weight: 700;
        letter-spacing: -0.035em;
        color: #eef0e8;
      }
      .line {
        margin-top: ${spec.text.gapLine}px;
        font-size: ${spec.text.line}px;
        line-height: 1.35;
        color: #b6bcae;
      }
      .address {
        position: absolute;
        left: ${spec.address.left}px;
        bottom: ${spec.address.bottom}px;
        font-size: ${spec.address.size}px;
        font-weight: 500;
        letter-spacing: 0.01em;
        color: #9ba193;
      }
    </style>
  </head>
  <body>
    <div class="glow"></div>
    <img class="mascot" src="${mascotUrl}" alt="" />
    <div class="text">
      <div class="wordmark">fiddy</div>
      <div class="headline">Meet your Fiddy.</div>
      <div class="line">A little agent. A world to discover.</div>
    </div>
    <div class="address">fiddy.fun</div>
  </body>
</html>`;

/** The brand's ground, and the colour the manifest paints behind the splash. */
const GROUND = '#161715';

/**
 * Where the mark's box sits, as an inset from the left/top edge: the number that
 * centres a box of `spec.mark.size` in the canvas. It is asserted to be a whole
 * number of pixels — a fractional offset renders the drawing through a resample
 * and moves its measured centre half a pixel, which is the kind of drift this
 * variant exists to end.
 */
const markInset = (spec) => {
  const inset = (spec.width - spec.mark.size) / 2;
  if (!Number.isInteger(inset)) {
    throw new Error(
      `a ${spec.mark.size}px mark does not centre on a ${spec.width}px canvas without a half pixel`,
    );
  }
  return inset;
};

/**
 * The splash: the same mascot on the same ground, and nothing else. One thing in
 * a 200x200 square, because there is room for one thing — a wordmark at this
 * size is a smudge, and the address is already in the graphic the cast card
 * shows beside it.
 *
 * The mark element is an empty slot that the loop below fills with a crop of the
 * still, and that crop is the whole of the centring story: the still is 384x384
 * and its drawing is a 217x210 box at (89,80) once it is composited over the
 * ground the splash paints — so an <img> centred by its BOX would put the
 * DRAWING 2.5px right and 3.2px high, which is past the couple of pixels the
 * release gate refuses a splash for. Cropped to the drawing, the box IS the
 * drawing, and a centred box is a centred mark.
 *
 * No glow: the glow is what makes the poster cards read as posters, and at
 * 200x200 a radial wash behind a 100px mark reads as a smudge. The picture this
 * splash sits beside in the app list — the icon — carries none either.
 */
const splashCard = (spec) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${spec.width}px; height: ${spec.height}px; overflow: hidden; }
      body {
        position: relative;
        background: ${GROUND};
      }
      .mark {
        position: absolute;
        left: ${markInset(spec)}px;
        top: ${markInset(spec)}px;
        width: ${spec.mark.size}px;
        height: ${spec.mark.size}px;
        object-fit: contain;
      }
    </style>
  </head>
  <body>
    <img class="mark" id="mark" alt="" />
  </body>
</html>`;

// Which cards to draw: the first argument names one (`share`, `embed`, `splash`)
// or says `all`. An unknown name lists what there is rather than drawing the
// wrong card.
const requested = process.argv[2] ?? 'share';
const names =
  requested === 'all'
    ? Object.keys(CARDS)
    : Object.keys(CARDS).filter((name) => name === requested);
if (names.length === 0) {
  console.error(
    `unknown card "${requested}" — known cards: ${Object.keys(CARDS).join(', ')}, all`,
  );
  process.exit(2);
}

// The mascot travels as a data URL rather than a file:// reference: the page is
// set as content (about:blank), and Chrome will not load a local file into a
// document that is not itself a file.
const mascotUrl = `data:image/png;base64,${readFileSync(mascotPath).toString('base64')}`;

// The drawing's box inside that still, measured over the ground the splash will
// paint it on rather than assumed, with the SAME reader and the SAME rule the
// release gate uses (`lib/png.mjs`) — so the crop this script takes and the
// check the gate makes cannot disagree about where the drawing is.
const markBox = visibleBox(decodePng(readFileSync(mascotPath)), {
  ground: rgbOf(GROUND),
});
if (markBox === null) {
  console.error(`REFUSING to draw: ${mascotPath} has no visible pixel in it`);
  process.exit(1);
}

/**
 * Measure a splash the way the release gate does, and refuse to write one whose
 * drawing is not centred: the trade is that a bad render never lands in
 * `public/` at all, rather than landing there and being refused at release time.
 * Returns the measurement so the run can print what it drew.
 */
const measureSplash = (png, spec) => {
  const image = decodePng(png);
  const ground = dominantColour(image);
  const drawn = visibleBox(image, { ground: rgbOf(GROUND) });
  if (drawn === null) throw new Error(`${spec.file} has no drawing in it`);
  const centre = boxCentre(drawn);
  const off = Math.max(
    Math.abs(centre.x - spec.width / 2),
    Math.abs(centre.y - spec.height / 2),
  );
  if (off > 2) {
    throw new Error(
      `${spec.file} draws its mark centred at (${centre.x},${centre.y}) on a ${spec.width}x${spec.height} canvas whose centre is (${spec.width / 2},${spec.height / 2}) — ${off}px off, and the launch transition paints it exactly there`,
    );
  }
  if (hex(ground) !== GROUND) {
    throw new Error(
      `${spec.file} is drawn on ${hex(ground)}; the splash is painted on ${GROUND}, and the manifest and the shell both say so`,
    );
  }
  return { drawn, centre, ground: hex(ground) };
};

// The probes in this directory launch the reader's own Chrome (`channel:
// 'chrome'`) rather than a bundled Chromium, and this follows them: it is the
// browser a shared link is actually opened in, and it is the one whose fonts
// and text rendering the committed cards were drawn with.
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const name of names) {
    const spec = CARDS[name];
    const splash = spec.layout === 'splash';
    const outPath = path.join(webRoot, 'public', spec.file);
    mkdirSync(path.dirname(outPath), { recursive: true });
    const page = await browser.newPage({
      viewport: { width: spec.width, height: spec.height },
      deviceScaleFactor: 1,
    });
    await page.setContent(splash ? splashCard(spec) : card(spec, mascotUrl), {
      waitUntil: 'load',
    });
    if (splash) {
      // Crop the still to its drawing in the page's own canvas — the ONE thing
      // the splash needs from a browser beyond a screenshot — so that the mark's
      // box and the drawing's box are the same box and CSS centring centres the
      // mark. Then hand the crop to the slot.
      const cropped = await page.evaluate(
        async ({ src, crop }) => {
          const poster = new Image();
          await new Promise((resolve, reject) => {
            poster.onload = resolve;
            poster.onerror = () =>
              reject(new Error('the still would not load'));
            poster.src = src;
          });
          const canvas = document.createElement('canvas');
          canvas.width = crop.width;
          canvas.height = crop.height;
          canvas
            .getContext('2d')
            .drawImage(
              poster,
              crop.x0,
              crop.y0,
              crop.width,
              crop.height,
              0,
              0,
              crop.width,
              crop.height,
            );
          return canvas.toDataURL('image/png');
        },
        { src: mascotUrl, crop: markBox },
      );
      await page.evaluate((url) => {
        document.getElementById('mark').src = url;
      }, cropped);
    }
    // Wait for the drawing to have decoded, or the card screenshots an empty slot
    // instead of the picture.
    await page.waitForFunction(
      (selector) => {
        const image = document.querySelector(selector);
        return image !== null && image.complete && image.naturalWidth > 0;
      },
      splash ? 'img.mark' : 'img.mascot',
      { timeout: 15000 },
    );
    const png = await page.screenshot({ type: 'png' });
    await page.close();
    if (splash) {
      const { drawn, centre } = measureSplash(png, spec);
      console.log(
        `  mark ${drawn.width}x${drawn.height} at (${drawn.x0},${drawn.y0}) — centre (${centre.x},${centre.y}) on a ${spec.width}x${spec.height} canvas`,
      );
    }
    writeFileSync(outPath, png);
    console.log(`wrote ${outPath} (${spec.width}x${spec.height})`);
  }
} finally {
  await browser.close();
}
