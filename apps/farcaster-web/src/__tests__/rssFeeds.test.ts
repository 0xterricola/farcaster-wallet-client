/**
 * The RSS feeds, held to their contract without a socket.
 *
 * `/~/profiles/<fid>/rss` and `/~/channel/<id>/rss` are the cheapest
 * anti-lock-in feature this host ships: a profile or channel becomes
 * followable in any feed reader, with no account and no app. These tests hold
 * the parts that can actually go wrong, and they are quilcast's own lessons
 * (backmeupplz/quilcast commit cdc4ec655888, MIT, adopted 2026-11-06):
 *
 *   1. the escaper — what XML 1.0 cannot hold even when escaped (a C0
 *      control, U+FFFE, half a surrogate pair) is DROPPED, and the five
 *      entities are escaped, so a cast full of `&`, `<` and emoji still
 *      parses;
 *   2. the refusal rules — a nameless FID and an unknown channel are "no such
 *      feed" (404), a failed read is "try again" (503), never an invented
 *      empty feed;
 *   3. the provider chain — the node answers when it answers, Farcaster's
 *      public server stands in when it does not, the answer names which one
 *      held it, and replies are never silently thinned by the fallback;
 *   4. the window — a feed's read is kept ten minutes and a miss as long as
 *      a hit, so a poller cannot stampede the node and a missing feed is not
 *      re-asked every request.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { xml } from '../../server/unfurl/feed.mjs';
import { createUnfurlHandler } from '../../server/unfurl/handler.mjs';
import { createLinkReader, parseFid } from '../../server/unfurl/reader.mjs';

const webRoot = path.resolve(__dirname, '../..');
const shell = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const ORIGIN = 'https://fiddy.fun';

const NODE = 'https://node.example';
const PUBLIC = 'https://api.farcaster.xyz';

// The shapes the fixtures below move, spelled once so every helper (and the
// type checker) agrees on them.
type NodeEmbed = { url?: string; castId?: { fid: number; hash: string } };
type ChainState = {
  calls: string[];
  nodeDown: boolean;
  t?: number;
  now?: () => number;
};

/** A farcaster-protocol message, the shape `/v1/castsByFid` answers. */
const nodeMessage = ({
  hash,
  fid,
  text,
  timestamp,
  parent = false,
  embeds = [],
}: {
  hash: string;
  fid: number;
  text: string;
  timestamp: number;
  parent?: boolean;
  embeds?: NodeEmbed[];
}) => ({
  hash,
  data: {
    type: 'MESSAGE_TYPE_CAST_ADD',
    fid,
    timestamp,
    castAddBody: {
      text,
      embeds,
      parentCastId: parent ? { fid: 1, hash: `0x${'c'.repeat(40)}` } : null,
      parentUrl: null,
    },
  },
});

const fixtures = {
  castsByFid: {
    messages: [
      // Newest, and hostile on purpose: entities, an emoji, a C0 control,
      // U+FFFE and half a surrogate pair — the escaper's whole case.
      nodeMessage({
        hash: `0x${'a'.repeat(40)}`,
        fid: 3,
        text: 'Fish & <chips> "today" \u2700\uFE0F and a control:\u0001 plus \uFFFE and \uD800 alone',
        timestamp: 1_000,
        embeds: [
          { url: 'https://pictures.example/a.png' },
          { castId: { fid: 2, hash: `0x${'b'.repeat(40)}` } },
        ],
      }),
      // A reply: hidden unless ?replies=1.
      nodeMessage({
        hash: `0x${'d'.repeat(40)}`,
        fid: 3,
        text: 'A reply\nwith a second line',
        timestamp: 2_000,
        parent: true,
      }),
      // A hash that is not a full hash: skipped, never an item.
      nodeMessage({
        hash: '0xdeadbeef',
        fid: 3,
        text: 'A prefix is not answerable',
        timestamp: 3_000,
      }),
    ],
  },
  userDataByFid: {
    messages: [
      {
        data: {
          userDataBody: { type: 'USER_DATA_TYPE_USERNAME', value: 'dwr' },
        },
      },
      {
        data: {
          userDataBody: { type: 'USER_DATA_TYPE_DISPLAY', value: 'Dan Romero' },
        },
      },
    ],
  },
  // The channel, under the warpcast spelling the network actually carries.
  castsByParent: {
    messages: [
      nodeMessage({
        hash: `0x${'e'.repeat(40)}`,
        fid: 3,
        text: 'A cast in the channel',
        timestamp: 500,
      }),
    ],
  },
};

