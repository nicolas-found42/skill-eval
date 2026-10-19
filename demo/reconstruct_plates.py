#!/usr/bin/env python3
"""Reconstruct the demo's terminal plates from the rendered MP4.

The original plates (pyte renderings of an asciinema cast) and the cast itself
are gone, but the camera transform is deterministic: build_video.py resizes a
2400x1292 plate through a float crop box onto a 1920x1080 frame.  Inverting
that transform recovers the plate for every frame, which lets the video be
re-rendered with fixed captions.

Emits a render dir (states/*.png + periods.json) and a timeline.jsonl that
build_video.py consumes exactly as it consumes the original ones.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from build_video import FPS, GAP, H, LEAD, PLANS, SCENES, W, lerp_rect  # noqa: E402

PLATE_W, PLATE_H = 2400, 1292
FFMPEG = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
KEEP = 12  # frames kept per state, per kind


def read_ass(path: Path) -> list[tuple[float, float, str]]:
    out = []
    for line in path.read_text().splitlines():
        if not line.startswith("Dialogue:"):
            continue
        p = line.split(",", 9)
        out.append((to_s(p[1]), to_s(p[2]), p[9]))
    return out


def to_s(x: str) -> float:
    h, m, rest = x.split(":")
    return int(h) * 3600 + int(m) * 60 + float(rest)


def subtitle_box(text: str) -> tuple[int, int, int, int]:
    """Approximate the burned-in caption box in frame pixels: (x0, y0, x1, y1)."""
    max_chars = (W - 160) // 26  # 44px JetBrainsMono -> ~26px advance
    lines = [text[i : i + max_chars] for i in range(0, len(text), max_chars)] or [""]
    line_h = 53
    width = int(max(len(l) for l in lines) * 26.4) + 12
    bottom = H - 46
    top = bottom - len(lines) * line_h - 4
    x0 = max(0, (W - width) // 2)
    return x0, max(0, top), min(W, x0 + width), bottom


def scene_plan(segments: list[dict]) -> list[tuple[str, float, float]]:
    """Scene start/duration on the video timeline, as build_video.py computes it."""
    need: dict[str, float] = {}
    for s in segments:
        need[s["scene"]] = need.get(s["scene"], 0.0) + s["dur"] + GAP
    plan, t = [], 0.0
    for name in SCENES:
        dur = need.get(name, 0.0) + LEAD + 1.2
        plan.append((name, t, dur))
        t += dur
    return plan


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", type=Path, required=True)
    ap.add_argument("--segments", type=Path, required=True)
    ap.add_argument("--ass", type=Path, required=True, help="subtitle track of the source video")
    ap.add_argument("--outdir", type=Path, required=True)
    ap.add_argument("--threshold", type=float, default=4.0, help="thumbnail diff that counts as a new state")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=1e9)
    ap.add_argument("--diffs-out", type=Path, default=None)
    args = ap.parse_args()

    segments = json.loads(args.segments.read_text())
    plan = scene_plan(segments)
    captions = read_ass(args.ass)
    total = sum(d for _, _, d in plan)
    print(f"scene plan: {[(n, round(s, 2), round(d, 2)) for n, s, d in plan]}")
    print(f"total {total:.2f}s")

    def scene_at(t: float) -> tuple[str, float]:
        for name, s, d in plan:
            if t < s + d or name == plan[-1][0]:
                return name, (t - s) / d
        raise AssertionError

    cmd = [FFMPEG, "-v", "error", "-i", str(args.video), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=10**8)
    frame_bytes = W * H * 3

    states: list[dict] = []
    cur: dict | None = None
    prev_thumb = None
    idx = 0
    diffs: list[tuple[float, float]] = []
    while True:
        buf = proc.stdout.read(frame_bytes)
        if len(buf) < frame_bytes:
            break
        t = idx / FPS
        if t < args.start:
            idx += 1
            continue
        if t > args.end:
            break
        name, frac = scene_at(t)
        box = lerp_rect(PLANS[name], frac, PLATE_W, PLATE_H)
        x, y = int(round(box[0])), int(round(box[1]))
        w, h = int(round(box[2] - box[0])), int(round(box[3] - box[1]))
        frame = Image.frombytes("RGB", (W, H), buf)

        cap = None
        for c0, c1, text in captions:
            if c0 <= t < c1:
                cap = subtitle_box(text)
                break

        if cur is None:
            cur = {"start": t, "end": t, "clean": deque(maxlen=KEEP), "dirty": deque(maxlen=KEEP)}
        cur["end"] = t + 1 / FPS

        # inverse camera transform: frame -> plate-space region
        region = np.asarray(frame.resize((w, h), Image.LANCZOS), dtype=np.uint8)

        # state signature in plate space: camera motion is cancelled by the unwarp,
        # so only real content changes show up.  The caption box is masked out.
        sig = np.asarray(Image.fromarray(region).convert("L").resize((480, 270), Image.BILINEAR),
                         dtype=np.float32)
        if cap is not None:
            bx0, by0, bx1, by1 = cap
            cx0, cx1 = int(bx0 / W * 480), int(bx1 / W * 480)
            cy0, cy1 = int(by0 / H * 270), int(by1 / H * 270)
            sig[cy0:cy1, cx0:cx1] = sig.mean()
        if prev_thumb is not None:
            diff = float(np.abs(sig - prev_thumb).mean())
            diffs.append((t, diff))
            if diff > args.threshold:
                states.append(cur)
                cur = {"start": t, "end": t, "clean": deque(maxlen=KEEP), "dirty": deque(maxlen=KEEP)}
        prev_thumb = sig

        if cap is None:
            cur["clean"].append((region, x, y, w, h))
        else:
            band = np.zeros((PLATE_H, PLATE_W), bool)
            bx0, by0, bx1, by1 = cap
            px0 = x + int(round(bx0 / W * w))
            px1 = x + int(round(bx1 / W * w))
            py0 = y + int(round(by0 / H * h))
            py1 = y + int(round(by1 / H * h))
            band[py0:py1, px0:px1] = True
            cur["dirty"].append((region, x, y, w, h, band))
        idx += 1
        if idx % 480 == 0:
            print(f"  frame {idx} scene={name} t={t:.1f}s", flush=True)
    proc.stdout.close()
    proc.wait()
    if cur is not None:
        states.append(cur)
    print(f"{idx} frames, {len(states)} states")

    # diagnostic: where do the big thumbnail jumps land?
    jumps = [(t, d) for t, d in diffs if d > args.threshold]
    print("state starts: " + ", ".join(f"{s['start']:.2f}" for s in states[:40]))
    plan_starts = [round(s, 2) for _, s, _ in plan]
    print(f"plan starts: {plan_starts}")
    print("largest jumps: " + ", ".join(f"{t:.2f}({d:.1f})" for t, d in sorted(jumps, key=lambda v: -v[1])[:12]))
    if args.diffs_out:
        args.diffs_out.write_text(json.dumps([[round(t, 3), round(d, 4)] for t, d in diffs]))
        vals = np.array([d for _, d in diffs])
        print(f"diff series: n={len(vals)} p50={np.percentile(vals,50):.2f} p90={np.percentile(vals,90):.2f} "
              f"p99={np.percentile(vals,99):.2f} max={vals.max():.2f}")

    out_states = args.outdir / "states"
    out_states.mkdir(parents=True, exist_ok=True)
    periods = []
    for si, st in enumerate(states):
        plate = np.zeros((PLATE_H, PLATE_W, 3), np.uint8)
        filled = np.zeros((PLATE_H, PLATE_W), bool)
        for region, x, y, w, h in st["clean"]:
            take = ~filled[y : y + h, x : x + w]
            sub = plate[y : y + h, x : x + w]
            sub[take] = region[take]
            filled[y : y + h, x : x + w] |= take
        for region, x, y, w, h, band in st["dirty"]:
            vis = ~band[y : y + h, x : x + w]
            take = vis & ~filled[y : y + h, x : x + w]
            sub = plate[y : y + h, x : x + w]
            sub[take] = region[take]
            filled[y : y + h, x : x + w] |= take
        if not filled.all():
            # pixels only ever seen under a caption: median of the dirty samples
            samples = []
            for region, x, y, w, h, band in list(st["dirty"])[:8]:
                s = np.full((PLATE_H, PLATE_W, 3), 255, np.uint8)
                s[y : y + h, x : x + w] = region
                samples.append(s)
            if samples:
                med = np.median(np.stack(samples), axis=0).astype(np.uint8)
                plate[~filled] = med[~filled]
        Image.fromarray(plate).save(out_states / f"state_{si:04d}.png")
        periods.append({"state": si, "start": round(st["start"], 3), "end": round(st["end"], 3)})
        print(f"  state {si:04d} {st['start']:7.2f}-{st['end']:7.2f} clean={len(st['clean']):2d} dirty={len(st['dirty']):2d}")

    (args.outdir / "periods.json").write_text(json.dumps({"total": round(total, 3), "periods": periods}, indent=1))
    tl = args.outdir / "timeline.jsonl"
    tl.write_text("".join(json.dumps({"scene": n, "t": round(s + 0.45, 3)}) + "\n" for n, s, _ in plan))
    print(f"wrote {out_states} ({len(periods)} states), {args.outdir / 'periods.json'}, {tl}")


if __name__ == "__main__":
    main()
