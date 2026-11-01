# shellcheck shell=bash
# fiddy node — command (1): a read node on your compute.
#
# Two networks are on the menu (`--network snapchain|hypersnap`), and this
# command only installs the one it can install reproducibly: Snapchain. The
# Hypersnap path is real (upstream publishes a bootstrap, a compose file and an
# image) but the install as published does not produce a node that follows the
# chain, so fiddy prints what is known and stops — see cli/networks.sh and
# docs/NETWORK-CHOICE.md. Reading Hypersnap needs no node at all:
# `fiddy client up --network hypersnap`.
#
# A read node (read_node = true) follows the chain, stores full state, and
# serves the HTTP + gRPC APIs. Anyone can run one; no keys, no permission.
# It also accepts submitMessage and gossips valid messages to validators —
# it has no mempool of its own, so confirm inclusion via MERGE_MESSAGE events
# or by querying the message back.
#
# Install notes (these are the difference between "works over SSH" and not):
#   * snapchain-bootstrap.sh ends in `exec ./snapchain.sh upgrade < /dev/tty`,
#     so piping it into bash on a headless session dies with
#     "/dev/tty: No such device or address". We fetch snapchain.sh directly.
#   * snapchain.sh refuses to run without AGREE_NO_REWARDS_FOR_ME=true in .env
#     and, when it is not attached to a terminal, stops every container and
#     exits. We pre-seed .env, so the install is unattended.
#   * snapchain.sh `upgrade` ends by tailing container logs with -f, which
#     never returns over SSH. We run it detached and follow its log file.
#   * the auto-upgrade cron it installs runs `docker system prune --volumes -f`
#     against the whole Docker host — hostile on a server that runs anything
#     else, so we set SKIP_CRONTAB=true by default.

node_main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    up)      node_up "$@" ;;
    status)  node_status ;;
    verify)  node_verify ;;
    logs)    node_logs ;;
    dashboard) node_dashboard ;;
    autoupgrade) node_autoupgrade "$@" ;;
    stop)    node_stop ;;
    start)   node_start ;;
    upgrade) node_upgrade ;;
    -h|--help|"")
      cat <<'EOF'
fiddy node — manage your read node.

  up [--network snapchain|hypersnap] [--local] [--force]
                 Install a read node on the target, start syncing, and wait
                 until the HTTP API answers. --local runs on this machine
                 instead of the provisioned target. --force installs on a
                 machine that fails the requirements preflight (it will stop
                 when the disk fills).
                 --network picks which network the node follows (default
                 snapchain). snapchain: Farcaster's own network, the one every
                 account, cast and follow lives on — pick this. hypersnap: an
                 independent parallel network built by the Quilibrium
                 community, for explorers. Hypersnap cannot be installed
                 unattended yet and this command says so instead of pretending
                 (see: fiddy node up --network hypersnap).
  status         Print sync status from /v1/info. While the snapshot bootstrap
                 runs (the API refuses HTTP), print the container's status and
                 download progress instead — from the node itself, or over SSH
                 from the machine that provisioned it.
  verify [fid]   Run the acceptance checks against the node's HTTP API:
                 health, reads served by this node, signer list. Default FID
                 is 3 (dwr.eth); pass any FID you can check.
  logs           Tail node logs (Ctrl-C to stop).
  dashboard      Open the node's Grafana dashboard (sync height, peers,
                 shard stats) via an SSH tunnel on http://localhost:3000.
                 Grafana ships with the official snapchain.sh install.
  autoupgrade on|off [--every weekly|daily|hourly]
                 Auto-upgrades on a schedule (default: weekly, Tue 03:00).
                 Works on the provisioned target or a --local node.
                 Default OFF because the upstream job ends with
                 `docker system prune --volumes -f` on the whole host —
                 safe on a dedicated box, hostile on a shared one. Hourly
                 also restarts the node 24×/day; prefer daily if unsure.
  start | stop   Start / stop the node's containers (non-blocking).
  upgrade        Re-run the official installer, pulling the latest release.