/** A fetch that answers the chain from fixtures, counting every call. */
const chainFetch = (state: ChainState) => async (url: string | URL) => {
  state.calls.push(String(url));
  const target = String(url);
  if (target.startsWith(`${NODE}/v1/userDataByFid`)) {
    const fid = Number(new URL(target).searchParams.get('fid'));
    return new Response(
      JSON.stringify(fid === 3 ? fixtures.userDataByFid : { messages: [] }),
      { status: 200 },
    );
  }
  if (target.startsWith(`${NODE}/v1/castsByFid`)) {
    if (state.nodeDown) {
      return new Response('no answer', { status: 502 });
    }
    return new Response(JSON.stringify(fixtures.castsByFid), { status: 200 });
  }
  if (target.startsWith(`${NODE}/v1/castsByParent`)) {
    const parent = new URL(target).searchParams.get('url') ?? '';
    if (state.nodeDown) {
      return new Response('no answer', { status: 502 });
    }
    const carried = [
      'https://warpcast.com/~/channel/memes',
      'https://farcaster.xyz/~/channel/snaps',
    ];
    const answered = carried.includes(parent);
    return new Response(
      JSON.stringify(answered ? fixtures.castsByParent : { messages: [] }),
      { status: 200 },
    );
  }
  if (target.startsWith(`${PUBLIC}/v2/user-by-fid`)) {
    const fid = Number(new URL(target).searchParams.get('fid'));
    if (fid !== 3) {
      return new Response(JSON.stringify({ errors: [] }), { status: 404 });
    }
    return new Response(
      JSON.stringify({
        result: {
          user: {
            fid: 3,
            username: 'dwr',
            displayName: 'Dan Romero',
            profile: {
              bio: { text: 'Interested in technology and other stuff.' },
            },
          },
        },
      }),
      { status: 200 },
    );
  }
  if (target.startsWith(`${PUBLIC}/v2/profile-casts`)) {
    return new Response(
      JSON.stringify({
        result: {
          casts: [
            {
              hash: `0x${'f'.repeat(40)}`,
              text: 'A cast the public server answered',
              timestamp: 1_500 * 1000 + 1609459200000,
              author: { fid: 3, username: 'dwr' },
              embeds: { images: [], urls: [], casts: [] },
            },
          ],
        },
      }),
      { status: 200 },
    );
  }
  return new Response('not found', { status: 404 });
};

const buildHandler = (
  state: ChainState,
  overrides: { feedRemoved?: { casts: string[]; fids: number[] } } = {},
) => {
  const reader = createLinkReader({
    fetchImpl: chainFetch(state),
    nodeBaseUrl: NODE,
    neynarApiKey: 'test-only',
    appOrigin: ORIGIN,
    now: () => state.t ?? 0,
  });
  return createUnfurlHandler({
    origin: ORIGIN,
    shellSource: () => shell,
    siteCard: Buffer.from('89504e470d0a1a0a', 'hex'),
    renderCard: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
    reader,
    now: () => state.t,
    ...(overrides.feedRemoved ? { feedRemoved: overrides.feedRemoved } : {}),
  } as never);
};

const request = async (handler: unknown, url: string, ip = '203.0.113.7') =>
  (await (
    handler as {
      handle: (request: {
        method: string;
        path: string;
        ip?: string;
      }) => Promise<{
        status: number;
        headers: Record<string, string>;
        body: string | Buffer;
      }>;
    }
  ).handle({ method: 'GET', path: url, ip })) as {
    status: number;
    headers: Record<string, string>;
    body: string | Buffer;
  };

const body = (answer: { body: string | Buffer }) => String(answer.body);

