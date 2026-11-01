#!/usr/bin/env python3
"""Sweep upstream Hypersnap and print whether the install refusal still holds.

`fiddy node up --network hypersnap` refuses to install a node, because the
published install does not produce one that follows the chain (see
docs/NETWORK-CHOICE.md §3). That refusal is only honest while the measurement
behind it is true, so this script re-measures it in one command.

What it checks, and why each source is the right one:

  * the on-chain registry, `SnapchainConfigRegistry` on Ethereum L1
    (`0x00000000fc51aD6eb74EAE89ba4b01b1776fBA85`, the address baked into
    farcasterxyz/snapchain's `cli/src/config_pull.rs`). `configVersion()` is the
    mutation counter and `configToml()` the rendered config document the node
    pulls. This is the authority the network's validators publish, so a
    published file is only current if its validator sets match this one.
  * `validators.toml` on `farcasterorg/hypersnap` main and the `@latest` tag
    (the tag the default "stable" channel installs from), plus whether the
    stable channel's compose carries an inline set instead.
  * `validators.toml` on `farcasterxyz/snapchain`, the repair operators
    confirmed in farcasterorg/hypersnap#41.
  * the public read node's `/v1/info`: per-shard heights and `blockDelay`. In
    Snapchain `blockDelay` is *seconds since that shard's last block*
    (`src/storage/store/engine.rs`: `block_delay_seconds = now - block.timestamp`),
    so a shard whose height does not move while its `blockDelay` climbs in step
    with the wall clock has stopped following the chain.
  * the state of farcasterorg/hypersnap#41.

Exit status is the automation contract:

  0  the premise holds: the published install is still behind the registry
     (or the registry itself could not be read, so nothing may be lifted)
  1  possibly fixed: a published file now matches the registry, so it is time to
     install one on real hardware and prove it follows the chain before the CLI
     stops refusing
  2  could not measure: upstream sources unreachable, so do not act on this run

Usage:
  scripts/sweep-hypersnap-upstream.py                 # human summary
  scripts/sweep-hypersnap-upstream.py --json          # same facts as JSON
  scripts/sweep-hypersnap-upstream.py --rpc <url> --node <url>

Stdlib only, no dependencies, safe to run anywhere with network access.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

# --- the selectors are keccak256 of the signatures, computed once ---
# keccak256("configVersion()")[:4] = 0xdd64d24d, keccak256("configToml()")[:4] = 0x5a62bd75
REGISTRY_ADDRESS = "0x00000000fc51aD6eb74EAE89ba4b01b1776fBA85"
SEL_CONFIG_VERSION = "0xdd64d24d"
SEL_CONFIG_TOML = "0x5a62bd75"

DEFAULT_L1_RPC = "https://ethereum-rpc.publicnode.com"
DEFAULT_NODE = "https://haatz.quilibrium.com"
ISSUE = "farcasterorg/hypersnap#41"
ISSUE_API = "https://api.github.com/repos/farcasterorg/hypersnap/issues/41"

HYPERSNAP_REPO = "farcasterorg/hypersnap"
SNAPCHAIN_REPO = "farcasterxyz/snapchain"
RAW = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"

EFFECTIVE_AT = re.compile(r"effective_at\s*=\s*([0-9_]+)")
SHARD_IDS = re.compile(r"shard_ids\s*=\s*\[([^\]]*)\]")


def fetch(url, timeout=25, accept="application/json"):
    """GET a URL. Returns (status, text). Never raises for HTTP status."""
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "fiddy-sweep"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")
    except Exception as error:  # DNS, TLS, timeouts
        return None, "{}: {}".format(type(error).__name__, error)


def rpc_call(rpc, data, timeout=30):
    """One eth_call. Returns hex result string, or None when it did not answer."""
    payload = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_call",
            "params": [{"to": REGISTRY_ADDRESS, "data": data}, "latest"],
        }
    ).encode()
    req = urllib.request.Request(
        rpc, data=payload, headers={"Content-Type": "application/json", "User-Agent": "fiddy-sweep"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8", "replace"))
    except Exception as error:
        return None, "{}: {}".format(type(error).__name__, error)
    if "error" in body:
        return None, str(body["error"])[:200]
    return body.get("result"), None


def abi_decode_string(result):
    """Decode an ABI-encoded `string` return value (offset, length, bytes)."""
    if not result or not result.startswith("0x") or len(result) <= 2:
        return None
    raw = bytes.fromhex(result[2:])
    if len(raw) < 64:
        return None
    offset = int.from_bytes(raw[0:32], "big")
    length = int.from_bytes(raw[offset : offset + 32], "big")
    return raw[offset + 32 : offset + 32 + length].decode("utf-8", "replace")


def validator_sets(document):
    """The (effective_at, shards, key count) triples in a config/validators document.

    Both the registry document and the repo files mention the table name inside
    their comment headers, so a piece with neither an `effective_at` nor any key
    is the text between a comment and the first real entry, not a set.
    """
    if not document:
        return []
    blocks = document.split("[[consensus.validator_sets]]")[1:]
    sets = []
    for block in blocks:
        effective = EFFECTIVE_AT.search(block)
        shards = SHARD_IDS.search(block)
        keys = re.findall(r'"[0-9a-f]{64}"', block)
        if effective is None and not keys:
            continue
        sets.append(
            {
                "effective_at": int(effective.group(1).replace("_", "")) if effective else None,
                "shards": shards.group(1).replace(" ", "") if shards else None,
                "keys": len(keys),
            }
        )
    return sets


def missing_from(published, authority):
    """The authority's entries the published file does not carry."""
    return [entry for entry in authority if entry not in published]


