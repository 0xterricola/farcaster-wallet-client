# Client parity: the fork's surfaces vs where Fiddy is (Phase 1 audit)

Status: **first pass, 2026-10-20**, measured against commit `041c593` (branch
`main`); the second half of the day's work — what is node-backed *now* — is in
"What is node-backed now" at the end of this file (card `t_c9861884`). This document exists so the client work has one honest map: what the
fork can do, what our shell can do today, and what each gap costs.

Read the "How this was measured" section before trusting any verdict in the
table — the shared working tree had three other cards in flight while this was
written, and one window of measurements is contaminated (it is marked).

## How this was measured

Two lenses, both signed in with a real Sign In With Farcaster session: a
throwaway key signs a real SIWE message (`viem/accounts` +
`viem/siwe`), only the SIWF relay is stubbed, so the app's own verifier accepts
the sign-in for real (`@fiddy`, `fid 4242`).

| Lens | Backend | What it proves |
| --- | --- | --- |
| **real** | `https://farcaster.xyz/~api` (what a third-party session actually has) | what a Fiddy user can reach today, and the exact refusal they get |
| **mock** | the fork's own dev backend on `localhost:8080` (`localStorage['farcasterApi.local']='true'`) | that the client's surfaces and code paths still exist and run, independent of the hosted API's gate |

Probe (Playwright, headless Chrome, `ignoreHTTPSErrors` on the context):
sign in → visit each surface → record landed path, rendered copy, every request
the surface made to the data layer and its status, and whether an error
boundary came up. Screenshots and raw JSON for both lenses are attached to
kanban card `t_08e02638`.

