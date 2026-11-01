import tempfile
import unittest
from pathlib import Path

from console.bootstrap import bootstrap
from console.config import ConfigStore


class BootstrapTests(unittest.TestCase):
    def test_existing_fiddy_target_and_explicit_bastion_become_console_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli = root / "cli-config"
            cli.write_text("FIDDY_TARGET=ubuntu@203.0.113.10\nFIDDY_NODE_NETWORK=snapchain\n")
            store = ConfigStore(root / "console")
            result = bootstrap(store, {
                "FIDDY_CONFIG": str(cli),
                "FIDDY_CONSOLE_PROXYJUMP": "root@198.51.100.10",
                "FIDDY_CONSOLE_SSH_KEY": str(root / "node.pem"),
            })
            self.assertEqual(result["target"], "ubuntu@203.0.113.10")
            self.assertEqual(result["network"], "snapchain")
            self.assertEqual(store.load_settings()["ssh_proxyjump"], "root@198.51.100.10")
            self.assertTrue(result["has_ssh_key"])

    def test_cli_loopback_target_means_local_not_ssh_to_self(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli = root / "cli-config"
            cli.write_text("FIDDY_TARGET=ubuntu@127.0.0.1\n")
            store = ConfigStore(root / "console")
            result = bootstrap(store, {"FIDDY_CONFIG": str(cli)})
            self.assertEqual(result["target"], "local")


if __name__ == "__main__":
    unittest.main()
