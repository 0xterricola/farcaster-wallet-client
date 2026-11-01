import json
import os
import re
import shlex
import socket
import subprocess
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone


TARGET_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+$")
CHUNK_PATTERN = re.compile(r"chunk_(\d+)\.bin")
# Current upstream mainnet snapshot layout; progress is a hint, not a sync proof.
SNAPSHOT_CHUNK_COUNT = 5690


class NodeError(Exception):
    pass


class CommandExecutor:
    def __init__(self, store):
        self.store = store

    def run(self, script, timeout=20):
        settings = self.store.load_settings()
        target = settings.get("target", "local")
        if target == "local":
            if os.name == "nt":
                raise NodeError("A local Windows node is not supported. Choose your server over SSH in Settings.")
            command = ["bash", "-s"]
        else:
            if not isinstance(target, str) or not TARGET_PATTERN.fullmatch(target):
                raise NodeError("Use an SSH target like ubuntu@203.0.113.10.")
            command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                       "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes"]
            if settings.get("ssh_proxyjump"):
                jump = settings["ssh_proxyjump"]
                if not TARGET_PATTERN.fullmatch(jump):
                    raise NodeError("Use an SSH jump host like root@203.0.113.10.")
                command.extend(["-J", jump])
            if settings.get("ssh_key"):
                command.extend(["-i", settings["ssh_key"]])
            command.extend([target, "bash -s"])
        try:
            result = subprocess.run(command, input=script, text=True, capture_output=True, timeout=timeout)
        except FileNotFoundError:
            raise NodeError("SSH is not installed." if target != "local" else "A Unix shell is required for local node controls.") from None
        except subprocess.TimeoutExpired:
            raise NodeError("The node did not answer in time. Check SSH and try again.") from None
        return result.returncode, result.stdout, result.stderr