**Measurement window A** (~16:52 IST, `041c593`, tree dirty only with another
card's `snapchain/nodeEnv.ts` + its test) — this is the window the table's
verdicts come from.

**Measurement window B** (~17:05 IST, same commit, tree now also dirty with
another card's `contexts/WebFarcasterApiClientProvider.tsx`) — in this window
the client itself throws: the home feed and `/~/compose` both render the shell's
error boundary, console cause
`TypeError: Cannot read properties of undefined (reading 'length') at TrendingTopics (src/components/rightSidebar/TrendingTopics.tsx:149)`.
Window B is **not** a property of the commit; it is a neighbour's in-flight edit
in the shared tree. Any verdict measured in window B is void and has to be
re-measured on a quiet tree.

## 2026-10-21 refresh — what landed after this audit, and what is left

This document was written a day before the work it maps. Everything below it is
the audit as measured at `041c593`; this section is the current state, so nobody
acts on a row that has since changed. Each line names the card that landed it
and the evidence that card left.

| Surface (as audited below) | Now | Evidence |
| --- | --- | --- |
| Composer — text posting | **works.** The submit is a message this device signs and a server carries; the refusal the audit recorded is gone. | card `t_aa93f0c5` (writes through providers, `88cf2ba`), released to fiddy.fun by `t_49d63304`; `~/snapchain/nodeApi/nodeWrites.ts` |
| Reactions, follows, recasts | **work**, on the same path — a write is confirmed against the server's own state before any success is reported | `t_aa93f0c5` |
| Composer — image | **works**, through our own media host rather than Warpcast's | card `t_54ee6c54`: `~/snapchain/nodeApi/mediaUpload.ts` sends `POST /v1/generate-image-upload-url` to `POST /api/fiddy/media`; that card's probe 14/14 and a live check of the deployed route (POST 201, GET 200 immutable, cross-site 403, bad name 404) |
| Composer — video | **still not ours.** The picker's video path is Warpcast's pipeline: `hostedRoutes.ts` classifies `/v1/prepare-video-upload`, `/v1/upload-video-with-tus` and `/v1/uploaded-video` as `hosted` (read at `13d504e` for this refresh). "Post with video" is therefore open, and its fix is a media-host change — its own card, filed from this one. | the routing table at `13d504e` |
| Mini apps — catalogue, and embeds in the feed | **being wired now** by card `t_93fa5c59` (running while this was written): readers via Neynar, `fc:miniapp` meta for the card in the feed. Not this card's to redo, and not a gap this card may call done. | that card's own body |
| Reads — feed, cast detail, profile, channel, notifications | **node-backed and verified** | `t_c9861884`, `scripts/verify-node-backed-client.mjs` 12/12 |
| Advanced screen / the Fiddy command line | **was a dead route**: the page rendered one word and the settings list had no entry for it, so reaching it meant typing its address. It now carries the CLI entry — the four `bin/fiddy` lines, each copyable — and the list links it. The command-line agentic extras next to it are named as not-here-yet. | this card: `scripts/verify-advanced-cli.mjs` 11/11 at 390px and 1440px, `~/pages/settingsAdvanced/__tests__/settingsAdvanced.test.tsx` 8/8 |

Still open, honestly: **video** (above); the **miniapp catalogue and embeds**
(`t_93fa5c59`); **search, the channel directory, direct messages, audio rooms,
wallet surfaces and notification grouping** (hosted-API products with no node
equivalent — see "Still not node-backed"); and **a cast that reaches the real
network**, which needs the operator's test account and a node that merges —
neither a probe's nor this card's to do.

## The two things the audit found, before the table

1. **A real third-party session cannot reach a single authed surface.** With a
   genuine device-only SIWF session, all 13 surfaces probed (`/`,
   `/~/following`, `/~/apps/trending`, `/~/profiles/4242`, `/~/notifications`,
   `/~/channel/cast`, `/~/inbox`, `/miniapps`, `/~/settings`, `/~/bookmarks`,
   `/~/channels`, `/~/agent`, `/~/compose`) render the honest device-only
   landing ("Farcaster signed this device in…") and make **zero** data calls.
   The client is not broken — it is gated, correctly, by the absence of the
   hosted API's server session. That gate is the whole gap.
2. **The fork's surfaces are intact.** With the fork's own dev backend the full
   Fiddy shell renders on every one of those routes, issuing 14–22 requests
   each, all `200`. So parity work is *rewiring the data layer*, not rebuilding
   UI.

## Surfaces, where their data comes from, and status

"Status" is at `041c593`, measured in window A: **gated** = third-party session
sees the device-only landing; **renders (mock)** = the surface's own code path
runs against a working backend.

| Surface | Route | Where its data comes from | Status | What parity needs |
| --- | --- | --- | --- | --- |
| Home feed | `/` | **node-backed**: `POST /v2/feed-items` → `linksByFid` + `castsByFid` off your follow graph | **node-backed, verified** (real casts on screen) | done — see "What is node-backed now" |
| Following feed | `/~/following` | hosted `/v2/feed` + `/v2/following` | gated; renders (mock) | same node feed, follow-graph filtered |
| Trending / discover | `/~/apps/trending` | hosted feed + `rightSidebar/TrendingTopics.tsx` | gated; renders (mock) — window B threw here | re-measure; trending has no node endpoint today |
| Cast detail + threads | `/~/conversations/:castHash` | **node-backed**: `castById` for the ancestors + `castsByParent` for the replies | **node-backed, verified** | done |
| Composer (text) | `/~/compose` | `mutation/useCreateCast.ts` → `POST /v2/casts` (`FarcasterApiClient.ts:…createCast`) | gated in window A; **error boundary in window B** | route on `submitMessage` (`packages/farcaster-node-client`) — the app-key path that already exists |
| Composer — image | composer picker | `MediaComposerPicker` → `useFetchImageUploadUrl` → `POST /v1/generate-image-upload-url` (`FarcasterApiClient.ts:5019`), then upload to the returned host | **unusable** — endpoint is 401 for a third party (measured, see media section) | a media seam of our own; see "Media upload" |
| Composer — video | composer picker | `useCastComposerEmbeds.ts:1253` → `POST /v1/upload-video-with-tus` (`FarcasterApiClient.ts:11719`) | **unusable** — same hosted gate | same media seam |
| Quote / recast / reply | cast actions, `QuoteCastComposer` | hosted `/v2/casts` with embed | gated | node writes (`submitMessage`) |
| Reactions (like / recast) | cast actions | `useCreateCastLike.ts` → hosted `/v2/cast-reactions`, `/v2/cast-recasters` | gated | node reactions (already in the node client) |
| Follows | profile / lists | `useCreateFollow.ts` → hosted `/v2/follows`, `/v2/followers` | gated | node follows (already in the node client) |
| Profiles — view | `/~/profiles/:fid` | **node-backed**: `userDataByFid` + counted `linksByFid`/`linksByTargetFid` | **node-backed, verified** | done |
| Profiles — edit | settings/profile | hosted user update | gated | node `userData` writes (`submitMessage`) |
| Notifications | `/~/notifications` | **node-backed (derived)**: mentions (`castsByMention`), reactions (`reactionsByCast`/`reactionsByFid`) and follows (`linksByTargetFid`) to your FID; the group drill-down (`/v2/notification-group`) still 501s | **node-backed, verified**; group view is an honest gap | derive done; grouping needs an indexer |
| Channels — browse | `/~/channels` | hosted `/v2/all-channels`, `/v2/highlighted-channels` | gated; renders (mock) | node channel reads; browse needs a channel list source |
| Channels — page / post into | `/~/channel/:channelKey` | **node-backed for casts**: `castsByParent?url=…` (the channel's parent URL is computable from its key); name/image/viewer state are the hosted directory's and read neutral | **node-backed, verified** (casts) | directory needs an indexer |
| Channels — join / create | channel settings | `useCreateChannel.ts`, join-by-code hooks | gated | `farcaster-node-client` as-is |
| Search | `/~/search*`, top bar | hosted `searchUsers`, `searchChannels`, `searchMiniApps` | gated | NEEDS-NODE (no search endpoint on the node) |
| Direct messages | `/~/inbox`, `/~/inbox/:conversationId` | hosted direct-cast endpoints | **hidden with an honest note**: the rail's entry is replaced by `Direct Casts · soon` (and the endpoint 501s for a direct URL) | done — see "What is node-backed now" |
| Mini apps — browse | `/miniapps` | hosted app catalog (`/v2/…mini-app…`) | gated; renders (mock, 21 calls) | NEEDS-NODE for the catalog; launching is client-side |
| Mini app / frame rendering in feed | cast embeds, `components/frames/`, `components/iframes/` | embed URL in the cast itself | renders (mock) — **unverified with a live frame** | verify once the feed is node-backed |
| Wallet surfaces | `/~/settings/preferred-wallet`, mint, pay-user | wallet-connect + hosted wallet endpoints | gated; `Reown Config` fetch failed `403` in console (project id unset) | operator key + a decision on whether Fiddy ships a wallet at all |
| Settings | `/~/settings`, `/settings/developer-tools`, `/settings/node` | local + hosted prefs | gated (hosted parts) | mostly local already; `/settings/node` is ours |
| Agent extras (ours) | `/~/agent`, `/~/agent/brains`, `/~/agent/apps` | local shell state | **works signed-out and device-only** (verified by `t_891e6995`) | the two sheets are the licensed exception on the device-only landing |

Also logged but not a Fiddy surface: `ph.neynar.com/array/REPLACE_ME/config.js`
404 (an unset third-party analytics placeholder) and a `ws://localhost:8080/stream`
handshake failure against the mock backend — both cosmetic noise from the fork,
both worth removing before a judge sees the console.

## Media upload: the fork's path is unusable, and the choice that follows

Measured, not assumed:

```
$ curl -sS -o /dev/null -w '%{http_code}' -X POST \
    https://farcaster.xyz/~api/v1/generate-image-upload-url \
    -H 'content-type: application/json' -d '{}'
401
{"errors":[{"message":"Authentication required"}]}
```

So image upload dies at the first hop (`/v1/generate-image-upload-url` needs
Warpcast's own session) and video upload dies at `/v1/upload-video-with-tus`
for the same reason. The upload URL the picker receives is also handed out by
that same gated endpoint, so there is nothing to fall back to client-side.

**Decision (recorded here as the card requires):**

* Chosen: **direct-to-IPFS through an operator-configured pinning endpoint**,
  called by a small `uploadMedia()` seam on our side. The browser sends the file
  to our endpoint; the endpoint pins it (or otherwise stores it) and returns a
  public `https` URL; the cast embed references that URL. This keeps any pinning
  credential **server-side** — the alternative, pinning straight from the
  browser, would ship a write-scoped key to every visitor.
* Rejected: doing nothing and leaving the buttons live (that is a fake success
  path: the user picks an image, watches it upload, and the cast silently can't
  carry it).
* Rejected: hosting media *on the node*. A Snapchain node has no media endpoint —
  `packages/farcaster-node-client` writes `submitMessage` and reads `/v1/*`, and
  the cast embed is just a URL. Media must be pinned somewhere public.

**What this needed before it could be implemented** — and what happened instead,
because the answer arrived: the operator's go-ahead went to a small upload
service of our own (`services/`, which this card's scope excludes → that work
went its own way as card `t_54ee6c54`). **It is built and live.** Our media host
takes the bytes (`POST /api/fiddy/media`), types them by their own magic bytes,
caps them at 25 MB, stores them under a content-hash name and answers with the
public URL the cast embeds; `~/snapchain/nodeApi/mediaUpload.ts` is the client
half. Image posting therefore works end to end (that card's probe 14/14, plus a
live check of the deployed route). Video did **not** come along with it: the
picker's video path is Warpcast's pipeline and is classified `hosted` in
`hostedRoutes.ts` at `13d504e`, so "post with video" is still open and is filed
as its own card.

## What is node-backed now (card `t_c9861884`, measured same day)

The signed-in client reads from **your Snapchain node**, not from
`farcaster.xyz`: one `fetch` seam in `~/snapchain/nodeApi/nodeBackedFetch`
classifies every hosted-API request and answers it from the node, locally, or
with an honest 501 naming whose job it is. Pages, hooks and return shapes are
untouched.

**The gate moved with it.** `useDeviceOnlySession` used to send every local
SIWF sign-in to the "nothing can serve this session" landing. The landing's own
premise — that every surface is a `farcaster.xyz` read or write — is no longer
true, so with the adapter on *and a node named* the session runs the real
client. Adapter-without-node still lands on the honest landing.

**Which node answered (measured 2026-10-20, at `d467d28` + the two honesty fixes
described below).** The dev server this ran against is `https://localhost:5174`,
started with `SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com` — a live public
read node, read through the dev server's own `/snapchain-api` relay. The node
this repo's `apps/farcaster-web/.env.local` names,
`http://34.101.47.167:3381`, did **not** answer while this was measured: ICMP and
TCP to 3381/3383 time out from this Mac **and** from the VPS (both measured). So
`https://localhost:5173` (which reads `.env.local`) currently has no node behind
its relay, and the run below is what proves the adapter against a real node. When
that node is back, the same probe run against `5173` needs no env override.

**Verified end-to-end, not by construction.** `scripts/verify-node-backed-client.mjs`
(Playwright, headless Chrome, `ignoreHTTPSErrors`) signs in with a real SIWE
message signed by a throwaway key — only the SIWF relay is stubbed, and it names
`fid 3` (`dwr`) so the feed has a real follow graph — then drives the client
against a live public read node and **attributes every read to the machine that
answered it**. Re-pointed at the provider chain and re-measured 2026-10-21
(5174 → `https://haatz.quilibrium.com`): the table below is the shape of a 12/12
run, and **the one check that flips is the reload** — fifteen live-node runs of
the same command on the same two revisions were measured that day and three of
them failed it. "The one row that flips, measured" below has the numbers and the
cause; the 12/12 numbers in the table are real, they are just not the only
outcome.

| Check | Evidence (2026-10-21, 5174 → the live public node) |
| --- | --- |
| a completed sign-in lands in the client | `clicked="Go social — sign in with Farcaster"`, `path=/` — not the setup, not the device-only landing |
| cast text from bytes a server returned is on screen | 23 of 544 cast texts the node returned were found in the page column; the check names the server the first one came from |
| the feed's cast reads came from a server this client can read from | 156 of 156 cast reads answered `200` by `https://haatz.quilibrium.com` (the page's own fetch log ×78, the network the probe watched ×78 — two lenses, see below) |
| the feed is not an error page | no refusal on the feed itself, even when another surface in the same column carries one |
| the rail is honest about DMs | `data-fiddy="dms-unavailable"` **and** `Direct Casts · soon` in the text |
| a cast detail opens and shows its thread | the thread's own cast text (a cast a node returned) on screen; 12 `200` reads of `castsByParent`/`castById` at the node's own origin |
| a profile renders and names the account | 7 `200` reads, mostly `userDataByFid`; the page column names `dwr` |
| a channel renders and answers — never an empty success | 16 `200` reads; the column renders the channel's members and casts |
| notifications are derived from a node read | 16 `200` reads on the notifications surface (`castsByMention`, `reactionsByFid`, `linksByTargetFid`) |
| notifications are not an error page | the surface renders; no refusal, no fork copy |
| **a reload keeps it** | `62` `200` node reads after `goto('/')`; `46` cast texts back on screen — **the row that flips**: 3 of the 15 runs measured on 2026-10-21 failed it, and when it fails the column carries the client's own panel while the node answers every read (see "The one row that flips, measured") |
| no surface fell back to the fork's generic copy | 6 surfaces read; `Could not reach Farcaster` / `Error retrieving data` / `Something went wrong` nowhere on any of them |

Node routes the client used in that 12/12 run, all `200`, all at the node's own
origin: `linksByFid` (259), `linksByTargetFid` (227), `reactionsByCast` (164),
`castsByFid` (129), `userDataByFid` (90), `castsByParent` (70), `castById` (17),
`castsByMention` (8), `userNameProofByName` (7), `verificationsByFid` (7),
`reactionsByFid` (4), `info` (7). The only `/snapchain-api` traffic in the whole
run is the relay's health check, `GET 200 /v1/info` (41×).

**The one row that flips, measured.** Re-pointing the probe did not make the
reload check stable, and this document does not claim it did. Fifteen live-node
runs of the same command on the same two revisions were measured on 2026-10-21 —
thirteen by this card, two by the review that asked for this pass (evidence: the
card's attachments — `post-runs.log` and the per-run logs next to it):

* **twelve 12/12.** The reload row read `62` `200` node reads and `46` cast texts
  back on screen on every one of them, so the table's numbers are real; they are
  just not the only outcome. One of these ran the previous revision, before this
  pass's detail change; the rest ran this one.
* **one 9/12** (this card, `post-run-live-7.log`): the reload check plus the
  profile and channel checks, both of which read nothing. The page carried the
  rail's own panel — `Cmd+K Explore didn't load from your node Farcaster's own
  public server did not answer: Failed to fetch.` — while the node answered
  elsewhere in the same run (the notifications surface's 27 reads, all `200`).
  The reload detail read `×1 (200) | casts back on screen: 0`.
* **two 11/12** (the review's runs of the previous revision, both with only the
  reload check red): the column carried the client's own refusal, unchanged for
  the whole 60s budget and 75s past the `goto('/')` —
  `Home isn't on your node — POST /v2/feed-items is a write, and Farcaster's own
  public server does not take writes from this client.` — while the node answered
  every read it was handed (770 in one run, all `200`).

So the reload row is a flake, and the flake is the client — not the node, and not
a deadline: the seam refuses `POST /v2/feed-items` as a write whenever the
provider in use is `farcaster-public`, and a cold load that starts there does not
recover. That is card `t_f7c34463` (measured, with the code pointers) and it is
not this probe's to fix. What this probe now does is say so: a failing reload
prints the column's own words (the panel or the fork's copy, or the column when
it says nothing — with a refusal that only the rail carries reported as the
rail's), the read that did not answer `200`, and, in the report, every read the
reload document itself made. The check stays red on purpose — no re-open and no
tolerance, because the panel outlived the budget, so the red is a real condition
and `visitSurface`'s one-re-open policy would hide the very thing "a reload keeps
it" exists to catch.

**What changed, and why the 11/11 revision was measuring itself (2026-10-21, card
`t_30c38e9a`).** The commits `703e2da`, `af8d9f8`, `131ae87`, `de0269e` (the
provider chain in `~/snapchain/providers`) moved *where a read comes from* into
the client: its fetch seam answers from whichever server the failover engine
measured as live, so a read leaves the page as `https://<node>/v1/castsByFid…`
(the provider's own origin) or as `<this origin>/snapchain-api/…` (the build's
relay). The old revision demanded the relay path, so it failed 7 of 11 checks on
a client that was working — re-measured on the same tree (`6dcfe29`) it is 4/11,
and the only relay traffic left is `GET 200 /v1/info`. The probe now asserts what
still matters — real text from the server it read from, each surface rendering, a
reload keeping it, no generic copy, no empty success — and reports which server
answered each read instead of dictating a route: `node:<origin>`, `this build's
relay`, the named providers (`api.farcaster.xyz` = farcaster-public,
`api.neynar.com` = neynar), and a bucket of its own for origins that are not read
servers at all (`api.web3modal.org`, `pulse.walletconnect.org`, `ph.neynar.com` —
the wallet kit and an unset analytics placeholder, which an earlier pass of this
re-point had named "the node at …").

Three further things were measured while re-pointing, and are honoured by the
probe rather than hidden: **a refused relay is not a failure** — the same probe
against 5175 (relay → refused port `127.0.0.1:3399`) is **12/12**, because the
chain moves to the public node and every read is attributed to it; **a
whole-document predicate is satisfied by the rail** — its `Notifications` item
once made the notifications check measure the wrong surface, so every surface
claim is now made against the page column (`main`); and **the probe fails on a
client whose reads really fail** — one run on the live relay with the machine at
load average ~230 came back **9/12** with the feed column carrying the client's
own sentence, "Farcaster's own public server stopped answering — and nothing
better is answering either, so nothing moved". That is a real failure, reported
as one, and the reason the budgets are as generous as they are.

**Fail-capable.** `NODE_BACKED_ISOLATE=1` puts every other server the chain could
fall back to out of reach, leaving the build's own route as the only one; run
against a black-holed node (5176 → `http://34.101.47.167:3381`, aborted at the
browser) the same probe is **4/12, exit 1**: every read the page attempted threw,
no cast text reached the column, and only the four checks that need no read
passed (the sign-in, the DM note, notifications without a refusal panel, no
generic copy). A green run therefore means reads happened — it is not a check
that cannot fail. Its reload check red reads, in full, the shape this pass
fixed — the surface's own state and the read that failed, not just the node:
`no castsByFid read answered by a node after the reload | casts back on screen: 0
| the client's own panel: "… didn't load from your node Your node did not answer
this read: Could not reach the Snapchain node at https://haatz.quilibrium.com
(Failed to fetch)." | 1 feed read did not answer 200: THREW GET /v1/castsByFid
(the node at https://haatz.quilibrium.com)`.

### The 501s are the honest part

These endpoints answer `501` with a sentence saying whose job they are — and,
since the fixes below, the **screens** say it too, where the surface sits, never
an empty success:

* `explore-feed`, `feeds` (feed summaries), `get-trending-topics` — ranking is
  an indexer's job;
* `highlighted-channels`, `user-following-channels`, `channel-streaks` — the
  channel directory is Warpcast's;
* `direct-cast-inbox`, `notification-group` — direct messages and notification
  grouping are not on a read node;
* `search-casts`/`search-*` — a read node keeps no search index;
* `audio-rooms`, `favorite-frames`, `user-thread-casts`, `analytics-events`.

### A refused surface used to hide the sentence (measured; fixed here)

That list was true of the *adapter*. It was **not** true of the screens: driven
with a real session against a live node
(`scripts/verify-node-unanswered-surfaces.mjs`, 2026-10-20), four surfaces were
measured **before** the fix:

| Surface | What it showed | Why that was wrong |
| --- | --- | --- |
| search (`/~/search`) | `This page couldn't load` / `Error retrieving data. Please try again.` / `Try again` | the adapter's sentence was thrown away, and the retry was offered for a read no retry can fix |
| channel directory (`/~/channels`) | the same generic copy | same |
| explore / trending (`/~/apps/trending`) | the same generic copy | same |
| direct messages (`/~/inbox`) | a normal-looking inbox reading `No direct casts` | an empty success: the node cannot serve direct messages at all, so this reads as "you have none" |

Cause: `getErrorDescription` (`~/utils/errorUtils`) maps every
`FarcasterApiError` to "Error retrieving data. Please try again." for the
page-column boundary, and the DM route rendered the fork's empty inbox whatever
the data source was.

What changed — same probe, four surfaces, **15/15 checks**, no page errors:

* `~/snapchain/nodeApi/nodeCannotAnswer.ts` recognises the adapter's own two
  refusals on a `HandledFetchError` and hands back its sentence: `501` (your node
  cannot answer this read) and `502` (your node did not answer). The `501` rule is
  safe because a `501` in this client has only ever been the adapter's own answer
  — the hosted API's failures appear in the same console as `400/401/403/404`
  (measured), and if a `501` ever came from the API instead, showing the API's own
  sentence is still the honest thing to do.
* `~/components/snapchain/NodeCannotAnswerPanel` is the one panel for it
  (`data-fiddy="node-cannot-answer"`): the sentence as written, and a retry
  **only** where a retry could change the outcome (the node was down) — never for
  a read the node cannot serve.
* `ShellSectionErrorBoundary` renders that panel for a refused region, so the
  page column says why with the shell standing around it.
* `DirectCastsInboxPage` renders the same panel on the DM route when the node is
  the data source (and the dev mock API is not), reading the reason off
  `classifyHostedRequest` so the page cannot drift from the adapter's answer.

The unit tests for the boundary's three branches (generic failure, node cannot
answer, node did not answer) are in
`src/components/session/__tests__/deviceOnlySession.test.tsx`.

### A node that never answers: every layer now has a deadline (measured, fixed)

Was, at `d0eede6`: with the node `.env.local` names black-holed
(`http://34.101.47.167:3381`, unreachable from this Mac), the signed-in client on
`https://localhost:5173` ran for 75 seconds and the **feed column showed no
casts, no error and no message** — just the feed's header and tabs. The rail's
Explore region did show its honest refusal (that read is a `501`, answered
locally), so the shell was alive; the feed's own read simply never came back.

The root cause was sharper than "nothing times out":

* the fork's client **does** time every endpoint out itself
  (`DEFAULT_TIMEOUT_FEED_ITEMS` = 5 s) and passes the `AbortSignal` in, but
  `nodeBackedFetch` never read `init.signal`, so the abort did nothing: the read
  was not cancelled, no request failed, and the client's promise never settled —
  the column stayed in its loading state for as long as the page was open. The
  client's deadline was dead code on this path;
* the dev server's `/snapchain-api` relay had no deadline at all, and http-proxy
  waits on a TCP connect that a black-holed address never completes. MEASURED:
  a bare in-page read came back **75.008 s** later with `500` and an **empty
  body** — which is also why the `502` sentence never appeared.

Both layers now have a deadline, and the numbers come from measurement, not
taste:

| Measurement | Value |
| --- | --- |
| healthy node, per-read latency (feed fan-out shape: 60 authors × `pageSize=10`, concurrency 12, warm) | p50 **258 ms**, p90 759 ms, p95 **773 ms**, p99 986 ms, max **986 ms** |
| the same fan-out, wall clock | **1.99 s** (cold first read 819 ms) |
| black-holed node, relay **before** | **75.008 s**, `500`, empty body |
| black-holed node, relay **after** (`curl` at `/snapchain-api`) | **8.07 s**, `504`, `{"errors":[{"message":"Your node did not answer this read: the relay waited up to 8s for http://34.101.47.167:3381 and gave up (no reply within 8000ms)."}]}` |
| a *refused* port through the same relay | `504` in **35 ms**, same envelope, `(connect ECONNREFUSED …)` |

What changed:

* `nodeBackedFetch`: `NODE_READ_TIMEOUT_MS = 10_000` is the per-read deadline
  (~10× the worst healthy read), armed around every node fetch and handed to the
  node client as its own `timeoutMs`; `NodeReadTimeoutError` /
  `isNodeReadTimeout` / `nodeDidNotAnswerWithin(ms)` name the failure in words;
  and `raceClientDeadline` **honours the caller's own `init.signal`**, so the
  client's 5 s feed deadline answers `502 "Your node did not answer this read
  within 5 s."` instead of never settling.
* the relay (`vite.config.js`, `nodeRelayProxy`, on both `server.proxy` and
  `preview.proxy`): an 8 s per-upstream-request deadline whose error hook answers
  the hosted API's error envelope with `504` and that sentence. Three relays were
  tried and measured, in this order: no timeout (75 s hang) → `proxyTimeout` +
  `timeout` (bounded at +8.4 s but the socket is destroyed with **no response at
  all**, `curl` status 000) → `proxyReq.setTimeout` (never fires while the TCP
  connect hangs) → a plain timer around the upstream request (chosen). 8 s sits
  below the adapter's 10 s on purpose, so the relay's failure is what the read
  reports.
* the feed column: `FullScreenErrorBoundary` → `ShellSectionErrorBoundary
  label="Home"`, so the adapter's sentence lands **in the column** with a retry
  instead of the generic full-screen "Error retrieving data" /
  "Could not reach Farcaster" copy. `NodeCannotAnswerPanel`'s heading now says
  which failure it is: `502` → "… didn't load from your node" (with Try again),
  `501` → "… isn't on your node".
* `reads.ts`: the feed's fan-out counts the reads that **answered**. MEASURED
  (relay pointed at a refused port): every per-author read came back `500`, every
  one was swallowed by the per-account `catch`, and the feed answered `200` with
  zero items — indistinguishable from a genuinely quiet follow graph. When *no*
  account read succeeded, the read now throws instead of answering an empty page.

Fail-capable probe: `scripts/verify-dead-node-feed.mjs` (sign-in via the same
real-SIWE stub as its siblings, then the feed column's own words). **4/4** with
the relay pointed at the black-holed node and every other server blocked, the
column carrying the adapter's sentence and a retry; at the pre-fix state the
column stays blank for the whole budget (measured twice: the 75 s run above, and
a 30 s run of this probe whose only answer on the page was the rail's `501`).

Two things this round had to learn the hard way, both recorded in the probe:

* a check that accepts *any* `[data-fiddy="node-cannot-answer"]` panel on the page
  passes on the **rail**, not the feed (it did) — the assertion is scoped to
  `main`;
* reads taken while the client is swapping routes throw
  `Execution context was destroyed, most likely because of a navigation` and kill
  the probe mid-run — a probe defect that hid the checks it was about to make.

And one thing that changed under this card, worth knowing before anyone re-runs
it: the provider chain (`~/snapchain/providers`) now answers the same setup by
**moving to a server that answers** — measured without isolation, the column
filled with live casts and the status pill said which server it moved to. A dead
node with a live backup is not a blank feed; the sentence above is what the user
gets when nothing else can answer, which is why the probe blocks the other
servers.

### Two measured defects this card had to fix first

1. **`fetch` needs its receiver.** Passing the bare `fetch` into the node client
   produced `TypeError: Failed to execute 'fetch' on 'Window': Illegal
   invocation`, so *every* read the adapter answered came back `502` while the
   node was perfectly healthy. The adapter now binds it, and a unit test drives a
   fake that refuses any other receiver.
2. **A 501 in the rail took the page down.** `ClankerSpotlight` (explore) threw
   through to the route boundary, so the feed column became "Error retrieving
   data". Each fetched rail widget now has its own
   `ShellSectionErrorBoundary`, and the honest refusal lands in the rail.

### Latency, measured and bounded

The first working version read 200 followed accounts × 25 casts at concurrency
5 — **~55s** to answer the feed's first page (measured in the browser, one run:
`POST /v2/feed-items` at +5.8s, 25 items at +60.4s). The fan-out is now 60
accounts × 10 casts at concurrency 12: same shape, roughly an order of magnitude
less wall clock. A large follow graph still means the feed is a bounded slice of
it, not "everyone you follow" — worth saying out loud before a judge asks.

### Still not node-backed

Media upload (see "Media upload" above), the channel directory, search, mini-app
catalogue, audio rooms, wallet surfaces, notification grouping and DMs — all
hosted-API products with no node equivalent today.

### Cast drafts and the cast submit (card `t_44070b80`, measured 2026-10-21)

Measured end to end in headless Chrome with the node-backed client on a live
public read node and no hosted session (`scripts/verify-cast-submit.mjs`), by
typing text and pressing **Cast**:

| Step | Endpoint | Verdict |
| --- | --- | --- |
| pre-publish draft write | `POST /v2/draft-caststorms` | **local** — this device's own state, 200, kept in `localStorage` per FID (`localDrafts.ts`). It was a 501, retried twice, in front of every Cast attempt. |
| drafts list / discard | `GET /v2/draft-caststorms`, `POST\|GET\|DELETE /v2/draft-casts` | **local** — the same store; the Drafts tab and resume button read it back. |
| the submit itself | `POST /v2/casts` | **hosted, refused by name.** The submit *does* reach it (the earlier audit's \"never reaches `/v2/casts`\" was a probe under-measurement, corrected in that probe's comments). It answers 501 with the classification's sentence — sending a cast means signing it with an app key, and this device has none — and the composer renders it: \"The cast didn't post. Sending a cast means signing it with an app key … nothing was signed and nothing was sent.\" No success UI. |

Still open at that measurement, and now half-closed: the pass the refusal asks
for. As of `88cf2ba` the submit is still refused in those words — and the pass
is now offered from the shell, one press after sign-in, instead of only on
Advanced. See the next section; signing a cast and reading it back is the write
layer's work, measured by that work's own probes, not here.

### The one-time "let Fiddy post as you" step (card `t_c9861884`, measured 2026-10-21)

*The sentence that was true and nowhere useful.* The refusal above sends the
reader to Advanced → their setup → "Issue app key" — two taps away from the
composer they were standing in, in the middle of writing a post. MEASURED in the
live client, signed in, before this change: that is the only path to a pass, and
the reader meets it as a failure rather than as a step.

*What it is now.* `~/components/session/PostForYouStep`, mounted once in the
shell (`AuthedLayout`), is the offer: "Let Fiddy post as you?" — what Fiddy may
do with it (post, reply, like and follow), what approving costs (one tap in
their own Farcaster app, on their phone — no fee, nothing to type), and the
honest limit ("your account, its key and its recovery phrase stay where they
are"), with "Set it up" and "Not now". It renders nothing unless all of these
hold: the session is a device one, the node adapter is on, a server is named,
the account is known, and this device holds no pass for it yet. The device
remembers how it was answered (`fiddy_post_for_you_<fid>_answer`, `not-now` or
`approved`; the released build's `…_said_not_now` is still read so a device
that already answered is not asked again), so the offer is made once. The
answer record is what an approval needs: the pass is held by Fiddy's service,
not on this device, so nothing here would tell the card about it after a
reload.

*"Set it up" raises the phone approval.* MEASURED (2026-10-22, before this
card's change): the offer's own button opened `SeedPhraseWarningModal` — the
blocking "⚠️ Security warning … use a TEST account … enter your recovery
phrase" screen — so a reader could meet a phrase prompt two taps after signing
in, even though the posting flow itself had stopped doing that. "Set it up" now
mounts `ConnectSheet` (the same sheet `/connect-farcaster` shows and
`SignerApprovalGate` reuses) with `autoStart` and `onApproved`: one service
request, the link, a code to scan, and a screen that notices the approval by
itself. On approval the offer ends and is remembered; closing the sheet
without approving leaves the offer standing (nothing is remembered, and "Not
now" is still the way to say no).

*The phrase step is still reachable, and still named for who it is for.* Behind
a collapsed disclosure on the card — "Advanced: test account recovery phrase
(developers only)", invisible until it is opened — the door opens the SAME
screen Advanced ships (`SeedPhraseWarningModal`), unchanged and loaded lazily:
checkbox acknowledgement, test account only, confirm disabled without it,
phrase cleared on close. Nothing about how the pass is issued changed — the
one signing path (`issueAppKey` from the node client), the pass stored
browser-local per FID, the phrase never stored. A second signing path is what
the card forbids, so this is only a new door onto the existing one — and it is
a developer's door with its name on it, not a normal reader's first screen.

| Check (probe `scripts/verify-post-for-you.mjs`, **8/8**, exit 0) | Evidence |
| --- | --- |
| a completed sign-in lands in the client | `clicked="Go social — sign in with Farcaster"`, path `/`, `main` present, not the device-only landing |
| the offer is made right after it, in the shell | `[data-fiddy="post-for-you"]` on screen at `/`, without navigating anywhere |
| plain words, two buttons, the honest limit | "Set it up" and "Not now", "stay where they are", "one tap in your own Farcaster app"; no `gasless\|signer\|scope\|ttl\|KEY_ADD\|app key\|nonce\|EIP-712` anywhere on the card |
| "Set it up" raises the phone approval by itself, and the phrase step is only behind its own disclosure | one `POST /api/fiddy/connect` (stubbed — a real one mints a paid signer request), the waiting sheet with its QR and the approval link, no `#mnemonic` and no warning anywhere on that path; the card back after the sheet is closed; disclosure collapsed with the developer label, the phrase door invisible until opened, then the blocking warning — confirm disabled with nothing typed **and** with a phrase typed, enabled only after the acknowledgement |
| nothing is signed or sent by the probe | no `/v1/submitMessage` left the page |
| the same session still reads a node | 72 cast reads `200` at `https://haatz.quilibrium.com` (not this app) |
| "Not now" ends it, and the device remembers | gone after the click; still gone after a reload of `/` |
| approving in the reader's own Farcaster app ends it too, and is remembered | the stub flipped to `connected` (the approval itself happens in their app); the card ends with "Done — Fiddy can post for you now.", the sheet is gone, and the offer is still gone after a reload of `/` — on a second, fresh device |

Unit level — `~/components/session/__tests__/postForYou.test.tsx`, 14 tests (part
of the session directory's suites, all green): the decision's every negative
case (a session a server can serve, the adapter off, no server named, no
account yet, a pass already present, already said not now, already approved,
the storage reads still pending); "Set it up" raising the approval with a link
and no phrase field; closing the sheet leaving the offer standing; the approval
ending the offer with nothing typed and no key made on this device, and no
offer after the done line; the phrase step behind a collapsed disclosure that
still blocks until acknowledged; and the setup itself against a fake node —
exactly one custody-signed KEY_ADD submitted, the stored pass's public half
equal to the key in the submitted bytes, the account's next nonce recorded, and
no phrase written to storage.

*What this does not do.* It does not make a cast post on its own: signing the
cast and reading the state back is the write layer, which this card did not
touch. It does not delete the composer's refusal copy, which still names
Advanced; the offer makes that sentence rare rather than wrong.

*Measurement hygiene for the live numbers above.* Three runs, each recorded with
its log and screenshots on card `t_c9861884`:

* **acceptance 12/12** — `scripts/verify-node-backed-client.mjs`, on a dev server
  started minutes before the run (`:5201` → `https://haatz.quilibrium.com`), with
  the app at `4262059` (which carries this change and the write layer's). Every
  read attributed to that node: the feed's 152 cast reads (two lenses), a cast
  detail's 12 thread reads, a profile's 3, a channel's 12, notifications' 22, and
  the reload's 62 with 46 casts back on screen.
* **the offer 7/7** — `scripts/verify-post-for-you.mjs`, same server and revision.
* **the earlier 11/12, and the probe fix it caused** (`b09f8c0`): on the first
  run of that revision the only red was the reload row —
  *"no castsByFid read answered by a node after the reload | casts back on screen:
  69"* — with the feed full and the client's own pill naming **Neynar** as the
  server answering. The provider ladder picks a named provider first when the
  build holds a key for it, and this dev `.env.local` carries
  `VITE_NEYNAR_API_KEY`, so the row was demanding a node from a chain that had
  answered from a provider — the same "measuring its own expectation" family the
  re-point above fixed. It now counts a read server (node, relay, or a named
  provider), says which one answered, and keeps the clause that fails when the
  client is broken: cast text on screen, which a client showing "Home isn't on
  your node" cannot produce.

The acceptance run before this card's change (12/12 at `d00b7a7`, the write
layer's edits still in flight) and the offer run at `88cf2ba` are on the same card
rather than restated here as one number.

## Fix order for Phase 2 (posting loop first) — status at 2026-10-21

The order below was written as a plan. It is kept because the *order* was right;
each item now carries where it landed, so this section cannot read as work still
to do.

1. **Text posting — done.** Composer → `submitMessage`, no new signing path.
   `~/snapchain/nodeApi/nodeWrites.ts` builds and signs the message and confirms
   it against the server's own state (card `t_aa93f0c5`). The channel picker's
   write rides the same message (`parent_url`), so "post into a channel" is not
   a separate path.
2. **Feed reads behind the adapter — done** (card `t_c9861884`): a posted cast
   is visible again after a reload, measured — see "What is node-backed now".
3. **Frame / mini-app embeds in the feed — in flight elsewhere** (card
   `t_93fa5c59`): readers via Neynar, `fc:miniapp` meta for the card. This card
   does not duplicate it, and does not call it done.
4. **Media — half done.** Images work through our own host (card
   `t_54ee6c54`); video is still Warpcast's pipeline and has its own card (see
   the refresh section).
5. **Notifications and DMs — done, honestly** (cards `t_c9861884` and
   `t_963a9287`): notifications are derived from node reads, and direct messages
   are hidden behind a plain "Direct Casts · soon" rather than an empty inbox.

The overlap warning that used to sit here is spent: `t_c9861884` landed, and
this card worked around the shared tree rather than through it — see "How this
card avoided the shared tree, and what it cost" below.

## Measurement hygiene (why some cells say "re-measure")

`/Users/lc/Projects/fiddy` is one working tree shared by several concurrent
cards. During this audit HEAD moved (`ad2193d` → `041c593`), a neighbour's
untracked modules appeared under `src/snapchain/nodeApi/`, and a neighbour's
in-flight edit to `WebFarcasterApiClientProvider.tsx` broke the running client
mid-audit — which is exactly the contamination recorded above.

Verdicts are only as good as a quiet tree. Before trusting a live verdict:
confirm `git status` shows nothing in flight, record `git rev-parse HEAD`, and
re-run the probe.
## Phase 3: the command line's door, and what is not built (this card, 2026-10-21)

The agentic half of Fiddy starts on the command line, and until this card the
product said so nowhere: `/~/settings/advanced` rendered the single word
"Advanced", and the settings list had no entry for it (both read off the source
at `13d504e`; the route itself has existed since the fork). A door nothing
points at is not a door.

What is there now:

* `~/pages/settingsAdvanced/SettingsAdvancedPage` — the Advanced screen: what
  the Fiddy command is, the four subcommands `bin/fiddy` actually has
  (`provision`, `node up`, `client up`, `doctor`), each with the plain-words
  reason to run it and a copy control; the two walkthrough links
  (`fiddy.fun/client` and the deploy page beside it); a link to the setup screen
  and to the agent surface that works today.
* `~/layouts/SettingsNav` gains the entry — that is what makes the screen
  reachable at all.
* `~/lib/advancedCli.ts` — the copy and the command list, out of the page so the
  words can be asserted on their own.
* The agentic extras the command line is *for* ("chat with your agent from the
  terminal", "let your agent post from a script") are named with a `soon` note
  and **no control**: there is nothing behind one, and this card builds no agent
  backend.

Verified rather than asserted — `apps/farcaster-web/scripts/verify-advanced-cli.mjs`,
**11/11**, signed in with a real SIWE session against a dev server started from
this card's own worktree: the entry visible in the settings list at 390px and in
the rail at 1440px, the page opening from it, the four commands on screen, the
copy control reporting "Copied" with the clipboard read back holding
`fiddy provision`, no protocol vocabulary in the column (the card's jargon ban),
the two agentic rows carrying their note with zero buttons under them, no
horizontal overflow at either width, and zero uncaught page errors. Unit level:
`~/pages/settingsAdvanced/__tests__/settingsAdvanced.test.tsx`, 8/8 — the
commands, the plain words, the not-here-yet rows, and both branches of the copy
control (a copy that happened, and a browser that refuses one, which is reported
rather than claimed).

One probe defect was found and fixed on the way, worth knowing before re-running
it: waiting for "some nav" on `/~/settings` matched the shell's left rail and
measured the page before the settings list had rendered — **4/11 on a working
client**. The wait is now on the entry itself, and the failure branch prints what
the list actually showed.

## How this card avoided the shared tree, and what it cost

`/Users/lc/Projects/fiddy` is one working tree shared by every Fiddy card. This
card was blocked twice for exactly that (see its comments), and on the third
attempt files were still in flight, so the work was done in an isolated
`git worktree` at a fixed revision (`13d504e`,
`~/.hermes/kanban/workspaces/t_08e02638/wt`, branch `t_08e02638-parity`) — the
way the neighbouring cards and their reviewers already work. Nothing was written
to the shared tree, no `git stash` was cycled over another card's work, and the
probe ran against a dev server started from the worktree, so every number above
belongs to a known revision.

The cost is real, and it is why this is written down: the work lands as a
fast-forward of `13d504e` rather than as commits in the middle of the shared
tree's own history, and every parity verdict in this document is for `13d504e`
plus this diff — not for whatever `main` had become by the time anyone reads it.
Re-run the probes before trusting a verdict.
