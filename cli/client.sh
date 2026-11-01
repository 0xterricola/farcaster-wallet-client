# shellcheck shell=bash
# fiddy client — command (2): the Fiddy client, pointed at your node.
#
# What is wired up today, and what is not:
#   * The client's data layer (apps/farcaster-web/src/contexts/
#     WebFarcasterApiClientProvider.tsx → farcaster-client-data) talks to
#     Farcaster's hosted API at https://farcaster.xyz/~api. Its ~700 routes
#     are that API's surface, not the Snapchain HTTP API.
#   * The Snapchain API is the Hubble-compatible /v1/* surface, so pointing
#     the client at the node needs an adapter; the app's own escape hatch for
#     one is `farcasterApi.local` → http://localhost:8080 (see
#     apps/farcaster-web/src/constants/api.ts).
#   * Writes are meant to go to the node's POST /v1/submitMessage — read nodes
#     accept them and gossip to validators.
#
# So `client up` writes the node URL into .env.local for the node-backed data
# layer and says plainly which upstream the app uses today. See
# docs/CLIENT-NODE-GAP.md for the adapter plan and the route inventory.
#
# Two networks are on the menu (`--network snapchain|hypersnap`). Snapchain
# reads come from a node — yours. Hypersnap needs no node: the public Hypersnap
# node (haatz.quilibrium.com) serves reads and relays writes, so this command
# points the client at it and records that (VITE_FIDDY_NETWORK), which is what
# lets the client NAME the network instead of guessing it.
#
# App keys are gasless KEY_ADD messages — no ETH, no Optimism transaction.
# A seed phrase is only ever used in the browser, only to authorize the
# client's app key — use a TEST account.

client_main() {
  local sub="${1:-}"; shift || true
  case "$sub" in
    up) client_up "$@" ;;
    check) client_check ;;
    -h|--help|"")
      cat <<'EOF'
fiddy client — run the Fiddy client against your node.

  up [--network snapchain|hypersnap] [--tunnel] [--build]
      Point the web client at a node and start it.
      --network  Which network to read. snapchain (default): your own node —
                 Farcaster's own network, where every account, cast and follow
                 lives. hypersnap: the public Hypersnap node, an independent
                 parallel network built by the Quilibrium community; nothing of
                 yours runs, and it is for explorers rather than for the account
                 you already have.
      --tunnel   Your node API is not public (default): open an SSH tunnel
                 local 3381/3383 → remote 3381/3383 for the session.
      --build    Production build instead of the dev server.
  check          Verify the node API answers and report where the client's
                 reads go today.

