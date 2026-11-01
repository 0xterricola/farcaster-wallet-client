// A PNG reader for the scripts that have to look INSIDE a picture, not just at
// its header.
//
// Two scripts need this and neither wants a dependency for it:
//
//   * `check-manifest.mjs` (the release gate) measures WHERE the splash's art
//     sits, not only how big the splash is. A 200x200 splash whose drawing is
//     pushed into its upper-left third is right-sized and wrong, and only a
//     look at the pixels can tell — measured 2026-10-22 (card t_28b3612c): the
//     mark's box was (29,16)-(118,117), centre (73.5,66.5) on a 200x200 canvas
//     whose centre is (100,100), so the launch transition painted Fiddy's
//     mascot up and to the left with the empty ground stacked right and below.
//   * `render-share-card.mjs` (which draws it) crops the mascot still to its
//     own drawing before placing it, because the still carries transparent
//     margin: `fiddy-mark-poster.png` is 384x384 and its drawing is a 217x210
//     box at (89,80) once it is composited over the splash's ground — a box
//     whose centre is 2.5px right and 3.2px high of where the splash's centre
//     is, which is the couple of pixels that decide whether a mark looks
//     centred. Cropped to the drawing, the box IS the drawing.
//
// `visibleBox()` below is the one measurement both of them make: the box of
// everything that, on the ground the picture will sit on, is not that ground.
//
// Node ships zlib, and a PNG that is 8-bit, truecolour-or-grey, non-interlaced
// is ~40 lines of inflate plus the five filter types. That is cheap enough to
// do rather than take a dependency, and it keeps the gate honest: it reads the
// bytes the release actually carries.
//
// What this reader deliberately does NOT do, and why the gate is fine with
// that: palette PNGs (colour type 3), bit depths below 8 and interlaced files
// are refused with a named reason rather than decoded. Chrome's screenshot
// encoder and every asset in this repo's `public/` are 8-bit types 0/2/4/6, and
// a refusal here is a loud failure at the gate, never a silent wrong answer.

import { Buffer } from 'node:buffer';
import { inflateSync } from 'node:zlib';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isPng = (buffer) =>
  buffer.length > 8 && PNG_MAGIC.every((byte, at) => buffer[at] === byte);

/** The channels per pixel for each colour type this reader decodes. */
const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

const paeth = (left, up, upLeft) => {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
};

/**
 * Decode an 8-bit, non-interlaced PNG into RGBA.
 *
 * Returns `{ width, height, data }` where `data` is a `Uint8Array` of
 * `width * height * 4` bytes in RGBA order, whatever the source's colour type
 * was — so a caller measuring colour and a caller measuring alpha read the same
 * layout and neither branches.
 */
export function decodePng(buffer) {
  if (!isPng(buffer)) throw new Error('not a PNG (bad signature)');

  let width;
  let height;
  let bitDepth;
  let colourType;
  let interlace;
  const idat = [];
  let at = 8;
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colourType = body[9];
      interlace = body[12];
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (width === undefined) throw new Error('no IHDR chunk');
  if (bitDepth !== 8) {
    throw new Error(`bit depth ${bitDepth}: this reader decodes 8-bit PNGs`);
  }
  if (interlace !== 0) throw new Error('interlaced PNG: not decoded here');
  const channels = CHANNELS[colourType];
  if (!channels) {
    throw new Error(
      `colour type ${colourType}: this reader decodes greyscale, truecolour, and either with alpha`,
    );
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prior = new Uint8Array(stride);
  let at2 = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at2++];
    line.set(raw.subarray(at2, at2 + stride));
    at2 += stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = prior[i];
      const upLeft = i >= channels ? prior[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + left) & 0xff;
      else if (filter === 2) line[i] = (line[i] + up) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4)
        line[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`scanline filter ${filter}`);
    }
    let out = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (channels === 1) {
        data[out] = line[x];
        data[out + 1] = line[x];
        data[out + 2] = line[x];
        data[out + 3] = 255;
      } else if (channels === 2) {
        data[out] = line[x * 2];
        data[out + 1] = line[x * 2];
        data[out + 2] = line[x * 2];
        data[out + 3] = line[x * 2 + 1];
      } else if (channels === 3) {
        data[out] = line[x * 3];
        data[out + 1] = line[x * 3 + 1];
        data[out + 2] = line[x * 3 + 2];
        data[out + 3] = 255;
      } else {
        data[out] = line[x * 4];
        data[out + 1] = line[x * 4 + 1];
        data[out + 2] = line[x * 4 + 2];
        data[out + 3] = line[x * 4 + 3];
      }
      out += 4;
    }
    prior.set(line);
  }
  return { width, height, data };
}

