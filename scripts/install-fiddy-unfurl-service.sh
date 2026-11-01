#!/bin/bash
# Install (or refresh) the per-page unfurl service on the host that serves
# fiddy.fun: the systemd unit, its environment file, and the two nginx
# locations that route to it.
#
#   bash scripts/install-fiddy-unfurl-service.sh
#
# WHY THIS IS A SCRIPT AND NOT PART OF THE RELEASE. The release ships CODE
# (`server/unfurl/`, from the repo) and restarts the unit; the unit, the user
# and the vhost locations are host state that outlives any one release — the
# same reason the release does not touch nginx at all. It is idempotent: run it
# again and it rewrites the same files, refuses nothing, and reloads only what
# changed.
#
# The one secret is NEYNAR_API_KEY, which is the cast-hash → author index the
# service needs for a cast page (a Snapchain node shards by FID, so a bare hash
# cannot be read without an author). It is COPIED on the host from the control
# plane's environment file, never printed and never passed through this machine.
set -euo pipefail

HOST=${FIDDY_HOST:-root@100.111.203.78}
VHOST=/etc/nginx/sites-available/fiddy.fun
UNIT=/etc/systemd/system/fiddy-unfurl.service
ENVDIR=/etc/fiddy-unfurl
ENVFILE=$ENVDIR/unfurl.env
SOURCE_ENV=${FIDDY_UNFURL_KEY_SOURCE:-/etc/fiddy-auth/app.env}
service_user=fiddy-unfurl

say() { printf '\n== %s\n' "$*"; }
ssh_() { ssh -o BatchMode=yes "$HOST" "$@"; }

say "1/4 the service account and its environment"
ssh_ "id -u $service_user >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin $service_user
  install -d -m 0750 -o root -g $service_user $ENVDIR
  if [ ! -s $ENVFILE ] || ! grep -q '^NEYNAR_API_KEY=' $ENVFILE; then
    KEY=\$(grep -m1 '^NEYNAR_API_KEY=' $SOURCE_ENV | cut -d= -f2-)
    [ -n \"\$KEY\" ] || { echo 'no NEYNAR_API_KEY in $SOURCE_ENV: a cast page cannot ask who wrote a cast'; exit 1; }
    umask 077
    printf 'NEYNAR_API_KEY=%s\n' \"\$KEY\" > $ENVFILE
    echo '  wrote $ENVFILE (key copied from $SOURCE_ENV, not printed)'
  else
    echo '  $ENVFILE already holds a key'
  fi
  chown root:$service_user $ENVFILE; chmod 0640 $ENVFILE"

say "2/4 the unit"
ssh_ "cat > $UNIT" <<'UNIT'
# The per-page unfurl service: a cast URL or a profile URL, answered as itself.
#
# fiddy.fun serves one static document for every route (the client is an SPA),
# so a shared cast or profile link used to unfurl as the front door. This
# process answers those two route families with the release's own shell plus
# that page's og: tags and a 1200x630 card drawn for it, and serves the cards
# and the cast-hash index under /unfurl/. nginx proxies to it on loopback only.
#
# It runs as its own unprivileged user with almost no writable filesystem
# (ProtectSystem=strict), which is also why the card renderer is told
# PYTHONDONTWRITEBYTECODE: a __pycache__ next to the script would be a write, and
# a write is refused. The ONE place it may write is its state directory
# (/var/lib/fiddy-looks), where a shared look is stored once under a hash of its
# checked contents — systemd creates it, owns it as the service user and makes it
# the exception to ProtectSystem.
[Unit]
Description=Fiddy per-page unfurl cards (cast and profile pages for crawlers)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fiddy-unfurl
Group=fiddy-unfurl
WorkingDirectory=/var/www/fiddy.fun/current
ExecStart=/usr/bin/node /var/www/fiddy.fun/current/server/unfurl/server.mjs
Environment=NODE_ENV=production
Environment=PORT=3220
Environment=FIDDY_WEB_ROOT=/var/www/fiddy.fun/current/web
Environment=SNAPCHAIN_HTTP_URL=https://haatz.quilibrium.com
Environment=FIDDY_LOOKS_DIR=/var/lib/fiddy-looks
EnvironmentFile=/etc/fiddy-unfurl/unfurl.env
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
StateDirectory=fiddy-looks
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
LockPersonality=true
UMask=0077
MemoryMax=256M
TasksMax=64

[Install]
WantedBy=multi-user.target
UNIT
ssh_ "systemctl daemon-reload && systemctl enable --quiet fiddy-unfurl && echo '  unit installed and enabled'"

say "3/4 the vhost locations"
REPO=$(cd "$(dirname "$0")/.." && pwd)
scp -q "$REPO/scripts/fiddy-unfurl.nginx.conf" "$HOST:/tmp/fiddy-unfurl.nginx.conf"
scp -q "$REPO/scripts/insert-unfurl-nginx-locations.py" "$HOST:/tmp/insert-unfurl-nginx-locations.py"
ssh_ "set -e
  cp -a $VHOST $VHOST.before-unfurl
  python3 /tmp/insert-unfurl-nginx-locations.py $VHOST /tmp/fiddy-unfurl.nginx.conf
  nginx -t && systemctl reload nginx && echo '  nginx: config ok, reloaded'"

say "4/4 is it up?"
ssh_ "systemctl restart fiddy-unfurl; sleep 1
  systemctl is-active fiddy-unfurl
  curl -s -o /dev/null -w '  loopback /unfurl/health → %{http_code}\n' http://127.0.0.1:3220/unfurl/health
  curl -s http://127.0.0.1:3220/unfurl/health"
echo "  (a page test needs a release that ships server/unfurl/ — the release ritual gates it)"
