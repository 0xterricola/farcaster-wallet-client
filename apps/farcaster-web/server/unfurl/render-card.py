#!/usr/bin/env python3
"""Draw the 1200x630 social card or 1200x800 mini-app card for a page.

The 3:2 variant is adapted from backmeupplz/quilcast commit d0a87cce7fd7
(MIT), with this renderer's own centred layout, mascot and glow preserved.

    python3 render-card.py < payload.json > card.png

The payload is one JSON object on stdin:

    {"kind":"cast","hash":"0x…","text":"…","username":"dwr","fid":3,
     "displayName":"Dan Romero","alt":"…"}
    {"kind":"profile","fid":3,"username":"dwr","displayName":"Dan Romero",
     "bio":"…","alt":"…"}
    {"kind":"look","id":"a1b2c3d4e5","name":"Mossy","palette":{"bg":"#…",
     "accent":"#…"},"round":18,"borderWidth":1,"font":"rounded"}

WHY THIS IS PYTHON AND NOT THE BROWSER

`scripts/render-share-card.mjs` draws the SITE card with Playwright and the
reader's own Chrome, which is right for a script a person runs on their laptop
and wrong for a service: the host that answers crawlers for fiddy.fun has no
Chromium, and a browser per unfurl would be a lot of machine for a picture of
some text. It has Python 3 and Pillow, which is what this uses. The two cards
are drawn in the same language on purpose — the same ground (#161715), the same
chartreuse (#d4ff3f), the same dim grey (#9ba193), the same mascot still
(`fiddy-mark-poster.png`, which the release ships in its own web root) in the
same corner — so a feed that shows both reads as one product.

WHAT IT WILL NOT DO

It does not invent a fact. A card carries the handle, the words the cast
actually has and, for a profile, the bio that account published. No follower
count, no avatar: an avatar would mean fetching a third party's image per card,
and a card that fails to draw is worse than a card that draws less.

Emoji are dropped rather than drawn as empty boxes (see `keep_glyphs`).
"""

import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

WIDTH = 1200
HEIGHT = 630
MINI_APP_HEIGHT = 800
PAD_LEFT = 92
TEXT_WIDTH = 700  # the mascot owns everything to the right of this

BG = (0x16, 0x17, 0x15)
INK = (0xEE, 0xF0, 0xE8)
SOFT = (0xB6, 0xBC, 0xAE)
DIM = (0x9B, 0xA1, 0x93)
ACCENT = (0xD4, 0xFF, 0x3F)

# The CSS on the site card names `'Helvetica Neue', Helvetica, Arial,
# sans-serif`. On this host those resolve to nothing, so the same character is
# asked for by the names a Linux box files it under: Liberation Sans is
# metric-compatible with Arial, DejaVu is the fallback everything has, Lato is
# the last pleasant surprise. The macOS paths are here so the same script draws
# the same card on the machine the site card was drawn on.
FONT_FILES = {
    "bold": [
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/lato/Lato-Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ],
    "regular": [
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/lato/Lato-Regular.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ],
}


def font_path(weight):
    """The first font this host actually has, or a stated failure."""
    for candidate in FONT_FILES[weight]:
        if os.path.exists(candidate):
            return candidate
    raise SystemExit(f"no {weight} font on this host: tried {FONT_FILES[weight]}")


