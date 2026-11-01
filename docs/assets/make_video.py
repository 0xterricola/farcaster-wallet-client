#!/usr/bin/env python3
"""Render the 59s vertical Fiddy walkthrough (1080x1920, burned-in captions).

Content is the deployed tutorial's own three steps (https://fiddy.fun/client):
provision -> read node -> client. Captions are burned into every frame; the
video has no audio track, so it reads fine muted (the way a feed autoplays).

It is a scripted rendering of the real commands and their real effect, not a
live capture: a real Snapchain read node needs 1.5-2 TB of disk, so provisioning
one here is not possible. Every frame carries the "scripted demo" label.
"""
import os, subprocess, sys, math
from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
FPS = 30
FFMPEG = os.path.expanduser("~/.hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg")
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fiddy-59s.mp4")

MONO = "/System/Library/Fonts/Menlo.ttc"
SANS = "/System/Library/Fonts/HelveticaNeue.ttc"
CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"

def mono(size, bold=False):
    return ImageFont.truetype(MONO, size, index=1 if bold else 0)

def sans(size, bold=True):
    return ImageFont.truetype(SANS, size, index=1 if bold else 0)

def cjk(size):
    return ImageFont.truetype(CJK, size, index=0)

# palette (matches site/index.html tokens)
GROUND, TERM = (22, 23, 21), (16, 17, 15)
INK, INK_DIM, CMT = (238, 240, 232), (167, 171, 158), (134, 139, 122)
LIME, LIME_DEEP = (212, 255, 63), (124, 181, 24)
RIM, CARD, HAIR = (255, 255, 255, 30), (255, 255, 255, 18), (255, 255, 255, 22)

f_term, f_term_b = mono(30), mono(30, True)
f_small, f_smallb = mono(22), mono(21, True)
f_cap = sans(42)
f_cap_s = sans(32)
f_big = sans(66)
f_huge = sans(88)
f_url = mono(38, True)
f_cjk = cjk(34)

PAD = 62
PANEL = [PAD, 232, W - PAD, 1400]      # terminal panel
BODY_X, BODY_Y, LH = PAD + 46, 232 + 190, 52
BODY_W = (W - PAD - 46) - BODY_X
BODY_BOTTOM = PANEL[3] - 30
CAP_BOTTOM = 1662
CAP_TOP_MIN = 1440
LINEMAX = 44                            # terminal body chars per line (asserted)
RAIL_Y = 1812

# ---------------------------------------------------------------- timeline
SHOTS = [
 dict(kind="title", t0=0.0, t1=3.2),

 dict(kind="term", t0=3.2, t1=14.0, step=0, title="fiddy - bash - step 0 of 2",
   cap="Step 0 | fiddy provision - rent the compute. 4 vCPU, 16 GB RAM, 1.5-2 TB disk. AWS with --aws, or any server with --ssh user@host.",
   lines=[
     (0.0, "cmd", "git clone https://github.com/ivcained/fiddy"),
     (2.4, "out", "cloning... done - the tool is bin/fiddy"),
     (3.4, "cmd", "cd fiddy && fiddy provision --aws"),
     (5.2, "ok",  "instance up - 4 vCPU / 16 GB"),
     (6.0, "ok",  "gp3 volume 2048 GB - nodes need 1.5-2 TB,"),
     (6.7, "dim", "   not the ~200 GB *compressed* snapshot"),
     (7.5, "ok",  "docker + prereqs installed"),
     (8.3, "ok",  "keys -> ~/.fiddy/   config -> same dir"),
     (9.1, "ok",  "firewall :22 :3381 :3383 open to your IP"),
     (10.0,"blank"," "),
     (10.2,"out", "ready - next, the node itself."),
   ]),

 dict(kind="term", t0=14.0, t1=28.5, step=1, title="fiddy - bash - step 1 of 2",
   cap="Step 1 | fiddy node up - a Snapchain read node on your server. It answers the API at once, then catches up on history.",
   lines=[
     (0.0, "cmd", "fiddy node up"),
     (1.4, "out", "installing docker + snapchain launcher"),
     (2.8, "out", "starting snapchain, waiting for the API"),
     (4.6, "ok",  "read node healthy - http :3381  grpc :3383"),
     (5.8, "out", "syncing history in the background (hours)"),
     (7.2, "cmd", "fiddy node status"),
     (8.4, "out", "sync 62%   peers 24   head 0x9f3c.."),
     (9.6, "out", "your node holds the full chain state"),
     (10.8,"out", "reads AND writes go through it - no API key"),
   ]),

 dict(kind="term", t0=28.5, t1=42.5, step=2, title="fiddy - bash - step 2 of 2",
   cap="Step 2 | fiddy client up - the web client reads and writes through your own node. Login is one gasless app key.",
   lines=[
     (0.0, "cmd", "fiddy client up --tunnel"),
     (1.6, "out", "ssh tunnel: localhost -> your node only"),
     (3.2, "ok",  "client reading YOUR node - localhost:3000"),
     (4.6, "cmd", "import a test account seed that has storage"),
     (6.2, "out", "one gasless KEY_ADD mints an ed25519 app key"),
     (7.6, "ok",  "no ETH, no Optimism tx, about a second"),
     (8.8, "out", "the custody key signs once, then sleeps."),
     (10.2,"blank"," "),
     (10.4,"out", "you are posting through your own node."),
   ]),

 dict(kind="lines", t0=42.5, t1=49.5, step=3,
   cap="Your feed, your casts, your reads - served by your own node. Plus the agent no other client has.",
   lines=[
     (0.4, "Your feed. Your casts. Your reads."),
     (2.2, "All served by your own node -"),
     (2.9, "no API key, no third party."),
     (4.2, "And one click hatches"),
     (4.9, "your own Hermes agent."),
   ]),

 dict(kind="recap", t0=49.5, t1=53.5, step=4,
   cap="Three commands. That is the whole install.",
   lines=[
     (0.0, "fiddy provision    # 0   the compute"),
     (0.5, "fiddy node up      # 1   the read node"),
     (1.0, "fiddy client up    # 2   your client"),
   ]),

 dict(kind="end", t0=53.5, t1=58.0),
]
TOTAL = SHOTS[-1]["t1"]

