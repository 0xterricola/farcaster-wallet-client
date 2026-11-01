#!/usr/bin/env bash
# One-command Snapchain read node on OVHcloud Public Cloud.
#
#   export OVH_APPLICATION_KEY=… OVH_APPLICATION_SECRET=… OVH_CONSUMER_KEY=…
#   export OVH_PUBLIC_CLOUD_PROJECT=<your Public Cloud project id>
#   bash scripts/ovh-deploy.sh
#
# (Create API credentials at https://api.ovh.com/createToken/ with
#  GET+POST+DELETE on /cloud/* .)
#
# Why Public Cloud and not a VPS: the OVH VPS range tops out at ~640 GB and a
# mainnet read node needs 1.5–2 TB. This script creates a b3-16 (4 vCore /
# 16 GB) plus a 2 TB Classic block volume mounted at /var/lib/fiddy-node, with
# the snapchain data directory placed on it.
#
# STATUS: built against the OVHcloud API docs but NOT yet battle-tested (we run
# GCP ourselves). If you are the first to run it and something breaks, the
# script prints the exact API response — paste it into a GitHub issue and we
# will fix it.
set -euo pipefail

REGION="${OVH_REGION:-GRA11}"
FLAVOR="${OVH_FLAVOR:-b3-16}"
VOL_GB="${OVH_VOLUME_GB:-2048}"
NAME="${FIDDY_OVH_NAME:-fiddy-node}"
API="https://api.ovh.com/1.0"

for v in OVH_APPLICATION_KEY OVH_APPLICATION_SECRET OVH_CONSUMER_KEY OVH_PUBLIC_CLOUD_PROJECT; do
  [ -n "${!v:-}" ] || { echo "missing env: $v"; exit 1; }
done

# OVH request signing: "$1$" + sha1(appSecret+consumerKey+METHOD+url+body+ts)
ovh() { # ovh METHOD PATH [BODY]
  local method="$1" path="$2" body="${3:-}" url="$API$2"
  local ts sig
  ts="$(curl -fsS "$API/auth/time")" # server time (avoids clock skew)
  sig="\$1\$$(printf '%s' "${OVH_APPLICATION_SECRET}+${OVH_CONSUMER_KEY}+${method}+${url}+${body}+${ts}" | openssl sha1 | awk '{print $NF}')"
  curl -fsS -X "$method" "$url" \
    -H "X-Ovh-Application: $OVH_APPLICATION_KEY" \
    -H "X-Ovh-Consumer: $OVH_CONSUMER_KEY" \
    -H "X-Ovh-Timestamp: $ts" \
    -H "X-Ovh-Signature: $sig" \
    -H "content-type: application/json" \
    ${body:+-d "$body"}
}

P="$OVH_PUBLIC_CLOUD_PROJECT"
echo "▸ project: $P · region: $REGION · flavor: $FLAVOR · volume: ${VOL_GB}GB classic"

FLAVOR_ID="$(ovh GET "/cloud/project/$P/flavor?region=$REGION" \
  | python3 -c "import sys,json; fs=json.load(sys.stdin); m=[f for f in fs if f['name']=='$FLAVOR']; print(m[0]['id'] if m else '')")" \
  || { echo "flavor lookup failed"; exit 1; }
[ -n "$FLAVOR_ID" ] || { echo "flavor $FLAVOR not available in $REGION"; exit 1; }

IMAGE_ID="$(ovh GET "/cloud/project/$P/image?osType=linux&region=$REGION" \
  | python3 -c "import sys,json; ims=json.load(sys.stdin); m=[i for i in ims if 'Ubuntu 24.04' in i.get('name','') and i.get('status')=='active']; print(m[0]['id'] if m else '')")" \
  || { echo "image lookup failed"; exit 1; }
[ -n "$IMAGE_ID" ] || { echo "Ubuntu 24.04 image not found in $REGION"; exit 1; }

echo "▸ ssh key"
PUB="$(cat "$HOME/.ssh/id_ed25519.pub" 2>/dev/null || cat "$HOME/.ssh/id_rsa.pub" 2>/dev/null)" \
  || { echo "no SSH public key in ~/.ssh — make one: ssh-keygen -t ed25519"; exit 1; }
