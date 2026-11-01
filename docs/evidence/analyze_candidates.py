#!/usr/bin/env python3
"""Rank Farcaster candidates for the Fiddy voucher ask from real network data.

Inputs (all fetched by fetch_network.py from a public hub):
  data/bounty-thread.json    - the 2220 replies to balajis's bounty cast
  data/owner-following.json  - fids @ivc (191554) follows
  data/owner-followers.json  - fids that follow @ivc
  data/ivc-casts.json        - @ivc's recent casts (Warpcast public API)

Output: data/candidates.json (ranked) + a human table on stdout.
"""
import json
import re
import time
import urllib.request
from pathlib import Path

HUB = "https://haatz.quilibrium.com"
DATA = Path(__file__).parent / "data"

VOUCH_INTENT = re.compile(
    r"vouch|voucher|i'?ll run|i can run|i'?d run|happy to run|willing to|"
    r"how do i (vouch|help|run)|need (a|someone to) vouch|looking for a vouch|"
    r"i have a (server|vps)|i'?ve got a (server|vps|box)|i'?ll try|sign me up",
    re.I,
)
DEV_SIGNAL = re.compile(
    r"\b(dev|devs|developer|engineer|eng\b|infra|infrastructure|devops|sre|sysadmin|"
    r"backend|full[- ]stack|rust|golang|gopher|python|typescript|node|kubernetes|k8s|"
    r"docker|self[- ]host|homelab|vps|server|servers|rpc|protocol|validator|node operator|"
    r"smart contract|solidity|founder|builder|building|ship|shipping|hacker|architect)\b",
    re.I,
)
FARCASTER_TOOLING = re.compile(
    r"farcaster|snapchain|hub\b|neynar|miniapp|mini app|frame|fname|fid\b|warpcast|"
    r"hypersnap|shuttle|custody|signer",
    re.I,
)
SPAM = re.compile(
    r"airdrop|casino|betting|sportsbook|giveaway|give away|free followers|"
    r"onlyfans|porn|forex|signal group|pump|memecoin presale|dm me to earn|"
    r"follow back|f4f|investment opportunity|guaranteed profit",
    re.I,
)


