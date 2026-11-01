# shellcheck shell=bash
# fiddy shared helpers: config, logging, ssh, preflight.
#
# Portability: macOS ships bash 3.2, so nothing here may use bash-4 builtins
# (mapfile/readarray, ${var,,}) — the CLI runs with /bin/bash as shipped.

FIDDY_CONFIG="$FIDDY_HOME/config"
# Snapchain default ports: HTTP API 3381, gRPC 3383, gossip 3382 (quic/udp).
SNAP_HTTP_PORT="${SNAP_HTTP_PORT:-3381}"
SNAP_GRPC_PORT="${SNAP_GRPC_PORT:-3383}"

# Documented minimums for a mainnet read node (snapchain README, Aug 2026):
# 16 GB RAM, 4 vCPU, 1.5 TB free storage, public IP, ports 3381-3383 TCP+UDP.
# The bootstrap also needs scratch space for snapshot chunks + the assembled
# tar before it is unpacked, so the real requirement is ~1.5 TB *plus* scratch.
FIDDY_MIN_VCPU="${FIDDY_MIN_VCPU:-4}"
FIDDY_MIN_RAM_GB="${FIDDY_MIN_RAM_GB:-16}"
FIDDY_MIN_DISK_GB="${FIDDY_MIN_DISK_GB:-1536}"

c_reset=$'\033[0m'; c_lime=$'\033[38;5;154m'; c_dim=$'\033[2m'; c_red=$'\033[31m'; c_bold=$'\033[1m'
log()  { printf '%s▸%s %s\n' "$c_lime" "$c_reset" "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_lime" "$c_reset" "$*"; }
warn() { printf '%s!%s %s\n' "$c_red" "$c_reset" "$*" >&2; }
die()  { warn "$*"; exit 1; }
step() { printf '\n%s%s%s\n' "$c_bold" "$*" "$c_reset"; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1 — $2"; }

config_load() {
  [ -f "$FIDDY_CONFIG" ] || return 0
  # shellcheck disable=SC1090
  . "$FIDDY_CONFIG"
}

config_set() { # key value — upsert into $FIDDY_CONFIG (mode 0600)
  mkdir -p "$FIDDY_HOME"
  touch "$FIDDY_CONFIG"; chmod 600 "$FIDDY_CONFIG"
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$FIDDY_CONFIG" > "$tmp" 2>/dev/null || true
  printf '%s=%q\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$FIDDY_CONFIG"; chmod 600 "$FIDDY_CONFIG"
  config_load
}

config_show() {
  step "fiddy config ($FIDDY_CONFIG)"
  if [ -f "$FIDDY_CONFIG" ]; then cat "$FIDDY_CONFIG"; else echo "(empty — run: fiddy provision)"; fi
}

# --- remote helpers -------------------------------------------------------

require_target() {
  config_load
  [ -n "${FIDDY_TARGET:-}" ] || die "no node target configured. Run: fiddy provision --aws   (or: --ssh user@host)"
}

# Build the ssh argument list into an array (portable: no mapfile, bash 3.2 safe).
FIDDY_SSH_ARGS=()
build_ssh_args() {
  FIDDY_SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
  if [ -n "${FIDDY_SSH_KEY:-}" ]; then
    FIDDY_SSH_ARGS=("${FIDDY_SSH_ARGS[@]}" -i "$FIDDY_SSH_KEY")
  fi
  return 0
}

ssh_run() { # ssh_run <remote command...> — non-interactive, no tty
  require_target
  build_ssh_args
  ssh "${FIDDY_SSH_ARGS[@]}" "$FIDDY_TARGET" "$@"
}

ssh_run_tty() { # allocate a remote pty (for sudo prompts / interactive remote work)
  require_target
  build_ssh_args
  ssh -t "${FIDDY_SSH_ARGS[@]}" "$FIDDY_TARGET" "$@"
}

scp_to() { # scp_to <local> <remote-path>
  require_target
  build_ssh_args
  scp "${FIDDY_SSH_ARGS[@]}" "$1" "$FIDDY_TARGET:$2"
}

# Poll the node's HTTP info endpoint until it answers, printing health.
wait_for_node() { # wait_for_node <base-url> [tries] [remote-hint]
  local base="$1" tries="${2:-60}" hint="${3:-}" i body
  log "waiting for the node API at $base — the snapshot downloads first; that is the long part"
  for ((i = 1; i <= tries; i++)); do
    if body="$(curl -fsS --max-time 5 "$base/v1/info" 2>/dev/null)"; then
      ok "node API is up: $base"
      printf '%s\n' "$body" | node_info_summary
      return 0
    fi
    printf '\r\033[K%s' "$(snapshot_progress)"
    sleep 5
  done
  printf '\n'
  if [ -n "$hint" ]; then warn "$hint"; fi
  die "node did not answer at $base — check: fiddy node logs"
}

# Live bootstrap status: which snapshot chunk is downloading, how fast, and a
# real ETA from the measured rate. Works locally or against the SSH target.
snapshot_progress() {
  local chunk
  if [ -n "${FIDDY_TARGET:-}" ]; then
    chunk="$(ssh_run 'docker logs snapchain-snapchain-1 2>&1 | grep -oE "chunk_[0-9]+\.bin" | tail -1' 2>/dev/null || true)"
  else
    chunk="$(docker logs snapchain-snapchain-1 2>&1 | grep -oE 'chunk_[0-9]+\.bin' | tail -1 2>/dev/null || true)"
  fi
  [ -n "$chunk" ] || { printf 'preparing the snapshot download (the node API answers after it loads)…'; return; }
  local n="${chunk#chunk_}"; n="${n%.bin}"
  local now; now="$(date +%s)"
  if [ -z "${_SP_FIRST_N:-}" ]; then _SP_FIRST_N=$n; _SP_START=$now; fi
  local pct=$(( n * 100 / 5690 ))
  local elapsed=$(( (now - _SP_START) / 60 )); [ "$elapsed" -lt 1 ] && elapsed=1
  local rate=$(( (n - _SP_FIRST_N) / elapsed )); [ "$rate" -lt 1 ] && rate=1
  local eta_min=$(( (5690 - n) / rate ))
  local eta
  if [ "$eta_min" -ge 90 ]; then eta="$(( (eta_min + 30) / 60 ))h"; else eta="${eta_min}m"; fi
  printf 'downloading snapshot: chunk %s/5690 (%s%%) · %s chunks/min · ~%s left · safe to close this terminal' "$n" "$pct" "$rate" "$eta"
}

# Summarise /v1/info (jq if present, otherwise raw).
node_info_summary() {
  if command -v jq >/dev/null 2>&1; then
    jq -c '{version: (.version // .nodeVersion // null), maxHeight, blockDelay, shardInfo: (.shardInfo // .shards // null)}' 2>/dev/null \
      || jq -c '.' 2>/dev/null
  else
    cat
  fi
  return 0
}

# Is the node's HTTP API answering? (Non-fatal probe — a bootstrapping node
# legitimately refuses connections for a long time.)
node_api_reachable() {
  curl -fsS --max-time 5 "$1/v1/info" >/dev/null 2>&1
}

# Is something already listening on this local port (e.g. a tunnel we opened
# in an earlier run that outlived the CLI)?
tunnel_forward_active() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || return 1
  exec 3>&- 2>/dev/null || true
  return 0
}