# ---------------------------------------------------------------- layout audit
def wrap(s, font, maxw):
    words, lines, cur = s.split(" "), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if font.getlength(t) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur); cur = w
    if cur: lines.append(cur)
    return lines

def audit():
    problems = []
    for s in SHOTS:
        if s["kind"] == "term":
            for i, (_, k, txt) in enumerate(s["lines"]):
                if len(txt) > LINEMAX:
                    problems.append("%s line %d too long (%d): %s" % (s["title"], i, len(txt), txt))
                if k == "cmd" and f_term_b.getlength(txt) + 34 > BODY_W:
                    problems.append("%s cmd overflows: %s" % (s["title"], txt))
                if k in ("ok", "out") and f_term.getlength(txt) + 36 > BODY_W:
                    problems.append("%s prefixed line overflows: %s" % (s["title"], txt))
            bot = BODY_Y + len(s["lines"]) * LH
            if bot > BODY_BOTTOM:
                problems.append("%s body bottom %d > %d" % (s["title"], bot, BODY_BOTTOM))
            for i, (_, k, txt) in enumerate(s["lines"]):
                if k != "cmd" and f_term.getlength(txt) > BODY_W:
                    problems.append("%s text overflows panel: %s" % (s["title"], txt))
        if "cap" in s:
            cl = wrap(s["cap"], f_cap, (W - PAD) - (PAD))
            if len(cl) > 3:
                problems.append("%s caption needs %d lines" % (s["kind"], len(cl)))
            top = CAP_BOTTOM - len(cl) * 60 - 30
            if top < CAP_TOP_MIN:
                problems.append("%s caption top %d < %d" % (s["kind"], top, CAP_TOP_MIN))
            for l in cl:
                if f_cap.getlength(l) > (W - PAD) - PAD:
                    problems.append("caption line overflows: %s" % l)
        if s["kind"] == "recap":
            for _, txt in s["lines"]:
                cmd = txt.split("#")[0].strip()
                if mono(40, True).getlength(cmd) + 46 > (W - PAD) - PAD - 40:
                    problems.append("recap cmd overflows: %s" % cmd)
        if s["kind"] == "end":
            for txt, f in [("github.com/ivcained/fiddy", mono(46, True)),
                           ("fiddy.fun/client", mono(72, True)),
                           ("your node - your client - your agent", f_cap)]:
                if f.getlength(txt) > W - 2 * PAD:
                    problems.append("end card overflows: %s" % txt)
        if s["kind"] == "title":
            for txt, f in [("Farcaster client.", f_huge), ("On your own node.", f_big)]:
                if f.getlength(txt) > W - 2 * PAD:
                    problems.append("title overflows: %s" % txt)
    return problems

# ---------------------------------------------------------------- drawing
def bg(d):
    for y in range(0, H, 4):
        k = y / H
        g = (1 - abs(k - .34) * 2)
        d.rectangle([0, y, W, y + 4], fill=(int(GROUND[0] + 7 * g), int(GROUND[1] + 8 * g), int(GROUND[2] + 6 * g)))

def rrect(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)

def header(d):
    d.text((PAD, 92), "fiddy", font=f_url, fill=LIME)
    d.text((W - PAD, 100), "fiddy.fun/client", font=f_small, fill=INK_DIM, anchor="ra")
    d.line([PAD, 158, W - PAD, 158], fill=RIM, width=2)

