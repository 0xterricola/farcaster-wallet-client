# shellcheck shell=bash
# fiddy provision — command (0): furnish the compute.
#
# Two paths:
#   --aws            create a fresh EC2 instance (m5.xlarge + 2 TB gp3) with
#                    Docker preinstalled via user-data
#   --ssh user@host  register any server you already have (checked, then saved)
#
# Storage is the constraint that decides whether this works at all: a mainnet
# read node wants 1.5 TB free, and the snapshot bootstrap needs scratch space
# on top of that (chunks + assembled tar before unpack). See
# docs/NODE-REQUIREMENTS.md for the measured numbers.

provision_main() {
  local mode=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --aws)  mode=aws ;;
      --gcp)  mode=gcp ;;
      --ovh)  mode=ovh ;;
      --hetzner)  mode=hetzner ;;
      --ssh)  mode=ssh; shift; FIDDY_SSH_TARGET_ARG="${1:-}" ;;
      --teardown) mode=teardown ;;
      --force) FIDDY_ALLOW_UNDERSIZED=1 ;;
      -h|--help)
        cat <<EOF
fiddy provision — furnish the compute your node will run on.

  --aws             Create an AWS EC2 instance with Docker preinstalled.
  --gcp             Create a Google Cloud VM (e2-standard-4 + 2 TB HDD).
                    Needs: gcloud CLI signed in (gcloud auth login) and a
                    project set (gcloud config set project ...).
                    Options: FIDDY_GCP_ZONE (default us-central1-a)
                             FIDDY_GCP_TYPE (default e2-standard-4)
  --ovh             OVHcloud Public Cloud: b3-16 + 2 TB Classic volume (~\$190/mo).
                    Needs: OVH_APPLICATION_KEY / _SECRET / CONSUMER_KEY and
                    OVH_PUBLIC_CLOUD_PROJECT env vars (api.ovh.com/createToken).
                    NOTE: not yet battle-tested — fails loudly with API errors.
  --hetzner         Hetzner Cloud: CCX33 + 2 TB volume (~€120/mo).
                    Needs: HCLOUD_TOKEN env (console.hetzner.cloud → project →
                    Security → API tokens). NOTE: not yet battle-tested.
                    Needs: aws CLI configured (aws configure).
                    Defaults: m5.xlarge (4 vCPU / 16 GB) in ${FIDDY_AWS_REGION:-us-east-1}
                              with a ${FIDDY_AWS_VOLUME_GB:-2048} GB gp3 volume.
                    Options: FIDDY_AWS_REGION, FIDDY_AWS_INSTANCE_TYPE,
                             FIDDY_AWS_VOLUME_GB
                    Rough list price: instance + volume (printed before it runs).
  --ssh user@host   Skip creation — use a server you already have.
                    Needs: SSH key auth already working, sudo on the remote.
  --teardown        Give back the AWS compute --aws created (terminate the
                    instance, delete its volume, key pair and security group)
                    and print a verdict read back from AWS. Irreversible.
                    Same script the deploy-agent runs, so a lapsed managed
                    subscription and this command take one path.
  --force           Skip the requirements preflight (see below).

A Snapchain mainnet read node needs 4 vCPU, 16 GB RAM and 1.5 TB of free
disk, a public IP, and ports 3381-3383 reachable (gossip is 3382/udp).
Snapshot bootstrap needs scratch space beyond that. fiddy checks the target
before installing and refuses to fill a machine that cannot host the node.

The target is saved to ~/.fiddy/config (mode 0600).
EOF
        return 0 ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  case "$mode" in
    aws) provision_aws ;;
    gcp) provision_gcp ;;
    ovh) provision_ovh ;;
    hetzner) provision_hetzner ;;
    ssh) provision_ssh "${FIDDY_SSH_TARGET_ARG:?missing user@host after --ssh}" ;;
    teardown) provision_teardown ;;
    *)
      step "fiddy provision"
      echo "Pick your compute (free first, then default):"
      echo "  0. Your own machine (FREE):                fiddy node up --local"
      echo "  1. AWS (~\$285/mo — DEFAULT cloud):          fiddy provision --aws"
      echo "     Why default: Hetzner caps NEW accounts at 1024 GB of volume"
      echo "     storage (verified: resize refused, resource_limit_exceeded) —"
      echo "     not enough for an unmodified node restore. AWS root volumes"
      echo "     can simply be 2 TB."
      echo "  2. Hetzner (~€120/mo, cheapest — fine once   fiddy provision --hetzner"
      echo "     your account's volume quota is raised):"
      echo "  3. OVH Public Cloud (~\$190/mo):              fiddy provision --ovh"
      echo "  4. Google Cloud (~\$350/mo, TESTED by us):    fiddy provision --gcp"
      echo "     …or one click in Cloud Shell: https://fiddy.fun/client#step0"
      echo "  5. Any server you have:                    fiddy provision --ssh user@host"
      echo "     (budget VPS from ~€24/mo — MivoCloud, Advin, Contabo, LuxVPS —"
      echo "     are order-manually paths: see https://fiddy.fun/client/deploy/)"
      echo ""
      echo "Hetzner and OVH are scripted against their API docs but not yet"
      echo "battle-tested (they fail loudly); GCP is the path our own node ran."
      echo "Honest prices measured/published 2026-10 — check before committing."
      echo ""
      echo "Minimum for a Snapchain mainnet read node: 4 vCPU, 16 GB RAM,"
      echo "1.5 TB free disk, public IP, ports 3381-3383 TCP+UDP."
      echo "A cheaper 2 TB VPS from any provider works just as well — see the tutorial."
      ;;
  esac
}