# --- preflight ------------------------------------------------------------
# The node itself is cheap to install and expensive to host: a judge who
# points fiddy at a small droplet should hear that before the disk fills.

PREFLIGHT_FAILED=0
PREFLIGHT_PORTS=""
preflight_report() { # preflight_report <vcpu> <ram_mb> <disk_gb_free> <disk_label> <ports_taken>
  local vcpu="$1" ram_gb="$2" disk_gb="$3" disk_label="$4" ports="$5"
  PREFLIGHT_PORTS="$ports"
  step "Preflight — Snapchain mainnet read node needs 4 vCPU, 16 GB RAM, ${FIDDY_MIN_DISK_GB} GB free disk"
  printf '  %-22s %s\n' "vCPU:" "$vcpu (need ${FIDDY_MIN_VCPU})"
  printf '  %-22s %s\n' "RAM:" "${ram_gb} GB (need ${FIDDY_MIN_RAM_GB})"
  printf '  %-22s %s\n' "free disk ($disk_label):" "${disk_gb} GB (need ${FIDDY_MIN_DISK_GB})"
  if [ -n "$ports" ]; then printf '  %-22s %s\n' "ports already in use:" "$ports"; fi
  # RAM is compared in integer GiB read from the OS, which truncates: every
  # 16 GB-class cloud VM (GCP e2-standard-4, AWS m5.xlarge, …) reports 15.x GiB.
  # Floor the comparison at min-1 so the standard 16 GB class passes while a
  # genuinely smaller box (8/12 GB) still fails.
  local ram_floor=$(( FIDDY_MIN_RAM_GB - 1 ))
  [ "$vcpu" -ge "$FIDDY_MIN_VCPU" ] 2>/dev/null || PREFLIGHT_FAILED=1
  [ "$ram_gb" -ge "$ram_floor" ] 2>/dev/null || PREFLIGHT_FAILED=1
  [ "$disk_gb" -ge "$FIDDY_MIN_DISK_GB" ] 2>/dev/null || PREFLIGHT_FAILED=1
  if [ -n "$ports" ]; then
    case ",$ports," in
      *",3000,"*) # snapchain.sh waits on Grafana at 127.0.0.1:3000 forever if it cannot bind
        warn "port 3000 is taken — snapchain.sh's Grafana step cannot bind and will wait indefinitely." ;;
    esac
    case ",$ports," in
      *",3381,"*|*",3382,"*|*",3383,"*)
        warn "a Snapchain port is already bound on this host — is another node running?" ;;
    esac
  fi
  return 0
}

