/**
 * The app catalog, as tests.
 *
 * The mini-app surfaces read four endpoints the hosted API used to serve, and
 * the honest source for all four is Neynar's own catalog of apps. What this file
 * protects is that the translation is real: the shapes the pages read, the
 * paging the surfaces rely on, the fields left absent rather than invented, and
 * the one thing that must never happen — a near-miss match putting a different
 * app's art on somebody else's link.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  answerFromNeynar,
  apiFrameFromNeynarFrame,
  fetchFrameCardFromNeynar,
  neynarCallFor,
} from '~/snapchain/providers/neynarMap';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** One frame as Neynar publishes it, shaped like the live answer. */
const NEYNAR_FRAME = {
  version: 'next',
  frames_url: 'https://app.example',
  image: 'https://app.example/image.png',
  author: {
    fid: 191554,
    username: 'ivc',
    display_name: 'ivc',
    pfp_url: 'https://example.com/pfp.png',
    follower_count: 2802,
    following_count: 434,
  },
  manifest: {
    account_association: { header: 'a', payload: 'b', signature: 'c' },
    frame: { name: 'Older spelling', home_url: 'https://app.example' },
    miniapp: {
      version: '1',
      name: 'Example App',
      home_url: 'https://app.example',
      icon_url: 'https://app.example/icon.png',
      splash_image_url: 'https://app.example/splash.png',
      splash_background_color: '#0a091a',
      webhook_url: 'https://app.example/webhook',
      subtitle: 'Lock. Tip. Create.',
      description: 'Tipping for Farcaster',
      tagline: 'Lock',
      primary_category: 'social',
      tags: ['tipping', 'base', ''],
      screenshot_urls: ['https://app.example/cover.png', 'not-a-url'],
      hero_image_url: 'https://app.example/hero.png',
      og_title: 'Example',
      og_description: 'Example, described',
      og_image_url: 'https://app.example/og.png',
    },
  },
};

const catalogPayload = (frames: unknown[], cursor?: string | null) => ({
  frames,
  next: { cursor: cursor ?? null },
});

const callFor = (
  path: string,
  params: Record<string, string> = {},
  signedInFid?: number,
) =>
  neynarCallFor({
    path,
    searchParams: new URLSearchParams(params),
    signedInFid,
    baseUrl: 'https://api.neynar.test',
  });

describe('which catalog read a surface becomes', () => {
  it('asks Neynar’s catalog for the list of apps', () => {
    expect(callFor('/v1/top-mini-apps', { limit: '50' })).toEqual({
      url: 'https://api.neynar.test/v2/farcaster/frame/catalog/?limit=50',
      kind: 'frames',
      shape: 'top-mini-apps',
    });
  });

  it('asks the same catalog for “new apps”, in that surface’s envelope', () => {
    expect(callFor('/v1/new-frameapps', { limit: '50' })?.shape).toBe(
      'new-frames',
    );
  });

  it('carries Neynar’s own cursor through a paged read', () => {
    expect(
      callFor('/v1/top-mini-apps', { limit: '2', cursor: 'abc===' })?.url,
    ).toContain('cursor=abc%3D%3D');
  });

  it('asks for the apps relevant to the signed-in reader', () => {
    expect(callFor('/v1/favorite-frames', { limit: '20' }, 191554)).toEqual({
      url: 'https://api.neynar.test/v2/farcaster/frame/relevant/?viewer_fid=191554&limit=20',
      kind: 'frames',
      shape: 'favorite-frames',
    });
  });

  it('cannot ask what is relevant without an account', () => {
    expect(callFor('/v1/favorite-frames', { limit: '20' })).toBeNull();
  });

  it('searches apps through Neynar, by the query the surface sent', () => {
    expect(
      callFor('/v1/search-miniapps', { query: 'fiddy.fun', limit: '20' }),
    ).toEqual({
      url: 'https://api.neynar.test/v2/farcaster/frame/search/?q=fiddy.fun&limit=20',
      kind: 'frames',
      shape: 'search-miniapps',
    });
  });

  it('will not search for nothing', () => {
    expect(callFor('/v1/search-miniapps', { limit: '20' })).toBeNull();
  });
});

