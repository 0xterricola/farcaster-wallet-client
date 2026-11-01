/**
 * The per-page unfurl service, held to its contract without a socket.
 *
 * A shared fiddy.fun link to a CAST or a PROFILE now answers with that page's
 * own `og:` tags over the shell this repo builds, plus a 1200x630 card drawn
 * for it — the work t_1e01f488 left carded because a crawler never runs the
 * bundle and the host serves one static document for every route.
 *
 * These tests hold the four things that can actually go wrong:
 *
 *   1. the document — the page's tags replace the site's rather than piling on
 *      top of them, values are escaped, and the REST of the shell comes back
 *      byte-for-byte (the theme bootstrap, the skeleton, the entry chunk: the
 *      shell is the app's first paint);
 *   2. the bundle guard — nothing injected is inline script, because the host
 *      serves `script-src 'self'`;
 *   3. the failures — an unreadable cast, a source that throws, a card that
 *      cannot be drawn: each answers with the shell or the site card, never
 *      with an invented fact and never with a 500 in a crawler's face;
 *   4. the picture — a real PNG at exactly 1200x630, and two casts do not draw
 *      the same card.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createCardRenderer, pngSize } from '../../server/unfurl/cards.mjs';
import { createUnfurlHandler } from '../../server/unfurl/handler.mjs';
import { createLinkReader } from '../../server/unfurl/reader.mjs';
import {
  escapeHtml,
  oneLine,
  renderPageHtml,
} from '../../server/unfurl/shellMeta.mjs';

const webRoot = path.resolve(__dirname, '../..');
const shell = readFileSync(path.join(webRoot, 'index.html'), 'utf8');

/**
 * Pillow — the card renderer's one real dependency — or an honest skip: without
 * it no card can be drawn on this machine, and this file must not claim one
 * was. The answer is decided once, here, so the skip shows up as a named test.
 */
