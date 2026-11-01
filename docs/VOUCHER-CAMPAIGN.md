# Fiddy bounty — voucher campaign + submission (work plan)

Status as of 2026-10-18 (IST). Deadline is pinned from the bounty cast itself, not estimated.

## 1. The bounty, pinned

| Fact | Value | How it was verified |
| --- | --- | --- |
| Cast | https://farcaster.xyz/balajis.eth/0x50184b62 | `GET farcaster.xyz`, plus the cast page fetch |
| Hash | `0x50184b62b4c52fd76628713562e1eda3dccaf63d` | `castById?fid=37` on a public hub + Warpcast `search-casts`; both agree |
| Author | **@balajis.eth** (FID 37) | both API reads agree |
| Posted | **2026-10-17T14:47:30Z** | `castById` returned the hash with Farcaster-epoch `182789250` = unix `1792248450` |
| Deadline | **2026-10-24T14:47:30Z** = Sat 2026-10-24 20:17:30 IST | +7 days exactly, per the cast text |
| Engagement at read time | 24 replies, 45 recasts, 186 reactions | Warpcast API |

**`docs/BOUNTY-DEADLINE.md` is the single source of truth for the cast URL, its timestamp and the deadline**, with
the verbatim permalink, the reproduce command, the named confirmation sources and the 48h-early target. Read it
before posting a submission.

Two corrections to earlier notes on this card:

- The bounty cast is **balajis's, not 10X Chris's**. 10X Chris (@10xchris.eth, FID 1129138) appears next to it on the
  channel page but has no cast containing the bounty text (checked his last 500 casts back to 2026-08-24).
- The deadline is **2026-10-24T14:47:30Z**, not ~2026-10-25. Reply target = the cast above.

Time left from 2026-10-18T14:07Z: **6 days 0h 40m**.

## 2. What qualifies (verbatim requirements condensed)

1. A microsite with the quickstart at the top + a mobile/desktop tutorial teaching FIDs, custody addresses, app
   keys, Snapchain messages, read nodes vs validators, storage rent.
2. A public GitHub repo, all code MIT.
3. **At least one other human** goes through the tutorial, creates a read node and client, then posts a public
   Farcaster cast vouching for the quality of the work.
4. Entry = a **reply to the bounty cast with three URLs**: microsite, repo, voucher cast.
5. Extra mile, ranked by signal: **more vouches > Chinese translation > 59s vertical video**.
6. "You can use AI, but your output must *not* be AI slop."

## 3. Submission URL status

| # | URL | State |
| --- | --- | --- |
| 1 | https://fiddy.fun/client | Live, HTTP 200, quickstart hero + tutorial present (checked 2026-10-18) |
| 2 | https://github.com/ivcained/fiddy | Public, main == origin/main (checked 2026-10-18, head `68761a8`). `LICENSE` at the root is the standard MIT text (`© Neynar, Inc.` — inherited from the upstream client fork, which is the attribution the licence requires and should stay). `gh api repos/ivcained/fiddy/license` serves it; `gh repo view` shows no SPDX badge only because the root `package.json` carries no `license` field |
| 3 | voucher's cast | **Missing — this is the whole campaign.** |
| 4 | https://fiddy.fun/client/zh/ | Chinese translation of the tutorial, `site/zh/index.html`, linked from `/client` and from the footer, hreflang both ways (extra-mile item 2, ranked above the video). Live 2026-10-18 |

Ready-to-paste reply: `docs/SUBMISSION-REPLY.md` (insert the voucher cast URL).

Local smoke of the voucher's first minute (fresh `FIDDY_HOME`, 2026-10-18): `fiddy doctor` reports ready (ssh/curl/pnpm/node all found; aws and docker flagged optional with the reason), `fiddy config` answers cleanly before any setup, and `fiddy provision` with no arguments prints the two compute options instead of failing. No blockers on the first-run path. The same menu still quotes "~$100/mo" and "200 GB SSD" — trip points P0/P1.

## 4. Voucher prerequisites — tell them before they start

A voucher needs, in this order:

1. An **existing Farcaster account with storage rent paid** (their normal account works). Nothing is created onchain;
   Fiddy imports a seed phrase for an account that already has storage.