/** `#rrggbb` for a pixel, the form the manifest's colour fields are written in. */
export const hex = ({ r, g, b }) =>
  `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;

/** The inverse: the `#rrggbb` a manifest field carries, as channels. */
export const rgbOf = (value) => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value ?? '');
  if (!match) throw new Error(`${value} is not a #rrggbb colour`);
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
};

/** The pixel a picture is mostly made of — its ground, for these pictures. */
export function dominantColour(image, { skipTransparent = true } = {}) {
  const counts = new Map();
  const { data } = image;
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3];
    if (skipTransparent && alpha === 0) continue;
    const key =
      (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | alpha;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  if (best === null) throw new Error('the picture has no opaque pixel');
  return {
    r: (best >>> 24) & 0xff,
    g: (best >>> 16) & 0xff,
    b: (best >>> 8) & 0xff,
    a: best & 0xff,
    count: bestCount,
  };
}

/** The most opaque pixel's alpha — 0 when the picture carries transparency. */
export function minAlpha(image) {
  let least = 255;
  for (let at = 3; at < image.data.length; at += 4) {
    if (image.data[at] < least) least = image.data[at];
    if (least === 0) break;
  }
  return least;
}

/**
 * The box the DRAWING occupies when the picture is put on `ground`, inclusive of
 * its edges — or `null` when nothing is drawn on it. `{ x0, y0, x1, y1, width,
 * height }`.
 *
 * That is the one measurement this pair of scripts needs, and it is the
 * measurement the off-centre splash was found with: a pixel counts as drawing
 * when what it LOOKS like over the ground differs from the ground by more than
 * `threshold` (per channel, the largest of the three differences) — which for an
 * opaque pixel is simply "differs from the ground", and for a translucent one
 * weights the difference by its own alpha, because a shadow at 20% opacity over
 * a dark ground is 20% of a shadow and the eye reads it that way.
 *
 * Both callers pass the ground the picture will sit on: the splash's own
 * `#161715` (which is also the manifest's `splashBackgroundColor`), so the
 * renderer's crop and the release gate's check measure the same box — a crop
 * taken from raw alpha would include a tail of nearly-invisible pixels that the
 * colour measurement cannot see, and the two would disagree by the couple of
 * pixels that decide whether the mark looks centred.
 */
export function visibleBox(
  image,
  { ground = { r: 0, g: 0, b: 0 }, threshold = 30 } = {},
) {
  const { width, height, data } = image;
  const box = { x0: width, y0: height, x1: -1, y1: -1 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const alpha = data[at + 3] / 255;
      if (alpha === 0) continue;
      const difference =
        alpha *
        Math.max(
          Math.abs(data[at] - ground.r),
          Math.abs(data[at + 1] - ground.g),
          Math.abs(data[at + 2] - ground.b),
        );
      if (difference <= threshold) continue;
      if (x < box.x0) box.x0 = x;
      if (x > box.x1) box.x1 = x;
      if (y < box.y0) box.y0 = y;
      if (y > box.y1) box.y1 = y;
    }
  }
  return box.x1 < 0 ? null : withSize(box);
}

/** The box's centre, in the inclusive-edge convention the measurements use. */
export const boxCentre = ({ x0, y0, x1, y1 }) => ({
  x: (x0 + x1) / 2,
  y: (y0 + y1) / 2,
});

const withSize = (box) => ({
  ...box,
  width: box.x1 - box.x0 + 1,
  height: box.y1 - box.y0 + 1,
});
