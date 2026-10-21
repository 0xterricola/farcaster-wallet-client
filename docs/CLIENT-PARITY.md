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

**What this needs before it can be implemented** (this is why it is not done in
this pass): either a pinning endpoint + credential from the operator, or a
go-ahead to add a small upload service on the VPS (that is a `services/` change,
explicitly out of scope for this card → it wants its own card). Until then the
honest state for both media buttons is a plain "media isn't ready yet" — not a
hosted-API error toast.

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
(5174 → `https://haatz.quilibrium.com`): one run, **12/12 checks**.

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
| **a reload keeps it** | 62 `200` node reads after `goto('/')`; 46 cast texts back on screen |
| no surface fell back to the fork's generic copy | 6 surfaces read; `Could not reach Farcaster` / `Error retrieving data` / `Something went wrong` nowhere on any of them |

Node routes the client used in that 12/12 run, all `200`, all at the node's own
origin: `linksByFid` (259), `linksByTargetFid` (227), `reactionsByCast` (164),
`castsByFid` (129), `userDataByFid` (90), `castsByParent` (70), `castById` (17),
`castsByMention` (8), `userNameProofByName` (7), `verificationsByFid` (7),
`reactionsByFid` (4), `info` (7). The only `/snapchain-api` traffic in the whole
run is the relay's health check, `GET 200 /v1/info` (41×).

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
that cannot fail.

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

Still open, deliberately: signing the Farcaster message (the app-key flow). That
is the only thing between this compose → Cast path and a real post.

## Fix order for Phase 2 (posting loop first)

1. Text posting: composer → `packages/farcaster-node-client.submitMessage`
   (gasless app-key path already built; no new signing path). Include the
   channel picker in the same write (`parent_url`), since "channels work" is a
   must-have and it is the same message.
2. Feed reads behind the adapter so a posted cast is visible again after reload
   (a write you cannot see is not a working loop).
3. Frame / mini-app embed rendering + launch in-feed, verified against a live
   frame URL, not just the mock.
4. Media: the seam above, once the storage decision has an owner.
5. Notifications and DMs: honest states (derive from the node where possible,
   hide the rest with a note) — do not fake either.

Overlap warning: another live card (`t_c9861884`) is rewiring the same surfaces
(reads, notifications, posting) through the same node client. Whoever lands
second rebases on the first; the parity table above is the shared map.

## Measurement hygiene (why some cells say "re-measure")

`/Users/lc/Projects/fiddy` is one working tree shared by several concurrent
cards. During this audit HEAD moved (`ad2193d` → `041c593`), a neighbour's
untracked modules appeared under `src/snapchain/nodeApi/`, and a neighbour's
in-flight edit to `WebFarcasterApiClientProvider.tsx` broke the running client
mid-audit — which is exactly the contamination recorded above.

Verdicts are only as good as a quiet tree. Before trusting a live verdict:
confirm `git status` shows nothing in flight, record `git rev-parse HEAD`, and
re-run the probe.