2. **Compute**: any VPS with 4 vCPU / 16 GB RAM / Ubuntu 22.04+, or AWS via `fiddy provision --aws`.
   **Storage: 1.5–2 TB free** (see §5, trip point #1) and **ports 3381–3383 open on TCP *and* UDP**.
3. **A test account's seed phrase**, not their main: the tutorial's safety rule is to import a test account only.
4. **Time**: the snapshot is ~200 GB, so sync is hours (the API answers early, full sync lags). Plan a half-day,
   most of it unattended.

Costs, checked against AWS's published prices (2026-10-18): gp3 storage is $0.08/GB-month, so 2 TB alone is
**$163.84/month**; `t3.xlarge` on-demand is **$121.47/month** — about **$285/month** for the AWS path at the
protocol's real disk requirement. Cheaper 2 TB VPS hosts (Hetzner/Contabo/OVH class) land far below that, and
`fiddy provision --ssh` supports them.

## 5. Trip-point log — fix what a voucher trips on

| # | Trip point | Evidence | Owner |
| --- | --- | --- | --- |
| P0 | Tutorial and `provision.sh` say **"200 GB SSD"**. Official Snapchain requirements are **1.5 TB** (GitHub README) / **2 TB** (`snapchain.farcaster.xyz/getting-started`); 200 GB is the *snapshot download* size, not the free-disk requirement. A voucher provisioning 200 GB runs out of space during/after sync. | snapchain docs, 2026-10-18 | `t_fa420e09` (raises the volume) + `t_4b504279` (page copy) |
| P1 | AWS path is quoted as **~$100/mo**; the real figure at 2 TB is ~$285/mo (§4). Quote the honest number and point at `--ssh` + cheaper hosts, or a voucher feels misled. | AWS prices, 2026-10-18 | `t_fa420e09` |
| P2 | The bounty brief says a read node **"does not accept writes"** and that the app key costs **"one small Optimism transaction"**. Both are stale, and our tutorial says so. The tutorial must state the brief's assumption and then show the current behaviour, or a judge diffing the text against the brief reads it as an error. | `snapchain.farcaster.xyz/node-types#message-submission-and-the-mempool`: `submitMessage` works on both roles; a read node has no mempool, validates, gossips to validators; confirm via `MERGE_MESSAGE` or query-back. Gasless `KEY_ADD` since Snapchain V16. | submission reply (§6) + tutorial |
| P3 | Block pruning is **read-nodes-only and off by default** (`pruning.block_retention`), so "it will prune itself" is not a way to keep a small disk. | snapchain docs, node management table | `t_fa420e09` |
| P4 | No Farcaster posting credentials exist on this machine (`~/.hermes/.env` has no Farcaster/Neynar keys). **Corrected 2026-10-18: reading is possible** — `nemes.farcaster.xyz` and `hub.pinata.cloud` are DNS-blocked and Neynar answers 402, but the public hub `https://haatz.quilibrium.com` works from here (`/v1/castsByParent?fid=37&hash=…&pageSize=50` returned all 37 replies), so the vouch and the thread can be read and verified programmatically. Posting still must happen from the owner's account: a cast needs a signature from an app key authorised by the owner's FID, and no such key exists here. | probes, 2026-10-18 | owner |
| P5 | **Fixed 2026-10-18.** The live step-0 command read `fiddy provision --ssh [email protected]` — Cloudflare Scrape Shield rewrote the sample `ubuntu@203.0.113.10` into a `__cf_email__` span whose decoder the `/client` CSP blocks. Anyone copy-pasting the command failed instantly. Fixed in `358111f`; re-verified live: the page now serves `ubuntu&#64;203.0.113.10` and no `__cf_email__` remains. | live page fetch, 2026-10-18 | t_4b504279 (done) |

Live-page re-check 2026-10-18 after `358111f`: HTTP 200, quickstart hero intact, `--ssh` sample command copy-safe, `200 GB SSD` still published (P0 open).

**P0/P1 page copy fixed 2026-10-18** (`site/index.html`): the requirements line now reads 4 vCPU / 16 GB RAM /
**1.5–2 TB free disk** with the snapshot's ~200 GB *compressed* size named as the reason, and the AWS figure is
the honest **~$285/month** (instance ~$121 + 2 TB gp3 ~$164) with the $50–80/month 2 TB VPS alternative.
The paragraph no longer names an instance type, so it stays true whatever `cli/provision.sh` defaults to;
the CLI-side volume/default change is owned by `t_fa420e09` (their in-flight diff already moves the default
volume to `${FIDDY_AWS_VOLUME_GB:-2048}` GB on m5.xlarge). Nobody else owns this text now — one owner, one commit.

## 6. Submission reply

Full text in `docs/SUBMISSION-REPLY.md`. It leads with the three URLs and then spends two lines on the stale parts
of the brief, with the protocol citations. That is the "not AI slop" part: we read the docs and corrected them.

## 7. Recruiting a voucher

**Targeting is now data-backed instead of a template, and split across three files:** `docs/VOUCHER-RECRUIT-TARGETS.md`
holds the targeting and the evidence (tiers, verbatim posts, DM copy, how to verify a vouch from the public hub),
`docs/VOUCHER-OUTREACH.md` holds the 13-person send queue with live recency/reach, the per-person first lines, the
owner decisions and the per-candidate outcome tracker, and `docs/VOUCHER-FRICTION-LOG.md` is where a voucher's
blockers get written down verbatim. What is still missing is the send itself: no Farcaster write credential exists
on this machine, so the DMs and the cast go out from @ivc's client.

Where to look, in order of conversion:

1. **Direct DMs to the owner's own network** — people who already run servers or side projects. Highest conversion,
   lowest volume. Template below.
2. **A public ask cast in /farcaster** (the bounty's own channel, where the 24 other replies are) and in
   /poidh, with the microsite link. This doubles as marketing for the tutorial.
3. Anyone in the replies of the bounty cast who asks "how do I vouch" — reply helpfully, not with a pitch.

Competitive note: @mobeen02 already posted "Need a voucher for Balaji's $2048 Farcaster bounty" (2026-10-17T17:39Z),
and the bounty has 37 replies (35 authors, read 2026-10-18 from the public hub). The field is moving; recruit today.

**Targeting is no longer guesswork: `docs/VOUCHER-RECRUIT-TARGETS.md`** ranks five entrants who publicly asked
for a tester or a voucher in that same thread (@mobeen02, @vaibhavmule, @sats100m, @0xzoz, @webthe3rd.eth),
five node operators who already run the hardware, and the exact DM copy for each. The strongest single deal is
@0xzoz — 13.1k followers, needs an **agent-led** clean-machine run of "In Three" by 2026-10-23T14:47Z, which this
machine can supply outright in exchange for a human clean-machine run of ours ending in the vouch cast.

Recruitment cast copy (post from the owner's account):

```
Three commands to your own Farcaster client on your own read node:

  fiddy provision   # your compute (AWS scripted, or any VPS over SSH)
  fiddy node up     # Snapchain read node, no API keys from anyone
  fiddy client up   # client reading YOUR node

https://fiddy.fun/client — full tutorial, mobile + desktop, protocol concepts explained as you go.

Looking for one person who'll actually run it end to end and say publicly whether it worked. Reply here or DM me.
```

DM copy:

```
Hey — I wrote a Farcaster client + read-node tutorial and I'm looking for one person to actually run it and vouch publicly.

The honest ask: a server with 4 vCPU / 16 GB RAM / 2 TB free disk and ports 3381-3383 open (a ~$50-80/mo 2 TB VPS is fine, `fiddy provision --ssh` handles it), a test account's seed phrase, and about half a day where most of it is the node syncing. You don't pay anything else, there are no API keys, and nothing is created onchain.

https://fiddy.fun/client

If you hit anything broken I want to know — I'll fix it. And if it works, the voucher cast is just your honest review plus the link.
```

Do not promise: prizes, money, or that it takes ten minutes.

## 8. The voucher's cast — what has to be in it

Judge-facing minimum: public, from the voucher's own account, naming that they ran the tutorial end to end (node +
client) and whether it was any good, with the microsite link. A reply to the bounty cast or a standalone cast both
work; a standalone cast keeps the reply thread clean for the 3-URL submission. Template:

```
I just stood up my own Farcaster client + read node with Fiddy's tutorial.

Three commands, no API keys from anyone, my own Snapchain node serving my feed:
- fiddy provision --ssh <box>   (2 TB disk, ports 3381-3383)
- fiddy node up
- fiddy client up

Took me <X> hours, mostly the node syncing. The tutorial explained what a read node actually is and why gasless app
keys changed (no Optimism tx). <One honest criticism.>

https://fiddy.fun/client
```

## 9. Timeline

| When (UTC) | What |
| --- | --- |
| 2026-10-18 | Post the recruitment cast + start DMs (owner action). |
| 2026-10-19 → 10-21 | Voucher runs it; fix whatever they trip on; log it in §5. |
| by 2026-10-23 | Voucher's cast live; get the URL into the submission reply. |
| 2026-10-24 14:47:30 | **Hard deadline** — reply to https://farcaster.xyz/balajis.eth/0x50184b62 with the three URLs. Post with a day of slack, not an hour. |

## 10. Owner decisions needed

1. **Who is the voucher?** A name/handle to DM, or approval to post the public ask cast above. The ranked
   shortlist with paste-ready DMs is `docs/VOUCHER-RECRUIT-TARGETS.md` — pick any one of the five tier-1 handles
   and the DM is already written.
2. **Which account posts the submission reply** (and the recruitment cast) — the reply must come from the owner's
   Farcaster account, and the prize is paid to a public Farcaster wallet address. Use the full-length text
   (**974 characters / 986 bytes** with a real voucher URL — under the protocol's 1024-byte cast cap, checked
   by byte count), or the short 268-character variant at the top of `docs/SUBMISSION-REPLY.md` if the composer
   refuses long casts.
3. **Extra mile**: the Chinese translation is **done and live** (https://fiddy.fun/client/zh/). The 59s video is
   now the only outstanding extra-mile item; a second vouch is worth more than both, so it stays last.