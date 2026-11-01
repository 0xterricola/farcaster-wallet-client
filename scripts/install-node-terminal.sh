#!/usr/bin/env bash
# Put a per-node web terminal (and a token-gated node-API proxy) in front of one
# managed node. Runs ON THE HOST THAT RUNS THE DEPLOY-AGENT (the VPS), as root.
#
#   bash scripts/install-node-terminal.sh \
#     --fid 191554 --token <32-64 hex chars> \
#     --ssh ubuntu@<node-ip> --key /path/to/instance.pem \
#     [--network snapchain] [--node-port 3381] [--host fiddy.fun] [--json]
#
# What it does, in order:
#   1. installs ttyd (apt, else the upstream static binary) — once per host;
#   2. stores the node's SSH key at /etc/fiddy/nodes/fid-<fid>.pem (mode 600);
#      the key lives here and nowhere else; the miniapp never sees it;
#   2b. writes a NODE-LOCAL fiddy config (~/.fiddy/config for the SSH user) so
#      `fiddy node status` works on the box itself, plus a motd naming the ops
#      commands that work there (docker ps, docker logs snapchain-snapchain-1);
#   3. starts ttyd as a systemd unit, bound to 127.0.0.1, whose command is an
#      SSH login to the node. So the terminal is an SSH session to the node —
#      it holds no keys, and the node holds none by design;
#   4. writes an nginx snippet with two locations for this node:
#        /term/<token>/   -> that ttyd            (interactive ops shell)
#        /node/<token>/   -> the node's HTTP API  (so "your endpoint" is a
#                            real HTTPS URL, reachable from a browser)
#      The token is 128-bit random and is the only thing in the path; rotating
#      it is re-running this script with a new token (the old URL 404s).
#   5. reloads nginx and READS BOTH PATHS BACK, then prints
#        FIDDY_TERMINAL_JSON {…}
#      so the caller stores verified facts, not intentions.
#
# Idempotent: re-running for the same fid rewrites the unit and snippet in place
# and keeps the port already allocated to that fid.
set -euo pipefail

FID=""
TOKEN=""
SSH_TARGET=""
KEY=""
NETWORK="snapchain"
NODE_PORT="${SNAP_HTTP_PORT:-3381}"
SITE_HOST="fiddy.fun"
SITE_CONF="/etc/nginx/sites-available/${SITE_HOST}"
SNIPPET_DIR="/etc/nginx/snippets/fiddy-terminals"
NODE_DIR="/etc/fiddy/nodes"
STATE_DIR="/etc/fiddy/terminals"
PORT_BASE=7701

log() { printf '▸ %s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }
warn(){ printf '! %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --fid) FID="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --ssh) SSH_TARGET="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --network) NETWORK="$2"; shift 2 ;;
    --node-port) NODE_PORT="$2"; shift 2 ;;
    --host) SITE_HOST="$2"; SITE_CONF="/etc/nginx/sites-available/$2"; shift 2 ;;
    --json) shift ;;   # the verdict JSON is always printed; kept for the agent's argv
    -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$FID" in ''|*[!0-9]*) die "--fid must be a positive integer" ;; esac
[ "$FID" -gt 0 ] || die "--fid must be a positive integer"
printf '%s' "$TOKEN" | grep -Eq '^[0-9a-f]{32,64}$' \
  || die "--token must be 32-64 lowercase hex chars (128+ bits of randomness)"
printf '%s' "$SSH_TARGET" | grep -Eq '^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$' \
  || die "--ssh must look like user@host"
[ -n "$KEY" ] && [ -f "$KEY" ] || die "--key must point at the node's private key"
[ "$(id -u)" = "0" ] || die "run as root (systemd + nginx live here)"
command -v nginx >/dev/null || die "nginx not found on this host"
command -v python3 >/dev/null || die "python3 not found"
[ -f "$SITE_CONF" ] || die "$SITE_CONF not found — pass --host with the right site"

# --- 1. ttyd ---------------------------------------------------------------
if ! command -v ttyd >/dev/null 2>&1 && [ ! -x /usr/local/bin/ttyd ]; then
  log "installing ttyd…"
  if apt-get install -y -qq ttyd >/dev/null 2>&1; then
    ok "ttyd from apt"
  else
    # ttyd is not in every distro's repos; the upstream static release is.
    ver="1.7.7"
    curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${ver}/ttyd.x86_64" \
      || die "could not install ttyd (apt and the static release both failed)"
    chmod 755 /usr/local/bin/ttyd
    ok "ttyd $ver static binary"
  fi
