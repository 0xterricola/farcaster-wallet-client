import json
import os
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from console.config import ConfigStore
from console.node import NodeError, NodeManager
from console.proxy import GrafanaProxy


def hyperlink(url, label):
    if sys.stdout.isatty():
        return "\033]8;;%s\033\\%s\033]8;;\033\\" % (url, label)
    return "%s\n%s" % (label, url)


def main():
    store = ConfigStore()
    manager = NodeManager(store)
    tunnel = manager.endpoint_mapper
    try:
        _, upstream = manager.endpoints()
        proxy = GrafanaProxy(upstream, port=int(os.environ.get("FIDDY_CONSOLE_PORT", "43117")))
    except (NodeError, OSError, ValueError) as error:
        print("Fiddy could not open Grafana: %s" % error, file=sys.stderr)
        return 1
    print("\033[38;5;154mFIDDY / LIVE GRAFANA\033[0m")
    print("Real Snapchain metrics. Loopback only. No AI or API key needed.")
    print("")
    print(hyperlink(proxy.url, "[ Open live Grafana ]"))
    print("")
    print("EMBED IT HERE: Grafana opens beside this pane automatically.")
    print("If it does not, Shift-click [ Open live Grafana ].")
    print("Grafana's first login is admin / admin; change that password in Grafana.")
    print("Keep this pane open: closing it closes the dashboard tunnel.")
    print("")
    # Publish the tokened URL for the Ovis auto-embed hook. The file is 0600
    # because the URL carries the hand-off token; it is loopback-only anyway.
    fd = os.open(store.runtime_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump({"grafana_url": proxy.url}, handle)
    try:
        proxy.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        proxy.server_close()
        try:
            store.runtime_path.unlink()
        except OSError:
            pass
        if hasattr(tunnel, "close"):
            tunnel.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