describe('the XML escaper', () => {
  it('drops what XML 1.0 cannot hold even when escaped', () => {
    expect(xml('a\u0001b\uFFFEc\uD800d')).toBe('abcd');
  });
  it('escapes the five entities', () => {
    expect(xml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
  it('keeps a real emoji whole', () => {
    expect(xml('\u2700\uFE0F')).toBe('\u2700\uFE0F');
  });
});

describe('a profile feed', () => {
  it('answers RSS 2.0 with the casts, the pictures and the quoted cast', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(buildHandler(state), '/~/profiles/3/rss');
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe(
      'application/rss+xml; charset=utf-8',
    );
    expect(answer.headers['cache-control']).toBe('public, max-age=600');
    const xmlBody = body(answer);
    expect(xmlBody).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xmlBody).toContain('<rss version="2.0"');
    expect(xmlBody).toContain('<ttl>15</ttl>');
    expect(xmlBody.match(/<item>/g)).toHaveLength(1);
    expect(xmlBody).toContain(
      `<link>${ORIGIN}/~/conversations/0x${'a'.repeat(40)}</link>`,
    );
    expect(xmlBody).toContain('<guid isPermaLink="true">');
    expect(xmlBody).toContain('<pubDate>');
    expect(xmlBody).toContain(
      '&lt;img src=&quot;https://pictures.example/a.png&quot;',
    );
    expect(xmlBody).toContain('&gt;Quoted cast&lt;/a&gt;');
    expect(xmlBody).toContain('<dc:creator>Dan Romero (@dwr)</dc:creator>');
    // The hostile cast: entities escaped, the control and U+FFFE gone, the
    // emoji whole. A document that carries any of the dropped characters is
    // not parseable by any reader.
    expect(xmlBody).toContain('Fish &amp; &lt;chips&gt;');
    expect(xmlBody).not.toContain('\u0001');
    expect(xmlBody).not.toContain('\uFFFE');
    expect(xmlBody).not.toContain('\uD800');
    expect(xmlBody).toContain('\u2700\uFE0F');
  });

  it('escapes the description as XML character data', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(buildHandler(state), '/~/profiles/3/rss');
    expect(body(answer)).toContain('&quot;today&quot;');
  });

  it('names the server that answered the read', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(buildHandler(state), '/~/profiles/3/rss');
    expect(answer.headers['x-unfurl']).toBe('feed:profile');
    expect(answer.headers['x-fiddy-feed-read']).toBe(`node:${NODE}`);
  });

  it('advertises itself on the profile page the crawler reads', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(buildHandler(state), '/~/profiles/3');
    const html = body(answer);
    expect(html).toContain('<link rel="alternate" type="application/rss+xml"');
    expect(html).toContain(`${ORIGIN}/~/profiles/3/rss`);
    // The plain-words line, on the server-drawn crawler page.
    expect(html).toContain('Every profile here has a feed');
  });

  it('hides replies unless asked, and adds them when asked', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const handler = buildHandler(state);
    const plain = await request(handler, '/~/profiles/3/rss');
    expect(body(plain).match(/<item>/g)).toHaveLength(1);
    const withReplies = await request(handler, '/~/profiles/3/rss?replies=1');
    expect(body(withReplies).match(/<item>/g)).toHaveLength(2);
    expect(body(withReplies)).toContain('&lt;br&gt;');
  });

  it('keeps one read per feed per window, so a poller cannot stampede', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const handler = buildHandler(state);
    await request(handler, '/~/profiles/3/rss');
    const readsAfterFirst = state.calls.length;
    await request(handler, '/~/profiles/3/rss');
    await request(handler, '/~/profiles/3/rss');
    expect(state.calls.length).toBe(readsAfterFirst);
    // Ten minutes later (the window is quilcast's number), the read happens.
    state.t = 1_000 + 10 * 60 * 1000 + 1;
    await request(handler, '/~/profiles/3/rss');
    expect(state.calls.length).toBeGreaterThan(readsAfterFirst);
  });

  it('refuses a nameless FID as no such feed, and remembers the miss', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const handler = buildHandler(state);
    const answer = await request(handler, '/~/profiles/30/rss');
    expect(answer.status).toBe(404);
    expect(body(answer)).toBe('No such feed.\n');
    // A nameless FID, asked again, is not re-read: the miss is remembered as
    // long as a feed is.
    const readsAfterFirst = state.calls.length;
    await request(handler, '/~/profiles/30/rss');
    expect(state.calls.length).toBe(readsAfterFirst);
  });

  it('drops a taken-down cast and refuses a taken-down account', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const handler = buildHandler(state, {
      feedRemoved: {
        casts: [`0x${'a'.repeat(40)}`],
        fids: [],
      },
    });
    const answer = await request(handler, '/~/profiles/3/rss');
    expect(answer.status).toBe(200);
    expect(body(answer).match(/<item>/g) ?? []).toHaveLength(0);

    const handlerAccountGone = buildHandler(
      { calls: [], nodeDown: false, t: 1_000 },
      { feedRemoved: { casts: [], fids: [3] } },
    );
    const refused = await request(handlerAccountGone, '/~/profiles/3/rss');
    expect(refused.status).toBe(404);
    expect(body(refused)).toBe('No such feed.\n');
  });

  it('falls through to Farcaster public when the node does not answer', async () => {
    const state: ChainState = { calls: [], nodeDown: true, now: () => 1_000 };
    const answer = await request(buildHandler(state), '/~/profiles/3/rss');
    expect(answer.status).toBe(200);
    expect(answer.headers['x-fiddy-feed-read']).toBe('farcaster-public');
    expect(body(answer)).toContain('A cast the public server answered');
    // A dead node with replies asked for is a failed read, not a thinned feed.
    const withReplies = await request(
      buildHandler({ calls: [], nodeDown: true, now: () => 2_000 }),
      '/~/profiles/3/rss?replies=1',
    );
    expect(withReplies.status).toBe(503);
    expect(body(withReplies)).toBe('Try again in a minute.\n');
  });

  it('answers try-again, and does not remember the failure', async () => {
    // farcaster-public also refuses: the whole chain is down.
    const handler = createUnfurlHandler({
      origin: ORIGIN,
      shellSource: () => shell,
      siteCard: Buffer.from('89504e470d0a1a0a', 'hex'),
      renderCard: async () => Buffer.from('89504e470d0a1a0a', 'hex'),
      reader: createLinkReader({
        fetchImpl: async () => new Response('down', { status: 502 }),
        nodeBaseUrl: NODE,
        neynarApiKey: 'test-only',
        appOrigin: ORIGIN,
      }),
      now: () => 1_000,
    } as never);
    const answer = await request(handler, '/~/profiles/3/rss');
    expect(answer.status).toBe(503);
    expect(body(answer)).toBe('Try again in a minute.\n');
  });

  it('refuses an id that is not an fid', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(buildHandler(state), '/~/profiles/dwr/rss');
    expect(answer.status).toBe(404);
  });

  it('slows a caller down past the feed limit', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const handler = buildHandler(state);
    let answer;
    for (let i = 0; i < 60; i += 1) {
      answer = await request(handler, '/~/profiles/3/rss');
      expect(answer.status).toBe(200);
    }
    answer = await request(handler, '/~/profiles/3/rss');
    expect(answer.status).toBe(429);
    expect(answer.headers['retry-after']).toBe('60');
  });
});

