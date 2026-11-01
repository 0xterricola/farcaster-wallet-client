#!/usr/bin/env bash
# Tear down a fiddy node's AWS compute — and prove the billing stopped.
#
#   bash scripts/aws-teardown.sh <instance-id> [--region us-east-1] [--fid N] [--json]
#
# Terminates the instance, deletes the volume(s) it owned, then deletes the key
# pair and security group that were created for it — but only after checking no
# other running instance still uses them. With --fid (the managed path), it also
# removes that node's web terminal on THIS host (ttyd unit, nginx snippet,
# state, key) so a token'd /term/ URL can never outlive its node. Finally it
# READS AWS STATE BACK and prints a verdict on the last line as
#
#   FIDDY_TEARDOWN_JSON {"instanceId":"i-…","billingStopped":true,…}
#
# so a caller (the deploy-agent's teardown job) can parse a machine-readable
# answer instead of scraping human text.
#
# Idempotent by design: a second run against an already-terminated instance
# still sweeps leftovers and still prints a verdict. Both the CLI
# (`fiddy provision --teardown`) and the deploy-agent use this one script, so a
# lapsed managed subscription and a human at a terminal take the same path.
set -euo pipefail

REGION="${FIDDY_AWS_REGION:-us-east-1}"
IID=""
FID=""
JSON=0
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="${2:?--region needs a value}"; shift 2 ;;
    --fid) FID="${2:?--fid needs a value}"; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) if [ -z "$IID" ]; then IID="$1"; else echo "unexpected argument: $1" >&2; exit 2; fi; shift ;;
  esac
done

log() { printf '▸ %s\n' "$*"; }
ok()  { printf '✓ %s\n' "$*"; }
warn(){ printf '! %s\n' "$*" >&2; }
die() { warn "$*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v aws >/dev/null 2>&1 || die "aws CLI not found — install it (or run this on the deploy-agent host)"
command -v python3 >/dev/null 2>&1 || die "python3 not found"
aws sts get-caller-identity >/dev/null 2>&1 || die "aws CLI is not authenticated for this host"
[ -n "$IID" ] || die "usage: aws-teardown.sh <instance-id> [--region R] [--fid N] [--json]"
case "$FID" in ''|*[!0-9]*) die "--fid must be a positive integer" ;; esac

# The node's terminal (ttyd unit + nginx snippet + token'd paths on THIS host)
# only exists if a fid was passed — the managed path does, a bare
# `fiddy provision --teardown` does not. Removing it is part of teardown: a
# terminal that outlives its node serves a ttyd that can SSH nowhere, forever
# (measured 2026-10-24, card t_9b6ac005). Called only once billing is verifiably
# stopped, so a half-failed AWS teardown never takes a live node's terminal away.
remove_terminal() {
  [ -n "$FID" ] || return 0
  bash "$SCRIPT_DIR/remove-node-terminal.sh" --fid "$FID" --json \
    || warn "terminal removal for fid $FID reported a problem — run: bash $SCRIPT_DIR/remove-node-terminal.sh --fid $FID"
}

VERDICT=""
emit() { # state note — always prints the JSON line last
  local state="$1" note="$2"
  printf '\n%s\n' "$VERDICT"
  printf 'FIDDY_TEARDOWN_JSON %s\n' "$(STATE="$state" NOTE="$note" IID="$IID" REGION="$REGION" python3 - <<'PY'
import json, os
print(json.dumps({
    "instanceId": os.environ["IID"],
    "region": os.environ["REGION"],
    "state": os.environ["STATE"],
    "note": os.environ["NOTE"],
    "billingStopped": os.environ["STATE"] in ("terminated", "absent"),
}))
PY
)"
}

# --- what are we deleting? -------------------------------------------------
info="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" --output json 2>/dev/null || true)"
if [ -z "$info" ] || [ "$(printf '%s' "$info" | tr -d ' [:space:]')" = "" ]; then
  log "$IID is not in $REGION — already gone (terminated with its volume), or never existed here"
  remove_terminal
  VERDICT='nothing to terminate; no AWS resources are billing for this id'
  emit absent "instance not found in $REGION"
  ok "nothing is running for $IID"
  exit 0
fi

FACTS="$(INFO="$info" python3 - <<'PY'
import json, os
d = json.loads(os.environ["INFO"])["Reservations"][0]["Instances"][0]
key = d.get("KeyName") or "-"
sgs = [s["GroupId"] for s in d.get("SecurityGroups", [])] or ["-"]
vols = [b["Ebs"]["VolumeId"] for b in d.get("BlockDeviceMappings", []) if "Ebs" in b] or ["-"]
name = next((t["Value"] for t in d.get("Tags", []) if t.get("Key") == "Name"), "-")
print(d["State"]["Name"], key, " ".join(sgs), " ".join(vols), name)
PY
)"
STATE="$(printf '%s' "$FACTS" | cut -d' ' -f1)"
KEY_NAME="$(printf '%s' "$FACTS" | cut -d' ' -f2)"
SG_IDS="$(printf '%s' "$FACTS" | cut -d' ' -f3)"
VOL_IDS="$(printf '%s' "$FACTS" | cut -d' ' -f4)"
NAME="$(printf '%s' "$FACTS" | cut -d' ' -f5)"

log "$IID ($NAME) state=$STATE key=$KEY_NAME sg=$SG_IDS volumes=$VOL_IDS"
if [ "$STATE" = "pending" ] || [ "$STATE" = "running" ]; then
  cat <<EOF

Cost honesty: terminating stops instance billing. The volume is deleted with
it, so the ~\$0.08/GB-month storage charge stops too. This is irreversible.
EOF
fi