class Card:
    """The frame every card shares: ground, glow, mascot, the address."""

    def __init__(self, mascot_path, height=HEIGHT):
        self.offset = (height - HEIGHT) // 2
        self.image = Image.new("RGB", (WIDTH, height), BG)
        self.draw = ImageDraw.Draw(self.image)
        self._glow()
        self._mascot(mascot_path)
        self.draw = ImageDraw.Draw(self.image)
        self.bold = {size: self._font("bold", size) for size in (40, 54, 62)}
        self.regular = {size: self._font("regular", size) for size in (26, 30)}

    @staticmethod
    def _font(weight, size):
        return ImageFont.truetype(font_path(weight), size)

    def _glow(self):
        """The chartreuse bloom behind the mascot, as the site card has it.

        The site card is CSS: `radial-gradient(560px 560px at 81% 72%,
        rgba(212,255,63,0.2), rgba(212,255,63,0) 66%)`. This draws exactly that
        — a 560px radius centred at 81%/72%, 20% alpha at the centre fading
        linearly to nothing by 66% of the radius — because
        `Image.radial_gradient` does not: its gradient only reaches white at the
        square's CORNERS (181 on an edge midpoint), so a pasted layer keeps a
        faint rectangle of alpha at its own edge, and the card gets a visible
        vertical seam where that edge falls (measured on the first draft of this
        script). The mask is computed small and scaled up, which is both fast
        and smooth.
        """
        scale = 3
        mask_w, mask_h = WIDTH // scale, self.image.height // scale
        radius = 560 / scale
        cx, cy = 0.81 * mask_w, (0.72 * HEIGHT + self.offset) / scale
        mask = Image.new("L", (mask_w, mask_h), 0)
        pixels = mask.load()
        falloff = radius * 0.66
        for y in range(mask_h):
            dy = y - cy
            for x in range(mask_w):
                distance = ((x - cx) ** 2 + dy**2) ** 0.5
                if distance < falloff:
                    pixels[x, y] = int(round(51 * (1 - distance / falloff)))
        mask = mask.resize(self.image.size, Image.Resampling.LANCZOS)
        self.image.paste(Image.new("RGB", self.image.size, ACCENT), (0, 0), mask)

    def _mascot(self, mascot_path):
        mascot = Image.open(mascot_path).convert("RGBA")
        box = 330
        mascot.thumbnail((box, box), Image.Resampling.LANCZOS)
        self.image.paste(
            mascot,
            (WIDTH - 60 - mascot.width, HEIGHT - 24 - mascot.height + self.offset),
            mascot,
        )

    def text(self, value, xy, font, fill):
        self.draw.text((xy[0], xy[1] + self.offset), value, font=font, fill=fill)

    def line(self, value, xy, font, fill):
        self.draw.text((xy[0], xy[1] + self.offset), value, font=font, fill=fill)

    def wrap(self, value, font, max_width, max_lines, max_chars=280):
        """Greedy wrap with an honest ellipsis, and never an unbounded block."""
        words = keep_glyphs(" ".join(value.split())[:max_chars]).split(" ")
        lines = []
        current = ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if self.draw.textlength(candidate, font=font) <= max_width or not current:
                current = candidate
                continue
            lines.append(current)
            current = word
            if len(lines) == max_lines:
                break
        if current and len(lines) < max_lines:
            lines.append(current)
        if not lines:
            return []
        # Anything left over becomes one ellipsis on the last line, cut back
        # word by word until it fits with the ellipsis in place.
        remaining = words[len(" ".join(lines).split(" ")):] if lines else []
        if remaining:
            last = lines[-1]
            while last and self.draw.textlength(f"{last} …", font=font) > max_width:
                last = " ".join(last.split(" ")[:-1])
            lines[-1] = f"{last} …".strip()
        return lines


def keep_glyphs(value):
    """Drop anything a text font cannot draw.

    Casts carry emoji, and the only emoji face this host has is a colour bitmap
    font that FreeType will not scale to a 54px line honestly — it would draw a
    full-size glyph, or an empty box. Neither belongs on a card, so the words
    stay and the pictures go.
    """
    kept = []
    for char in value:
        code = ord(char)
        if code < 0x2000 or 0x2000 <= code < 0x2066 or 0x2190 <= code < 0x3000:
            # Control and formatting characters out; arrows and symbols in,
            # DejaVu has them.
            if code < 0x20 or code in (0x7F,):
                continue
        if 0x1F000 <= code <= 0x1FAFF or 0x2600 <= code <= 0x27BF or code in (0xFE0F, 0x200D):
            continue
        kept.append(char)
    return "".join(kept)


def draw_cast_card(payload, mascot_path, height=HEIGHT):
    card = Card(mascot_path, height)
    username = payload.get("username")
    handle = f"@{username}" if username else f"fid {payload.get('fid', '')}".strip()
    card.text("fiddy", (PAD_LEFT, 74), card.bold[40], ACCENT)
    card.text(f"{handle} · a cast", (PAD_LEFT, 136), card.regular[26], DIM)

    text = payload.get("text") or ""
    if text.strip():
        lines = card.wrap(text, card.bold[54], TEXT_WIDTH, 4)
        y = 210
        for line in lines:
            card.text(line, (PAD_LEFT, y), card.bold[54], INK)
            y += 64
    else:
        card.text(
            f"{handle} cast, with no words",
            (PAD_LEFT, 216),
            card.bold[54],
            INK,
        )

    card.text("fiddy.fun", (PAD_LEFT, HEIGHT - 78), card.regular[26], DIM)
    return card.image


def draw_profile_card(payload, mascot_path, height=HEIGHT):
    card = Card(mascot_path, height)
    username = payload.get("username")
    handle = f"@{username}" if username else f"fid {payload.get('fid', '')}".strip()
    card.text("fiddy", (PAD_LEFT, 74), card.bold[40], ACCENT)
    card.text(f"{handle} · a profile", (PAD_LEFT, 136), card.regular[26], DIM)

    name = payload.get("displayName") or handle
    lines = card.wrap(name, card.bold[62], TEXT_WIDTH, 2, max_chars=80)
    y = 206
    for line in lines:
        card.text(line, (PAD_LEFT, y), card.bold[62], INK)
        y += 72

    bio = payload.get("bio") or ""
    if bio.strip():
        bio_lines = card.wrap(bio, card.regular[30], TEXT_WIDTH, 3, max_chars=240)
        y += 8
        for line in bio_lines:
            card.text(line, (PAD_LEFT, y), card.regular[30], SOFT)
            y += 42

    card.text("fiddy.fun", (PAD_LEFT, HEIGHT - 78), card.regular[26], DIM)
    return card.image


