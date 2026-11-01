/**
 * What leaves the device inside a photo, and what does not.
 *
 * A phone photo is not just pixels: it usually carries where it was taken, when,
 * and with what — and this client's media host stores exactly the bytes it is
 * given. Re-encoding the picture before it is sent is the cheapest privacy win
 * there is: the pixels a person chose to share reach the network, and the
 * location they did not choose to share does not.
 *
 * WHAT HAPPENS
 *
 *  - JPEG, PNG and WebP are re-encoded no larger than 2048px on the long edge
 *    (quality 0.88). Draw the pixels onto a fresh canvas and encode it again,
 *    and every metadata block a camera or a screenshot tool wrote is simply not
 *    in the output — there is nothing to strip, because the bytes are new.
 *    Downscaling also means a 12MP photo stops being 4MB.
 *  - A picture with a see-through pixel is encoded as PNG, and everything else
 *    as JPEG. A logo, a sticker, a cut-out or a graphic is not a photograph:
 *    writing one out as an opaque JPEG bakes a white box behind every
 *    transparent pixel, and on this app's dark background that box is the first
 *    thing anyone would see. The drawn pixels are scanned for alpha before the
 *    encode decides (once, and never for a JPEG input — that type has no alpha
 *    channel at all). This is the shape upstream quilcast chose for it
 *    (92d1aeead4af, MIT): see the note on `scanAlpha` below.
 *  - MP4 and MOV lose their `udta` (location, device) and `meta` boxes: those
 *    bytes are overwritten in place with a `free` box, which keeps every offset
 *    and size untouched, so the video plays exactly as before.
 *  - GIFs and WebM are sent as they are: re-encoding an animation here would
 *    either lose frames or cost more than it saves.
 *
 * WHAT THIS IS NOT
 *
 * Not a guarantee about other people's clients, and not a reason to stop asking:
 * the photo still goes to a host we run and is still readable at a URL. It only
 * means the file itself carries no more than the picture.
 *
 * The decode/encode steps are injected so the decision logic is testable without
 * a browser: the real defaults are `createImageBitmap` and a canvas, and the
 * tests hand in small fakes.
 */

/** The longest edge a re-encoded photo is allowed to keep, in pixels. */
export const MAX_PHOTO_EDGE = 2048;

/** JPEG quality for the re-encode. High enough that a photo still looks like
 *  itself; low enough that the metadata loss is not paid for twice in bytes. */
export const PHOTO_JPEG_QUALITY = 0.88;

/** Types that are re-encoded. */
const RE_ENCODABLE_PHOTO = /^image\/(jpeg|png|webp)$/i;

/** The input type that cannot be see-through, so it is never scanned. */
const JPEG_PHOTO = /^image\/jpeg$/i;

/** Types whose metadata boxes are overwritten in place. */
const SCRUBBABLE_VIDEO = /^video\/(mp4|quicktime)$/i;

export interface PhotoScrubResult {
  /** The bytes to send. The original when nothing was done. */
  file: Blob;
  /** True when the bytes in `file` are not the bytes that came in. */
  changed: boolean;
  /** Why nothing was done, when nothing was done. */
  reason?: string;
}

/** A decoded picture, as `createImageBitmap` hands one back. */
export interface DecodedPhoto {
  width: number;
  height: number;
}

/** The types a re-encoded picture comes back as: PNG while anything in it is
 *  see-through, JPEG otherwise. */
export type PhotoEncoding = 'image/jpeg' | 'image/png';

/** The browser pieces this module needs, so a test can supply its own. */
export interface ScrubEnvironment {
  decode?: (file: Blob) => Promise<DecodedPhoto>;
  /**
   * True when any pixel of the drawn picture is see-through.
   *
   * This is a step of its own rather than a branch hidden inside `encode`
   * because the decision it feeds — PNG or JPEG — belongs to `scrubPhoto`,
   * where a test can see it. The price is that the browser draws the picture
   * once to scan it and once to encode it; at ≤2048px that is a few
   * milliseconds in front of an upload that takes seconds, and it keeps the
   * scan replaceable with a fake.
   */
  scanAlpha?: (
    bitmap: DecodedPhoto,
    width: number,
    height: number,
  ) => Promise<boolean>;
  /** Encode the drawn result as `type`; the real one is `canvas.toBlob`. */
  encode?: (
    bitmap: DecodedPhoto,
    width: number,
    height: number,
    type: PhotoEncoding,
  ) => Promise<Blob | null>;
}

