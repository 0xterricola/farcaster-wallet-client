# Extra-mile assets for the bounty (Chinese translation, 59s vertical video)

Owner: kanban `t_a02d39fc` (ranked extra mile: **more vouches > Chinese translation > 59s video**).
Both assets are public and linkable; the submission task can reference the URLs below directly.

## Public URLs

| Asset | URL | State |
| --- | --- | --- |
| Chinese tutorial (zh-Hans) | https://fiddy.fun/client/zh/ | live, 200, byte-identical to `site/zh/index.html` at HEAD |
| Chinese README (key sections) | https://github.com/ivcained/fiddy/blob/main/README.zh-CN.md | committed, linked from `README.md` |
| 59s vertical video | https://fiddy.fun/client/fiddy-59s.mp4 | live, 200, `video/mp4`, 891,495 B, `accept-ranges: bytes` |
| Captions / transcript (WebVTT) | https://fiddy.fun/client/fiddy-59s.vtt | live, 200 (see limitation below) |
| 59s video, repo copy (download mirror) | https://github.com/ivcained/fiddy/raw/main/docs/assets/fiddy-59s.mp4 | committed, 200, byte-identical — serves `application/octet-stream`, so **use the fiddy.fun URL for playback**, this one for archiving |
| Build script (reproduce the video) | https://github.com/ivcained/fiddy/blob/main/docs/assets/make_video.py | PIL + ffmpeg, no other deps |
| Video preview (contact sheet, 6 frames) | task attachment `preview-contact-sheet.png` | evidence only |

## 1. Chinese translation (Simplified, zh-Hans)

Already live before this run, shipped by the parent card: `site/zh/index.html` → `/client/zh/`,
`hreflang` both ways, linked from the `/client` header and footer. This card adds the README half
of the brief and a review pass.

**Added this run**

- `README.zh-CN.md` — the README's key sections in natural Simplified Chinese: 快速开始 (install),
  跑一个读节点, 跑客户端, 常见问题 (troubleshooting), plus the fork/upstream and licence notes.
  Command names, flags, env vars and ports are kept in English.
- `README.md` — three lines under the tutorial link pointing at the Chinese README and `/client/zh`.

**Translation review (what was actually checked, not asserted)**

`docs/evidence/zh-translation-review.txt` is the raw output of `docs/evidence/zh-translation-review.py` (both committed). Method: extract every `<code>|<pre>|<kbd>`
block from `site/index.html` and `site/zh/index.html`, then diff the command-shaped tokens
(`fiddy …`, `--flag`, `~/.fiddy/…`, `:port`, `KEY_ADD`/`KEY_REMOVE`/`MERGE_MESSAGE`, hostnames)
between the two pages.

```
code blocks: en=22 zh=22
command/code tokens present in EN but missing from ZH:  (none)
tokens present in ZH but not EN:                        (none)
fiddy node up (2,2)  fiddy client up (2,2)  fiddy node status (1,1)  fiddy node logs (1,1)
KEY_ADD (6,6)  KEY_REMOVE (4,4)  MERGE_MESSAGE (4,4)  submitMessage (1,1)
--tunnel (2,2)  --ssh (2,2)  --aws (2,2)  :3381 (1,1)  :3383 (1,1)  ~/.fiddy/ (1,1)
```

The only CJK inside code blocks is in `#` comments, which is correct: comments are translated,
commands are not. Both pages also keep the same anchor set (`quickstart`, `architecture`, `safety`,
`agent`, `faq`), so every cross-link and the README's `#safety` link still land.

## 2. The 59s vertical video

- File: `fiddy-59s.mp4` — **1080x1920, 30 fps, h264 High, yuv420p, 58.00 s, 891 KB, no audio track**
  (readable muted, which is how a feed autoplays). Captions are burned into every frame. The same file
  is committed at `docs/assets/fiddy-59s.mp4` as an archivable mirror.
- Walkthrough order matches the brief: **install (`fiddy provision`) → read node (`fiddy node up`) →
  client (`fiddy client up --tunnel`)** — then what you get, a three-command recap, and an end card
  carrying **fiddy.fun/client** and **github.com/ivcained/fiddy** (plus the Chinese guide).
- Source of truth for the copy: the deployed tutorial. The disk/price line follows the corrected
  `/client` copy (1.5–2 TB, not "200 GB"; the ~200 GB snapshot is the *compressed* size). No instance
  type is named, so the video stays true whatever `cli/provision.sh` defaults to.

