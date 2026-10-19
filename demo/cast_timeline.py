#!/usr/bin/env python3
"""Turn an asciinema cast into the scene timeline build_video.py expects.

The walkthrough prints a marker line when it starts a new step:

    ### <scene> :: <title>          (current format)
    ### <n>. <title>                (older format; n maps through --map)

Each marker's first appearance on screen gives the cast time where the scene
starts, which is written as timeline.jsonl (one {"scene", "t"} per line).
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pyte

# number -> scene, for the older "### N. title" markers
DEFAULT_MAP = {
    "0": "intro", "1": "preflight", "2": "situations", "3": "lint",
    "4": "run", "5": "receipts", "6": "receipts", "7": "receipts",
    "8": "fix", "9": "fix", "10": "fix", "11": "fix",
}

MARKER = re.compile(r"^###\s+(?:(\w+)\s+::\s+)?(?:(\d+)\.)?\s*(.*)$")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cast", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--map", type=Path, default=None, help="JSON map of number -> scene")
    args = ap.parse_args()

    num_map = dict(DEFAULT_MAP)
    if args.map:
        num_map.update(json.loads(args.map.read_text()))

    lines = args.cast.read_text(errors="replace").splitlines()
    header = json.loads(lines[0])
    cols, rows = header["term"]["cols"], header["term"]["rows"]
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

    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    found: list[dict] = []
    seen_markers: set[str] = set()
    ei = 0
    last_t = 0.0
    step = 0.25
    sample = 0.0
    total = events[-1][0] if events else 0.0
    while sample <= total + step:
        while ei < len(events) and events[ei][0] <= sample:
            stream.feed(events[ei][1].encode("utf-8", "replace"))
            last_t = events[ei][0]
            ei += 1
        for line in screen.display:
            m = MARKER.match(line.strip())
            if not m:
                continue
            scene = m.group(1) or num_map.get(m.group(2) or "")
            if not scene:
                continue
            key = f"{scene}::{m.group(3)}"
            if key in seen_markers:
                continue
            seen_markers.add(key)
            found.append({"scene": scene, "t": round(last_t, 3), "title": m.group(3)})
        sample += step

    args.out.write_text("".join(json.dumps(f) + "\n" for f in found))
    for f in found:
        print(f"{f['t']:8.2f}s  {f['scene']:12s} {f['title']}")


if __name__ == "__main__":
    main()