def fmt(value):
    """A block height the way the TOML files write it: 39_798_000."""
    if value is None:
        return "none"
    return "{:,}".format(value).replace(",", "_")


def newest(sets, shard=None):
    """The highest effective_at, optionally restricted to one shard id."""
    if shard is None:
        chosen = sets
    else:
        chosen = []
        for entry in sets:
            ids = (entry["shards"] or "").split(",")
            if str(shard) in ids:
                chosen.append(entry)
    heights = [entry["effective_at"] for entry in chosen if entry["effective_at"] is not None]
    return max(heights) if heights else None


def shard_heights(node):
    """(heights, delays, version, error) from a node's /v1/info."""
    status, text = fetch(node.rstrip("/") + "/v1/info", accept="application/json")
    if status != 200:
        return {}, {}, None, "HTTP {}: {}".format(status, text[:120])
    try:
        info = json.loads(text)
    except ValueError:
        return {}, {}, None, "not JSON: " + text[:120]
    heights, delays = {}, {}
    for shard in info.get("shardInfos") or []:
        heights[shard.get("shardId")] = shard.get("maxHeight")
        delays[shard.get("shardId")] = shard.get("blockDelay")
    return heights, delays, info.get("version"), None


def repo_file(repo, ref, path):
    status, text = fetch(RAW.format(repo=repo, ref=ref, path=path), accept="text/plain")
    return (text if status == 200 else None), status


