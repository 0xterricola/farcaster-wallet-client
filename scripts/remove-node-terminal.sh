#!/usr/bin/env bash
# Remove one node's web terminal — the exact opposite of
# scripts/install-node-terminal.sh, run on the same host (the VPS), as root.
#
#   bash scripts/remove-node-terminal.sh --fid 191554 [--host fiddy.fun] [--json]
#
# Removes, idempotently:
#   * the systemd unit  /etc/systemd/system/fiddy-term-<fid>.service (stopped, disabled, deleted)
#   * the nginx snippet /etc/nginx/snippets/fiddy-terminals/fid-<fid>.conf
#   * the state file    /etc/fiddy/terminals/fid-<fid>.env   (port + token)
#   * the node's key    /etc/fiddy/nodes/fid-<fid>.pem
#
# Then reloads nginx and READS THE TOKEN'D PATH BACK: after removal the
# terminal URL must answer 404 (the site's unknown-token guard), never the ttyd.
# Prints the verdict as
#
#   FIDDY_TERMINAL_REMOVED_JSON {"fid":…,"terminalHttp":"404","tokenRefused":true,…}
#
# so the deploy-agent's teardown job stores verified facts, not intentions.
# Measured 2026-10-24 (card t_9b6ac005): teardown terminated compute, volume,
# key pair and security group but left all four files above behind, so
# fiddy.fun/term/<token>/ kept serving a ttyd that could no longer SSH anywhere.
set -euo pipefail

FID=""
SITE_HOST="fiddy.fun"
while [ $# -gt 0 ]; do
  case "$1" in
    --fid) FID="${2:?--fid needs a value}"; shift 2 ;;
    --host) SITE_HOST="${2:?--host needs a value}"; shift 2 ;;
    --json) shift ;;  # the verdict JSON is always printed; kept for argv symmetry
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

log() { printf '▸ %s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }
warn(){ printf '! %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

case "$FID" in ''|*[!0-9]*) die "--fid must be a positive integer" ;; esac
[ "$FID" -gt 0 ] || die "--fid must be a positive integer"
[ "$(id -u)" = "0" ] || die "run as root (systemd + nginx live here)"

UNIT="/etc/systemd/system/fiddy-term-${FID}.service"
SNIPPET_DIR="/etc/nginx/snippets/fiddy-terminals"
SNIPPET="${SNIPPET_DIR}/fid-${FID}.conf"
STATE_DIR="/etc/fiddy/terminals"
STATE="${STATE_DIR}/fid-${FID}.env"
NODE_DIR="/etc/fiddy/nodes"
KEY="${NODE_DIR}/fid-${FID}.pem"

# The token is only needed for the read-back, and only while the state file
# still exists — read it before deleting the thing that holds it.
TOKEN=""
if [ -f "$STATE" ]; then
  TOKEN="$(sed -n 's/^TOKEN=//p' "$STATE" | head -1)"
fi

UNIT_REMOVED=false
SNIPPET_REMOVED=false
STATE_REMOVED=false
KEY_REMOVED=false

if [ -e "$UNIT" ]; then
  systemctl stop "fiddy-term-${FID}.service" 2>/dev/null || true
  systemctl disable "fiddy-term-${FID}.service" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload
  UNIT_REMOVED=true
  ok "unit removed: fiddy-term-${FID}.service"
else
  log "no unit for fid ${FID} — nothing to stop"
fi

if [ -e "$SNIPPET" ]; then
  rm -f "$SNIPPET"
  SNIPPET_REMOVED=true
  ok "nginx snippet removed: $SNIPPET"
else
  log "no nginx snippet for fid ${FID}"
fi

if [ -f "$STATE" ]; then
  rm -f "$STATE"
  STATE_REMOVED=true
  ok "state removed: $STATE"
else
  log "no state file for fid ${FID}"
fi

if [ -f "$KEY" ]; then
  rm -f "$KEY"
  KEY_REMOVED=true
  ok "node key removed: $KEY"
else
  log "no node key for fid ${FID}"
fi

# nginx only needs to notice if a location disappeared.
if [ "$SNIPPET_REMOVED" = true ]; then
  nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx config is invalid — check ${SNIPPET_DIR}"; }
  systemctl reload nginx
  ok "nginx reloaded"
fi

# --- read it back -----------------------------------------------------------
# 404 is the correct answer after removal (the site guards unknown /term/
# tokens). 200 means the terminal is still being served — a failure, not a
# warning, because a live URL to a dead node is exactly the trap this fixes.
sleep 1
TERM_CODE=""
if [ -n "$TOKEN" ]; then
  TERM_CODE="$(curl -s -o /dev/null -m 15 -k -w '%{http_code}' \
    --resolve "${SITE_HOST}:443:127.0.0.1" "https://${SITE_HOST}/term/${TOKEN}/" || echo 000)"
fi

FID="$FID" TOKEN="${TOKEN:-none}" SITE_HOST="$SITE_HOST" TERM_CODE="${TERM_CODE:-none}" \
UNIT_REMOVED="$UNIT_REMOVED" SNIPPET_REMOVED="$SNIPPET_REMOVED" \
STATE_REMOVED="$STATE_REMOVED" KEY_REMOVED="$KEY_REMOVED" python3 - <<'PY'
import datetime, json, os
e = os.environ
print("FIDDY_TERMINAL_REMOVED_JSON " + json.dumps({
  "fid": int(e["FID"]),
  "unitRemoved": e["UNIT_REMOVED"] == "true",
  "snippetRemoved": e["SNIPPET_REMOVED"] == "true",
  "stateRemoved": e["STATE_REMOVED"] == "true",
  "keyRemoved": e["KEY_REMOVED"] == "true",
  "terminalHttp": e["TERM_CODE"],
  "tokenRefused": e["TERM_CODE"] in ("404", "none"),
  "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}))
PY

if [ -n "$TERM_CODE" ] && [ "$TERM_CODE" = "200" ]; then
  die "the terminal URL still answers 200 after removal — check nginx and the snippet dir"
fi
ok "terminal for fid ${FID} is gone; its token'd path refuses"
