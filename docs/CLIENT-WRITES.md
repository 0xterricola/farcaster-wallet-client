# Writes through a provider — likes, casts, follows, recasts

Status 2026-10-21. The client could read from a provider chain and could not
write: pressing the heart answered

    UpdateCastLikeError — createCastLike 501
    "no node-backed reader has been written for this endpoint yet"

on a live signed-in page. That sentence was about a *reader*, for a write. This
is what answers that endpoint now, what it is verified against, and the one half
that is still an owner action.

## The seam

Nothing in the fork's components changed. The client's data layer
(`farcaster-client-data`) is one class whose every call goes out through a
`fetch` this app hands it, so the writes are answered at the same seam the reads
already were (`snapchain/nodeApi/nodeBackedFetch.ts`,
`snapchain/providers/providerFetch.ts`):

    component → fork's data layer → seam → classify (hostedRoutes) → write

`hostedRoutes.ts` now has a `write` table — the classification is by path and
method, because that is all a `fetch` sees:

| the fork's call | what this device signs | builder |
| --- | --- | --- |
| `PUT /v2/cast-likes` | `REACTION_ADD` (like) | `buildReactionAddMessage` |
| `DELETE /v2/cast-likes` | `REACTION_REMOVE` | `buildReactionRemoveMessage` |
| `PUT /v2/recasts` | `REACTION_ADD` (recast) | `buildReactionAddMessage` |
| `DELETE /v2/recasts` | `REACTION_REMOVE` | `buildReactionRemoveMessage` |
| `PUT /v2/follows` | `LINK_ADD` | `buildLinkAddMessage` |
| `DELETE /v2/follows` | `LINK_REMOVE` | `buildLinkRemoveMessage` |
| `POST /v2/casts` | `CAST_ADD` | `buildCastAddMessage` |

`nodeWrites.ts` is the writer: it maps that path to a protocol message, signs it
with the app key this device holds for the signed-in FID, hands the bytes to the
provider's node with `POST /v1/submitMessage`, and then **reads the node's own
state back** before it answers. A message the node accepted but is not showing is
answered `502` in those words — never as a success. (A node can also accept the
bytes and reject the signer at merge: an unregistered key passes
`/v1/validateMessage` with `valid:true` and is refused at merge with
`bad_request.validation_failure/invalid signer`. That is why the read-back
exists.)

A write that arrives with **no key at all** is no longer refused at the reader:
the pending write itself is handed to an asker, which puts one friendly approval
screen in front of them where they are and answers the *same* request once they
approve it — so a like pressed before the key exists still lands, without a second
press and without a recovery phrase. See `docs/CLIENT-INLINE-APPROVAL.md`.

Everything the fork's write surface does that has *no* builder here — deleting a
cast, editing a profile, mutes, blocks, bookmarks — stays unclassified and is
refused in words that name the gap:

    no node-backed writer has been written for PUT /v2/… yet,
    so nothing was signed and nothing was sent

## The capability matrix

`snapchain/providers/capabilities.ts`, one answer used by three callers (the
seam, the picker, the pill):

| server | reads | writes | what a reader is told |
| --- | --- | --- | --- |
| your node, or the public relay | yes | yes (`submitMessage`) | "reads + posts" |
| Neynar (with your own key) | yes (its index) | yes (its own node) | "reads + posts" |
| Farcaster's own public server | yes | **no** | "reads only" |

A write is **never rerouted**. It goes to the server the reader is on and is
refused there if that server cannot carry it, because a write commits something
under the reader's name. A *read* may go to the first server on their list that
can serve it — which is what makes Neynar workable as the default: Neynar's index
has profiles, threads and one account's casts but not the follow-graph feed, so
the feed is read from the node behind it rather than failing on the default.

Neynar is not one server but two, and the client uses both halves: the index
(`api.neynar.com`) for those reads, and Neynar's own Snapchain node
(`snapchain-api.neynar.com`) for writes, with the reader's key in `x-api-key`.