provision_gcp() {
  require gcloud "install: https://cloud.google.com/sdk/docs/install (or use the one-click Cloud Shell path: https://fiddy.fun/client#step0)"
  # The deploy script owns VM + firewall creation and is deliberately the same
  # one Cloud Shell users run — one path, no drift.
  FIDDY_GCP_ZONE="${FIDDY_GCP_ZONE:-us-central1-a}" bash "$FIDDY_REPO/scripts/gcp-deploy.sh" \
    || die "GCP deploy failed — see the output above"
  local name="${FIDDY_GCP_NAME:-fiddy-node}" zone="${FIDDY_GCP_ZONE:-us-central1-a}" ip
  ip="$(gcloud compute instances describe "$name" --zone "$zone" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')" \
    || die "instance created but no external IP — check: gcloud compute instances describe $name --zone $zone"
  config_set FIDDY_TARGET "$(whoami)@$ip"
  config_set FIDDY_PROVIDER "gcp"
  ok "compute ready: $(whoami)@$ip"
  ok "Next: fiddy node up"
}

provision_ovh() {
  require curl "install curl"; require openssl "install openssl"; require python3 "install python3"
  # Same script the docs walk through — one path, no drift. It writes the IP to
  # $FIDDY_HOME/ovh-last-ip on success.
  mkdir -p "$FIDDY_HOME"
  bash "$FIDDY_REPO/scripts/ovh-deploy.sh" || die "OVH deploy failed — see the output above"
  local ip
  ip="$(cat "$FIDDY_HOME/ovh-last-ip" 2>/dev/null || true)"
  [ -n "$ip" ] || die "deploy finished but no IP was recorded — re-run, or: fiddy provision --ssh ubuntu@<IP-from-output>"
  config_set FIDDY_TARGET "ubuntu@$ip"
  config_set FIDDY_PROVIDER "ovh"
  ok "compute ready: ubuntu@$ip"
  ok "Next: fiddy node up"
}

provision_hetzner() {
  require curl "install curl"; require python3 "install python3"
  # Same script the docs walk through — one path, no drift. Writes the IP to
  # $FIDDY_HOME/hetzner-last-ip on success.
  mkdir -p "$FIDDY_HOME"
  bash "$FIDDY_REPO/scripts/hetzner-deploy.sh" || die "Hetzner deploy failed — see the output above"
  local ip
  ip="$(cat "$FIDDY_HOME/hetzner-last-ip" 2>/dev/null || true)"
  [ -n "$ip" ] || die "deploy finished but no IP was recorded — re-run, or: fiddy provision --ssh root@<IP-from-output>"
  config_set FIDDY_TARGET "root@$ip"
  config_set FIDDY_PROVIDER "hetzner"
  ok "compute ready: root@$ip"
  ok "Next: fiddy node up"
}

provision_ssh() {
  local target="$1"
  require ssh "install openssh"
  step "Registering existing server: $target"
  log "checking SSH (BatchMode, 10s timeout)…"
  local probe
  config_load                       # pick up FIDDY_SSH_KEY if a previous run saved one
  build_ssh_args
  probe="$(ssh "${FIDDY_SSH_ARGS[@]}" "$target" 'echo fiddy-ok && uname -sm && (command -v docker >/dev/null && docker --version || echo no-docker)' 2>&1)" \
    || true
  printf '%s\n' "$probe"
  case "$probe" in
    *fiddy-ok*) ;;
    *) die "cannot reach $target — fix key auth first (ssh-copy-id $target)" ;;
  esac
  config_set FIDDY_TARGET "$target"
  config_set FIDDY_PROVIDER "ssh"

  # Same preflight the node install runs, done here so the answer arrives
  # before anything is installed.
  preflight_remote
  preflight_verdict "${FIDDY_ALLOW_UNDERSIZED:-0}"
  ok "target saved. Next: fiddy node up"
}