const PYTHON = process.env.PYTHON ?? 'python3';
const pillowReady = (() => {
  try {
    execFileSync(PYTHON, ['-c', 'import PIL.Image'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const ORIGIN = 'https://fiddy.fun';

const siteCard = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A reader that answers from a fixture, so no test needs a network. */
const fakeReader = (
  facts: {
    cast?: (hash: string) => unknown;
    profile?: (fid: string) => unknown;
  } = {},
) => ({
  cast: async (hash: string) => facts.cast?.(hash),
  profile: async (fid: string) => facts.profile?.(fid),
  size: () => 0,
});

const handler = (overrides: Record<string, unknown> = {}) =>
  createUnfurlHandler({
    origin: ORIGIN,
    shellSource: () => shell,
    siteCard,
    renderCard: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
    reader: fakeReader(),
    ...overrides,
  } as never);

const read = async (url: string, overrides: Record<string, unknown> = {}) =>
  (await handler(overrides).handle({ method: 'GET', path: url })) as {
    status: number;
    headers: Record<string, string>;
    body: string | Buffer;
  };

const metaContent = (
  html: string,
  attribute: 'property' | 'name',
  key: string,
) => {
  const tag = new RegExp(
    `<meta\\s+${attribute}="${key}"\\s+content=(?:"([^"]*)"|'([^']*)')`,
  ).exec(html);
  return tag?.[1] ?? tag?.[2];
};

const allMeta = (html: string, attribute: 'property' | 'name', key: string) =>
  html.match(new RegExp(`<meta\\s+${attribute}="${key}"[^>]*>`, 'g')) ?? [];

const DW_R = {
  cast: {
    hash: '0xec0c8a227d7f34ad3e2243ae098b46459b7d1847',
    fid: 3,
    text: 'Neat',
  },
  author: { fid: 3, username: 'dwr', displayName: 'Dan Romero' },
};

describe('what a cast page tells a crawler', () => {
  const reader = fakeReader({ cast: () => DW_R });

  it("declares that page's own tags, and drops the site's", async () => {
    const { status, body, headers } = await read(
      `/~/conversations/${DW_R.cast.hash}`,
      { reader },
    );
    const html = body as string;

    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/html; charset=utf-8');
    expect(headers['x-unfurl']).toBe('page:cast');
    expect(headers['cache-control']).toBe('public, max-age=300, no-transform');

    // The page's own words, and its own URL — the shell deliberately carries no
    // static og:url, and this is the page that can carry a real one.
    expect(metaContent(html, 'property', 'og:title')).toBe('@dwr: Neat');
    expect(metaContent(html, 'property', 'og:url')).toBe(
      `${ORIGIN}/~/conversations/${DW_R.cast.hash}`,
    );
    expect(metaContent(html, 'property', 'og:type')).toBe('article');
    expect(metaContent(html, 'property', 'og:description')).toBe(
      'Dan Romero on Farcaster.',
    );
    expect(metaContent(html, 'property', 'og:image')).toBe(
      `${ORIGIN}/unfurl/cards/cast/${DW_R.cast.hash}.png`,
    );
    expect(metaContent(html, 'property', 'og:image:width')).toBe('1200');
    expect(metaContent(html, 'property', 'og:image:height')).toBe('630');
    expect(metaContent(html, 'name', 'twitter:card')).toBe(
      'summary_large_image',
    );
    expect(metaContent(html, 'name', 'twitter:image')).toBe(
      metaContent(html, 'property', 'og:image'),
    );
    expect(html).toContain(`<title>@dwr: Neat</title>`);

    // Exactly one of each: two og:title tags means an unfurler picks one at
    // random, which is how the shell's own front-door title used to leak into
    // every shared cast link.
    for (const key of ['og:title', 'og:description', 'og:image', 'og:url']) {
      expect(allMeta(html, 'property', key)).toHaveLength(1);
    }
    expect(allMeta(html, 'name', 'twitter:title')).toHaveLength(1);
    // The site's own front-door title is gone with the tags that carried it.
    expect(html).not.toContain('fiddy — a Farcaster client with an agent');
  });

  it('is still the app: everything but the head comes back untouched', async () => {
    const { body } = await read(`/~/conversations/${DW_R.cast.hash}`, {
      reader,
    });
    const html = body as string;

    // Byte-for-byte from </head> on, and the same document head up to <head>:
    // the injected tags live in one block between them.
    const shellTail = shell.slice(shell.indexOf('</head>'));
    expect(html.slice(html.indexOf('</head>'))).toBe(shellTail);
    expect(html.slice(0, html.indexOf('<head>'))).toBe(
      shell.slice(0, shell.indexOf('<head>')),
    );

    // The three things a reader's first paint depends on.
    expect(html).toContain('<script src="/shell-bootstrap.js"></script>');
    expect(html).toContain('id="shell-skeleton"');
    // The entry chunk the shell names, whatever this tree's shell calls it (the
    // source shell names /src/index.jsx, a built one names /assets/index-*.js).
    const entry = /<script type="module"[^>]*src="[^"]+"[^>]*><\/script>/.exec(
      shell,
    );
    expect(entry).toBeTruthy();
    expect(html).toContain(entry?.[0] as string);
    // and the mini-app embed is the same one the front door declares, aimed at
    // this page.
    const embed = JSON.parse(metaContent(html, 'name', 'fc:miniapp') as string);
    expect(embed.button.action.url).toBe(
      `${ORIGIN}/~/conversations/${DW_R.cast.hash}`,
    );
    expect(embed.button.action.name).toBe('fiddy');
    expect(embed.button.action.splashBackgroundColor).toBe('#161715');
    expect(embed.imageUrl).toBe(
      `${ORIGIN}/unfurl/cards/cast/${DW_R.cast.hash}.3x2.png`,
    );
    expect(embed.button.title).toBe('Open this cast in fiddy');
    // The social preview stays the existing 1200x630 card.
    expect(metaContent(html, 'property', 'og:image')).toBe(
      `${ORIGIN}/unfurl/cards/cast/${DW_R.cast.hash}.png`,
    );
    expect(metaContent(html, 'property', 'og:image:height')).toBe('630');
  });

  it('injects no inline script and no event handler (script-src is self)', async () => {
    const { body } = await read(`/~/conversations/${DW_R.cast.hash}`, {
      reader,
    });
    // The same method as the ritual's own check
    // (`scripts/check-shell-has-no-inline-script.mjs`): comments out first,
    // because the shell explains the `onload=` it used to carry in one.
    const html = (body as string).replace(/<!--[\s\S]*?-->/g, '');

    const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
    expect(
      scripts.filter((tag) => !/\bsrc\s*=/i.test(tag[1])).map((tag) => tag[0]),
    ).toEqual([]);
    expect(
      [...html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\son([a-z]+)\s*=/gi)].map(
        (m) => m[0],
      ),
    ).toEqual([]);
    // Our block adds no script of its own: the tags are `<meta>` and `<title>`.
    expect(scripts.length).toBe(
      (shell.replace(/<!--[\s\S]*?-->/g, '').match(/<script\b[^>]*>/gi) ?? [])
        .length,
    );
  });

  it('cannot be broken out of by the text it quotes', async () => {
    const hostile = {
      cast: {
        hash: '0x' + 'a'.repeat(40),
        fid: 9,
        text: '"><script>alert(1)</script> and "quotes"',
      },
      author: { fid: 9, username: 'x"><img src=x>', displayName: 'a "b" <c>' },
    };
    const { body } = await read(`/~/conversations/${hostile.cast.hash}`, {
      reader: fakeReader({ cast: () => hostile }),
    });
    const html = body as string;

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x>');
    expect(metaContent(html, 'property', 'og:title')).toContain('&quot;');
    // The values survive as text, escaped once and not twice.
    expect(metaContent(html, 'property', 'og:title')).toContain(
      '&lt;script&gt;',
    );
  });
});

describe('what a profile page tells a crawler', () => {
  const profile = {
    author: {
      fid: 3,
      username: 'dwr',
      displayName: 'Dan Romero',
      bio: 'Interested in technology and other stuff.',
    },
  };

  it('declares the profile and its own card', async () => {
    const { body, headers } = await read('/~/profiles/3', {
      reader: fakeReader({ profile: () => profile }),
    });
    const html = body as string;

    expect(headers['x-unfurl']).toBe('page:profile');
    expect(headers['cache-control']).toBe('public, max-age=300, no-transform');
    expect(metaContent(html, 'property', 'og:title')).toBe('Dan Romero (@dwr)');
    expect(metaContent(html, 'property', 'og:description')).toBe(
      'Interested in technology and other stuff.',
    );
    expect(metaContent(html, 'property', 'og:image')).toBe(
      `${ORIGIN}/unfurl/cards/profile/3.png`,
    );
    expect(metaContent(html, 'property', 'og:url')).toBe(
      `${ORIGIN}/~/profiles/3`,
    );
    expect(metaContent(html, 'property', 'og:type')).toBe('profile');
    const embed = JSON.parse(metaContent(html, 'name', 'fc:miniapp') as string);
    expect(embed.imageUrl).toBe(`${ORIGIN}/unfurl/cards/profile/3.3x2.png`);
    expect(embed.button.title).toBe('Open this profile in fiddy');
    expect(embed.button.action.url).toBe(`${ORIGIN}/~/profiles/3`);
  });
});

describe('the pages this service cannot read', () => {
  it('answers with the shell, unchanged, rather than an error', async () => {
    const { status, body, headers } = await read(
      '/~/conversations/0x' + 'b'.repeat(40),
      { reader: fakeReader({}) },
    );
    expect(status).toBe(200);
    expect(headers['x-unfurl']).toBe('shell');
    expect(body).toBe(shell);
    // The site tags are still the site's: this URL unfurls as the front door,
    // exactly as it did before this service existed.
    expect(metaContent(body as string, 'property', 'og:image')).toBe(
      `${ORIGIN}/fiddy-share-card.png`,
    );
  });

  it('answers with the shell when a source throws, not with a 500', async () => {
    const reader = {
      cast: async () => {
        throw new Error('the node is not answering');
      },
      profile: async () => {
        throw new Error('the node is not answering');
      },
      size: () => 0,
    };
    for (const url of [
      `/~/conversations/0x${'c'.repeat(40)}`,
      '/~/profiles/3',
    ]) {
      const { status, body } = await read(url, { reader });
      expect(status).toBe(200);
      expect(body).toBe(shell);
    }
  });

  it('answers a path it does not own with a 404, and a POST with a 405', async () => {
    expect((await read('/index.html')).status).toBe(404);
    expect((await read('/robots.txt')).status).toBe(404);
    // The route FAMILIES without an id are not pages the service has facts for,
    // but they are still the app's own prefix — the answer is the shell, which
    // is what the host served for them before this service existed.
    for (const url of ['/~/conversations', '/~/profiles', '/~/']) {
      const { status, body, headers } = await read(url);
      expect(status).toBe(200);
      expect(headers['x-unfurl']).toBe('shell');
      expect(body).toBe(shell);
    }
    const posted = (await handler().handle({ method: 'POST', path: '/' })) as {
      status: number;
    };
    expect(posted.status).toBe(405);
  });

  it('still serves the app for the routes under the prefix it does not tag', async () => {
    // nginx sends the whole `/~/conversations|profiles/` family here, and the
    // client owns the rest of it: a reaction list, a follower list, a profile
    // tab. Those are pages, not 404s.
    for (const url of [
      `/~/conversations/${'0x' + 'a'.repeat(40)}/reactions`,
      '/~/profiles/3/followers',
      '/~/settings',
    ]) {
      const { status, body, headers } = await read(url);
      expect(status).toBe(200);
      expect(headers['x-unfurl']).toBe('shell');
      expect(body).toBe(shell);
    }
  });
});

describe('HTML is delivered exactly as built', () => {
  it('marks page and shell responses no-transform, never JSON or images', async () => {
    for (const url of ['/~/settings', '/~/profiles/3']) {
      const answer = await read(url);
      expect(answer.headers['content-type']).toContain('text/html');
      expect(answer.headers['cache-control']).toBe(
        'public, max-age=300, no-transform',
      );
    }
    const json = await read(`/unfurl/cast-author/${DW_R.cast.hash}`, {
      reader: fakeReader({ cast: () => DW_R }),
    });
    expect(json.headers['cache-control']).toBe('no-store');
    const image = await read('/unfurl/cards/profile/3.png', {
      reader: fakeReader({ profile: () => ({ author: { fid: 3 } }) }),
    });
    expect(image.headers['cache-control']).toBe('public, max-age=3600');
  });
});

describe('the cast-hash index the client asks for', () => {
  it('answers the FID that wrote a cast', async () => {
    const { status, body, headers } = await read(
      `/unfurl/cast-author/${DW_R.cast.hash}`,
      {
        reader: fakeReader({ cast: () => DW_R }),
      },
    );
    expect(status).toBe(200);
    expect(headers['cache-control']).toBe('no-store');
    expect(JSON.parse(body as string)).toEqual({
      hash: DW_R.cast.hash,
      fid: 3,
    });
  });

  it('says so when it cannot answer, rather than guessing a FID', async () => {
    const { status, body, headers } = await read(
      `/unfurl/cast-author/0x${'d'.repeat(40)}`,
      {
        reader: fakeReader({}),
      },
    );
    expect(status).toBe(404);
    expect(headers['x-unfurl']).toBe('author:miss');
    expect(JSON.parse(body as string).fid).toBeNull();
  });
});

describe('the payload the card renderer is handed', () => {
  // A PROMISE here is what shipped the site card for every page on the first
  // release: `handler.card()` was passed a `.then(…)` chain, the renderer reads
  // its payload synchronously, and `JSON.stringify(promise)` is `{}` — so the
  // renderer answered "unknown card kind: None" and every card fell back to the
  // site card while the gate (1200x630) still passed. These pin the argument.
  const drawn = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000004b000000276',
    'hex',
  );

  it('is this page’s own cast card, resolved', async () => {
    const seen: unknown[] = [];
    const { headers } = await read(`/unfurl/cards/cast/${DW_R.cast.hash}.png`, {
      reader: fakeReader({ cast: () => DW_R }),
      renderCard: async (payload: unknown) => {
        seen.push(payload);
        return drawn;
      },
    });
    expect(headers['x-unfurl']).toBe('card:cast');
    const card = seen[0] as {
      kind?: string;
      hash?: string;
      text?: string;
      fid?: number;
      username?: string;
    };
    expect(card).not.toBeInstanceOf(Promise);
    expect(card.kind).toBe('cast');
    expect(card.hash).toBe(DW_R.cast.hash);
    expect(card.text).toBe('Neat');
    expect(card.fid).toBe(3);
    expect(card.username).toBe('dwr');
  });

  it('is this page’s own profile card, resolved', async () => {
    const seen: unknown[] = [];
    const { headers } = await read('/unfurl/cards/profile/3.png', {
      reader: fakeReader({
        profile: () => ({
          author: { fid: 3, username: 'dwr', displayName: 'Dan Romero' },
        }),
      }),
      renderCard: async (payload: unknown) => {
        seen.push(payload);
        return drawn;
      },
    });
    expect(headers['x-unfurl']).toBe('card:profile');
    const card = seen[0] as {
      kind?: string;
      fid?: string;
      displayName?: string;
    };
    expect(card).not.toBeInstanceOf(Promise);
    expect(card.kind).toBe('profile');
    expect(card.fid).toBe('3');
    expect(card.displayName).toBe('Dan Romero');
  });

  it('draws a separate 1200x800 payload for the mini-app card', async () => {
    const seen: Record<string, unknown>[] = [];
    const tall = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000004b000000320',
      'hex',
    );
    const answer = await read(`/unfurl/cards/cast/${DW_R.cast.hash}.3x2.png`, {
      reader: fakeReader({ cast: () => DW_R }),
      renderCard: async (payload: Record<string, unknown>) => {
        seen.push(payload);
        return tall;
      },
    });
    expect(answer.headers['x-unfurl']).toBe('card:cast');
    expect(answer.body).toEqual(tall);
    expect(seen[0]).toMatchObject({ kind: 'cast', aspect: '3x2' });
  });

  it('does not let the two card sizes evict each other', async () => {
    const seen: Record<string, unknown>[] = [];
    const h = handler({
      reader: fakeReader({ cast: () => DW_R }),
      renderCard: async (payload: Record<string, unknown>) => {
        seen.push(payload);
        return payload.aspect === '3x2'
          ? Buffer.from('mini-app')
          : Buffer.from('social');
      },
    });
    const ask = async (suffix: string) =>
      (await h.handle({
        method: 'GET',
        path: `/unfurl/cards/cast/${DW_R.cast.hash}${suffix}`,
      })) as { body: Buffer };
    expect((await ask('.png')).body.toString()).toBe('social');
    expect((await ask('.3x2.png')).body.toString()).toBe('mini-app');
    expect((await ask('.png')).body.toString()).toBe('social');
    expect(seen).toHaveLength(2);
  });
});