class TunnelManager:
    """Maps a remote node's loopback API and Grafana onto local ephemeral ports."""

    def __init__(self):
        self.signature = None
        self.process = None
        self.endpoints = None

    def _free_port(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def close(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.signature = None
        self.process = None
        self.endpoints = None

    def __call__(self, settings):
        if settings.get("target", "local") == "local":
            return settings["node_url"], settings["grafana_url"]
        signature = (settings.get("target"), settings.get("ssh_key"), settings.get("ssh_proxyjump"), settings.get("node_url"), settings.get("grafana_url"))
        if signature == self.signature and self.process is not None and self.process.poll() is None:
            return self.endpoints
        self.close()
        target = settings.get("target", "")
        if not TARGET_PATTERN.fullmatch(target):
            raise NodeError("Use an SSH target like ubuntu@203.0.113.10.")
        node_port = urllib.parse.urlparse(settings["node_url"]).port or 3381
        grafana_port = urllib.parse.urlparse(settings["grafana_url"]).port or 3000
        local_node = self._free_port()
        local_grafana = self._free_port()
        command = ["ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                   "-o", "StrictHostKeyChecking=accept-new", "-o", "ExitOnForwardFailure=yes",
                   "-L", "127.0.0.1:%d:127.0.0.1:%d" % (local_node, node_port),
                   "-L", "127.0.0.1:%d:127.0.0.1:%d" % (local_grafana, grafana_port)]
        if settings.get("ssh_proxyjump"):
            jump = settings["ssh_proxyjump"]
            if not TARGET_PATTERN.fullmatch(jump):
                raise NodeError("Use an SSH jump host like root@203.0.113.10.")
            command.extend(["-J", jump])
        if settings.get("ssh_key"):
            command.extend(["-i", settings["ssh_key"]])
        command.append(target)
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            raise NodeError("SSH is required to reach a remote node's loopback dashboard.") from None
        # Do not race the browser: wait until both local forwards actually
        # accept TCP. The old fixed 0.4s sleep let the first page load hit a
        # not-yet-bound port and surface as a 502.
        deadline = time.time() + 15
        while time.time() < deadline:
            if self.process.poll() is not None:
                self.close()
                raise NodeError("Could not open the SSH tunnels. Check the target and key in Settings.")
            ready = 0
            for port in (local_node, local_grafana):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=1):
                        ready += 1
                except OSError:
                    pass
            if ready == 2:
                break
            time.sleep(0.25)
        else:
            self.close()
            raise NodeError("The SSH tunnels did not come up in time. Check the target and key in Settings.")
        self.signature = signature
        self.endpoints = ("http://127.0.0.1:%d" % local_node, "http://127.0.0.1:%d" % local_grafana)
        return self.endpoints


def default_fetch_json(url):
    with urllib.request.urlopen(url, timeout=4) as response:
        return json.loads(response.read().decode("utf-8"))


class NodeManager:
    def __init__(self, store, executor=None, fetch_json=None, endpoint_mapper=None):
        self.store = store
        self.executor = executor or CommandExecutor(store)
        self.fetch_json = fetch_json or default_fetch_json
        self.endpoint_mapper = endpoint_mapper or TunnelManager()

    def endpoints(self):
        return self.endpoint_mapper(self.store.load_settings())

    def grafana_upstream(self):
        return self.endpoints()[1]

    def _docker_status(self):
        code, output, _ = self.executor.run("docker ps --filter name=snapchain-snapchain-1 --format '{{.Status}}'", timeout=12)
        return output.strip() if code == 0 else ""

    def _docker_started(self):
        code, output, _ = self.executor.run("docker inspect --format '{{.State.StartedAt}} {{.RestartCount}}' snapchain-snapchain-1", timeout=12)
        if code != 0 or not output.strip():
            return None
        return output.split()

    @staticmethod
    def _humanize_uptime(started_iso):
        try:
            cleaned = re.sub(r"(\.\d{6})\d+", r"\1", started_iso.replace("Z", "+00:00"))
            started = datetime.fromisoformat(cleaned)
        except ValueError:
            return None
        minutes = int((datetime.now(timezone.utc) - started).total_seconds() // 60)
        if minutes < 0:
            return None
        if minutes < 60:
            return "%dm" % minutes
        if minutes < 60 * 48:
            return "%dh %dm" % (minutes // 60, minutes % 60)
        return "%dd %dh" % (minutes // 1440, (minutes % 1440) // 60)

    def _network_tips(self):
        # The network tip is not in the HTTP API; the sync log lines carry it.
        code, output, _ = self.executor.run("docker logs --tail 4000 snapchain-snapchain-1 2>&1 | grep height.tip | tail -60", timeout=15)
        tips = {}
        if code != 0:
            return tips
        plain = re.sub(r"\x1b\[[0-9;]*m", "", output)
        for match in re.finditer(r"height\.tip=\[(\d+)\]\s+(\d+)", plain):
            shard, height = int(match.group(1)), int(match.group(2))
            tips[shard] = max(tips.get(shard, 0), height)
        return tips

    def _bootstrap(self):
        code, output, _ = self.executor.run("docker logs --tail 2500 snapchain-snapchain-1 2>&1", timeout=15)
        chunks = CHUNK_PATTERN.findall(output) if code == 0 else []
        if not chunks:
            return None
        chunk = int(chunks[-1])
        total = SNAPSHOT_CHUNK_COUNT
        return {"chunk": chunk, "total": total, "percent": round(min(100, chunk * 100 / total), 1)}

    def status(self):
        settings = self.store.load_settings()
        result = {
            "live": False,
            "phase": "unavailable",
            "network": settings.get("network", "snapchain"),
            "container": self._docker_status(),
            "snapshot": self._bootstrap(),
            "shards": [],
        }
        try:
            node_url, _ = self.endpoints()
            info = self.fetch_json(node_url.rstrip("/") + "/v1/info")
        except (OSError, ValueError, json.JSONDecodeError, NodeError):
            info = None
        if info is None:
            result["phase"] = "bootstrap" if result["container"] else "unavailable"
            result["notice"] = ("The node's HTTP API is not answering yet. Snapshot progress is still live; "
                                "a fresh node starts its API after the historical data loads.")
            return result
        result["live"] = True
        result["phase"] = "syncing"
        version = info.get("version", {})
        result["version"] = version.get("string") if isinstance(version, dict) else str(version)
        started = self._docker_started()
        if started:
            uptime = self._humanize_uptime(started[0])
            if uptime:
                result["uptime"] = "%s (restarts: %s)" % (uptime, started[1] if len(started) > 1 else "0")
        shards = info.get("shardInfos") or info.get("shardInfo") or []
        if isinstance(shards, dict):
            shards = list(shards.values())
        tips = self._network_tips()
        for shard in shards if isinstance(shards, list) else []:
            if not isinstance(shard, dict):
                continue
            height = shard.get("maxHeight", shard.get("max_height", 0))
            entry = {
                "id": shard.get("shardId", shard.get("shard_id", "?")),
                "max_height": height,
                "block_delay_seconds": shard.get("blockDelay", shard.get("block_delay", 0)),
            }
            tip = tips.get(int(entry["id"])) if isinstance(entry["id"], int) else None
            entry["sync_percent"] = round(min(100, height * 100 / tip), 1) if tip and height else None
            entry["lag_blocks"] = (tip - height) if tip and height and tip >= height else None
            result["shards"].append(entry)
        return result

    def logs(self):
        code, output, error = self.executor.run("docker logs --tail 250 snapchain-snapchain-1 2>&1", timeout=15)
        if code != 0:
            raise NodeError("Could not read the node logs. Is Snapchain installed and Docker running?")
        return {"logs": output[-60000:] or error[-4000:]}

    def _apply(self, script, failure):
        code, output, error = self.executor.run(script, timeout=45)
        if code != 0:
            detail = (error or output).strip().splitlines()
            suffix = " " + detail[-1][:240] if detail else ""
            raise NodeError(failure + suffix)
        return output

    def start(self):
        self._apply('cd "$HOME/snapchain" && docker compose up -d snapchain statsd grafana',
                    "Could not start the node.")
        return {"message": "Node containers started."}

    def stop(self):
        self._apply('cd "$HOME/snapchain" && ./snapchain.sh down', "Could not stop the node.")
        return {"message": "Node containers stopped."}

    def set_operator_fid(self, fid):
        if isinstance(fid, bool) or not isinstance(fid, int) or fid <= 0 or fid > 9223372036854775807:
            raise ValueError("Enter a positive Farcaster account number.")
        script = '''set -e
cd "$HOME/snapchain"
test -f .env
umask 077
tmp=$(mktemp)
grep -v '^HUB_OPERATOR_FID=' .env > "$tmp" || true
printf 'HUB_OPERATOR_FID=%s\n' >> "$tmp"
cat "$tmp" > .env
rm -f "$tmp"
chmod 600 .env
''' % fid
        self._apply(script, "Could not save the operator FID.")
        self.store.update_settings({"operator_fid": fid})
        return {"operator_fid": fid, "message": "Operator FID saved. Restart the node when you are ready to apply it."}

    def set_auto_upgrade(self, schedule):
        cron = {"off": "", "weekly": "0 3 * * 2", "daily": "0 3 * * *", "hourly": "0 * * * *"}.get(schedule)
        if cron is None:
            raise ValueError("Choose off, weekly, daily, or hourly.")
        enabled = "false" if schedule == "off" else "true"
        skip = "true" if schedule == "off" else "false"
        schedule_line = ""
        if enabled == "true":
            schedule_line = "printf '%s\\n' " + shlex.quote(cron + " $HOME/snapchain/snapchain.sh autoupgrade >> $HOME/snapchain/snapchain-autoupgrade.log 2>&1") + " >> \"$cron_tmp\""
        else:
            schedule_line = ":"
        script = '''set -e
cd "$HOME/snapchain"
test -f .env
umask 077
tmp=$(mktemp)
grep -v '^SKIP_CRONTAB=' .env > "$tmp" || true
printf 'SKIP_CRONTAB=%s\n' >> "$tmp"
cat "$tmp" > .env
rm -f "$tmp"
cron_tmp=$(mktemp)
(crontab -l 2>/dev/null || true) | grep -v 'snapchain.sh autoupgrade' > "$cron_tmp" || true
%s
crontab "$cron_tmp"
rm -f "$cron_tmp"
''' % (skip, schedule_line)
        self._apply(script, "Could not save the upgrade schedule.")
        self.store.update_settings({"auto_upgrade": schedule})
        return {"auto_upgrade": schedule, "message": "Automatic upgrades are %s." % (schedule if schedule != "off" else "off")}
