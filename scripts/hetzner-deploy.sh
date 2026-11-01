#!/usr/bin/env bash
# One-command Snapchain read node on Hetzner Cloud.
#
#   export HCLOUD_TOKEN=<api token from console.hetzner.cloud → project → API tokens>
#   bash scripts/hetzner-deploy.sh
#
# Creates: a 2 TB ext4 volume + a CCX33 (4 vCPU / 16 GB, ~€30/mo) with the
# volume mounted at /var/lib/fiddy-node and ~/snapchain symlinked onto it.
# All-in ≈ €120/mo (volume ~€88). Hetzner has no default inbound firewall, so
# the node's gossip ports work immediately.
#
# STATUS: built against the Hetzner Cloud API docs but NOT yet battle-tested
# (we run GCP ourselves). It fails loudly with the API's own error — paste it
# into a GitHub issue if you are the first to hit one.
set -euo pipefail

TOKEN="${HCLOUD_TOKEN:-${HETZNER_TOKEN:-}}"
[ -n "$TOKEN" ] || { echo "missing HCLOUD_TOKEN — console.hetzner.cloud → your project → Security → API tokens"; exit 1; }

LOCATION="${HETZNER_LOCATION:-fsn1}"
TYPE="${HETZNER_TYPE:-ccx33}"
VOL_GB="${HETZNER_VOLUME_GB:-2048}"
NAME="${FIDDY_HETZNER_NAME:-fiddy-node}"
API="https://api.hetzner.cloud/v1"

hz() { # hz METHOD PATH [BODY]
  curl -fsS -X "$1" "$API$2" -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" ${3:+-d "$3"}
}
jqpy() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

echo "▸ location: $LOCATION · type: $TYPE · volume: ${VOL_GB}GB ext4"

echo "▸ ssh key"
PUB="$(cat "$HOME/.ssh/id_ed25519.pub" 2>/dev/null || cat "$HOME/.ssh/id_rsa.pub" 2>/dev/null)" \
  || { echo "no SSH public key in ~/.ssh — make one: ssh-keygen -t ed25519"; exit 1; }
KEY_ID="$(hz GET "/ssh_keys" | jqpy "next((k['id'] for k in d['ssh_keys'] if k['name']=='fiddy'), '')" 2>/dev/null || true)"
if [ -z "$KEY_ID" ]; then
  KEY_ID="$(hz POST "/ssh_keys" "{\"name\":\"fiddy\",\"public_key\":\"$PUB\"}" | jqpy "d['ssh_key']['id']")"
fi

echo "▸ volume"
VOL_ID="$(hz POST "/volumes" "{\"name\":\"fiddy-node-data\",\"size\":$VOL_GB,\"location\":\"$LOCATION\",\"format\":\"ext4\"}" | jqpy "d['volume']['id']")"

# user_data: find the volume by its stable scsi id, mount at /var/lib/fiddy-node,
# symlink ~/snapchain onto it (root's and ubuntu's), install Docker + cron.
USER_DATA='#!/bin/bash
set -e
curl -fsSL https://get.docker.com | sh
apt-get install -y cron git && systemctl enable --now cron
git clone https://github.com/ivcained/fiddy /opt/fiddy 2>/dev/null || git -C /opt/fiddy pull --ff-only
chmod +x /opt/fiddy/bin/fiddy
ln -sf /opt/fiddy/bin/fiddy /usr/local/bin/fiddy
for i in $(seq 1 30); do
  DEV=$(ls /dev/disk/by-id/scsi-0HC_Volume_* 2>/dev/null | head -1) && break
  sleep 2
done
if [ -n "${DEV:-}" ]; then
  blkid "$DEV" >/dev/null 2>&1 || mkfs.ext4 -F "$DEV"
  mkdir -p /var/lib/fiddy-node
  mount "$DEV" /var/lib/fiddy-node || true
  grep -q fiddy-node /etc/fstab || echo "$DEV /var/lib/fiddy-node ext4 defaults,nofail 0 2" >> /etc/fstab
  mkdir -p /var/lib/fiddy-node/snapchain
  ln -sfn /var/lib/fiddy-node/snapchain /root/snapchain
fi'

echo "▸ server (this bills hourly from now)"
SERVER="$(hz POST "/servers" "$(python3 -c "
import json, sys
print(json.dumps({
  'name': '$NAME',
  'server_type': '$TYPE',
  'image': 'ubuntu-24.04',
  'location': '$LOCATION',
  'ssh_keys': [int('$KEY_ID')],
  'volumes': [int('$VOL_ID')],
  'user_data': '''$USER_DATA''',
  'labels': {'project': 'fiddy'},
}))")")"
SERVER_ID="$(printf '%s' "$SERVER" | jqpy "d['server']['id']")"

echo "▸ waiting for running…"
for i in $(seq 1 40); do
  sleep 10
  S="$(hz GET "/servers/$SERVER_ID")"
  STATUS="$(printf '%s' "$S" | jqpy "d['server']['status']")"
  [ "$STATUS" = "running" ] && break
done
IP="$(printf '%s' "$S" | jqpy "d['server']['public_net']['ipv4']['ip']")"
[ -n "$IP" ] && [ "$IP" != "None" ] || { echo "no IPv4 — check the console"; exit 1; }

mkdir -p "${FIDDY_HOME:-$HOME/.fiddy}"
printf '%s\n' "$IP" > "${FIDDY_HOME:-$HOME/.fiddy}/hetzner-last-ip"

cat <<EOF

✓ node compute is ready.

  external IP:  $IP
  ssh:          ssh root@$IP   (Hetzner images log in as root)

Next:

  fiddy provision --ssh root@$IP
  fiddy node up
  fiddy client up

(If 'fiddy: command not found': run  export PATH="$PWD/bin:$PATH"  inside the repo first.)

Tear down (both, or the volume keeps billing):

  curl -X DELETE -H "Authorization: Bearer \$HCLOUD_TOKEN" $API/servers/$SERVER_ID
  curl -X DELETE -H "Authorization: Bearer \$HCLOUD_TOKEN" $API/volumes/$VOL_ID
EOF