preflight_verdict() { # preflight_verdict <allow-undersized 0|1>
  [ "$PREFLIGHT_FAILED" = 0 ] && { ok "preflight passed"; return 0; }
  if [ "$1" = 1 ]; then
    warn "continuing anyway (--force): the node will run until it hits the wall above."
    warn "expect the snapshot bootstrap to fail on a small disk; see docs/NODE-REQUIREMENTS.md."
    return 0
  fi
  die "this machine cannot host a mainnet read node. Re-run with --force to install anyway (it will fail when the disk fills), or provision a bigger machine: fiddy provision --aws (2048 GB) / --ssh user@bigger-host"
}

preflight_local() {
  local vcpu ram_gb disk_kb disk_gb ports target_dir
  # Portable: nproc//proc/meminfo on Linux, sysctl on macOS.
  if command -v nproc >/dev/null 2>&1; then
    vcpu="$(nproc)"
  else
    vcpu="$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"
  fi
  if [ -r /proc/meminfo ]; then
    ram_gb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
  else
    ram_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 ))
  fi
  # Measure the disk the node's data will live on; never feed awk an empty
  # string (a nonexistent dir makes df fail and the arithmetic explodes).
  target_dir="$HOME/snapchain"; [ -d "$target_dir" ] || target_dir="$FIDDY_HOME"; [ -d "$target_dir" ] || target_dir="$HOME"
  disk_kb="$(df -Pk "$target_dir" 2>/dev/null | awk 'NR==2 {print $4}')"
  disk_gb=$(( ${disk_kb:-0} / 1048576 ))
  ports="$(ports_in_use_local)"
  preflight_report "$vcpu" "$ram_gb" "$disk_gb" "\$HOME" "$ports"
}

preflight_remote() {
  local out vcpu ram_gb disk_gb ports
  # Measure the disk the node's data will actually live on: when ~/snapchain
  # is a symlink to an attached volume (the OVH path), ~ alone would report
  # the small boot disk and false-fail the preflight.
  out="$(ssh_run 'printf "%s %s %s %s\n" \
      "$(nproc)" \
      "$(( $(awk "/MemTotal/ {print \$2}" /proc/meminfo) / 1024 / 1024 ))" \
      "$(( $( (df -Pk ~/snapchain 2>/dev/null || df -Pk ~) | awk "NR==2 {print \$4}" ) / 1048576 ))" \
      "$( (ss -lntup 2>/dev/null || netstat -lntup 2>/dev/null) | grep -oE ":(3000|3381|3382|3383|8125|8126)\b" | tr -d ":" | sort -u | tr "\n" "," )"')" \
    || die "could not read resources from $FIDDY_TARGET"
  set -- $out
  vcpu="${1:-0}"; ram_gb="${2:-0}"; disk_gb="${3:-0}"; ports="${4:-}"
  preflight_report "$vcpu" "$ram_gb" "$disk_gb" "\$HOME on $FIDDY_TARGET" "$ports"
}

ports_in_use_local() {
  local found=""
  for p in 3000 3381 3382 3383 8125 8126; do
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      exec 3>&- 2>/dev/null || true
      found="${found}${p},"
    fi
  done
  printf '%s' "$found"
}