describe('a Neynar frame as the fork’s ApiFrame', () => {
  it('carries the app’s own manifest into the shape the pages read', () => {
    const frame = apiFrameFromNeynarFrame(NEYNAR_FRAME);

    expect(frame).toMatchObject({
      domain: 'app.example',
      name: 'Example App',
      iconUrl: 'https://app.example/icon.png',
      // `URL` canonicalizes a host-only address with its trailing slash.
      homeUrl: 'https://app.example/',
      imageUrl: 'https://app.example/image.png',
      splashImageUrl: 'https://app.example/splash.png',
      splashBackgroundColor: '#0a091a',
      subtitle: 'Lock. Tip. Create.',
      description: 'Tipping for Farcaster',
      primaryCategory: 'social',
      supportsNotifications: true,
    });
    expect(frame?.tags).toEqual(['tipping', 'base']);
    expect(frame?.screenshotUrls).toEqual(['https://app.example/cover.png']);
    expect(frame?.author?.fid).toBe(191554);
  });

  it('leaves a field Neynar did not state absent, never invented', () => {
    const frame = apiFrameFromNeynarFrame({
      version: 'next',
      frames_url: 'https://bare.example',
      manifest: {
        frame: {
          name: 'Bare',
          home_url: 'https://bare.example',
          icon_url: 'https://bare.example/icon.png',
        },
      },
    });

    expect(frame).not.toBeNull();
    expect(frame?.imageUrl).toBeUndefined();
    expect(frame?.heroImageUrl).toBeUndefined();
    expect(frame?.primaryCategory).toBeUndefined();
    expect(frame?.tags).toBeUndefined();
    expect(frame?.author).toBeUndefined();
    // No webhook in the manifest: this app did not register for notifications.
    expect(frame?.supportsNotifications).toBe(false);
  });

  it('drops a category the fork does not name', () => {
    const frame = apiFrameFromNeynarFrame({
      frames_url: 'https://odd.example',
      manifest: {
        miniapp: {
          name: 'Odd',
          home_url: 'https://odd.example',
          icon_url: 'https://odd.example/icon.png',
          primary_category: 'interpretive-dance',
        },
      },
    });

    expect(frame?.primaryCategory).toBeUndefined();
  });

  it('will not carry a picture a page can never load', () => {
    const frame = apiFrameFromNeynarFrame({
      frames_url: 'http://insecure.example',
      manifest: {
        miniapp: {
          name: 'Insecure',
          home_url: 'https://insecure.example',
          icon_url: 'http://insecure.example/icon.png',
        },
      },
    });

    expect(frame).toBeNull();
  });

  it('has no card for an app with no picture at all', () => {
    expect(
      apiFrameFromNeynarFrame({
        manifest: {
          miniapp: { name: 'Blank', home_url: 'https://blank.example' },
        },
      }),
    ).toBeNull();
  });

  it('prefers the newer manifest spelling when both are present', () => {
    // NEYNAR_FRAME carries both `manifest.frame` ("Older spelling") and
    // `manifest.miniapp` ("Example App"); the miniapp one is the current tag.
    expect(apiFrameFromNeynarFrame(NEYNAR_FRAME)?.name).toBe('Example App');
  });
});

