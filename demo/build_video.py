#!/usr/bin/env python3
"""Build the demo video: plates + timeline + narration -> narrated, subtitled MP4.

Camera movement is float-accurate crop+resize on the static plates (Pillow
LANCZOS with float box), which measured 90/90 distinct frames vs 13/90 for
ffmpeg crop+scale quantization. Encode + subtitle burn-in use ffmpeg-full
(libass). Cuts are hard cuts at scene boundaries from timeline.jsonl.
"""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf
from PIL import Image

FPS = 24
W, H = 1920, 1080
GAP = 0.45          # seconds between narration sentences
LEAD = 0.8          # silence before a scene's first sentence
SCENES = ["intro", "flow", "situations", "skill", "run", "results", "fix"]
FFMPEG = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
FONTS = "/Users/nicolas/Library/Fonts"

# Camera plans: (width_fraction, top_y_fraction). x is centered; height is derived
# so the crop is exactly 16:9 in pixels. Width never drops below 0.88: the terminal
# content is wide and left-aligned, so horizontal cropping clips words.
# (from_w, from_y) -> (to_w, to_y), eased.
PLANS = {
    "intro":   ((0.957, 0.00), (0.90, 0.05)),
    "flow":    ((0.957, 0.00), (0.88, 0.20)),
    "situations": ((0.957, 0.00), (0.90, 0.14)),
    "skill":   ((0.957, 0.05), (0.91, 0.10)),
    "run":     ((0.957, 0.00), (0.92, 0.03)),
    "results": ((0.957, 0.08), (0.89, 0.22)),
    "fix":     ((0.91, 0.10), (0.957, 0.01)),
}
# used for any scene without its own plan
DEFAULT_PLAN = ((0.957, 0.00), (0.90, 0.08))


def ease(t: float) -> float:
    return 0.5 - 0.5 * np.cos(np.pi * min(1.0, max(0.0, t)))