describe('a card that cannot be drawn', () => {
  it('falls back to the site card, which is the picture this URL had yesterday', async () => {
    const { status, body, headers } = await read(
      `/unfurl/cards/cast/${DW_R.cast.hash}.png`,
      {
        reader: fakeReader({ cast: () => DW_R }),
        renderCard: async () => {
          throw new Error('pillow is not installed');
        },
      },
    );
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('image/png');
    expect(headers['x-unfurl']).toBe('card:site');
    expect(body).toEqual(siteCard);
    // The site card is a real picture, but it is not this page's, and the answer
    // no longer pretends otherwise: the reason rides with it.
    expect(headers['x-unfurl-note']).toContain('pillow is not installed');
    expect(headers['x-unfurl-note']).toContain('2 attempts');
  });

  it('answers 503 when there is no site card to fall back to', async () => {
    const { status, headers } = await read(
      `/unfurl/cards/cast/${DW_R.cast.hash}.png`,
      {
        reader: fakeReader({ cast: () => DW_R }),
        siteCard: undefined,
        renderCard: async () => {
          throw new Error('pillow is not installed');
        },
      },
    );
    expect(status).toBe(503);
    expect(headers['x-unfurl']).toBe('card:unavailable');
  });

  it('serves the bytes the renderer drew, as image/png', async () => {
    const drawn = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000004b0000000276',
      'hex',
    );
    const { status, body, headers } = await read(
      `/unfurl/cards/profile/3.png`,
      {
        reader: fakeReader({
          profile: () => ({ author: { fid: 3, username: 'dwr' } }),
        }),
        renderCard: async () => drawn,
      },
    );
    expect(status).toBe(200);
    expect(headers['x-unfurl']).toBe('card:profile');
    expect(body).toEqual(drawn);
  });
});

