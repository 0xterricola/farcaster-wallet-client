# Snapchain or Hypersnap — the network choice, and what is actually known

Two networks, same idea. They carry the same kind of social data and do not talk
to each other:

- **Snapchain** — Farcaster's own network. The one every account, cast and follow
  lives on. This is the one to pick.
- **Hypersnap** — an independent parallel network built by the Quilibrium
  community. Same kind of social data, different plumbing and different
  economics. It is for explorers, and it is not where a Farcaster account lives.

This document is the record of what was measured while building the choice into
the CLI and the client, because the whole feature turns on one question: what can
Fiddy honestly offer?

## 1. Where each network can be read right now

| Endpoint                          | Measured 2026-10-24                              | Verdict |
| --------------------------------- | ------------------------------------------------ | ------- |
| `https://haatz.quilibrium.com`    | `GET /v1/info` → **200**, version `0.13.5`, 914,322,172 messages, 2 shards (heights 48,822,452 / 49,477,354 / 49,328,400) | Hypersnap's own documentation names this host as their public node, and it answers. **Readable.** |
| `https://snapchain-api.neynar.com` | `GET /v1/info` → **402** `X-PAYMENT header or API key required` | Not readable without a paid key. |
| `https://hub-api.neynar.com`       | `GET /v1/info` → **402** (same)                  | Not readable without a paid key. |
| `https://hub.farcaster.standardcrypto.vc` | no answer within 10 s                     | Gone. |

So: **Hypersnap has a public read route; Snapchain has none for a stranger.**
A Snapchain read needs a node of your own, which is exactly what `fiddy node up`
installs — which is why the client only offers Snapchain where such a node exists
(see §4) and why the CLI defaults to it.

**"Readable" is not "following the chain", re-measured 2026-10-24 14:34 to 14:46
UTC.** The public node answered every one of eleven reads over four minutes while
its two message shards did not advance: shard 1 sat at `49,477,354` and shard 2
at `49,328,400`, with `blockDelay` climbing in step with the wall clock
(`31,706` → `31,937` s on shard 1, `15,816` → `16,047` s on shard 2), while shard
0 advanced about one block a second. `blockDelay` is *the age of that shard's
newest block, in seconds* — MEASURED at the source (`farcasterxyz/snapchain`:
`src/network/server.rs` sets `block_delay: current_time.saturating_sub(max_block_time)`
from that shard's `max_block_timestamp()`, and `src/storage/store/engine.rs`
gauges the same quantity per commit as `block_delay_seconds = now - block.timestamp`)
— not a count of blocks, so a number that climbs in step with the wall clock
means that shard is not advancing at all. This was not a stale validator list: the on-chain registry still reports
the current set (§3), so it is a shard that stopped advancing as far as this node
could see. Which of the two it was, this node or the network, could not be settled
from here: there is no second reachable Farcaster or Hypersnap read node
(`hub.pinata.cloud` and `nemes.farcaster.xyz` do not resolve,
`snapchain-api.neynar.com` answers `402`, `api.warpcast.com` and
`api.farcaster.xyz` answer `401`).

**The same node two hours later was applying blocks again and still behind
(MEASURED 2026-10-24 16:07 to 16:27 UTC, three reads 21 s apart).** After the halt
in §3 the shards resumed and caught up: shard 0 kept a newest block 2–6 s old
throughout, while shard 1 and shard 2 *advanced* (~200 blocks in 21 s) with their
newest blocks still `26,597` s → `16,773` s and `10,627` s → `795` s old, falling
as they caught up. So the field is a **lag**: the frozen shape above (age climbing
1 s per second) and this catching-up shape (heights moving, age falling slowly)
are both readings of the same number, and either way the shard is behind by
exactly what the field says. The client reports that, per shard, in those words
(§4). The raw reads are in
[evidence/client-freshness-2026-10-24.json](evidence/client-freshness-2026-10-24.json).

## 2. A node cannot be asked which network it is

This is the fact that shapes the whole UI. MEASURED 2026-10-24, `GET
https://haatz.quilibrium.com/v1/info` answers exactly:

```json
{ "dbStats": {...}, "numShards": 2, "shardInfos": [...], "version": "0.13.5",
  "peer_id": "12D3KooWMY…", "nextEngineVersionTimestamp": 0 }
```

No network name, and `version` is shared lineage with Snapchain (Hypersnap is a
fork of the same codebase), so it cannot separate them either. Therefore:

- the client **never infers** a network from a response;
- a network comes from (a) a listed public address whose network was measured
  when it was added, or (b) `VITE_FIDDY_NETWORK`, which is what
  `fiddy client up` writes for the node it just pointed the client at;