Requirements for a mainnet read node: 4 vCPU, 16 GB RAM, 1.5 TB free disk,
public IP, ports 3381-3383 reachable (gossip uses 3382/udp).

Reading Hypersnap needs no node: fiddy client up --network hypersnap reads the
public Hypersnap node.
EOF
      ;;
    *) die "unknown node command: $sub" ;;
  esac
}

node_up() {
  local local_mode=0 force=0 network="$FIDDY_DEFAULT_NETWORK"
  while [ $# -gt 0 ]; do
    case "$1" in
      --local) local_mode=1 ;;
      --force) force=1 ;;
      # Both spellings, because both are what people type:
      #   fiddy node up --network hypersnap   (this repo's CLI)
      #   fiddy node snapchain                (the shorthand other CLIs use)
      --network) shift || true; network="${1:-}" ;;
      snapchain|hypersnap) network="$1" ;;
      *) die "unknown option: $1 (try: fiddy node --help)" ;;
    esac
    shift
  done
  [ "${FIDDY_ALLOW_UNDERSIZED:-0}" = 1 ] && force=1
  network_require_known "$network"

  # A network fiddy will not install: say what is known, and stop. Installing
  # something that reports itself healthy while falling behind is worse than
  # refusing, and pretending is not an option.
  if ! network_install_supported "$network"; then
    step "Setting up a $(network_plain_name "$network") read node"
    hypersnap_install_report
    hypersnap_refuse
  fi

  step "Setting up a $(network_plain_name "$network") read node"
  log "What you're getting: a read node (read_node = true). It follows the chain,"
  log "stores full state, serves HTTP :$SNAP_HTTP_PORT + gRPC :$SNAP_GRPC_PORT, and"
  log "relays your writes to validators over gossip. No API keys. Your compute only."
  log "First boot downloads the historical snapshot from Farcaster's public bucket"
  log "(up to ~2h), then it syncs blocks."

  if [ "$local_mode" = 1 ]; then
    node_install_local "$force"
  else
    node_install_remote "$force"
  fi

  # Record which network this node follows: reads from two networks look
  # identical on the wire, so the one thing that can name the network later is
  # the thing that installed it.
  config_set FIDDY_NODE_NETWORK "$network"
  ok "network recorded: $network (fiddy config shows it; fiddy client up passes it on)"
}

node_install_remote() {
  local force="${1:-0}"
  require_target
  log "target: $FIDDY_TARGET"

  preflight_remote
  preflight_verdict "$force"

  log "ensuring Docker…"
  remote_ensure_docker

  # snapchain.sh gates on crontab; minimal cloud images (GCE Ubuntu) lack it
  # and the installer dies AFTER statsd/Grafana are already up, leaving a
  # confusing half-install. Install cron first.
  log "ensuring cron (snapchain.sh requires crontab)…"
  ssh_run 'command -v crontab >/dev/null 2>&1 || { sudo -n apt-get update -qq && sudo -n apt-get install -y -qq cron >/dev/null && sudo systemctl enable --now cron >/dev/null 2>&1; }; command -v crontab >/dev/null 2>&1 && echo cron-ok' | grep -q cron-ok \
    || die "cron is missing on $FIDDY_TARGET and needs sudo to install (sudo apt-get install -y cron), then re-run."

  log "installing Snapchain (official snapchain.sh, fetched directly)…"
  remote_seed_snapchain_env
  local grafana_blocked=0
  case ",$PREFLIGHT_PORTS," in *",3000,"*) grafana_blocked=1 ;; esac
  remote_start_upgrade "$grafana_blocked"

  local host="${FIDDY_TARGET#*@}"
  node_wait_or_report "http://$host:$SNAP_HTTP_PORT" "$host"

  config_set FIDDY_NODE_HTTP "http://$host:$SNAP_HTTP_PORT"
  config_set FIDDY_NODE_GRPC "$host:$SNAP_GRPC_PORT"
  echo ""
  ok "Read node installed: http://$host:$SNAP_HTTP_PORT (gRPC $host:$SNAP_GRPC_PORT)."
  ok "Next: fiddy client up"
}

