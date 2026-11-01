import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from console.config import ConfigStore


class ConfigStoreTests(unittest.TestCase):
    def test_settings_round_trip_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = ConfigStore(Path(tmp))
            store.save_settings({
                "target": "ubuntu@203.0.113.10",
                "ssh_proxyjump": "root@198.51.100.10",
                "node_url": "http://127.0.0.1:3381",
                "grafana_url": "http://127.0.0.1:3000",
                "network": "snapchain",
                "auto_upgrade": "off",
                "operator_fid": 191557,
            })
            loaded = store.load_settings()
            self.assertEqual(loaded["target"], "ubuntu@203.0.113.10")
            self.assertEqual(loaded["ssh_proxyjump"], "root@198.51.100.10")
            self.assertEqual(loaded["operator_fid"], 191557)
            self.assertEqual(stat.S_IMODE((Path(tmp) / "config.json").stat().st_mode), 0o600)

    def test_herdr_config_dir_is_the_default_private_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {"HERDR_PLUGIN_CONFIG_DIR": tmp}):
                self.assertEqual(ConfigStore.default_root(), Path(tmp))

    def test_public_settings_hide_the_private_key_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = ConfigStore(Path(tmp))
            store.update_settings({"ssh_key": "/private/node.pem"})
            public = store.public_settings()
            self.assertTrue(public["has_ssh_key"])
            self.assertNotIn("ssh_key", public)
            self.assertNotIn(str(Path(tmp)), str(public))


if __name__ == "__main__":
    unittest.main()