describe('the four envelopes the surfaces read', () => {
  const neynarFetch = (payload: unknown) =>
    vi.fn(async () => jsonResponse(payload));

  it('answers the top list, ranked, in the shape the page reads', async () => {
    const response = await answerFromNeynar({
      path: '/v1/top-mini-apps',
      searchParams: new URLSearchParams({ limit: '2' }),
      signedInFid: 3,
      apiKey: 'test-key',
      fetchImpl: neynarFetch(catalogPayload([NEYNAR_FRAME], 'next-cursor')),
    });
    const body = (await response.json()) as {
      result: { miniApps: { rank: number; miniApp: { name: string } }[] };
      next?: { cursor?: string };
    };

    expect(response.status).toBe(200);
    expect(body.result.miniApps[0]?.rank).toBe(1);
    expect(body.result.miniApps[0]?.miniApp.name).toBe('Example App');
    expect(body.next?.cursor).toBe('next-cursor');
  });

  it('answers “new apps” with the title and description that surface prints', async () => {
    const response = await answerFromNeynar({
      path: '/v1/new-frameapps',
      searchParams: new URLSearchParams({ limit: '50' }),
      signedInFid: 3,
      apiKey: 'test-key',
      fetchImpl: neynarFetch(catalogPayload([NEYNAR_FRAME])),
    });
    const body = (await response.json()) as {
      result: { frames: unknown[]; title: string; description: string };
    };

    expect(body.result.frames).toHaveLength(1);
    expect(body.result.title).toBe('Mini apps');
    expect(body.result.description).toContain('Neynar');
  });

  it('answers “your apps” from the relevance list', async () => {
    const response = await answerFromNeynar({
      path: '/v1/favorite-frames',
      searchParams: new URLSearchParams({ limit: '20' }),
      signedInFid: 191554,
      apiKey: 'test-key',
      fetchImpl: neynarFetch({
        relevant_frames: [
          {
            frame: NEYNAR_FRAME,
            top_relevant_users: [],
            remaining_relevant_users: 0,
          },
        ],
      }),
    });
    const body = (await response.json()) as { result: { frames: unknown[] } };

    expect(body.result.frames).toHaveLength(1);
  });

  it('answers app search in the search envelope', async () => {
    const response = await answerFromNeynar({
      path: '/v1/search-miniapps',
      searchParams: new URLSearchParams({ query: 'fiddy', limit: '20' }),
      signedInFid: 3,
      apiKey: 'test-key',
      fetchImpl: neynarFetch(catalogPayload([NEYNAR_FRAME])),
    });
    const body = (await response.json()) as { result: { apps: unknown[] } };

    expect(body.result.apps).toHaveLength(1);
  });

  it('says so in plain words when there is no account to be relevant to', async () => {
    const response = await answerFromNeynar({
      path: '/v1/favorite-frames',
      searchParams: new URLSearchParams({ limit: '20' }),
      signedInFid: undefined,
      apiKey: 'test-key',
      fetchImpl: neynarFetch(catalogPayload([])),
    });
    const body = (await response.json()) as { errors: { message: string }[] };

    expect(response.status).toBe(501);
    expect(body.errors[0]?.message).toContain('signed-in account');
  });
});

describe('a feed embed’s app card from the index', () => {
  const search = (frames: unknown[]) =>
    vi.fn(async () => jsonResponse({ frames }));

  it('accepts the app whose own home page is that host', async () => {
    const card = await fetchFrameCardFromNeynar({
      url: 'https://app.example/client/deploy',
      apiKey: 'test-key',
      fetchImpl: search([NEYNAR_FRAME]),
      baseUrl: 'https://api.neynar.test',
    });

    expect(card).toEqual({
      imageUrl: 'https://app.example/image.png',
      title: 'Open Example App',
      actionUrl: 'https://app.example/',
    });
  });

  it('refuses a near miss — another app’s art on this link is not an answer', async () => {
    const card = await fetchFrameCardFromNeynar({
      url: 'https://app.example/client/deploy',
      apiKey: 'test-key',
      fetchImpl: search([
        {
          frames_url: 'https://elsewhere.example',
          manifest: {
            miniapp: {
              name: 'Elsewhere',
              home_url: 'https://elsewhere.example',
              icon_url: 'https://elsewhere.example/icon.png',
            },
          },
        },
      ]),
      baseUrl: 'https://api.neynar.test',
    });

    expect(card).toBeNull();
  });

  it('asks by the host, then by its label, and stops at the first exact answer', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse(
        url.includes('q=fiddy.fun')
          ? { frames: [] }
          : { frames: [NEYNAR_FRAME] },
      );
    });

    const card = await fetchFrameCardFromNeynar({
      url: 'https://fiddy.fun/client/deploy',
      apiKey: 'test-key',
      fetchImpl,
      baseUrl: 'https://api.neynar.test',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain('q=fiddy.fun');
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('q=fiddy');
    expect(card).toBeNull();
  });

  it('never sends the key as a query parameter', async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ frames: [NEYNAR_FRAME] }),
    );

    await fetchFrameCardFromNeynar({
      url: 'https://app.example/',
      apiKey: 'secret-key',
      fetchImpl,
      baseUrl: 'https://api.neynar.test',
    });

    const [input, init] = fetchImpl.mock.calls[0] ?? [undefined, undefined];
    expect(String(input)).not.toContain('secret-key');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe(
      'secret-key',
    );
  });
});
