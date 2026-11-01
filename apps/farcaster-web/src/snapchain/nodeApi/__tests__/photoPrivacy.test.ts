/**
 * What leaves the device inside a photo or a video.
 *
 * The photo tests prove the three halves that matter: that the picture really is
 * decoded and re-encoded at a bounded size (so the metadata blocks are not in the
 * output at all), that a picture with anything see-through in it is written out
 * as a PNG rather than an opaque JPEG with a white box baked behind its
 * transparent pixels, and that a browser which cannot do it still sends the file
 * rather than failing the post.
 *
 * The video test builds a real container by hand — `ftyp`, a `moov` holding a
 * `udta` with a location atom and an `mvhd`, then `mdat` — and checks that the
 * location is gone, the box sizes are untouched (so the file still plays), and
 * the atoms that carry the actual stream are still there.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_PHOTO_EDGE,
  type PhotoEncoding,
  type ScrubEnvironment,
  scrubForUpload,
  scrubPhoto,
  scrubVideo,
} from '~/snapchain/nodeApi/photoPrivacy';

/** A fake decoded bitmap, as `createImageBitmap` would hand back. */
const bitmap = (width: number, height: number) => {
  const close = vi.fn();
  return { width, height, close, _close: close };
};

const encoded = (type: PhotoEncoding = 'image/jpeg') =>
  new Blob([new Uint8Array(64)], { type });

/** A picture nothing can see through, which is what most photos are. */
const opaque = async () => false;

describe('photos', () => {
  it('decodes, scales to the long edge, and sends the re-encoded bytes', async () => {
    const decoded = bitmap(4000, 3000);
    const encode = vi.fn(async () => encoded());
    const environment: ScrubEnvironment = {
      decode: vi.fn(async () => decoded),
      scanAlpha: opaque,
      encode,
    };

    const file = new Blob([new Uint8Array(1024)], { type: 'image/jpeg' });
    const result = await scrubPhoto({ file, environment });

    expect(result.changed).toBe(true);
    expect(result.file.type).toBe('image/jpeg');
    // 4000×3000 scaled to a 2048 long edge
    expect(encode).toHaveBeenCalledWith(
      decoded,
      MAX_PHOTO_EDGE,
      1536,
      'image/jpeg',
    );
    expect(decoded._close).toHaveBeenCalled();
  });

  it('keeps a see-through picture see-through, by writing a PNG', async () => {
    const decode = vi.fn(async () => bitmap(1000, 1000));
    const encode = vi.fn(
      async (_bitmap, _width, _height, type: PhotoEncoding) => encoded(type),
    );

    const file = new Blob([new Uint8Array(64)], { type: 'image/png' });
    const result = await scrubPhoto({
      file,
      environment: { decode, scanAlpha: async () => true, encode },
    });

    expect(result.changed).toBe(true);
    expect(result.file.type).toBe('image/png');
    expect(encode).toHaveBeenCalledWith(
      expect.anything(),
      1000,
      1000,
      'image/png',
    );
  });

  it('does not scan a JPEG, which has no alpha channel to find', async () => {
    const scanAlpha = vi.fn(opaque);
    const encode = vi.fn(async () => encoded());

    await scrubPhoto({
      file: new Blob([new Uint8Array(64)], { type: 'image/jpeg' }),
      environment: {
        decode: async () => bitmap(900, 900),
        scanAlpha,
        encode,
      },
    });

    expect(scanAlpha).not.toHaveBeenCalled();
    expect(encode).toHaveBeenCalledWith(
      expect.anything(),
      900,
      900,
      'image/jpeg',
    );
  });

  it('treats a WebP like a PNG: scanned, and PNG out when it is see-through', async () => {
    const encode = vi.fn(async () => encoded('image/png'));

    const result = await scrubPhoto({
      file: new Blob([new Uint8Array(64)], { type: 'image/webp' }),
      environment: {
        decode: async () => bitmap(300, 200),
        scanAlpha: async () => true,
        encode,
      },
    });

    expect(result.file.type).toBe('image/png');
    expect(encode).toHaveBeenCalledWith(
      expect.anything(),
      300,
      200,
      'image/png',
    );
  });

  it('leaves a small photo at its own size', async () => {
    const decode = vi.fn(async () => bitmap(800, 600));
    const encode = vi.fn(async () => encoded());

    await scrubPhoto({
      file: new Blob([new Uint8Array(8)], { type: 'image/png' }),
      environment: { decode, scanAlpha: opaque, encode },
    });

    expect(encode).toHaveBeenCalledWith(
      expect.anything(),
      800,
      600,
      'image/jpeg',
    );
  });

  it('sends a picture as it came when this browser cannot scan or encode it', async () => {
    const file = new Blob([new Uint8Array(16)], { type: 'image/png' });

    const result = await scrubPhoto({
      file,
      // No `scanAlpha`: a browser that cannot scan would have to guess whether
      // to bake a white box, so it re-encodes nothing at all.
      environment: {
        decode: async () => bitmap(100, 100),
        encode: async () => encoded(),
      },
    });

    expect(result.changed).toBe(false);
    expect(result.file).toBe(file);
    expect(result.reason).toMatch(/cannot re-encode/);
  });

  it('sends the original when this browser cannot decode it', async () => {
    const file = new Blob([new Uint8Array(16)], { type: 'image/jpeg' });

    const result = await scrubPhoto({
      file,
      environment: {
        decode: async () => {
          throw new Error('unsupported');
        },
        scanAlpha: opaque,
        encode: async () => encoded(),
      },
    });

    expect(result.changed).toBe(false);
    expect(result.file).toBe(file);
    expect(result.reason).toMatch(/could not read the photo/);
  });

  it('sends the original when the re-encode comes back empty', async () => {
    const file = new Blob([new Uint8Array(16)], { type: 'image/webp' });

    const result = await scrubPhoto({
      file,
      environment: {
        decode: async () => bitmap(100, 100),
        scanAlpha: opaque,
        encode: async () => null,
      },
    });

    expect(result.changed).toBe(false);
    expect(result.file).toBe(file);
  });

  it('has nothing to do with a GIF', async () => {
    const file = new Blob([new Uint8Array(16)], { type: 'image/gif' });

    const result = await scrubPhoto({ file });

    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/not a photo this client re-encodes/);
  });
});

