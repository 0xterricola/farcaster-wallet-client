# Fiddy Console for Herdr + Ovis

Fiddy Console is a separate Herdr plugin. Ovis discovers its actions as native
buttons; neither project is forked or patched.

## Buttons

Open Ovis's command palette (Cmd/Ctrl+Shift+K) and type `Fiddy`:

- Live node status and sync progress (snapshot chunks while the API is offline,
  then real shard heights and block delay in seconds)
- Logs, start, and stop
- Operator FID, node/SSH settings, and auto-upgrade schedule
- Grafana: the real Snapchain dashboard shipped by `snapchain.sh`

The Grafana button opens a Herdr pane with a loopback-only SSH tunnel and local
proxy. **Shift-click** `[ Open live Grafana ]` in Ovis to embed it beside the
terminal. To make a plain click embed it, choose Ovis Settings → Web links →
Beside the pane. Keep the Herdr pane open while using the dashboard.

The proxy is bound to `127.0.0.1`, requires a single-use token exchanged for an
HttpOnly SameSite session cookie, and removes Grafana's frame-denial headers only at
that local boundary. It never exposes Grafana on a LAN or public interface.
Grafana's first login is `admin` / `admin`; change it in Grafana.

The node API and Grafana stay on the node's loopback interface. For an SSH node,
set its target and private-key path in Settings. `ssh_proxyjump` is optional for
a node whose security group admits only a bastion.

## Install

From a checkout:

```bash
herdr plugin link "$PWD/plugins/fiddy-console"
```

From GitHub after this directory lands on `main`:

```bash
herdr plugin install ivcained/fiddy/plugins/fiddy-console
```

The one-line installer at `https://fiddy.fun/client/install.sh` installs Herdr,
Ovis, and this plugin. On a laptop it prints the Way 1 remote-node path; inside
an SSH session it follows Way 2 and uses the local node. Native Windows uses the
`python` launcher; Mac/Linux uses `python3`. On Windows, use WSL for the shell
installer and a remote node.

## AI is deliberately not required

This release has no agent chat and no Surp key flow. Every button above calls
the node or its CLI directly. A future optional agent pane can be added without
becoming a dependency of node controls or Grafana.

## Tests

```bash
PYTHONPATH=plugins/fiddy-console python3 -m unittest discover -s plugins/fiddy-console/tests -v
```
