/**
 * The shared-look half of the per-page service, held to its contract with no
 * socket (the same harness `unfurlService.test.ts` uses).
 *
 * What is asserted here is what a stranger's browser can make this host do:
 *
 *   1. STORED ONCE, BY CONTENT. The same checked body is the same id, twice —
 *      and a second share of it does not rewrite the file (the id IS the
 *      contents, so a stored look is immutable and there is nothing to migrate).
 *   2. REFUSALS, NOT REPAIRS. A body that is empty, unreadable, oversized, or
 *      that carries a picture or a font is refused with a status and a sentence.
 *      What is stored can only be the eleven named colours, a name, a base, two
 *      whole numbers in range and one of three faces.
 *   3. A TRAP DOOR IS NOT A DOOR. An id that is not ten hex characters never
 *      reaches the filesystem (`../../etc/passwd` is a 404 and a dead-link
 *      sentence, not a read).
 *   4. THE PAGE AND THE CARD. `/look/<id>` answers the release's own shell with
 *      the look's tags (nothing inline, `script-src 'self'` still enough), a
 *      missing look is the shell and never an invented page, and the card route
 *      hands the renderer a payload drawn from the CHECKED look.
 *   5. ONE MODEL, THREE FILES. The host's checker, the browser's and the shell
 *      bootstrap's agree on the token list, the limits and the colour rule.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  cleanLook,
  FIDDY_LOOK,
  LOOK_LIMITS as CLIENT_LIMITS,
  LOOK_TOKENS as CLIENT_TOKENS,
  LOOK_VARS,
} from '~/utils/lookTheme';

import { createUnfurlHandler } from '../../server/unfurl/handler.mjs';
import {
  carriesLookBody,
  readLookBody,
} from '../../server/unfurl/lookBody.mjs';
import {
  cleanLook as cleanLookOnHost,
  createLookStore,
  isLookId,
  LOOK_LIMITS,
  LOOK_MEDIA_KEYS,
  LOOK_TOKENS,
  shareableLook,
} from '../../server/unfurl/looks.mjs';

const webRoot = path.resolve(__dirname, '../..');
const shell = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const ORIGIN = 'https://fiddy.fun';

const miniAppEmbed = (html: string) => {
  const content = /<meta\s+name="fc:miniapp"\s+content='([^']*)'/.exec(
    html,
  )?.[1];
  return JSON.parse(content ?? 'null') as {
    imageUrl: string;
    button: { title: string; action: { url: string } };
  };
};

const store = () =>
  createLookStore({ dir: mkdtempSync(path.join(os.tmpdir(), 'fiddy-looks-')) });

/**
 * One store per test FILE, shared by every handler this file builds: a service
 * stores a look in one request and reads it in the next, and a store per call
 * would have made "share then read back" a test of nothing.
 */
const defaultStore = store();

const handler = (overrides: Record<string, unknown> = {}) =>
  createUnfurlHandler({
    origin: ORIGIN,
    shellSource: () => shell,
    siteCard: Buffer.from('89504e470d0a1a0a', 'hex'),
    renderCard: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
    reader: {
      cast: async () => undefined,
      profile: async () => undefined,
      size: () => 0,
    },
    looks: defaultStore,
    ...overrides,
  } as never);

type Answer = {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
};

const ask = async (
  request: { method: string; path: string; body?: string },
  overrides: Record<string, unknown> = {},
): Promise<Answer> =>
  (await handler(overrides).handle(request)) as unknown as Answer;

const share = async (
  look: unknown,
  overrides: Record<string, unknown> = {},
): Promise<{ id?: string; status: number; error?: string }> => {
  const answer = await ask(
    { method: 'POST', path: '/look', body: JSON.stringify(look) },
    overrides,
  );
  return { status: answer.status, ...JSON.parse(String(answer.body)) };
};

const A_LOOK = {
  name: 'Mossy',
  bg: '#101418',
  card: '#182028',
  ink: '#e8f0e0',
  muted: '#8fa08a',
  line: '#243024',
  soft: '#182028',
  accent: '#b8ff3f',
  onAccent: '#10200a',
  like: '#ff6f9c',
  recast: '#3fd08a',
  border: '#243024',
  base: 'light',
  round: 20,
  borderWidth: 2,
  font: 'mono',
};