/** A re-encode needs all three steps; anything less is no re-encode at all. */
type CompleteScrubEnvironment = Required<ScrubEnvironment>;

/** The environment, or nothing when this browser cannot supply every step. */
const completeEnvironment = (
  environment: ScrubEnvironment | undefined,
): CompleteScrubEnvironment | undefined => {
  const env = environment ?? browserEnvironment();

  return env.decode && env.scanAlpha && env.encode
    ? { decode: env.decode, scanAlpha: env.scanAlpha, encode: env.encode }
    : undefined;
};

const browserEnvironment = (): ScrubEnvironment => ({
  decode: (file) => createImageBitmap(file),
  scanAlpha: async (bitmap, width, height) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    // `willReadFrequently` is this canvas's whole reason for existing: it is
    // drawn once and read straight back, and never shown.
    const context = canvas.getContext('2d', { willReadFrequently: true });

    if (!context) {
      // A browser that cannot make this context cannot make the encoder's
      // either, so nothing is re-encoded and nothing is white-filled behind a
      // transparent pixel. See `encode` below.
      return false;
    }

    context.drawImage(
      bitmap as unknown as CanvasImageSource,
      0,
      0,
      width,
      height,
    );

    const { data } = context.getImageData(0, 0, width, height);

    // Alpha is every fourth byte. Stop at the first see-through pixel there is.
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) {
        return true;
      }
    }

    return false;
  },
  encode: async (bitmap, width, height, type) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');

    if (!context) {
      return null;
    }

    if (type === 'image/jpeg') {
      // A JPEG has no alpha channel, so transparency has to land on something:
      // white, which is what a photo viewer would show. A picture that really
      // is see-through never reaches this branch — it is encoded as PNG.
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
    }

    context.drawImage(
      bitmap as unknown as CanvasImageSource,
      0,
      0,
      width,
      height,
    );

    return new Promise<Blob | null>((resolve) => {
      // The quality belongs to JPEG; `toBlob` ignores it for a PNG.
      canvas.toBlob((blob) => resolve(blob), type, PHOTO_JPEG_QUALITY);
    });
  },
});

/** Release a decoded bitmap if the browser gives us a way to. */
const closeBitmap = (bitmap: DecodedPhoto) => {
  const closable = bitmap as unknown as { close?: () => void };

  if (typeof closable.close === 'function') {
    closable.close();
  }
};

/**
 * Re-encode a photo so it carries nothing but the picture.
 *
 * Failing to re-encode is never a reason to lose the post: a photo this browser
 * cannot decode is sent as it is, and `reason` says so, because the alternative
 * ("your photo could not be sent") is worse than a photo with its camera's
 * metadata in it.
 */