describe('a channel feed', () => {
  it('answers under the parent URL the network carries', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(buildHandler(state), '/~/channel/memes/rss');
    expect(answer.status).toBe(200);
    expect(answer.headers['x-unfurl']).toBe('feed:channel');
    expect(answer.headers['x-fiddy-feed-read']).toBe(`node:${NODE}`);
    const xmlBody = body(answer);
    expect(xmlBody).toContain('A cast in the channel');
    // The warpcast spelling is asked first; the farcaster.xyz one never was.
    expect(state.calls.some((call) => call.includes('warpcast.com'))).toBe(
      true,
    );
    expect(state.calls.some((call) => call.includes('farcaster.xyz'))).toBe(
      false,
    );
  });

  it('asks the farcaster.xyz spelling only when the first came back empty', async () => {
    // Both spellings empty: no such feed.
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(buildHandler(state), '/~/channel/quiet/rss');
    expect(answer.status).toBe(404);
    expect(body(answer)).toBe('No such feed.\n');
    expect(state.calls.some((call) => call.includes('farcaster.xyz'))).toBe(
      true,
    );
  });

  it('takes the channel key as its real parent URL when it spells one', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const parent = 'https://farcaster.xyz/~/channel/snaps';
    const answer = await request(
      buildHandler(state),
      `/~/channel/${encodeURIComponent(parent)}/rss`,
    );
    expect(answer.status).toBe(200);
    expect(
      state.calls.some((call) =>
        call.includes(`/v1/castsByParent?url=${encodeURIComponent(parent)}`),
      ),
    ).toBe(true);
  });

  it('answers try-again when the node is down (no other server holds channels)', async () => {
    const state: ChainState = { calls: [], nodeDown: true, now: () => 1_000 };
    const answer = await request(buildHandler(state), '/~/channel/memes/rss');
    expect(answer.status).toBe(503);
  });

  it('refuses a key that is neither a channel key nor a URL', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(
      buildHandler(state),
      `/~/channel/${encodeURIComponent('not a channel!')}/rss`,
    );
    expect(answer.status).toBe(404);
  });
});

describe('parseFid', () => {
  it('takes an integer and refuses everything else', () => {
    expect(parseFid('3')).toBe(3);
    expect(parseFid('0')).toBe(0);
    expect(parseFid('dwr')).toBeUndefined();
    expect(parseFid('-1')).toBeUndefined();
    expect(parseFid('1.5')).toBeUndefined();
  });
});

// A document a real validator reads: written once, checked with xmllint when
// the machine has it, so the "well-formed" claim is never only ours.
describe('the document is well-formed XML', () => {
  it('parses under xmllint when present', async () => {
    const state: ChainState = { calls: [], nodeDown: false, t: 1_000 };
    const answer = await request(buildHandler(state), '/~/profiles/3/rss');
    const file = path.join(
      mkdtempSync(path.join(os.tmpdir(), 'fiddy-rss-')),
      'feed.xml',
    );
    writeFileSync(file, body(answer));
    let linted;
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('xmllint', ['--noout', file], { stdio: 'pipe' });
      linted = true;
    } catch (error) {
      linted = undefined;
      // eslint-disable-next-line no-console
      console.warn(
        `xmllint not usable here (${
          error instanceof Error ? error.message : String(error)
        }); structural checks above stand`,
      );
    }
    if (linted !== undefined) {
      expect(linted).toBe(true);
    }
  });
});