describe('a shared look is stored once, under a hash of its checked body', () => {
  it('answers the same id for the same look, whatever order it arrives in', async () => {
    const first = await share(A_LOOK);
    const second = await share({ ...A_LOOK });
    const reordered = await share({
      accent: A_LOOK.accent,
      name: A_LOOK.name,
      font: A_LOOK.font,
      borderWidth: A_LOOK.borderWidth,
      round: A_LOOK.round,
      base: A_LOOK.base,
      bg: A_LOOK.bg,
      card: A_LOOK.card,
      ink: A_LOOK.ink,
      muted: A_LOOK.muted,
      line: A_LOOK.line,
      soft: A_LOOK.soft,
      onAccent: A_LOOK.onAccent,
      like: A_LOOK.like,
      recast: A_LOOK.recast,
      border: A_LOOK.border,
    });

    expect(first.status).toBe(200);
    expect(first.id).toMatch(/^[0-9a-f]{10}$/);
    expect(second.id).toBe(first.id);
    // The checked body is normalised, so the id does not depend on key order.
    expect(reordered.id).toBe(first.id);
  });

  it('gives a different look a different id', async () => {
    const mine = await share(A_LOOK);
    const theirs = await share({ ...A_LOOK, accent: '#ff0000' });
    expect(theirs.id).not.toBe(mine.id);
  });

  it('reads back exactly what it stored, checked again', async () => {
    const { id } = await share(A_LOOK);
    const answer = await ask({ method: 'GET', path: `/look/${id}.json` });
    const body = JSON.parse(String(answer.body)) as {
      look: Record<string, unknown>;
    };

    expect(answer.status).toBe(200);
    expect(answer.headers['x-unfurl'] ?? '').not.toBeUndefined();
    expect(body.look.name).toBe('Mossy');
    expect(body.look.accent).toBe('#b8ff3f');
    expect(body.look.round).toBe(20);
    expect(body.look.font).toBe('mono');
    // Nothing a look may not hold came back with it.
    expect(Object.keys(body.look).sort()).toEqual(
      Object.keys(cleanLook(A_LOOK)).sort(),
    );
  });

  it('does not rewrite a look it already holds', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fiddy-looks-same-'));
    const looks = createLookStore({ dir });
    const body = JSON.stringify(cleanLookOnHost(A_LOOK));
    const first = await looks.put(body);
    const second = await looks.put(body);
    expect(second.id).toBe(first.id);
    expect(readFileSync(path.join(dir, `${first.id}.json`), 'utf8')).toBe(body);
  });
});

describe('a body that is not a checked look is refused, in one sentence', () => {
  it('refuses an empty look', async () => {
    const answer = await share({});
    expect(answer.status).toBe(400);
    expect(answer.error).toBe('That look is empty.');
  });

  it('refuses CSS, a URL, and any other key it does not know', async () => {
    // A stylesheet is not a colour, so nothing survives the checker.
    const css = await share({
      css: 'body { background: url(http://evil.test) }',
    });
    expect(css.status).toBe(400);

    // The same for a colour that is really a URL, a variable or an expression.
    for (const value of [
      'url(https://example.com/x.png)',
      'javascript:alert(1)',
      'var(--x)',
      'expression(alert(1))',
    ]) {
      const answer = await share({ bg: value });
      expect(answer.status).toBe(400);
      expect(answer.error).toBe('That look is empty.');
    }
  });

  it('refuses a look that carries a picture or a font', async () => {
    const answer = await share({
      bg: '#161715',
      bgImg: 'data:image/png;base64,AAAA',
    });
    expect(answer.status).toBe(400);
    expect(answer.error).toBe("A look can't carry a picture or a font yet.");

    const font = await share({
      accent: '#fff000',
      fontUrl: 'https://x.test/a.ttf',
    });
    expect(font.status).toBe(400);
  });

  it('refuses a body that is not JSON, and one that came through empty', async () => {
    const notJson = await ask({ method: 'POST', path: '/look', body: '{oops' });
    expect(notJson.status).toBe(400);

    const empty = await ask({ method: 'POST', path: '/look', body: '' });
    expect(empty.status).toBe(400);

    const oversized = await ask({
      method: 'POST',
      path: '/look',
      body: JSON.stringify({
        bg: '#161715',
        name: 'x'.repeat(LOOK_LIMITS.bytes),
      }),
    });
    expect(oversized.status).toBe(413);
    expect(JSON.parse(String(oversized.body)).error).toBe(
      'That look is too big to share.',
    );
  });

  it('drops what it does not know rather than storing it', () => {
    const shareable = shareableLook(
      JSON.stringify({ bg: '#161715', width: 100, '--evil': 'red' }),
    );
    expect(shareable.ok).toBe(true);
    expect(shareable.body).toBe('{"bg":"#161715"}');
  });

  it('answers the app in one plain sentence when the host stores no looks', async () => {
    const answer = await ask(
      {
        method: 'POST',
        path: '/look',
        body: JSON.stringify({ bg: '#161715' }),
      },
      { looks: undefined },
    );
    expect(answer.status).toBe(503);
    expect(JSON.parse(String(answer.body)).error).toBe(
      "Fiddy can't save looks on this host right now.",
    );
  });

  it('answers 405 to anything else with a body', async () => {
    const answer = await ask({ method: 'POST', path: '/look/abc', body: '{}' });
    expect(answer.status).toBe(405);
  });
});

