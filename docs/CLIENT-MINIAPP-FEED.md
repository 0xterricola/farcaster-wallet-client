# A mini app in the feed: what actually renders, and the policy before anyone frames one

Follow-up to `t_bb61fcf8` (which audited the miniapp stack and deliberately claimed
nothing, having run no signed-in probe). This is the probe that card asked for,
plus the decision it deferred, plus the security policy it said had to be written
down **before** an iframe is wired.

Everything below is one of three things, and each line says which: **measured**
(a command ran and this is its output), **read** (this is what the committed
source says), or **not verified** (this is what follows from the other two, and
it has not been watched happen).

---

## 1. The fixture, found by reading, not by guessing

The card asked for a cast found **through the node** whose embed URL answers
`fc:miniapp`. Finding one is not a search a read node can do — a node keeps no
search index, which is one of the three endpoints this repo refuses in writing
(`snapchain/nodeApi/hostedRoutes.ts`). So it was read out:

1. Neynar's frame catalog listed 50 miniapp hosts (`GET /v2/farcaster/frame/catalog`).
2. Each host's author FID was read **on the node** (`GET /v1/castsByFid`), every
   embed URL those authors had posted was fetched and grepped for `fc:miniapp`.
   That gave 19 frame/miniapp casts — all **326–536 days old**. The catalog's
   authors are not the people posting miniapps this week.
3. So the search was inverted — recent casts embedding a known miniapp URL, each
   confirmed back **on the node** with `GET /v1/castById` before use.

The fixture, measured on `https://haatz.quilibrium.com`:

| | |
| --- | --- |
| cast | `0x8b3019a85bdbd946bab5f1105f62f7b926746ace`, fid 1062481, **top-level** (a reply never reaches a home feed), 4 hours old at the time of the run |
| text | `ask me anything for $0.05` |
| embed | `https://beep.works/send/cmi8mtgn500afiolnh4qelc53` |
| that page says | `<meta name="fc:miniapp" content='{"version":"1","imageUrl":".../opengraph-image","button":{"title":"Beep @topp-airdrop","action":{"type":"launch_miniapp", …}}}'>` |
| why this account | a home feed is the newest casts of **your follows**, so the probe signs in as fid 259576 (`ogmaro`, 151 follows), who follows the cast's author — `/v1/linksByTargetFid?target_fid=1062481` returned them. fid 3 (`dwr`) does not follow that author at all. |

