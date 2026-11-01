#!/usr/bin/env python3
"""Fetch Farcaster network data for the Fiddy voucher recruitment candidate list.

Source: public hub HTTP API (haatz.quilibrium.com) - no auth required.
Writes JSON to ./data/ so each stage is re-runnable and inspectable.
"""
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

HUB = "https://haatz.quilibrium.com"
BOUNTY_HASH = "0x50184b62b4c52fd76628713562e1eda3dccaf63d"
BOUNTY_FID = 37
OWNER_FID = 191554
DATA = Path(__file__).parent / "data"
DATA.mkdir(exist_ok=True)


def get(path, tries=4):
    url = HUB + path
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fiddy-voucher-recruit/1.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"failed {url}: {last}")


def paged(path, key="messages", page_size=100, max_pages=60):
    out, token = [], None
    for _ in range(max_pages):
        p = f"{path}{'&' if '?' in path else '?'}pageSize={page_size}"
        if token:
            p += f"&pageToken={token}"
        d = get(p)
        items = d.get(key) or []
        out.extend(items)
        token = d.get("nextPageToken")
        if not token or not items:
            break
        time.sleep(0.15)
    return out


def main():
    # --- stage 1: the bounty cast and its reply thread -----------------------
    thread = paged(f"/v1/castsByParent?fid={BOUNTY_FID}&hash={BOUNTY_HASH}")
    (DATA / "bounty-thread.json").write_text(json.dumps(thread))
    print("bounty thread replies:", len(thread))

    # --- stage 2: reactions/recasts are not stored on this hub (empty) ------
    (DATA / "bounty-likes.json").write_text("[]")
    (DATA / "bounty-recasts.json").write_text("[]")
    print("reactions: not served by this hub, skipped")

    # --- stage 3: the owner's graph -----------------------------------------
    following = paged(f"/v1/linksByFid?fid={OWNER_FID}&link_type=follow")
    followers = paged(f"/v1/linksByTargetFid?target_fid={OWNER_FID}&link_type=follow")
    (DATA / "owner-following.json").write_text(json.dumps(following))
    (DATA / "owner-followers.json").write_text(json.dumps(followers))
    print("owner following:", len(following), "owner followers:", len(followers))


if __name__ == "__main__":
    main()