describe('the reason a card fell back, and the one retry before it does', () => {
  // MEASURED 2026-10-23 (card t_7413507e): release-client.sh step 3 refused a
  // release twice, on the CARDS alone, with no cause named — `handler.card()`
  // kept the renderer's error in a cache note that nothing printed, so a starved
  // renderer and a broken card looked identical and the release had to be re-cut
  // blind (the same command by hand passed minutes later). Two rules came out of
  // it and both are pinned here: a card the renderer fails ONCE is drawn on the
  // second attempt, and a card that really cannot be drawn carries its reason on
  // the answer (`x-unfurl-note`), in the health JSON, and so in the gate's own
  // output.
  const drawn = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000004b000000276',
    'hex',
  );
  const castUrl = `/unfurl/cards/cast/${DW_R.cast.hash}.png`;
  const withReader = { reader: fakeReader({ cast: () => DW_R }) };

  /** One handler, asked several times: the caches are part of what is under test. */
  const ask = async (h: unknown, url: string) =>
    (await (
      h as {
        handle: (r: { method: string; path: string }) => Promise<unknown>;
      }
    ).handle({ method: 'GET', path: url })) as {
      status: number;
      headers: Record<string, string>;
      body: string | Buffer;
    };

  it('draws again, instead of falling back, when the renderer fails once', async () => {
    let calls = 0;
    const { status, headers, body } = await read(castUrl, {
      ...withReader,
      renderCard: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('the card renderer did not finish within 20000ms');
        }
        return drawn;
      },
    });
    expect(calls).toBe(2);
    expect(status).toBe(200);
    expect(headers['x-unfurl']).toBe('card:cast');
    expect(headers['x-unfurl-note']).toBeUndefined();
    expect(body).toEqual(drawn);
  });

  it('names the renderer, both attempts included, when it fails twice', async () => {
    let calls = 0;
    const { status, headers } = await read(castUrl, {
      ...withReader,
      renderCard: async () => {
        calls += 1;
        throw new Error(
          `render-card.py exited 3: no Pillow here (attempt ${calls})`,
        );
      },
    });
    expect(calls).toBe(2);
    expect(status).toBe(200);
    expect(headers['x-unfurl']).toBe('card:site');
    expect(headers['x-unfurl-note']).toContain(
      'the renderer did not draw it in 2 attempts',
    );
    for (const attempt of ['attempt 1', 'attempt 2']) {
      expect(headers['x-unfurl-note']).toContain(attempt);
    }
  });

  it("names the page, not the renderer, when this page's facts cannot be read", async () => {
    const { headers } = await read(castUrl, {
      reader: fakeReader(),
      renderCard: async () => drawn,
    });
    expect(headers['x-unfurl']).toBe('card:site');
    expect(headers['x-unfurl-note']).toContain(
      "this page's own facts could not be read",
    );
    expect(headers['x-unfurl-note']).not.toContain('renderer did not draw');
  });

  it('keeps the reason inside what a response header can carry', async () => {
    const { headers } = await read(castUrl, {
      ...withReader,
      renderCard: async () => {
        throw new Error(`boom\r\nx-injected: yes\u0007 ${'long '.repeat(200)}`);
      },
    });
    const cause = headers['x-unfurl-note'];
    expect(cause).not.toMatch(/[\r\n]/);
    expect(cause).not.toContain('\u0007');
    expect(cause.length).toBeLessThanOrEqual(300);
  });

  it('carries the reason on the 503 too, when there is no site card', async () => {
    const { status, headers } = await read(castUrl, {
      ...withReader,
      siteCard: undefined,
      renderCard: async () => {
        throw new Error('pillow is not installed');
      },
    });
    expect(status).toBe(503);
    expect(headers['x-unfurl']).toBe('card:unavailable');
    expect(headers['x-unfurl-note']).toContain('pillow is not installed');
  });

  it('keeps the reason where /unfurl/health can be asked for it', async () => {
    const failing = {
      ...withReader,
      renderCard: async () => {
        throw new Error('the card renderer did not finish within 20000ms');
      },
    };
    const h = handler(failing);
    await ask(h, castUrl);
    const { body } = await ask(h, '/unfurl/health');
    const health = JSON.parse(String(body)) as {
      cardFallbacks: number;
      lastCardFallback: { key: string; note: string; at: string } | null;
    };
    expect(health.cardFallbacks).toBe(1);
    expect(health.lastCardFallback?.key).toBe(`cast:${DW_R.cast.hash}`);
    expect(health.lastCardFallback?.note).toContain('2 attempts');
    expect(h.sizes().cardFallbacks).toBe(1);
  });

  it('does not hold a fallback for the hour a drawn card is cached for', async () => {
    let clock = 1_000_000;
    let calls = 0;
    const h = handler({
      ...withReader,
      now: () => clock,
      renderCard: async () => {
        calls += 1;
        if (calls <= 2) {
          throw new Error('starved');
        }
        return drawn;
      },
    });
    expect((await ask(h, castUrl)).headers['x-unfurl']).toBe('card:site');
    expect(calls).toBe(2);
    // Inside the miss window the same answer is reused: no third spawn.
    expect((await ask(h, castUrl)).headers['x-unfurl']).toBe('card:site');
    expect(calls).toBe(2);
    // Past it the card is drawn again — a failure is never cached for the hour.
    clock += 31_000;
    const later = await ask(h, castUrl);
    expect(later.headers['x-unfurl']).toBe('card:cast');
    expect(calls).toBe(3);
  });
});

