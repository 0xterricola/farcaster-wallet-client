# "This page isn't on your node" — the 501 sweep, and what it changed

USER-REPORTED (2026-10-22): *"This page isn't on your node — No node-backed
reader has been written for this endpoint yet"* was appearing on settings
surfaces and all over the app.

That sentence is the node adapter's **fallback**: the honest answer for an
endpoint no table names, shown in place instead of an empty list that would read
as "there is nothing here". It is written for a programmer, not for a reader —
and it was appearing on pages a person reaches deliberately.

This is what found it, what was wired, and what still refuses (and why).

## The probe

    SWEEP_SERVER=https://localhost:5173 node scripts/verify-node-501-sweep.mjs
    SWEEP_SERVER=https://localhost:5173 node scripts/verify-node-501-sweep.mjs --record

`verify-node-501-sweep.mjs` walks the app's own route table
(`src/constants/routes.ts`), opens **every signed-in surface at 390 and 1440**
with a real seeded session (a real SIWF message; the relay is stubbed, the reads
are not), and records per surface:

- every request the adapter classified, with its kind and status;
- every refusal sentence the surface was actually shown;
- whether the *shrug* sentence is on screen, whether the page crashed, whether
  the shell degraded.

It exits non-zero when **any** surface shows the shrug, when a surface that must
render shows a refusal panel instead, or when a page throws. The verdicts it
compares against live in `scripts/node-501-sweep.expectations.json`, which is
checked in and reviewable: this is the regression gate for the bug.

MEASURED (the first full run, 2026-10-22, 78 surfaces × 2 widths = 156 visits):
**48 surfaces showed the shrug.**

A second measurement came out of that run: the probe's per-surface request list
was empty for many visits. The marker it sliced from was read off the *previous*
page (`window.__nodeBackedRequests.length`), and a page reload builds a new array
— so a surface whose predecessor had logged more requests reported none. The
panels were still read correctly off the DOM, which is why the verdicts held
while the refusal lists did not. Fixed: the marker is now 0 and the log is
emptied before each navigation.

## What was wired