/** Build one ISO-BMFF box: 4-byte size, 4-char type, then the payload. */
const box = (type: string, payload: Uint8Array) => {
  const bytes = new Uint8Array(8 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  for (let i = 0; i < 4; i++) {
    bytes[4 + i] = type.charCodeAt(i);
  }
  bytes.set(payload, 8);
  return bytes;
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const readType = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(
    bytes[offset + 4],
    bytes[offset + 5],
    bytes[offset + 6],
    bytes[offset + 7],
  );

const asText = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');

describe('videos', () => {
  const buildVideo = () => {
    const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d]));
    const mvhd = box('mvhd', new Uint8Array(16));
    const udta = box('udta', new Uint8Array([0x40, 0x40, 0x40, 0x40]));
    const moov = box('moov', concat(mvhd, udta));
    const mdat = box('mdat', new Uint8Array([0xaa, 0xbb, 0xcc]));

    return concat(ftyp, moov, mdat);
  };

  it('overwrites the location box and leaves every size alone', async () => {
    const bytes = buildVideo();
    const file = new Blob([bytes], { type: 'video/mp4' });

    const result = await scrubVideo(file);

    expect(result.changed).toBe(true);

    const after = new Uint8Array(await result.file.arrayBuffer());

    // Same length: nothing was re-indexed, so the file still plays.
    expect(after.length).toBe(bytes.length);
    // The container and the media data are untouched.
    expect(readType(after, 0)).toBe('ftyp');
    expect(readType(after, 12)).toBe('moov');
    expect(asText(after)).toContain('mvhd');
    expect(asText(after)).toContain('mdat');
    // The location box is gone…
    expect(asText(after)).not.toContain('udta');
    // …and where it was there is now a zeroed `free` box of the same size.
    expect(readType(after, 12 + 8 + 24)).toBe('free');
  });

  it('sends a video it cannot read as it came', async () => {
    const file = {
      type: 'video/mp4',
      size: 8,
      arrayBuffer: async () => new ArrayBuffer(4),
    } as unknown as Blob;

    const result = await scrubVideo(file);

    expect(result.changed).toBe(false);
    expect(result.file).toBe(file);
  });

  it('has nothing to do with a WebM', async () => {
    const file = new Blob([new Uint8Array(16)], { type: 'video/webm' });

    const result = await scrubVideo(file);

    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/not a video this client strips/);
  });
});

describe('whatever the file is', () => {
  it('routes a PNG to the photo path and an MP4 to the video path', async () => {
    const decode = vi.fn(async () => bitmap(100, 100));
    const encode = vi.fn(async () => encoded());

    const photo = await scrubForUpload({
      file: new Blob([new Uint8Array(16)], { type: 'image/png' }),
      environment: { decode, scanAlpha: opaque, encode },
    });

    expect(photo.changed).toBe(true);
    expect(decode).toHaveBeenCalled();

    const video = await scrubForUpload({
      file: new Blob([buildVideoLike()], { type: 'video/quicktime' }),
    });

    expect(video.changed).toBe(true);
  });

  it('says what it left alone, rather than pretending it did something', async () => {
    const result = await scrubForUpload({
      file: new Blob([new Uint8Array(4)], { type: 'application/pdf' }),
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toMatch(/nothing to strip from application\/pdf/);
  });
});

/** A tiny but structurally valid MOV: ftyp, moov{mvhd, udta}, mdat. */
const buildVideoLike = () =>
  concat(
    box('ftyp', new Uint8Array([0x71, 0x74, 0x20, 0x20])),
    box(
      'moov',
      concat(box('mvhd', new Uint8Array(12)), box('udta', new Uint8Array(4))),
    ),
    box('mdat', new Uint8Array([1, 2, 3])),
  );
