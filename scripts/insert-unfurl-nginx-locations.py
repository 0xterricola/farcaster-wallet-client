#!/usr/bin/env python3
"""Put the per-page-unfurl locations into the fiddy.fun vhost, once.

    python3 scripts/insert-unfurl-nginx-locations.py <vhost> <snippet>

Run by `scripts/install-fiddy-unfurl-service.sh` on the host, which also takes a
copy of the vhost first (`<vhost>.before-unfurl`). It refuses rather than guesses:

  * a location the vhost already carries is left alone — IDEMPOTENT PER BLOCK,
    not per file: the snippet grew a `/look/` pair in card t_d85d8520, and a
    file-level check ("does this vhost have /unfurl/ yet?") would have skipped
    them on every deployed host, which is exactly where they were needed;
  * a vhost with no `location / {` — the SPA fallback these are inserted before —
    is an error, because inserting anywhere else would change which requests the
    app sees;
  * the file is written only after nginx itself has been asked to validate it
    (`nginx -t` is the caller's next step, and it fails loudly if this went
    wrong).
"""

import sys

vhost, snippet = sys.argv[1], sys.argv[2]
text = open(vhost).read()
block = open(snippet).read()
lines = block.split("\n")


def blocks_of(source):
    """Each `location … { … }` in a snippet, as its own text.

    A block ends at the first `}` sitting at the block's own indentation, which
    is how the snippet is written: a brace nested inside a location (an `if`,
    an `error_page`) is deeper than its own `{`, so it cannot be mistaken for
    the end of it.
    """
    found = []
    index = 0
    while index < len(source):
        line = source[index]
        if line.lstrip().startswith("location ") and line.rstrip().endswith("{"):
            indent = len(line) - len(line.lstrip())
            chunk = [line]
            cursor = index + 1
            while cursor < len(source):
                chunk.append(source[cursor])
                if source[cursor].rstrip() == " " * indent + "}":
                    break
                cursor += 1
            found.append("\n".join(chunk))
            index = cursor + 1
            continue
        index += 1
    return found


marker = "    location / {\n"
if text.count(marker) != 1:
    raise SystemExit(
        f"expected exactly one `location / {{` in {vhost}, found {text.count(marker)}"
    )

missing = []
for candidate in blocks_of(lines):
    header = candidate.split("\n")[0].strip()
    if header in text:
        print(f"  vhost already routes {header}: left alone")
        continue
    missing.append(candidate)

if not missing:
    print("  vhost: every location this snippet carries is already in place")
    sys.exit(0)

print(f"  vhost: inserting {len(missing)} location(s)")
open(vhost, "w").write(text.replace(marker, "\n".join(missing) + "\n" + marker, 1))
print("  vhost: inserted the missing locations ahead of the app's own fallback")