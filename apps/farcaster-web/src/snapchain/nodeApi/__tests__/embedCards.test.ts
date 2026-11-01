/**
 * Link and mini-app embeds, as tests.
 *
 * The rules this file pins are the ones a reader would notice if they broke: a
 * page's own title and picture reach the card; a page that declares a mini app
 * gets the card whose button launches it; a page that cannot be read leaves the
 * embed exactly as it was; and none of it holds a feed open behind somebody
 * else's server.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createEmbedCardResolver,
  embedCardFromHtml,
  metaTagsFromHtml,
  miniAppCardFromMetaTag,
  openGraphFromCard,
} from '~/snapchain/nodeApi/embedCards';

const MINIAPP_TAG = JSON.stringify({
  version: 'next',
  imageUrl: 'https://app.example/embed.png',
  button: {
    title: 'Play now',
    action: {
      type: 'launch_miniapp',
      name: 'Example',
      url: 'https://app.example/',
      splashImageUrl: 'https://app.example/splash.png',
      splashBackgroundColor: '#101010',
    },
  },
});

const page = (head: string): string =>
  `<!doctype html><html><head>${head}</head><body>hello</body></html>`;

const htmlResponse = (html: string): Response =>
  new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }) as Response & { url: string };

const withUrl = (response: Response, url: string): Response => {
  Object.defineProperty(response, 'url', { value: url });
  return response;
};

describe('the tags on a page', () => {
  it('reads a tag spelled with name or property, in either quote style', () => {
    const tags = metaTagsFromHtml(
      page(
        `<meta property="og:title" content="A page">` +
          `<meta name='og:description' content='Said in single quotes'>` +
          `<meta content="Reversed order" name="og:image">`,
      ),
    );

    expect(tags['og:title']).toBe('A page');
    expect(tags['og:description']).toBe('Said in single quotes');
    expect(tags['og:image']).toBe('Reversed order');
  });

  it('decodes the entities a content attribute carries', () => {
    const tags = metaTagsFromHtml(
      page(
        '<meta name="fc:miniapp" content="{&quot;version&quot;:&quot;next&quot;}">',
      ),
    );

    expect(tags['fc:miniapp']).toBe('{"version":"next"}');
  });

  it('takes the last tag when a page states one twice', () => {
    const tags = metaTagsFromHtml(
      page(
        '<meta name="og:title" content="first">' +
          '<meta name="og:title" content="second">',
      ),
    );

    expect(tags['og:title']).toBe('second');
  });

  it('ignores tags after the head, which is not where these live', () => {
    const tags = metaTagsFromHtml(
      '<html><head></head><body><meta name="og:title" content="late"></body></html>',
    );

    expect(tags['og:title']).toBeUndefined();
  });
});

describe('a page as a card', () => {
  it('carries the mini-app card a page declares, with its own button', () => {
    const card = embedCardFromHtml(
      page(
        `<meta name="og:title" content="Example">` +
          `<meta name="fc:miniapp" content='${MINIAPP_TAG}'>`,
      ),
      'https://app.example/',
    );

    expect(card?.miniApp).toEqual({
      imageUrl: 'https://app.example/embed.png',
      title: 'Play now',
      actionUrl: 'https://app.example/',
      splashImageUrl: 'https://app.example/splash.png',
      splashBackgroundColor: '#101010',
    });
  });

  it('reads the older fc:frame tag too', () => {
    const card = embedCardFromHtml(
      page(`<meta name="fc:frame" content='${MINIAPP_TAG}'>`),
      'https://app.example/',
    );

    expect(card?.miniApp?.actionUrl).toBe('https://app.example/');
  });

  it('says nothing about an app whose tag is not the protocol shape', () => {
    const notAnApp = JSON.stringify({
      version: 'next',
      imageUrl: 'https://app.example/embed.png',
      button: { title: 'Nope', action: { type: 'view_token', token: 'x' } },
    });
    const card = embedCardFromHtml(
      page(`<meta name="fc:miniapp" content='${notAnApp}'>`),
      'https://app.example/',
    );

    expect(card?.miniApp).toBeUndefined();
  });

  it('refuses a tag that is not JSON at all', () => {
    expect(
      miniAppCardFromMetaTag('{not json', 'https://app.example/'),
    ).toBeUndefined();
  });

  it('launches the page it is on when the action names no address', () => {
    const tag = JSON.stringify({
      version: 'next',
      imageUrl: 'https://app.example/embed.png',
      button: { title: 'Open', action: { type: 'launch_miniapp' } },
    });

    expect(
      miniAppCardFromMetaTag(tag, 'https://app.example/mini')?.actionUrl,
    ).toBe('https://app.example/mini');
  });

  it('carries a link’s own title, description and picture', () => {
    const card = embedCardFromHtml(
      page(
        '<meta name="og:title" content="A read">' +
          '<meta name="og:description" content="Of the page">' +
          '<meta name="og:image" content="https://cdn.example/cover.png">',
      ),
      'https://blog.example/post',
    );

    expect(card).toEqual({
      title: 'A read',
      description: 'Of the page',
      imageUrl: 'https://cdn.example/cover.png',
    });
  });

  it('leaves out a picture a page can never load', () => {
    const card = embedCardFromHtml(
      page(
        '<meta name="og:title" content="Insecure">' +
          '<meta name="og:image" content="http://cdn.example/cover.png">',
      ),
      'https://blog.example/post',
    );

    expect(card?.imageUrl).toBeUndefined();
    expect(card?.title).toBe('Insecure');
  });

  it('is no answer at all when the page said nothing', () => {
    expect(embedCardFromHtml(page(''), 'https://app.example/')).toBeUndefined();
    expect(embedCardFromHtml('', 'https://app.example/')).toBeUndefined();
  });
});

describe('a card as the fork’s open graph', () => {
  it('becomes the mini-app embed the feed already renders and launches', () => {
    const openGraph = openGraphFromCard('https://app.example/', {
      title: 'Example',
      miniApp: {
        imageUrl: 'https://app.example/embed.png',
        title: 'Play now',
        actionUrl: 'https://app.example/',
      },
    });

    expect(openGraph.url).toBe('https://app.example/');
    expect(openGraph.title).toBe('Example');
    expect(openGraph.frameEmbedNext?.frameUrl).toBe('https://app.example/');
    expect(openGraph.frameEmbedNext?.frameEmbed?.imageUrl).toBe(
      'https://app.example/embed.png',
    );
    expect(openGraph.frameEmbedNext?.frameEmbed?.button).toEqual({
      title: 'Play now',
      action: {
        type: 'launch_miniapp',
        name: 'Example',
        url: 'https://app.example/',
      },
    });
  });

  it('is the bare URL when nothing could be read — never a blank card', () => {
    expect(openGraphFromCard('https://app.example/', undefined)).toEqual({
      url: 'https://app.example/',
    });
  });
});

describe('reading a page once, per embed', () => {
  it('answers from the page’s own tags after one read', async () => {
    const fetchImpl = vi.fn(async () =>
      withUrl(
        htmlResponse(
          page(
            `<meta name="og:title" content="Example">` +
              `<meta name="fc:miniapp" content='${MINIAPP_TAG}'>`,
          ),
        ),
        'https://app.example/',
      ),
    );
    const resolver = createEmbedCardResolver({ fetchImpl, storage: null });

    await resolver.resolve(['https://app.example/']);

    expect(resolver.cardOf('https://app.example/')?.miniApp?.title).toBe(
      'Play now',
    );
    await resolver.resolve(['https://app.example/']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never asks the index about a page that declared its own app', async () => {
    const indexLookup = vi.fn(async () => ({
      imageUrl: 'https://index.example/art.png',
      title: 'Open Indexed',
      actionUrl: 'https://index.example/',
    }));
    const resolver = createEmbedCardResolver({
      fetchImpl: async () =>
        withUrl(
          htmlResponse(
            page(`<meta name="fc:miniapp" content='${MINIAPP_TAG}'>`),
          ),
          'https://app.example/',
        ),
      indexLookup,
      storage: null,
    });

    await resolver.resolve(['https://app.example/']);

    expect(indexLookup).not.toHaveBeenCalled();
    expect(resolver.cardOf('https://app.example/')?.miniApp?.imageUrl).toBe(
      'https://app.example/embed.png',
    );
  });

  it('asks the index when the page cannot be read at all', async () => {
    const resolver = createEmbedCardResolver({
      fetchImpl: async () => {
        // What a browser gets for a page that grants no CORS permission.
        throw new TypeError('Failed to fetch');
      },
      indexLookup: async (url) => ({
        imageUrl: 'https://index.example/art.png',
        title: 'Open Indexed',
        actionUrl: url,
      }),
      storage: null,
    });

    await resolver.resolve(['https://app.example/']);

    expect(resolver.cardOf('https://app.example/')?.miniApp).toEqual({
      imageUrl: 'https://index.example/art.png',
      title: 'Open Indexed',
      actionUrl: 'https://app.example/',
    });
  });

  it('is no answer when neither the page nor the index knows it', async () => {
    const resolver = createEmbedCardResolver({
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
      indexLookup: async () => null,
      storage: null,
    });

    await resolver.resolve(['https://unknown.example/page']);

    expect(resolver.cardOf('https://unknown.example/page')).toBeUndefined();
  });

  it('does not read a page that answered with something that is not HTML', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"not":"a page"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const resolver = createEmbedCardResolver({ fetchImpl, storage: null });

    await resolver.resolve(['https://api.example/thing.json']);

    expect(resolver.cardOf('https://api.example/thing.json')).toBeUndefined();
  });

  it('does not hold a page open behind a host that never answers', async () => {
    const resolver = createEmbedCardResolver({
      fetchImpl: () => new Promise<Response>(() => undefined),
      timeoutMs: 5_000,
      waitMs: 60,
      storage: null,
    });
    const started = Date.now();

    await resolver.resolve(['https://slow.example/page'], { waitMs: 60 });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(resolver.cardOf('https://slow.example/page')).toBeUndefined();
  });

  it('reads a page anonymously, and never says which cast asked', async () => {
    // The in-browser read is the privacy surface the policy names
    // (`docs/CLIENT-MINIAPP-FEED.md` §4). What keeps it minimal is the request
    // itself, so this holds the request: no credentials, and no referrer — a
    // referrer would hand the page's host which cast the reader was looking at.
    const fetchImpl = vi.fn(async () =>
      htmlResponse(page('<title>Just a link</title>')),
    );
    const resolver = createEmbedCardResolver({ fetchImpl, storage: null });

    await resolver.resolve(['https://link.example/page']);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = (
      fetchImpl.mock.calls as unknown as [unknown, RequestInit?][]
    )[0]!;
    expect(init?.credentials).toBe('omit');
    expect(init?.referrerPolicy).toBe('no-referrer');
  });

  it('remembers a card for the next session, like the media kinds do', async () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const first = createEmbedCardResolver({
      fetchImpl: async () =>
        withUrl(
          htmlResponse(page('<meta name="og:title" content="Kept">')),
          'https://blog.example/',
        ),
      storage,
    });

    await first.resolve(['https://blog.example/']);
    await first.settle();

    const reader = createEmbedCardResolver({
      fetchImpl: async () => {
        throw new Error('the second session must not read the page again');
      },
      storage,
    });

    expect(reader.cardOf('https://blog.example/')).toEqual({ title: 'Kept' });
  });
});
