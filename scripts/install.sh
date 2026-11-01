#!/usr/bin/env bash
# Fiddy's single installer: local terminal = Way 1, inside SSH = Way 2.
#   curl -fsSL https://fiddy.fun/client/install.sh | bash
set -euo pipefail

REPO_URL="${FIDDY_REPO_URL:-https://github.com/ivcained/fiddy}"
REPO_REF="${FIDDY_REPO_REF:-main}"
DEST="${FIDDY_INSTALL_DIR:-$HOME/fiddy}"
INSTALL_NODE="${FIDDY_INSTALL_NODE:-auto}"
INSTALL_CONSOLE="${FIDDY_INSTALL_CONSOLE:-1}"
REMOTE=0
if [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then REMOTE=1; fi

say() { printf '\n\033[38;5;154m▸ %s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; elif need sudo; then sudo "$@"; else
    echo "Need root for: $*" >&2; exit 1
  fi
}

if [ "$REMOTE" = 1 ]; then
  say "Way 2: you are inside the server. Fiddy will use this machine's node."
else
  say "Way 1: you are on your own computer. Fiddy will drive a remote node over SSH."
fi

if ! need git || ! need curl || ! need python3 || ! need unzip; then
  if need apt-get; then
    as_root apt-get update -qq
    as_root apt-get install -y git curl python3 unzip
  else
    echo "Install git, curl, Python 3, and unzip, then re-run this installer." >&2
    exit 1
  fi
fi

say "Installing the Fiddy checkout in $DEST"
if [ -d "$DEST/.git" ]; then
  if [ -n "$(git -C "$DEST" status --porcelain)" ]; then
    echo "$DEST has uncommitted work. Commit, stash, or choose another FIDDY_INSTALL_DIR; the installer will not overwrite it." >&2
    exit 1
  fi
  git -C "$DEST" fetch origin "$REPO_REF"
  git -C "$DEST" checkout -B fiddy-installed "FETCH_HEAD"
else
  git clone --branch "$REPO_REF" "$REPO_URL" "$DEST"
fi

say "Putting fiddy on PATH"
BIN_DIR="${FIDDY_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
ln -sf "$DEST/bin/fiddy" "$BIN_DIR/fiddy"
export PATH="$BIN_DIR:$HOME/.local/bin:$PATH"
case "${SHELL:-}" in *zsh) USER_PROFILE="$HOME/.zprofile" ;; *) USER_PROFILE="$HOME/.profile" ;; esac
touch "$USER_PROFILE"
if ! grep -q 'fiddy-installer PATH' "$USER_PROFILE"; then
  printf '\n# fiddy-installer PATH\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$USER_PROFILE"
fi

if [ "$INSTALL_CONSOLE" = 1 ]; then
  export PATH="$HOME/.local/bin:$PATH"
  if ! need herdr; then
    say "Installing Herdr"
    curl -fsSL https://herdr.dev/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  PLUGINS="$(herdr plugin list 2>/dev/null || true)"
  if [[ "$PLUGINS" != *devswha.ovis* ]]; then
    say "Installing Ovis"
    curl -fsSL https://ovis.sh/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
  say "Installing the Fiddy console buttons"
  if [[ "$PLUGINS" != *fun.fiddy.console* ]]; then
    if [ -n "${FIDDY_CONSOLE_PLUGIN_DIR:-}" ]; then
      herdr plugin link "$FIDDY_CONSOLE_PLUGIN_DIR"
    elif [ -f "$DEST/plugins/fiddy-console/herdr-plugin.toml" ]; then
      herdr plugin link "$DEST/plugins/fiddy-console"
    else
      herdr plugin install ivcained/fiddy/plugins/fiddy-console
    fi
  fi
  FIDDY_CONSOLE_HOME="${FIDDY_CONSOLE_HOME:-$(herdr plugin config-dir fun.fiddy.console)}"
  export FIDDY_CONSOLE_HOME
  python3 "$DEST/plugins/fiddy-console/console/bootstrap.py"
fi

if [ "$INSTALL_CONSOLE" = 1 ]; then
  cat <<'EOF'

Fiddy Console is installed. Start Herdr:
  herdr
Then open Ovis, press Cmd/Ctrl+Shift+K, and type Fiddy. The node buttons are native.
On a headless server, from your laptop instead:
  ssh -N -L 7317:127.0.0.1:7317 <user>@<this-server-ip>
then open http://localhost:7317 in your browser.
For Grafana: Fiddy → Open Grafana dashboard, then Shift-click [ Open live Grafana ].
Set Ovis Settings → Web links → Beside the pane to embed with a plain click.
No AI key is needed for node controls or Grafana.
Grafana panels show "No data" during the snapshot download — live sync % is in the Fiddy pane.
EOF
fi

SHOULD_INSTALL_NODE=0
case "$INSTALL_NODE" in
  1|yes|true) SHOULD_INSTALL_NODE=1 ;;
  0|no|false) SHOULD_INSTALL_NODE=0 ;;
  auto)
    if [ "$REMOTE" = 1 ] && [ ! -f "$HOME/snapchain/snapchain.sh" ]; then SHOULD_INSTALL_NODE=1; fi
    ;;
  *) echo "FIDDY_INSTALL_NODE must be auto, 1, or 0." >&2; exit 2 ;;
esac

if [ "$SHOULD_INSTALL_NODE" = 1 ]; then
  say "Installing Snapchain with the official node script (2 TB preflight applies)"
  fiddy node up --local
elif [ "$REMOTE" = 1 ]; then
  say "Using the Snapchain install already on this server"
else
  cat <<'EOF'

Next, Way 1: create or register your 2 TB server, then install its node.
  fiddy provision --ssh ubuntu@<server-ip>
  fiddy node up
Open Fiddy Console → Settings in Herdr and set that same SSH target.
EOF
fi