# A brand new node does NOT serve HTTP while it downloads the snapshot — the
# API starts after the load (measured 2026-10-18: connections refused on
# :3381 for the whole bootstrap). So: report progress instead of blocking for
# hours. `fiddy node status` is the "is it up yet" command afterwards.
node_wait_or_report() {
  local base="$1" host="$2" tries="${3:-24}" i
  log "waiting up to $((tries * 5))s for the node API at ${base}…"
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS --max-time 5 "$base/v1/info" 2>/dev/null | node_info_summary; then
      printf '\n'
      ok "node API is up: $base"
      return 0
    fi
    printf '\r\033[K%s' "$(snapshot_progress)"
    sleep 5
  done
  printf '\n'
  warn "the API is not answering yet — a fresh read node refuses HTTP until the"
  warn "snapshot bootstrap finishes (up to ~2h, ~470 GB of chunks; see"
  warn "docs/NODE-REQUIREMENTS.md). This is expected on first boot."
  local status progress
  status="$(ssh_run 'docker ps --filter name=snapchain-snapchain-1 --format "{{.Status}}"' 2>/dev/null || true)"
  progress="$(ssh_run 'docker logs snapchain-snapchain-1 2>&1 | grep -oE "chunk_[0-9]+\.bin" | tail -1' 2>/dev/null || true)"
  if [ -n "$status" ]; then log "container: $status"; fi
  if [ -n "$progress" ]; then log "snapshot download at: $progress of 5690"; fi
  log "watch it: fiddy node logs      (or: fiddy node status once the bootstrap ends)"
  return 0
}

node_install_local() {
  local force="${1:-0}"
  require curl "install curl"

  preflight_local
  preflight_verdict "$force"

  if ! command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
    if [ "$(uname -s)" = "Linux" ]; then
      # Headless Linux: there is no Docker Desktop here. Install the engine.
      log "Docker missing — installing the engine via get.docker.com…"
      if sudo -n true 2>/dev/null; then
        curl -fsSL https://get.docker.com | sudo sh >/tmp/fiddy-docker-install.log 2>&1 \
          && sudo usermod -aG docker "$USER" \
          || die "Docker install failed — see /tmp/fiddy-docker-install.log"
        # Group membership applies to new shells; re-exec ourselves inside one
        # (sg) so the user never has to run the command twice. NOTE: $* here is
        # this function's own args (the force flag), NOT the user's — rebuild
        # the command from the flags we actually know.
        warn "Docker installed. Restarting this command ONCE so the new docker group applies — not a retry, nothing failed."
        if command -v sg >/dev/null 2>&1; then
          local again="--local"
          [ "$force" = 1 ] && again="$again --force"
          exec sg docker -c "'$FIDDY_REPO/bin/fiddy' node up $again"
        fi
        warn "log out and back in (or run: newgrp docker), then re-run: fiddy node up --local"
        exit 0
      else
        die "Docker missing and sudo needs a password. Run: curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER — then log out/in and re-run."
      fi
    else
      local answer=""
      if [ -t 0 ]; then
        printf 'Docker is required for the node. Install Docker Desktop now? [y/N] '
        read -r answer || true
      fi
      case "$answer" in
        [yY]*) open -a Docker 2>/dev/null || true
               log "waiting for Docker Desktop…"
               local i
               for ((i = 1; i <= 60; i++)); do
                 docker info >/dev/null 2>&1 && break
                 sleep 5
               done ;;
        *) die "install Docker first: https://docs.docker.com/get-docker/  (or run: fiddy node up --ssh-target …)" ;;
      esac
    fi
  fi

  mkdir -p "$FIDDY_HOME/snapchain"
  # Upstream reexec_as_root_if_needed() hard-codes `cd ~/snapchain` before sudo.
  # Our local install lives in ~/.fiddy/snapchain, so without this link the
  # bootstrap dies instantly with "Failed to switch to ~/snapchain directory"
  # and the wait loop shows "preparing" forever. Only link when nothing is there.
  if [ ! -e "$HOME/snapchain" ]; then
    ln -s "$FIDDY_HOME/snapchain" "$HOME/snapchain"
  fi
  ( cd "$FIDDY_HOME/snapchain" && fetch_snapchain_script && seed_env_file && start_upgrade_detached )
  wait_for_node "http://127.0.0.1:$SNAP_HTTP_PORT" 120 "node logs: fiddy node logs"
  config_set FIDDY_NODE_HTTP "http://127.0.0.1:$SNAP_HTTP_PORT"
  config_set FIDDY_NODE_GRPC "127.0.0.1:$SNAP_GRPC_PORT"
  ok "Local read node running on http://127.0.0.1:$SNAP_HTTP_PORT. Next: fiddy client up"
}

