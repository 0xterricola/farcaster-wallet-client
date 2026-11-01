"""Import non-secret node connection facts from the existing Fiddy CLI config."""

import os
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from console.config import ConfigStore


def read_cli_config(path):
    values = {}
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def bootstrap(store=None, environ=None):
    env = os.environ if environ is None else environ
    store = store or ConfigStore()
    cli = read_cli_config(env.get("FIDDY_CONFIG", Path.home() / ".fiddy" / "config"))
    changes = {}
    if env.get("FIDDY_CONSOLE_TARGET"):
        changes["target"] = env["FIDDY_CONSOLE_TARGET"]
    elif cli.get("FIDDY_TARGET"):
        target = cli["FIDDY_TARGET"]
        host = target.rsplit("@", 1)[-1]
        host = host[1:].split("]", 1)[0] if host.startswith("[") else host.split(":", 1)[0]
        changes["target"] = "local" if host in ("127.0.0.1", "localhost", "::1") else target
    if env.get("FIDDY_CONSOLE_SSH_KEY"):
        changes["ssh_key"] = os.path.expanduser(env["FIDDY_CONSOLE_SSH_KEY"])
    elif cli.get("FIDDY_SSH_KEY"):
        changes["ssh_key"] = cli["FIDDY_SSH_KEY"]
    if env.get("FIDDY_CONSOLE_PROXYJUMP"):
        changes["ssh_proxyjump"] = env["FIDDY_CONSOLE_PROXYJUMP"]
    if env.get("FIDDY_CONSOLE_NETWORK") in ("snapchain", "hypersnap"):
        changes["network"] = env["FIDDY_CONSOLE_NETWORK"]
    elif cli.get("FIDDY_NODE_NETWORK") in ("snapchain", "hypersnap"):
        changes["network"] = cli["FIDDY_NODE_NETWORK"]
    if changes:
        store.update_settings(changes)
    return store.public_settings()


if __name__ == "__main__":
    result = bootstrap()
    print("Fiddy console: %s, %s network." % (result["target"], result["network"]))
