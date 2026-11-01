# Bounty cast + hard deadline — pinned, single source of truth

Status: **VERIFIED** (not an estimate). Written 2026-10-18T15:27Z for the submission task (`t_48a3e97d`).
Supersedes the working assumption of "~2026-10-25" and the "cast by 10X Chris" attribution on the handoff card.

## 1. The cast (permalink captured verbatim)

```
https://farcaster.xyz/balajis.eth/0x50184b62
```

| Field | Value |
| --- | --- |
| Permalink (verbatim) | `https://farcaster.xyz/balajis.eth/0x50184b62` |
| Cast hash (full) | `0x50184b62b4c52fd76628713562e1eda3dccaf63d` |
| Author | **@balajis.eth**, FID **37** |
| Parent URL | `chain://eip155:7777777/erc721:0x4f86113fc3e9783cf3ec9a552cbb566716a57628` |
| Posted — Farcaster epoch | `182789250` (seconds since 2021-01-01T00:00:00Z) |
| Posted — unix | `1792248450` |
| **Posted — ISO-8601** | **`2026-10-17T14:47:30Z`** = 2026-10-17 20:17:30 IST |
| Text sha256 | `6b6754594baaf814073c110a367af5755fdfe93863f1adc3c9830d0041f7e18b` (2784 chars) |

Text opens `$2048 FOR FARCASTER CLIENTS` and matches the brief on this board line for line.

## 2. The deadline

Verbatim from the cast (the only deadline rule that exists):

> Deadline: your reply with three URLs must be submitted within seven days exactly from this post's timestamp.

- **Hard deadline: `2026-10-24T14:47:30Z`** — Saturday 2026-10-24 **20:17:30 IST**.
- **Recommended submit-by (48h early): `2026-10-22T14:47:30Z`** (2026-10-22 20:17:30 IST).
- Absolute fallback if the voucher lands late: post by `2026-10-23T14:47:30Z` (24h of slack).

## 3. Who confirmed it, and on what evidence

| Source | What it establishes | Independent of the others? |
| --- | --- | --- |
| **Owner** — the bounty link was supplied by the project owner in chat and is recorded in the board history of `t_b05919fc` (comment, 2026-10-18 20:10 IST: "owner supplied the link in chat") | that this is the cast the bounty refers to | no |
| **Protocol read (primary evidence)** — live `GET https://haatz.quilibrium.com/v1/castById?fid=37&hash=0x50184b62b4c52fd76628713562e1eda3dccaf63d`, re-run 2026-10-18T15:21Z | hash, author FID, exact timestamp, full text incl. the deadline sentence. Artifact: `evidence/bounty-cast-verified.json` | **yes** — this is the cast as signed and stored by the network, not a UI or an index |
| **Public web render of the permalink** — `farcaster.xyz/balajis.eth/0x50184b62` fetched and extracted; also present in the search index with title `@balajis.eth on Farcaster: "$2048 FOR FARCASTER CLIENTS…"` | the permalink resolves, is public, and is authored by @balajis.eth | **yes** — path independent of the hub |

Author handle confirmed as `balajis.eth` from the hub's `userDataByFid?fid=37`, not from a second-hand listing.

Reproduce:

```bash
curl -s "https://haatz.quilibrium.com/v1/castById?fid=37&hash=0x50184b62b4c52fd76628713562e1eda3dccaf63d" \
  | python3 -c 'import json,sys,datetime; d=json.load(sys.stdin)["data"]; print(datetime.datetime.fromtimestamp(1609459200+d["timestamp"],datetime.timezone.utc).isoformat())'
# -> 2026-10-17T14:47:30+00:00
```

## 4. Correction: the bounty cast is not 10X Chris's

@10xchris.eth is **FID 1129138**. Its 600 most recent casts (newest first, back to Farcaster epoch `175015615` ≈ 2026-07-19) contain no cast with the bounty text — scanned live 2026-10-18. 10X Chris appears in the thread as an entrant/commenter (published infra pricing for the same requirements), not as the bounty author. Anywhere the board still says "bounty cast by 10X Chris", read it as **@balajis.eth**.

## 5. What this pins for the submission task (`t_48a3e97d`)

1. Reply target: the permalink in §1, threaded under it (**not** a new top-level cast).
2. Post before `2026-10-24T14:47:30Z`; treat `2026-10-22T14:47:30Z` as the real target.
3. The voucher's public cast URL must exist and be public before posting — it is the long pole, so it should be in hand by 2026-10-22 at the latest.
4. Remaining time from 2026-10-18T15:21Z: **5 days 23h 26m** to the hard deadline, **3 days 23h 26m** to the 48h-early target.

## 6. Unverified / open

- Nothing about the deadline is unverified. The "~2026-10-25" figure in the original spec is **wrong** and is recorded here as retired.
- The one thing no worker can supply is a **human voucher** and a **signed cast** (posting needs an app key authorised by the owner's FID). Both remain owner actions.