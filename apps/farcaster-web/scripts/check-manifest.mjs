#!/usr/bin/env node
/**
 * Refuse to release a build whose app-list manifest is unsigned, mis-sized, or
 * describes a different product than the shell it ships with.
 *
 * WHY THIS IS A RELEASE GATE AND NOT ONLY A TEST
 *
 * `/.well-known/farcaster.json` is Fiddy's listing identity: the signed
 * per-domain manifest a Farcaster client reads to list, search and notify this
 * app. The vhost serves it from `/var/www/fiddy-well-known/farcaster.json`, and
 * the repo's copy under `public/.well-known/` is what `release-client.sh`
 * installs there — so a release is the thing that changes the listing, and a
 * release is where it has to be checked. Measured 2026-10-22 (card t_8654d91e):
 * the served manifest asked for a 512x512 splash (the spec asks 200x200),
 * painted the splash in upstream Warpcast purple (#6200EA) while the app's
 * ground is #161715, and advertised "deploy always on agents with onchain
 * identities" — a different product than the one `index.html` unfurls as.
 *
 * This checks the BUILT tree (dist/), not the sources: what must be right is
 * what ships. It reads the PNG's own header for each picture's size, so a
 * mis-sized asset cannot pass on its name, and it holds all three of the URLs
 * the listing names (splash, icon, embed image) to the same rule: a file this
 * repo built, at the size the spec asks — measured 2026-10-22 (card t_90a2eee2),
 * the icon and the embed were nginx aliases into the sibling FSSC app's asset
 * directory and carried its art. It never touches the signature: the
 * domain association is the owner's cryptographic approval — carried through
 * unchanged, never regenerated.
 *
 * And for the splash it also looks INSIDE: the art that shipped was 200x200 and
 * off-centre (measured 2026-10-22, card t_28b3612c — see the placement block
 * below), so this gate now measures where the drawing sits, not only how big the
 * picture is. A sprite that is the right size and in the wrong place is exactly
 * the defect a header-only check cannot see, and the splash is the first frame
 * of every launch.
 *
 *   node scripts/check-manifest.mjs <built web root>    # e.g. apps/farcaster-web/dist
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  boxCentre,
  decodePng,
  dominantColour,
  hex,
  minAlpha,
  rgbOf,
  visibleBox,
} from './lib/png.mjs';

const root = process.argv[2];
if (!root) {
  console.error('usage: check-manifest.mjs <built web root>');
  process.exit(2);
}

const refuse = (why) => {
  console.error(`REFUSING to ship: ${why}`);
  process.exit(1);
};

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return refuse(`${file} is missing from the build`);
  }
};

let manifest;
try {
  manifest = JSON.parse(read(path.join(root, '.well-known', 'farcaster.json')));
} catch (error) {
  refuse(`the manifest is not JSON (${error.message})`);
}

const association = manifest.accountAssociation ?? {};
if (!association.header || !association.payload) {
  refuse('the manifest carries no account association');
}
if (
  typeof association.signature !== 'string' ||
  association.signature.length < 64
) {
  refuse(
    'the manifest association is unsigned — an unsigned manifest cannot be listed',
  );
}

const app = manifest.miniapp ?? {};
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
if (app.version !== '1')
  refuse(`manifest version is ${app.version}, the spec asks "1"`);
if (!app.name || app.name.length > 32)
  refuse('manifest name is missing or over 32 characters');
if (!/^https:\/\//.test(app.homeUrl ?? ''))
  refuse('manifest homeUrl is not absolute https');
if (!/^https:\/\//.test(app.iconUrl ?? ''))
  refuse('manifest iconUrl is not absolute https');
if (!app.description || app.description.length > 170) {
  refuse('manifest description is missing or over 170 characters');
}
if (!PRINTABLE_ASCII.test(app.description)) {
  refuse('manifest description carries an emoji or a special character');
}
if (app.subtitle && app.subtitle.length > 30)
  refuse('manifest subtitle is over 30 characters');
if (app.tagline && app.tagline.length > 30)
  refuse('manifest tagline is over 30 characters');
if (Array.isArray(app.tags) && app.tags.length > 5)
  refuse('manifest carries more than 5 tags');
if (
  !Array.isArray(app.tags) ||
  app.tags.some((tag) => !/^[a-z0-9-]+$/.test(tag))
) {
  refuse('manifest tags are not lowercase, single-word values');
}

// The link and the listing are the same app or they are broken: `index.html` is
// what a shared URL unfurls as, the manifest is what the app list shows.
const shell = read(path.join(root, 'index.html'));
const metaContent = (attribute, key) => {
  const tag = new RegExp(
    `<meta\\s+${attribute}="${key}"\\s+content=(?:"([^"]*)"|'([^']*)')`,
  ).exec(shell);
  return tag?.[1] ?? tag?.[2];
};

let embed;
try {
  embed = JSON.parse(metaContent('name', 'fc:miniapp') ?? 'null');
} catch {
  refuse('the shell carries an fc:miniapp tag that is not JSON');
}
const action = embed?.button?.action ?? {};
if (action.name !== app.name) {
  refuse(
    `the shell launches "${action.name}" while the listing is named "${app.name}"`,
  );
}
if (action.splashImageUrl !== app.splashImageUrl) {
  refuse(
    `the shell's splash is ${action.splashImageUrl} and the listing's is ${app.splashImageUrl}`,
  );
}
if (action.splashBackgroundColor !== app.splashBackgroundColor) {
  refuse(
    `the splash colour disagrees: shell ${action.splashBackgroundColor}, listing ${app.splashBackgroundColor}`,
  );
}
// The embed card in the feed and the listing's own image are one picture: a
// cast that launches one app and an app list that shows another is the drift
// this gate exists to catch.
if (embed?.imageUrl !== app.imageUrl) {
  refuse(
    `the shell embeds ${embed?.imageUrl} while the listing shows ${app.imageUrl}`,
  );
}
if (metaContent('property', 'og:description') !== app.description) {
  refuse(
    'the unfurl sentence and the listing description are not the same sentence',
  );
}

// Every picture the listing names is painted before or beside any of our code:
// the splash covers the transition and the icon and the embed card are what a
// client shows in the app list and in a cast. Each must be an asset THIS repo
// owns at the size the spec asks — a URL the host aliases into another app's
// asset directory is another product's art waiting to happen (measured
// 2026-10-22, card t_90a2eee2: the icon and the embed both came out of
// /var/www/fiddy-fssc/assets/, the sibling FSSC app's directory, and carried
// its judge-baby art). Sizes are read from the PNG's own IHDR, so a mis-sized
// asset cannot pass on its name.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const ownedPng = (urlString, label, [wantWidth, wantHeight]) => {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    refuse(`the ${label} URL is not a URL: ${urlString}`);
  }
  if (url.origin !== 'https://fiddy.fun') {
    refuse(`the ${label} is served from ${url.origin}, not https://fiddy.fun`);
  }
  const file = path.join(root, url.pathname);
  let png;
  try {
    png = readFileSync(file);
  } catch {
    refuse(`the build carries no ${url.pathname} for the ${label} it asks for`);
  }
  if (PNG_MAGIC.some((byte, at) => png[at] !== byte)) {
    refuse(`${file} is not a PNG`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== wantWidth || height !== wantHeight) {
    refuse(
      `the ${label} is ${width}x${height}; the spec asks ${wantWidth}x${wantHeight}`,
    );
  }
  return { pathname: url.pathname, width, height, bytes: png };
};

const splash = ownedPng(app.splashImageUrl, 'splash', [200, 200]);
const icon = ownedPng(app.iconUrl, 'icon', [1024, 1024]);
const embedImage = ownedPng(app.imageUrl, 'embed image', [1200, 800]);

// WHERE the splash's art sits, not only how big the splash is.
//
// Measured 2026-10-22 (card t_28b3612c): the art that shipped was 200x200, a
// file in this repo, byte-identical live and in the repo — and off-centre. Its
// drawing's box was (29,16)-(118,117), centre (73.5,66.5) on a canvas whose
// centre is (100,100), so the launch transition painted Fiddy's mascot into the
// upper-left of its own square with the empty ground stacked to the right and
// below: an alignment bug on the first frame of every launch, and nothing in the
// release could see it, because everything the release measured was right.
//
// So: decode the splash and measure the drawing. The drawing is everything that,
// composited on the colour the manifest paints behind it
// (`splashBackgroundColor` — the ground the launch transition shows), is not
// that colour by more than ~30 in RGB: the rule the measurement that found the
// bug used, which is also the rule the picture was cropped to when it was drawn
// (`render-share-card.mjs` measures with the same reader). Its box must be
// centred on the canvas within a couple of pixels.
const splashImage = decodePng(splash.bytes);
let splashGround;
try {
  splashGround = rgbOf(app.splashBackgroundColor);
} catch {
  refuse(
    `the manifest's splashBackgroundColor is ${app.splashBackgroundColor}, not a #rrggbb colour`,
  );
}
const ground = dominantColour(splashImage);
const transparentGround = minAlpha(splashImage) < 250;
const drawn = visibleBox(splashImage, { ground: splashGround, threshold: 30 });
if (drawn === null) {
  refuse(`${splash.pathname} carries no drawing at all — a blank splash`);
}
// An opaque splash whose ground is not the colour the manifest paints behind it
// shows up as a rectangle of the wrong colour: the purple-vs-#161715 drift this
// listing already had once, in the one picture nobody could see a size problem
// in. (A transparent splash is asking for that colour from the host instead.)
if (!transparentGround && hex(ground) !== hex(splashGround)) {
  refuse(
    `the splash is drawn on ${hex(ground)} while the manifest paints ${app.splashBackgroundColor} behind it`,
  );
}
const drawnCentre = boxCentre(drawn);
const offBy = Math.max(
  Math.abs(drawnCentre.x - splash.width / 2),
  Math.abs(drawnCentre.y - splash.height / 2),
);
if (offBy > 2) {
  refuse(
    `the splash's art is off-centre: its drawing occupies (${drawn.x0},${drawn.y0})-(${drawn.x1},${drawn.y1}) — centre (${drawnCentre.x},${drawnCentre.y}) on a ${splash.width}x${splash.height} canvas whose centre is (${splash.width / 2},${splash.height / 2}), ${offBy}px away — so the launch transition paints the mark in the wrong place`,
  );
}
// Centred and filling nothing is not a splash either: the mark takes about half
// the square, the share the app icon gives its own mark. The band is wide on
// purpose (the drawing's exact share is an art decision, not a spec) — it only
// refuses a speck and a mark running off the edges.
const fills = Math.min(
  drawn.width / splash.width,
  drawn.height / splash.height,
);
if (fills < 0.3 || fills > 0.8) {
  refuse(
    `the splash's drawing fills ${Math.round(fills * 100)}% of the square; a mark takes about half of it`,
  );
}

console.log(
  `  manifest ok  ${app.name} "${app.description}" — signed; splash ${splash.pathname} (${splash.width}x${splash.height} on ${app.splashBackgroundColor}; mark ${drawn.width}x${drawn.height} centred at (${drawnCentre.x},${drawnCentre.y})), icon ${icon.pathname} (${icon.width}x${icon.height}), embed ${embedImage.pathname} (${embedImage.width}x${embedImage.height}) — every one of them a file in this build, shell and listing agree`,
);