## Which server a signed-in reader starts on

`catalog.ts`'s `defaultProviderOrder`, with a Neynar key present: **Neynar
first**, then the public relay, then Farcaster's own public server (always last,
read-only). With no key: the relay first. An explicit pick in the picker still
takes the first place.

## The read-back, and why it pages

MEASURED 2026-10-21 on a live cast (215 likes), against **both** Neynar's node
and the public relay:

- a node hands back **at most 200 reactions per page**, whatever `pageSize` asks
  (asked 100, got 200), and says so with a `nextPageToken` while another page
  exists;
- a page is in the node's own index order — **not** newest-first (page 1 ran from
  timestamp 182745086 to 182872702).

So a one-page read-back could not see this device's own like on a popular cast,
and would answer "the node is not showing it" for a like that really landed — or,
worse, answer that an *undo* had landed while the reaction was still on page 3.
The read-back walks up to 5 pages (1000 reactions) and distinguishes three
states: `shown`, `absent` (searched to the end, not there) and `unknown` (stopped
looking early). `unknown` is never reported as a success, in either direction.

## What is verified, and how

- **The bytes are real and a real node evaluates them.** Live probe (default
  provider, 2026-10-21): `GET snapchain-api.neynar.com/v1/info` → 200;
  the index read → 200; the addressed cast → 200; a `REACTION_ADD` built by this
  client's own builder and signed by a throwaway key → `POST /v1/submitMessage`
  → **400 `bad_request.validation_failure/invalid signer`** (the node decoded the
  message and checked the signature against that account's key registry);
  `REACTION_REMOVE` builds to a *different* message type; the read-back
  (`/v1/reactionsByCast`) → 200 on Neynar's node and on the relay.
- **The client's half, in tests** (`nodeWrites.test.ts`, 14 tests): the bytes
  that leave are decoded with the protocol library the client signed them with,
  the app key's own signer bytes are compared with an independently built
  message, and every answer that says "landed" is only reached when the fake
  node's state shows it. Both directions are covered, including the paging case
  and the "could not search to the end" case.
- **Routing and the matrix** (`providerFetch.test.ts`, `catalog.test.ts`): a
  write is never rerouted; a read the preferred server cannot serve goes to one
  that can; a write on a server that takes no writes is refused in that server's
  own words; the default order starts on Neynar when a key exists.
- `typecheck`, `eslint` (the CI gate), `vitest`, and `vite build` are green on the
  change.

**Not verified here, and it cannot be from this machine: a like that really lands
on mainnet under the owner's own FID.** Posting needs a message signed by an app
key authorised by that FID, and no such key exists on this machine (the same
open item as `docs/BOUNTY-DEADLINE.md` §6 and `docs/VOUCHER-CAMPAIGN.md` P4). An
app key is minted per device in the browser by the one-time "Issue app key" flow.
What can be checked from a machine with no credentials is checked above; the
signed-in end-to-end press is an owner action, and the writer's own read-back is
what makes it observable when it happens.

## Launch your own node

The picker's server list labels each row with its capability, and a card under it
links the deploy page (`https://fiddy.fun/client/deploy/`) and the CLI. The
prices on that card are the ones the CLI's own output and the deploy page carry —
never estimates:

| path | price |
| --- | --- |
| AWS (`fiddy provision --aws`) | ~$285/mo — the documented path |
| Google Cloud (`--gcp`) | ~$350/mo — the one that was tested |
| OVHcloud (`--ovh`) | ~$190/mo |
| Hetzner (`--hetzner`) | ~€120/mo — the cheapest measured |

Sizing is the one in `docs/NODE-REQUIREMENTS.md`: 16 GB RAM, 4 vCPU, a 2 TB disk
(a "1.5 TB free" box is at the edge during bootstrap), and the first sync takes
hours.