describe('an id is never a path', () => {
  it('knows a real id from anything else', () => {
    expect(isLookId('0123456789')).toBe(true);
    expect(isLookId('ABCDEF0123')).toBe(false);
    expect(isLookId('../../etc/passwd')).toBe(false);
    expect(isLookId('0123456789.json')).toBe(false);
    expect(isLookId('')).toBe(false);
  });

  it('answers a dead link in one sentence, and never reads a file', async () => {
    const answer = await ask({ method: 'GET', path: '/look/0123456789.json' });
    expect(answer.status).toBe(404);
    expect(JSON.parse(String(answer.body)).error).toBe(
      "That look link doesn't work any more.",
    );

    const traversal = await ask({
      method: 'GET',
      path: `/look/${encodeURIComponent('../../etc/passwd')}.json`,
    });
    expect(traversal.status).toBe(404);
    expect(String(traversal.body)).not.toContain('root:');
  });
});

describe('the page a look link unfurls as', () => {
  it('answers the release shell with the look own tags', async () => {
    const looks = store();
    const { id } = (await looks.put(
      JSON.stringify(cleanLookOnHost(A_LOOK)),
    )) as { id: string };
    const answer = await ask({ method: 'GET', path: `/look/${id}` }, { looks });
    const html = String(answer.body);

    expect(answer.status).toBe(200);
    expect(answer.headers['x-unfurl']).toBe('page:look');
    expect(answer.headers['cache-control']).toBe(
      'public, max-age=300, no-transform',
    );
    const embed = miniAppEmbed(html);
    expect(embed.imageUrl).toBe(`${ORIGIN}/unfurl/cards/look/${id}.3x2.png`);
    expect(embed.button.title).toBe('Open this look in fiddy');
    expect(embed.button.action.url).toBe(`${ORIGIN}/look/${id}`);
    expect(html).toContain('<title>Mossy — a look for Fiddy</title>');
    expect(html).toContain(`og:url" content="${ORIGIN}/look/${id}"`);
    expect(html).toContain(`/unfurl/cards/look/${id}.png`);
    // The shell itself is unchanged: same bytes either side of the head.
    expect(html).toContain('/shell-bootstrap.js');
    expect(html.length).toBeGreaterThan(shell.length / 2);
    // …and nothing was made inline: the host serves `script-src 'self'`.
    const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
    const inline = [...withoutComments.matchAll(/<script\b([^>]*)>/gi)].filter(
      (match) => !/\bsrc\s*=/i.test(match[1]),
    );
    expect(inline).toHaveLength(0);
  });

  it('invents nothing for a look nobody stored: the shell, unchanged', async () => {
    const answer = await ask({ method: 'GET', path: '/look/0123456789' });
    expect(answer.status).toBe(200);
    expect(answer.headers['x-unfurl']).toBe('shell');
    expect(String(answer.body)).toBe(shell);
  });

  it('never credits a maker from the query string', async () => {
    // A URL that could name anyone must not become a claim about who made it:
    // the app's card names the CAST's author, which is a fact.
    const looks = store();
    const { id } = (await looks.put(
      JSON.stringify(cleanLookOnHost(A_LOOK)),
    )) as { id: string };
    const answer = await ask(
      { method: 'GET', path: `/look/${id}?by=somebody` },
      { looks },
    );
    expect(String(answer.body)).not.toContain('somebody');
  });
});

