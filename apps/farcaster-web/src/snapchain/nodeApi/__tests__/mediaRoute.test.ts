/**
 * The media route through the adapter: what the composer used to get a 501 for.
 *
 * The composer's first request for a photo is `POST /v1/generate-image-upload-url`
 * (Warpcast mints a signed Cloudflare URL there). It is not a node read and it
 * is not an indexer feature: it is the media pipeline, which is now ours. These
 * tests pin that the adapter answers it with our own media host, that the URL it
 * answers with is the one the uploader recognises, and that everything media-ish
 * which is genuinely Warpcast's own (video transcoding, attachment resolution)
 * still says so rather than pretending.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  classifyHostedRequest,
  createNodeBackedFetch,
  isOwnMediaUploadUrl,
  mediaUploadUrl,
} from '~/snapchain/nodeApi';

import { offlineEmbedKinds } from './fakeEmbedKinds';

const MEDIA_ENV = { VITE_FIDDY_MEDIA_URL: 'http://localhost:3217' };

const buildHarness = ({
  mediaUploadUrl: injected,
}: { mediaUploadUrl?: string } = {}) => {
  const nodeFetch = vi.fn(async () => new Response('{}', { status: 200 }));
  const handle = createNodeBackedFetch({
    nodeBaseUrl: 'http://node.test',
    embedKinds: offlineEmbedKinds(),
    getSignedInFid: () => 3,
    fetchImpl: nodeFetch as unknown as typeof fetch,
    ...(injected ? { mediaUploadUrl: injected } : {}),
  });
  return { fetch: handle.fetch, nodeFetch, log: handle.log };
};

describe('the media pipeline through the adapter', () => {
  it('answers the image upload URL with our own media host, not a 501', async () => {
    const {
      fetch: nodeBackedFetch,
      nodeFetch,
      log,
    } = buildHarness({
      mediaUploadUrl: 'http://localhost:3217/api/fiddy/media',
    });

    const response = await nodeBackedFetch(
      'https://farcaster.xyz/~api/v1/generate-image-upload-url',
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { url: string; optimisticImageId: string };
    };
    expect(body.result.url).toBe('http://localhost:3217/api/fiddy/media');
    expect(body.result.optimisticImageId.length).toBeGreaterThan(0);
    // The composer decides which pipeline it is in from this URL alone.
    expect(isOwnMediaUploadUrl(body.result.url, MEDIA_ENV)).toBe(true);
    // Nothing was asked of the node: this answer is not a node read.
    expect(nodeFetch).not.toHaveBeenCalled();
    expect(log.at(-1)?.kind).toBe('media');
  });

  it('mints a fresh id per request, and never the Cloudflare shape it replaced', async () => {
    const { fetch: nodeBackedFetch } = buildHarness({
      mediaUploadUrl: 'http://localhost:3217/api/fiddy/media',
    });
    const ids = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const body = (await (
        await nodeBackedFetch(
          'https://farcaster.xyz/~api/v1/generate-image-upload-url',
          {
            method: 'POST',
            body: JSON.stringify({}),
          },
        )
      ).json()) as { result: { url: string; optimisticImageId: string } };
      ids.add(body.result.optimisticImageId);
      expect(body.result.url).not.toMatch(/imagedelivery\.net/);
    }
    expect(ids.size).toBe(3);
  });

  it('uses this build’s configured host when none is injected', () => {
    expect(mediaUploadUrl(MEDIA_ENV)).toBe(
      'http://localhost:3217/api/fiddy/media',
    );
    expect(mediaUploadUrl({})).toBe('https://fiddy.fun/api/fiddy/media');
  });

  it('classifies the mint as media for every URL shape the client builds', () => {
    for (const url of [
      'https://farcaster.xyz/~api/v1/generate-image-upload-url',
      '/~api/v1/generate-image-upload-url',
      'http://localhost:8080/v1/generate-image-upload-url',
    ]) {
      expect(
        classifyHostedRequest({ method: 'POST', path: url }),
      ).toMatchObject({
        kind: 'media',
        path: '/v1/generate-image-upload-url',
      });
    }
    // A GET on the same path is not the endpoint we know: it stays unclassified
    // rather than being answered with a media URL nobody asked for.
    expect(
      classifyHostedRequest({
        method: 'GET',
        path: '/v1/generate-image-upload-url',
      }).kind,
    ).toBe('hosted');
  });

  it('still says whose job the rest of the media pipeline is', async () => {
    const expectations: [string, string, RegExp][] = [
      ['POST', '/v1/prepare-video-upload', /transcoding/],
      ['POST', '/v1/upload-video-with-tus', /Cloudflare bucket/],
      ['GET', '/v1/uploaded-video', /Warpcast’s pipeline/],
      ['DELETE', '/v1/uploaded-video', /Warpcast’s pipeline/],
      ['PUT', '/v2/cast-attachments', /hosted indexer/],
    ];

    for (const [method, path, message] of expectations) {
      const { fetch: nodeBackedFetch, nodeFetch } = buildHarness();
      const response = await nodeBackedFetch(
        `https://farcaster.xyz/~api${path}`,
        { method },
      );
      expect(response.status).toBe(501);
      expect(JSON.stringify(await response.json())).toMatch(message);
      expect(nodeFetch).not.toHaveBeenCalled();
    }
  });

  it('keeps a write’s body readable for a probe only when the debug surface is on', async () => {
    const embed = 'http://localhost:3217/api/fiddy/media/abc123.jpg';
    vi.stubEnv('VITE_SNAPCHAIN_DEBUG', 'true');
    const loud = buildHarness({
      mediaUploadUrl: 'http://localhost:3217/api/fiddy/media',
    });
    await loud.fetch('https://farcaster.xyz/~api/v2/casts', {
      method: 'POST',
      body: JSON.stringify({ text: 'a photo', embeds: [embed] }),
    });

    // The submit is a real write now (it used to be a `hosted` refusal). No app
    // key is injected here, so the honest answer is the one-step sentence that
    // names how to get one — and what the composer carried is still on the log,
    // which is the only trace of a write that never leaves the page.
    const write = loud.log.at(-1);
    expect(write).toMatchObject({
      method: 'POST',
      path: '/~api/v2/casts',
      kind: 'write',
      status: 501,
    });
    expect(write?.bodyPreview).toContain(embed);
    // The probe's handle on the same array: adapter-answered writes never leave
    // the page, so this is the only trace of what a composer submitted.
    expect(
      (globalThis as unknown as Record<string, unknown>).__nodeBackedRequests,
    ).toBe(loud.log);

    vi.stubEnv('VITE_SNAPCHAIN_DEBUG', '');
    const quiet = buildHarness();
    await quiet.fetch('https://farcaster.xyz/~api/v2/casts', {
      method: 'POST',
      body: JSON.stringify({ text: 'a photo', embeds: [embed] }),
    });
    expect(quiet.log.at(-1)?.bodyPreview).toBeUndefined();
    vi.unstubAllEnvs();
  });
});