def footer(d, step):
    x = PAD
    for i, lab in enumerate(["0 provision", "1 node up", "2 client up"]):
        cur = (step == i)
        on = (step is not None and i <= step)
        d.ellipse([x, RAIL_Y - 9, x + 18, RAIL_Y + 9],
                  fill=LIME if cur else (LIME_DEEP if on else (70, 74, 64)))
        d.text((x + 30, RAIL_Y), lab, font=f_small,
               fill=LIME if cur else (INK_DIM if on else (110, 114, 102)), anchor="lm")
        x += 30 + int(f_small.getlength(lab)) + 46
    d.text((W - PAD, RAIL_Y), "scripted demo - the real commands", font=f_small,
           fill=(110, 114, 102), anchor="rm")

def caption_band(d, cap):
    lines = wrap(cap, f_cap, W - 2 * PAD)
    y0 = CAP_BOTTOM - len(lines) * 60 - 30
    rrect(d, [PAD - 26, y0, W - PAD + 26, CAP_BOTTOM], 20, fill=CARD, outline=RIM, width=2)
    d.line([PAD - 26, y0, PAD + 74, y0], fill=LIME, width=7)
    yy = y0 + 8
    for l in lines:
        d.text((PAD, yy), l, font=f_cap, fill=INK)
        yy += 60

def terminal_frame(d, shot, el):
    rrect(d, PANEL, 26, fill=TERM, outline=(0, 0, 0, 130), width=3)
    rrect(d, [PANEL[0] + 3, PANEL[1] + 3, PANEL[2] - 3, PANEL[3] - 3], 24, outline=RIM, width=2)
    d.line([PANEL[0] + 22, PANEL[1] + 3, PANEL[2] - 22, PANEL[1] + 3], fill=(255, 255, 255, 48), width=3)
    for i, c in enumerate([(88, 92, 82), (88, 92, 82), LIME_DEEP]):
        cx = PANEL[0] + 44 + i * 40
        d.ellipse([cx, PANEL[1] + 34, cx + 20, PANEL[1] + 54], fill=c)
    d.text((PANEL[0] + 44, PANEL[1] + 92), shot["title"], font=f_small, fill=CMT)
    d.text((PANEL[2] - 44, PANEL[1] + 92), "%d/2" % shot["step"], font=f_smallb, fill=LIME_DEEP, anchor="ra")
    d.line([PANEL[0] + 44, PANEL[1] + 134, PANEL[2] - 44, PANEL[1] + 134], fill=HAIR, width=2)

    ax, y = BODY_X, BODY_Y
    for ev_t, kind, s in shot["lines"]:
        if el < ev_t:
            continue
        if kind == "cmd":
            typed = min(len(s), max(0, int((el - ev_t) / 0.05)))
            body = s[:typed]
            d.text((ax, y), ">", font=f_term_b, fill=LIME)
            d.text((ax + 34, y), body, font=f_term_b, fill=INK)
            if typed < len(s) and int(el * 2) % 2 == 0:
                cw = ax + 34 + f_term_b.getlength(body)
                d.rectangle([cw + 8, y + 6, cw + 24, y + 42], fill=LIME)
        elif kind == "ok":
            d.text((ax, y), "\u2713", font=f_term_b, fill=LIME)
            d.text((ax + 36, y), s, font=f_term, fill=INK)
        elif kind == "out":
            d.text((ax, y), "\u2192", font=f_term_b, fill=LIME_DEEP)
            d.text((ax + 36, y), s, font=f_term, fill=INK_DIM)
        elif kind == "blank":
            pass
        else:
            d.text((ax, y), s, font=f_term, fill=CMT)
        y += LH
    if el > 0.9:                                   # liveness dot in the chrome
        r = 5 + 2 * math.sin(el * 4)
        cx, cy = PANEL[2] - 62, PANEL[1] + 44
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=LIME_DEEP)

def title_frame(d, el):
    d.text((PAD, 600), "Your own", font=f_huge, fill=INK)
    d.text((PAD, 710), "Farcaster client.", font=f_huge, fill=INK)
    d.text((PAD, 880), "On your own node.", font=f_big, fill=LIME)
    d.text((PAD, 976), "Three commands.", font=f_big, fill=INK_DIM)
    d.line([PAD, 1096, PAD + 190, 1096], fill=LIME, width=8)
    for i, l in enumerate(["no API keys", "no Neynar", "no permission", "no third party"]):
        d.text((PAD, 1156 + i * 54), "- " + l, font=f_cap_s, fill=INK_DIM)
    d.text((PAD, 1500), "fiddy.fun/client", font=f_url, fill=LIME)
    d.text((PAD, 1560), "github.com/ivcained/fiddy", font=f_small, fill=INK_DIM)