fi
TTYD_BIN="$(command -v ttyd || echo /usr/local/bin/ttyd)"
TTYD_BASE_PATH="$($TTYD_BIN --help 2>&1 | grep -c -- '--base-path' || true)"
[ "$TTYD_BASE_PATH" -gt 0 ] || die "this ttyd has no --base-path: it cannot be served under /term/<token>/"

# --- 2. the node's key, in one place --------------------------------------
install -d -m 700 "$NODE_DIR"
install -m 600 "$KEY" "$NODE_DIR/fid-${FID}.pem"
ok "key stored: $NODE_DIR/fid-${FID}.pem (mode 600)"

case "$NETWORK" in
  snapchain|hypersnap) ;;
  *) die "--network must be snapchain or hypersnap" ;;
esac

# --- 2b. the node's own ops copy: `fiddy node status` works ON the box ------
# The orchestrator's job home holds the real target config; the node itself
# only gets the CLI from cloud-init. Without this, `fiddy node status` in the
# node's own web terminal answers "! no node target configured" (measured
# 2026-10-24) — while the node's API is right there on 127.0.0.1. So write a
# node-local config for the SSH user the terminal logs in as, and a motd that
# names the honest ops commands for a box where the node is local Docker, not
# a remote target. Best effort: a box we cannot configure is still a working
# terminal, it just says so in the verdict.
NODE_LOCAL_CONFIG=false
NODE_USER="${SSH_TARGET%%@*}"
NODE_GRPC_PORT="${SNAP_GRPC_PORT:-3383}"
NODE_CONFIG="FIDDY_TARGET=${NODE_USER}@127.0.0.1
FIDDY_PROVIDER=managed-node
FIDDY_NODE_HTTP=http://127.0.0.1:${NODE_PORT}
FIDDY_NODE_GRPC=127.0.0.1:${NODE_GRPC_PORT}
FIDDY_NODE_NETWORK=${NETWORK}
"
if printf '%s\n' "$NODE_CONFIG" | ssh -i "$NODE_DIR/fid-${FID}.pem" -o BatchMode=yes \
     -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$SSH_TARGET" \
     'mkdir -p ~/.fiddy && cat > ~/.fiddy/config && chmod 600 ~/.fiddy/config && grep -q "^FIDDY_NODE_HTTP=" ~/.fiddy/config && echo node-config-ok' 2>/dev/null | grep -q node-config-ok; then
  NODE_LOCAL_CONFIG=true
  ok "node-local config written: 'fiddy node status' works on the box"
else
  warn "could not write the node-local config — fiddy node status will not work on the box"
fi

# The landing text for a terminal that just opened: what this box is, and which
# commands answer questions here. Needs passwordless sudo (cloud images have it).
NODE_MOTD="$(cat <<'MOTD'
This is your Fiddy node.
  sync status:      fiddy node status
  the node itself:  docker ps ; docker logs snapchain-snapchain-1
  install dir:      ~/snapchain
MOTD
)"
printf '%s\n' "$NODE_MOTD" | ssh -i "$NODE_DIR/fid-${FID}.pem" -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$SSH_TARGET" \
  'sudo -n mkdir -p /etc/motd.d 2>/dev/null && sudo -n tee /etc/motd.d/99-fiddy >/dev/null && echo motd-ok' 2>/dev/null | grep -q motd-ok \
  && ok "terminal banner: /etc/motd.d/99-fiddy on the node" \
  || warn "no motd banner on the node (sudo unavailable) — not fatal"

# --- 3. port, reused if this fid already had one --------------------------
install -d -m 700 "$STATE_DIR"
PORT=""
if [ -f "$STATE_DIR/fid-${FID}.env" ]; then
  PORT="$(sed -n 's/^PORT=//p' "$STATE_DIR/fid-${FID}.env" | head -1)"
