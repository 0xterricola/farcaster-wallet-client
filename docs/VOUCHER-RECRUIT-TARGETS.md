# Fiddy bounty — who to DM for the one vouch we need

Status 2026-10-18 (IST). Companion to `docs/VOUCHER-CAMPAIGN.md`. Deadline **2026-10-24T14:47:30Z**
(Sat 20:17:30 IST). Every handle below was read out of the live network today, not guessed.

## 1. The gate, restated

The bounty requires "**at least one other human** goes through the tutorial, creates a read node and client,
then posts a public Farcaster cast vouching for the quality of the work". Our submission is otherwise finished
(microsite live, repo public + MIT, reply written). **Nothing else on the card is blocked except this.**
Vouch content requirements and the cast template are in `VOUCHER-CAMPAIGN.md` §8.

New fact this run: **a public hub is reachable from the owner's machine** (`https://haatz.quilibrium.com`),
so the vouch can be verified programmatically the moment it exists — see §6. Posting still needs a Farcaster
account (no app key or custody key exists on this machine), so sending a DM is a human action.

## 2. Tier 1 — cross-vouch: they are recruiting a tester too (highest conversion)

Five entrants are in exactly our position and said so in public, in the bounty thread. A cross-run is the
cheapest honest deal available on this board: we run theirs and post an honest review, they run ours and post
theirs. Ordered by how well they convert.

| # | Handle | FID / followers | What they said (verbatim, UTC) | Why they convert |
| --- | --- | --- | --- | --- |
| 1 | **@mobeen02** | 440212 / 2.4k | Submission posted with "**(3) Voucher: (getting voucher, will update)**" (10-17 17:41) + standalone "Need a voucher for Balaji's $2048 Farcaster bounty 🙏" (10-17 17:39) | Already shipping, already stuck on the same gap, mainland-timezone overlap |
| 2 | **@vaibhavmule** | 1356870 / 3.3k | "I'm in. 3 commands, my own read node, no API keys. **Looking for a builder to test it and vouch. Who's up?**" (10-17 15:18) | Explicitly asking for a voucher partner, no voucher yet |
| 3 | **@sats100m** | 3355244 / 0 | "**need 3-5 people to run it this week and tell me where it breaks**" — node 17% through a 470 GB snapshot (10-17 21:05) | Wants testers badly; a run of his is cheap goodwill to trade |
| 4 | **@0xzoz** | 1918 / 13.1k | "Looking for two independent testers to run In Three end to end by Oct 23, 14:47 UTC: • 1 human-led clean-machine run • **1 agent-led clean-machine run**" (10-18) | Largest account in the field, and they explicitly want an **agent-led** run — the one thing this machine can supply outright |
| 5 | **@webthe3rd.eth** | 374565 / 220 | "I'm gonna work on a submission to this bounty. **Any devs willing to test and vouch for it later this week?**" (10-17 22:20) | Asked publicly and got no answer yet |

**The @0xzoz trade is the strongest lead on the whole board.** They need an agent-led clean-machine run of
In Three by 2026-10-23T14:47Z, a day before our deadline. We can deliver that (a Hermes agent on a clean
machine, logs + screenshots + honest failure list) in exchange for a human clean-machine run of Fiddy that
ends in a vouch cast. Both halves are real work, both are verifiable, and neither side pays the other.

DM copy for tier 1 (one message; keep it short, they are builders in the same race):

```
Hey — saw your post in Balaji's client bounty thread. I'm in the same boat: my tutorial is done
(https://fiddy.fun/client), no API keys, three commands, and the only thing I'm missing is the
independent vouch the brief asks for.

Want to trade runs? You run mine on a clean box, tell me honestly where it breaks, and cast the
vouch; I do the same for yours and post my real review — plus, if it helps, I can put an agent
on a clean machine for the test you're short of (@0xzoz's ask is an agent-led run for In Three;
for everyone else it's a straight human-for-human swap).

The honest ask on my side: 4 vCPU / 16 GB RAM / 1.5-2 TB free disk, ports 3381-3383 open, a test
account's seed phrase (never a main account), and half a day where most of it is the node syncing.
A ~$50-80/mo 2 TB VPS is enough — `fiddy provision --ssh you@box` handles any host.
```

## 3. Tier 2 — node operators: they already own the hardware

These handles were found discussing Snapchain nodes on Farcaster today. For them the ask is nearly free —
they run this infrastructure or write tooling for it, so the vouch is a peer review, not a favour.

