import json
import os
import subprocess


TITLES = {
    "console": "Fiddy Console", "status": "Node Status", "logs": "Node Logs", "start": "Start Node", "stop": "Stop Node",
    "grafana": "Grafana", "fid-setup": "Operator FID", "settings": "Node Settings",
    "auto-upgrade": "Auto-upgrade",
}

ACTIONS = {
    "console": "console",
    "status": "console",
    "logs": "console",
    "start": "console",
    "stop": "console",
    "grafana": "grafana",
    "fid-setup": "console",
    "settings": "console",
    "auto-upgrade": "console",
}


def open_pane(action, herdr_bin=None, plugin_id="fun.fiddy.console"):
    if action not in ACTIONS:
        raise ValueError("Unknown Fiddy console action: %s" % action)
    binary = herdr_bin or os.environ.get("HERDR_BIN_PATH", "herdr")
    entrypoint = ACTIONS[action]
    if os.name == "nt":
        entrypoint += "-windows"
    argv = [
        binary, "plugin", "pane", "open", "--plugin", plugin_id,
        "--entrypoint", entrypoint, "--focus",
    ]
    if entrypoint == "console":
        argv.extend(["--env", "FIDDY_CONSOLE_ACTION=" + action])
    result = subprocess.run(argv, check=False)
    if result.returncode == 0:
        name_focused_tab(binary, TITLES[action])
    return result.returncode


def name_focused_tab(binary, title):
    """Tabs default to bare numbers; name the one we just opened (--focus)."""
    try:
        out = subprocess.run([binary, "pane", "list"], capture_output=True, text=True, timeout=10).stdout
        panes = json.loads(out)["result"]["panes"]
        focused = [pane for pane in panes if pane.get("focused")]
        if focused:
            subprocess.run([binary, "tab", "rename", focused[0]["tab_id"], title],
                           capture_output=True, timeout=10)
    except Exception:
        pass  # naming is cosmetic; never fail the action over it


def main(argv=None):
    import sys
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1 or args[0] not in ACTIONS:
        print("Choose a Fiddy console button.", file=sys.stderr)
        return 2
    return open_pane(args[0])


if __name__ == "__main__":
    raise SystemExit(main())
