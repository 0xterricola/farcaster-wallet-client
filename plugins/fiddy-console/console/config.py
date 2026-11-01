import json
import os
import tempfile
from pathlib import Path


DEFAULT_SETTINGS = {
    "target": "local",
    "ssh_key": "",
    "ssh_proxyjump": "",
    "node_url": "http://127.0.0.1:3381",
    "grafana_url": "http://127.0.0.1:3000",
    "network": "snapchain",
    "auto_upgrade": "off",
    "operator_fid": 0,
}


class ConfigStore:
    def __init__(self, root=None):
        self.root = Path(root) if root is not None else self.default_root()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.root.chmod(0o700)
        except OSError:
            pass
        self.config_path = self.root / "config.json"
        self.runtime_path = self.root / "runtime.json"

    @staticmethod
    def default_root():
        override = os.environ.get("FIDDY_CONSOLE_HOME") or os.environ.get("HERDR_PLUGIN_CONFIG_DIR")
        if override:
            return Path(override).expanduser()
        if os.name == "nt" and os.environ.get("APPDATA"):
            return Path(os.environ["APPDATA"]) / "FiddyConsole"
        config_home = os.environ.get("XDG_CONFIG_HOME")
        return (Path(config_home) if config_home else Path.home() / ".config") / "fiddy-console"

    def _atomic_write(self, path, data):
        fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=str(self.root))
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            path.chmod(0o600)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def load_settings(self):
        try:
            saved = json.loads(self.config_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            saved = {}
        settings = dict(DEFAULT_SETTINGS)
        if isinstance(saved, dict):
            for name in DEFAULT_SETTINGS:
                if name in saved:
                    settings[name] = saved[name]
        return settings

    def save_settings(self, settings):
        clean = {name: settings[name] for name in DEFAULT_SETTINGS if name in settings}
        self._atomic_write(self.config_path, json.dumps(clean, indent=2, sort_keys=True) + "\n")

    def update_settings(self, changes):
        settings = self.load_settings()
        settings.update(changes)
        self.save_settings(settings)
        return settings

    def public_settings(self):
        settings = self.load_settings()
        has_ssh_key = bool(settings.pop("ssh_key", ""))
        settings["has_ssh_key"] = has_ssh_key
        return settings
