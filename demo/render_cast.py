#!/usr/bin/env python3
"""Render an asciinema v3 .cast into static screen plates + time periods.

Replays the terminal stream through pyte, snapshots the screen state whenever it
changes, and writes:
  <outdir>/states/state_NNNN.png   full-resolution plate of each distinct state
  <outdir>/periods.json            [{state, start, end}] in cast seconds

Design: plates are rendered at 2400x1292 (cell 20x34, JetBrains Mono 32) so the
video compositor can pan/zoom with float-accurate crops down to 1920x1080.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

FONT_PATH = next(Path("/Users/nicolas/Library/Fonts").glob("JetBrainsMonoNerdFont-Regular.ttf")) \
    or next(Path("/Users/nicolas/Library/Fonts").glob("JetBrainsMonoNerdFont*.ttf"))
FONT_BOLD = next(Path("/Users/nicolas/Library/Fonts").glob("JetBrainsMonoNerdFont-Bold.ttf"), FONT_PATH)
CELL_W, CELL_H, SIZE = 20, 34, 32

DEFAULT_FG = (204, 208, 216)
DEFAULT_BG = (13, 16, 24)

# pyte 256-color table (same values pyte uses); token -> rgb
from pyte.graphics import FG_BG_256  # noqa: E402

NAMED = {
    "black": (0, 0, 0), "red": (205, 49, 49), "green": (13, 188, 121),
    "brown": (229, 229, 16), "yellow": (229, 229, 16), "blue": (36, 114, 200),
    "magenta": (188, 63, 188), "cyan": (17, 168, 205), "white": (229, 229, 229),
    "default": DEFAULT_FG,
    "brightblack": (102, 102, 102), "brightred": (241, 76, 76),
    "brightgreen": (35, 209, 139), "brightyellow": (245, 245, 67),
    "brightblue": (59, 142, 234), "brightmagenta": (214, 112, 214),
    "brightcyan": (41, 184, 219), "brightwhite": (255, 255, 255),
}
NAME_TO_INDEX = None  # pyte >=0.8 stores direct-color/256 tokens as hex strings

HEX_RE = None


def color(token: str | None, bold: bool, is_fg: bool) -> tuple[int, int, int]:
    if token is None or token == "default":
        c = DEFAULT_FG if is_fg else DEFAULT_BG
    elif token in NAMED:
        c = NAMED[token]
    elif isinstance(token, str) and len(token) == 6 and all(ch in "0123456789abcdefABCDEF" for ch in token):
        c = hex2rgb(token)
    elif isinstance(token, str) and token.isdigit() and int(token) < len(FG_BG_256):
        c = hex2rgb(FG_BG_256[int(token)])
    else:
        c = DEFAULT_FG if is_fg else DEFAULT_BG
    if bold and is_fg:
        c = tuple(min(255, v + 40) for v in c)
    return c


def hex2rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def render(screen: pyte.Screen, fonts: dict) -> Image.Image:
    w, h = screen.columns * CELL_W, screen.lines * CELL_H
    img = Image.new("RGB", (w, h), DEFAULT_BG)
    d = ImageDraw.Draw(img)
    for y in range(screen.lines):
        for x in range(screen.columns):
            ch = screen.buffer[y][x]
            text = ch.data or " "
            bg = color(ch.bg, False, False)
            if ch.reverse:
                fg, bg = bg, color(ch.fg, ch.bold, True)
            else:
                fg = color(ch.fg, ch.bold, True)
            if bg != DEFAULT_BG:
                d.rectangle([x * CELL_W, y * CELL_H, (x + 1) * CELL_W - 1, (y + 1) * CELL_H - 1], fill=bg)
            if text.strip():
                f = fonts["bold"] if ch.bold else fonts["regular"]
                d.text((x * CELL_W, y * CELL_H + (CELL_H - SIZE) // 2), text, font=f, fill=fg)
    return img


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cast", type=Path)
    ap.add_argument("outdir", type=Path)
    ap.add_argument("--fps", type=float, default=24.0, help="sampling rate for state changes")
    args = ap.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)
    (args.outdir / "states").mkdir(exist_ok=True)

    lines = args.cast.read_text(errors="replace").splitlines()
    header = json.loads(lines[0])
    cols, rows = header["term"]["cols"], header["term"]["rows"]
    # asciinema v3: each event is [delta_seconds, type, data] in chronological file
    # order; deltas accumulate to wall time. 'x' is the exit record (exit code).
    events = []
    t = 0.0
    for ln in lines[1:]:
        try:
            e = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if isinstance(e, list) and len(e) >= 3:
            t += float(e[0])
            if e[1] == "o":
                events.append((t, e[2]))
    total = events[-1][0] if events else 0.0

    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    fonts = {"regular": ImageFont.truetype(str(FONT_PATH), SIZE),
             "bold": ImageFont.truetype(str(FONT_BOLD), SIZE)}

    step = 1.0 / args.fps
    periods: list[dict] = []
    seen: dict[str, int] = {}
    state = -1
    last_t = 0.0
    sample = 0.0
    ei = 0
    cur_hash = None

    def feed(data: str) -> None:
        # pyte has no alternate-screen buffer (CSI ?1049h/l): Textual apps would
        # paint over the pre-TUI screen. Treat the switch as a full reset;
        # Textual's next full repaint keeps us in sync with its diffs.
        for part in re.split(r"(\x1b\[\?1049[hl])", data):
            if part in ("\x1b[?1049h", "\x1b[?1049l"):
                screen.reset()
            elif part:
                stream.feed(part.encode("utf-8", "replace"))

    while sample <= total + step:
        while ei < len(events) and events[ei][0] <= sample:
            feed(events[ei][1])
            last_t = events[ei][0]
            ei += 1
        blob = "".join((screen.buffer[y][x].data or " ") + f"{screen.buffer[y][x].fg}{screen.buffer[y][x].bg}{screen.buffer[y][x].bold}"
                       for y in range(rows) for x in range(cols))
        hsh = hashlib.md5(blob.encode()).hexdigest()
        if hsh != cur_hash:
            cur_hash = hsh
            if hsh not in seen:
                seen[hsh] = len(seen)
                render(screen, fonts).save(args.outdir / f"states/state_{seen[hsh]:04d}.png")
            state = seen[hsh]
            periods.append({"state": state, "start": round(last_t, 3)})
        sample += step
    # close periods at total
    closed = []
    for i, p in enumerate(periods):
        p["end"] = round(periods[i + 1]["start"] if i + 1 < len(periods) else total, 3)
        if p["end"] > p["start"]:
            closed.append(p)
    (args.outdir / "periods.json").write_text(json.dumps({"total": total, "periods": closed}, indent=1))
    print(f"states={len(seen)} periods={len(closed)} duration={total:.1f}s -> {args.outdir}")


if __name__ == "__main__":
    main()