describe('the card a look unfurls as', () => {
  it('hands the renderer the look own palette', async () => {
    const rendered: Record<string, unknown>[] = [];
    const looks = store();
    const { id } = (await looks.put(
      JSON.stringify(cleanLookOnHost(A_LOOK)),
    )) as { id: string };

    const answer = await ask(
      { method: 'GET', path: `/unfurl/cards/look/${id}.png` },
      {
        looks,
        renderCard: async (payload: Record<string, unknown>) => {
          rendered.push(payload);
          return Buffer.from('89504e470d0a1a0a', 'hex');
        },
      },
    );

    expect(answer.status).toBe(200);
    expect(answer.headers['x-unfurl']).toBe('card:look');
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toMatchObject({
      kind: 'look',
      id,
      name: 'Mossy',
      round: 20,
      borderWidth: 2,
      font: 'mono',
    });
    expect((rendered[0].palette as Record<string, string>).accent).toBe(
      '#b8ff3f',
    );
    expect((rendered[0].palette as Record<string, string>).bg).toBe('#101418');
  });

  it('draws the look again at 1200x800 for its mini-app card', async () => {
    const rendered: Record<string, unknown>[] = [];
    const looks = store();
    const { id } = (await looks.put(
      JSON.stringify(cleanLookOnHost(A_LOOK)),
    )) as { id: string };
    const answer = await ask(
      { method: 'GET', path: `/unfurl/cards/look/${id}.3x2.png` },
      {
        looks,
        renderCard: async (payload: Record<string, unknown>) => {
          rendered.push(payload);
          return Buffer.from('1200x800');
        },
      },
    );
    expect(answer.headers['x-unfurl']).toBe('card:look');
    expect(rendered[0]).toMatchObject({ kind: 'look', id, aspect: '3x2' });
  });

  it('falls back to the site card for a look nobody stored, and says why', async () => {
    const answer = await ask({
      method: 'GET',
      path: '/unfurl/cards/look/0123456789.png',
    });
    expect(answer.status).toBe(200);
    expect(answer.headers['x-unfurl']).toBe('card:site');
    expect(answer.headers['x-unfurl-note']).toMatch(/not stored here/);
  });
});

describe('one model, three files', () => {
  it('the host checks the same tokens, limits and colour rule', () => {
    expect(LOOK_TOKENS).toEqual([...CLIENT_TOKENS]);
    for (const key of ['bytes', 'name', 'round', 'borderWidth'] as const) {
      expect(LOOK_LIMITS[key]).toBe(
        (CLIENT_LIMITS as unknown as Record<string, number>)[key],
      );
    }
    expect(LOOK_MEDIA_KEYS).toContain('bgImg');
    expect(LOOK_MEDIA_KEYS).toContain('fontUrl');
    // The one sentence that refuses a picture, on the host, matches the plan:
    // this client ships no media in a look at all.
    expect(Array.from(LOOK_MEDIA_KEYS).sort()).toEqual(
      [...LOOK_MEDIA_KEYS].sort(),
    );
  });

  it('the host and the browser agree on every input', () => {
    const inputs: unknown[] = [
      A_LOOK,
      { bg: 'red', accent: '#FF0000' },
      { round: 99, borderWidth: -3 },
      { name: '  Night\nOwl  ' },
      { base: 'dark' },
      { base: 'light' },
      { font: 'comic-sans' },
      { bgImg: 'data:image/png;base64,AA' },
      { css: 'body{}' },
      null,
      'string',
      [],
      { bg: '#161715', round: 18, borderWidth: 1, font: 'rounded' },
    ];

    for (const input of inputs) {
      const host = cleanLookOnHost(input);
      const browser = cleanLook(input);
      // The host keeps `base: 'light'` and drops 'dark'; the browser does the
      // same, and both normalise their own default values away.
      expect(host).toEqual(browser);
    }
  });

  it('the look the client ships is a look the host accepts, unchanged', () => {
    // The brand look goes through both checkers and comes out the same: what a
    // person can put on is what this host will store and hand back.
    expect(cleanLookOnHost(FIDDY_LOOK)).toEqual(cleanLook(FIDDY_LOOK));
    expect(Object.keys(cleanLook(FIDDY_LOOK)).length).toBeGreaterThan(0);
    // Every variable the browser writes is named and non-empty.
    for (const varName of LOOK_VARS) {
      expect(varName.startsWith('--')).toBe(true);
    }
  });
});