export const scrubPhoto = async ({
  file,
  environment,
}: {
  file: Blob;
  environment?: ScrubEnvironment;
}): Promise<PhotoScrubResult> => {
  if (!RE_ENCODABLE_PHOTO.test(file.type)) {
    return {
      file,
      changed: false,
      reason: `not a photo this client re-encodes (${file.type || 'no type'})`,
    };
  }

  const env = completeEnvironment(environment);

  if (!env) {
    return { file, changed: false, reason: 'this browser cannot re-encode' };
  }

  try {
    const bitmap = await env.decode(file);
    const scale = Math.min(
      1,
      MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    try {
      // A JPEG cannot hold a see-through pixel, so scanning one is work with an
      // answer we already know (upstream quilcast skips it for the same reason,
      // 92d1aeead4af).
      const seeThrough = JPEG_PHOTO.test(file.type)
        ? false
        : await env.scanAlpha(bitmap, width, height);
      const type: PhotoEncoding = seeThrough ? 'image/png' : 'image/jpeg';
      const encoded = await env.encode(bitmap, width, height, type);

      if (!encoded || encoded.size === 0) {
        return {
          file,
          changed: false,
          reason: 'the re-encode produced nothing',
        };
      }

      return { file: encoded, changed: true };
    } finally {
      // The decode holds pixels in memory; give them back.
      closeBitmap(bitmap);
    }
  } catch {
    return {
      file,
      changed: false,
      reason: 'this browser could not read the photo',
    };
  }
};

/** The bytes that make up the padding of a zeroed box. */
const FREE = new Uint8Array([0x66, 0x72, 0x65, 0x65]);

interface Box {
  size: number;
  headerSize: number;
  type: string;
}

/** Read one ISO-BMFF box header at `offset`. */
const readBox = (
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  end: number,
): Box => {
  let size = view.getUint32(offset);
  let headerSize = 8;

  if (size === 1) {
    // 64-bit size
    size = Number(view.getBigUint64(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    // "to the end of the file"
    size = end - offset;
  }

  return {
    size,
    headerSize,
    type: String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    ),
  };
};

/** Overwrite `udta` and `meta` boxes with zeroed `free` boxes, recursively.
 *  Returns true when at least one box was rewritten. */
const scrubBoxes = (bytes: Uint8Array, start: number, end: number): boolean => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let rewrote = false;

  for (let offset = start; offset + 8 <= end; ) {
    const box = readBox(bytes, view, offset, end);

    if (box.size < box.headerSize || offset + box.size > end) {
      return rewrote;
    }

    if (box.type === 'udta' || box.type === 'meta') {
      bytes.set(FREE, offset + 4);
      bytes.fill(0, offset + box.headerSize, offset + box.size);
      rewrote = true;
    } else if (
      box.type === 'trak' ||
      box.type === 'mdia' ||
      box.type === 'minf'
    ) {
      rewrote =
        scrubBoxes(bytes, offset + box.headerSize, offset + box.size) ||
        rewrote;
    }

    offset += box.size;
  }

  return rewrote;
};

/** The largest video this client will read into memory to scrub, in bytes. */
export const MAX_SCRUB_VIDEO_BYTES = 64 * 1024 * 1024;

/**
 * Strip a video's location/device metadata in place.
 *
 * In place is the point: the sizes and offsets in the container are untouched,
 * so nothing downstream has to be re-indexed and the file plays identically.
 */
export const scrubVideo = async (file: Blob): Promise<PhotoScrubResult> => {
  if (!SCRUBBABLE_VIDEO.test(file.type)) {
    return {
      file,
      changed: false,
      reason: `not a video this client strips (${file.type || 'no type'})`,
    };
  }

  if (file.size > MAX_SCRUB_VIDEO_BYTES) {
    return {
      file,
      changed: false,
      reason: 'the video is too large to rewrite here',
    };
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const parts: BlobPart[] = [];
    let cursor = 0;
    /** Nothing is claimed as stripped unless a box really was rewritten. */
    let rewritten = false;

    for (let offset = 0; offset + 8 <= bytes.length; ) {
      const box = readBox(bytes, view, offset, bytes.length);

      if (box.size < box.headerSize) {
        break;
      }

      if (box.type === 'moov' && box.size < bytes.length) {
        const moov = bytes.slice(offset, offset + box.size);
        rewritten = scrubBoxes(moov, box.headerSize, moov.length) || rewritten;
        parts.push(bytes.slice(cursor, offset), moov);
        cursor = offset + box.size;
      } else if (
        (box.type === 'udta' || box.type === 'meta') &&
        box.size < bytes.length
      ) {
        parts.push(
          bytes.slice(cursor, offset + 4),
          FREE,
          new Uint8Array(box.size - 8),
        );
        cursor = offset + box.size;
        rewritten = true;
      }

      offset += box.size;
    }

    parts.push(bytes.slice(cursor));

    return rewritten
      ? { file: new Blob(parts, { type: file.type }), changed: true }
      : {
          file,
          changed: false,
          reason: 'this video carried no location or device box',
        };
  } catch {
    return {
      file,
      changed: false,
      reason: 'this browser could not read the video',
    };
  }
};

/** Whatever this file is, take the metadata out of it if we know how. */
export const scrubForUpload = async ({
  file,
  environment,
}: {
  file: Blob;
  environment?: ScrubEnvironment;
}): Promise<PhotoScrubResult> => {
  if (RE_ENCODABLE_PHOTO.test(file.type)) {
    return scrubPhoto({ file, environment });
  }

  if (SCRUBBABLE_VIDEO.test(file.type)) {
    return scrubVideo(file);
  }

  return {
    file,
    changed: false,
    reason: `nothing to strip from ${file.type || 'this file'}`,
  };
};