def draw_look_card(payload, mascot_path, height=HEIGHT):
    """A shared look, drawn IN THE LOOK'S OWN COLOURS.

    This card is the one thing upstream's theme card cannot be: a picture of the
    thing itself. The ground is the look's background, the panel its card, the
    type its ink, the dot its accent — and the row of swatches is the palette a
    reader can compare against the card they were sent.

    The mascot still is deliberately NOT on this card. It is drawn for
    #161715 with a chartreuse glow behind it (see `Card._glow`), and pasting
    that onto a light look would put a dark ground's art on someone's cream
    page — the one thing a card about a palette must not do. The palette is the
    subject here, so the palette is what is drawn.
    """
    palette = payload.get("palette") or {}

    def colour(key, fallback):
        value = palette.get(key)
        if isinstance(value, str) and len(value) == 7 and value.startswith("#"):
            try:
                return tuple(int(value[i : i + 2], 16) for i in (1, 3, 5))
            except ValueError:
                return fallback
        return fallback

    bg = colour("bg", BG)
    card_colour = colour("card", (0x1D, 0x1E, 0x1C))
    ink = colour("ink", INK)
    muted = colour("muted", DIM)
    accent = colour("accent", ACCENT)
    line = colour("line", card_colour)
    like = colour("like", accent)
    recast = colour("recast", accent)

    radius = max(0, min(int(payload.get("round") or 18), 40))
    border = max(0, min(int(payload.get("borderWidth") or 1, ), 4))

    image = Image.new("RGB", (WIDTH, height), bg)
    draw = ImageDraw.Draw(image)
    offset = (height - HEIGHT) // 2
    bold = {
        size: ImageFont.truetype(font_path("bold"), size) for size in (40, 62, 30)
    }
    regular = {
        size: ImageFont.truetype(font_path("regular"), size) for size in (26, 30)
    }

    # The panel: a look's own card colour, its own corners, its own edges.
    draw.rounded_rectangle(
        [PAD_LEFT - 44, 62 + offset, WIDTH - 68, HEIGHT - 62 + offset],
        radius=radius * 2,
        fill=card_colour,
        outline=line,
        width=border,
    )

    draw.text((PAD_LEFT, 108 + offset), "fiddy", font=bold[40], fill=accent)
    draw.text((PAD_LEFT + 132, 122 + offset), "· a look", font=regular[26], fill=muted)

    name = payload.get("name") or "A look for Fiddy"
    kept = keep_glyphs(" ".join(str(name).split())[:60])
    lines = wrap_text(draw, kept, bold[62], TEXT_WIDTH + 220, 1)
    draw.text((PAD_LEFT, 196 + offset), lines[0] if lines else kept, font=bold[62], fill=ink)

    draw.text(
        (PAD_LEFT, 292 + offset),
        "colours, corners and type — put it on in one press",
        font=regular[30],
        fill=muted,
    )

    # The palette, as the object it is: one swatch per token a look carries.
    swatch_y = HEIGHT - 214 + offset
    swatch = 84
    gap = 18
    swatches = [
        ("bg", bg),
        ("card", card_colour),
        ("ink", ink),
        ("muted", muted),
        ("accent", accent),
        ("like", like),
        ("recast", recast),
        ("line", line),
    ]
    x = PAD_LEFT
    for _token, colour_value in swatches:
        draw.rounded_rectangle(
            [x, swatch_y, x + swatch, swatch_y + swatch],
            radius=max(6, radius),
            fill=colour_value,
            outline=muted,
            width=1,
        )
        x += swatch + gap

    draw.text(
        (PAD_LEFT, HEIGHT - 96 + offset),
        f"fiddy.fun/look/{payload.get('id', '')}",
        font=regular[26],
        fill=muted,
    )
    return image


def wrap_text(draw, value, font, max_width, max_lines):
    """The same greedy wrap the Card class uses, for the standalone card."""
    words = value.split(" ") if value else []
    lines = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if draw.textlength(candidate, font=font) <= max_width or not current:
            current = candidate
            continue
        lines.append(current)
        current = word
        if len(lines) == max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    return lines


def main():
    payload = json.load(sys.stdin)
    mascot_path = os.environ.get("FIDDY_MASCOT_PATH", "fiddy-mark-poster.png")
    if not os.path.exists(mascot_path):
        raise SystemExit(f"no mascot at {mascot_path}")
    kind = payload.get("kind")
    height = MINI_APP_HEIGHT if payload.get("aspect") == "3x2" else HEIGHT
    if kind == "cast":
        image = draw_cast_card(payload, mascot_path, height)
    elif kind == "profile":
        image = draw_profile_card(payload, mascot_path, height)
    elif kind == "look":
        image = draw_look_card(payload, mascot_path, height)
    else:
        raise SystemExit(f"unknown card kind: {kind!r}")
    image.save(sys.stdout.buffer, format="PNG", optimize=True)


if __name__ == "__main__":
    main()