# shellcheck shell=bash
# fiddy doctor — machine + network check, fatline-style: what this box can do,
# which nodes answer, how far behind they are, and what to do next.

doctor_main() {
  step "fiddy doctor"
  local fail=0

  echo "This machine"
  local os cpu ram_gb disk_gb
  os="$(uname -sr)"
  cpu="$( (command -v nproc >/dev/null 2>&1 && nproc) || sysctl -n hw.ncpu 2>/dev/null || echo '?')"
  if [ -r /proc/meminfo ]; then
    ram_gb=$(awk '/MemTotal/ {printf "%.1f", $2/1024/1024}' /proc/meminfo)
  else
    ram_gb=$(awk "BEGIN{printf \"%.1f\", $(sysctl -n hw.memsize 2>/dev/null || echo 0)/1073741824}")
  fi
  local dtarget="$HOME/snapchain"; [ -d "$dtarget" ] || dtarget="$HOME"
  disk_gb=$(df -Pk "$dtarget" 2>/dev/null | awk 'NR==2 {printf "%.0f", $4/1048576}')
  echo "  $os · $cpu CPUs · ${ram_gb} GB RAM · ${disk_gb:-?} GB free disk"

  check() { # cmd, note
    if command -v "$1" >/dev/null 2>&1; then
      echo "  ✓ $1"
    else
      echo "  ✗ $1 ($2)"
      [ "${3:-0}" = 1 ] && fail=1
    fi
  }
  check git "needed to clone" 1
  check curl "needed for downloads" 1
  check node "auto-installed by 'fiddy client up' when missing" 0
  check pnpm "auto-installed by 'fiddy client up' when missing" 0
  check docker "auto-installed by 'fiddy node up --local' when missing" 0
  check aws "only for: fiddy provision --aws" 0

  echo ""
  echo "Networks"

  node_line() { # label, base url, height-out-file
    local label="$1" base="$2" body latency height version msg
    # curl reports its own timing; macOS date has no millisecond support.
    body="$(curl -fsS --max-time 6 -w $'\n%{time_total}' "$base/v1/info" 2>/dev/null)" || {
      echo "  ✗ $label  $base  not reachable"; return; }
    latency="$(printf '%s' "$body" | tail -1 | awk '{printf "%.0f", $1*1000}')"
    body="$(printf '%s' "$body" | sed '$d')"
    version="$(printf '%s' "$body" | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4)"
    height="$(printf '%s' "$body" | grep -o '"maxHeight":[0-9]*' | head -1 | cut -d: -f2)"
    msg="$(printf '%s' "$body" | grep -o '"numMessages":[0-9]*' | head -1 | cut -d: -f2)"
    echo "  ✓ $label  $base  v${version:-?} · height ${height:-?} · ${msg:-?} messages · ${latency} ms"
    [ -n "$height" ] && echo "$height" > "${3:-/dev/null}"
  }

  local my_height_file; my_height_file="$(mktemp)"
  local pub_height_file; pub_height_file="$(mktemp)"

  config_load 2>/dev/null || true
  node_line "yours"  "${FIDDY_NODE_HTTP:-http://127.0.0.1:${SNAP_HTTP_PORT:-3381}}" "$my_height_file"
  node_line "public" "https://crackle.farcaster.xyz" "$pub_height_file"
  node_line "public" "https://haatz.quilibrium.com" "$pub_height_file"

  local mh ph
  mh="$(cat "$my_height_file" 2>/dev/null)"; ph="$(cat "$pub_height_file" 2>/dev/null)"
  rm -f "$my_height_file" "$pub_height_file"
  if [ -n "$mh" ] && [ -n "$ph" ] && [ "$ph" -gt "$mh" ] 2>/dev/null; then
    echo "    (yours is $(( ph - mh )) blocks behind the network)"
  fi

  echo ""
  echo "Can this machine run a node?"
  if [ "${disk_gb:-0}" -ge 1536 ] 2>/dev/null; then
    echo "  ✓ yes — ${disk_gb} GB free clears the 1.5 TB a mainnet node needs (state was ~560 GB on 2026-10-23 and grows)"
  else
    echo "  ✗ no — ${disk_gb:-0} GB free; a mainnet read node needs 1.5–2 TB"
    echo "    (free-space rule of thumb: pruned state ~560 GB today, plus snapshot scratch + growth)"
  fi

  echo ""
  echo "Next"
  if [ ! -f "$FIDDY_CONFIG" ]; then
    echo "  fiddy provision      # pick compute (or: fiddy node up --local on this box)"
  elif [ -z "$mh" ]; then
    echo "  fiddy node up        # your node isn't answering yet"
  else
    echo "  fiddy client up      # your node answers — start the client"
  fi

  [ "$fail" = 0 ] && { echo ""; ok "ready"; return 0; } || die "fix the missing requirements above"
}
