#!/usr/bin/env bash
# One-command Snapchain read node on AWS — run in AWS CloudShell
# (console.aws.amazon.com → the CloudShell icon — pre-authenticated, free)
# or anywhere with an aws CLI configured.
#
#   bash scripts/aws-deploy.sh
#
# Creates (idempotent — safe to re-run):
#   * key pair "fiddy-node" (private key saved to ./fiddy-node.pem — guard it)
#   * security group "fiddy-node": SSH + node APIs from YOUR ip only, gossip open
#   * EC2 m5.xlarge, Ubuntu 24.04, 2048 GB gp3 (~$285/mo list) with Docker
#
set -euo pipefail

REGION="${FIDDY_AWS_REGION:-us-east-1}"
ITYPE="${FIDDY_AWS_INSTANCE_TYPE:-m5.xlarge}"
VOL_GB="${FIDDY_AWS_VOLUME_GB:-2048}"
NAME="${FIDDY_AWS_NAME:-fiddy-node}"

command -v aws >/dev/null || { echo "aws CLI not found — run this in CloudShell (console.aws.amazon.com → CloudShell icon)"; exit 1; }
aws sts get-caller-identity >/dev/null || { echo "aws not authenticated — CloudShell is pre-authed; locally: aws configure"; exit 1; }

MY_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
echo "▸ region: $REGION · type: $ITYPE · disk: ${VOL_GB}GB gp3 · your IP: $MY_IP"

AMI="$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
  --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' 'Name=state,Values=available' \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
[ -n "$AMI" ] && [ "$AMI" != "None" ] || { echo "no Ubuntu 24.04 AMI in $REGION"; exit 1; }

echo "▸ key pair"
if [ ! -f "$NAME.pem" ]; then
  aws ec2 create-key-pair --region "$REGION" --key-name "$NAME" --query 'KeyMaterial' --output text > "$NAME.pem"
  chmod 600 "$NAME.pem"
  echo "  saved ./$NAME.pem — this is the only copy. Guard it."
else
  echo "  ($NAME.pem exists — reusing)"
fi

echo "▸ security group (SSH + APIs → you only; gossip → world)"
SG="$(aws ec2 describe-security-groups --region "$REGION" --filters "Name=group-name,Values=$NAME" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [ -z "$SG" ] || [ "$SG" = "None" ]; then
  SG="$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME" --description "fiddy snapchain read node" --query 'GroupId' --output text)"
  for spec in "tcp 22 $MY_IP/32" "tcp 3381 $MY_IP/32" "tcp 3383 $MY_IP/32" \
              "tcp 3382 0.0.0.0/0" "udp 3382 0.0.0.0/0" "tcp 3384 0.0.0.0/0" "udp 3384 0.0.0.0/0"; do
    set -- $spec
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" --protocol "$1" --port "$2" --cidr "$3" >/dev/null
  done
fi

# One shared user-data script (Docker + cron + the fiddy CLI), so the box this
# CloudShell path creates and the box `fiddy provision --aws` creates come up
# identically — two paths, one image. The CLI install lives there loudly, with
# a fallback, because a silent failure here once left a real node with no
# `fiddy` at all (measured 2026-10-24, PR #82).
UD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/aws-node-user-data.sh"
[ -f "$UD" ] || { echo "missing $UD — the fiddy checkout is incomplete" >&2; exit 1; }

IID="$(aws ec2 describe-instances --region "$REGION" --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running" --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"
if [ -z "$IID" ] || [ "$IID" = "None" ]; then
  echo "▸ launching the VM (billing starts now, ~\$285/mo until you terminate)"
  IID="$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type "$ITYPE" \
    --key-name "$NAME" --security-group-ids "$SG" --user-data "file://$UD" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$VOL_GB,VolumeType=gp3}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=fiddy}]" \
    --query 'Instances[0].InstanceId' --output text)"
else
  echo "▸ ($NAME already running — reusing)"
fi
aws ec2 wait instance-running --region "$REGION" --instance-ids "$IID"
IP="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

mkdir -p "${FIDDY_HOME:-$HOME/.fiddy}"
printf '%s\n' "$IP" > "${FIDDY_HOME:-$HOME/.fiddy}/aws-last-ip"
cp -f "$NAME.pem" "${FIDDY_HOME:-$HOME/.fiddy}/$NAME.pem" 2>/dev/null || true

cat <<EOF2

✓ node compute is ready.

  external IP:  $IP
  ssh:          ssh -i $NAME.pem ubuntu@$IP

Cost honesty: ~\$285/mo at list price while this runs. Stop billing with:
  aws ec2 terminate-instances --region $REGION --instance-ids $IID

Next — install the node (from any machine with the fiddy repo cloned):

  git clone https://github.com/ivcained/fiddy && cd fiddy
  export PATH="$PWD/bin:$PATH"
  fiddy provision --ssh ubuntu@$IP
  fiddy node up
  fiddy client up

The node downloads ~470 GB of snapshot chunks before its API answers —
overnight is normal. fiddy node status shows progress.
EOF2
