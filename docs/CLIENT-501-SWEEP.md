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

**Node-derivable, but no reader yet** — the honest gap sentence, not the shrug:
`/v2/followers-you-know`, `/v2/channel-followers-you-know` (an intersection this
client does not assemble yet), `/v2/notification-group` (the frames/mini-apps
notification tabs), `/v2/profile-snap-casts` (the snaps tab). Each of these is a
read a node *can* make; what is missing is a reader, and the panel says exactly
that.

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
the shrug fails the run everywhere.