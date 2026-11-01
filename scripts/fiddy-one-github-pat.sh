#!/usr/bin/env bash
# Ships fiddy-one's GitHub PAT to the VPS — hidden entry, stdin over SSH,
# mode-600 storage, verified immediately. The token never touches this Mac's
# disk, shell history, or chat. Safe to re-run (rotates the key).
set -euo pipefail

printf 'Paste the GitHub PAT for the fiddyone account (input hidden): '
read -rs PAT
printf '\n'

if [[ "$PAT" != github_pat_* && "$PAT" != ghp_* ]]; then
  echo "That doesn't look like a GitHub PAT (expected github_pat_… or ghp_…). Aborting."
  exit 1
fi

printf '%s' "$PAT" | ssh -o BatchMode=yes root@100.111.203.78 'bash -s' <<'REMOTE'
set -e
PAT=$(cat)
umask 077
ENV=/etc/fiddy-one/app.env
grep -v "^GITHUB_TOKEN=" "$ENV" > /tmp/.f1env.$$ || true
mv /tmp/.f1env.$$ "$ENV"
printf 'GITHUB_TOKEN=%s\nFIDDY_ONE_GITHUB_USER=fiddyone\n' "$PAT" >> "$ENV"
chmod 600 "$ENV"
curl -sS -m 15 -H "Authorization: Bearer $PAT" https://api.github.com/user \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'login' in d, d; print('PAT verified — login:', d['login'])"
REMOTE

echo "✓ stored in /etc/fiddy-one/app.env (mode 600) on the VPS"
