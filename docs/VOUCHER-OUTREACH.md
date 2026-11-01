# Fiddy voucher outreach — the send queue, the copy, and the outcome tracker

Operational companion to `docs/VOUCHER-RECRUIT-TARGETS.md` (canonical targeting + evidence: who they are and why
they will convert, with the verbatim posts that prove it) and `docs/VOUCHER-CAMPAIGN.md` (the campaign plan and
the submission reply).

Written 2026-10-18T15:57Z, updated 2026-10-18T~16:20Z after the site's honest-disk/price release (`8374eed`).
This file answers three questions and nothing else: **who do we send to now, what do we paste, and what happened
to each one.**

**Status: queue built and verified against the live network. Nothing sent — no Farcaster write credential exists
on this machine, so the send is the owner's action (see §1).**

## 1. Channel status (checked 2026-10-18, not assumed)

| Check | Result | How |
| --- | --- | --- |
| Farcaster write credentials on this machine | **none** | no `FARCASTER_*`/`NEYNAR_*` key in `~/.hermes/.env`; `grep -ci neynar /etc/fiddy-auth/app.env` = 0 on the VPS |
| Can we read the network? | **yes, unauthenticated** | public hub `https://haatz.quilibrium.com` answers `/v1/castsByFid`, `/v1/castsByParent`, `/v1/linksByFid`, `/v1/userDataByFid`; `api.warpcast.com/v2/user?fid=` also answers with no token |
| Targeting source | **@ivc, fid 191554** | Warpcast API: 1 402 followers, 429 following; profile links `github.com/ivcained` |
| Recruitment already posted? | **no** | @ivc's last 50 casts contain no ask; the only Fiddy cast is the Network Court early-list one |
| `gh` CLI | **authenticated as `ivcained`** (`repo` scope) | `gh auth status` — repo issues are a second channel the owner can fire in one command |

## 2. Send queue — 13 people, in the order to send

Every row was read from the live network today: follower count, last-cast date and last-cast text are from the
hub/Warpcast reads in this task, not from memory. `RT` marks rows whose evidence is written up in
`docs/VOUCHER-RECRUIT-TARGETS.md`.

# 1–4 are **entrants in the same race who have publicly asked for a tester** (RT §2) — the ask is symmetric, so
they convert best. #5–10 are **Snapchain node operators and client builders** (RT §3 + this run's filters over
@ivc's graph) — the ask is a peer review, and their vouch carries weight with a judge. #11–13 are warm
owner-network accounts with the infra habit.

| # | Handle | fid | followers | last cast | Why this one, now | Channel |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | @mobeen02 | 440212 | 2 428 | today | RT: posted a submission with "(3) Voucher: (getting voucher, will update)" and a standalone "Need a voucher" cast — stuck on exactly our gap | Farcaster DM |
| 2 | @vaibhavmule | 1356870 | 3 318 | 1 d | RT: "Looking for a builder to test it and vouch. Who's up?" | Farcaster DM |
| 3 | @webthe3rd.eth | 374565 | 220 | today | RT: "Any devs willing to test and vouch for it later this week?" — unanswered so far | Farcaster DM |
| 4 | @sats100m | 3355244 | 0 | today | RT: wants 3–5 testers this week; his own node is mid-sync, so he is in the same week-one grind | Farcaster DM |
| 5 | @0xzoz | 1918 | 13 134 | today | RT: asked for **one human-led and one agent-led** clean-machine run of his "In Three" by 10-23. We can supply the agent-led half; ask for a human run of ours in return. The strongest trade on the board | Farcaster DM |
| 6 | @topocount.eth | 20603 | 1 620 | 2.8 d | RT: posts Snapchain node-runner release notes ("node runners will want to upgrade before Thursday") — runs the exact stack our tutorial installs | Farcaster DM |
| 7 | @0xael.eth | 539854 | 1 326 | 0.1 d | RT: runs SnapMeter, "Hypersnap data is syncing with a local node" — will judge the node path on the numbers | Farcaster DM |
| 8 | @felirami.eth | 196149 | 4 910 | 0.7 d | RT: "Making it easier to run a Hypersnap node" — adjacent tooling, will see the differences fast | Farcaster DM |
| 9 | @boiler | 14217 | 708 | 0.6 d | RT: "Who is running either a snapchain node or a replicator?" — an open, unanswered node question | Farcaster DM (reply) |
| 10 | @mvr | 230238 | 11 864 | 0.2 d | builds a Farcaster client (Vibeshift); in the bounty thread he made the read-node/write-path point the tutorial implements | Farcaster DM |
| 11 | @manan | 191 | 38 281 | 2.7 d | "Building (and sometimes breaking) farcaster" — will read the protocol claims critically | Farcaster DM |
| 12 | @borodutch | 1356 | 38 398 | 0.7 d | "sr staff agentic engineer" — runs infra for a living, warm (@ivc follows, mutual) | Farcaster DM |
| 13 | @darrylyeo | 3854 | 7 894 | today | Farcaster dev who replied in the bounty thread; also useful as a second vouch | Farcaster DM |

