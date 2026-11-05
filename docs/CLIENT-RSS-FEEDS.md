# RSS feeds for every profile and channel

`https://fiddy.fun/~/profiles/<fid>/rss` is any account's casts as RSS 2.0, and
`https://fiddy.fun/~/channel/<id>/rss` is a channel's. `?replies=1` on a
profile adds its replies. Paste either into any feed reader: no account, no
app, no Neynar — the document is built by the same per-page server that already
draws the cast and profile pages (`docs/CLIENT-PER-PAGE-CARDS.md`), from the
node that answered.

## Source and attribution

The pattern is adapted from [backmeupplz/quilcast](https://github.com/backmeupplz/quilcast),
MIT license, commit
[`cdc4ec655888`](https://github.com/backmeupplz/quilcast/commit/cdc4ec655888)
(0.69.0 — "RSS feeds for every account and channel"), adopted 2026-11-06.

Taken from it wholesale, because these are the parts everyone gets wrong:

- the `xml()` escaper in `server/unfurl/feed.mjs`, which **first drops what XML
  1.0 cannot hold even when escaped** — most C0 controls, U+FFFE/U+FFFF, and
  half a surrogate pair — and only then escapes `& < > " '`;
- the hash test on every cast before it can become an `<item>`, the takedown
  filter, and the reply filter that shows replies only when asked;
- a real `<pubDate>` from the cast's own timestamp;
- the caching rules: a "no such feed" is remembered as long as a feed is, a
  failure is not remembered at all, and a reader that misses the cache is rate
  limited so pollers cannot stampede the node;
- the item shape: link and guid to the cast's own page, the title a 100-character
  cut of the text, the description the cast as HTML (line breaks kept) followed
  by its pictures, its links and `Quoted cast` for quote embeds.

Fiddy's own parts — our routes under `/~/`, the reads and the provider chain,
the node-first/host-fallback rules, the server-rendered pages that advertise the
feed, and the words — are ours. No upstream code is merged automatically.

## Where it lives

| File | What it is |
| --- | --- |
| `apps/farcaster-web/server/unfurl/feed.mjs` | the XML writer (the ported escaper, the item, the document) |
| `apps/farcaster-web/server/unfurl/reader.mjs` | `feed(fid, {replies})` and `channelFeed(key)`: the reads, the provider chain, the 10-minute cache |
| `apps/farcaster-web/server/unfurl/handler.mjs` | the two routes, their refusals, the in-process rules |
| `apps/farcaster-web/server/unfurl/pages.mjs` + `shellMeta.mjs` | the feed each profile page describes for itself, and the `<link rel="alternate">` in its head |
| `apps/farcaster-web/server/unfurl/profileCrawler.mjs` | the plain-words line and the link on the server-drawn profile page |

Nothing here touches the client bundle: the feeds are server-rendered XML, so
`pnpm --filter farcaster-web build` produces byte-identical output with or
without this feature, and `script-src 'self'` is unchanged. The visible
affordance is on the server-drawn profile page (which a crawler and a
JavaScript-disabled reader both see) and in the microsite tutorial — not a new
client button, because a button would be a new client chunk for a feature whose
whole point is not needing the app.

## The provider chain, and what "no feed" means

A feed is read through the same chain the client reads through, and the answer
names which link held it in `x-fiddy-feed-read`, in the server log, and in
`/unfurl/health`'s `feeds.lastSource`:

- `node:<origin>` — a Snapchain node (the configured `SNAPCHAIN_HTTP_URL`);
- `relay` — that node reached through this app's own origin (`/snapchain-api`);
- `farcaster-public` — `api.farcaster.xyz`, Farcaster's own public server, the
  same safety net the client's catalog keeps last.

Neynar is deliberately **not** in this chain: it stays the cast-hash → author
index it already is for cast pages. A feed is content, and content comes from a
node whenever a node can answer.

Refusals, which are the honest half of the feature:

| Situation | Answer |
| --- | --- |
| a nameless FID, an id nobody has, a taken-down account | `404` "No such feed." (remembered as long as a feed is) |
| a channel that returns no casts under either spelling | `404` "No such feed." (we cannot tell a new channel from a missing one, and we refuse to guess) |
| the node did not answer, and `farcaster-public` answered | `200`, the feed, labelled `farcaster-public` (top-level casts: the public server serves no replies) |
| the node did not answer with `?replies=1` | `503` "Try again in a minute." — a thinned feed would be a lie about the account |
| nothing answered | `503` "Try again in a minute." (never cached, so the next poll reads again) |
| one caller past the feed limit | `429` with `retry-after: 60` |

## Caching — and the one-hour rule

Feed content is cached **10 minutes** in process (quilcast's number), with
`ttl` 15 in the document and `cache-control: public, max-age=600`. A stampede
of requests therefore costs at most one node read per feed per ten minutes.

Anything we cache that can **point somewhere else** — a mini app manifest, a
link preview, a feed's own self-link — is held to **≤ 1 hour** server-side and
in the HTTP header, never a day. This is quilcast 0.70.1's lesson
(`a9c8c7cfc785`): they cached `/api/unfurl` for 24 hours, a mini app moved its
`fc:miniapp` address, and readers kept opening the old address for a day —
browsers had the old payload cached, so the fix also needed a cache-key bump on
the client (`/api/unfurl?v=2`), because a server-side purge cannot reach
browsers. Content (a cast's text, a profile's bio) may be held 10 minutes to 6
hours; **addresses** are the short-lived ones. If a client-side surface ever
caches a feed or a preview, version its key rather than relying on a purge.
The feed's 10 minutes sits comfortably inside that rule.

## Verification

Offline (no network — fixtures for the reads):

```bash
cd apps/farcaster-web
pnpm exec vitest run src/__tests__/rssFeeds.test.ts
node server/unfurl/self-check.mjs dist/index.html /tmp/fiddy-unfurl-check
```

The self-check writes `profile-feed.xml`, `profile-feed-replies.xml`,
`channel-feed.xml` and `profile-feed-miss.xml` beside the pages and judges the
escaper, the refusals and the read label; the release gate
(`scripts/release-client.sh`, step 3) refuses a build whose feeds do not hold.

Live, after a release:

```bash
curl -s https://fiddy.fun/~/profiles/3/rss | xmllint --noout - && echo well-formed
curl -s https://fiddy.fun/~/profiles/3/rss | head -c 400          # the newest cast, as the app draws it
curl -s -A 'Mozilla/5.0 (compatible; Feedfetcher)' https://fiddy.fun/~/profiles/3 \
  | grep -o '<link rel="alternate"[^>]*rss[^>]*>'                 # the page advertises its feed
curl -sI https://fiddy.fun/~/profiles/3/rss | grep -i cache-control  # public, max-age=600
curl -sI https://fiddy.fun/~/profiles/3/rss | grep -i x-fiddy-feed-read  # which server answered
```

A second fetch inside ten minutes does not reach the node: the service log
prints one read line per ten minutes per feed, with the server that held it.

## Not adopted

- **0.70.0, pin a cast to the top of a profile** (`58c6beb4b59c`) — not
  protocol: Hypersnap has channel pins and no profile pin, so quilcast stores it
  itself (a JSON file per FID written through a signature-verifying endpoint).
  That is per-account persistent user state plus a signature authority surface
  we would own forever, against Fiddy's stateless read relay.
- **App 1.1.0 to Play, App Store paused while 1.0.0 is in review**
  (`02e397eb8e7d`) — their Forgejo/Gradle release plumbing has no counterpart in
  our Expo path. The one keepable line (gate the iOS job on a repo variable so a
  release never replaces a submission Apple is still reviewing) belongs on the
  iOS card when that unblocks.