describe('the card renderer, against the real thing', () => {
  const render = createCardRenderer({
    pythonPath: PYTHON,
    scriptPath: path.join(webRoot, 'server', 'unfurl', 'render-card.py'),
    mascotPath: path.join(webRoot, 'public', 'fiddy-mark-poster.png'),
  }).render;

  // Six cards, six python3 processes, and a Pillow check: this one is a
  // subprocess test, not a unit test, and it gets its own budget. Without
  // Pillow no card can be drawn at all, so the test is skipped BY NAME rather
  // than passing quietly — a green run must never mean "did not run".
  it.skipIf(!pillowReady)(
    'draws both sizes for a cast, a profile and a look, with distinct art and the brand palette',
    async () => {
      const payloads = [
        {
          kind: 'cast',
          hash: '0xec0c8a227d7f34ad3e2243ae098b46459b7d1847',
          text: 'Neat',
          username: 'dwr',
          displayName: 'Dan Romero',
          fid: 3,
        },
        {
          kind: 'profile',
          fid: 3,
          username: 'dwr',
          displayName: 'Dan Romero',
          bio: 'Interested in technology and other stuff.',
        },
        {
          kind: 'look',
          id: '0123456789',
          name: 'Fiddy dark',
          palette: {
            bg: '#161715',
            card: '#1d1e1c',
            ink: '#eef0e8',
            muted: '#9ba193',
            accent: '#d4ff3f',
          },
        },
      ];
      const cards: Record<string, string> = {};
      for (const payload of payloads) {
        for (const aspect of ['og', '3x2'] as const) {
          const png = await render(
            aspect === '3x2' ? { ...payload, aspect } : payload,
          );
          cards[`${payload.kind}:${aspect}`] = png.toString('base64');
          expect(pngSize(png)).toEqual({
            width: 1200,
            height: aspect === '3x2' ? 800 : 630,
          });
          const colours = JSON.parse(
            execFileSync(
              PYTHON,
              [
                '-c',
                "import json,sys; from PIL import Image; import io; im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGB'); colours={c for _,c in im.getcolors(2000000)}; print(json.dumps({'bg':im.getpixel((0,0)),'accent':(212,255,63) in colours}))",
              ],
              { input: png, encoding: 'utf8' },
            ),
          ) as { bg: number[]; accent: boolean };
          expect(colours.bg).toEqual([22, 23, 21]);
          expect(colours.accent).toBe(true);
        }
        expect(cards[`${payload.kind}:og`]).not.toBe(
          cards[`${payload.kind}:3x2`],
        );
      }
      expect(cards['cast:3x2']).not.toBe(cards['profile:3x2']);
      expect(cards['cast:3x2']).not.toBe(cards['look:3x2']);
      expect(cards['profile:3x2']).not.toBe(cards['look:3x2']);
    },
    60_000,
  );

  it('refuses a card that is not 1200x630', async () => {
    const render = createCardRenderer({
      pythonPath: PYTHON,
      scriptPath: path.join(webRoot, 'server', 'unfurl', 'cards.mjs'),
      mascotPath: path.join(webRoot, 'public', 'fiddy-mark-poster.png'),
    }).render;
    await expect(render({ kind: 'cast', text: 'x' })).rejects.toThrow();
  });
});

