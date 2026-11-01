#!/usr/bin/env python3
"""Translation review for the zh-Hans tutorial page (kanban t_a02d39fc).

Compares every <code>|<pre>|<kbd> block on site/index.html (EN) with
site/zh/index.html (ZH) and diffs the command-shaped tokens between them:
commands, flags, env vars, ports, paths, hosts and protocol identifiers must
appear verbatim on both sides. Comments after '#' are expected to be translated;
anything else that differs is a bug.

Run from the repo root:  python3 docs/evidence/zh-translation-review.py
"""
import re, html, collections

PAGES = [("site/index.html", "en"), ("site/zh/index.html", "zh")]

PATS = [
    r"fiddy [a-z]+(?: [a-z-]+)?", r"--[a-z-]+", r"~/[.a-z/]+", r":\d{4}",
    r"KEY_(?:ADD|REMOVE)", r"MERGE_MESSAGE", r"submitMessage",
    r"\$[A-Z_]{3,}", r"FIDDY_[A-Z_]+",
    r"[a-z0-9.-]+\.(?:fun|com|eth|io|sh|xyz)", r"\b(?:git|bash|ssh|docker|sudo)\b",
    r"\b[A-Z][A-Z_]{3,}\b",
]

def code_blocks(path):
    s = open(path, encoding="utf-8").read()
    out = []
    for m in re.finditer(r"<(code|pre|kbd)[^>]*>(.*?)</\1>", s, re.S):
        out.append(html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip())
    return out

def token_counts(text):
    c = collections.Counter()
    for p in PATS:
        for m in re.finditer(p, text):
            c[m.group(0)] += 1
    return c

def main():
    en, zh = (code_blocks(p) for p, _ in PAGES)
    print("code blocks: en=%d zh=%d" % (len(en), len(zh)))
    ce, cz = token_counts("\n".join(en)), token_counts("\n".join(zh))
    print("\n-- command/code tokens in EN but missing from ZH --")
    for k, v in sorted({k: v for k, v in ce.items() if k not in cz}.items()):
        print("  %-40s x%d" % (k, v))
    print("\n-- tokens in ZH but not EN (should be empty) --")
    for k, v in sorted({k: v for k, v in cz.items() if k not in ce}.items()):
        print("  %-40s x%d" % (k, v))
    print("\n-- counts (en, zh) --")
    for k in ["fiddy node up", "fiddy client up", "fiddy node status", "fiddy node logs",
              "KEY_ADD", "KEY_REMOVE", "MERGE_MESSAGE", "submitMessage",
              "--tunnel", "--ssh", "--aws", ":3381", ":3383", "~/.fiddy/"]:
        print("  %-18s %s" % (k, (ce.get(k, 0), cz.get(k, 0))))
    print("\n-- ZH code blocks with CJK that also look like commands --")
    bad = 0
    for t in zh:
        if re.search(r"[\u4e00-\u9fff]", t) and re.search(r"\b(fiddy|git|ssh|docker|export|cd|bash)\b|--|\$", t):
            for line in t.splitlines():
                code = line.split("#", 1)[0]          # inline comments are translated on purpose
                if re.search(r"[\u4e00-\u9fff]", code):
                    print("  !", repr(line)); bad += 1
    print("  %d offending line(s) (CJK left of any '#')" % bad)

main()