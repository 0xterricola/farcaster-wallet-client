# Deploy your Farcaster read node on AWS — one command

Run this in **AWS CloudShell** — the terminal built into the AWS Console,
already signed in as you, free. Nothing you type leaves your account.

This is command (0) of the three-command path:

```
0. provision compute   ← you are here
1. fiddy node up       ← installs + syncs your Snapchain read node
2. fiddy client up     ← the Fiddy client, reading from YOUR node
```

## 1. Open CloudShell

[console.aws.amazon.com](https://console.aws.amazon.com) → click the
**CloudShell icon** (the `>_` in the top bar). Pick a region with capacity —
`us-east-1` is the default and what this script assumes.

## 2. Run the deploy

```bash
curl -fsSL https://raw.githubusercontent.com/ivcained/fiddy/main/scripts/aws-deploy.sh | bash
```

One command creates: a key pair (saved as `./fiddy-node.pem` — download it or
copy it somewhere safe, it's the only copy), a security group (SSH and the node
APIs answer **your IP only**; gossip ports open to the network), and an
`m5.xlarge` with Ubuntu 24.04, a 2048 GB gp3 disk, Docker and cron preinstalled.

**Cost honesty:** ~$285/mo at list price while it runs. The script prints the
exact terminate command at the end. (AWS has no broad free-credit program like
GCP's $300 — if you're new to cloud entirely, the [GCP path](GCP-DEPLOY.md) is
free to start; if you're already on AWS, this is the fewest-moving-parts path.)

## 3. Install the node

From any machine with the fiddy repo cloned and the `.pem` from step 2:

```bash
bin/fiddy provision --ssh ubuntu@<IP-from-step-2>
bin/fiddy node up
```

The node downloads ~470 GB of snapshot chunks before its API answers — overnight
is normal. `bin/fiddy node status` shows progress; `bin/fiddy node verify` must
print all green before you continue.

## 4. Run the client

```bash
bin/fiddy client up
```

Then open the printed localhost URL. The full protocol walkthrough — FIDs,
custody keys, gasless app keys, read nodes vs validators — is at
**https://fiddy.fun/client**.