KEY_ID="$(ovh GET "/cloud/project/$P/sshkey" \
  | python3 -c "import sys,json; ks=json.load(sys.stdin); m=[k for k in ks if k.get('name')=='fiddy']; print(m[0]['id'] if m else '')")"
if [ -z "$KEY_ID" ]; then
  KEY_ID="$(ovh POST "/cloud/project/$P/sshkey" "{\"name\":\"fiddy\",\"publicKey\":\"$PUB\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")"
fi

echo "▸ 2 TB volume + instance"
VOL_ID="$(ovh POST "/cloud/project/$P/volume" "{\"region\":\"$REGION\",\"size\":$VOL_GB,\"type\":\"classic\",\"name\":\"fiddy-node-data\",\"description\":\"snapchain node data\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")"

# userData: format+mount the volume at /var/lib/fiddy-node, install Docker+cron.
USER_DATA='#!/bin/bash
set -e
curl -fsSL https://get.docker.com | sh
apt-get install -y cron git && systemctl enable --now cron
git clone https://github.com/ivcained/fiddy /opt/fiddy 2>/dev/null || git -C /opt/fiddy pull --ff-only
chmod +x /opt/fiddy/bin/fiddy
ln -sf /opt/fiddy/bin/fiddy /usr/local/bin/fiddy
for d in /dev/sdb /dev/vdb; do
  if [ -b "$d" ]; then
    mkfs.ext4 -F "$d" || true
    mkdir -p /var/lib/fiddy-node
    mount "$d" /var/lib/fiddy-node || true
    echo "$d /var/lib/fiddy-node ext4 defaults,nofail 0 2" >> /etc/fstab
    mkdir -p /var/lib/fiddy-node/snapchain
    ln -sfn /var/lib/fiddy-node/snapchain /home/ubuntu/snapchain
    break
  fi
done'

INST="$(ovh POST "/cloud/project/$P/instance" "{\"flavorId\":\"$FLAVOR_ID\",\"imageId\":\"$IMAGE_ID\",\"name\":\"$NAME\",\"region\":\"$REGION\",\"sshKeyId\":\"$KEY_ID\",\"userData\":$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$USER_DATA"),\"monthlyBilling\":false}")"
INST_ID="$(printf '%s' "$INST" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")"

echo "▸ attaching volume (waits for the instance to be active)…"
for i in $(seq 1 60); do
  sleep 10
  STATUS="$(ovh GET "/cloud/project/$P/instance/$INST_ID" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)"
  [ "$STATUS" = "ACTIVE" ] && break
done
ovh POST "/cloud/project/$P/volume/$VOL_ID/attach" "{\"instanceId\":\"$INST_ID\"}" >/dev/null

# Public IPv4: since 2026-10-01 b3 instances bill IPv4 separately — if no
# public address shows up, add one in the OVH Control Panel (Public Cloud →
# Public IPs) and re-run the lookup below.
sleep 20
IP="$(ovh GET "/cloud/project/$P/instance/$INST_ID" \
  | python3 -c "import sys,json; ips=json.load(sys.stdin).get('ipAddresses',[]); v4=[i['ip'] for i in ips if i.get('version')==4 and i.get('type')=='public']; print(v4[0] if v4 else '')")"
[ -n "$IP" ] || { echo "⚠ no public IPv4 yet — add one in the Control Panel (Public Cloud → Public IPs), then re-run this script's lookup"; exit 1; }

mkdir -p "${FIDDY_HOME:-$HOME/.fiddy}"
printf '%s\n' "$IP" > "${FIDDY_HOME:-$HOME/.fiddy}/ovh-last-ip"

cat <<EOF

✓ node compute is ready.

  external IP:  $IP
  ssh:          ssh ubuntu@$IP

OVH security note: the default security group allows SSH; open the Snapchain
ports before the node can peer (Public Cloud → Network → Security Groups on
$NAME): tcp 3381-3384 + udp 3382,3384 from 0.0.0.0/0.

Next:

  fiddy provision --ssh ubuntu@$IP
  fiddy node up
  fiddy client up

(If 'fiddy: command not found': run  export PATH="$PWD/bin:$PATH"  inside the repo first.)

Tear down: delete the instance AND the volume in the Control Panel (or via the
API) — the volume keeps billing if you only delete the VM.
EOF
