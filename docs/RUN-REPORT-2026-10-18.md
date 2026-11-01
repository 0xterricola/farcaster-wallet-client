# Three-command end-to-end run on real compute — 2026-10-18

What a judge would run, run for real:

```bash
git clone https://github.com/ivcained/fiddy && cd fiddy
fiddy provision --ssh <host>     # (0)
fiddy node up                    # (1)
fiddy client up --tunnel         # (2)
```

**Where.** Client host: macOS 27 (Apple Silicon), stock `/bin/bash` 3.2.7,
pnpm 10.8.1, Node 26.10.0. Node host: a real Ubuntu VPS over SSH (4 vCPU,
15 GB RAM, 55 GB free disk, Docker 29.6.2, 11 unrelated production containers
running — the exact shared-host case the spec names as the dogfood target).
The AWS path has no credentials in this environment, so `--aws` was verified
against local stubs of the `aws` CLI, not against real EC2; see "Not verified".

**Honesty first:** this run could **not** complete a mainnet full sync. A read
node wants 2 TB and up to a day of bandwidth (measured: 468 GB of snapshot
chunks at ~10-20 MB/s, peak ~1.66 TB with scratch — `docs/NODE-REQUIREMENTS.md`).
The available host had 55 GB. The run was therefore cut to a **20 GB capped
sandbox** on that host so it could not endanger the other containers, and it
was taken exactly to the wall: the node filled the disk at chunk 254 of 5,690,
which is where the storage requirements in this repo came from.

## What broke, in the order a judge would hit it

| # | Where | Symptom | Fix |
| --- | --- | --- | --- |
| 1 | `cli/provision.sh:52`, `cli/lib/common.sh:55,61`, `cli/client.sh:50` | `mapfile: command not found` — `fiddy provision --ssh` dies instantly on any stock macOS (`/bin/bash` 3.2, and `mapfile` is bash 4+) | ssh options are built into an array without bash-4 builtins; the entry point refuses to run under `sh` |
| 2 | `cli/provision.sh` | Help and defaults said "Minimum … 200 GB SSD" and created a 200 GB volume. 200 GB covers 43% of the chunk download and never reaches the tar/unpack stages | `--aws` now defaults to a 2048 GB gp3 volume (`FIDDY_AWS_VOLUME_GB`), m5.xlarge, an authenticated-credentials check before creating anything, an honest cost estimate, and the documented 3381-3383 TCP+UDP rules instead of the dead 3384 pair |
| 3 | `cli/node.sh` | `fiddy node up` died with `main: line 83: /dev/tty: No such device or address`. `snapchain-bootstrap.sh` ends in `exec ./snapchain.sh upgrade < /dev/tty`, so piping it into bash over SSH cannot work at all | fetch `snapchain.sh` directly and run it detached; no tty needed |
| 4 | same | `snapchain.sh` refuses to run without `AGREE_NO_REWARDS_FOR_ME=true` and, with no terminal, **stops every container and exits** | `.env` is pre-seeded (agreement, operator FID, `SKIP_CRONTAB=true`, loopback statsd ports) before the installer runs |
| 5 | `cli/node.sh` | Nothing waited for anything real: `snapchain.sh start/stop` do not exist (the real verbs are `up`/`down`), and the `start` call was wrapped in `|| true`, so failures were invisible | `start`/`stop`/`upgrade` map to real commands; the installer runs detached with its output in `~/snapchain/upgrade.log` |
| 6 | same | Nothing prevented filling a host that cannot hold the node | preflight measures vCPU/RAM/free disk/in-use ports on the target and refuses below 4 vCPU / 16 GB / 1536 GB free unless `--force` |
| 7 | same | `snapchain.sh upgrade` explicitly installs a weekly cron that runs `docker system prune --volumes -f` **host-wide** — on a server with other workloads that is a footgun | `SKIP_CRONTAB=true` by default; statsd moved to `127.0.0.1:18125/18126` |
| 8 | same | `snapchain.sh upgrade` waits for Grafana at `127.0.0.1:3000` **with no timeout**. That port was already taken on the target, so the node container was never started and the installer hung forever | fiddy detects the conflict, starts the node container from the compose file the installer fetched, and stops the stalled script (no metrics dashboard, nothing else lost) |
| 9 | `cli/node.sh` | `fiddy node up` waited for `/v1/info` with a 10-minute budget. A fresh node **refuses HTTP for the entire snapshot bootstrap** (measured: connections refused on :3381 for the whole download), so this died on every healthy first boot | `node up` now reports bootstrap progress (container state, chunk N of 5,690) and hands off to `fiddy node status` instead of blocking for hours |
| 10 | `cli/client.sh` | `fiddy client up` died when the node was not answering yet — guaranteed, because of #9 | warns and starts the client anyway |
| 11 | same | The dev server never came up: `Failed to resolve entry for package "farcaster-analytics"` — the workspace packages ship as `dist/` builds that a fresh clone has not built | `client up` builds the five packages the web app imports (`pnpm build:packages`) when their `dist/` is missing |
| 12 | same | A tunnel left over from an earlier run made the next run print raw ssh noise (`bind [127.0.0.1]:3381: Address already in use`) | an existing forward on 3381 is detected and reused |
| 13 | `cli/node.sh` | The teardown `pkill` matched the shell running it and killed the SSH session (exit 255, mid-install) | bracketed pattern (`snapchain[.]sh upgrade`) so the killer cannot kill itself |
| 14 | `cli/client.sh`, README | The client was described as reading from your node. Nothing read `VITE_SNAPCHAIN_HTTP_URL`; the running app requested `https://farcaster.xyz/~api` | `fiddy client up` and `fiddy client check` **detect** whether the web app imports `farcaster-node-client` and report that state instead of a fixed claim; README and `docs/CLIENT-NODE-GAP.md` record the gap, the `localhost:8080` seam and the path to close it |
| 15 | `cli/node.sh` | During re-verification: `line 118: base<garbled>: unbound variable`. Under bash 3.2 the ellipsis immediately after `$base` is absorbed into the variable name, so `set -u` kills the script | `${base}…` (braced); no `$var` is followed directly by a non-ASCII byte anywhere in the CLI |