**Honest disclosure: this is a scripted rendering of the real commands, not a live capture.**
A real Snapchain read node needs 1.5–2 TB of disk, so it cannot be provisioned from this machine; the
tutorial has no recorded screen session to cut down either. Every frame therefore carries the label
`scripted demo - the real commands`, and the command names, flags, ports and outputs mirror the
tutorial. Treat it as a marketing walkthrough, not as proof of a working install — the proof is the
voucher's cast.

**How it is built / how to change it**

```bash
# committed copy: docs/assets/make_video.py (identical to the one used for the upload)
python3 docs/assets/make_video.py probe    # 6 PNGs + the layout audit (exits non-zero on a problem)
python3 docs/assets/make_video.py video    # frames straight into ffmpeg -> fiddy-59s.mp4 (~35 s wall)
```

`make_video.py` is self-contained (PIL + ffmpeg only; `FFMPEG` at the top points at the toolchain on this machine). Content lives in the `SHOTS` list: each shot
has a start/end time, a caption, and timestamped terminal lines. Editing copy means editing that list
and re-running; the audit fails the build if a line overflows the panel, if a caption needs more than
three lines, or if the caption band would overlap the terminal.

**Quality checks actually run (no human eyes were available to this worker, so these are the
substitutes for a review)**

| Check | Result |
| --- | --- |
| Layout audit (`make_video.py probe`) | **OK** — 0 problems: no terminal line exceeds the panel width, no line longer than 44 chars, body bottom 1094 < 1370, captions ≤ 3 lines |
| Ink-bounds audit over 6 rendered frames **and 16 frames decoded back out of the mp4** (`docs/evidence/video-frame-audit.txt`) | text bbox x 36–1015 inside the 1080 frame; **0 ink pixels** in the top 80 px and bottom 80 px; 0 ink in the panel/caption gap (1402–1460) except the caption's own lime accent bar at 1452 |
| Captions present in every frame | bright-ink counts: panel 12k–53k, caption band 17k–29k (0 only on the title card, which has no band); progress rail present 813–2000 |
| Glyph coverage per font | every character drawn was rendered with the font that has it: Menlo (terminal, `✓`, `→`), Helvetica Neue (captions/titles), Hiragino Sans GB (the one CJK line). Zero `.notdef` boxes |
| Container facts | `ffmpeg -i` → Duration 00:00:58.00, h264 High, yuv420p(progressive), 1080x1920, 30 fps, one stream (no audio) |
| Served bytes | `md5` local == `md5` on the VPS == `md5` of the HTTPS body (`bb6bb3386ef9a00efc4c9853309fddcc`) |
| Range support | `curl -r 0-99` → **206**, 100 bytes (players can seek) |
| Repo mirror reachable | `gh api repos/ivcained/fiddy/commits/main` → `a28e03f`, and `docs/assets/fiddy-59s.mp4` is in that tree (891,495 B) |

**Deploy (same pattern as the page — pin the hash, not the branch)**

```bash
scp fiddy-59s.mp4 fiddy-59s.vtt root@100.111.203.78:/var/www/fiddy-client/
ssh root@100.111.203.78 'chmod 0644 /var/www/fiddy-client/fiddy-59s.*'
md5 -q fiddy-59s.mp4   # must match md5sum on the VPS
```

## Limitations and follow-ups (not blockers for submission)

1. **The video is not embedded on `/client`.** `site/index.html` is a declared hotspot (three cards
   edit it) and this card does not own that copy. If the owner wants it embedded, the safe snippet is
   a `<video controls playsinline poster=… src="/client/fiddy-59s.mp4">` block in the hero — one owner,
   one commit, then re-deploy the page.
2. **`.vtt` is served as `application/octet-stream`** (nginx's `mime.types` has no `vtt` entry, and the
   `/client/` location inherits `default_type application/octet-stream`). Browsers only accept a
   `<track>` with `text/vtt`, so today the file is a **downloadable transcript**, not a live track.
   Captions are burned in regardless. Fix belongs to whoever owns `/etc/nginx/sites-available/fiddy.fun`:
   a nested `location ~* \.vtt$ { default_type text/vtt; add_header Cache-Control "public, max-age=300"; }`
   inside the existing `location ^~ /client/`, then `nginx -t && systemctl reload nginx`. Do **not** add a
   bare `types {}` block there — that would replace the whole MIME map and serve `index.html` as binary.
3. **No audio track at all.** Deliberate (no voice-over in the brief, and it keeps the file at 891 KB);
   if a platform rejects silent video, mux a silent AAC track with
   `ffmpeg -i fiddy-59s.mp4 -f lavfi -i anullsrc -shortest -c:v copy -c:a aac out.mp4`.