- anything else is reported as **"Not recorded"**, with the reason, rather than
  guessed. `~/snapchain/networks.ts` is the one place this lives.

## 3. The self-hosted Hypersnap install is real, and does not produce a working node

Upstream publishes a bootstrap, a compose file and an image:

```
curl -sSL https://raw.githubusercontent.com/farcasterorg/hypersnap/refs/heads/main/scripts/hypersnap-bootstrap.sh | bash
  → ~/hypersnap/hypersnap.sh upgrade → docker compose, image farcasterorg/hypersnap:latest
  → HTTP :3381 · gossip :3382/udp · gRPC :3383
  → same host as a Snapchain node: 16 GB RAM, 4 vCPU, 1.5 TB free disk
```

Measured 2026-10-24, on the published install path (re-measured by the sweep
described in §3.1; every number below comes from that run):

- The **stable** channel (the default) fetches the installer from GitHub's
  `@latest` tag. That tag is not a release: it resolves to commit `dc8d8df` of
  `2026-03-30`, which is **29 commits behind** `v0.11.8` (`2026-05-07`, the newest
  release). That copy fetches no validator list and mounts none, and its
  `docker-compose.mainnet.yml` hardcodes seven `[[consensus.validator_sets]]`
  entries whose newest heights are `28_415_000` (shard 0), `28_852_000` (shard 1)
  and `28_706_000` (shard 2): about 21M blocks behind the live network.
  `.../@latest/scripts/hypersnap.sh` → `200` (no mention of a validator list),
  `.../@latest/validators.toml` → **404**.
- The **main**-branch installer does fetch `validators.toml`, but that file is
  behind the network's own on-chain registry. The registry
  (`SnapchainConfigRegistry`, `0x00000000fc51aD6eb74EAE89ba4b01b1776fBA85` on
  Ethereum L1, the address baked into `farcasterxyz/snapchain`'s
  `cli/src/config_pull.rs`) answers `configVersion()` = **18** and publishes
  **13** validator sets, newest `effective_at = 49_311_000`. Upstream's file
  carries **10** of those and stops three rotations short (`39_180_000` shard 0,
  `39_624_000` shard 2, `39_798_000` shard 1); the three it does not carry are
  `48_632_000` (shard 0), `49_147_000` (shard 2) and `49_311_000` (shard 1), and
  the live network (48.8M / 49.5M / 49.3M) is past all three.