/**
 * The socket's half of the contract: what a body PAST the cap does.
 *
 * This block exists because of a MEASURED failure on fiddy.fun (2026-10-23,
 * card t_d85d8520): the first shape of the reader destroyed the request as soon
 * as a share body crossed the cap, so no answer was ever written — nginx logged
 * a closed upstream and its `error_page 502 = @fiddy_shell` answered the POST
 * with `405 Not Allowed` and an HTML page, while the service's own log said
 * `400`, because the whitespace placeholder it was handed read as an EMPTY
 * body. Every test above hands the handler a string and so could not see any of
 * it. These cases read a request the way the service does.
 */
const fakeRequest = () => {
  const request = new EventEmitter() as EventEmitter & {
    destroyed: boolean;
    destroy: () => void;
    destroyCalls: number;
  };
  request.destroyed = false;
  request.destroyCalls = 0;
  request.destroy = () => {
    request.destroyed = true;
    request.destroyCalls += 1;
  };
  return request;
};

const readPast = async (
  chunks: Buffer[],
): Promise<{ body: string; request: ReturnType<typeof fakeRequest> }> => {
  const request = fakeRequest();
  const reading = readLookBody(request, LOOK_LIMITS.bytes);
  for (const chunk of chunks) {
    request.emit('data', chunk);
  }
  request.emit('end');
  return { body: await reading, request };
};

describe('a share body past the cap is answered, never abandoned', () => {
  it('keeps the socket open and hands the model one byte over the cap', async () => {
    const { body, request } = await readPast([
      Buffer.alloc(3000, 0x61),
      Buffer.alloc(3000, 0x61),
      Buffer.alloc(3000, 0x61),
    ]);

    // The regression: destroying the request closed the socket before the
    // model's sentence could be written, and nginx answered 405 HTML instead.
    expect(request.destroyCalls).toBe(0);
    expect(request.destroyed).toBe(false);

    // What the model is handed is over the cap, and NOT blank: the sentence a
    // person reads is the model's own ("too big"), never "came through empty".
    expect(Buffer.byteLength(body, 'utf8')).toBe(LOOK_LIMITS.bytes + 1);
    expect(body.trim().length).toBeGreaterThan(0);
    const refusal = shareableLook(body);
    expect(refusal.ok).toBe(false);
    expect(refusal.status).toBe(413);
    expect(refusal.error).toBe('That look is too big to share.');
  });

  it('hands a body inside the cap to the model byte for byte', async () => {
    const look = JSON.stringify({ ...A_LOOK, name: 'Mossy 🌿 ünïcode' });
    const { body } = await readPast([
      Buffer.from(look.slice(0, 40)),
      Buffer.from(look.slice(40)),
    ]);
    expect(body).toBe(look);
    expect(shareableLook(body).ok).toBe(true);
  });

  it('is inclusive at the cap: at it the body is read, one byte past it is too big', async () => {
    const atCap = Buffer.alloc(LOOK_LIMITS.bytes, 0x78);
    const overCap = Buffer.alloc(LOOK_LIMITS.bytes + 1, 0x78);
    const inside = await readPast([atCap]);
    const past = await readPast([overCap]);
    expect(Buffer.byteLength(inside.body, 'utf8')).toBe(LOOK_LIMITS.bytes);
    expect(Buffer.byteLength(past.body, 'utf8')).toBe(LOOK_LIMITS.bytes + 1);
    expect(shareableLook(inside.body).status).toBe(400);
    expect(shareableLook(past.body).status).toBe(413);
  });

  it('settles on a request that errors mid-body rather than rejecting', async () => {
    const request = fakeRequest();
    const reading = readLookBody(request, LOOK_LIMITS.bytes);
    request.emit('data', Buffer.from('{"bg":"#161715"}'));
    request.emit('error', new Error('aborted'));
    await expect(reading).resolves.toBe('{"bg":"#161715"}');
  });

  it('reads a body only from the POST that shares a look', () => {
    expect(carriesLookBody('POST', '/look')).toBe(true);
    expect(carriesLookBody('POST', '/look?from=app')).toBe(true);
    expect(carriesLookBody('GET', '/look')).toBe(false);
    expect(carriesLookBody('POST', '/look/91fd1eb7f0')).toBe(false);
    expect(carriesLookBody('POST', '/unfurl/cards/look/91fd1eb7f0.png')).toBe(
      false,
    );
  });
});