provision_aws() {
  if ! command -v aws >/dev/null 2>&1; then
    # The #1 real-user mistake (measured 2026-10-24): provisioning runs FROM a
    # machine that talks to AWS (laptop / CloudShell). People clone the repo
    # ON the VPS they made by hand and hit this error there.
    warn "no aws CLI here. Two readings:"
    warn "  • you meant to CREATE a server → install the AWS CLI on your laptop"
    warn "    (or use the CloudShell button at fiddy.fun/client) and run this there"
    warn "  • you ALREADY MADE the server and are SSH'd into it → skip provision:"
    warn "    fiddy node up --local"
    die "install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
  fi
  require ssh "install openssh"

  local region="${FIDDY_AWS_REGION:-us-east-1}"
  local itype="${FIDDY_AWS_INSTANCE_TYPE:-m5.xlarge}"   # matches Farcaster's own guide
  local volume_gb="${FIDDY_AWS_VOLUME_GB:-2048}"        # 1.5 TB minimum + scratch
  local name="fiddy-node-$(date +%s)"
  local sg_name="fiddy-node"
  local my_ip

  # Credentials before resources: a half-provisioned AWS run is worse than a
  # clear "you are not logged in".
  aws sts get-caller-identity >/dev/null 2>&1 \
    || die "aws CLI is not authenticated — run: aws configure  (or: aws sso login)"

  if [ "$volume_gb" -lt "$FIDDY_MIN_DISK_GB" ] 2>/dev/null; then
    warn "FIDDY_AWS_VOLUME_GB=$volume_gb is below the ${FIDDY_MIN_DISK_GB} GB a read node needs"
  fi

  local inst_hr="${FIDDY_AWS_INSTANCE_HOURLY:-0.192}"   # m5.xlarge us-east-1 list
  local gb_mo="${FIDDY_AWS_GP3_GB_MONTH:-0.08}"
  local est
  est="$(awk -v h="$inst_hr" -v g="$volume_gb" -v p="$gb_mo" 'BEGIN {printf "%.0f", h*730 + g*p}')"

  step "Provisioning AWS EC2 ($itype in $region, ${volume_gb} GB gp3)"
  log "estimated list price: \$${est}/month (instance \$$(awk -v h="$inst_hr" 'BEGIN{printf "%.0f", h*730}') + storage \$$(awk -v g="$volume_gb" -v p="$gb_mo" 'BEGIN{printf "%.0f", g*p}'))"
  log "that is the cost of 1.5 TB of state, not a fiddy markup — a 2 TB VPS elsewhere is usually cheaper"

  my_ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')" \
    || die "could not determine your public IP"
  log "your IP: $my_ip (SSH + node API will be restricted to it)"

  # AMI: latest Ubuntu 24.04 LTS amd64 from Canonical's public SSM parameter.
  local ami
  ami="$(aws ec2 describe-images --region "$region" --owners 099720109477 \
    --filters 'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
              'Name=state,Values=available' \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)" \
    || die "AMI lookup failed — check aws credentials (aws sts get-caller-identity)"
  [ "$ami" != "None" ] && [ -n "$ami" ] || die "no Ubuntu 24.04 AMI found in $region"
  log "AMI: $ami"

  # Key pair
  local key_path="$FIDDY_HOME/${name}.pem"
  mkdir -p "$FIDDY_HOME"
  aws ec2 create-key-pair --region "$region" --key-name "$name" \
    --query 'KeyMaterial' --output text > "$key_path" || die "key pair creation failed"
  chmod 600 "$key_path"
  ok "SSH key saved: $key_path"

  # Security group. Snapchain documents 3381-3383 on TCP and UDP; in practice
  # gossip is 3382/udp (quic-v1) with 3382/tcp as the documented pair, and
  # 3381/3383 are the HTTP/gRPC APIs — those stay on your IP only.
  local sg_id
  sg_id="$(aws ec2 create-security-group --region "$region" --group-name "$sg_name-$name" \
    --description "fiddy snapchain read node" --query 'GroupId' --output text)" || die "security group failed"
  for spec in "tcp 22 $my_ip/32" \
              "tcp $SNAP_HTTP_PORT $my_ip/32" "udp $SNAP_HTTP_PORT $my_ip/32" \
              "tcp $SNAP_GRPC_PORT $my_ip/32" "udp $SNAP_GRPC_PORT $my_ip/32" \
              "tcp 3382 0.0.0.0/0" "udp 3382 0.0.0.0/0"; do
    set -- $spec
    aws ec2 authorize-security-group-ingress --region "$region" --group-id "$sg_id" \
      --protocol "$1" --port "$2" --cidr "$3" >/dev/null
  done
  ok "security group: $sg_id (SSH/API → you only; gossip 3382 → world)"

  # user-data: ONE shared file (scripts/aws-node-user-data.sh) so the box this
  # path creates and the box scripts/aws-deploy.sh creates cannot drift —
  # Docker, cron, and the fiddy CLI the node's own terminal is meant to run.
  local ud="$FIDDY_REPO/scripts/aws-node-user-data.sh"
  [ -f "$ud" ] || die "missing $ud — the fiddy checkout is incomplete"

  local iid
  iid="$(aws ec2 run-instances --region "$region" \
    --image-id "$ami" --instance-type "$itype" --key-name "$name" \
    --security-group-ids "$sg_id" --user-data "file://$ud" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$volume_gb,VolumeType=gp3}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$name},{Key=project,Value=fiddy}]" \
    --query 'Instances[0].InstanceId' --output text)" || die "run-instances failed"
  log "instance: $iid — waiting for running state…"
  aws ec2 wait instance-running --region "$region" --instance-ids "$iid"

  local ip
  ip="$(aws ec2 describe-instances --region "$region" --instance-ids "$iid" \
    --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
  [ -n "$ip" ] && [ "$ip" != "None" ] || die "instance has no public IP"

  # Everything a teardown needs, recorded while it is cheap to ask: the volume
  # it owns, its security group, its key pair and its public IP. A teardown can
  # then run from the config alone (fiddy provision --teardown) instead of
  # making a human copy an instance id out of the console.
  local vol_id=""
  vol_id="$(aws ec2 describe-volumes --region "$region" \
    --filters "Name=attachment.instance-id,Values=$iid" \
    --query 'Volumes[0].VolumeId' --output text 2>/dev/null || true)"
  [ "$vol_id" = "None" ] && vol_id=""

  config_set FIDDY_TARGET "ubuntu@$ip"
  config_set FIDDY_PROVIDER "aws"
  config_set FIDDY_SSH_KEY "$key_path"
  config_set FIDDY_AWS_REGION "$region"
  config_set FIDDY_AWS_INSTANCE_ID "$iid"
  config_set FIDDY_AWS_VOLUME_ID "$vol_id"
  config_set FIDDY_AWS_SG_ID "$sg_id"
  config_set FIDDY_AWS_KEY_NAME "$name"
  config_set FIDDY_AWS_IP "$ip"
  config_set FIDDY_AWS_VOLUME_GB "$volume_gb"

  log "waiting for cloud-init (Docker install)…"
  local i
  for ((i = 1; i <= 40; i++)); do
    if ssh -i "$key_path" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
        "ubuntu@$ip" 'command -v docker' >/dev/null 2>&1; then
      ok "compute ready: ubuntu@$ip (${volume_gb} GB disk)"
      ok "Next: fiddy node up"
      ok "Running costs until you stop it — tear down with: aws ec2 terminate-instances --region $region --instance-ids $iid"
      return 0
    fi
    sleep 10
  done
  die "instance is running but Docker never appeared — ssh -i $key_path ubuntu@$ip and check /var/log/cloud-init-output.log"
}