Every endpoint the sweep touched is now **named by a table** — 80 distinct
endpoints across the 156 visits, zero left to the fallback (asserted by
classification, and by the probe's own exit code).

Served from a node, where the node holds the data (each row MEASURED against a
live public read node, 2026-10-22, and implemented in `nodeApi/reads.ts`):

| route | source |
| --- | --- |
| `GET /v2/profile-casts`, `GET /v2/casts` | `castsByFid` — the same read as `/v2/user-casts`, under the names the profile and casts-and-replies tabs ask with |
| `GET /v2/followers` | `linksByTargetFid?link_type=follow` — the edge's author is the follower |
| `GET /v2/following` | `linksByFid?link_type=follow` — the edge's target is the account followed |
| `GET /v2/cast-likes`, `GET /v2/cast-recasters` | `reactionsByCast?reaction_type=Like\|Recast` |
| `GET /v2/get-blocked-users` | `linksByFid?link_type=block`, each blocked account read as a profile |
| `GET /v2/storage-utilization` | `storageLimitsByFid` |
| `GET /v2/user-cast`, `GET /v2/user-thread-casts` | one account's cast, resolved from its own `castsByFid` pages by hash prefix (bounded), then its thread |

`/v2/following` also carries `leastInteractedWith`, which is an affinity ranking
neither the node nor this client computes: it is returned **empty** rather than
invented, and no surface is shown a number nobody measured.

Served from an **index**, where a node is honestly the wrong machine — classified
`index` in the routing table and answered by Neynar's index with the reader's own
key (each MEASURED 200, 2026-10-22):

| route | index read | envelope |
| --- | --- | --- |
| `GET /v2/cast-quotes` | `/v2/farcaster/cast/quotes` | `result.quotes` |
| `GET /v2/user-liked-casts` | `/v2/farcaster/reactions/user?type=likes` | `result.casts` |
| `GET /v2/search-users` | `/v2/farcaster/user/search` | `result.users` |
| `GET /v2/search-channels` | `/v2/farcaster/channel/search` | `result.channels` |

A channel from the index carries **no claim about the reader**: `viewerContext`
is neutral (`following: false`, `isMember: false`), because Neynar's lucky row
knows nothing about your membership and a drawn join button would promise a write
nobody made.

An `index` route with no index on the reader's list is now refused with the
routing table's own sentence about the read (`providerFetch.ts`) rather than
whichever provider is live explaining what *it* covers.

And the fallback itself, for the endpoints no source exists for, is no longer a
note to a programmer:

> Fiddy can't read `/v2/…` yet: it isn't something your node keeps, and no reader
> here answers it. Nothing was faked — this part of the app has no data source
> yet.

with its node-side twin for a route a node *could* carry but this build has no
reader for:

> Fiddy can't read `/v2/…` yet: this read has no reader wired up in this app.
> Nothing was faked and nothing was sent — your account is untouched.

## The second pass (2026-10-22): the assertion was blind

A third measurement — the same probe, over the route table as it stands now,
**156 surfaces × 2 widths = 312 visits** — found **13 visits still showing the
fallback**, from six endpoints. They had been wearing it since the first pass:
the probe asserted **only the old sentence**
(`/no node-backed reader has been written/i`), and the fix had introduced two new
ones while leaving `works` verdicts in the checked-in file behind it. So a run
could print `shrug sentences on screen: 0` over a page that shrugged in new
words. The probe now asserts **every flavour** of the fallback — including the
two the fix itself introduced — and `--record` writes what the run **saw** rather
than keeping a verdict the run just disproved.

| endpoint still shrugging | surfaces |
| --- | --- |
| `GET /v2/followers-you-know` | `/dwr/followers-you-know`, `/~/profiles/3/followers-you-know` |
| `GET /v2/channel-followers-you-know` | `/~/channel/<key>/followers-you-know` |
| `GET /v2/notification-group` | `/~/notifications/mini-apps`, `/frames`, `/channel-role-invites` |
| `GET /v2/rent-storage-offerings` | `/~/settings/storage` |
| `GET /v2/starter-packs/suggested` | `/~/suggested-starter-packs` |
| `GET /v2/profile-snap-casts` | the snaps tab of a profile |

Wired from the node in this pass (implementations in `nodeApi/reads.ts`, each a
read the node really makes):

| route | source | why it is the node's read |
| --- | --- | --- |
| `GET /v2/followers-you-know` | `linksByFid?link_type=follow` ∩ `linksByTargetFid?link_type=follow` | both halves are the node's own follow edges — the first pass's "a node keeps nothing for this" row was wrong about the node |
| `GET /v2/notification-group` | the same mention/reply/reaction/follow messages the notifications tab is built from, at the group's own depth | the group ids the tab draws are this client's own (`mentions:<fid>`, `replies:<fid>`, `reactions:<fid>`, `follows:<fid>`) |
| `GET /v2/profile-snap-casts` | `castsByFid`, kept to the casts whose parent is the snaps channel | a snap is an ordinary cast with that parent. MEASURED: the network spells the channel `https://warpcast.com/~/channel/snaps`; the `farcaster.xyz` spelling answers empty, so the URL is written down rather than derived |

Bounded, and said out loud: the intersection is taken over **one page** from each
side (`pageSizeFor`), so `totalCount` is the number of rows in the answer,
counted — never a total inferred from a page. A group a node cannot hold (frame
and mini-app notifications, channel role invites) is refused in words naming the
missing service, and a group page opened with no group id says which id it needs.

Reclassified, with the measurement that settled it:
`GET /v2/channel-followers-you-know` leaves the node table entirely. MEASURED
(2026-10-22, a live public read node): a read node's link state carries only
`follow` and `block` **between FIDs**, so channel membership is not node state at
all — it is an index's roster, and no reader here joins it with your follow
graph. The first pass's table row claimed otherwise.

Six more endpoints the second pass watched were classified for the first time:
`/v2/rent-storage-offerings`, `/v2/starter-packs/suggested`, `/v1/audio-room`,
`/v1/domain-manifest`, `PATCH /v2/user-preferences`, `POST /v1/analytics-events`.

Two real bugs came out of the run, both invisible to the old probe's log:

- a Neynar **quote cast embed** was passed through raw (`object:
  'user_dehydrated'`, an author with no `profile`). The row that draws a quote
  reads the author's level, so it threw and the whole surface fell to "This page
  couldn't load". It is now mapped like every other cast
  (`apiQuoteCastFromNeynar`, `providers/neynarMap.ts`).
- `DevelopersPage`'s `PATCH /v2/user-preferences` had no rejection handler, so
  the adapter's honest refusal arrived as an unhandled rejection on every visit.

## What still refuses, and why

These surfaces show a panel naming what is missing. None of them show the shrug.

**Warpcast's own account state** (no protocol message, no public equivalent):
`/~/bookmarks`, `/~/saved` (saved casts), `/~/settings/muted-keywords`,
`/~/settings/import` (X following import), `/~/developers/api-keys`,
`/~/referrals` + `/~/referrals/list` + `/~/r/<name>/join`, `/~/developers/mini-apps/debug`.

**Warpcast's own editorial or computed lists**: `/~/starter-packs/<id>`,
`/dwr/packs`, `/~/explore/channels`, `/~/explore/users`, `/~/news/<id>` (articles),
`/~/frame-analytics`, `/~/admin/reviews`, `/~/sealed`, `/miniapps/<id>` (frame
registry), `/dwr/assets` (wallet positions), `/~/inbox`, every surface's feed
summaries / trending topics / channel streaks / highlighted channels.

**A read the node does not hold, refused by name**: `/~/settings/storage` (what
storage costs to rent is Warpcast's pricing of the storage contract, not a read
your node serves), `/~/suggested-starter-packs` and `/~/starter-packs/<id>` (an
editorial pick, not a protocol message), `/~/channel/<key>/followers-you-know`
(channel membership is not a node link — MEASURED: a node's link state is
`follow`/`block` between FIDs), and a notification-group page opened with no
group id, which says which id it needs.

## Re-running it

The probe needs the dev server with a real session:

    cd apps/farcaster-web && HTTPS=true pnpm dev       # https://localhost:5173
    SWEEP_SERVER=https://localhost:5173 node scripts/verify-node-501-sweep.mjs

`.env.local` needs `VITE_SNAPCHAIN_DEBUG=true` (the classification log the probe
reads) and a node URL; `VITE_NEYNAR_API_KEY` is what makes the `index` reads
answerable. On a busy machine (load average in the tens) the browser visits and
the cold vite compile stretch: widen `SWEEP_SETTLE_MS` or wait for the load to
settle rather than "fixing" the product.

`--record` writes fresh expectations to `$SWEEP_OUT`; review them before checking
them in. A surface whose verdict is `works` must render content, `refused` must
name its reason, `degraded` must be a deliberate device-only degradation — and
the shrug fails the run everywhere. A full sweep is 312 visits (156 surfaces ×
390/1440) and takes about an hour on this machine.