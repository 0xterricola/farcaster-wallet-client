# Deploy your Farcaster read node on Google Cloud — one command

You are in **Google Cloud Shell** — gcloud is already signed in as you, and nothing
you type here leaves your project. This is command (0) of the three-command path:

```
0. provision compute   ← you are here
1. fiddy node up       ← installs + syncs your Snapchain read node
2. fiddy client up     ← the Fiddy client, reading from YOUR node
```

## 1. Pick a project

Usually automatic: the deploy script auto-selects your project when you have
exactly one, and prints a picker when you have several. To choose by hand:

```bash
gcloud config set project YOUR_PROJECT_ID
```

(New to GCP? The free trial's \$300 credit covers this node for weeks.)

## 2. Run the deploy

```bash
bash scripts/gcp-deploy.sh
```

It creates one firewall rule and one VM (`e2-standard-4`, Ubuntu 24.04, 2 TB disk),
installs Docker + cron, and prints the node's IP. Safe to re-run — it reuses what exists.

**Why a Standard (HDD) disk?** New GCP projects cap regional SSD at 500 GB and will
reject a 2 TB SSD. HDD has its own, larger quota. Cost runs about \$350/mo all-in
(VM plus 2 TB disk, measured on our own bill). **New customers get
[\$300 in free credit](https://cloud.google.com/free)** — the node is free to start,
but set a reminder now to delete the VM (or decide to keep paying) before the credit
runs out, so the bill never surprises you. Teardown prints at the end of the script.

## 3. Install the node

From any machine with this repo cloned and SSH access (this Cloud Shell works):

```bash
bin/fiddy provision --ssh $(whoami)@<IP-from-step-2>
bin/fiddy node up
```

The node downloads ~470 GB of snapshot chunks before its API answers — overnight on
HDD is normal. `bin/fiddy node status` shows progress; `bin/fiddy node verify` must
print all green before you continue.

## 4. Run the client

On your own computer (not Cloud Shell):

```bash
bin/fiddy client up
```

Then open the printed localhost URL. Full walkthrough of what just happened —
FIDs, custody keys, gasless app keys, read nodes vs validators — is at
**https://fiddy.fun/client**.
