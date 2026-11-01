# A cast URL and a profile URL, answered as themselves

fiddy.fun is a single-page app: nginx serves one static shell for every route,
and the client's per-page `og:` tags are written by JavaScript a crawler never
runs. So until this service existed, EVERY url on the host unfurled as the front
door — a shared cast or profile link said "fiddy — a Farcaster client with an
agent" and showed the site card. t_1e01f488 made that front door a real card
(`public/fiddy-share-card.png`); this is the other half.

## What answers what

`apps/farcaster-web/server/unfurl/` ships inside the client release (see
`CLIENT-RELEASE.md`) and runs as **fiddy-unfurl.service** on the host, loopback
`:3220`. nginx routes exactly two things to it
(`scripts/fiddy-unfurl.nginx.conf`):

| requested | answered with |
| --- | --- |
| `GET /~/conversations/<hash>` | the release's own shell, with that cast's `og:`/`twitter:` tags and a 1200×630 card drawn for it |
| `GET /~/profiles/<fid>` | the same, for that account: display name, handle, bio |
| `GET /unfurl/cards/{cast/<hash>,profile/<fid>,look/<id>}.png` | the social card itself, 1200×630, drawn on demand |
| `GET /unfurl/cards/{cast/<hash>,profile/<fid>,look/<id>}.3x2.png` | the same page drawn at 1200×800 for its mini-app card |
| `GET /unfurl/cast-author/<hash>` | `{"hash":…,"fid":…}` — the index the CLIENT reads (below) |
| `GET /unfurl/health` | what the service loaded: shell size, whether the site card is there, cache sizes |
| anything else under `/~/` | the shell, unchanged (the client owns the rest of that prefix) |

If the service is down, `error_page 502 503 504 = @fiddy_shell` serves the shell:
the page is still the app, exactly as before this existed. A page the service
cannot read (an unknown hash, a node that is not answering) is also the shell —
never a broken page, never an invented fact.

## Where the facts come from

* The **Snapchain node** (`/v1/castById`, `/v1/userDataByFid`) — the same reads
  the client makes, so a card shows what the app shows.
* **Neynar**, for one thing only: turning a cast HASH into its author's FID. A
  Snapchain node shards by FID, so `castById` needs the author as well as the
  hash, and a cast URL carries only the hash. The key is copied to
  `/etc/fiddy-unfurl/unfurl.env` (root-only) from the control plane's own
  environment by `scripts/install-fiddy-unfurl-service.sh`; without it a cast
  page still answers, as the shell, and says so in the log.

The node answers a cast as a MESSAGE — `/v1/castById` gives
`{"data":{"castAddBody":{"text":…}}}` — so the reader reads the text out of
`data.castAddBody` (`reader.mjs`). Reading it one level up finds nothing on the
real node while every fixture-shaped test still passes, and every cast page then
answers the shell; that is what shipped once (2026-10-22), and the reader test
against the node's own envelope is what pins it.

No follower counts, no avatars, no engagement: a card is a claim about a page,
and a claim has to come from somewhere.

## The card is drawn by Pillow, the site card by Playwright