def lines_frame(d, shot, el):
    y = 520
    for ev_t, s in shot["lines"]:
        if el >= ev_t:
            f = f_big if f_big.getlength(s) <= W - 2 * PAD else f_cap
            prog = min(1.0, (el - ev_t) / 0.45)
            d.text((PAD, y), s, font=f, fill=INK if prog > .45 else INK_DIM)
        y += 124

def recap_frame(d, shot, el):
    for i, (ev_t, s) in enumerate(shot["lines"]):
        if el < ev_t:
            continue
        top = 500 + i * 190
        rrect(d, [PAD, top, W - PAD, top + 150], 20, fill=CARD, outline=RIM, width=2)
        d.rectangle([PAD, top + 14, PAD + 9, top + 136], fill=LIME)
        cmd, cmt = s.split("#", 1)
        d.text((PAD + 46, top + 70), cmd.strip(), font=mono(40, True), fill=INK, anchor="lm")
        d.text((PAD + 46, top + 118), "#" + cmt, font=f_small, fill=LIME_DEEP, anchor="lm")

def end_frame(d, el):
    d.text((W // 2, 600), "Full tutorial", font=f_cap_s, fill=INK_DIM, anchor="ma")
    d.text((W // 2, 700), "fiddy.fun/client", font=mono(72, True), fill=LIME, anchor="ma")
    d.line([W // 2 - 260, 810, W // 2 + 260, 810], fill=RIM, width=3)
    d.text((W // 2, 900), "Source (MIT)", font=f_cap_s, fill=INK_DIM, anchor="ma")
    d.text((W // 2, 986), "github.com/ivcained/fiddy", font=mono(46, True), fill=INK, anchor="ma")
    d.text((W // 2, 1150), "your node - your client - your agent", font=f_cap, fill=INK_DIM, anchor="ma")
    d.text((W // 2, 1560), "简体中文指南", font=f_cjk, fill=LIME, anchor="ma")
    d.text((W // 2, 1620), "fiddy.fun/client/zh", font=f_small, fill=INK_DIM, anchor="ma")

def render_frame(t):
    img = Image.new("RGB", (W, H), GROUND)
    d = ImageDraw.Draw(img, "RGBA")
    bg(d)
    shot = SHOTS[-1]
    for s in SHOTS:
        if s["t0"] <= t < s["t1"]:
            shot = s; break
    el = t - shot["t0"]
    header(d)
    k = shot["kind"]
    if k == "title":
        title_frame(d, el)
        caption_band(d, "The whole install on your own hardware, in 59 seconds. No voice-over - everything is on screen.")
        footer(d, None)
    elif k == "term":
        terminal_frame(d, shot, el); caption_band(d, shot["cap"]); footer(d, shot["step"])
    elif k == "lines":
        lines_frame(d, shot, el); caption_band(d, shot["cap"]); footer(d, shot["step"])
    elif k == "recap":
        recap_frame(d, shot, el); caption_band(d, shot["cap"]); footer(d, shot["step"])
    else:
        end_frame(d, el); footer(d, 2)
    return img

def captions_vtt(path):
    def ts(s):
        h = int(s // 3600); m = int(s % 3600 // 60); sec = s % 60
        return "%02d:%02d:%06.3f" % (h, m, sec)
    with open(path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for s in SHOTS:
            if "cap" in s:
                f.write("%s --> %s\n%s\n\n" % (ts(s["t0"] + 0.1), ts(s["t1"] - 0.1), s["cap"]))
        f.write("%s --> %s\n%s\n\n" % (ts(53.6), ts(57.9), "Full tutorial fiddy.fun/client - source github.com/ivcained/fiddy - Chinese guide fiddy.fun/client/zh"))

def main():
    problems = audit()
    print("layout audit:", "OK" if not problems else "%d PROBLEMS" % len(problems))
    for p in problems:
        print("  !", p)
    if problems:
        sys.exit(1)
    which = sys.argv[1] if len(sys.argv) > 1 else "video"
    if which == "probe":
        for t in [1.6, 8.0, 20.0, 34.0, 46.0, 56.0]:
            p = os.path.join(HERE, "probe-%04.1f.png" % t)
            render_frame(t).save(p); print(p)
        return
    captions_vtt(os.path.join(HERE, "fiddy-59s.vtt"))
    n = int(round(TOTAL * FPS))
    cmd = [FFMPEG, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H),
           "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "21",
           "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", OUT]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    for i in range(n):
        p.stdin.write(render_frame(i / FPS).tobytes())
        if i % 300 == 0:
            print("frame %d/%d" % (i, n), flush=True)
    p.stdin.close()
    err = p.stderr.read().decode()[-800:]
    p.wait()
    print(err)
    print("frames=%d duration=%.2fs -> %s" % (n, n / FPS, OUT))

if __name__ == "__main__":
    main()