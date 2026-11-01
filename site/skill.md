# Set up a Fiddy node + client (instructions for an AI agent)

Source of truth: the repository README, `docs/NODE-REQUIREMENTS.md`, and
`fiddy --help`. If this file and the code disagree, the code wins; tell the
person.

## What they get

Their own Farcaster node (Snapchain) on their own compute, and the Fiddy client
reading and writing through it. No API keys from anyone. A fresh node downloads
about 468 GB, briefly needs about 1.66 TB while unpacking, then settles near
597 GB before new blocks are added. Give it 2 TB free disk, 4 vCPU, and 16 GB RAM.

## 1. Check the laptop's free disk first

Your FIRST action is a read-only free-disk check on the person's laptop. Do this
before cloning, installing anything, starting a node, or creating a server.
Use `df -h /` on macOS or Linux, or the equivalent read-only disk query on
Windows. Tell them the result.

- **Under 1 TB free:** reject the local-node path now. Never start a local node
  and never retry one on that disk. Offer the free public relay at
  https://fiddy.fun/client/#networks or the managed card at
  https://fiddy.fun/client/deploy/#managedCard ($320/month) instead. The public
  relay reads Hypersnap, not Farcaster's Snapchain; say that plainly.
- **1 TB to under 2 TB free:** do not start a local node either. The measured
  first-boot peak is about 1.66 TB and 1.5 TB is at the edge. Offer a 2 TB rented
  machine or the managed card.
- **2 TB or more free:** their own machine can be the free local path, provided
  it also has 4 vCPU and 16 GB RAM and can stay awake.

**Disk-full death loop:** a too-small disk does not resume where it stopped. The
node fills the disk, restarts, and re-downloads from chunk 1 until it fills again.
Pre-check the disk; never respond to a full disk by retrying the same install.

If their disk is too small, stop here and help them choose the relay or managed
path. Do not make them install the node stack first.

## 2. Choose compute, with the price and wait stated up front

Before creating ANY server, state its recurring monthly price and get an
explicit yes from the person. A vague reply is not consent to spend. Do not
create, pay for, or provision anything before that yes.

- **Their own machine** (free): only after the disk check above passes. Use
  `fiddy node up --local` in step 3.
- **AWS** (default cloud, about **$285/month**): CloudShell one-liner or
  `fiddy provision --aws` from their laptop with the AWS CLI configured. Warn
  before they start: a new AWS account can take **0-2 days** to verify, and
  CloudShell may be unavailable during that wait. Offer GCP as the alternative.
- **GCP** (tested, about **$350/month**, with a **$300 new-user credit**): the
  Google Cloud Shell button at https://fiddy.fun/client or
  `fiddy provision --gcp`. Say that the credit is promotional, not a permanent
  free tier, and remind them to delete the VM when finished.
- **Hetzner** (about **EUR 120/month**): `fiddy provision --hetzner`. New
  accounts can be capped at 1024 GB volumes until support raises the quota.
- **OVHcloud** (about **$190/month**): `fiddy provision --ovh`.
- **Managed by Fiddy** (**$320/month**): https://fiddy.fun/client/deploy/#managedCard.
  Get an explicit yes to that monthly price before any payment or deployment.
- **A server they already have:** `fiddy provision --ssh user@host` from their
  laptop. If they are already SSH'd into that server, skip provisioning and use
  step 3 with `--local`.

**Where provisioning runs:** run `fiddy provision` FROM the laptop, never ON the
server being provisioned. If the server already exists and they are SSH'd into
it, do not provision again; install and run the node there instead.

**If the hosting company caps the disk:** new accounts can be limited to 1 TB,
which cannot safely finish the first boot. Ask support to raise the limit to
2 TB, choose another provider, or use the public relay and move later. Do not
retry against the same cap.

**If the outside world cannot reach the copy:** the firewall is blocking the
network connection. Open 3382/UDP to the network; allow 3381/TCP and 3383/TCP
only from the person's own IP for the HTTP and gRPC APIs.

## 3. Start the node and set waiting expectations

```sh
curl -fsSL https://fiddy.fun/client/install.sh | bash
```

Or clone `https://github.com/ivcained/fiddy`, enter `fiddy`, and run
`export PATH="$PWD/bin:$PATH"`. Then use `fiddy node up` for a remote target or
`fiddy node up --local` for this machine. The installer detects an SSH session:
inside a server it installs a missing local node; on a laptop it leaves the
2 TB node remote. It also installs the Herdr/Ovis Fiddy Console.

The first download has **5,690 pieces and about 468 GB total**. At the measured
10-20 MB/s it takes many hours; plan for overnight on a slow disk. Use this copy
at the matching point instead of implying that something is broken:

**At 0%:** Your computer is downloading the whole history of what everyone has
ever posted. There is no exact finish time yet; at 10-20 MB/s this takes many
hours. You can close this and come back. It keeps going on its own.

**At 34%:** About a third is down. It is pulling 10-20 megabytes every second.
Roughly 300 GB is left; speed depends on the connection and disk, so plan for
overnight. You can close this and come back. It keeps going on its own.

**At 99%:** The download finished. Now it unpacks everything into working space.
That step needs the full 2 TB free at once, then it shrinks to about 597 GB. A
few more minutes. You can close this and come back; you are nearly there.

Always explain: the copy will not answer requests until the whole history is
downloaded and unpacked. That is normal, not broken.

**If the copy is not answering yet:** a brand-new copy refuses requests until
that work finishes, which takes hours. Run `fiddy node logs` to watch progress,
then keep waiting; `fiddy node status` works after the load completes.

**If the laptop went to sleep:** a local computer pauses, so its download pauses
too. Keep it plugged in and awake, or move to a computer that stays on (about
$120-285/month to rent one). Closing a terminal window is fine; letting a local
laptop sleep is not.

**If the disk filled up:** it briefly needs about 2 TB, with a measured peak of
about 1.66 TB; a smaller disk fills and the download starts over from chunk 1.
Free space or move to a computer with 2 TB free before running it again. Never
retry on the same full disk.

## 4. Start the client

Run `fiddy client up` from the laptop, adding `--tunnel` when the node API is not
public. It installs Node.js and pnpm itself when missing. Open the printed
localhost URL with `open`, `xdg-open`, or `start` as appropriate, or give the
person the link.

## 5. Sign in without a seed phrase

Prefer delegated approval: their Farcaster phone app scans a QR code and
approves an app key. **Never ask for their seed phrase, never suggest pasting
one into chat or anything networked, and do not route them through seed import.**
If they paste one unsolicited, do not repeat it; tell them to revoke exposure
through their wallet's recovery process.

## Other failures

- `fiddy doctor`: machine and network check with the fix spelled out.
- `fiddy: command not found`: run `export PATH="$PWD/bin:$PATH"` in the repo, or
  `bin/fiddy install` once.
- Still stuck: https://github.com/ivcained/fiddy/issues with the command, the
  last 30 lines of output, and the OS. Never include tokens, keys, or seed phrases.

Docs: https://fiddy.fun/client (also Chinese: /client/zh/) · repo:
https://github.com/ivcained/fiddy
