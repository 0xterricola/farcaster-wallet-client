import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class DirectScriptTests(unittest.TestCase):
    def test_bootstrap_runs_without_pythonpath_or_package_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = os.environ.copy()
            env.pop("PYTHONPATH", None)
            env["FIDDY_CONSOLE_HOME"] = tmp
            env["FIDDY_CONFIG"] = str(pathlib.Path(tmp) / "missing")
            result = subprocess.run(
                [sys.executable, str(ROOT / "console" / "bootstrap.py")],
                env=env, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Fiddy console: local", result.stdout)


if __name__ == "__main__":
    unittest.main()