# --- remote install steps -------------------------------------------------

remote_ensure_docker() {
  local probe
  probe="$(ssh_run 'command -v docker >/dev/null 2>&1 && echo docker-ok || echo no-docker')"
  case "$probe" in
    *docker-ok*)
      ssh_run 'docker --version' ;;
    *)
      log "Docker missing on the target — installing via get.docker.com…"
      if [ "$(ssh_run 'id -u')" = "0" ]; then
        ssh_run 'curl -fsSL https://get.docker.com | sh >/tmp/fiddy-docker-install.log 2>&1 && docker --version' \
          || die "Docker install failed on the target — see /tmp/fiddy-docker-install.log"
      else
        ssh_run 'sudo -n true' >/dev/null 2>&1 \
          || die "Docker is missing and sudo on $FIDDY_TARGET needs a password. Install it yourself (curl -fsSL https://get.docker.com | sudo sh), add your user to the docker group, then re-run."
        ssh_run 'curl -fsSL https://get.docker.com | sudo sh >/tmp/fiddy-docker-install.log 2>&1 && sudo usermod -aG docker $USER && sudo docker --version' \
          || die "Docker install failed on the target — see /tmp/fiddy-docker-install.log"
        warn "added $USER to the docker group — reconnect may be needed for passwordless docker"
      fi
      ;;
  esac
}

# .env must exist before snapchain.sh runs: it gates every command on the
# operator agreement and, with no tty, stops all containers instead of asking.
remote_seed_snapchain_env() {
  local fid="${FIDDY_OPERATOR_FID:-0}"
  # STATSD_*_PUBLISH: keep the node's metrics ports on loopback and out of the
  # way, so a shared host's 8125/8126 stay free (upstream default binds 0.0.0.0).
  ssh_run "mkdir -p ~/snapchain && cd ~/snapchain && fetch_script=\$(mktemp) &&
    curl -sSL https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/scripts/snapchain.sh -o \"\$fetch_script\" &&
    mv \"\$fetch_script\" snapchain.sh && chmod +x snapchain.sh &&
    printf 'AGREE_NO_REWARDS_FOR_ME=true\nHUB_OPERATOR_FID=%s\nSKIP_CRONTAB=true\nSTATSD_PUBLISH=127.0.0.1:18125\nSTATSD_ADMIN_PUBLISH=127.0.0.1:18126\n' '$fid' > .env &&
    chmod 600 .env && grep -c . .env" \
    || die "could not fetch snapchain.sh / seed .env on $FIDDY_TARGET"
  local version
  version="$(ssh_run 'cd ~/snapchain && ./snapchain.sh help >/dev/null 2>&1 && echo snapchain.sh-ok')"
  case "$version" in
    *snapchain.sh-ok*) ok "snapchain.sh installed, .env seeded (no rewards agreement, no host-wide cron)" ;;
    *) die "snapchain.sh did not run on $FIDDY_TARGET" ;;
  esac
}

