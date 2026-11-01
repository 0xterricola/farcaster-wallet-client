/**
 * A cast's mini app, as Neynar tells it — and as the feed has to draw it.
 *
 * The live report this covers: a cast embedding `https://fiddy.fun/client/deploy`
 * rendered as an empty link card, with no art and no button to press. The
 * protocol stores a bare URL; Neynar is the side that read the page, and it
 * hands the page's own tags back in `embed.metadata` (`html` for open-graph,
 * `frame`/`miniapp` for the app's card). Dropping that metadata is what made the
 * embed blank.
 *
 * The fixtures are the shapes measured off the live API on 2026-10-21
 * (`/v2/farcaster/cast/conversation` for a cast by fid 191554 embedding
 * fiddy.fun/client/deploy), values included: `ogImage` as `[{ url }]`, the frame
 * on the older `frame` key with `title` / `image` / `frames_url`, and an embed
 * whose metadata carries nothing but `_status`.
 */

import { describe, expect, it } from 'vitest';

import {
  apiCastFromNeynar,
  openGraphFromNeynarEmbed,
} from '~/snapchain/providers/neynarMap';

const DEPLOY_URL = 'https://fiddy.fun/client/deploy';

/** The metadata Neynar really returned for that cast's first embed. */
const DEPLOY_METADATA = {
  _status: 'RESOLVED',
  html: {
    ogUrl: DEPLOY_URL,
    ogTitle: 'Deploy your own Farcaster node — Fiddy',
    ogDescription:
      'One click to your own read node on Google Cloud — or let Fiddy run it for you.',
    ogSiteName: 'fiddy.fun',
    ogImage: [{ url: 'https://fiddy.fun/client/assets/deploy-card.png' }],
  },
  frame: {
    version: '1',
    title: 'Deploy my node',
    image: 'https://fiddy.fun/client/assets/deploy-card.png',
    frames_url: DEPLOY_URL,
  },
};