def get_json(path, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(HUB + path, headers={"User-Agent": "fiddy-recruit/1.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.loads(r.read().decode())
        except Exception:  # noqa: BLE001
            time.sleep(1.2 * (i + 1))
    return {}


def profile(fid):
    d = get_json(f"/v1/userDataByFid?fid={fid}")
    out = {"fid": fid}
    for m in (d.get("messages") or []):
        b = m.get("data", {}).get("userDataBody", {})
        t, v = b.get("type", ""), b.get("value", "")
        if t == "USER_DATA_TYPE_USERNAME":
            out["username"] = v
        elif t == "USER_DATA_TYPE_DISPLAY":
            out["display"] = v
        elif t == "USER_DATA_TYPE_BIO":
            out["bio"] = v
        elif t == "USER_DATA_TYPE_URL":
            out["url"] = v
        elif t == "USER_DATA_TYPE_TWITTER":
            out["twitter"] = v
        elif t == "USER_DATA_TYPE_LOCATION":
            out["location"] = v
    return out


def fids_from_links(msgs, key="linkBody"):
    out = []
    for m in msgs:
        b = m.get("data", {}).get(key, {})
        t = b.get("targetFid")
        if t:
            out.append(int(t))
    return out


def load_profile_cache():
    p = DATA / "profiles.json"
    return json.loads(p.read_text()) if p.exists() else {}


def main():
    thread = json.loads((DATA / "bounty-thread.json").read_text())
    following = fids_from_links(json.loads((DATA / "owner-following.json").read_text()))
    followers = fids_from_links(json.loads((DATA / "owner-followers.json").read_text()))
    set_following, set_followers = set(following), set(followers)

    replies = []
    for m in thread:
        d = m.get("data", {})
        body = d.get("castAddBody", {})
        replies.append(
            {
                "fid": int(d.get("fid", 0)),
                "ts": int(d.get("timestamp", 0)),
                "text": (body.get("text") or "").strip(),
                "mentions": body.get("mentions") or [],
            }
        )
    thread_fids = {r["fid"] for r in replies}
    intent = [r for r in replies if VOUCH_INTENT.search(r["text"])]

    # ---- candidate set: people with a reason to say yes -------------------
    # Prefilter: don't profile all 2220 thread authors. Keep only substantive
    # replies (>40 chars, not spam) plus everyone the owner already follows.
    def substantive(t):
        return len(t) > 40 and not SPAM.search(t)

    cand = {}
    for r in replies:
        if substantive(r["text"]):
            cand[r["fid"]] = {"fid": r["fid"], "reasons": ["substantive reply in the bounty thread"], "score": 1}
        elif r["fid"] in set_following or r["fid"] in set_followers:
            cand[r["fid"]] = {"fid": r["fid"], "reasons": [], "score": 0}
    for r in intent:
        c = cand.setdefault(r["fid"], {"fid": r["fid"], "reasons": [], "score": 0})
        c["reasons"].append("expressed voucher/run-it intent in the bounty thread")
        c["score"] += 3
        c.setdefault("intent_text", r["text"][:280])
    for fid in set_following:
        c = cand.setdefault(fid, {"fid": fid, "reasons": [], "score": 0})
        if fid in thread_fids:
            c["reasons"].append("follows @ivc AND replied to the bounty")
            c["score"] += 3
        else:
            c["reasons"].append("follows @ivc")
            c["score"] += 1
    for fid in thread_fids & set_followers:
        c = cand.setdefault(fid, {"fid": fid, "reasons": [], "score": 0})
        c["reasons"].append("follows @ivc (in the owner's audience) AND replied to the bounty")
        c["score"] += 2

    print(f"thread authors: {len(thread_fids)}  intent hits: {len(intent)}  "
          f"following: {len(set_following)}  followers: {len(set_followers)}  "
          f"candidate pool before profiles: {len(cand)}")

    cache = load_profile_cache()
    todo = [f for f in cand if str(f) not in cache]
    print(f"profiles cached: {len(cache)}  to fetch: {len(todo)}")
    for i, fid in enumerate(todo, 1):
        cache[str(fid)] = profile(fid)
        if i % 50 == 0:
            (DATA / "profiles.json").write_text(json.dumps(cache))
            print(f"  ...{i}/{len(todo)}")
    (DATA / "profiles.json").write_text(json.dumps(cache))

    # ---- score with profile signals -------------------------------------
    for fid, c in cand.items():
        p = cache.get(str(fid)) or {}
        bio = " ".join(str(p.get(k, "")) for k in ("bio", "display", "url", "twitter"))
        c["username"] = p.get("username")
        c["display"] = p.get("display")
        c["bio"] = (p.get("bio") or "").replace("\n", " ")[:200]
        c["url"] = p.get("url")
        c["twitter"] = p.get("twitter")
        if not c["username"]:
            c["score"] -= 5
            c["reasons"].append("no username on this hub snapshot")
        if SPAM.search(bio):
            c["score"] -= 6
            c["reasons"].append("spam-looking profile")
        if DEV_SIGNAL.search(bio):
            c["score"] += 2
            c["reasons"].append("dev/infra signals in profile")
        if FARCASTER_TOOLING.search(bio):
            c["score"] += 3
            c["reasons"].append("builds/inspects Farcaster tooling")
    ranked = sorted(cand.values(), key=lambda c: (-c["score"], c.get("username") or "zzz"))

    (DATA / "candidates.json").write_text(json.dumps(ranked, indent=1))
    print("\nranked:", len(ranked))
    for c in ranked[:40]:
        print(f"{c['score']:>3}  @{c.get('username') or '?':<22} fid={c['fid']:<8} "
              f"{'; '.join(c['reasons'])[:95]}")


if __name__ == "__main__":
    main()