remote_start_upgrade() { # remote_start_upgrade [grafana_blocked 0|1]
  local blocked="${1:-0}"
  log "starting the node (detached; logs → ~/snapchain/upgrade.log)…"
  ssh_run 'cd ~/snapchain && (setsid ./snapchain.sh upgrade > upgrade.log 2>&1 < /dev/null &) ; sleep 2; echo started' \
    || die "could not start snapchain.sh upgrade on $FIDDY_TARGET"

  if [ "$blocked" = 1 ]; then
    # snapchain.sh waits on http://127.0.0.1:3000/api/health with no timeout.
    # If :3000 belongs to something else, that wait never ends and the node
    # container is never started. Start it from the compose file the script
    # already fetched, and stop the stalled script.
    warn "port 3000 is taken on $FIDDY_TARGET — snapchain.sh's Grafana step will wait forever."
    log "starting the node containers directly from the fetched compose file…"
    local waited=0
    while [ "$waited" -lt 90 ]; do
      if ssh_run 'test -s ~/snapchain/docker-compose.yml && test -s ~/snapchain/validators.toml'; then break; fi
      sleep 5; waited=$((waited + 5))
    done
    ssh_run 'cd ~/snapchain && docker compose up -d snapchain' \
      || die "could not start the node container on $FIDDY_TARGET"
    # Pattern is bracketed so pkill does not match the shell running it.
    ssh_run 'pkill -f "snapchain[.]sh upgrade" 2>/dev/null || sudo -n pkill -f "snapchain[.]sh upgrade" 2>/dev/null || true' || true
    ok "node container started without Grafana (no metrics dashboard on this host)"
  fi
}

# --- local install steps (used by --local and by the macOS path) ----------

fetch_snapchain_script() {
  local tmp
  tmp="$(mktemp)"
  curl -sSL https://raw.githubusercontent.com/farcasterxyz/snapchain/@latest/scripts/snapchain.sh -o "$tmp" || die "could not fetch snapchain.sh"
  mv "$tmp" snapchain.sh && chmod +x snapchain.sh
}

seed_env_file() {
  local fid="${FIDDY_OPERATOR_FID:-0}"
  printf 'AGREE_NO_REWARDS_FOR_ME=true\nHUB_OPERATOR_FID=%s\nSKIP_CRONTAB=true\n' "$fid" > .env
  chmod 600 .env
}

start_upgrade_detached() {
  nohup ./snapchain.sh upgrade > upgrade.log 2>&1 < /dev/null &
  log "snapchain.sh upgrade started (logs → $PWD/upgrade.log)"
}

# --- status / lifecycle ---------------------------------------------------

node_status() {
  require_target
  config_load
  local host="${FIDDY_TARGET#*@}"
  local base="${FIDDY_NODE_HTTP:-http://$host:$SNAP_HTTP_PORT}"
  step "Node status ($base)"
  node_network_line
  local body
  if ! body="$(curl -fsS --max-time 10 "$base/v1/info" 2>/dev/null)"; then
    node_status_silent "$base" "$host" \
      || die "node not answering at $base — try: fiddy node logs"
    return 0
  fi
  printf '%s\n' "$body" | if command -v jq >/dev/null 2>&1; then jq '.'; else cat; fi
}

# The API's honest silence: a fresh read node refuses HTTP until the snapshot
# bootstrap finishes (hours). "Is it up yet?" still deserves an answer — the
# container knows. Look locally first (this is how it runs ON the node, where
# the node is local Docker), then over SSH (how it runs on the machine that
# provisioned the node). Exit 0 when something was reported.
node_status_silent() { # base host
  local base="$1" host="$2" status="" progress="" is_local=0
  warn "the node's HTTP API is not answering at $base yet"
  warn "this is expected while the snapshot bootstrap runs (up to ~2h, ~470 GB)"
  case "$host" in localhost|127.0.0.1|::1) is_local=1 ;; esac
  if [ "$is_local" = 1 ] && command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1; then
    status="$(docker ps --filter name=snapchain-snapchain-1 --format '{{.Status}}' 2>/dev/null || true)"
    progress="$(docker logs snapchain-snapchain-1 2>&1 | grep -oE 'chunk_[0-9]+\.bin' | tail -1 || true)"
  else
    status="$(ssh_run 'docker ps --filter name=snapchain-snapchain-1 --format "{{.Status}}"' 2>/dev/null || true)"
    progress="$(ssh_run 'docker logs snapchain-snapchain-1 2>&1 | grep -oE "chunk_[0-9]+\.bin" | tail -1' 2>/dev/null || true)"
  fi
  if [ -n "$status" ]; then log "container: $status"; fi
  if [ -n "$progress" ]; then log "snapshot download at: $progress of 5690"; fi
  if [ -z "$status" ]; then
    warn "no snapchain container is visible from here — check: fiddy node logs"
    return 1
  fi
  return 0
}

