import pathlib
import unittest


class InstallerTests(unittest.TestCase):
    def test_installer_detects_ssh_and_does_not_force_a_node_onto_a_laptop(self):
        script = (pathlib.Path(__file__).resolve().parents[3] / "scripts" / "install.sh").read_text()
        self.assertIn("SSH_CONNECTION", script)
        self.assertIn("Way 1", script)
        self.assertIn("Way 2", script)
        self.assertIn("herdr.dev/install.sh", script)
        self.assertIn("ovis.sh/install.sh", script)
        self.assertIn("plugins/fiddy-console", script)
        self.assertIn("FIDDY_INSTALL_NODE", script)
        self.assertNotIn("/api/keys/" + "create", script)


if __name__ == "__main__":
    unittest.main()