def main():
    parser = argparse.ArgumentParser(description="Re-check whether a Hypersnap install is reproducible yet.")
    parser.add_argument("--rpc", default=os.environ.get("ETH_RPC_URL", DEFAULT_L1_RPC))
    parser.add_argument("--node", default=DEFAULT_NODE)
    parser.add_argument("--json", action="store_true", help="print the facts as JSON")
    args = parser.parse_args()

    facts = {"registry": {}, "hypersnap": {}, "snapchain": {}, "node": {}, "issue": {}}
    notes = []
    registry_sets = []

    # 1. the authority: the on-chain registry
    version_hex, version_error = rpc_call(args.rpc, SEL_CONFIG_VERSION)
    if version_error or not version_hex or version_hex == "0x":
        facts["registry"]["reachable"] = False
        facts["registry"]["error"] = version_error or "empty result"
        notes.append("the registry did not answer on {}; nothing may be lifted from this run".format(args.rpc))
    else:
        facts["registry"]["reachable"] = True
        facts["registry"]["config_version"] = int(version_hex, 16)
        toml_hex, toml_error = rpc_call(args.rpc, SEL_CONFIG_TOML)
        document = abi_decode_string(toml_hex) if not toml_error else None
        registry_sets = validator_sets(document)
        facts["registry"]["validator_sets"] = len(registry_sets)
        facts["registry"]["newest"] = newest(registry_sets)
        facts["registry"]["newest_per_shard"] = {str(s): newest(registry_sets, s) for s in (0, 1, 2)}
        if not registry_sets:
            notes.append("the registry answered but its config document could not be read")

    # 2. upstream Hypersnap: main and the @latest tag the stable channel installs from
    main_toml, main_status = repo_file(HYPERSNAP_REPO, "refs/heads/main", "validators.toml")
    latest_toml, latest_status = repo_file(HYPERSNAP_REPO, "refs/tags/%40latest", "validators.toml")
    latest_compose, compose_status = repo_file(
        HYPERSNAP_REPO, "refs/tags/%40latest", "docker-compose.mainnet.yml"
    )
    latest_installer, installer_status = repo_file(
        HYPERSNAP_REPO, "refs/tags/%40latest", "scripts/hypersnap.sh"
    )
    main_sets = validator_sets(main_toml)
    facts["hypersnap"] = {
        "main_validators_toml": {
            "http": main_status,
            "sets": len(main_sets),
            "newest": newest(main_sets),
            "missing_vs_registry": len(missing_from(main_sets, registry_sets)),
        },
        "latest_tag": {
            "validators_toml_http": latest_status,
            "installer_http": installer_status,
            "installer_mentions_validators": "validator" in (latest_installer or "").lower(),
            "compose_http": compose_status,
            "compose_sets": len(validator_sets(latest_compose)),
            "compose_newest": newest(validator_sets(latest_compose)),
        },
    }

    # 3. the repair source operators confirmed
    snap_toml, snap_status = repo_file(SNAPCHAIN_REPO, "refs/heads/main", "validators.toml")
    snap_sets = validator_sets(snap_toml)
    facts["snapchain"] = {
        "validators_toml": {
            "http": snap_status,
            "sets": len(snap_sets),
            "newest": newest(snap_sets),
            "matches_registry": snap_sets == registry_sets,
        }
    }

    # 4. the public read node: heights now, and again a few seconds later
    heights_a, delays_a, version, node_error = shard_heights(args.node)
    facts["node"] = {
        "url": args.node,
        "version": version,
        "heights": heights_a,
        "block_delay_seconds": delays_a,
        "error": node_error,
    }
    if not node_error:
        time.sleep(20)
        heights_b, delays_b, _, _ = shard_heights(args.node)
        stuck = {}
        for shard, height in heights_a.items():
            moved = heights_b.get(shard) != height
            delay_a, delay_b = delays_a.get(shard), delays_b.get(shard)
            climbing = (
                isinstance(delay_a, int)
                and isinstance(delay_b, int)
                and delay_b - delay_a >= 15
                and isinstance(height, int)
                and height == heights_b.get(shard)
            )
            if climbing or not moved:
                stuck[str(shard)] = {
                    "height": height,
                    "moved": moved,
                    "block_delay_seconds": delay_a,
                }
        facts["node"]["not_advancing"] = stuck
        facts["node"]["heights_after_20s"] = heights_b

    # 5. the issue this card watches
    issue_status, issue_text = fetch(ISSUE_API)
    if issue_status == 200:
        try:
            issue = json.loads(issue_text)
        except ValueError:
            issue = {}
        facts["issue"] = {
            "http": issue_status,
            "state": issue.get("state"),
            "comments": issue.get("comments"),
            "updated_at": issue.get("updated_at"),
            "title": issue.get("title"),
        }
    else:
        facts["issue"] = {"http": issue_status}

    # --- the verdict ----------------------------------------------------------
    registry_reachable = facts["registry"].get("reachable") is True
    registry_newest = facts["registry"].get("newest")
    hypersnap_sets = validator_sets(main_toml)
    hypersnap_missing = missing_from(hypersnap_sets, registry_sets)
    hypersnap_newest = facts["hypersnap"]["main_validators_toml"]["newest"]
    snapchain_newest = facts["snapchain"]["validators_toml"]["newest"]

    if not registry_reachable:
        verdict = "unmeasured"
        reason = "the on-chain registry could not be read, so no published file can be called current"
    elif hypersnap_newest is None:
        verdict = "still-broken"
        reason = "upstream's main validators.toml is missing or unreadable (HTTP {})".format(
            facts["hypersnap"]["main_validators_toml"]["http"]
        )
    elif not hypersnap_missing and registry_sets:
        verdict = "possibly-fixed"
        reason = "upstream main's {} validator sets match the registry's, entry for entry".format(
            len(hypersnap_sets)
        )
    else:
        verdict = "still-broken"
        reason = (
            "upstream main carries {} validator sets and is missing {} of the registry's {} "
            "(newest it publishes: {}, newest the registry publishes: {}, configVersion {})"
        ).format(
            len(hypersnap_sets),
            len(hypersnap_missing),
            len(registry_sets),
            fmt(hypersnap_newest),
            fmt(registry_newest),
            facts["registry"].get("config_version"),
        )

    if verdict == "possibly-fixed" and snapchain_newest is not None and hypersnap_newest < snapchain_newest:
        verdict = "still-broken"
        reason += "; and it is behind the consensus author's own file ({})".format(fmt(snapchain_newest))

    if args.json:
        facts["verdict"] = verdict
        facts["reason"] = reason
        facts["notes"] = notes
        json.dump(facts, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        stamp = facts["issue"].get("updated_at") or "unknown"
        print("Upstream Hypersnap sweep")
        print("  registry (Ethereum L1 {})".format(REGISTRY_ADDRESS))
        if registry_reachable:
            print(
                "    configVersion()        {}".format(facts["registry"].get("config_version"))
            )
            print(
                "    configToml()           {} validator sets, newest effective_at {}".format(
                    facts["registry"].get("validator_sets"), fmt(registry_newest)
                )
            )
        else:
            print("    unreachable: {}".format(facts["registry"].get("error")))
        print("  farcasterorg/hypersnap")
        print(
            "    main validators.toml   HTTP {} · {} sets · newest {} · missing {} of the registry's".format(
                facts["hypersnap"]["main_validators_toml"]["http"],
                facts["hypersnap"]["main_validators_toml"]["sets"],
                fmt(hypersnap_newest),
                facts["hypersnap"]["main_validators_toml"]["missing_vs_registry"],
            )
        )
        latest = facts["hypersnap"]["latest_tag"]
        print(
            "    @latest tag            installer HTTP {} (mentions a validator list: {}) · "
            "validators.toml HTTP {} · compose {} sets, newest {}".format(
                latest["installer_http"],
                latest["installer_mentions_validators"],
                latest["validators_toml_http"],
                latest["compose_sets"],
                fmt(latest["compose_newest"]),
            )
        )
        print("  farcasterxyz/snapchain (the repair operators confirmed in {})".format(ISSUE))
        print(
            "    main validators.toml   HTTP {} · {} sets · newest {} · matches the registry: {}".format(
                facts["snapchain"]["validators_toml"]["http"],
                facts["snapchain"]["validators_toml"]["sets"],
                fmt(snapchain_newest),
                "yes" if facts["snapchain"]["validators_toml"]["matches_registry"] else "no",
            )
        )
        print("  public read node {}".format(args.node))
        if node_error:
            print("    {}".format(node_error))
        else:
            for shard in sorted(heights_a):
                frozen = facts["node"].get("not_advancing", {}).get(str(shard))
                print(
                    "    shard {}  height {}  blockDelay {}s{}".format(
                        shard,
                        heights_a[shard],
                        delays_a.get(shard),
                        "   <- not advancing (it has not applied a block for that long)" if frozen else "",
                    )
                )
        print(
            "  {}  state={} comments={} updated={}".format(
                ISSUE, facts["issue"].get("state"), facts["issue"].get("comments"), stamp
            )
        )
        print("")
        print("VERDICT: {} - {}".format(verdict.upper(), reason))
        for note in notes:
            print("  note: {}".format(note))
        print("")
        print("What to do next")
        if verdict == "possibly-fixed":
            print("  1. install one on real hardware (16 GB RAM, 4 vCPU, 1.5 TB free disk)")
            print("  2. prove it follows the chain: compare /v1/info heights against this public node")
            print("     over a few minutes; only then may the CLI stop refusing")
            print("  3. implement the install path in cli/node.sh + cli/networks.sh, then the docs")
        elif verdict == "still-broken":
            print("  1. nothing to lift: the CLI's refusal and its record stay as they are")
            print("  2. re-run this script on the next sweep (one command, same facts)")
        else:
            print("  1. re-run with --rpc pointing at a working Ethereum L1 endpoint")

    return {"still-broken": 0, "possibly-fixed": 1, "unmeasured": 2}[verdict]


if __name__ == "__main__":
    sys.exit(main())