A second, aged fixture was measured alongside (fid 17, `thefirm.biz/employees/17`,
a genuine `fc:miniapp` cast inside `dwr`'s follow graph, 326 days old). It is in
the follow graph but past the end of the feed the client renders — which is why
the assertions use the fresh one.

Probes: `apps/farcaster-web/scripts/verify-miniapp-in-feed.mjs` and
`scripts/probe-miniapp-embed-cors.mjs`.

```
SNAPCHAIN_HTTP_URL=https://<node> npx vite --port 5180
MINIAPP_SERVER=https://localhost:5180 node scripts/verify-miniapp-in-feed.mjs
```

## 2. What actually rendered

**Measured** (2026-10-21, signed in through a real SIWE sign-in — only the
`relay.farcaster.xyz` SIWF relay is stubbed, so the client reaches its real
signed-in shell):

| surface | what the client did |
| --- | --- |
| `/` — the default **Home** tab | refuses by name, in its own console: `getExploreFeed 501 - explore is a ranking, and ranking is an indexer's job`. The ranked feed is not served, and the column sits on a spinner until the reader presses **Following**. |
| `/` — the **Following** tab | **the fixture cast is in the column** — its text and its hash `0x8b3019a85b…` are both present in the feed's cast list, and every read behind it is the node's: `castsByFid` ×124, `linksByTargetFid` ×50, `linksByFid` ×78, `castsByParent`, `reactionsByCast`, `userDataByFid` — all `200` from `haatz.quilibrium.com`. |
| the fixture cast's card | **no mini-app card.** No image from `beep.works`, no `Beep @topp-airdrop` button, no launch affordance, no iframe. The card's own text box carries the URL and nothing more. |
| the cast page for both fixtures | the cast and its thread render (text present, replies read via `castsByParent`/`reactionsByCast`), and the **same absence**: no mini-app image, no mini-app button, no iframe. |
| the embed URL itself | the browser **tried** and was refused: `GET https://beep.works/send/… → failed`, with the client's own console line — `Access to fetch at 'https://beep.works/…' from origin 'https://localhost:5180' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.` The same refusal appears for `warpletbox.xyz/embed`, `brnd-v2-backend-production.up.railway.app/embeds/podium/…`, and a Neynar-hosted miniapp. |

**Measured separately** (curl, from a `https://fiddy.fun` origin): neither real
miniapp page sends `Access-Control-Allow-Origin` at all — `beep.works` and
`thefirm.biz` both answer `200 text/html` with no CORS header.

So the honest answer to "does an in-feed miniapp card render?" on the build this
was measured against is: **the cast reaches the feed, the card does not, and the
reason is that the page's descriptor cannot be read from the browser.**

### What this measurement does NOT establish

Two things moved while this probe ran, and both are visible in the record:

- **The tree moved under it.** Four commits landed on `main` at 22:54:31–32 —
  `5d90216` (mini apps from Neynar's catalog), `ecc6127` (a cast's mini app
  renders as its card), `9cd530e` (the card's data comes from Neynar's own read
  of the page), `55a4ddd` (the sibling card's own probe). The `run 3` feed
  measurement above is from that window; the desktop pass and the cast-page
  numbers are from `run 2`, minutes earlier, on the pre-landing tree.
- **The setup flow gained a step.** `/welcome/ready` now sits on a "Step 2 of 2"
  screen with a trial message to the agent before sign-in, and a probe that does
  not walk it measures an onboarding screen instead of the client (runs 5 and 6
  did exactly that, and say so in their own logs).

**Screenshots on disk** (in this card's attachments) are therefore labelled by
run, and they are weaker evidence than the log:

- `mobile-390-2-feed.png`, `desktop-1440-2-feed.png` — the feed column **loading**
  (Home tab, spinner, the "Let Fiddy post as you?" prompt). They are not the
  fixture in the column; the fixture's presence is the `run 3` log line, not a
  picture.
- `mobile-390-3-cast-detail.png`, `desktop-1440-3-cast-detail.png`,
  `*-4-aged-fixture-detail.png` — the two cast pages, rendered, with no mini-app
  card.
- A clean 390/1440 screenshot pair **on one fixed head, walking the current
  onboarding** is not claimed here and is the first thing the next run of this
  probe should produce.

## 3. The decision, in three parts

The card offered (a) render the descriptor from the cast's own embed metadata
client-side, (b) refuse it by name, (c) a node-backed equivalent for the three
refused endpoints. Measured against the evidence above:

### (a) — yes, but not "client-side" as written: the browser is not allowed to read these pages

The literal (a) — fetch the page in the browser and parse `fc:miniapp` — is
**measured impossible for real miniapps**: no `Access-Control-Allow-Origin`, so
the read is refused before any parsing happens. That is not a bug to fix; it is
what cross-origin means. Quilcast's unfurl is a **server module**
(`server/unfurl.mjs`) for exactly this reason — the meta-tag shapes in its
`src/compose.tsx` are the shapes this client already parses, from a server-side
unfurl.

The landed implementation (`src/snapchain/nodeApi/embedCards.ts`, `ecc6127` +
`9cd530e`) is the shape that works, and it is worth naming precisely because it
is **two sources, in order**:

1. **one bounded `GET` of the page** — `<head>` only, `text/html` only, 192 KB
   cap, 4 s per read, concurrency 3, `credentials: 'omit'`, cached per URL for
   the session and persisted for the next one. This is what answers for the
   pages that *do* allow a cross-origin read (many do).
2. **only when that read could not be made or said nothing about an app**, an
   index that has already read the page — this client's is Neynar's app catalog.

That is (a), honestly sourced: never a card invented from a hunch, never a
button the page did not declare, and never a guess when both sources are silent —
a read refused by CORS is *no answer*, and no answer leaves the embed as a link.

### (b) — kept for what neither source can answer

The refusal is not removed where it is still the truth, and the copy exists
already: the ranked **Home** feed answers `explore is a ranking, and ranking is
an indexer's job` (measured in the console), and a surface with no reader answers
`This page isn't on your node` / `no node-backed reader has been written for this
endpoint yet`. When no index key is configured, `embedCards` degrades to the
browser read alone and a CORS-refused page stays a plain link — silence, not an
empty card.

### (c) — no node equivalent exists for two of the three, and the third was never a refusal

- `GET /v1/favorite-frames` — **no node equivalent.** Favourites are hosted
  account state. On `main` this route is now `catalog`: answered from Neynar's
  index (`/v1/new-frameapps` likewise), because an app is a web page with an
  `fc:miniapp` tag, not a protocol message a node could index.
- `GET /v1/search-miniapps` — **no node equivalent**; a read node keeps no search
  index. Same `catalog` answer.
- `GET /v2/frame-blocklist` — **not a refusal at all** on `main`: it is `local`.
  Nothing is blocked locally, and a blocklist is local state; the truthful answer
  is "nothing is blocked", which is what a local answer is.

There is no route in the table for the descriptor the fork's own renderer asks
for (`GET /v1/frame`, `FarcasterApiClient.getFrameDetails`) — which is exactly
why the descriptor is now built from the page instead of requested from a server.

## 4. The policy, before anyone frames a miniapp

The card's own words: launching somebody else's miniapp inside our shell needs
its own origin, a sandboxed iframe and a CSP, and **the policy is written down
first**. Here it is, with what the shipped build does today next to it.

**Measured, the shipped client** (`curl -sSI https://fiddy.fun/`, 2026-10-21):

```
content-security-policy: … connect-src 'self' https: wss:; frame-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'
permissions-policy: camera=(), microphone=(), geolocation=()
```

**Read, the miniapp host** (`components/miniApp/MiniApp.tsx:1477` and the
`IFrameLoader` it uses):

```jsx
<IFrameLoader
  src={url}                                              // the app's own origin
  allow="microphone; camera; clipboard-write"
  sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
/>
```

The policy this client should hold, and the reasons:

1. **A miniapp's content never runs on our origin.** It is framed from its own
   origin, always. Nothing proxies a miniapp's HTML through `fiddy.fun` — the
   unfurl reads tags, it does not serve the app. This is the one rule that makes
   everything else survivable: on its own origin, the app has no access to our
   storage, our session or our app key.
2. **`sandbox` is the control, not a host allowlist.** `frame-src https:` is
   *required* — miniapp origins are arbitrary and cannot be enumerated — so the
   containment has to come from the sandbox. Keep `allow-forms allow-scripts
   allow-same-origin allow-popups`, and keep **not** adding
   `allow-popups-to-escape-sandbox`, `allow-top-navigation`, `allow-modals` or
   `allow-downloads`. `allow-same-origin` is safe here *only* because the frame is
   cross-origin; it must never be used to frame same-origin content.
3. **Camera and microphone are contradictory today, and it must be decided.**
   The iframe asks for `microphone; camera`, and the document's own
   `Permissions-Policy` denies both (`camera=(), microphone=()`). Per the
   Permissions-Policy spec a child frame cannot be granted a feature the parent
   denies, so **the miniapp's camera request cannot succeed on the shipped
   build**. *(Not verified in a browser — spec-derived from the two measured
   headers/attributes above.)* Decide one way and write it in the settings copy:
   either keep them denied and let the app be told "no", or delegate them with
   `allow=` **and** a visible, per-launch consent.
4. **Everything that touches identity is mediated and confirmed.** Wallet,
   signer, compose and notifications are shell capabilities reached over
   `postMessage`; every request is untrusted input, and none of it happens
   silently. The app key stays in the shell's own storage, is never handed to a
   miniapp, and its scopes stay the protocol minimum (the repo's `KEY_ADD` asks
   cast/reaction/link/user-data scopes for 90 sliding days — a miniapp must not be
   able to spend those on its own).
5. **The unfurl read is a privacy surface, and it is the honest price of (a).**
   Reading a page from the reader's browser tells that page's host the reader's
   IP and that they are looking at this cast. It is bounded and
   credential-free (`credentials: 'omit'`), and it should also carry
   `referrerPolicy: 'no-referrer'` — **not yet set, a one-line follow-up.**
   Where an index key exists, the index answer costs the reader nothing extra;
   where it does not, the browser read is what remains. Either way the settings
   should say that a link in your feed may be read for its card.

## 5. Scope, and what this card did not do

- **Not duplicated:** the build (catalog reads via Neynar, in-feed card, launch)
  is card `t_93fa5c59`'s, and it landed on `main` at 22:54 (`5d90216`,
  `ecc6127`, `9cd530e`, `55a4ddd`). This card measures it, decides the shape and
  writes the policy — it does not re-implement any of it.
- **Not touched:** `docs/CLIENT-PARITY.md`. Card `t_08e02638` owns that file and
  its miniapp row; the row is left exactly as it is (`re-measure`) so that card
  can be the one that closes it.
- **Not verified, and said so above:** a screenshot pair on one fixed head; the
  desktop pass on the landed tree; the Permissions-Policy deduction in a real
  browser; whether the launch itself succeeds end to end (the button that opens a
  miniapp window is not reachable until a card renders, and no card rendered in
  the window this probe had).