# --- terminate -------------------------------------------------------------
if [ "$STATE" != "terminated" ] && [ "$STATE" != "shutting-down" ]; then
  aws ec2 terminate-instances --region "$REGION" --instance-ids "$IID" >/dev/null
  log "terminate requested for $IID — waiting for terminated…"
else
  log "instance is already $STATE"
fi
aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$IID" 2>/dev/null \
  || warn "wait instance-terminated timed out; continuing with the sweep"

# --- volumes ---------------------------------------------------------------
VOLS_LEFT=""
DELETED=""
for v in $VOL_IDS; do
  [ "$v" = "-" ] && continue
  # A root volume with DeleteOnTermination is unlinked once the instance is
  # terminated; one that survived (or was created separately) is deleted here.
  for attempt in 1 2 3 4 5 6; do
    vstate="$(aws ec2 describe-volumes --region "$REGION" --volume-ids "$v" \
      --query 'Volumes[0].State' --output text 2>/dev/null || echo absent)"
    [ "$vstate" = "absent" ] && break
    case "$vstate" in
      available) aws ec2 delete-volume --region "$REGION" --volume-id "$v" >/dev/null 2>&1 || true ;;
      in-use)    aws ec2 detach-volume --region "$REGION" --volume-id "$v" >/dev/null 2>&1 || true ;;
    esac
    sleep 5
  done
  vstate="$(aws ec2 describe-volumes --region "$REGION" --volume-ids "$v" \
    --query 'Volumes[0].State' --output text 2>/dev/null || echo absent)"
  if [ "$vstate" = "absent" ]; then DELETED="$DELETED $v"; else VOLS_LEFT="$VOLS_LEFT $v($vstate)"; fi
done
[ -n "$DELETED" ] && ok "volumes gone:$DELETED"
[ -n "$VOLS_LEFT" ] && warn "volumes still billing:$VOLS_LEFT"

# --- key pair and security group (only if nothing else uses them) ----------
# A fiddy node's key/SG are named fiddy-node-*; anything else is not ours to
# delete. Before deleting we ask AWS whether another instance still holds them —
# two nodes sharing a group must not take each other down.
other_instances_using() { # "$1" = filter name (key-name | security-group-id) "$2" = value
  aws ec2 describe-instances --region "$REGION" \
    --filters "Name=$1,Values=$2" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null \
    | tr '\t' '\n' | grep -v "^$IID$" | grep -v '^None$' | head -1
}

KEY_DELETED=false
if [ "$KEY_NAME" != "-" ] && [ "$KEY_NAME" != "None" ]; then
  case "$KEY_NAME" in
    fiddy-node*)
      if [ -n "$(other_instances_using key-name "$KEY_NAME")" ]; then
        warn "key pair $KEY_NAME still used by another instance — keeping it"
      else
        aws ec2 delete-key-pair --region "$REGION" --key-name "$KEY_NAME" >/dev/null 2>&1 \
          && KEY_DELETED=true && ok "key pair deleted: $KEY_NAME" \
          || warn "could not delete key pair $KEY_NAME"
      fi ;;
    *) warn "key pair $KEY_NAME is not fiddy-managed — keeping it" ;;
  esac
fi

SGS_DELETED=""
SGS_LEFT=""
for g in $SG_IDS; do
  [ "$g" = "-" ] && continue
  gname="$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$g" \
    --query 'SecurityGroups[0].GroupName' --output text 2>/dev/null || echo None)"
  if [ "$gname" = "None" ]; then continue; fi
  case "$gname" in
    fiddy-node*) ;;
    *) warn "security group $g ($gname) is not fiddy-managed — keeping it"; continue ;;
  esac
  if [ -n "$(other_instances_using security-group-id "$g")" ]; then
    warn "security group $g still used by another instance — keeping it"; continue
  fi
  deleted=false
  for attempt in 1 2 3 4 5 6; do
    if aws ec2 delete-security-group --region "$REGION" --group-id "$g" >/dev/null 2>&1; then deleted=true; break; fi
    sleep 5
  done
  if [ "$deleted" = true ]; then SGS_DELETED="$SGS_DELETED $g"; else SGS_LEFT="$SGS_LEFT $g"; fi
done
[ -n "$SGS_DELETED" ] && ok "security groups gone:$SGS_DELETED"
[ -n "$SGS_LEFT" ] && warn "security groups still present:$SGS_LEFT"

# --- verdict: read the state back, don't assume ---------------------------
FINAL="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$IID" \
  --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo absent)"
VOLS_STILL=""
for v in $VOL_IDS; do
  [ "$v" = "-" ] && continue
  s="$(aws ec2 describe-volumes --region "$REGION" --volume-ids "$v" --query 'Volumes[0].State' --output text 2>/dev/null || echo absent)"
  [ "$s" != "absent" ] && VOLS_STILL="$VOLS_STILL $v($s)"
done

VERDICT="instance $IID is $FINAL in $REGION; volumes deleted:$DELETED; key deleted=$KEY_DELETED; groups deleted:$SGS_DELETED"
[ -n "$VOLS_STILL" ] && VERDICT="$VERDICT; STILL BILLING:$VOLS_STILL"

if [ "$FINAL" = "terminated" ] && [ -z "$VOLS_STILL" ]; then
  remove_terminal
  ok "billing stopped: $IID terminated, no volume left behind"
  emit terminated "compute and storage gone"
elif [ "$FINAL" = "absent" ]; then
  remove_terminal
  ok "billing stopped: $IID absent from $REGION"
  emit absent "instance gone"
else
  warn "not clean: state=$FINAL volumes_left='$VOLS_STILL'"
  warn "terminal left in place — the instance may still be reachable"
  emit "$FINAL" "teardown incomplete — check manually"
  exit 1
fi