provision_teardown() {
  # The other half of --aws: hand the compute back and prove the billing
  # stopped. Everything it needs is already in ~/.fiddy/config (--aws records
  # the instance, volume, security group and key pair). The AWS work lives in
  # scripts/aws-teardown.sh so `fiddy provision --teardown`, the deploy-agent's
  # teardown job and a human running the script by hand are one code path —
  # a lapsed subscription must not use a different teardown than a person.
  config_load
  local iid="${FIDDY_AWS_INSTANCE_ID:-}"
  local region="${FIDDY_AWS_REGION:-us-east-1}"
  if [ -z "$iid" ]; then
    die "no AWS instance recorded in $FIDDY_CONFIG — for a specific one: bash $FIDDY_REPO/scripts/aws-teardown.sh <instance-id>"
  fi
  step "Tearing down AWS compute ($iid in $region)"
  bash "$FIDDY_REPO/scripts/aws-teardown.sh" "$iid" --region "$region" \
    || die "teardown did not finish cleanly — re-run it or check the AWS console"

  # The saved target pointed at that IP. Clearing it matters: an IP gets
  # recycled, and a stale target would let a later `fiddy node up` install onto
  # a stranger's machine.
  config_set FIDDY_TARGET ""
  config_set FIDDY_AWS_INSTANCE_ID ""
  config_set FIDDY_AWS_VOLUME_ID ""
  config_set FIDDY_AWS_SG_ID ""
  config_set FIDDY_AWS_KEY_NAME ""
  config_set FIDDY_AWS_IP ""
  ok "local config cleared — nothing here points at the torn-down compute"
}