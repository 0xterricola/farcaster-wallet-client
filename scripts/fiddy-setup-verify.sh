#!/usr/bin/env bash
#
# fiddy: re-check the keys you saved, without re-reading the wizard.
#
# Run this any time after scripts/fiddy-setup.command — a week later, on a
# different day, after a key was rotated, to find out whether what is in
# apps/farcaster-web/.env.local still works. Every check is READ-ONLY:
#
#   Neynar       one user lookup by fid (GET /v2/farcaster/user/bulk?fids=3)
#   Pinata       Pinata's own test endpoint (GET /data/testAuthentication)
#   Reown id     format only — the relay validates over a websocket, so the real
#                proof is the wallet sheet connecting in a browser, and saying
#                otherwise here would be a claim this script cannot make
#   your node    its own status (GET /v1/info)
#
# No value is printed, and no value is passed in a command line: secrets travel
# through curl's config on stdin (`--config -`), because anything in argv is
# visible to every process on the machine.
#
# Exit codes: 0 = everything present is accepted, 1 = something present was
# refused, 2 = the env file could not be read.

set -uo pipefail

_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${FIDDY_ENV_FILE:-$_REPO_ROOT/apps/farcaster-web/.env.local}"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; GREEN=""; YELLOW=""; RED=""
fi

say()  { printf '  %s\n' "$1"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
skip() { printf '  %s–%s %s\n' "$DIM" "$RESET" "$1"; }

if ! command -v curl >/dev/null 2>&1; then
  bad "curl is not installed, and every check here needs it."
  exit 2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  skip "no $ENV_FILE yet — run scripts/fiddy-setup.command first"
  exit 0
fi
if [[ ! -r "$ENV_FILE" ]]; then
  bad "$ENV_FILE cannot be read"
  exit 2
fi

printf '\n%s%s  fiddy: checking what you saved%s\n' "$BOLD" "$BOLD" "$RESET"
say "$ENV_FILE"
printf '\n'

# Value of KEY, or empty. Never printed by this script.
value_of() {
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n1)" || return 0
  printf '%s' "${line#*=}"
}

# One read-only request; prints the HTTP status, body goes to $4.
probe_request() {
  local url="$1" name="$2" secret="$3" out="$4"
  if [[ -n "$name" ]]; then
    case "$secret" in
      *'"'*|*$'\n'*|*$'\r'*) printf '000'; return 2 ;;
    esac
    printf 'header = "%s: %s"\n' "$name" "$secret" |
      curl --silent --show-error --max-time 12 --output "$out" --write-out '%{http_code}' --config - "$url"
  else
    curl --silent --show-error --max-time 12 --output "$out" --write-out '%{http_code}' "$url"
  fi
}

failures=0

# ── Neynar ─────────────────────────────────────────────────────────────────
neynar_key="$(value_of VITE_NEYNAR_API_KEY)"
if [[ -z "$neynar_key" ]]; then
  skip "Neynar: no key saved (it is optional)"
else
  out="$(mktemp)"
  # `|| status="000"` rather than `|| printf '000'`: curl prints its own 000
  # when it cannot connect, so the old form could report "000000" — a status no
  # server ever sent, in a sentence a human has to read.
  status="$(probe_request 'https://api.neynar.com/v2/farcaster/user/bulk?fids=3' 'x-api-key' "$neynar_key" "$out" 2>/dev/null)" || status="000"
  rm -f "$out"
  case "$status" in
    200) ok "Neynar: your key is accepted" ;;
    401|402) bad "Neynar: refused your key ($status) — it may have been rotated or its plan changed"; failures=$((failures + 1)) ;;
    000) bad "Neynar: no answer (the network or the endpoint is unreachable from here)"; failures=$((failures + 1)) ;;
    *) bad "Neynar: answered with an error ($status)"; failures=$((failures + 1)) ;;
  esac
fi