def lerp_rect(plan, t: float, pw: int, ph: int) -> tuple:
    """Return a float pixel box (x0, y0, x1, y1) for plate size pw x ph.

    The plate is 2400x1292 (ratio 1.857). A 16:9 crop must fit inside it, so the
    maximum usable width is ph*16/9 (2297 px) — cropping wider than that would
    either stretch or push content off-frame. Terminal text starts at x=0, so the
    crop is pinned to the left edge, never centered.
    """
    (w0, y0f), (w1, y1f) = plan
    e = ease(t)
    max_w = ph * 16 / 9
    wf = min(w0 + (w1 - w0) * e, max_w / pw)
    yf = y0f + (y1f - y0f) * e
    w = wf * pw
    h = w * 9 / 16
    x = 0.0
    # keep the title bar visible: never crop below 4% of the plate height
    y = min(max(yf * ph, 0.0), min(ph - h, ph * 0.04))
    if y < 0:
        y = 0.0
    return (x, y, x + w, y + h)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--render-dir", type=Path, required=True, help="render_cast output")
    ap.add_argument("--timeline", type=Path, required=True, help="timeline.jsonl from the TUI")
    ap.add_argument("--segments", type=Path, required=True, help="narration segments.json")
    ap.add_argument("--max", action="append", default=[], help="scene=seconds cap (time-lapses longer scenes)")
    ap.add_argument("--from", action="append", default=[], help="scene=cast_seconds to start that scene later (e.g. skip a blocked stage)")
    ap.add_argument("--outdir", type=Path, default=Path(__file__).parent / "out")
    args = ap.parse_args()
    caps = {}
    for m in args.max:
        k, v = m.split("=", 1)
        caps[k] = float(v)
    froms = {}
    for m in getattr(args, "from"):
        k, v = m.split("=", 1)
        froms[k] = float(v)
    (args.outdir / "frames").mkdir(parents=True, exist_ok=True)

    periods = json.loads((args.render_dir / "periods.json").read_text())
    total_cast: float = periods["total"]
    tl = [json.loads(l) for l in args.timeline.read_text().splitlines() if l.strip()]

    # map timeline scene changes to cast time: the first STABLE state change (>=1s)
    # at/after t-0.6; transient states (<1s) are render flashes, not scenes
    starts = [(p["start"], p["end"] - p["start"]) for p in periods["periods"]]
    scene_at: dict[str, float] = {}
    for e in tl:
        if e["scene"] in SCENES and e["scene"] not in scene_at:
            t_cast = e["t"] + 0.15  # app starts ~0.15s after rec start
            cands = [s for s, dur in starts if s >= t_cast - 0.6 and dur >= 1.0]
            scene_at[e["scene"]] = min(cands) if cands else 0.0
    scene_at = {k: scene_at[k] for k in SCENES if k in scene_at}
    for k, v in froms.items():
        if k in scene_at:
            scene_at[k] = max(scene_at[k], v)
    if len(scene_at) < len(SCENES):
        missing = [s for s in SCENES if s not in scene_at]
        raise SystemExit(f"timeline missing scenes: {missing}; have {scene_at}")

    # scene windows [start, end); the last ends at cast end
    order = sorted(scene_at.items(), key=lambda kv: kv[1])
    windows = []
    for i, (name, s) in enumerate(order):
        e = order[i + 1][1] if i + 1 < len(order) else total_cast
        windows.append({"scene": name, "v0": s, "v1": e})

    segs = json.loads(args.segments.read_text())
    # Scene durations are narration-driven: hold the (static) plate as long as the
    # scene's speech needs, but never shorter than the recorded TUI window.
    # The run scene stays LIVE: cast time is mapped into its window so the cards
    # update on screen while the narrator talks.
    sr = 24000
    need: dict[str, float] = {}
    for s in segs:
        need[s["scene"]] = need.get(s["scene"], 0.0) + s["dur"] + GAP
    for wdw in windows:
        cast_dur = wdw["v1"] - wdw["v0"]
        target = need.get(wdw["scene"], 0.0) + LEAD + 1.2
        wdw["dur"] = min(max(cast_dur, target), max(caps.get(wdw["scene"], 0.0), target))
        # video shorter than the recorded span -> compress (time-lapse) the states
        wdw["timelapse"] = wdw["dur"] < cast_dur - 0.01
    acc = 0.0
    for wdw in windows:
        wdw["vstart"] = acc  # where this scene starts on the VIDEO timeline
        acc += wdw["dur"]
    video_dur = acc
    n_frames = int(round(video_dur * FPS))
    # The audio track is exactly as long as the rendered frames: a longer master
    # would leave the picture frozen on the last frame while speech keeps going.
    audio_dur = n_frames / FPS

    # master audio: sentences placed sequentially inside each (extended) scene window
    master = np.zeros(int(round(audio_dur * sr)), dtype=np.float32)
    speech_at = {}
    speech_end = 0.0
    for wdw in windows:
        t = wdw["vstart"] + LEAD
        for s in [x for x in segs if x["scene"] == wdw["scene"]]:
            speech_at[id(s)] = t
            audio, asr = sf.read(args.segments.parent / s["wav"], dtype="float32")
            assert asr == sr, f"{s['wav']} sr={asr}"
            i0 = int(t * sr)
            if i0 + len(audio) > len(master):
                raise SystemExit(f"speech at {t:.2f}s overruns the {audio_dur:.2f}s video: {s['wav']}")
            master[i0:i0 + len(audio)] += audio
            speech_end = max(speech_end, t + len(audio) / sr)
            t += s["dur"] + GAP
    if speech_end > audio_dur:
        raise SystemExit(f"last speech ends at {speech_end:.2f}s but the video is {audio_dur:.2f}s")

    # subtitles (sentence level, ASS)
    ass = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "",
           "[V4+ Styles]",
           "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
           "Style: Narr,JetBrainsMono Nerd Font,44,&H00F2F2F2,&H000000FF,&H00101418,&H8C101418,-1,0,0,0,100,100,0,0,3,14,0,2,80,80,46,1",
           "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]

    def ts(t: float) -> str:
        cs = max(0, int(round(t * 100)))
        return f"{cs // 360000:01d}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"

    for wdw in windows:
        for s in [x for x in segs if x["scene"] == wdw["scene"]]:
            t0 = speech_at[id(s)]
            ass.append(f"Dialogue: 0,{ts(t0)},{ts(t0 + s['dur'] + 0.25)},Narr,,0,0,0,,{s.get('subtitle', s['text'])}")
    ass_path = args.outdir / "subs.ass"
    ass_path.write_text("\n".join(ass) + "\n")

    # master audio wav
    sf.write(args.outdir / "master.wav", master, sr)

    # frames -> ffmpeg stdin
    plates: dict[int, Image.Image] = {}
    enc = subprocess.Popen(
        [FFMPEG, "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
         "-i", str(args.outdir / "master.wav"),
         "-vf", f"subtitles={ass_path}:fontsdir={FONTS}",
         "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
         str(args.outdir / "skill-eval-demo.mp4")],
        stdin=subprocess.PIPE)

    def plate_for(state: int) -> Image.Image:
        if state not in plates:
            plates[state] = Image.open(args.render_dir / f"states/state_{state:04d}.png")
        return plates[state]

    def state_at(t_cast: float) -> int:
        cur = periods["periods"][0]["state"]
        for p in periods["periods"]:
            if p["start"] <= t_cast:
                cur = p["state"]
            else:
                break
        return cur

    for i in range(n_frames):
        t = i / FPS
        for wdw in windows:
            if t < wdw["vstart"] + wdw["dur"] or wdw is windows[-1]:
                break
        local = t - wdw["vstart"]
        frac = local / wdw["dur"]
        if wdw["timelapse"]:
            cast_t = (local / wdw["dur"]) * (wdw["v1"] - wdw["v0"] - 0.05)
        else:
            cast_t = min(local, wdw["v1"] - wdw["v0"] - 0.05)
        plate = plate_for(state_at(wdw["v0"] + max(0.0, cast_t)))
        box = lerp_rect(PLANS[wdw["scene"]], frac, *plate.size)
        crop = plate.resize((W, H), Image.LANCZOS, box=box)
        enc.stdin.write(crop.tobytes())
        if i % 240 == 0:
            print(f"frame {i}/{n_frames} scene={wdw['scene']} t={t:.1f}s")
    enc.stdin.close()
    rc = enc.wait()
    if rc != 0:
        raise SystemExit(f"ffmpeg rc={rc}")
    print(f"video: {args.outdir / 'skill-eval-demo.mp4'} ({video_dur:.1f}s @ {FPS}fps, {n_frames} frames)")


if __name__ == "__main__":
    main()
