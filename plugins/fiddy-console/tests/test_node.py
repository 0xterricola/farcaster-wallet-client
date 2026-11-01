import json
import tempfile
import unittest
from pathlib import Path

from console.config import ConfigStore
from console.node import NodeManager


class FakeExecutor:
    def __init__(self):
        self.scripts = []
        self.docker_running = True

    def run(self, script, timeout=20):
        self.scripts.append(script)
        if "docker ps --filter" in script:
            return 0, "Up 12 minutes\n" if self.docker_running else "", ""
        if "docker logs" in script:
            return 0, "downloading chunk_0012.bin\ndownloading chunk_0042.bin\n", ""
        if "docker compose up -d" in script:
            self.docker_running = True
            return 0, "started\n", ""
        if "snapchain.sh down" in script:
            self.docker_running = False
            return 0, "stopped\n", ""
        if "HUB_OPERATOR_FID" in script or "crontab" in script:
            return 0, "ok\n", ""
        return 1, "", "unknown fake command"


class NodeManagerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ConfigStore(Path(self.tmp.name))
        self.executor = FakeExecutor()
        self.info = {
            "version": {"string": "0.11.0"},
            "shardInfos": [
                {"shardId": 1, "maxHeight": 12345, "blockDelay": 4},
                {"shardId": 2, "maxHeight": 12340, "blockDelay": 8},
            ],
        }
        self.manager = NodeManager(
            self.store,
            executor=self.executor,
            fetch_json=lambda url: self.info,
            endpoint_mapper=lambda settings: (settings["node_url"], settings["grafana_url"]),
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_live_status_has_real_shard_progress_and_bootstrap_progress(self):
        status = self.manager.status()
        self.assertTrue(status["live"])
        self.assertEqual(status["container"], "Up 12 minutes")
        self.assertEqual(status["snapshot"]["chunk"], 42)
        self.assertEqual(status["snapshot"]["total"], 5690)
        self.assertEqual(status["shards"][0]["max_height"], 12345)
        self.assertEqual(status["shards"][1]["block_delay_seconds"], 8)
        self.assertEqual(status["network"], "snapchain")

    def test_bootstrap_is_not_reported_as_a_dead_node(self):
        self.manager.fetch_json = lambda url: (_ for _ in ()).throw(OSError("not listening"))
        status = self.manager.status()
        self.assertFalse(status["live"])
        self.assertEqual(status["phase"], "bootstrap")
        self.assertEqual(status["snapshot"]["chunk"], 42)
        self.assertIn("HTTP API is not answering", status["notice"])

    def test_start_and_stop_use_the_existing_snapchain_install(self):
        self.assertIn("started", self.manager.start()["message"])
        self.assertIn("stopped", self.manager.stop()["message"])
        scripts = "\n".join(self.executor.scripts)
        self.assertIn("docker compose up -d snapchain statsd grafana", scripts)
        self.assertIn("./snapchain.sh down", scripts)

    def test_fid_and_upgrade_settings_are_guided_writes(self):
        self.assertEqual(self.manager.set_operator_fid(191557)["operator_fid"], 191557)
        self.assertEqual(self.manager.set_auto_upgrade("daily")["auto_upgrade"], "daily")
        scripts = "\n".join(self.executor.scripts)
        self.assertIn("HUB_OPERATOR_FID=191557", scripts)
        self.assertIn("0 3 * * *", scripts)
        self.assertIn("SKIP_CRONTAB=false", scripts)
        with self.assertRaises(ValueError):
            self.manager.set_operator_fid(0)
        with self.assertRaises(ValueError):
            self.manager.set_auto_upgrade("every-minute")


if __name__ == "__main__":
    unittest.main()
