#!/usr/bin/env python3
"""Narrate: demo/narration.json -> per-sentence WAVs + segments.json (Kokoro-82M, open weights).

Each scene carries two texts: `text` is what the voice says (spelling may be
tuned for pronunciation, e.g. "A I"), `subtitle` is what the caption shows
(defaults to `text`). Both are split into sentences the same way, so sentence
i of one pairs with sentence i of the other.

--reuse skips synthesis and rebuilds segments.json from the WAVs already on
disk (used when the TTS model is not available).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf


def sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?]) +", text.strip())
    return [p.strip() for p in parts if p.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script", type=Path, default=Path(__file__).parent / "narration.json")
    ap.add_argument("--outdir", type=Path, default=Path(__file__).parent / "out/narration")
    ap.add_argument("--models", type=Path, default=Path(os.environ.get("KOKORO_MODELS", "/tmp/exp/models")))
    ap.add_argument("--reuse", action="store_true", help="reuse existing WAVs, only rewrite segments.json")
    ap.add_argument("--engine", choices=["auto", "kokoro", "say"], default="auto",
                    help="TTS engine: kokoro (local ONNX), say (macOS built-in), auto (kokoro if installed)")
    args = ap.parse_args()
    args.outdir.mkdir(parents=True, exist_ok=True)
    spec = json.loads(args.script.read_text())

    k = None
    engine = "kokoro"
    if not args.reuse:
        if args.engine in ("auto", "kokoro"):
            try:
                from kokoro_onnx import Kokoro
                k = Kokoro(str(args.models / "kokoro-v1.0.int8.onnx"), str(args.models / "voices-v1.0.bin"))
            except Exception:
                if args.engine == "kokoro":
                    raise
        if k is None:
            engine = "say"
    else:
        engine = "say"

    segs = []
    for item in spec["scenes"]:
        spoken = sentences(item["text"])
        shown = sentences(item.get("subtitle", item["text"]))
        if len(spoken) != len(shown):
            raise SystemExit(f"scene {item['scene']}: {len(spoken)} spoken sentences but {len(shown)} subtitle sentences")
        for i, (s, sub) in enumerate(zip(spoken, shown)):
            name = f"{item['scene']}__{i:02d}.wav"
            path = args.outdir / name
            if k is not None:
                samples, sr, _timings = k.create_timed(s, voice=spec["voice"], speed=spec.get("speed", 1.0), lang="en-us")
                sf.write(path, np.asarray(samples), sr)
            elif engine == "say" and not path.exists():
                subprocess.run(["say", "-v", spec.get("say_voice", "Samantha"), "-o", str(path),
                                "--data-format=LEF32@24000", s], check=True)
            if not path.exists():
                raise SystemExit(f"missing {path} (run without --reuse to synthesize it)")
            dur = len(sf.read(path)[0]) / sf.read(path)[1]
            segs.append({"scene": item["scene"], "text": s, "subtitle": sub, "wav": name, "dur": round(dur, 3)})
            print(f"{name}  {dur:5.2f}s  {s[:60]}")
    (args.outdir / "segments.json").write_text(json.dumps(segs, indent=1))
    total = sum(s["dur"] for s in segs)
    print(f"{len(segs)} sentences, {total:.1f}s speech -> {args.outdir}/segments.json")


if __name__ == "__main__":
    main()
