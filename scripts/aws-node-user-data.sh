#!/bin/bash
# cloud-init user-data for a fiddy node box. ONE file, used by BOTH paths that
# create AWS compute — cli/provision.sh --aws (the deploy-agent's managed path)
# and scripts/aws-deploy.sh (the CloudShell path) — so the box a customer pays
# for and the box a person at a terminal creates cannot drift.
#
# What it leaves behind:
#   * Docker (the node runs in compose)
#   * cron (snapchain.sh gates on crontab existing)
#   * the fiddy CLI at /usr/local/bin/fiddy, so `fiddy node status` resolves
#     from the box's own web terminal
set -euo pipefail

curl -fsSL https://get.docker.com | bash
usermod -aG docker ubuntu
apt-get install -y cron git
systemctl enable --now cron

# Install the fiddy CLI system-wide so `fiddy` resolves from any shell/session.
# Loudly, with a fallback: a plain `git clone 2>/dev/null || pull` pair failed
# silently on a real node (measured 2026-10-24, card t_9b6ac005) and left the
# box with no CLI at all — `fiddy: command not found` in the very terminal this
# box exists to serve, with nothing in the log to say why.
install_fiddy_cli() {
  rm -rf /opt/fiddy
  if ! git clone --depth 1 https://github.com/ivcained/fiddy /opt/fiddy; then
    echo "! git clone failed — falling back to the source tarball" >&2
    mkdir -p /opt/fiddy && curl -fsSL https://codeload.github.com/ivcained/fiddy/tar.gz/refs/heads/main \
      | tar -xz --strip-components=1 -C /opt/fiddy || return 1
  fi
  chmod +x /opt/fiddy/bin/fiddy || return 1
  ln -sf /opt/fiddy/bin/fiddy /usr/local/bin/fiddy || return 1
  return 0
}
if install_fiddy_cli; then
  echo "fiddy CLI: $(command -v fiddy)"
else
  echo "! fiddy CLI install FAILED — this node's web terminal will have no 'fiddy' command" >&2
fi