| Handle | FID / followers | Evidence |
| --- | --- | --- |
| @piratekev.eth | 13525 / 151 | "Here's some infrastructure code to run a snapchain node on kubernetes with persistent storage" (`standard-crypto/snapchain-gcp`) |
| @topocount.eth | 20603 / 1.6k | Posts the node-runner release notes: "A new snapchain release is out! Node runners will want to upgrade before Thursday, October 22" |
| @0xael.eth | 539854 / 1.3k | Runs SnapMeter; "Snapchain data is acquired via @neynar API, and Hypersnap data is syncing with a local node" |
| @felirami.eth | 196149 / 4.9k | "Making it easier to run a Hypersnap node" |
| @boiler | 14217 / 708 | "Who is running either a snapchain node or a replicator?" |

Pitch for tier 2 (lead with what is in it for them — nothing to install, a second independent implementation
of the node path they already run):

```
You already run a Snapchain node, so you'll see what's wrong with mine in ten minutes.

I built a three-command path to a read node + client (no API keys, no third parties):
https://fiddy.fun/client · https://github.com/ivcained/fiddy — MIT.

If you'll run it on a clean box and cast an honest vouch, I'll take the criticism as the deliverable:
anything you trip on gets fixed and credited in the tutorial. Trade for the same on your project, or
just tell me where it breaks — a public vouch is what the brief wants.
```

## 4. Tier 3 — engage, do not pitch

- **@10xchris.eth** (1129138 / 1.4k) — the handle this card originally mis-attributed the bounty to. He ran
  and won the previous Farcaster-client bounty and, on 10-18 05:10, published verified infra pricing against
  Snapchain's documented requirements (Netcup ≈ A$103/mo, AWS ≈ A$442/mo, Akash ≈ A$310/mo). He also raised
  the strongest technical objection in the thread on 10-17 15:13: entering an existing seed phrase into a new
  client is an unnecessary risk when delegated signer authorization exists. **Our tutorial already agrees with
  him** (`/client` §2, the safety pane: test account only, prefer delegated signer authorization). Answering
  his objection with our own text and letting him decide is how he becomes a voucher — do not ask him first.
- **@0xael.eth** asked how the winner is selected (meritocracy vs. redistribution). Ignore; not our fight.
- **@baseddesigner.eth**, **@darrylyeo**, **@vaipraonde**, **@mvr** — the "I'd like to run a NODE" crowd. They
  want a node path, which is exactly what we ship; a reply that answers one of them with the three commands is
  marketing that costs nothing.

## 5. Where to post, and in what order

1. **DMs to tier 1, today.** One message each, no follow-up for 24h. These are the only people with the same
   deadline pressure.
2. **A reply in the bounty thread** pointing at the three commands and asking for one clean-machine run. The
   thread is where all 37 replies and every other entrant already are; a standalone cast reaches nobody.
3. **One public ask cast** (copy in `VOUCHER-CAMPAIGN.md` §7) in `/farcaster`, standalone, with the microsite
   link — this doubles as marketing for the tutorial.
4. **Answer @10xchris.eth's seed-phrase objection** in the thread with our own safety text. That is the one
   line in the whole thread aimed at us whether or not he knew it.

Do not promise prize money, a cut, or speed. Do say the run is honest and that a "your thing is broken here"
answer is a complete success as far as we are concerned.

## 6. Verifying the vouch the moment it lands

Read the thread back from the public hub (no key needed, works from this machine):

```bash
H=0x50184b62b4c52fd76628713562e1eda3dccaf63d   # the bounty cast
curl -s "https://haatz.quilibrium.com/v1/castsByParent?fid=37&hash=$H&pageSize=50" | python3 -m json.tool | head
# then, for the voucher's own cast:
curl -s "https://haatz.quilibrium.com/v1/castsByUser?fid=<VOUCHER_FID>&pageSize=25" | python3 -m json.tool | grep -i fiddy
```

A vouch counts when: it is public, from the voucher's own FID, names that they ran the tutorial
(node + client), says whether it was any good, and links https://fiddy.fun/client. Then paste its
`farcaster.xyz` URL into `docs/SUBMISSION-REPLY.md` and post the reply.

## 7. If they trip

Log it in `VOUCHER-CAMPAIGN.md` §5 with the exact command and error, fix it, then ask the voucher to re-run
that step. Two trip points are already known and being fixed (disk sizing: the box needs 1.5-2 TB free, not
the 200 GB the page used to say; and the AWS price, ~$285/mo at 2 TB, not ~$100). Tell a prospective voucher
both numbers up front — a voucher who feels misled about cost is a voucher who goes quiet.