- Consequence, as reported upstream in
  [farcasterorg/hypersnap#41](https://github.com/farcasterorg/hypersnap/issues/41)
  (**still open**, 3 comments, the last from an operator on `2026-10-24` who
  deliberately left it open so the fix becomes resilient rather than patched):
  the node answers `/v1/info` and then stops following shards 1 and 2 with
  `Block contained signatures from unexpected signers`. **The repair that worked
  for them is to replace `~/hypersnap/validators.toml` with the validator list
  from the other project, `farcasterxyz/snapchain`** — measured today, that copy
  still matches the registry entry for entry (13 sets, newest `49_311_000`). That
  is a hand repair, not an install: it is only as good as the next sweep.

A fresh install is therefore not a working node: it is a node that reports itself
healthy while falling behind. Fiddy will not install one and call it done.

**What the CLI does instead** (`cli/networks.sh`, `hypersnap_install_report` +
`hypersnap_refuse`): `fiddy node up --network hypersnap` prints the whole record
above — the install path, the registry's version and set count next to upstream's,
the open issue, the repair and its caveat, the host requirements, and how to read
the public node's own freshness numbers — and exits 1, pointing at the two things
that do work today: reading the public Hypersnap node, and the upstream issue that
would change the verdict.

`--network snapchain` (the default) is unchanged: it installs Snapchain on the
target exactly as before, and now records `FIDDY_NODE_NETWORK=snapchain` in
`~/.fiddy/config` so the network is known later rather than assumed.

### 3.1 Re-checking this, in one command

The refusal is only honest while the measurement behind it is true, and the
measurement moves: a validator rotation, a release tag that catches up, or a fresh
install path upstream all change the verdict. `scripts/sweep-hypersnap-upstream.py`
re-derives all of §3 and prints a verdict, so a later sweep does not have to invent
the method again:

```
scripts/sweep-hypersnap-upstream.py          # human summary, dated facts
scripts/sweep-hypersnap-upstream.py --json   # the same facts as JSON
```

Its exit status is the automation contract:

| exit | meaning |
| ---- | ------- |
| `0`  | the premise holds: the published install is still behind the registry, so there is nothing to lift |
| `1`  | possibly fixed: a published file now matches the registry, so install one on real hardware and prove it follows the chain |
| `2`  | could not measure: upstream sources unreachable, so do not act on this run |

It reads the on-chain registry first (`eth_call` for `configVersion()` and
`configToml()` on Ethereum L1, selectors `0xdd64d24d` and `0x5a62bd75`), compares
`validators.toml` on `farcasterorg/hypersnap` `main` and on the `@latest` tag
against it entry for entry, checks `farcasterxyz/snapchain`'s copy against the same
authority, then reads the public node's `/v1/info` twice twenty seconds apart to
see which shards are moving. **It never decides that an install works.** A file
that matches the registry only gets you to "now prove it on a real node": heights
compared against a public node over a few minutes, and only then may the CLI stop
refusing.

## 4. What the client does

- **`~/snapchain/networks.ts`** owns the vocabulary and the honesty rules:
  `readNetwork()` (which network, and where that answer came from),
  `routeForNetwork()` (the address reads would go to), `networkOffers()` (both
  networks, each with a route or a reason it has none).
- **Settings → your node** (`/~/settings/node`) is where the reader meets it: a
  **Network** card above the server picker states which network this client is
  reading, words both in the ELI5 language, and offers a network **only when
  there is an address for it**. On a build with no node of its own, Snapchain is
  shown as unavailable with the exact reason and the one command that changes it
  (`fiddy node up --network snapchain`, then `fiddy client up`) — never as a
  button that fails after it is pressed.
- Picking a network is not a label: it saves that network's address as the
  reader's server (the existing node choice), which is what actually moves the
  reads. `Your setup` in the same page then names the network.
- `PUBLIC_READ_NODES` gained a `network` field, and the public entry's name is now
  honest about what it is ("The public Hypersnap node" — it always was one; the
  picker used to call it "a public Farcaster node").
- **Freshness is now claimed per shard, from the node's own fields**
  (`apps/farcaster-web/src/snapchain/providers/health.ts`). A Snapchain `/v1/info`
  body carries, for each shard, `maxHeight` (a block number) and `blockDelay` (the
  age of that shard's newest block, in seconds). `ProbeSample.shards` keeps both as
  the node reported them; freshness is judged per shard (that shard's height across
  two reads, `judgeFreshness` + `combineFreshness`), and a shard whose age is over
  the threshold makes the server `stale` (`shardsBehind`). A single number taken
  across the shards is exactly what let an advancing shard vouch for a stopped one,
  so the client no longer takes one.
- **The threshold is a duration and its name says so**:
  `DEFAULT_HEALTH_CONFIG.maxTipAgeMs = 120_000`. MEASURED: a shard that is keeping
  up has a newest block 0–6 s old (blocks land about once a second), so two minutes
  is twenty times the worst healthy reading; the public node's other shards measured
  795 s to 31,937 s.
- **The sentence says what the field says, never "blocks"**: *"It answered, but
  shard 1's newest block is 4h 39m old."*, or for several at once *"…the newest
  blocks on shards 1 and 2 are 4h 39m and 13m 15s old."* A shard whose `blockDelay`
  the node did not report keeps `tipAgeSeconds: null` and is never given a number;
  a server that goes stale with no per-shard number to quote gets the numberless
  sentence *"Answering, but it has stopped keeping up with the network."*
- A node that answers while a shard is hours behind is therefore `stale`, not
  `live`. The pill and Settings → your node say which shard and how old its newest
  block is; the failover only moves the reader off it when something better on their
  list is answering, so the sentence stays true either way.

## 5. The release carries the network

`scripts/release-client.sh` sets `VITE_FIDDY_NETWORK` alongside
`VITE_SNAPCHAIN_HTTP_URL`: `hypersnap` when the build targets the known public
Hypersnap node (the default), `FIDDY_BUILD_NETWORK` otherwise, and nothing when
neither applies (so the client says "not recorded" rather than something wrong).
Step 3 refuses a build that has lost the network card or, when a network was
declared, the declared name.

`fiddy client up --network snapchain|hypersnap` writes both into
`apps/farcaster-web/.env.local`, so a self-hoster never hand-edits them:
`--network hypersnap` points the client at the public Hypersnap node with nothing
of theirs running, and `--network snapchain` (default) points it at their node.

## 6. Verification that was run

- Sweep, 2026-10-24 14:46 UTC: `scripts/sweep-hypersnap-upstream.py` → exit **0**
  (premise holds). Its verdict line: *"upstream main carries 10 validator sets and
  is missing 3 of the registry's 13 (newest it publishes: 39_798_000, newest the
  registry publishes: 49_311_000, configVersion 18)"*, with
  `farcasterxyz/snapchain`'s copy reported as `matches the registry: yes`, the
  `@latest` tag as `validators.toml HTTP 404`, and the public node's shards 1 and
  2 flagged `not advancing`. The run's machine-readable copy is
  [evidence/hypersnap-sweep-2026-10-24.json](evidence/hypersnap-sweep-2026-10-24.json).
- Client freshness, 2026-10-24: 42 tests across
  `apps/farcaster-web/src/snapchain/providers/__tests__/health.test.ts` and
  `runtime.test.ts`, including a fixture of the public node as measured here (one
  shard advancing, two hours behind, ages climbing) and a healthy node, asserting in
  both the status, the per-shard freshness judgement and the human sentence. Then a
  live run of `probeSnapchain` against `https://haatz.quilibrium.com` twice, 21 s
  apart, 2026-10-24 16:27 UTC, which printed `STATUS stale` and *"It answered, but
  the newest blocks on shards 1 and 2 are 4h 39m and 13m 15s old."* — the reads are
  in [evidence/client-freshness-2026-10-24.json](evidence/client-freshness-2026-10-24.json).
  The two sentences also reach the screen, proven twice:
  - in the DOM, by `apps/farcaster-web/src/snapchain/providers/__tests__/pill.test.ts`
    (the pill's hover title) and
    `apps/farcaster-web/src/pages/settingsNode/Component/ProviderListCard.test.tsx`
    (the row a reader opens to find out why their feed is quiet), both holding the
    measured sentence verbatim;
  - in a real browser, by `apps/farcaster-web/scripts/verify-freshness-copy.mjs`
    (recipe in its header): a signed-in client with the public node's `/v1/info`
    answered from the 16:27 UTC body prints a row reading `1. Our public node reads
    + posts **behind the network** in use … It answered, but the newest blocks on
    shards 1 and 2 are 4h 39m and 13m 15s old.` — **4/4** checks, and **3/3** with
    the healthy body, where the same row says the node is answering normally and
    never calls it behind. Machine output:
    [evidence/client-freshness-2026-10-24-browser.txt](evidence/client-freshness-2026-10-24-browser.txt).
- CLI, after the corrections: `fiddy node up --network hypersnap` prints the
  record above (registry version and set count, the three missing rotations, the
  issue's state, how to read the public node's freshness numbers) and exits 1
  before any preflight, SSH or install work.
- CLI: `fiddy node up --network bogus` → `unknown network` + exit 1;
  `--network hypersnap` → the full report + exit 1 (no install attempted);
  `--network snapchain` on a machine with no target → the real installer path
  (dies at `require_target`), and `--local` on this laptop dies at the disk
  preflight: the flag routes into the real install, it does not stub it.
- CLI: `fiddy client up --network hypersnap` wrote
  `VITE_SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com` and
  `VITE_FIDDY_NETWORK=hypersnap` into `.env.local`, and made no SSH attempt.
- Client: `pnpm --filter farcaster-web lint` clean; `tsc --noEmit` and the test
  suite hold parity with a pristine `origin/main` worktree (the only tsc errors
  are the known stale-`dist` ones from the shared clones' built packages, and CI
  builds the packages fresh); the new tests are
  `src/snapchain/__tests__/networks.test.ts` and
  `src/pages/settingsNode/Component/NetworkChoiceCard.test.tsx`.
- Client, in a browser: `apps/farcaster-web/scripts/verify-network-choice.mjs`
  (its own README block names the recipe), which signs in through the stubbed
  SIWF relay and drives Advanced → your node for real. Two configurations, both
  green:
  - a build with no node of its own (`VITE_FIDDY_NETWORK=hypersnap`): **12/12** —
    the card names Hypersnap, Snapchain is shown as unavailable with the reason
    and **no** button, Hypersnap is offered at `https://haatz.quilibrium.com`,
    pressing it asked the real node and reported `Hypersnap answered in 1552 ms ·
    v0.13.5`, the node picker agreed ("in use: a public server"), and the reading
    survived a reload with "Your setup" naming Hypersnap.
  - a build that runs its own node (`VITE_SNAPCHAIN_HTTP_URL=<node
    address>` + `VITE_FIDDY_NETWORK=snapchain`): **11/11** — both networks offered,
    each at its own address; pressing Snapchain saved the reader's own node and
    the picker said "in use: your own"; the address did not answer, and the card
    said exactly that rather than implying a working setup.