import pathlib
import unittest

try:
    import tomllib
except ImportError:
    tomllib = None


ROOT = pathlib.Path(__file__).resolve().parents[1]


class ManifestTests(unittest.TestCase):
    @unittest.skipIf(tomllib is None, "Python 3.11+ parses the manifest in this unit test; Herdr validates it on older runtimes")
    def test_console_buttons_and_panes_are_native_herdr_plugin_entries(self):
        manifest = tomllib.loads((ROOT / "herdr-plugin.toml").read_text())
        self.assertEqual(manifest["id"], "fun.fiddy.console")
        self.assertGreaterEqual(manifest["min_herdr_version"], "0.9.0")
        actions = {entry["id"]: entry for entry in manifest["actions"]}
        expected = {"open-console", "status", "sync", "logs", "start", "stop", "grafana", "fid-setup", "settings", "auto-upgrade"}
        self.assertTrue(expected.issubset(actions))
        for action_id in expected:
            self.assertIn("title", actions[action_id])
            self.assertTrue(actions[action_id]["command"])
        panes = {entry["id"]: entry for entry in manifest["panes"]}
        self.assertTrue({"console", "grafana"}.issubset(panes))
        self.assertEqual(panes["grafana"]["placement"], "tab")
        self.assertFalse(any("surp" in str(entry).lower() for entry in manifest["actions"]))

    def test_no_secret_or_key_material_is_shipped(self):
        for path in ROOT.rglob("*"):
            if path.is_file() and ".git" not in path.parts and "__pycache__" not in path.parts:
                body = path.read_text(errors="ignore")
                self.assertNotIn("sk-" + "surp-", body, str(path))
                self.assertNotIn("/api/keys/" + "create", body, str(path))


if __name__ == "__main__":
    unittest.main()