describe('the reader, against the node’s own envelope', () => {
  // MEASURED on the live node (2026-10-22): `/v1/castById` answers the MESSAGE
  // — `{"data":{"type":"MESSAGE_TYPE_CAST_ADD","castAddBody":{"text":…}}}` —
  // and `castTextFromMessage` used to look for `castAddBody` one level up. Every
  // cast page then read "no text" and answered the shell, which is the state the
  // first release of this service went live in. The fake answers the envelope
  // the node actually sends, not the shape a test would like.
  const envelope = (url: string): unknown => {
    if (url.includes('/v1/castById')) {
      return {
        data: {
          type: 'MESSAGE_TYPE_CAST_ADD',
          fid: 3,
          castAddBody: { text: 'Neat', mentions: [], embeds: [] },
        },
        hash: DW_R.cast.hash,
      };
    }
    if (url.includes('/v1/userDataByFid')) {
      return {
        messages: [
          {
            data: {
              userDataBody: {
                type: 'USER_DATA_TYPE_USERNAME',
                value: 'dwr',
              },
            },
          },
        ],
      };
    }
    if (url.includes('api.neynar.com')) {
      return { cast: { author: { fid: 3 } } };
    }
    throw new Error(`unexpected request: ${url}`);
  };

  const reader = () =>
    createLinkReader({
      fetchImpl: (async (url: string) =>
        new Response(JSON.stringify(envelope(url)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      nodeBaseUrl: 'https://node.test',
      neynarApiKey: 'test-key',
    });

  it('reads a cast out of the node’s message envelope', async () => {
    const facts = await reader().cast(DW_R.cast.hash);
    expect(facts?.cast.text).toBe('Neat');
    expect(facts?.cast.fid).toBe(3);
    expect(facts?.author.username).toBe('dwr');
  });
});

describe('the copy a card carries', () => {
  it('clips a long line on a word boundary, with one ellipsis', () => {
    expect(oneLine('a  b\n\nc', 40)).toBe('a b c');
    expect(oneLine('word '.repeat(30), 40).endsWith('…')).toBe(true);
    expect(oneLine('word '.repeat(30), 40).length).toBeLessThanOrEqual(41);
  });

  it('escapes everything that could close an attribute', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });

  it('refuses a shell with no head instead of serving it as a page', () => {
    expect(() =>
      renderPageHtml('<html><body>nothing</body></html>', 'x'),
    ).toThrow(/no <\/head>/);
  });
});

describe('the release self-check, measured the way the ritual runs it', () => {
  // The gate is only as good as its refusal. MEASURED 2026-10-23 (card
  // t_7413507e): step 3 refused a release twice, printed `card:site` for both
  // pages and nothing else, while the build itself was fine — the same command
  // by hand passed minutes later. These run the file the ritual runs, out of
  // this checkout, and hold it to the two halves of the fix: a refusal NAMES the
  // cause, and it says what to do next.
  const shell = path.join(webRoot, 'index.html');
  const selfCheck = path.join(webRoot, 'server', 'unfurl', 'self-check.mjs');

  const run = (python: string) => {
    const out = mkdtempSync(path.join(os.tmpdir(), 'unfurl-self-check-'));
    const result = spawnSync(process.execPath, [selfCheck, shell, out], {
      encoding: 'utf8',
      env: { ...process.env, PYTHON: python },
    });
    return {
      printed: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      status: result.status,
    };
  };

  it('names the renderer and what to do about it, instead of refusing silently', () => {
    // A python that STARTS and fails the way a broken one does, rather than a
    // missing file: this is the failure a person cannot tell from a broken
    // build, so it is the one the refusal has to describe.
    const out = mkdtempSync(path.join(os.tmpdir(), 'unfurl-broken-python-'));
    const broken = path.join(out, 'python3');
    writeFileSync(broken, '#!/bin/sh\necho "no Pillow here" >&2\nexit 3\n', {
      mode: 0o755,
    });
    const { printed, status } = run(broken);
    expect(status).toBe(1);
    expect(printed).toContain('card did not draw for this page');
    expect(printed).toContain('the card renderer exited 3: no Pillow here');
    expect(printed).toContain('what to do next');
    expect(printed).toContain('RE-CUT the release');
  }, 30_000);

  it.skipIf(!pillowReady)(
    'passes on this build, with every card drawn and no fallback unnamed',
    () => {
      const { printed, status } = run('python3');
      expect(status).toBe(0);
      expect(printed).toContain('unfurl self-check ok');
      expect(printed).not.toContain('NONE RECORDED');
    },
    30_000,
  );
});
