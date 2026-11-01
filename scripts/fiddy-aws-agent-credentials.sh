#!/usr/bin/env bash
# Create the AWS identity the deploy-agent uses, and give it a key — run ON A
# MACHINE WITH ADMIN CREDENTIALS (a laptop with `aws login`, or CloudShell).
#
#   bash scripts/fiddy-aws-agent-credentials.sh [--rotate]
#
# What it makes, idempotently:
#   * IAM user   fiddy-deploy-agent
#   * policy     fiddy-deploy-agent-ec2 — the EC2 calls a node's whole life needs
#                (create, describe, terminate, key pair, security group, volume,
#                snapshot), and nothing else. No IAM, no S3, no billing, no other
#                region: a stolen key can run up a node bill, not read your data.
#   * one access key, whose secret is piped straight to the deploy host's
#     installer (scripts/fiddy-aws-key.sh) over SSH and never printed here.
#
# --rotate replaces the key: the new one goes to the host first, and only after
# the host proves it does, are previously created keys for this user deleted.
set -euo pipefail

USER_NAME="${FIDDY_AWS_USER:-fiddy-deploy-agent}"
POLICY_NAME="${FIDDY_AWS_POLICY:-fiddy-deploy-agent-ec2}"
REGION="${FIDDY_AWS_REGION:-us-east-1}"
VPS="${FIDDY_DEPLOY_HOST:-root@100.111.203.78}"
KEY_INSTALLER="${FIDDY_KEY_INSTALLER:-/opt/fiddy-client/scripts/fiddy-aws-key.sh}"

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }
[ "${1:-}" = "--rotate" ] && ROTATE=1 || ROTATE=0
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage || true

command -v aws >/dev/null 2>&1 || { echo "aws CLI not found" >&2; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || { echo "not authenticated for IAM work (need admin)" >&2; exit 1; }

POLICY_DOC="$(mktemp)"; trap 'rm -f "$POLICY_DOC"' EXIT
cat > "$POLICY_DOC" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "OneNodeLifecycle",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeImages",
        "ec2:CreateTags",
        "ec2:CreateKeyPair",
        "ec2:DeleteKeyPair",
        "ec2:DescribeKeyPairs",
        "ec2:CreateSecurityGroup",
        "ec2:DeleteSecurityGroup",
        "ec2:DescribeSecurityGroups",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:DescribeVolumes",
        "ec2:CreateVolume",
        "ec2:DeleteVolume",
        "ec2:AttachVolume",
        "ec2:DetachVolume",
        "ec2:DescribeSnapshots",
        "ec2:ModifyInstanceAttribute"
      ],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "$REGION" } }
    },
    {
      "Sid": "WhoAmI",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
JSON

echo "▸ IAM user $USER_NAME"
if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  echo "  (exists)"
else
  aws iam create-user --user-name "$USER_NAME" >/dev/null
  echo "  created"
fi

echo "▸ policy $POLICY_NAME (EC2 lifecycle in $REGION only)"
POLICY_ARN="$(aws iam list-policies --scope Local --query "Policies[?PolicyName=='$POLICY_NAME'].Arn" --output text)"
if [ -n "$POLICY_ARN" ] && [ "$POLICY_ARN" != "None" ]; then
  aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document "file://$POLICY_DOC" --set-as-default >/dev/null
  echo "  policy updated to this document"
else
  POLICY_ARN="$(aws iam create-policy --policy-name "$POLICY_NAME" --policy-document "file://$POLICY_DOC" --query 'Policy.Arn' --output text)"
  echo "  created: $POLICY_ARN"
fi
aws iam attach-user-policy --user-name "$USER_NAME" --policy-arn "$POLICY_ARN"
echo "  attached"

echo "▸ new access key (the secret goes over SSH to $VPS and is never printed)"
aws iam create-access-key --user-name "$USER_NAME" --output json \
  | ssh -o BatchMode=yes "$VPS" "bash $KEY_INSTALLER"

if [ "$ROTATE" = 1 ]; then
  echo "▸ deleting the user's older access keys"
  NEW_ID="$(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[-1].AccessKeyId' --output text)"
  while read -r kid; do
    [ -z "$kid" ] && continue
    [ "$kid" = "$NEW_ID" ] && continue
    aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$kid"
    echo "  deleted $kid"
  done < <(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text | tr '\t' '\n')
fi

echo "✓ done. The deploy-agent now holds an EC2-only key in mode-600 /etc/fiddy/deploy-agent.env on $VPS."