# ── Pinata ─────────────────────────────────────────────────────────────────
pinata_jwt="$(value_of PINATA_JWT)"
if [[ -z "$pinata_jwt" ]]; then
  skip "Pinata: nothing saved (it is optional, and Fiddy does not use it yet)"
else
  out="$(mktemp)"
  status="$(probe_request 'https://api.pinata.cloud/data/testAuthentication' 'Authorization' "Bearer $pinata_jwt" "$out" 2>/dev/null)" || status="000"
  rm -f "$out"
  case "$status" in
    200) ok "Pinata: your key is accepted" ;;
    401) bad "Pinata: refused your key ($status) — it may have been revoked"; failures=$((failures + 1)) ;;
    000) bad "Pinata: no answer from here"; failures=$((failures + 1)) ;;
    *) bad "Pinata: answered with an error ($status)"; failures=$((failures + 1)) ;;
  esac
fi

# ── Reown project id ───────────────────────────────────────────────────────
reown_id="$(value_of VITE_WALLETCONNECT_PROJECT_ID)"
if [[ -z "$reown_id" ]]; then
  skip "Reown: no project id saved — wallets will not connect"
elif [[ "$reown_id" == "your_reown_project_id" ]]; then
  bad "Reown: still the placeholder your_reown_project_id — wallets will not connect"; failures=$((failures + 1))
elif [[ "$reown_id" =~ ^[0-9a-fA-F]{32}$ ]]; then
  ok "Reown: a project id is saved, and it has the right shape"
  skip "      (only a browser can prove it works: open the wallet sheet)"
else
  bad "Reown: what is saved is not a 32-character project id"; failures=$((failures + 1))
fi

# ── Your own node ──────────────────────────────────────────────────────────
node_url="$(value_of VITE_SNAPCHAIN_HTTP_URL)"
if [[ -z "$node_url" ]]; then
  skip "Your node: none configured (Fiddy reads from the public node, chosen in the app)"
else
  out="$(mktemp)"
  status="$(probe_request "${node_url%/}/v1/info?dbstats=0" '' '' "$out" 2>/dev/null)" || status="000"
  if [[ "$status" == "200" ]] && grep -q 'maxHeight' "$out" 2>/dev/null; then
    version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$out" | head -n1 | sed -E 's/.*"([^"]*)"$/\1/')"
    delay="$(grep -o '"blockDelay"[[:space:]]*:[[:space:]]*[0-9]*' "$out" | head -n1 | grep -o '[0-9]*$')"
    ok "Your node: answering (${version:+v$version }${delay:+blockDelay $delay})"
  else
    rm -f "$out"
    bad "Your node: did not answer /v1/info (status ${status}) — check that it is running and reachable"; failures=$((failures + 1))
    out=""
  fi
  [[ -n "$out" ]] && rm -f "$out"
fi

# ── File hygiene: a file full of credentials should be yours alone ─────────
printf '\n'
mode="$(stat -f '%Sp' "$ENV_FILE" 2>/dev/null || stat -c '%A' "$ENV_FILE" 2>/dev/null || printf '?')"
case "$mode" in
  *------) ok "file mode is $mode (yours alone)" ;;
  *) printf '  %s⚠%s file mode is %s — run: chmod 600 %s\n' "$YELLOW" "$RESET" "$mode" "$ENV_FILE" ;;
esac
if git -C "$_REPO_ROOT" check-ignore -q "$ENV_FILE" 2>/dev/null; then
  ok "the file is ignored by git (it will not be committed)"
else
  printf '  %s⚠%s this file is NOT ignored by git — do not commit it\n' "$YELLOW" "$RESET"
fi

printf '\n'
if (( failures == 0 )); then
  printf '  %s%s✓ everything saved is still accepted%s\n\n' "$BOLD" "$GREEN" "$RESET"
  exit 0
fi
printf '  %s%s✗ %d thing(s) need attention%s\n\n' "$BOLD" "$RED" "$failures" "$RESET"
exit 1