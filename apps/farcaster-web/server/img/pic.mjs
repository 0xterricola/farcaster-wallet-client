/**
 * What a fetched body actually is: read from its bytes, never from the URL.
 *
 * The extension is a claim the sender makes; a response's content-type is a
 * claim the sender makes. The bytes are not — a PNG starts with a PNG's
 * signature or it does not. `/api/img` answers only what this module names,
 * and answers a body it cannot name with nothing at all.
 *
 * Sizes matter for the same reason: a picture is rasterised at the size it
 * declares, so a 200-byte header claiming 60000x60000 would ask a reader's
 * browser for 3.6 billion pixels. `pixelCap` refuses that before the picture is
 * ever served. An SVG declares no pixel size — an `<img>` draws one without its
 * scripts or anything it links to, and the response's own sandbox makes it
 * inert if somebody opens it as a page — so it carries no size here.
 */

/** 50 megapixels: above any phone camera and any avatar, below "a decompression bomb". */
export const MAX_PIXELS = 50_000_000;

/** The formats a cast, an avatar or a preview really uses. */
const SIGNATURES = {
  png: (bytes) =>
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes.toString('latin1', 1, 4) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    bytes.toString('latin1', 12, 16) === 'IHDR'
      ? { type: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      : undefined,
  gif: (bytes) =>
    bytes.length > 10 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))
      ? { type: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
      : undefined,
  jpeg: (bytes) => {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      return undefined;
    }
    // Walk the segment chain to the frame header. A start-of-frame (SOF0-SOF15,
    // minus the ones that are not frames) carries the picture's height and
    // width; everything before it is metadata whose length the chain skips.
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) {
        at += 1;
        continue;
      }
      const marker = bytes[at + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) {
        return undefined;
      }
      const length = bytes.readUInt16BE(at + 2);
      const isFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isFrame) {
        return {
          type: 'image/jpeg',
          height: bytes.readUInt16BE(at + 5),
          width: bytes.readUInt16BE(at + 7),
        };
      }
      if (length < 2) {
        return undefined;
      }
      at += 2 + length;
    }
    // A header-only JPEG whose frame never arrived is not a picture we can size.
    return undefined;
  },
  webp: (bytes) => {
    if (
      bytes.length < 30 ||
      bytes.toString('latin1', 0, 4) !== 'RIFF' ||
      bytes.toString('latin1', 8, 12) !== 'WEBP'
    ) {
      return undefined;
    }
    const chunk = bytes.toString('latin1', 12, 16);
    if (chunk === 'VP8X') {
      return {
        type: 'image/webp',
        width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
        height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
      };
    }
    if (chunk === 'VP8 ') {
      return {
        type: 'image/webp',
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return {
        type: 'image/webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    return undefined;
  },
  avif: (bytes) => {
    if (bytes.length <= 32 || bytes.toString('latin1', 4, 8) !== 'ftyp') {
      return undefined;
    }
    const major = bytes.toString('latin1', 8, 12);
    if (major !== 'avif' && major !== 'avis' && major !== 'mif1') {
      return undefined;
    }
    const at = bytes.indexOf('ispe', 12, 'latin1');
    if (at < 0 || at + 16 > bytes.length) {
      return undefined;
    }
    return {
      type: 'image/avif',
      width: bytes.readUInt32BE(at + 8),
      height: bytes.readUInt32BE(at + 12),
    };
  },
  ico: (bytes) =>
    bytes.length > 22 && bytes.readUInt32BE(0) === 0x00000100 && bytes.readUInt16LE(4) > 0
      ? { type: 'image/x-icon', width: bytes[6] || 256, height: bytes[7] || 256 }
      : undefined,
  /**
   * SVG, deliberately strict. An XML declaration, comments and a doctype with
   * no internal subset may come first; nothing else may. The comment group
   * cannot run past its own `-->`, so this takes linear time on any run of
   * them rather than backtracking across the whole document.
   */
  svg: (bytes) => {
    const head = bytes.toString('utf8', 0, Math.min(bytes.length, 4096));
    // The optional BOM is written as an escape: a literal one is invisible.
    return /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--(?:(?!-->)[\s\S])*-->\s*|<!DOCTYPE svg[^>[]*>\s*)*<svg[\s>]/i.test(
      head,
    )
      ? { type: 'image/svg+xml', width: 0, height: 0 }
      : undefined;
  },
};

/**
 * `{type, width, height}` for a body this service may serve, or null.
 *
 * Order matters only for speed: the cheap signature checks run before the SVG
 * regex. Nothing here trusts a length field for anything but describing the
 * picture — the body's own size is enforced by the fetcher.
 */
export const picInfo = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) {
    return null;
  }
  for (const read of Object.values(SIGNATURES)) {
    const info = read(bytes);
    if (info) {
      return info;
    }
  }
  return null;
};

/** Whether this picture is small enough to hand a reader's browser. */
export const pixelCap = (info) =>
  info.width === 0 && info.height === 0
    ? true
    : info.width > 0 && info.height > 0 && info.width * info.height <= MAX_PIXELS;

/** An SVG is markup, so it gets a size budget of its own (bytes, not pixels). */
export const SVG_MAX_BYTES = 512 * 1024;