`scripts/render-share-card.mjs` draws the SITE card with the reader's own Chrome,
which is right for a script a person runs and wrong for a service (the host has no
Chromium). `server/unfurl/render-card.py` draws the per-page cards with Python 3
and Pillow, which the host has, from the same language: ground `#161715`, ink
`#eef0e8`, dim `#9ba193`, chartreuse `#d4ff3f`, the same mascot still
(`fiddy-mark-poster.png`, out of the release's own web root) in the same corner.
Both files carry the fuller story in their headers.

A page's own card is checked by the PICTURE, not by its size: the site card is
1200×630 as well, so `handler.mjs` hands the renderer a resolved payload (a
promise there is `{}`, the renderer answers `unknown card kind: None`, and every
page silently falls back to the site card — measured live 2026-10-22) and both
`self-check.mjs` and the release's served gate require the note the service
sends: `x-unfurl: card:cast` / `card:profile`, and bytes that are not the site
card.

Emoji are dropped rather than drawn as empty boxes: the only emoji face on the
host is a colour bitmap font FreeType will not scale to a 54px line honestly.

## The client half: a shared link has to OPEN, not only unfurl

A card on the other end of the link is worth nothing if the page it names cannot
be read. `GET /~/conversations/<hash>` gives the reader a hash and nothing else,
and a node cannot address a cast by hash alone — so before this, opening a
hash-only link cold (a shared link IS a cold open) ended in the client's honest
refusal.

The same service answers that too: `GET /unfurl/cast-author/<hash>` is the
same-origin index the reader asks when it has never served the cast
(`src/snapchain/providers/castAuthorHandoff.ts`, wired into
`NodeBackedReads.readThread`). One same-origin read, no key in the page, no
cross-origin call (`connect-src 'self'`), and the node still does all the
reading — the index is an author lookup, not a copy of the network.

With that in place, sharing points at ourselves:
`getFiddyCastUrl` / `getFiddyProfileUrl` (`packages/farcaster-client-data/src/utils/FiddyUrlUtils.ts`)
are what the web share surfaces copy — `/~/conversations/<full hash>` and
`/~/profiles/<fid>`. The handle is deliberately NOT in the cast path: `/dwr/0xec0c8a22`
is the prefix route, which this client reads through `/v2/user-thread-casts` and
no Snapchain node can answer. `getCastURL` is untouched for quote casts, the
composer and the mobile app: those are canonical NETWORK links.

## Verifying it

Local, no network (and inside the release ritual, step 3):

    cd apps/farcaster-web
    node server/unfurl/self-check.mjs dist/index.html /tmp/unfurl-self-check

It renders cast, profile and look pages from the build with fixture data and
asserts each page's own tags exactly once, the site's tags gone, `</head>` onward
byte-identical, no inline script, and hostile values escaped. Every page's
`fc:miniapp` names its own `.3x2.png` card and a plain per-kind button, while
`og:image` and `twitter:image` stay 1200×630. The real renderer draws both sizes
for all three kinds; the gate requires 1200×800 for mini-app cards, distinct bytes
per page and size, and `no-transform` on HTML.

Live, the way a crawler asks:

    curl -s -A 'facebookexternalhit/1.1' https://fiddy.fun/~/profiles/3 | grep -o 'og:[a-z:]*" content="[^"]*"'
    curl -sI https://fiddy.fun/unfurl/cards/profile/3.png          # 200 image/png, x-unfurl: card:profile
    curl -s http://127.0.0.1:3220/unfurl/health                    # on the host

The `x-unfurl` header is the service saying which answer it gave — `page:cast`,
`page:profile`, `card:cast`, `card:profile`, or `shell`/`card:site` when it fell
back. A card's SIZE proves nothing (the site card is 1200×630 too); the note and
the bytes are what say the page got its own picture.

The release ritual's step 8 asks the origin for `/~/profiles/3` and requires that
page's own `og:url`, then fetches the card and requires a 1200×630 PNG THAT PAGE
DREW (`x-unfurl: card:profile`), so a release that breaks the per-page half does
not stay live. Step 3 renders both cards locally from the build, with the real
renderer, and refuses to ship if either is the site card.

## The link inside the app is the link a share copies

Sharing pointed at ourselves, but the app's *own* permalink did not.

Measured 2026-10-22 on the live build (`88071ae…`, node-backed, card
t_5068bb26), signed in on the feed with the stubbed SIWF relay: the timestamp
inside every cast in the feed is `a[href="/<handle>/<0x prefix>"]`, and opening
it —

    https://fiddy.fun/greg/0x8ae98f90

— answered the shell (`x-unfurl` absent, as designed for a non-unfurl route) and
a body reading

    This page isn't on your node
    No node-backed reader has been written for this endpoint yet.

`casts: 0`: no cast, no action row, no share button. Tapping it from the feed
landed on the same URL, and a cold open of that URL (a new tab, a bookmark, a
link somebody was sent) was the same refusal — at 390 and at 1440.

The read behind that route is `/v2/user-thread-casts`, and a Snapchain node
shards by FID: it cannot address a hash prefix at all. There is nothing to
implement there — a prefix is an indexer's lookup, and this client's data source
is a node.

So the decision this card owned, taken: **the app's own cast links point at the
full-hash route** — the page `getFiddyCastUrl` copies,
`/~/conversations/<full hash>`. That is the route a node answers
(`/v2/thread-casts`), it is reachable from what the feed already holds in
memory, and it makes the link inside the app and the link somebody else opens
the SAME page. The alternative — a node-backed reader for
`/v2/user-thread-casts` that resolves a prefix by paging the author's casts —
was rejected: it would still dead-end on a cold open (resolving depends on this
session having served that cast), it makes one click cost an unbounded walk
through an account's history, and it keeps alive a URL shape only an indexer can
serve.

What that touched (`apps/farcaster-web/src`):

| where | what it carried |
| --- | --- |
| `components/links/LinkToConversation.tsx` | the timestamp inside every cast — the full-hash route, always |
| `hooks/navigation/useNavigateToConversation.tsx` | tapping a cast's body, the notifications, the composer's “View”, a mini app's `viewCast` — its handle parameter is gone |
| `hooks/data/useOptimisticallyPrefetchConversation.ts` | the hover prefetch warms `/v2/thread-casts` instead of a read no page opens |
| `components/attachments/QuoteCast.tsx` | the quoted cast's overlay, and its hover prefetch |
| `components/notifications/CollectibleCast{Watch,}NotificationGroup.tsx` | the two notification paths that navigated by prefix |
| `scripts/measure-first-cast.mjs` | the “a cast is painted” detector names the route the feed now paints |

The app still SERVES the prefix route (`/:username/:castHashPrefix`,
`ConversationWithUsernamePage`) for links that come from somewhere else, and
answers them as it did. What changed is that this client hands nobody one — the
same rule `FiddyUrlUtils.ts` already wrote down for shares. The handle is not
lost: it is on the page, and on the card the page unfurls as.

Not fixed there, and measured — both are t_fb198c05, and both are decided:

* a conversation's recasts/quotes/likes tabs read their cast by prefix through
  `/v2/user-cast`, which a node does not answer either. **Decision, measured:
  the recasters and the likes are node reads after all** — `/v1/reactionsByCast`
  pages both kinds by the cast's own (author, hash) (a live node answered a
  terminal page of 186 recasts and like pages of 200), so those two tabs now
  point at `/~/conversations/<full hash>/{recasts,reactions}` and have real
  node-backed readers (`reads.ts`). Quotes are the indexer's job and stay
  refused, in words that say so. The prefix-cast read itself is now classified
  with a sentence that names why (`hostedRoutes.ts`), so a cold open of a
  prefix URL from somewhere else says what it needs instead of "no reader
  written yet".
* a quote of an *external* cast URL (`FauxQuoteCast`, out of a
  `warpcast.com/<handle>/<prefix>` embed) has only the prefix in its metadata,
  and its overlay now opens the `og.url` the embed itself carries — the one
  destination that can actually show the quoted cast — instead of this app's
  prefix route.

## Host state this needs (once, then it outlives any release)

`bash scripts/install-fiddy-unfurl-service.sh` installs the unit, the service
account, `/etc/fiddy-unfurl/unfurl.env` (the Neynar key, copied on the host and
never printed) and the two nginx locations, then restarts the service. The
release ships the CODE and restarts it; it does not touch nginx — the same
division the vhost already has.

## What is not done here

* The mobile app (`apps/farcaster-mobile`) still shares `farcaster.xyz` links.
* Only cast and profile pages are tagged; a channel, a list or a mini app URL
  still unfurls as the front door.