## Verified on real compute (post-fix)

Command output captured in the run workspace (`evidence/`).

* **`fiddy doctor`** — prerequisites, node version check, config display.
* **`fiddy provision --ssh root@<host>`** — reaches the target, reports
  `fiddy-ok / Linux x86_64 / Docker 29.6.2`, saves the target, and runs the
  preflight with real numbers:

  ```
  Preflight — Snapchain mainnet read node needs 4 vCPU, 16 GB RAM, 1536 GB free disk
    vCPU:                  4 (need 4)
    RAM:                   15 GB (need 16)
    free disk ($HOME):     54 GB (need 1536)
    ports already in use:  3000,
  ! port 3000 is taken — snapchain.sh's Grafana step cannot bind and will wait indefinitely.
  ```

* **`fiddy node up --force`** — installs `snapchain.sh` (`.env` seeded, no
  cron), pulls `farcasterxyz/snapchain:latest`, starts the container, and then
  reports the bootstrap. The container came up and really did start the
  mainnet snapshot:

  ```
  Persisted metadata to .rocks.snapshot/metadata.json
  Starting download of 5690 chunks across 3 shards
  ```

  264 chunks were downloaded at a mean 82.2 MB/chunk before the 20 GB cap was
  reached, then the disk-full failure mode was captured verbatim:

  ```
  WARN snapchain::storage::db::snapshot: Failed to download
    .rocks.snapshot/shard-1/chunk_0254.bin due to error:
    No space left on device (os error 28)
  ```

  followed by the container restart loop (5 restarts) that a full disk causes.
  Snapshot metadata (shard 0: 371, shard 1: 2,671, shard 2: 2,648) and the
  full node log are kept with this report's evidence.
* **`fiddy node status` / `fiddy node verify`** — both run; against a bootstrapping
  node they report exactly that instead of pretending:
  `/v1/info: FAIL (no response)`, `/v1/castsByFid: FAIL (no response)`,
  `/v1/signersByFid: FAIL (no response)`, with the explanation that the API
  starts after the snapshot load. `verify` is the scripted form of the bounty's
  acceptance checks and will pass once a node has finished bootstrapping.
* **`fiddy client up --tunnel`** — opens the SSH tunnel, records the node URL,
  builds the workspace packages, and serves the Fiddy client:
  `<title>Fiddy</title>` from `https://localhost:5174/`. Runtime evidence of the
  read path, straight from the running app's module graph:

  ```
  const upstreamApiUrl = "https://farcaster.xyz/~api";
  const baseApiUrl = useLocalApi ? "http://localhost:8080" : isProd ? productionApiUrl : upstreamApiUrl;
  ```
* **`fiddy provision --aws`** — exercised against stub `aws`/`ssh` binaries
  (no credentials here): credentials check → AMI lookup → key pair → security
  group → instance run with a 2048 GB gp3 volume on an m5.xlarge → config
  written, with a `$304/month` list-price estimate printed before anything is
  created. The security group it requests:

  ```
  tcp 22   → your IP      tcp/udp 3381-3383 → your IP      tcp/udp 3382 → 0.0.0.0/0
  VolumeSize=2048,VolumeType=gp3      instance-type m5.xlarge
  ```

## Not verified (and why)

1. **A finished mainnet sync** — needs ~2 TB of disk and hours of download;
   the available host had 55 GB free and runs unrelated production containers.
   Everything downstream of the sync (a feed read from the node, a gasless
   `KEY_ADD` showing in `/v1/signersByFid`, a cast submitted and queried back)
   is blocked on that, not on fiddy.
2. **Real AWS provisioning** — no AWS credentials in this environment. The
   `--aws` script is verified structurally (stubs) and its numbers/paths against
   the official guide; running it spends money and needs an `aws configure`.
3. **Client reads served by the node** — the app's data layer still uses
   Farcaster's hosted API (see `docs/CLIENT-NODE-GAP.md`); `farcaster-node-client`
   exists but is uncommitted and unused. `fiddy client up` does not claim
   otherwise.

## Reproducing the safe version of this run

```bash
# on a host you do not want to risk filling: cap the node's disk first
truncate -s 20G /root/fiddy-sandbox.img && mkfs.ext4 -q -F /root/fiddy-sandbox.img
mount -o loop /root/fiddy-sandbox.img /mnt/fiddy
mkdir -p /root/snapchain/.rocks /root/snapchain/.rocks.snapshot
mount --bind /mnt/fiddy/rocks /root/snapchain/.rocks
# …and cap its memory (a 16 GB node on a 15 GB host with 9 GB in use is an OOM
#   hazard for everything else): services: snapchain: mem_limit: 5g in
#   ~/snapchain/docker-compose.override.yml (the installer never touches that file)
fiddy provision --ssh root@<host> && fiddy node up --force
```