node_verify() { # the bounty's acceptance checks, against the node's HTTP API
  local fid="${1:-3}"
  require jq "install jq (snapchain.sh installs it on the node host)"
  require_target
  config_load
  local host="${FIDDY_TARGET#*@}"
  local base="${FIDDY_NODE_HTTP:-http://$host:$SNAP_HTTP_PORT}"
  local fails=0

  step "Verifying the node at $base (fid $fid)"
  node_network_line

  # 1. Health / sync state
  local info
  if info="$(curl -fsS --max-time 10 "$base/v1/info")"; then
    printf '  %-26s %s\n' "/v1/info:" "OK"
    printf '%s\n' "$info" | jq -r '"    version=\(.version.string // "?" ) height=\(.maxHeight // 0) blockDelay=\(.blockDelay // 0)s shards=\((.shardInfo // {}) | length)"' 2>/dev/null \
      || printf '%s\n' "$info" | head -3
  else
    printf '  %-26s %s\n' "/v1/info:" "FAIL (no response)"
    fails=$((fails + 1))
  fi

  # 2. Reads served by this node (no third-party API involved)
  local casts count
  if casts="$(curl -fsS --max-time 15 "$base/v1/castsByFid?fid=$fid&pageSize=2&reverse=true")"; then
    count="$(printf '%s' "$casts" | jq -r '.messages | length' 2>/dev/null || echo 0)"
    if [ "${count:-0}" -gt 0 ]; then
      printf '  %-26s %s\n' "/v1/castsByFid:" "OK — this node served ${count} cast(s) for fid $fid"
      printf '%s' "$casts" | jq -r '.messages[0].data.castAddBody.text' 2>/dev/null | sed 's/^/    "&/;s/$/"/' | head -3
    else
      printf '  %-26s %s\n' "/v1/castsByFid:" "EMPTY — node answered, no data for fid $fid yet"
      printf '    %s\n' "expected while the snapshot is still loading; re-run after sync"
      fails=$((fails + 1))
    fi
  else
    printf '  %-26s %s\n' "/v1/castsByFid:" "FAIL (no response)"
    fails=$((fails + 1))
  fi

  # 3. Signers (the gasless KEY_ADD surface lives here)
  local signers
  if signers="$(curl -fsS --max-time 15 "$base/v1/signersByFid?fid=$fid")"; then
    printf '  %-26s %s\n' "/v1/signersByFid:" "OK — $(printf '%s' "$signers" | jq -r '.messages | length') key(s) for fid $fid"
  else
    printf '  %-26s %s\n' "/v1/signersByFid:" "FAIL (no response)"
    fails=$((fails + 1))
  fi

  echo ""
  if [ "$fails" = 0 ]; then
    ok "reads and key lookups are served by this node."
  else
    warn "$fails check(s) not satisfied yet."
  fi
  log "writes: POST /v1/submitMessage accepts a signed message (gasless KEY_ADD included)"
  log "and gossips it to validators — a 200 means accepted for relay, not merged."
  log "confirm inclusion with MERGE_MESSAGE events or by querying the message back."
}

# Which network the recorded node follows. Older installs predate networks, so
# "not recorded" is a real answer and is never upgraded to a guess.
node_network_line() {
  config_load
  case "${FIDDY_NODE_NETWORK:-}" in
    snapchain) log "network: Snapchain (Farcaster's own network)" ;;
    hypersnap) log "network: Hypersnap (the Quilibrium community's parallel network)" ;;
    *)         log "network: not recorded (this node was installed before fiddy knew about networks)" ;;
  esac
}

