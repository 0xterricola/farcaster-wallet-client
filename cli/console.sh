#!/usr/bin/env bash
# fiddy console — one command to the GUI.
# Starts herdr/Ovis on the node box if needed, opens the SSH tunnel from
# this machine, and launches the browser. No manual herdr, no manual ssh -N.
console_open() {
  config_load 2>/dev/null || true
  local target="${FIDDY_TARGET:-}"

  # A new user on the server sees "fiddy console" in the docs and runs it
  # here. The console is a browser UI; the useful command runs on the laptop.
  if [ "${1:-}" != "--here" ] && [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ] && [ -z "$target" ]; then
    cat <<'EOF'
▸ You are on the server. Run this on your laptop instead — the console is
  a browser UI, and your laptop opens it for you (tunnel included):

    fiddy console

  On the laptop, the first time only:
    fiddy provision --ssh <user>@<this-server-ip>

  To just start the console on this server anyway: fiddy console open --here
EOF
    return 0
  fi
  local url="http://localhost:7317"

  if [ -n "$target" ]; then
    log "console on $target"
    ssh_run 'command -v herdr >/dev/null 2>&1 || [ -x "$HOME/.local/bin/herdr" ]' \
      || die "herdr is not installed on $target yet — run the installer there first:
  curl -fsSL https://fiddy.fun/client/install.sh | bash"
    if ! ssh_run 'curl -fsS -m 2 http://127.0.0.1:7317 >/dev/null 2>&1'; then
      log "starting the console on the server (detached herdr)…"
      ssh_run 'command -v tmux >/dev/null 2>&1 || { command -v apt-get >/dev/null 2>&1 && sudo -n apt-get install -y -qq tmux; } || true
               tmux has-session -t fiddy-console 2>/dev/null || tmux new-session -d -s fiddy-console "export PATH=\$HOME/.local/bin:\$PATH; herdr"' \
        || die "could not start herdr on $target — run: ssh $target, then herdr"
      local i
      for ((i = 1; i <= 30; i++)); do
        ssh_run 'curl -fsS -m 2 http://127.0.0.1:7317 >/dev/null 2>&1' && break
        sleep 2
      done
    fi
    if ! curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      log "opening the tunnel (keeps running in the background)…"
      ssh -N -L 7317:127.0.0.1:7317 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 "$target" &
      echo $! > "$FIDDY_HOME/console-tunnel.pid"
      for ((i = 1; i <= 15; i++)); do
        curl -fsS -m 2 "$url" >/dev/null 2>&1 && break
        sleep 1
      done
    fi
  else
    log "console on this machine"
    command -v herdr >/dev/null 2>&1 \
      || die "herdr is not installed — run: curl -fsSL https://fiddy.fun/client/install.sh | bash"
    if ! curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      log "starting the console (detached herdr)…"
      if command -v tmux >/dev/null 2>&1; then
        tmux has-session -t fiddy-console 2>/dev/null || tmux new-session -d -s fiddy-console 'herdr'
      else
        die "tmux is needed to start the console in the background — brew install tmux (or run herdr yourself in another terminal)"
      fi
      local i
      for ((i = 1; i <= 30; i++)); do
        curl -fsS -m 2 "$url" >/dev/null 2>&1 && break
        sleep 2
      done
    fi
  fi

  curl -fsS -m 3 "$url" >/dev/null 2>&1 \
    || die "the console is not answering at $url yet — on the server, run: herdr (then retry)"
  if command -v open >/dev/null 2>&1; then open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  fi
  # Open the Fiddy Console pane for them; otherwise the browser lands on a
  # terminal tab and the sync view is nowhere obvious. Best-effort only.
  curl -sS -m 10 -X POST "$url/api/plugin/action" \
    -H 'Content-Type: application/json' -H 'x-herdr-machine: 1' \
    -d '{"plugin_id":"fun.fiddy.console","action_id":"open-console"}' >/dev/null 2>&1 || true
  ok "Console: $url  (Fiddy Console tab = sync %, Shift-click Grafana = dashboard)"
}

console_stop() {
  if [ -f "$FIDDY_HOME/console-tunnel.pid" ]; then
    kill "$(cat "$FIDDY_HOME/console-tunnel.pid")" 2>/dev/null || true
    rm -f "$FIDDY_HOME/console-tunnel.pid"
    ok "tunnel closed"
  else
    log "no tunnel running"
  fi
}

console_main() {
  case "${1:-open}" in
    open|up) shift; console_open "$@" ;;
    "") console_open ;;
    stop) console_stop ;;
    *) die "usage: fiddy console [open|stop]" ;;
  esac
}
