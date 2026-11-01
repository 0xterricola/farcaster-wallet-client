#!/usr/bin/env python3
"""Second stage: add liveness (last cast) and reach (followers) to the ranked
candidates, then emit a compact review table.

Farcaster timestamps are seconds since 2021-01-01T00:00:00Z.
"""
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HUB = "https://haatz.quilibrium.com"
FC_EPOCH = 1609459200
DATA = Path(__file__).parent / "data"


def get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fiddy-recruit/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except Exception:  # noqa: BLE001
            time.sleep(1.0 * (i + 1))
    return None


def iso(ts):
    return datetime.fromtimestamp(FC_EPOCH + ts, tz=timezone.utc).strftime("%Y-%m-%d")


def main():
    cands = json.loads((DATA / "candidates.json").read_text())
    top = cands[:130]
    live = {}
    p = DATA / "liveness.json"
    if p.exists():
        live = json.loads(p.read_text())
    for i, c in enumerate(top, 1):
        fid = str(c["fid"])
        if fid in live:
            continue
        rec = {}
        d = get(f"{HUB}/v1/castsByFid?fid={fid}&pageSize=6&reverse=true")
        ms = [m for m in ((d or {}).get("messages") or []) if m.get("data", {}).get("castAddBody")]
        if ms:
            rec["last_ts"] = ms[0]["data"]["timestamp"]
            rec["last_text"] = (ms[0]["data"]["castAddBody"].get("text") or "")[:120]
            rec["n_recent"] = len(ms)
        else:
            rec["last_ts"] = None
        w = get(f"https://api.warpcast.com/v2/user?fid={fid}")
        u = ((w or {}).get("result") or {}).get("user") or {}
        rec["followers"] = u.get("followerCount")
        rec["following"] = u.get("followingCount")
        rec["warpcast_username"] = u.get("username")
        live[fid] = rec
        if i % 25 == 0:
            p.write_text(json.dumps(live))
            print(f"  ...{i}/{len(top)}")
    p.write_text(json.dumps(live))

    rows = []
    for c in top:
        r = live.get(str(c["fid"]), {})
        last = r.get("last_ts")
        rows.append(
            {
                **{k: c.get(k) for k in ("fid", "username", "display", "bio", "url", "twitter", "score", "reasons", "intent_text")},
                "last_active": iso(last) if last else None,
                "days_idle": None if not last else round((1792338235 - (FC_EPOCH + last)) / 86400, 1),
                "followers": r.get("followers"),
                "last_text": r.get("last_text"),
            }
        )
    rows.sort(key=lambda r: (-r["score"], r["days_idle"] if r["days_idle"] is not None else 999))
    (DATA / "candidates_enriched.json").write_text(json.dumps(rows, indent=1))

    out = []
    for r in rows:
        out.append(
            f"{r['score']:>3} fc={str(r['followers']):>5} idle={str(r['days_idle']):>5}d "
            f"@{str(r['username'])[:20]:<20} {str(r['bio'] or '')[:90]} | last: {str(r['last_text'] or '')[:70]}"
        )
    (DATA / "review-table.txt").write_text("\n".join(out))
    print("\n".join(out[:70]))


if __name__ == "__main__":
    main()