require_snapchain_remote() {
  require_target
  config_load
  # A Hypersnap install has its own directory and its own script; fiddy did not
  # create it and does not drive it. Say which command does, rather than
  # reporting "no Snapchain install" about something that is there.
  if [ "${FIDDY_NODE_NETWORK:-}" = hypersnap ]; then
    die "the node on $FIDDY_TARGET is a Hypersnap install, not a Snapchain one — fiddy does not manage it. Use its own script: ssh $FIDDY_TARGET 'cd ~/hypersnap && ./hypersnap.sh logs' (see docs/NETWORK-CHOICE.md)"
  fi
  ssh_run 'test -d ~/snapchain && test -f ~/snapchain/snapchain.sh' \
    || die "no Snapchain install on $FIDDY_TARGET — run: fiddy node up"
}

node_logs() {
  require_snapchain_remote
  ssh_run_tty 'cd ~/snapchain && ./snapchain.sh logs'
}

node_dashboard() {
  require_target
  # snapchain.sh installs Grafana on the node at :3000. It should never be
  # public — open it through an SSH tunnel instead.
  log "tunneling the node's Grafana to http://localhost:3000 (Ctrl-C to close)"
  log "default login is admin / admin — change it in the Grafana UI."
  local opts=(-N -L 3000:127.0.0.1:3000)
  [ -n "${FIDDY_SSH_KEY:-}" ] && opts+=(-i "$FIDDY_SSH_KEY")
  ssh "${opts[@]}" -o StrictHostKeyChecking=accept-new "$FIDDY_TARGET"
}

