/**
 * The client's side of the media pipeline.
 *
 * These tests pin the three things that made the composer fail with
 * "Image upload failed - generateImageUploadUrl 501":
 *   1. the upload URL is ours, and comes from `VITE_FIDDY_MEDIA_URL`
 *      (default https://fiddy.fun) with the documented local fallback,
 *   2. the URL our adapter hands out is the same one this module recognises, so
 *      the composer knows which pipeline it is in,
 *   3. a refusal from the media host is a sentence a person can read, never a
 *      status code, and never the words "Cloudflare" or "501".
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MEDIA_BASE_URL,
  isOwnMediaUploadUrl,
  MEDIA_UPLOAD_FAILED_MESSAGE,
  MediaUploadError,
  mediaUploadUrl,
  resolveMediaBaseUrl,
  uploadMedia,
} from '~/snapchain/nodeApi/mediaUpload';

const jpeg = new File(
  [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])],
  'snap.jpg',
  {
    type: 'image/jpeg',
  },
);

const envWith = (value: string | undefined) => ({
  VITE_FIDDY_MEDIA_URL: value,
});

const okResponse = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('where the bytes go', () => {
  it('defaults to the production host and can be pointed at a local service', () => {
    expect(resolveMediaBaseUrl({})).toBe(DEFAULT_MEDIA_BASE_URL);
    expect(resolveMediaBaseUrl(envWith(undefined))).toBe(
      DEFAULT_MEDIA_BASE_URL,
    );
    expect(resolveMediaBaseUrl(envWith('http://localhost:3217'))).toBe(
      'http://localhost:3217',
    );
    expect(resolveMediaBaseUrl(envWith('https://media.example/'))).toBe(
      'https://media.example',
    );
    expect(
      resolveMediaBaseUrl(envWith('  https://media.example/base/  ')),
    ).toBe('https://media.example/base');
    expect(mediaUploadUrl(envWith('http://localhost:3217'))).toBe(
      'http://localhost:3217/api/fiddy/media',
    );
  });

  it('falls back to the production host rather than inventing a broken one', () => {
    expect(resolveMediaBaseUrl(envWith('not a url'))).toBe(
      DEFAULT_MEDIA_BASE_URL,
    );
    expect(resolveMediaBaseUrl(envWith('ftp://media.example'))).toBe(
      DEFAULT_MEDIA_BASE_URL,
    );
    expect(resolveMediaBaseUrl(envWith(''))).toBe(DEFAULT_MEDIA_BASE_URL);
  });

  it('recognises exactly the upload URL the adapter hands out, and nothing else', () => {
    const env = envWith('http://localhost:3217');
    expect(isOwnMediaUploadUrl(mediaUploadUrl(env), env)).toBe(true);
    expect(
      isOwnMediaUploadUrl('http://localhost:3217/api/fiddy/media/', env),
    ).toBe(false);
    expect(isOwnMediaUploadUrl('https://fiddy.fun/api/fiddy/media', env)).toBe(
      false,
    );
    expect(
      isOwnMediaUploadUrl(
        'https://upload.imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/signed-upload-url',
        env,
      ),
    ).toBe(false);
    expect(isOwnMediaUploadUrl('nonsense', env)).toBe(false);
  });
});

describe('uploading the bytes', () => {
  it('posts the file and keeps the URL the media host confirmed', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        ok: true,
        url: 'https://fiddy.fun/api/fiddy/media/abc123.jpg',
        sha256: 'abc123',
        bytes: 6,
        contentType: 'image/jpeg',
        ext: 'jpg',
        deduped: false,
      }),
    ) as unknown as typeof fetch;

    const uploaded = await uploadMedia({
      file: jpeg,
      uploadUrl: 'https://fiddy.fun/api/fiddy/media',
      fetchImpl,
    });

    expect(uploaded).toMatchObject({
      url: 'https://fiddy.fun/api/fiddy/media/abc123.jpg',
      sha256: 'abc123',
      bytes: 6,
      contentType: 'image/jpeg',
      ext: 'jpg',
      deduped: false,
    });

    const [calledUrl, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://fiddy.fun/api/fiddy/media');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('says what the host said when the file is refused, in the host’s own words', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          code: 'MEDIA_TOO_LARGE',
          message:
            'that file is too big - 25MB is the limit. try a smaller one.',
        }),
        { status: 413, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    await expect(
      uploadMedia({
        file: jpeg,
        uploadUrl: 'https://fiddy.fun/api/fiddy/media',
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: 'MediaUploadError',
      message: 'that file is too big - 25MB is the limit. try a smaller one.',
    });
  });

  it('never leaks a status code or another company’s name when the host misbehaves', async () => {
    const unreadable = (async () =>
      new Response('<html>502 Bad Gateway</html>', {
        status: 502,
      })) as unknown as typeof fetch;
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    for (const fetchImpl of [unreadable, offline]) {
      const error = await uploadMedia({
        file: jpeg,
        uploadUrl: 'https://fiddy.fun/api/fiddy/media',
        fetchImpl,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MediaUploadError);
      const message = (error as Error).message;
      expect(message).not.toMatch(/502|501|Cloudflare|Bad Gateway|TypeError/);
      expect(message).toMatch(/try again|didn't make it/);
      expect(MEDIA_UPLOAD_FAILED_MESSAGE).toContain("the photo didn't make it");
    }
  });
});
