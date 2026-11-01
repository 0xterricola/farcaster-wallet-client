# What a Snapchain mainnet read node actually needs

Measured on a real run on 2026-10-18 (Ubuntu 24.04, Docker 29.6.2, Snapchain
`v0.14.3` / `farcasterxyz/snapchain:latest`). Raw evidence:
`docs/RUN-REPORT-2026-10-18.md` and the captured node log in the run workspace.

Upstream states the requirement as **16 GB RAM, 4 vCPU, 1.5 TB free disk, a
public IP, ports 3381-3383 TCP+UDP**. That is the *steady state*. The first
boot needs more than that, and this is where fiddy's original 200 GB default
would have died.

## The first boot in numbers

The node starts by downloading historical snapshots (it is the only way a
fresh node reaches the chain tip in reasonable time):

| Stage | What it does | Size |
| --- | --- | --- |
| 1. Download chunks | 5,690 gzipped chunks (shard 0: 371, shard 1: 2,671, shard 2: 2,648) into `.rocks.snapshot/shard-<n>/` | ~468 GB compressed (mean 82.2 MB/chunk, n=264 measured, range 47-94 MB) |
| 2. Assemble the tar | gunzips every chunk into `shard_<n>_snapshot.tar` | ~597 GB uncompressed (each chunk expands to ~100 MiB; 104,850,944 B measured) |
| 3. Unpack | extracts the tar into `.rocks/` | ~597 GB in the database |
| 4. Cleanup | deletes `.rocks.snapshot` (chunks **and** tars) | frees ~468 GB + 597 GB |

Nothing is deleted until every shard is unpacked (`remove_dir_all(snapshot_dir)`
runs at the end), so the peak is roughly:

```
peak ≈ chunks + tars + database ≈ 468 + 597 + 597 ≈ 1.66 TB
steady state ≈ 597 GB  (then it keeps syncing blocks on top)
```

That is why:

* **200 GB** (fiddy's original `provision.sh` default) covers 2,434 of 5,690
  chunks — 43% — and never reaches the tar stage.
* **2 TB** (the new `--aws` default, matching Farcaster's own guide) fits the
  whole bootstrap with a little room.
* A "1.5 TB free" box is at the edge during bootstrap: give the node 2 TB or
  put `.rocks.snapshot` on its own scratch volume.

## Measured on the sandbox run

A 20 GB capped disk (deliberately small, to protect a shared host) filled at
chunk 254 of 5,690 and the node entered the failure mode below. This is the
general shape of what a too-small disk does, whatever its size:

```
WARN snapchain::storage::db::snapshot: Failed to download
  .rocks.snapshot/shard-1/chunk_0254.bin due to error:
  No space left on device (os error 28)
```

Retries are five attempts at 10s intervals per chunk, then the container exits
and `restart: always` brings it back — where it re-downloads from chunk 1 over
the same full disk and fills it again. It will not recover on its own: the data
directory is only cleaned up after a *successful* full bootstrap.

Observed throughput on a 4 vCPU VPS over a normal link: **~10-20 MB/s**, so a
full 468 GB download is **many hours** (upstream's "up to 2 hours" assumes a
much faster link). Budget time, not just disk.

## RAM and CPU

16 GB / 4 vCPU is right: the snapshot pipeline gunzips and tars on the host
(CPU-bound, disk-heavy), and the node holds RocksDB open afterwards. On a host
with other workloads, do not let the node take the whole box — but on a
dedicated box leave it unconstrained. fiddy's preflight refuses anything below
4 vCPU / 16 GB / 1536 GB free unless you pass `--force`.

## Ports and the API's start time

* 3381/tcp HTTP API, 3383/tcp gRPC, 3382/udp gossip (quic-v1). Publish 3381 and
  3383 to yourself only; 3382/udp must be reachable from the world or the node
  cannot join the gossip mesh.
* **The HTTP API refuses connections until the snapshot bootstrap finishes.** Measured:
  on a fresh node, `curl http://127.0.0.1:3381/v1/info` fails for the whole
  download. Upstream's "the API answers immediately" is wrong for a brand new
  node. Watch progress with `fiddy node logs`; `fiddy node status` starts
  working once the load completes.
* **Bootstrap time is disk-bound.** On a GCE e2-standard-4 with a Standard
  (pd-standard) HDD the ~470 GB of chunks took **over 6 hours** and counting
  (~5 chunks/min, ~88 MB each, 905 GB on disk at chunk #1935). Budget an
  overnight bootstrap on HDD-class disks; SSD cuts this substantially. The
  earlier "~2h" figure is the SSD best case, not the norm.

## Sharing a host with other services

Two hazards that bite when the node runs next to other workloads (the LC
gateway VPS is exactly this case):

1. **Grafana wants 127.0.0.1:3000.** `snapchain.sh upgrade` starts `statsd` and
   `grafana`, then waits for `http://127.0.0.1:3000/api/health` **with no
   timeout**. If :3000 is taken, that wait never ends and the node container is
   never started. fiddy detects the conflict, starts the node container from
   the compose file the installer already fetched, and stops the stalled
   script. You lose the metrics dashboard, nothing else.
2. **The auto-upgrade cron is hostile to a shared host.** It runs
   `docker system prune --volumes -f` — host-wide, not project-scoped. fiddy
   writes `SKIP_CRONTAB=true` into `.env` by default, and moves the node's
   statsd ports to `127.0.0.1:18125/18126` so they do not collide either.

To upgrade a node anyway without the cron, run `fiddy node upgrade` by hand.