node_autoupgrade() {
  local mode="${1:-}" every="weekly"
  shift || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --every) every="${2:?--every needs hourly|daily|weekly}"; shift ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done
  local cron
  case "$every" in
    weekly) cron='0 3 * * 2' ;;
    daily)  cron='0 3 * * *' ;;
    hourly) cron='0 * * * *'
            warn "hourly: every run restarts the node AND ends with a host-wide"
            warn "'docker system prune --volumes -f' — 24 restarts + prunes a day."
            warn "On a dedicated node box that's survivable; anywhere else, don't." ;;
    *) die "--every must be hourly, daily or weekly" ;;
  esac
  config_load 2>/dev/null || true

  # crontab is a hard prerequisite; minimal cloud images don't ship it, and a
  # missing binary used to make this command die with no explanation.
  if ! command -v crontab >/dev/null 2>&1; then
    log "cron is missing — installing it first…"
    if command -v apt-get >/dev/null 2>&1; then
      sudo -n apt-get update -qq && sudo -n apt-get install -y -qq cron \
        && sudo -n systemctl enable --now cron \
        || die "install cron first: sudo apt-get install -y cron && sudo systemctl enable --now cron"
    else
      die "cron (crontab) is required for auto-upgrade — install your OS's cron package"
    fi
  fi

  if [ "$mode" = "on" ]; then
    local line="$cron \$HOME/snapchain/snapchain.sh autoupgrade >> \$HOME/snapchain/snapchain-autoupgrade.log 2>&1"
    if [ -n "${FIDDY_TARGET:-}" ]; then
      ssh_run "sed -i 's/^SKIP_CRONTAB=true/SKIP_CRONTAB=false/' ~/snapchain/.env; (crontab -l 2>/dev/null | grep -v 'snapchain.sh autoupgrade'; echo \"$line\") | crontab -; crontab -l | grep snapchain" \
        && ok "auto-upgrade on: $every (cron '$cron', host time; log: ~/snapchain/snapchain-autoupgrade.log)"
    else
      # Local node (--local install): edit this machine's crontab.
      # The install lives at $FIDDY_HOME/snapchain (~/.fiddy/snapchain), not
      # necessarily ~/snapchain — resolve it, don't assume.
      local snap_dir="$FIDDY_HOME/snapchain"
      [ -f "$snap_dir/.env" ] || snap_dir="$HOME/snapchain"
      [ -f "$snap_dir/.env" ] || die "no Snapchain install found at $FIDDY_HOME/snapchain or ~/snapchain — run: fiddy node up --local first"
      sed -i '' 's/^SKIP_CRONTAB=true/SKIP_CRONTAB=false/' "$snap_dir/.env" 2>/dev/null \
        || sed -i 's/^SKIP_CRONTAB=true/SKIP_CRONTAB=false/' "$snap_dir/.env"
      ( crontab -l 2>/dev/null | grep -v 'snapchain.sh autoupgrade' | grep -v 'fiddy self-update'; echo "$cron $snap_dir/snapchain.sh autoupgrade >> $snap_dir/snapchain-autoupgrade.log 2>&1" ) | crontab -
      # Keep the fiddy CLI itself current too: hourly fast-forward pull of the
      # checkout this install was made from (ff-only: local edits never get
      # clobbered — a dirty tree just skips that run).
      if [ -d "$FIDDY_REPO/.git" ]; then
        mkdir -p "$FIDDY_HOME"
        ( crontab -l 2>/dev/null | grep -v 'snapchain.sh autoupgrade' | grep -v 'fiddy self-update'; echo "0 * * * * git -C $FIDDY_REPO pull --ff-only >> $FIDDY_HOME/self-update.log 2>&1 # fiddy self-update" ) | crontab -
      fi
      crontab -l | grep snapchain \
        && ok "auto-upgrade on (local): $every (cron '$cron'; log: ~/snapchain/snapchain-autoupgrade.log)"
      [ -d "$FIDDY_REPO/.git" ] && ok "fiddy self-update: hourly git pull --ff-only from $FIDDY_REPO (log: $FIDDY_HOME/self-update.log)"
    fi
  elif [ "$mode" = "off" ]; then
    if [ -n "${FIDDY_TARGET:-}" ]; then
      ssh_run 'sed -i "s/^SKIP_CRONTAB=false/SKIP_CRONTAB=true/" ~/snapchain/.env; crontab -l 2>/dev/null | grep -v snapchain | crontab -' \
        && ok "auto-upgrade off — upgrade by hand: fiddy node upgrade"
    else
      local snap_dir="$FIDDY_HOME/snapchain"
      [ -f "$snap_dir/.env" ] || snap_dir="$HOME/snapchain"
      [ -f "$snap_dir/.env" ] || die "no Snapchain install found — nothing to turn off"
      sed -i '' 's/^SKIP_CRONTAB=false/SKIP_CRONTAB=true/' "$snap_dir/.env" 2>/dev/null \
        || sed -i 's/^SKIP_CRONTAB=false/SKIP_CRONTAB=true/' "$snap_dir/.env"
      crontab -l 2>/dev/null | grep -v snapchain | grep -v 'fiddy self-update' | crontab -
      ok "auto-upgrade off (local) — upgrade by hand: fiddy node upgrade"
    fi
  else
    die "usage: fiddy node autoupgrade on|off [--every weekly|daily|hourly]"
  fi
}

node_stop() {
  require_snapchain_remote
  ssh_run 'cd ~/snapchain && ./snapchain.sh down' && ok "node containers stopped"
}

node_start() {
  require_snapchain_remote
  # snapchain.sh up tails logs with -f, so start the containers directly and
  # keep the command non-blocking.
  ssh_run 'cd ~/snapchain && docker compose up -d snapchain statsd' >/dev/null && ok "node containers started"
}

node_upgrade() {
  require_snapchain_remote
  log "running snapchain.sh upgrade (detached)…"
  ssh_run 'cd ~/snapchain && (setsid ./snapchain.sh upgrade > upgrade.log 2>&1 < /dev/null &) ; sleep 2; tail -n 5 upgrade.log' \
    || die "upgrade failed to start"
  ok "upgrade running in the background — fiddy node logs to follow"
}