Held back on purpose: @piratekev.eth (fid 13525) wrote snapchain-on-kubernetes infra code but his last cast is
**530 days old** — a dead DM. @nashrad (fid 3326491, 1 follower) is the highest-doc-value voucher ("I'm a
crypto/farcaster noob… attempting this", "My first cast on a local node") and the most likely to stall; send only
if a run is wanted that tests the docs rather than the code.

Send #1–5 today. They are the ones with the same deadline pressure. Then #6–13. Ask 8–10 people, not one.

## 3. What to paste

Long copy for #1–4 (mutual-vouch) and #5–8 (node-operator pitch) is in `docs/VOUCHER-RECRUIT-TARGETS.md` §2 and
§3 — use it as-is. Two additions from this run:

**Per-person first line** (replace the opener so the DM does not read as a blast):

- @manan — "you break farcaster professionally, so you'll catch whatever's wrong with my read-node claims"
- @borodutch — "you already run agent infra; this is one box and three commands"
- @darrylyeo — "you replied in balajis's thread and you actually read protocol code"
- @mvr — "your point in the thread about clients reading from a Snapchain node is exactly what the tutorial implements"
- @0xael.eth — "you're already syncing Hypersnap locally, so you'll see my node path's shortcuts in minutes"
- @felirami.eth — "you're making Hypersnap easier to run; I'd like the same scrutiny on my read-node path"
- @topocount.eth — "you post the node-runner releases, so you'll know if my install is wrong"
- @boiler — "you asked who's running a snapchain node or replicator — I shipped a three-command path to a read node"
- @sats100m — "you're mid-sync on your own shard; you'll know exactly where mine wastes your time"

**The one honest lever, if the owner approves it** (§5.2): "and if the box is what's stopping you, I'll cover the
VPS for the run — the tutorial needs a 2 TB disk, which is $50–80/mo on Hetzner/Contabo/OVH class hosts, not the
$285/mo AWS figure the page quotes for the scripted path."

Do **not** promise prizes, money, a cut, or that it takes ten minutes. Do say that "your thing is broken here" is
a successful answer.

## 4. One action instead of thirteen

1. **Public ask cast** — copy in `docs/VOUCHER-CAMPAIGN.md` §7, post standalone in `/farcaster`; reaches @ivc's
   1 402 followers and doubles as marketing.
2. **Reply in the bounty thread** (37 replies, every other entrant) pointing at the three commands — cheaper
   attention than a standalone cast.
3. **Repo issue**, one command with the `gh` CLI already authenticated as `ivcained`:

```
gh issue create --repo ivcained/fiddy --title "Looking for one person to run the tutorial end to end and vouch publicly" --body "<cast text + the prerequisite block from VOUCHER-CAMPAIGN.md §4>"
```

## 5. Decisions only the owner can make

1. **Send the DMs, post the cast, or both.** Nothing in this file can move without one of them.
2. **May the ask offer to cover the voucher's VPS?** Biggest single conversion lever (see §3). It is a money
   commitment, so it is deliberately not in the copy — say yes and the line goes in.
3. **The vouch must come from the voucher's own account**, never @ivc's. Not negotiable with the judge.

## 6. Outreach outcome log — the tracker for every candidate

Update this table as replies land. It is the evidence for the card's "outreach outcome for every candidate
recorded" criterion, and it is the only place that knows who was already asked.

| Handle | queue # | asked (UTC) | outcome | note |
| --- | --- | --- | --- | --- |
| @mobeen02 | 1 | not yet | not_contacted | |
| @vaibhavmule | 2 | not yet | not_contacted | |
| @webthe3rd.eth | 3 | not yet | not_contacted | |
| @sats100m | 4 | not yet | not_contacted | |
| @0xzoz | 5 | not yet | not_contacted | agent-run trade offer |
| @topocount.eth | 6 | not yet | not_contacted | |
| @0xael.eth | 7 | not yet | not_contacted | |
| @felirami.eth | 8 | not yet | not_contacted | |
| @boiler | 9 | not yet | not_contacted | |
| @mvr | 10 | not yet | not_contacted | |
| @manan | 11 | not yet | not_contacted | |
| @borodutch | 12 | not yet | not_contacted | |
| @darrylyeo | 13 | not yet | not_contacted | |
| @nashrad | hold | not yet | not_contacted | docs-stress run only |
| @piratekev.eth | hold | — | dropped | last cast 530 days old — dead DM |

Vocabulary: `not_contacted` → `asked` → `running` → `completed` (with the cast URL, handle and UTC timestamp) /
`dropped` (naming the step they died on) / `no_reply` (after 48 h). A `dropped` row must name its friction-log
entry.

When a vouch lands, verify it from the hub before it goes into the submission reply — the read works from this
machine with no key, the recipe is in `VOUCHER-RECRUIT-TARGETS.md` §6.

Raw data behind every number in §2: `docs/evidence/voucher-candidates-top40.json` (top 40 of the 130 ranked
candidates: score, follower count, days since last cast, bio, last-cast text, why-chosen) and
`docs/evidence/voucher-send-queue-verified.json` (the 22 handles re-read at send-queue time). Reproduce with the
producers in the same directory: `fetch_network.py` (public hub → raw JSON) → `analyze_candidates.py` (rank) →
`refine.py` (recency + reach).

## 7. While they run it

Record every stumble in `docs/VOUCHER-FRICTION-LOG.md` as it happens: exact step, exact command, exact output,
time stuck. That file is what the fix task (`t_2e6fcb98`) consumes, and it must never need a follow-up interview.