Reads: the node serves them at /v1/* (Hubble-compatible). The client's own
data layer still uses Farcaster's hosted API — see docs/CLIENT-NODE-GAP.md.
EOF
      ;;
    *) die "unknown client command: $sub" ;;
  esac
}

client_node_layer_state() { # "wired" | "not wired" — detect, don't assume
  if grep -rqs "farcaster-node-client" "$FIDDY_REPO/apps/farcaster-web/src" 2>/dev/null \
     || grep -qs '"farcaster-node-client"' "$FIDDY_REPO/apps/farcaster-web/package.json" 2>/dev/null; then
    printf 'wired'
  else
    printf 'not wired'
  fi
}

client_check() {
  config_load
  local node_url="${FIDDY_NODE_HTTP:-}"
  step "Network"
  case "${FIDDY_NODE_NETWORK:-}" in
    snapchain) ok "Snapchain — Farcaster's own network, the one every account, cast and follow lives on" ;;
    hypersnap) ok "Hypersnap — the Quilibrium community's parallel network; it is not where a Farcaster account lives" ;;
    *) warn "not recorded — this node was installed before fiddy knew about networks."
       log "the client will say \"not recorded\" rather than guess: a node does not announce its network." ;;
  esac
  if [ "${FIDDY_NODE_NETWORK:-}" != hypersnap ]; then
    log "reading Hypersnap needs no node at all: fiddy client up --network hypersnap"
  fi
  step "Node"
  if [ -z "$node_url" ]; then
    warn "no node URL recorded yet — run: fiddy node up (or fiddy client up --tunnel)"
  else
    curl -fsS --max-time 10 "$node_url/v1/info" | node_info_summary \
      || warn "node at $node_url is not answering (a fresh node serves HTTP only after its snapshot bootstrap)"
  fi
  step "Client data layer"
  if [ "$(client_node_layer_state)" = wired ]; then
    ok "node-backed data layer present (farcaster-node-client is imported by the web app)"
    log "verify it: block farcaster.xyz / client.farcaster.xyz and check the feed still renders"
  else
    warn "node-backed data layer NOT wired into the web app yet"
    log "upstream API in use: https://farcaster.xyz/~api (farcaster-client-data)"
    log "details: docs/CLIENT-NODE-GAP.md"
  fi
  return 0
}

client_up() {
  local tunnel=0 build=0 network=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --tunnel) tunnel=1 ;;
      --build)  build=1 ;;
      --network) shift || true; network="${1:-}" ;;
      snapchain|hypersnap) network="$1" ;;
      *) die "unknown option: $1 (try: fiddy client --help)" ;;
    esac
    shift
  done

  config_load
  # Default: the network the node install recorded, else Snapchain.
  [ -n "$network" ] || network="${FIDDY_NODE_NETWORK:-$FIDDY_DEFAULT_NETWORK}"
  network_require_known "$network"

  # Seamless deps: a fresh box has neither node nor pnpm — install them
  # instead of pointing at docs (the fatline test report: "NodeJS didn't
  # come built in… had to install node js" by hand).
  if ! command -v node >/dev/null 2>&1; then
    log "Node.js missing — installing it for you…"
    if [ "$(uname -s)" = "Linux" ] && command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/tmp/fiddy-node-install.log 2>&1 \
        && sudo apt-get install -y nodejs >>/tmp/fiddy-node-install.log 2>&1 \
        || die "Node install failed — see /tmp/fiddy-node-install.log"
    elif command -v brew >/dev/null 2>&1; then
      brew install node@22 || die "brew install node@22 failed"
    else
      die "install Node.js 22 first: https://nodejs.org"
    fi
    ok "node $(node --version) installed"
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    log "pnpm missing — enabling via corepack…"
    if command -v corepack >/dev/null 2>&1; then
      corepack enable >/dev/null 2>&1 || sudo corepack enable
      corepack prepare pnpm@10.8.1 --activate >/dev/null 2>&1 || true
    fi
    command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10.8.1 || sudo npm install -g pnpm@10.8.1 \
      || die "install pnpm: npm install -g pnpm"
    ok "pnpm $(pnpm --version) ready"
  fi
  require pnpm "install: https://pnpm.io/installation"

  local web_env="$FIDDY_REPO/apps/farcaster-web/.env.local"
  local node_url="${FIDDY_NODE_HTTP:-}"
  local ssh_host=""

  if [ "$network" = hypersnap ] && [ -z "${FIDDY_NODE_HTTP:-}" ]; then
    # Hypersnap reads and writes go to the public Hypersnap node: nothing to
    # install, nothing of yours runs anywhere. Say which node did the work —
    # this is somebody else's server, and the client's own page repeats it.
    node_url="https://haatz.quilibrium.com"
    log "reading Hypersnap from the public Hypersnap node ($node_url) — nothing of yours runs on it"
  elif [ "$tunnel" = 1 ] || [ -z "$node_url" ]; then
    require_target
    if tunnel_forward_active "$SNAP_HTTP_PORT"; then
      log "127.0.0.1:$SNAP_HTTP_PORT is already forwarded — reusing the open tunnel"
      ssh_host=""
    else
      ssh_host="$FIDDY_TARGET"
    fi
    if [ -n "$ssh_host" ]; then
      # Prefer the recorded node address; fall back to HTTP on the target host.
      local host
      host="$(printf '%s' "$node_url" | sed -e 's#^http://##' -e 's#^https://##' -e 's#:.*$##')"
      [ -n "$host" ] || host="${FIDDY_TARGET#*@}"
      log "opening SSH tunnel: 127.0.0.1:$SNAP_HTTP_PORT/$SNAP_GRPC_PORT → $host:$SNAP_HTTP_PORT/$SNAP_GRPC_PORT"
      build_ssh_args
      ssh "${FIDDY_SSH_ARGS[@]}" -N \
        -L "$SNAP_HTTP_PORT:127.0.0.1:$SNAP_HTTP_PORT" \
        -L "$SNAP_GRPC_PORT:127.0.0.1:$SNAP_GRPC_PORT" \
        "$ssh_host" &
      local tunnel_pid=$!
      trap 'kill $tunnel_pid 2>/dev/null || true' EXIT
      config_set FIDDY_TUNNEL_PID "$tunnel_pid"
      sleep 2
    fi
    node_url="http://127.0.0.1:$SNAP_HTTP_PORT"
  fi

  # The node refuses HTTP for the whole snapshot bootstrap (up to ~2h), so do
  # not treat "not answering yet" as fatal here.
  if ! node_api_reachable "$node_url"; then
    warn "node at $node_url is not answering yet — a fresh read node only serves"
    warn "HTTP after its snapshot bootstrap finishes (up to ~2h). Starting the"
    warn "client anyway; check later with: fiddy node status"
  fi

  step "Configuring the client"
  {
    [ -f "$FIDDY_REPO/apps/farcaster-web/.env.example" ] && grep -v '^#' "$FIDDY_REPO/apps/farcaster-web/.env.example" | grep '=' || true
    echo "VITE_SNAPCHAIN_HTTP_URL=$node_url"
    [ -n "${FIDDY_NODE_GRPC:-}" ] && echo "VITE_SNAPCHAIN_GRPC_URL=$FIDDY_NODE_GRPC"
    # Provenance, not an inference: a node does not announce which network it
    # is, so whoever pointed the client at one records it. The client shows it
    # on Settings → your node and lets the reader switch between the networks it
    # can actually read.
    echo "VITE_FIDDY_NETWORK=$network"
  } > "$web_env"
  # The instance's own Farcaster account is read from the environment this
  # script was started with, and is deliberately NOT copied into .env.local: it
  # is a custody key, and a file in a checkout is one `git add -A` from being
  # somebody's problem. Exporting the two values before `fiddy client up` is
  # enough — the dev server is this script's own child.
  if [ -n "${FIDDY_INSTANCE_APP_FID:-}" ]; then
    ok "this copy of Fiddy asks with its own account (FID ${FIDDY_INSTANCE_APP_FID}) — approvals happen on your phone"
  else
    ok "posting-key approvals happen on your phone: Fiddy's own signer asks for this copy"
    log "to ask with an account of your own instead, export FIDDY_INSTANCE_APP_FID and"
    log "FIDDY_INSTANCE_APP_KEY before this command — docs/CLIENT-SELF-HOSTED-CONNECT.md"
  fi
  ok "wrote $web_env (network: $network, node: $node_url)"

  if [ "$(client_node_layer_state)" = wired ]; then
    ok "node-backed data layer present — the web app imports farcaster-node-client"
    log "confirm it with third-party APIs blocked: farcaster.xyz / client.farcaster.xyz off, feed still renders"
  else
    warn "reads and writes still go to Farcaster's hosted API (farcaster.xyz/~api):"
    warn "the node-backed data layer is not wired into the web app in this checkout."
    warn "the node URL above is recorded for it; details: docs/CLIENT-NODE-GAP.md"
  fi

  if [ ! -d "$FIDDY_REPO/node_modules" ]; then
    log "installing dependencies (first run takes a few minutes)…"
    ( cd "$FIDDY_REPO" && pnpm install )
  fi

  # The shared packages the web client imports expose dist/ builds, so a fresh
  # clone fails in vite with "Failed to resolve entry for package …" until they
  # are built.
  local need_build=0 d
  for d in farcaster-analytics farcaster-client-data farcaster-client-hooks farcaster-cryptography farcaster-cryptography-web; do
    if [ -f "$FIDDY_REPO/packages/$d/package.json" ] && [ ! -d "$FIDDY_REPO/packages/$d/dist" ]; then
      need_build=1
    fi
  done
  if [ "$need_build" = 1 ]; then
    log "building workspace packages (takes a few minutes on a fresh clone)…"
    ( cd "$FIDDY_REPO" && NODE_OPTIONS="--max_old_space_size=8192" pnpm build:packages ) \
      || die "workspace package build failed — run: cd $FIDDY_REPO && pnpm build:packages"
    ok "workspace packages built"
  fi

  step "Starting Fiddy"
  # The upstream dev server forces a self-signed HTTPS cert, which greets every
  # first-time user with a browser security warning. localhost is a secure
  # context over plain HTTP, so nothing needs it — default off, opt back in
  # with HTTPS=true.
  if [ "$build" = 1 ]; then
    ( cd "$FIDDY_REPO" && pnpm --filter farcaster-web build && pnpm --filter farcaster-web preview )
  else
    log "serving plain HTTP on localhost (set HTTPS=true to restore the self-signed cert)"
    ( cd "$FIDDY_REPO" && HTTPS="${HTTPS:-false}" pnpm --filter farcaster-web dev )
  fi
}