fi
if [ -z "$PORT" ]; then
  # Ports in use by every other fid on this host. Read them file by file: an
  # unmatched glob reaches the reader as its own literal name, and with
  # `set -o pipefail` that is exit 2 — measured on a fresh host with an empty
  # STATE_DIR, where the FIRST terminal install on the box died right here
  # ("✗ install-node-terminal.sh exited 2") after ttyd and the key were already
  # in place.
  taken=""
  for state in "$STATE_DIR"/*.env; do
    [ -f "$state" ] || continue
    taken="$taken $(sed -n 's/^PORT=//p' "$state" | head -1)"
  done
  PORT="$PORT_BASE"
  while printf '%s' "$taken" | grep -q " $PORT "; do PORT=$((PORT + 1)); done
fi
printf 'PORT=%s\nTOKEN=%s\nSSH=%s\n' "$PORT" "$TOKEN" "$SSH_TARGET" > "$STATE_DIR/fid-${FID}.env"
chmod 600 "$STATE_DIR/fid-${FID}.env"
ok "terminal port: 127.0.0.1:$PORT"

# --- 4. ttyd unit: an SSH session to the node ------------------------------
UNIT="/etc/systemd/system/fiddy-term-${FID}.service"
cat > "$UNIT" <<EOF
# Managed by scripts/install-node-terminal.sh — fid ${FID}.
# ttyd speaks to the node over SSH with the key stored above; it listens on
# loopback only, so the token'd nginx location is the only way in.
[Unit]
Description=Fiddy managed node terminal (fid ${FID})
After=network.target

[Service]
Type=simple
ExecStart=${TTYD_BIN} --port ${PORT} --interface 127.0.0.1 --writable \\
  --base-path /term/${TOKEN}/ \\
  --client-option fontSize=13 --client-option scrollback=5000 \\
  /usr/bin/ssh -i ${NODE_DIR}/fid-${FID}.pem \\
    -o BatchMode=yes -o StrictHostKeyChecking=accept-new \\
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \\
    -o LogLevel=ERROR ${SSH_TARGET}
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

# --- 5. nginx: two token'd paths for this node ----------------------------
install -d -m 755 "$SNIPPET_DIR"
SNIPPET="$SNIPPET_DIR/fid-${FID}.conf"
cat > "$SNIPPET" <<EOF
# Managed by scripts/install-node-terminal.sh — fid ${FID}. Regenerate to rotate
# the token. Both paths are token-gated; without the token they 404.
location = /term/${TOKEN} { return 301 /term/${TOKEN}/; }
location /term/${TOKEN}/ {
    limit_except GET POST { deny all; }
    proxy_pass http://127.0.0.1:${PORT};
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
}
location = /node/${TOKEN} { return 301 /node/${TOKEN}/v1/info; }
location /node/${TOKEN}/ {
    limit_except GET { deny all; }
    proxy_pass http://${SSH_TARGET#*@}:${NODE_PORT}/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_read_timeout 60s;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
}
EOF

# The snippet has to be included by the site's TLS server block, once.
if ! grep -q "snippets/fiddy-terminals" "$SITE_CONF"; then
  log "adding the snippet include to $SITE_CONF"
  SITE_CONF="$SITE_CONF" python3 - <<'PY'
import os, pathlib, sys
path = pathlib.Path(os.environ["SITE_CONF"])
text = path.read_text()
anchor = "root /var/www/fiddy.fun/current/web;"
if text.count(anchor) != 1:
    sys.exit("anchor line is not unique in the site config — include it by hand")
include = ("    # Managed node terminals (scripts/install-node-terminal.sh): a token'd\n"
           "    # ttyd per node and a token'd proxy to that node's own HTTP API.\n"
           "    include /etc/nginx/snippets/fiddy-terminals/*.conf;\n")
path.write_text(text.replace(anchor, anchor + "\n" + include.rstrip("\n"), 1))
print("include added")
PY
fi

# …and a path under /term/ or /node/ that no snippet claims is a REFUSAL. The
# site's catch-all otherwise answers a rotated or guessed token with the app shell
# (200, ~15 kB of HTML) — measured 2026-10-24, and it made this script's own
# "wrong token" read-back read as success. Kept as its own step so a host that
# already has the include (any node deployed before this change) still gets it.
if ! grep -q "location \^~ /term/ { return 404; }" "$SITE_CONF"; then
  log "adding the unknown-token guards to $SITE_CONF"
  SITE_CONF="$SITE_CONF" python3 - <<'PY'
import os, pathlib, sys
path = pathlib.Path(os.environ["SITE_CONF"])
text = path.read_text()
anchor = "    include /etc/nginx/snippets/fiddy-terminals/*.conf;"
if text.count(anchor) != 1:
    sys.exit("the terminals include is not in the site config — run this script once without the guards, then again")
guards = ("    # A /term/ or /node/ path no node owns is a 404, never the app shell.\n"
          "    location ^~ /term/ { return 404; }\n"
          "    location ^~ /node/ { return 404; }\n")
path.write_text(text.replace(anchor, guards + anchor, 1))
print("guards added")
PY
fi

# --- 6. apply ---------------------------------------------------------------
systemctl daemon-reload
systemctl enable --now "fiddy-term-${FID}.service" >/dev/null 2>&1 || true
systemctl restart "fiddy-term-${FID}.service"
nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx config is invalid — snippet left in place for inspection"; }
systemctl reload nginx

# --- 7. read it back -------------------------------------------------------
sleep 2
UNIT_STATE="$(systemctl is-active "fiddy-term-${FID}.service" || true)"
LOCAL_CODE="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "http://127.0.0.1:${PORT}/" || echo 000)"
TERM_CODE="$(curl -s -o /dev/null -m 15 -k -w '%{http_code}' \
  --resolve "${SITE_HOST}:443:127.0.0.1" "https://${SITE_HOST}/term/${TOKEN}/" || echo 000)"
NODE_CODE="$(curl -s -o /dev/null -m 15 -k -w '%{http_code}' \
  --resolve "${SITE_HOST}:443:127.0.0.1" "https://${SITE_HOST}/node/${TOKEN}/v1/info" || echo 000)"
NO_TOKEN_CODE="$(curl -s -o /dev/null -m 10 -k -w '%{http_code}' \
  --resolve "${SITE_HOST}:443:127.0.0.1" "https://${SITE_HOST}/term/deadbeefdeadbeefdeadbeefdeadbeef/" || echo 000)"

# The terminal is an SSH session; prove the SSH half independently of ttyd.
SSH_PROBE="$(ssh -i "$NODE_DIR/fid-${FID}.pem" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=10 "$SSH_TARGET" 'echo ssh-ok; hostname' 2>&1 || true)"
SSH_FIRST="$(printf '%s' "$SSH_PROBE" | head -1 | tr -d '\r')"
if [ "$SSH_FIRST" = "ssh-ok" ]; then SSH_OK=true; else SSH_OK=false; fi
WRONG_TOKEN_OK=true
if [ "$NO_TOKEN_CODE" = "200" ]; then WRONG_TOKEN_OK=false; fi

printf 'state=%s local=%s term=%s node=%s no_token=%s ssh=%s\n' \
  "$UNIT_STATE" "$LOCAL_CODE" "$TERM_CODE" "$NODE_CODE" "$NO_TOKEN_CODE" "$SSH_FIRST"

# The verdict, printed from the environment rather than interpolated into a
# python literal: the SSH probe's own output is multi-line ("ssh-ok\n<hostname>"),
# which used to break the literal and make a WORKING terminal report a traceback
# and a non-zero exit (measured 2026-10-24 — the agent then logs a failed job for
# a terminal that is up).
FID="$FID" PORT="$PORT" SITE_HOST="$SITE_HOST" TOKEN="$TOKEN" \
UNIT_STATE="$UNIT_STATE" LOCAL_CODE="$LOCAL_CODE" TERM_CODE="$TERM_CODE" \
NODE_CODE="$NODE_CODE" NO_TOKEN_CODE="$NO_TOKEN_CODE" SSH_OK="$SSH_OK" \
SSH_FIRST="$SSH_FIRST" WRONG_TOKEN_OK="$WRONG_TOKEN_OK" NODE_LOCAL="$NODE_LOCAL_CONFIG" python3 - <<'PY'
import datetime, json, os
e = os.environ
print("FIDDY_TERMINAL_JSON " + json.dumps({
  "fid": int(e["FID"]),
  "terminalUrl": f"https://{e['SITE_HOST']}/term/{e['TOKEN']}/",
  "endpointUrl": f"https://{e['SITE_HOST']}/node/{e['TOKEN']}/",
  "port": int(e["PORT"]),
  "unit": f"fiddy-term-{e['FID']}.service",
  "unitState": e["UNIT_STATE"],
  "localHttp": e["LOCAL_CODE"],
  "terminalHttp": e["TERM_CODE"],
  "nodeApiHttp": e["NODE_CODE"],
  "wrongTokenHttp": e["NO_TOKEN_CODE"],
  "wrongTokenRefused": e["WRONG_TOKEN_OK"] == "true",
  "sshReachable": e["SSH_OK"] == "true",
  "sshFirstLine": e["SSH_FIRST"],
  "nodeLocalConfig": e["NODE_LOCAL"] == "true",
  "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
}))
PY

[ "$UNIT_STATE" = "active" ] || die "ttyd unit is $UNIT_STATE — check: journalctl -u fiddy-term-${FID}"
[ "$TERM_CODE" = "200" ] || warn "terminal path answered $TERM_CODE (ttyd may still be starting)"
ok "terminal: https://${SITE_HOST}/term/${TOKEN}/  ·  endpoint: https://${SITE_HOST}/node/${TOKEN}/"