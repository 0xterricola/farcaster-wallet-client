/**
 * The three pages this service serves, rendered from the build under release and
 * checked against the rules the shell itself is held to.
 *
 *   node server/unfurl/self-check.mjs dist/index.html [outDir]
 *
 * This runs inside the release ritual (scripts/release-client.sh step 3), before
 * anything is uploaded: the service renders a cast page and a profile page from
 * fixture data with NO network, and this asserts
 *
 *   1. the page's own `og:` tags are there, exactly once each, naming the page
 *      and a card on this host;
 *   2. the site's front-door tags are gone, because a document that declares
 *      both tells an unfurler whichever one it reads first;
 *   3. cast and look bodies stay byte-for-byte the shell; a profile adds only
 *      its crawler-readable root, while the theme bootstrap, skeleton markup
 *      and entry chunk stay intact;
 *   4. nothing injected is inline executable script or an inline handler
 *      (ProfilePage JSON-LD is data), the same rule
 *      `scripts/check-shell-has-no-inline-script.mjs` makes of the shell
 *      (that host serves `script-src 'self'`), so a tag that would be
 *      refused in a browser cannot ship;
 *   5. values that came off the network cannot close an attribute — a cast whose
 *      text contains a quote and a handle built out of angle brackets;
 *   6. the CARD each page promises is drawn by the real renderer, from this
 *      build's own mascot, and is not the site card — the picture, not just the
 *      pixels. A page's `og:image` is a promise to a platform, and the site card
 *      is also 1200x630 (see the note at the card checks);
 *   7. a card that falls back to the site card SAYS WHY, in the handler's own
 *      words, printed with the failing check — and the printout ends with what
 *      to do about it (re-cut the release, or fix the build), so a refusal
 *      costs one run instead of three.
 *
 * The rendered documents are written to `<outDir>/` so the ritual (and a person)
 * can grep what will actually be served.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUnfurlHandler } from './handler.mjs';
import {
  createCardRenderer,
  pngSize,
  CARD_WIDTH,
  CARD_HEIGHT,
  MINI_APP_CARD_HEIGHT,
} from './cards.mjs';

const selfPath = fileURLToPath(import.meta.url);
const webRoot = path.resolve(path.dirname(selfPath), '..', '..');
const shellPath = process.argv[2] ?? path.join(webRoot, 'dist', 'index.html');
const outDir = path.resolve(
  process.argv[3] ?? path.join(webRoot, 'unfurl-self-check'),
);
const origin = process.env.FIDDY_ORIGIN ?? 'https://fiddy.fun';

const failures = [];
const note = (line) => console.log(`  ${line}`);
const check = (name, condition, detail) => {
  if (condition) {
    note(`${name}: ok${detail ? ` (${detail})` : ''}`);
    return true;
  }
  failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  return false;
};

const shell = readFileSync(shellPath, 'utf8');

// WHAT A PAGE IS, built here rather than fetched: the fixtures carry the shapes
// a hostile one takes (a quote, an angle bracket, a long body, no text at all).
const CAST_HASH = `0x${'a'.repeat(40)}`;
const FEED_HASH = `0x${'b'.repeat(40)}`;
const LOOK_ID = '0123456789';
const LOOK = {
  name: 'Fiddy dark',
  bg: '#161715',
  card: '#1d1e1c',
  ink: '#eef0e8',
  muted: '#9ba193',
  accent: '#d4ff3f',
  round: 18,
  borderWidth: 1,
  font: 'rounded',
};
// The feeds' fixtures: a cast hostile to XML (the escaper's case), a reply
// hidden unless asked for, and a channel with one cast under the warpcast
// spelling the network really carries (see `reader.mjs`).
const FEED_TIMESTAMP = 1_000; // protocol seconds from the 2021 epoch
const fixtures = {
  feed: {
    author: {
      fid: 3,
      username: 'dwr',
      displayName: 'Dan Romero',
      bio: 'Building <things> & "sharing" on Farcaster.',
    },
    casts: [
      {
        hash: `0x${'a'.repeat(40)}`,
        fid: 3,
        who: 'Dan Romero (@dwr)',
        text: 'Fish & <chips> \u2700\uFE0F and a control:\u0001',
        timestampMs: (FEED_TIMESTAMP + 100) * 1000 + 1609459200000,
        parent: false,
        embeds: [{ url: 'https://pictures.example/a.png' }],
      },
      {
        hash: `0x${'d'.repeat(40)}`,
        fid: 3,
        who: 'Dan Romero (@dwr)',
        text: 'A reply',
        timestampMs: (FEED_TIMESTAMP + 200) * 1000 + 1609459200000,
        parent: true,
        embeds: [],
      },
    ],
    source: 'node:https://node.example',
  },
  channel: {
    casts: [
      {
        hash: `0x${'e'.repeat(40)}`,
        fid: 3,
        who: 'Dan Romero (@dwr)',
        text: 'A cast in the channel',
        timestampMs: (FEED_TIMESTAMP + 300) * 1000 + 1609459200000,
        parent: false,
        embeds: [],
      },
    ],
    parentUrl: 'https://warpcast.com/~/channel/memes',
    source: 'node:https://node.example',
  },
  cast: {
    cast: {
      hash: CAST_HASH,
      fid: 3,
      text: 'A cast with a "quote" and <brackets> in it, long enough to be clipped by a card that refuses to grow: '.repeat(
        2,
      ),
    },
    author: { fid: 3, username: 'dwr', displayName: 'Dan "Romero" <d>' },
  },
  profile: {
    author: {
      fid: 3,
      username: 'dwr',
      displayName: 'Dan Romero',
      bio: 'Building <things> & "sharing" on Farcaster.',
    },
    casts: [
      {
        hash: CAST_HASH,
        fid: 3,
        text: 'A latest post with <brackets> & "quotes"',
      },
    ],
  },
};

// The card the SITE uses, read once: it is both the fallback the handler may
// answer with and the picture a page's card must NOT be.
const siteCardBytes = readFileSync(
  path.join(webRoot, 'public', 'fiddy-share-card.png'),
);

const handler = createUnfurlHandler({
  origin,
  shellSource: () => shell,
  siteCard: siteCardBytes,
  renderCard: createCardRenderer({
    pythonPath: process.env.PYTHON ?? 'python3',
    scriptPath: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'render-card.py',
    ),
    mascotPath: path.join(webRoot, 'public', 'fiddy-mark-poster.png'),
  }).render,
  reader: {
    cast: async (hash) =>
      hash.toLowerCase() === CAST_HASH ? fixtures.cast : undefined,
    profile: async (fid) =>
      String(fid) === '3' ? fixtures.profile : undefined,
    // The feeds: an account that has one, a channel that has one, and the
    // refusal rule — anything else is no such feed.
    feed: async (fid) =>
      String(fid) === '3' ? fixtures.feed : undefined,
    channelFeed: async (key) =>
      key === 'memes' ? fixtures.channel : undefined,
    size: () => 0,
    feedSize: () => 0,
  },
  looks: {
    get: async (id) => (id === LOOK_ID ? LOOK : undefined),
  },
  feed: {
    get: async () => ({
      at: 1234,
      result: {
        latestMainCastTimestamp: 1,
        items: [
          {
            id: 'fixture-feed-a',
            cast: {
              hash: FEED_HASH,
              fid: 3,
              text: 'A root cast with <brackets> & "quotes"',
              timestamp: Date.UTC(2026, 0, 2),
              author: {
                fid: 3,
                username: 'dwr',
                displayName: 'Dan Romero',
              },
              replies: { count: 1 },
              reactions: { count: 2 },
              recasts: { count: 3 },
            },
          },
        ],
      },
    }),
  },
});

const pages = {
  'cast.html': await handler.handle({
    method: 'GET',
    path: `/~/conversations/${CAST_HASH}`,
  }),
  'profile.html': await handler.handle({
    method: 'GET',
    path: '/~/profiles/3',
  }),
  'feed.html': await handler.handle({
    method: 'GET',
    path: '/feed',
  }),
  'look.html': await handler.handle({
    method: 'GET',
    path: `/look/${LOOK_ID}`,
  }),
};

// The RSS feeds, held apart from the pages: their answers are XML and
// refusals, and the checks they must pass are their own (the escaper, the
// refusal rules, the provider-chain label) — not the head-tag contract a
// page holds.
const feedAnswers = {
  'profile-feed.xml': await handler.handle({
    method: 'GET',
    path: '/~/profiles/3/rss',
  }),
  'profile-feed-replies.xml': await handler.handle({
    method: 'GET',
    path: '/~/profiles/3/rss?replies=1',
  }),
  'channel-feed.xml': await handler.handle({
    method: 'GET',
    path: '/~/channel/memes/rss',
  }),
  'profile-feed-miss.xml': await handler.handle({
    method: 'GET',
    path: '/~/profiles/4/rss',
  }),
};

mkdirSync(outDir, { recursive: true });

const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
const withoutLinkedData = (html) =>
  withoutComments(html).replace(
    /<script type="application\/(?:ld\+)?json"[^>]*>[\s\S]*?<\/script>/g,
    '',
  );
const count = (html, pattern) => (html.match(pattern) ?? []).length;

for (const [file, answer] of Object.entries(pages)) {
  const html = String(answer.body);
  writeFileSync(path.join(outDir, file), html);

  const kind = file.replace('.html', '');
  const isCast = kind === 'cast';
  const url =
    kind === 'cast'
      ? `${origin}/~/conversations/${CAST_HASH}`
      : kind === 'profile'
        ? `${origin}/~/profiles/3`
        : kind === 'feed'
          ? `${origin}/feed`
          : `${origin}/look/${LOOK_ID}`;
  const cardId =
    kind === 'cast'
      ? CAST_HASH
      : kind === 'profile'
        ? '3'
        : kind === 'feed'
          ? null
          : LOOK_ID;
  const image = cardId
    ? `${origin}/unfurl/cards/${kind}/${cardId}.png`
    : `${origin}/fiddy-share-card.png`;
  const miniAppImage = cardId
    ? `${origin}/unfurl/cards/${kind}/${cardId}.3x2.png`
    : `${origin}/fiddy-embed.png`;

  check(
    `${file} answers 200 with the page's own tags`,
    answer.status === 200 && answer.headers['x-unfurl'] === `page:${kind}`,
    answer.headers['x-unfurl'],
  );
  check(
    `${file} og:url is this page`,
    html.includes(`<meta property="og:url" content="${url}" />`),
  );
  check(
    `${file} is delivered exactly as built`,
    answer.headers['cache-control'] ===
      (kind === 'feed'
        ? 'public, max-age=60, no-transform'
        : 'public, max-age=300, no-transform'),
    answer.headers['cache-control'],
  );
  const miniApp = JSON.parse(
    /<meta\s+name="fc:miniapp"\s+content='([^']*)'/.exec(html)?.[1] ?? 'null',
  );
  check(
    `${file} mini-app card is this page's own 3:2 card`,
    miniApp?.imageUrl === miniAppImage &&
      miniApp?.button?.title === `Open this ${kind} in fiddy` &&
      miniApp?.button?.action?.url === url,
  );
  check(
    `${file} og:image is this page's card`,
    html.includes(`<meta property="og:image" content="${image}" />`),
  );
  check(
    `${file} states the card size`,
    html.includes('<meta property="og:image:width" content="1200" />') &&
      html.includes('<meta property="og:image:height" content="630" />'),
  );
  check(
    `${file} has one og:title, not two`,
    count(html, /<meta property="og:title"/g) === 1,
  );
  check(
    `${file} has one twitter:card, not two`,
    count(html, /<meta name="twitter:card"/g) === 1,
  );
  check(
    `${file} drops the site's front-door tags`,
    !html.includes('fiddy — a Farcaster client with an agent') &&
      (kind === 'feed' || !html.includes('/fiddy-share-card.png')),
  );
  check(
    `${file} keeps the shell body, adding only the profile crawler root`,
    kind === 'profile'
      ? html.includes(
          '<div id="root"><section class="fiddy-crawler-profile"',
        ) &&
          html.endsWith(shell.slice(shell.indexOf('<!-- shell-skeleton:start')))
      : kind === 'feed'
        ? html.includes(
            '<div id="root"><main class="fiddy-server-feed" data-fiddy-server-feed>',
          ) &&
          html.endsWith(
            shell.slice(shell.indexOf('<!-- shell-skeleton:start')),
          )
        : html.slice(html.indexOf('</head>')) ===
            shell.slice(shell.indexOf('</head>')),
  );
  check(
    `${file} keeps the entry chunk`,
    html.includes(
      shell.match(/<script type="module"[^>]*>/)?.[0] ?? 'NO-ENTRY',
    ),
  );
  check(
    `${file} has no inline executable script`,
    count(withoutLinkedData(html), /<script\b[^>]*>/gi) ===
      count(withoutLinkedData(shell), /<script\b[^>]*>/gi),
  );
  check(
    `${file} has no inline handler`,
    !/<([a-z][a-z0-9]*)\b[^>]*\son([a-z]+)\s*=/i.test(withoutComments(html)),
  );
  // The fixture's hostile values must survive as TEXT: escaped, and not able to
  // open a tag or close an attribute.
  if (isCast) {
    check(
      `${file} escapes the handle it quotes`,
      html.includes('&lt;d&gt;') && html.includes('&quot;'),
    );
    check(
      `${file} cannot be broken out of by a cast body`,
      !html.includes('<brackets>') && !/<script>alert/i.test(html),
    );
  }
  if (kind === 'feed') {
    const boot = JSON.parse(
      /<script type="application\/json" id="fiddy-public-feed-boot">([\s\S]*?)<\/script>/.exec(
        html,
      )?.[1] ?? 'null',
    );
    check(
      `${file} draws the seed cast and its own boot data`,
      html.includes('A root cast with &lt;brackets&gt; &amp; &quot;quotes&quot;') &&
        !html.includes('A root cast with <brackets>') &&
        boot?.result?.items?.[0]?.cast?.hash === FEED_HASH,
    );
    check(
      `${file} hides the loading skeleton and carries no inline script`,
      html.includes('#shell-skeleton{display:none}') &&
        count(withoutLinkedData(html), /<script\b[^>]*>/gi) ===
          count(withoutLinkedData(shell), /<script\b[^>]*>/gi),
    );
  }
  if (kind === 'profile') {
    const linkedData = JSON.parse(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
        html,
      )?.[1] ?? 'null',
    );
    check(
      `${file} has parseable ProfilePage JSON-LD with only facts read`,
      linkedData?.['@type'] === 'ProfilePage' &&
        linkedData?.url === url &&
        linkedData?.mainEntity?.name === 'Dan Romero' &&
        linkedData?.mainEntity?.alternateName === '@dwr' &&
        linkedData?.mainEntity?.identifier === '3' &&
        linkedData?.mainEntity?.description ===
          'Building <things> & "sharing" on Farcaster.' &&
        !('image' in linkedData.mainEntity) &&
        !('interactionStatistic' in linkedData.mainEntity),
    );
    check(
      `${file} has readable escaped profile and latest-post HTML`,
      html.includes('data-fiddy-crawler') &&
        html.includes('Latest posts') &&
        html.includes(
          'A latest post with &lt;brackets&gt; &amp; &quot;quotes&quot;',
        ) &&
        !html.includes('A latest post with <brackets>'),
    );
    check(
      `${file} keeps its canonical and share card unchanged`,
      html.includes(`<link rel="canonical" href="${url}" />`) &&
        html.includes(`<meta property="og:image" content="${image}" />`),
    );
    check(
      `${file} clears crawler HTML before the SPA mounts`,
      readFileSync(path.join(webRoot, 'src', 'index.tsx'), 'utf8').includes(
        '$root.replaceChildren()',
      ),
    );
  }
}

// THE FEEDS. Each feed answer is judged as XML and as a refusal: the escaper's
// hostile cast must survive as text, the read that answered must be named, a
// miss must be "No such feed." — and the profile page must advertise the feed
// in its head, because that is how a reader finds it.
{
  for (const [file, answer] of Object.entries(feedAnswers)) {
    writeFileSync(path.join(outDir, file), String(answer.body));
  }
  const profileFeed = feedAnswers['profile-feed.xml'];
  check(
    'profile-feed.xml answers 200 as RSS',
    profileFeed.status === 200 &&
      profileFeed.headers['content-type'] ===
        'application/rss+xml; charset=utf-8' &&
      profileFeed.headers['cache-control'] === 'public, max-age=600',
    `${profileFeed.headers['content-type']} / ${profileFeed.headers['cache-control']}`,
  );
  const feedXml = String(profileFeed.body);
  check(
    'profile-feed.xml is RSS 2.0 with the newest cast as an item',
    feedXml.includes('<?xml version="1.0" encoding="UTF-8"?>') &&
      feedXml.includes('<rss version="2.0"') &&
      feedXml.includes('<ttl>15</ttl>') &&
      (feedXml.match(/<item>/g) ?? []).length === 1 &&
      feedXml.includes('<pubDate>') &&
      feedXml.includes(
        `<link>${origin}/~/conversations/0x${'a'.repeat(40)}</link>`,
      ),
  );
  check(
    'profile-feed.xml escapes what XML cannot hold',
    feedXml.includes('Fish &amp; &lt;chips&gt;') &&
      !feedXml.includes('\u0001') &&
      !feedXml.includes('\ufffe') &&
      !feedXml.includes('\ud800'),
  );
  check(
    'profile-feed.xml names the server that answered the read',
    profileFeed.headers['x-fiddy-feed-read'] === fixtures.feed.source,
    profileFeed.headers['x-fiddy-feed-read'],
  );
  check(
    'profile-feed.xml self-links its own URL',
    feedXml.includes(
      `<atom:link href="${origin}/~/profiles/3/rss" rel="self" type="application/rss+xml" />`,
    ),
  );
  const withReplies = String(
    feedAnswers['profile-feed-replies.xml'].body,
  );
  check(
    'profile-feed-replies.xml adds the reply only when asked',
    (withReplies.match(/<item>/g) ?? []).length === 2,
  );
  const channelFeed = feedAnswers['channel-feed.xml'];
  check(
    'channel-feed.xml answers 200 with the channel cast',
    channelFeed.status === 200 &&
      String(channelFeed.body).includes('A cast in the channel'),
  );
  const miss = feedAnswers['profile-feed-miss.xml'];
  check(
    'profile-feed-miss.xml is a plain no-such-feed refusal',
    miss.status === 404 && String(miss.body) === 'No such feed.\n',
  );
  check(
    'profile.html advertises its feed in the head',
    String(pages['profile.html'].body).includes(
      `<link rel="alternate" type="application/rss+xml"`,
    ) &&
      String(pages['profile.html'].body).includes(`${origin}/~/profiles/3/rss`),
  );
}

// THE PICTURES. Each page's `og:image` names a card drawn for THAT page, so the
// card route is asked the way a crawler asks it and the answer is judged by the
// picture — not only by its size. The site card is 1200x630 too, so a size-only
// check passes on a service that answers the front door's card for every URL:
// measured 2026-10-22 (card t_1efd7e2e), the handler handed the renderer an
// unresolved promise, every card fell back to the site card, and the release
// gate (pixels, and this file's own card-free self-check) let it ship.
const cards = {};
for (const [kind, id] of [
  ['cast', CAST_HASH],
  ['profile', '3'],
  ['look', LOOK_ID],
]) {
  cards[kind] = await handler.handle({
    method: 'GET',
    path: `/unfurl/cards/${kind}/${id}.png`,
  });
  cards[`${kind}:3x2`] = await handler.handle({
    method: 'GET',
    path: `/unfurl/cards/${kind}/${id}.3x2.png`,
  });
}
const cardBytes = {};
for (const [kind, answer] of Object.entries(cards)) {
  cardBytes[kind] = answer.body;
  const cause = answer.headers['x-unfurl-note'];
  const baseKind = kind.split(':')[0];
  const expectedHeight = kind.endsWith(':3x2')
    ? MINI_APP_CARD_HEIGHT
    : CARD_HEIGHT;
  const ownCard =
    answer.status === 200 && answer.headers['x-unfurl'] === `card:${baseKind}`;
  check(
    `${kind} card is that page's own card`,
    ownCard,
    `${answer.status} ${answer.headers['x-unfurl']}`,
  );
  // MEASURED 2026-10-23 (card t_7413507e): this file refused a release twice on
  // the cards alone and named no cause — the handler had the renderer's error in
  // a cache note that nothing printed, so a starved renderer and a broken card
  // looked the same, and the release had to be re-cut blind. The reason now
  // travels on the answer, is printed HERE with the failing check, and is itself
  // checked: a card that falls back without saying why is a failure of this
  // service, not only of this build.
  if (!ownCard) {
    note(
      `  ${kind} card did not draw for this page — the handler's own reason:`,
    );
    note(
      `    ${cause ?? 'NONE RECORDED (the card route fell back without a reason)'}`,
    );
  }
  check(
    `${kind} card, when it does not draw, says why`,
    ownCard || Boolean(cause),
    ownCard || cause ? undefined : 'no x-unfurl-note on a fallback',
  );
  const size = pngSize(answer.body);
  check(
    `${kind} card is ${CARD_WIDTH}x${expectedHeight}`,
    size?.width === CARD_WIDTH && size?.height === expectedHeight,
    size ? `${size.width}x${size.height}` : 'not a PNG',
  );
  check(
    `${kind} card is not the site card`,
    Buffer.isBuffer(answer.body) && !answer.body.equals(siteCardBytes),
  );
  if (Buffer.isBuffer(answer.body)) {
    writeFileSync(
      path.join(outDir, `card-${kind.replace(':', '-')}.png`),
      answer.body,
    );
  }
}
for (const kind of ['cast', 'profile', 'look']) {
  check(
    `${kind} social and mini-app cards are different renders`,
    Buffer.isBuffer(cardBytes[kind]) &&
      Buffer.isBuffer(cardBytes[`${kind}:3x2`]) &&
      !cardBytes[kind].equals(cardBytes[`${kind}:3x2`]),
  );
}
check(
  'the three pages do not draw the same mini-app picture',
  Buffer.isBuffer(cardBytes['cast:3x2']) &&
    Buffer.isBuffer(cardBytes['profile:3x2']) &&
    Buffer.isBuffer(cardBytes['look:3x2']) &&
    !cardBytes['cast:3x2'].equals(cardBytes['profile:3x2']) &&
    !cardBytes['cast:3x2'].equals(cardBytes['look:3x2']) &&
    !cardBytes['profile:3x2'].equals(cardBytes['look:3x2']),
);

// The size the tags PROMISE, read out of a PNG the same way the service reads it.
const cardSize = pngSize(siteCardBytes);
check(
  'the site card is the size the per-page tags declare',
  cardSize?.width === CARD_WIDTH && cardSize?.height === CARD_HEIGHT,
  cardSize ? `${cardSize.width}x${cardSize.height}` : 'not a PNG',
);

note(
  `wrote ${Object.keys(pages).join(', ')}, both card sizes for every page to ${outDir}`,
);

if (failures.length > 0) {
  console.error('unfurl self-check failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  // WHAT TO DO NEXT, decided by the cause printed above the failure list. This
  // is the half this check was missing on 2026-10-23: it refused twice while the
  // build was fine, and told nobody which of these three it was, which cost a
  // card two release runs (t_7413507e).
  console.error(
    [
      '  what to do next, read off the cause above:',
      '  - the cause names the RENDERER (a timeout, a spawn error, "exited 1", a python that is not there): this machine, not this build.',
      `    Re-run this file by hand on the same stage — node ${selfPath} <stage>/base/apps/farcaster-web/dist/index.html /tmp/unfurl-self-check — and if it passes, RE-CUT the release.`,
      '    If it fails again, fix the renderer before shipping: python3 -c "import PIL.Image; print(PIL.__version__)".',
      "  - the cause names this PAGE'S FACTS (they could not be read): the build's reader answered nothing — fix the build (or the node it reads), not the release.",
      '  - anything else above (tags, shell bytes, inline script, a fallback that named no reason at all) is a property of the build: fix it before shipping.',
    ].join('\n'),
  );
  process.exit(1);
}
console.log(
  "  unfurl self-check ok: cast, profile, feed and look carry their tags, with cast/profile/look cards in both sizes, drawn over this build's own shell",
);