describe('openGraphFromNeynarEmbed', () => {
  it('carries the page’s own title, description, picture and site', () => {
    const openGraph = openGraphFromNeynarEmbed(DEPLOY_URL, DEPLOY_METADATA);
    expect(openGraph.url).toBe(DEPLOY_URL);
    expect(openGraph.title).toBe('Deploy your own Farcaster node — Fiddy');
    expect(openGraph.description).toBe(
      'One click to your own read node on Google Cloud — or let Fiddy run it for you.',
    );
    expect(openGraph.image).toBe(
      'https://fiddy.fun/client/assets/deploy-card.png',
    );
    expect(openGraph.domain).toBe('fiddy.fun');
  });

  it('builds the mini-app card the feed draws and launches', () => {
    const openGraph = openGraphFromNeynarEmbed(DEPLOY_URL, DEPLOY_METADATA);
    expect(openGraph.frameEmbedNext).toEqual({
      frameUrl: DEPLOY_URL,
      frameEmbed: {
        version: 'next',
        imageUrl: 'https://fiddy.fun/client/assets/deploy-card.png',
        button: {
          title: 'Deploy my node',
          action: {
            type: 'launch_miniapp',
            name: 'Deploy your own Farcaster node — Fiddy',
            url: DEPLOY_URL,
          },
        },
      },
    });
  });

  it('reads the app’s art even when the page had no og:image', () => {
    const openGraph = openGraphFromNeynarEmbed(DEPLOY_URL, {
      _status: 'RESOLVED',
      frame: {
        version: 'next',
        title: 'Play Song',
        image: 'https://tortoise.studio/api/og/song?song=1',
        frames_url: 'https://tortoise.studio/song/a-castle-in-the-sky',
      },
    });
    expect(openGraph.image).toBe('https://tortoise.studio/api/og/song?song=1');
    expect(openGraph.frameEmbedNext?.frameEmbed?.button?.title).toBe(
      'Play Song',
    );
    expect(openGraph.frameEmbedNext?.frameEmbed?.button?.action).toMatchObject({
      type: 'launch_miniapp',
      url: 'https://tortoise.studio/song/a-castle-in-the-sky',
    });
  });

  it('prefers the newer `miniapp` spelling when both are present', () => {
    const openGraph = openGraphFromNeynarEmbed(DEPLOY_URL, {
      ...DEPLOY_METADATA,
      miniapp: {
        version: 'next',
        title: 'Open the app',
        image: 'https://fiddy.fun/client/assets/newer-card.png',
        frames_url: 'https://fiddy.fun/client/deploy/',
      },
    });
    expect(openGraph.frameEmbedNext?.frameEmbed?.imageUrl).toBe(
      'https://fiddy.fun/client/assets/newer-card.png',
    );
    expect(openGraph.frameEmbedNext?.frameUrl).toBe(
      'https://fiddy.fun/client/deploy/',
    );
  });

  it('names a button the page did not name the way the protocol does', () => {
    const openGraph = openGraphFromNeynarEmbed(DEPLOY_URL, {
      frame: {
        image: 'https://fiddy.fun/client/assets/deploy-card.png',
        frames_url: DEPLOY_URL,
      },
    });
    expect(openGraph.frameEmbedNext?.frameEmbed?.button?.title).toBe(
      `Open ${DEPLOY_URL}`,
    );
  });

  it('draws no card for an app whose art is not a loadable https address', () => {
    const openGraph = openGraphFromNeynarEmbed(DEPLOY_URL, {
      html: { ogTitle: 'Deploy your own Farcaster node — Fiddy' },
      frame: {
        title: 'Deploy my node',
        image: 'http://fiddy.fun/client/assets/deploy-card.png',
        frames_url: DEPLOY_URL,
      },
    });
    expect(openGraph.frameEmbedNext).toBeUndefined();
    expect(openGraph.image).toBeUndefined();
    // The link is still the link — the title the page declared is not thrown away.
    expect(openGraph.title).toBe('Deploy your own Farcaster node — Fiddy');
  });

  it('keeps a plain link a plain link when the metadata says nothing', () => {
    const openGraph = openGraphFromNeynarEmbed('https://example.com/post', {
      _status: 'RESOLVED',
    });
    expect(openGraph).toEqual({
      url: 'https://example.com/post',
      domain: 'example.com',
    });
  });

  it('falls back to the embed’s own URL when the frame names no target', () => {
    const openGraph = openGraphFromNeynarEmbed(DEPLOY_URL, {
      frame: { title: 'Deploy my node', image: 'https://fiddy.fun/card.png' },
    });
    expect(openGraph.frameEmbedNext?.frameUrl).toBe(DEPLOY_URL);
    expect(openGraph.frameEmbedNext?.frameEmbed?.button?.action).toMatchObject({
      url: DEPLOY_URL,
    });
  });

  it('understands Neynar’s og:image spellings, and invent nothing else', () => {
    expect(
      openGraphFromNeynarEmbed(DEPLOY_URL, {
        html: { ogImage: 'https://fiddy.fun/one.png' },
      }).image,
    ).toBe('https://fiddy.fun/one.png');
    expect(
      openGraphFromNeynarEmbed(DEPLOY_URL, {
        html: { ogImage: { url: 'https://fiddy.fun/two.png' } },
      }).image,
    ).toBe('https://fiddy.fun/two.png');
    expect(
      openGraphFromNeynarEmbed(DEPLOY_URL, {
        html: { ogImage: [{ url: 7 }, { url: 'ftp://fiddy.fun/three.png' }] },
      }).image,
    ).toBeUndefined();
  });
});

describe('a Neynar cast with a mini app in it', () => {
  const cast = {
    hash: '0xacf6cf418b3d312cbbc9141d8540f265567e8428',
    thread_hash: '0xacf6cf418b3d312cbbc9141d8540f265567e8428',
    author: { fid: 191554, username: 'ivc', display_name: 'ivc' },
    text: 'Deploy via Miniapp: https://fiddy.fun/client/deploy',
    timestamp: '2026-10-19T10:00:00.000Z',
    embeds: [{ url: DEPLOY_URL, metadata: DEPLOY_METADATA }],
  };

  it('hands the renderer the card, not an empty link', () => {
    const mapped = apiCastFromNeynar(cast);
    const openGraph = mapped.embeds?.urls?.[0]?.openGraph;
    expect(openGraph?.title).toBe('Deploy your own Farcaster node — Fiddy');
    expect(openGraph?.frameEmbedNext?.frameEmbed?.imageUrl).toBe(
      'https://fiddy.fun/client/assets/deploy-card.png',
    );
    expect(openGraph?.frameEmbedNext?.frameEmbed?.button?.action?.type).toBe(
      'launch_miniapp',
    );
  });

  it('still sorts a bare link into `urls`, with no invented card', () => {
    const mapped = apiCastFromNeynar({
      ...cast,
      embeds: [{ url: 'https://example.com/post' }],
    });
    expect(mapped.embeds?.urls?.[0]?.openGraph).toEqual({
      url: 'https://example.com/post',
      domain: 'example.com',
    });
  });
});
