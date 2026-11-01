#!/usr/bin/env bash
# Install (or rotate) the deploy-agent's AWS credentials — run ON THE DEPLOY HOST
# (the VPS that runs fiddy-deploy-agent.service), as root.
#
#   ssh root@<vps> bash /opt/fiddy-client/scripts/fiddy-aws-key.sh < key.json
#
# stdin is the JSON that `aws iam create-access-key` prints. It comes in on
# stdin, never as an argument, so the secret key does not land in a command line,
# a shell history file or a log. The two values are written to
# /etc/fiddy/deploy-agent.env (mode 600, the file the agent already reads) and
# nothing is printed except whether the key works.
#
# The key is then proven, not assumed: `sts get-caller-identity` has to answer
# before the agent is restarted with it.
set -euo pipefail

ENV=/etc/fiddy/deploy-agent.env
REGION="${FIDDY_AWS_REGION:-us-east-1}"

[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "aws CLI missing on this host" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 missing on this host" >&2; exit 1; }
[ -f "$ENV" ] || { echo "$ENV does not exist — install the deploy-agent first" >&2; exit 1; }

umask 077
# Read the JSON from stdin once, then hand it to python via the environment:
# a heredoc would occupy stdin, so python could never see the JSON itself.
RAW="$(cat)"
VALUES="$(RAW="$RAW" python3 - <<'PY'
import json, os, sys
try:
    key = json.loads(os.environ["RAW"])["AccessKey"]
except Exception:
    sys.exit("stdin is not the JSON from `aws iam create-access-key`")
ak, sk = key.get("AccessKeyId", ""), key.get("SecretAccessKey", "")
if not ak or not sk:
    sys.exit("that JSON has no AccessKeyId/SecretAccessKey")
print(f"AWS_ACCESS_KEY_ID={ak}")
print(f"AWS_SECRET_ACCESS_KEY={sk}")
PY
)" || exit 1

# Upsert: drop any previous AWS_* lines, then append the new pair. Everything
# else in the file (the agent token, PORT) is preserved.
TMP="$(mktemp)"; chmod 600 "$TMP"
grep -v '^AWS_' "$ENV" > "$TMP" 2>/dev/null || true
printf '%s\nAWS_DEFAULT_REGION=%s\nFIDDY_AWS_REGION=%s\n' "$VALUES" "$REGION" "$REGION" >> "$TMP"
mv "$TMP" "$ENV"
chown root:root "$ENV"; chmod 600 "$ENV"

# Prove the key before anything uses it.
set -a; . "$ENV"; set +a
if ! aws sts get-caller-identity --output json >/dev/null 2>&1; then
  echo "the new key does not work — check the IAM user and policy; the agent keeps its old environment" >&2
  exit 1
fi
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
ARN="$(aws sts get-caller-identity --query Arn --output text)"
echo "✓ key verified: $ARN (account $ACCOUNT)"
echo "✓ stored in $ENV (mode 600) — the value never appeared in a command line"

if systemctl list-unit-files | grep -q '^fiddy-deploy-agent.service'; then
  systemctl restart fiddy-deploy-agent.service
  sleep 1
  systemctl is-active fiddy-deploy-agent.service | sed 's/^/  fiddy-deploy-agent: /'
fi