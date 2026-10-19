# Demo tooling research: narrated, subtitled TUI demo

Research date **2026-10-19**. Every claim below is from a primary source (repo README at a pinned tag, source file, official docs page, LICENSE, PyPI/npm/crates metadata, or an HF model card). Versions read are named inline. Anything I could not confirm is marked `[UNVERIFIED]`.

Scope: build a TUI dashboard for `skill-eval`, run the `wait-what` skill inside it, record it, narrate it with open-source TTS, and mux an MP4 with synced subtitles — on macOS 27 arm64, no CUDA.

**Machine facts verified on this host (used throughout):**

- ffmpeg **9.0.2_1** (`/opt/homebrew/bin/ffmpeg`, Homebrew `ffmpeg` formula). Has `zoompan`, `crop`, `scale`, `overlay`, `xfade` (58 transitions), `fade`, `tpad`, `concat`, `amix`, `adelay`, `atempo`, `sendcmd`, `signalstats`, `libx264`, `h264_videotoolbox`, `prores`, `libvpx-vp9`. **No `subtitles`, no `ass`, no `drawtext`** — `ffmpeg -h filter=subtitles` → `Unknown filter 'subtitles'.` Homebrew's `ffmpeg` formula declares no `libass`/`freetype`/`fontconfig` dependency; `ffmpeg-full` does (see §4).
- `ffmpeg -f avfoundation -list_devices true` lists `[4] Capture screen 0`, so screen capture via ffmpeg is available.
- Fonts installed: `JetBrainsMono Nerd Font`, `JetBrainsMono Nerd Font Mono`, SF Mono, Menlo. `macOS screencapture -v/-V` supports video capture to a file.
- Python 3.13.16 (pillow present, no numpy/torch), Node v24.22.0, Bun 1.4.3.
- Pillow benchmark on this host: 30 frames of 4K→1080p `Image.transform(AFFINE, BICUBIC)` in **1.37 s ≈ 22 fps**, so a scripted camera is cheap in pure Python (measured here, not a doc claim).

---

# Summary and recommended stack

One pipeline, end to end, with a named fallback per slot. Every install command is the exact line from the primary doc.

| Slot | Primary | Install (verbatim from primary doc) | License | macOS arm64 caveat |
|---|---|---|---|---|
| TUI framework | **Textual 8.2.8** (Python) | `pip install textual textual-dev` — https://github.com/Textualize/textual/blob/v8.2.8/README.md | MIT | Needs Python ≥3.9,<4 (`textual` 8.2.8 PyPI metadata). Drags in Rich + markdown-it-py, all pure Python. |
| Recorder | **`asciinema` 3.2.1 `rec` headless** → `.cast` | `brew install asciinema` — https://github.com/asciinema/asciinema/blob/v3.2.1/README.md | GPL-3.0 | Records a **real running process** through a PTY (`--command`, `--headless`, `--window-size COLSxROWS`), which is what we need for a real eval run. |
| Cast → frames | **`agg` 1.9.0** cannot do this; use **`tui-test` 0.1.0** or asciinema + own renderer | `brew tap microsoft/tui-test https://github.com/microsoft/tui-test` + `brew install tui-test` — https://github.com/microsoft/tui-test/blob/main/README.md | MIT | `agg` outputs **GIF only** (`GifEncoder`, `output_filename`, `.gif` in `src/main.rs`), so it cannot feed an H.264 pipeline at 1080p. `tui-test record start x.mp4 --fps 60` emits MP4/PNG directly. |
| TTS | **Kokoro-82M via `kokoro-onnx` 0.6.1** | `pip install -U kokoro-onnx soundfile` — https://github.com/thewh1teagle/kokoro-onnx/blob/main/README.md | MIT code / Apache-2.0 weights | **Word/phoneme timestamps come free** (`create_timed()`), no torch. 326 MB fp32 / 114 MB int8 ONNX + 21 MB onnxruntime. |
| TTS fallback | **Piper 1.8.0** (`piper-tts`) | `pip install piper-tts` — https://github.com/OHF-Voice/piper1-gpl/blob/main/README.md | GPL-3.0 code, per-voice weights | Phoneme alignments are experimental and need an ONNX patch (`piper.patch_voice_with_alignment`). GPL-3.0 is fine for internal video, not for redistributing a bundled app. |
| Aligner / subtitles | **Kokoro's own phoneme timings → word timings → ASS** | no extra model | — | Because timings are model-internal (duration predictor), there is no ASR drift and no second model. Fallback below. |
| Aligner fallback | **whisper.cpp 1.9.5** forced alignment | `brew install whisper-cpp` — https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/README.md | MIT | `-ojf` writes per-token `t0/t1` offsets (`offsets.from`), `-ml 1` gives word-level segments, `-owts` writes a karaoke script. Core ML/Metal on Apple Silicon is first-class. |
| Compositor | **Pillow frame renderer → ffmpeg encoder** (`Image.resize(size, LANCZOS, box=(float,…))`, raw `rgb24` pipe, `libx264`) | already installed: `pip install pillow` + `brew install ffmpeg` | MIT-CMU / GPL-3.0-or-later (ffmpeg build) | **Measured** float-accurate: 90/90 distinct frames on a slow pan vs 13/90 for `crop`+`scale`; 37.7 ms/frame 4K→1080p; byte-identical re-encodes with `-threads 1`. Burns subtitles without libass. |
| Compositor fallback | **MLT 7.42.0 `melt`** — declarative `.mlt` XML timeline | `brew install mlt` (bottle `arm64_golden_gate`; pulls qt6/pango/opencv, 23 deps) | LGPL-2.1 | Its `subtitle` filter burns **SRT** through Qt6 `qtext` with **no libass**, and `affine` exposes an animatable float `rect`; heavier install. |

**Why this stack is internally consistent.** `asciinema rec --headless --command "python -m skilleval_tui …" --window-size 160x45` produces one `.cast` per take, with exact event timing and a real process behind it. Kokoro's `create_timed()` returns `Timing(phoneme, start, end)` in seconds for the *same* audio file we mux, so subtitles are derived from the voice track itself, not from a second recognizer. The compositor consumes either the `.cast` (re-rendered at 4K by a headless terminal → PNG sequence) or `tui-test`'s MP4, applies camera moves in Pillow at float precision, burns subtitle PNGs with `overlay=…:enable='between(t,a,b)'`, and uses ffmpeg only for `xfade`, audio mixing and `libx264`. Nothing in the chain needs a GPU, CUDA, or a paid account.

**Two hard consequences of the local ffmpeg build** (verify with `ffmpeg -filters | grep -E "subtitles|ass|drawtext"`; on this host it prints nothing):

1. **Camera moves must not be built on `zoompan`/`crop`.** `zoompan` holds one input image for `d` frames and keeps `x`/`y` as `int`; `crop` rounds per-frame offsets with `lrint(d)`. Measured on a static 1080p source at 4 px/s, `crop`+`scale` yielded **13 distinct frames out of 90** (4× supersampling: 48/90) while Pillow's float `box=` yielded **90/90**. Do the transform in Pillow (37.7 ms/frame 4K→1080p, measured) and let ffmpeg only encode (https://ffmpeg.org/ffmpeg-filters.html#zoompan, https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0/libavfilter/vf_crop.c).
2. Subtitle burn-in requires either `ffmpeg-full`, Pillow-rendered PNG overlays, or MLT's `subtitle` filter. `ffmpeg-full` is `keg_only :versioned_formula` and depends on `libass`, `freetype`, `fontconfig`, `harfbuzz`, and configures `--enable-libass --enable-libfreetype --enable-libfontconfig --enable-libharfbuzz` (https://github.com/Homebrew/homebrew-core/blob/master/Formula/f/ffmpeg-full.rb); because it is keg-only it will not shadow `/opt/homebrew/bin/ffmpeg`, so call it by full path or set `PATH` explicitly.

---

# 1. TUI frameworks

Judged on: Node/Python fit for a repo that is Node ≥20 ESM, install friction, rendering quality (truecolor/Unicode/emoji), testability, and whether it can be driven deterministically for recording.

| Name | Repo | Stars | Last release (date) | License | macOS arm64 install | Verdict |
|---|---|---|---|---|---|---|
| **Textual** | https://github.com/Textualize/textual | 37,478 | v8.2.8 (2026-06-30) | MIT | `pip install textual textual-dev` | **Pick.** Screens, Markdown widget, DataTable, SVG screenshot export, headless `run_test()` with `Pilot`, `FileMonitor`. |
| Rich | https://github.com/Textualize/rich | 57,573 | v15.0.0 (2026-04-12) | MIT | `pip install rich` | Rendering primitives only (no app loop, no screens); good for the static "explainer" export, not for live panels. |
| Ink | https://github.com/vadimdemedes/ink | 40,117 | v8.0.0 (2026-10-03) | MIT | `npm install ink react` | Best Node fit, but `^8` requires **Node ≥22** and it has no built-in table/markdown; `ink-testing-library` last published 2024-05-22. |
| OpenTUI | https://github.com/anomalyco/opentui | 13,576 | v0.6.6 (2026-10-14) | MIT | `bun add @opentui/core` (engines: `bun>=1.3.14`, `node>=26.4.0`) | Trendy (Zig core, used by OpenCode) but **requires Node ≥26.4** — host is Node 24, so it fails the install gate. |
| Bubble Tea v2 + Lip Gloss | https://github.com/charmbracelet/bubbletea | 45,450 | v2.1.0 (2026-10-08) | MIT | `go install charm.land/bubbletea/v2@latest` | Excellent renderer, but adds Go to a Node repo and has no markdown component (needs Glamour). |
| Ratatui | https://github.com/ratatui/ratatui | 23,011 | 0.30.2 (2026-06-19) | MIT | `cargo add ratatui` | Best-in-class widgets and `TestBackend`, but Rust build step in a Node repo. |
| blessed | https://github.com/chjj/blessed | 11,889 | 0.1.81 (2015-09-03) | MIT (NOASSERTION label) | `npm i blessed` | Abandoned (last push 2024-03); one row, no. |
| neo-blessed | https://www.npmjs.com/package/neo-blessed | — | 0.2.0 (2018-06-13) | MIT | `npm i neo-blessed` | Fork of a 2015 library, unmaintained. |
| terminal-kit | https://github.com/cronvel/terminal-kit | 3,380 | 3.1.4 (2026-07-19) | MIT | `npm i terminal-kit` | Alive, low-level; no component/test story comparable to Textual. |
| prompt_toolkit | https://github.com/prompt-toolkit/python-prompt-toolkit | 10,599 | 3.0.53 (2026-07-26) | BSD-3-Clause | `pip install prompt_toolkit` | Excellent for prompts and full-screen layouts; weak for data tables/markdown. |
| urwid | https://github.com/urwid/urwid | 3,025 | 4.2.5 (2026-10-05) | LGPL-2.1 | `pip install urwid` | Mature, but LGPL and a 2000s widget model; no built-in markdown. |
| Brick | https://github.com/jtdaugherty/brick | 1,744 | pushed 2026-09-26 | BSD-3-Clause | `cabal install brick` | Haskell; fails the language-fit gate. |
| FTXUI | https://github.com/ArthurSonzogni/FTXUI | 10,817 | pushed 2026-10-18 | MIT | `brew install ftxui` | C++; fails language fit. |
| pi-tui | https://github.com/badlogic/pi-mono (`packages/tui`) | 116,236 (monorepo) | `@earendil-works/pi-tui` 1.3.0 (2026-10-15) | MIT | `npm i @earendil-works/pi-tui` | Node ≥22.19; minimal, has Markdown+Loader components, no table widget, no test harness docs. |
| tui-test (as a *driver*, not a framework) | https://github.com/microsoft/tui-test | 291 | 0.1.0 (2026-10-03) | MIT | `brew tap microsoft/tui-test …&& brew install tui-test` | Not a UI library; included here because it drives/records *any* TUI. |

**Findings**

- Textual ships a first-class Markdown widget built on `markdown_it`, which is the single most important widget for rendering `summary.md`/`analysis.md` verbatim into a dashboard (source: https://github.com/Textualize/textual/blob/v8.2.8/src/textual/widgets/_markdown.py).
- Textual's test harness is the determinism lever: `App.run_test(headless=True, size=(80,24))` yields a `Pilot` with `press()`, `click()`, `pause()`, `resize_terminal()` — a recording can be *replayed* instead of typed (source: https://github.com/Textualize/textual/blob/v8.2.8/src/textual/app.py#L2133 and https://github.com/Textualize/textual/blob/v8.2.8/src/textual/pilot.py).
- Textual can emit an SVG screenshot of the current screen from code (`App.export_screenshot() -> str`, `App.save_screenshot()`), and the command palette has a built-in "Screenshot" system command — useful for building the explainer slides without a recorder at all (source: https://github.com/Textualize/textual/blob/v8.2.8/src/textual/app.py#L1844-L1918).
- Live file watching is in-tree: `textual.file_monitor.FileMonitor(paths, callback)` polls `st_mtime` and calls back on change — exactly what is needed to watch a run folder (`run.json`, `findings.json`, `<scenario>/events.json`) while the eval writes it (source: https://github.com/Textualize/textual/blob/v8.2.8/src/textual/file_monitor.py).
- Any Textual app can also be served to a browser with `textual serve "python -m myapp"`, giving a second, DOM-based capture path (Playwright/CDP) if terminal raster quality disappoints (source: https://textual.textualize.io/guide/devtools/).
- Ink 8.0.0 declares `engines: node >=22`, and its snapshot-testing companion `ink-testing-library` has not shipped since 2024-05-22 — for a demo you script and replay, that is the weakest link of the Node options (source: https://registry.npmjs.org/ink and https://registry.npmjs.org/ink-testing-library).
- OpenTUI is the strongest *new* entrant (Zig core, flexbox, images, used in production by OpenCode) but `@opentui/core@0.6.6` requires **Node ≥26.4.0 / Bun ≥1.3.14**; the host has Node 24.22, so it is a build-gate failure, not a taste judgement (source: https://registry.npmjs.org/@opentui%2Fcore).

**Recommendation:** **Textual 8.2.8.** It is the only candidate that combines a Markdown renderer, tables, progress, screens, an in-tree file watcher, an SVG exporter, and a headless pilot in one MIT package that installs with one `pip` line. Keep the dashboard as a *separate* Python package reading the run folder — the eval stays Node and unchanged.

---

# 2. Terminal recording and rendering to video

Judged on: determinism, scripted keystrokes, 1080p/4K quality, font control, install on macOS arm64, per-frame emission for post-production zoom/pan, and whether it can record a **real** running process.

| Name | Repo | Stars | Last release (date) | License | macOS arm64 install | Verdict |
|---|---|---|---|---|---|---|
| **asciinema CLI** | https://github.com/asciinema/asciinema | 17,890 | v3.2.1 (2026-06-16) | GPL-3.0 | `brew install asciinema` | **Pick.** `rec --headless --command … --window-size 160x45` records a real process; `.cast` is the source of truth for timing. |
| agg | https://github.com/asciinema/agg | 1,730 | v1.9.0 (2026-05-29) | GPL-3.0 | `brew install agg` | **GIF-only** output; cannot produce the 1080p H.264 the deliverable needs. Good for README previews. |
| **VHS** | https://github.com/charmbracelet/vhs | 21,148 | v0.12.1 (2026-09-24) | MIT | `brew install vhs` (needs `ttyd` + `ffmpeg`; also launches headless **Chrome**) | **Pick for scripted takes.** Tape DSL, `Output frames/` PNG sequence, `Screenshot`, themes, window chrome. |
| ttyd | https://github.com/tsl0922/ttyd | 12,519 | 1.7.7 (2024-03-30) | MIT | `brew install ttyd` | Plumbing under VHS, not a recorder itself; stale release. |
| **tui-test** | https://github.com/microsoft/tui-test | 291 | 0.1.0 (2026-10-03) | MIT | `brew tap microsoft/tui-test https://github.com/microsoft/tui-test` then `brew install tui-test` | **Pick for a *real* process with assertions.** Drives an existing TUI, `record start out.mp4 --fps --speed --idle-time-limit`, plus `trace.json`. |
| terminalizer | https://github.com/faressoft/terminalizer | 16,170 | 0.12.0 (2024-08-29) | MIT | `npm i -g terminalizer` | Unmaintained since 2024; WebP/GIF player output. |
| termtosvg | https://github.com/nbedos/termtosvg | 9,756 | archived, pushed 2020-06-16 | BSD-3-Clause | `pipx install termtosvg` | Archived; SVG frames, dead. |
| t-rec | https://github.com/sassman/t-rec-rs | 1,257 | v0.8.2 (2025-12-19) | GPL-3.0 | `brew install t-rec` | Captures the *window*, 4–15 fps via screenshots; not frame-exact. |
| asciinema-automation | https://github.com/PierreMarchand20/asciinema_automation | 34 | pushed 2024-07-28 | `[UNVERIFIED]` | `pip install asciinema-automation` | Types `.cast` files with pauses; superseded by `asciinema rec --command`. |
| xterm.js (headless) | https://github.com/xtermjs/xterm.js | 21,280 | pushed 2026-10-13 | MIT | `npm i @xterm/xterm` | This is what VHS rasterizes; you could drive it with Playwright and `page.screenshot()` at any zoom for exact per-frame output. |
| libvterm | https://github.com/neovim/libvterm | 188 | **archived** 2026-06-19 | MIT | build from source | Archived; unusable as a dependency. |
| pyte | https://github.com/selectel/pyte | 755 | 0.8.2 (2023-11-12) | LGPL-3.0 | `pip install pyte` | Pure-Python VT emulator with 256-color SGR handling — enough to render `.cast` yourself in Pillow at 4K. |
| tmux capture-pane | https://github.com/tmux/tmux | 49,910 | pushed 2026-10-18 | ISC | `brew install tmux` | Text-only snapshots; no color/truecolor fidelity. |
| macOS `screencapture -v` | `man screencapture` | — | OS built-in | — | `screencapture -v -V 20 out.mov` | Records any window exactly as displayed; retimes are non-deterministic. |
| ffmpeg `avfoundation` | https://ffmpeg.org/ffmpeg-devices.html | — | 9.0.2 | GPL build | `ffmpeg -f avfoundation -i "4:none"` | Device `[4] Capture screen 0` verified present; same non-determinism caveat. |

**Findings**

- `asciinema rec` records a **real** command, not a script of keystrokes: `--command "python script.py"`, `--headless` ("without using the terminal for input/output… enabled automatically when running in an environment where a terminal is not available"), `--window-size COLSxROWS`, `--idle-time-limit`, `--return` (source: https://github.com/asciinema/asciinema/blob/v3.2.1/src/cli.rs).
- `agg` **cannot** output MP4: its CLI arg is `/// GIF path/filename`, the encoder is `GifEncoder`, and the default output name is `output.gif` (source: https://github.com/asciinema/agg/blob/v1.9.0/src/main.rs). Treat agg as a README-preview tool only.
- VHS is a tape interpreter over ttyd + headless Chrome + ffmpeg: `VHS` struct fields include `Page *rod.Page`, `browser *rod.Browser`, and `New()` is documented as "sets up ttyd and go-rod for recording frames"; `startBrowser` launches Chrome or downloads one if absent (source: https://github.com/charmbracelet/vhs/blob/v0.12.1/vhs.go).
- VHS captures at a fixed cadence into `frame-text-%05d.png` + `frame-cursor-%05d.png` and then calls ffmpeg; `Output frames/` gives you that PNG sequence directly, which is the cleanest hand-off to a 4K compositor (source: https://github.com/charmbracelet/vhs/blob/v0.12.1/video.go and https://github.com/charmbracelet/vhs/blob/v0.12.1/vhs.go#L653-L716).
- VHS exposes exactly the knobs a demo needs: `Set Framerate`, `Set PlaybackSpeed`, `Set FontFamily/FontSize`, `Set Theme` (named or JSON), `Set Width/Height` **or** `Set Columns/Rows`, `Set Padding/Margin/MarginFill`, `Set WindowBar`, `Set BorderRadius`, `Set CursorBlink`, plus `Hide/Show`, `Wait+Screen`, `Screenshot` (source: https://github.com/charmbracelet/vhs/blob/v0.12.1/README.md).
- VHS 0.12.0 had a real "exits 0, writes no video" bug; it was fixed in **0.12.1** (release notes: "This release fixes https://github.com/charmbracelet/vhs/issues/787"), so pin `>=0.12.1` and assert the output file exists (source: https://github.com/charmbracelet/vhs/releases/tag/v0.12.1 and https://github.com/charmbracelet/vhs/issues/787).
- `tui-test` is the only recorder here that both drives a **real** long-running TUI and emits MP4/PNG with per-frame control: `record start PATH [--format --fps --speed --idle-time-limit --zoom --background --transparent]`, "APNG, GIF, and MP4 recordings capture frames from the session's live emulator", and MP4 requires ffmpeg (source: https://github.com/microsoft/tui-test/blob/main/references/cli.md).
- It also writes `trace.json` + `timeline.json` and an automatic asciinema cast per session (`get-recording`), so the recording session doubles as the evidence trail for the demo (source: https://github.com/microsoft/tui-test/blob/main/README.md).

**Recommendation:** two recorders, two purposes. **VHS** for the scripted explainer beats (tape file in-repo, `Output frames/` at 4K, deterministic re-render). **`asciinema rec --headless`** (optionally driven/asserted by `tui-test`) for the *real* eval run, because that must show a genuine process writing a real run folder. Do **not** build the pipeline on `agg`; it only makes GIFs.

---

# 3. Open-source TTS

Judged on: license for **code and weights** (commercial use), size, macOS arm64 install path, speed, timestamp support, max input length, prosody control.

| Name | Repo | Stars | Last release (date) | License code / weights | macOS arm64 install | Verdict |
|---|---|---|---|---|---|---|
| **Kokoro-82M + kokoro-onnx** | https://github.com/thewh1teagle/kokoro-onnx | 2,791 | PyPI 0.6.1 (2026-08-19); model files v1.1 | MIT / Apache-2.0 | `pip install -U kokoro-onnx soundfile` | **Primary.** Phoneme timestamps free; no torch. |
| Kokoro-82M (HF card) | https://huggingface.co/hexgrad/Kokoro-82M | 9,461 (code) | weights v1.0 (2025-01-27) | Apache-2.0 / Apache-2.0 | see above | Card explicitly permits commercial deployment. |
| Piper 1.8.0 | https://github.com/OHF-Voice/piper1-gpl | 5,917 | v1.8.0 (2026-09-04) | GPL-3.0 / per-voice | `pip install piper-tts` | **Fallback.** Light, but alignments experimental + GPL. |
| rhasspy/piper (old) | https://github.com/rhasspy/piper | 11,301 | **archived** (2025-08-26) | MIT | — | Dead; README says "Development has moved". |
| F5-TTS | https://github.com/SWivid/F5-TTS | 15,418 | 1.1.22 (2026-07-23) | MIT / **CC-BY-NC-4.0** | `pip install f5-tts` (+torch) | Fails commercial use. |
| StyleTTS2 | https://github.com/yl4579/StyleTTS2 | 6,365 | pushed 2024-08-10 | MIT / custom | `pip install -r requirements.txt` | Stale, non-standard weight terms, no timestamps. |
| XTTS-v2 / Coqui | https://github.com/coqui-ai/TTS | 46,136 | pushed 2024-08-16 | MPL-2.0 / **Coqui PML (non-commercial)** | `pip install TTS` | Fails commercial use. |
| Chatterbox | https://github.com/resemble-ai/chatterbox | 27,069 | v0.1.2 (2025-06-13) | MIT / MIT | `pip install chatterbox-tts` | MIT and good quality, but no timestamp output → needs an aligner anyway. |
| Orpheus-TTS | https://github.com/canopyai/Orpheus-TTS | 6,359 | pushed 2025-12-05 | Apache-2.0 / Apache-2.0 | `pip install orpheus-speech` | vLLM/CUDA path; fails the no-GPU gate. |
| Dia | https://github.com/nari-labs/dia | 19,406 | pushed 2025-11-19 | Apache-2.0 | `pip install git+…` | Dialogue model, wrong register for narration. |
| Parler-TTS | https://github.com/huggingface/parler-tts | 5,587 | pushed 2024-12-10 | Apache-2.0 | `pip install git+…` | 2.2B, heavy, no timestamps. |
| MeloTTS | https://github.com/myshell-ai/MeloTTS | 7,681 | v0.1.2 (2024-12-24) | MIT | `pip install -e .` | Pins old torch; fails Python 3.13 arm64. |
| KittenTTS | https://github.com/KittenML/KittenTTS | 16,166 | 0.8.1 (2026-02-24) | Apache-2.0 / mixed (v2 = "Stellon Labs Community License") | `pip install kittenml` | Tiny/CPU-friendly, no timestamps; license split by version. |
| OuteTTS | https://github.com/edwko/OuteTTS | 1,436 | PyPI 0.4.4 | Apache-2.0 / 0.6B Apache, 1B **CC-BY-NC-SA** | `CMAKE_ARGS="-DGGML_METAL=on" pip install outetts` | README points at CTC forced alignment → no free timings. |
| Sesame CSM | https://github.com/SesameAILabs/csm | 14,727 | pushed 2025-05-27 | Apache-2.0 | `pip install -r requirements.txt` | Research-oriented, gated Llama backbone. |
| Fish Speech | https://github.com/fishaudio/fish-speech | 33,272 | v1.5.1 (2025-05-31) | **Fish Audio Community License** | `pip install fish-speech` | Revenue-capped license; not plain MIT. |
| VibeVoice | https://github.com/microsoft/VibeVoice | 54,870 | pushed 2026-10-08 | MIT repo | — | TTS code removed; "research and development purposes only". |
| VoxCPM | https://github.com/OpenBMB/VoxCPM | 39,557 | 2.0.3 (2026-05-11) | Apache-2.0 | `pip install voxcpm` | README requires CUDA ≥12 for the documented path. |
| mlx-audio | https://github.com/Blaizzy/mlx-audio | 8,060 | v0.5.9 (2026-10-13) | MIT / Apache-2.0 | `pip install mlx-audio` | Good Apple-Silicon runtime, but Kokoro's `generate()` drops token timings. |
| kokoro-js | https://www.npmjs.com/package/kokoro-js | — | 1.2.1 (2025-05-03) | Apache-2.0 | `npm i kokoro-js` | Node-native alternative (used by aidemo at ~2.4× realtime); timestamps `[UNVERIFIED]`. |

**Findings**

- Kokoro's weights are Apache-2.0 and the model card says so explicitly: "With Apache-licensed weights, Kokoro can be deployed anywhere from production environments to personal projects" (source: https://huggingface.co/hexgrad/Kokoro-82M/raw/main/README.md).
- Timestamps are **model-internal**, not ASR-derived: `kokoro-onnx` 0.6.x exposes `create_timed() -> (audio, sample_rate, list[Timing])` where `Timing` is documented as "When a phoneme is spoken, in seconds from the start of the audio", and `timings()` pairs each kept phoneme with the sample span `edges[i]/rate .. edges[i+1]/rate` (source: https://github.com/thewh1teagle/kokoro-onnx/blob/main/src/kokoro_onnx/__init__.py and `src/kokoro_onnx/sliding.py`).
- Those phoneme spans convert to word spans without a model: the vocab includes `' '` as a token, so a space boundary after a phoneme run is a word boundary (source: https://github.com/thewh1teagle/kokoro-onnx/blob/main/src/kokoro_onnx/config.json, 114 entries incl. `" "`, `"."`, `","`).
- `create_timed()` only returns timings when the exported graph has a `duration` output; the model-files-v1.1 release notes state "Every model in this release carries … a duration output, which kokoro-onnx 0.6.0 uses for `create_timed()` timestamps" (source: https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1).
- Runtime weight is small and torch-free: PyPI deps are `espeakng-loader`, `numpy`, `onnxruntime`, `phonemizer`; ONNX graphs are 326 MB fp32 / 164 MB fp16 / 114 MB int8, voices 28 MB (source: https://pypi.org/pypi/kokoro-onnx/0.6.1 and the v1.1 release page).
- Input limits are explicit and matter for subtitles: voices are best on "100-200 tokens out of ~500 possible" and degrade below 10–20 tokens and above 400; the phoneme buffer caps at 510 (source: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md and `src/kokoro_onnx/config.py`). Narrate in one-to-three-sentence chunks and stitch, which also gives natural subtitle breaks.
- Prosody control is limited to `speed` (clamped 0.5–2.0) plus `sentence_pause`/`clause_pause` in `create()`; there is no SSML (source: https://github.com/thewh1teagle/kokoro-onnx/blob/main/src/kokoro_onnx/__init__.py). Plan punctuation-driven pacing, not SSML.
- Piper's alignments exist but are experimental: they require `python3 -m piper.patch_voice_with_alignment model.onnx` or `PiperVoice.load(..., include_alignments=True)` with `onnx` installed, and `docs/VOICES.md` says Piper is "intended for personal use and text to speech research only; we do not impose any additional restrictions on voice models. Some voices may have restrictive licenses" — per-voice `MODEL_CARD` files are authoritative (source: https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/ALIGNMENTS.md and `docs/VOICES.md`). `rhasspy/piper-voices` card metadata says `license: mit`.

**Recommendation:** **Kokoro-82M via `kokoro-onnx` (`af_heart` or `af_sarah`)**. Apache-2.0 on both code and weights with no revenue cap; 114 MB int8 graph; phoneme timings free from the duration predictor, so the subtitle step needs no aligner. Voice choice among `af_*` is a taste call for the human (see open questions). **Fallback: Piper `en_US-lessac-medium`** — same weight class, but GPL-3.0 code and experimental alignment, so only if Kokoro's prosody is rejected.

---

# 4. Subtitles and alignment

Judged on: whether it yields **word** timestamps without a GPU, install weight, and whether its output can be burned on *this* ffmpeg.

| Name | Repo | Stars | Last release (date) | License | macOS arm64 install | Verdict |
|---|---|---|---|---|---|---|
| **Kokoro phoneme timings** | https://github.com/thewh1teagle/kokoro-onnx | 2,791 | 0.6.1 | MIT | in TTS step | **Primary.** Zero extra models; timing is exact by construction. |
| **whisper.cpp** | https://github.com/ggml-org/whisper.cpp | 54,478 | v1.9.5 (2026-10-06) | MIT | `brew install whisper-cpp` | **Fallback.** `-ojf` per-token offsets, `-ml 1` word segments, `-owts` karaoke script; Metal/CoreML first-class. |
| WhisperX | https://github.com/m-bain/whisperX | 24,662 | v3.8.6 (2026-05-25) | BSD-2-Clause | `pip install whisperx` | Word timestamps via wav2vec2, but pulls `torch`, `pyannote-audio`, `torchcodec` — heavy for one narration track. |
| stable-ts | https://github.com/jianfch/stable-ts | 2,281 | **archived** (pushed 2026-05-30) | MIT | `pip install stable-ts` | README: "Development on this repository is indefinitely paused." |
| MFA 3 | https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner | 1,905 | pushed 2026-10-08 | MIT | `conda create -n aligner -c conda-forge montreal-forced-aligner -y` | Best phoneme-level accuracy, but needs conda + Kaldi; overkill. |
| aeneas | https://github.com/readbeyond/aeneas | 2,872 | v1.7.3 (2017-03-16) | AGPL-3.0 | `pip install numpy && pip install aeneas` | Dead since 2017; PyPI sdist only. |
| ctc-forced-aligner | https://github.com/MahmoudAshraf97/ctc-forced-aligner | 570 | v0.2 (2024-06-03) | **BSD-2 code / pyproject says CC-BY-NC 4.0** | `pip install git+…` | License conflict between `LICENSE` and `pyproject.toml`; needs torch. |
| mlx-audio Qwen3-ForcedAligner | https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit | — | 2026-01-29 | Apache-2.0 | `pip install mlx-audio` | New, Apple-Silicon-native word-level alignment (`result[i].start_time`); good plan B for MLX shops. |
| pysubs2 | https://github.com/tkarabela/pysubs2 | — | 1.9.0 (2026-08-16) | MIT | `pip install pysubs2` | Writes SRT/ASS/VTT from Python; ASS `\k` karaoke is spec'd by Aegisub. |

**Findings**

- whisper.cpp gives per-token timings in JSON when asked: `-ojf, --output-json-full [false] include more information in the JSON file`, and the writer emits a `tokens` array per segment with `t0`/`t1` when `mt.data.t0 > -1 && mt.t1 > -1`; `-ml 1` is documented as the word-level switch and `-owts` writes "script for generating karaoke video" (source: https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/cli/README.md and `examples/cli/cli.cpp`).
- whisper.cpp is a first-class Apple-Silicon target ("Apple Silicon first-class citizen - optimized via ARM NEON, Accelerate framework, Metal and Core ML") and Homebrew ships a bottle (`whisper.cpp 1.9.5`), so the fallback is one `brew install` away (source: https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/README.md).
- WhisperX's install is the reason not to use it here: its `pyproject.toml` pins `torch~=2.8.0`, `pyannote-audio>=4.0.0`, `torchcodec`, `transformers`, i.e. multiple GB for a 2-minute narration (source: https://github.com/m-bain/whisperX/blob/v3.8.6/pyproject.toml).
- Karaoke-style ASS is a documented format feature, not a hack: `\k<duration>` in centiseconds per syllable, with `\K`/`\kf` for smooth fill, and `\kt` absolute timing (source: https://aegisub.org/docs/latest/ass_tags/).
- `pysubs2` is the least-friction writer for SRT/ASS/VTT from the same timing structure (MIT; PyPI 1.9.0, requires Python ≥3.12) (source: https://pypi.org/pypi/pysubs2/1.9.0).
- Burn-in is the constraint, not the format: `ffmpeg`'s `subtitles` filter is documented as needing `--enable-libass` plus libavcodec/libavformat, and `ass` is "the same as the subtitles filter, except that it doesn't require libavcodec/libavformat… limited to ASS"; this build has neither (source: https://ffmpeg.org/ffmpeg-filters.html#subtitles and #ass, plus `ffmpeg -h filter=subtitles` → Unknown filter).
- Three working burn paths on this host: (a) `brew install ffmpeg-full` — keg-only, depends on `libass`/`freetype`/`fontconfig`/`harfbuzz` and configures `--enable-libass`, so call `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` explicitly (source: https://github.com/Homebrew/homebrew-core/blob/master/Formula/f/ffmpeg-full.rb); (b) render each cue to a transparent PNG with Pillow and composite with `overlay=…:enable='between(t,a,b)'`, which needs no install and is **measured frame-exact** (13/38/24-frame runs for a 1.5 s window at 30 fps); (c) `melt`'s `subtitle` filter, which burns an SRT through Qt6 `qtext` with no libass (source: https://raw.githubusercontent.com/mltframework/mlt/v7.42.0/src/modules/plus/filter_subtitle.cpp).
- Soft subtitles need nothing new: muxing `-c:s mov_text` into an H.264 MP4 was confirmed to produce both `h264` and `mov_text` streams, so a "player-toggleable subtitles" deliverable is free even with the bare ffmpeg.
- If you check a build, the documented probes are `ffmpeg -filters | grep -E "subtitles|drawtext|ass"` or `ffmpeg -h filter=subtitles`; an empty result means the filter was compiled out (`--enable-libass`/`--enable-libfreetype` absent).
- Timing hygiene: Kokoro's timing is per synthesized chunk; when you mux chunks you must add each chunk's start offset to every `Timing`, which `create_timed` already does internally for its own batches but not across your separate files. Budget for an explicit offset accumulator in the narration script.

**Recommendation:** derive word timings from **Kokoro `create_timed()`**, convert phoneme spans to word spans on space tokens, write **both** `.ass` (with `\k` for optional karaoke highlight) and `.srt` with `pysubs2`, and burn with **Pillow-rendered PNG overlays** on the existing ffmpeg (no install) or `ffmpeg-full`'s `subtitles` filter if a one-line burn is preferred. Keep **whisper.cpp `-ojf`** as the independent verifier: run it once over the final mix and assert that word boundaries agree within ~120 ms, which catches offset bugs the model cannot see.

---

# 5. Programmatic video editing / camera movement

Judged on: scripted zoom/pan/cuts/speed ramps/callouts/subtitles from a timeline file, reproducibility, and whether it consumes a terminal recording. Two claims here are **measured on this host**, not read from docs: frame-to-frame motion fidelity of `zoompan`/`crop`+`scale` vs Pillow, and byte-identical re-encode.

| Name | Repo | Stars | Last release (date) | License | macOS arm64 install | Verdict |
|---|---|---|---|---|---|---|
| **Pillow frame renderer → ffmpeg encoder** | https://github.com/python-pillow/Pillow | 13k | 12.3 (installed) | HPND (MIT-like) | installed; no numpy | **Pick.** `Image.resize(size, LANCZOS, box=(float,…))` gave **90/90** distinct frames on a 4 px/s pan; 37.7 ms/frame 4K→1080p; identical md5 on re-encode with `-threads 1`. |
| **ffmpeg filtergraph (encode/mux stage)** | https://ffmpeg.org/ffmpeg-filters.html | 65,401 (FFmpeg/FFmpeg) | 9.0.2 (2026-09-17) | GPL-3.0-or-later (this build) | already installed | **Pick, but not for camera moves.** `crop`+`scale` produced only **13/90** distinct frames at 4 px/s; `overlay:enable=between()` is frame-exact. No `drawtext`/`subtitles`. |
| **MLT 7.42.0 / `melt`** | https://github.com/mltframework/mlt | 1,866 | v7.42.0 (2026-10-03) | LGPL-2.1 | `brew install mlt` (bottle `arm64_golden_gate`; 23 deps incl. qt6, pango, opencv) | **Fallback.** `subtitle` filter burns SRT via Qt6 `qtext` with no libass; `affine` has an animatable float `rect`. |
| MoviePy 2.2.1 | https://github.com/Zulko/moviepy | 15,005 | v2.2.1 (2025-05-21) | MIT | `pip install moviepy` | Fails clean-install: requires `numpy>=1.25`, pins `pillow<12.0` (host has 12.3). |
| Remotion | https://github.com/remotion-dev/remotion | 65,096 | v4.0.536 (2026-10-16) | **Free only ≤3 employees**, else Company License | `npm i` (bundles `@remotion/compositor-darwin-arm64`) | Reject for a team: LICENSE.md gates by headcount; heavy Chrome-based render. |
| Motion Canvas | https://github.com/motion-canvas/motion-canvas | 19,389 | v3.17.2 (2024-12-14) | MIT | `npm init @motion-canvas` | 2026 commits are docs-only; render driven from the GUI. |
| Revideo | https://github.com/midrender/revideo | 4,120 | 0.11.0 (2026-07-10) | MIT | `npm init @revideo@latest` | Viable TS route, but browser-render determinism and no subtitle-file story. |
| editly | https://github.com/mifi/editly | 5,528 | v0.15.0-rc.1 (2025-01-19) | MIT | `npm i -g editly` | Fails install: `gl` 8.1.6 prebuilds stop at ABI 127/Node 22 (host Node 24 = ABI 137); `canvas` 2.11.2 has no arm64 prebuild. |
| Manim | https://github.com/ManimCommunity/manim | 41,664 | v0.22.0 (2026-10-08) | MIT | `pip install manim` | Needs numpy≥2.1 + moderngl; vector-motion tool, not a footage compositor. |
| OpenCV | https://github.com/opencv/opencv | 91,226 | 5.0.0 (2026-06-06) | Apache-2.0 | `pip install opencv-python` | Hard `numpy>=2` dep; duplicates Pillow with no timeline model. |
| vidpy | https://github.com/antiboredom/vidpy | 132 | pushed 2023-10-12 | GPL-3.0 | `pip install vidpy` + `melt` | Abandoned 2023. |
| Cap | https://github.com/CapSoftware/Cap | 23,410 | cap-v0.6.0 (2026-09-15) | **AGPL-3.0** core (camera/scap crates MIT) | `brew install --cask cap` | JSON project config exists, but only for its own `.cap` captures. |
| OpenScreen (fork) | https://github.com/getopenscreen/openscreen | 4,537 | v2.1.1 (2026-10-17) | MIT | Electron `Openscreen-Mac-arm64-2.1.1.zip` | Only Screen-Studio-alike with a real CLI + `.openscreen` JSON; `--quality good` caps at 1080p; cannot ingest `.cast`. |
| OpenScreen (original) | https://github.com/siddharthvaddem/openscreen | 39,929 | v1.5.0 (2026-06-06) | MIT | — | **Archived**; README redirects to the fork. |
| Recordly | https://github.com/webadderallorg/Recordly | 34,413 | v1.4.0 (2026-09-08) | **AGPL-3.0** | build from source | GUI only: `.recordly` projects, no CLI entry point. |
| ScreenPipe | https://github.com/mediar-ai/screenpipe | 21,983 | app-v2.7.109 (2026-10-14) | NOASSERTION (commercial terms) | brew/zip | Capture + recall, not a compositor. |
| aidemo | https://github.com/tandryukha/aidemo | 16 | v0.15.2 (2026-09-25) | MIT | `npx -y @tandryukha/aidemo` | Right *concept* (`storyboard.json` → narrated captioned MP4), but drives Chrome, not a terminal. |
| Glide | https://github.com/michaelshimeles/glide | 226 | none (pushed 2026-10-19) | Apache-2.0 | `scripts/build.sh` | `glide export Project.glide` + `project.json` is promising; unproven. |

**Findings**

- **`zoompan` and `crop`+`scale` quantize motion; Pillow does not.** `zoompan` keeps `x`/`y` as `int` and masks to chroma alignment (`x &= ~((1 << s->desc->log2_chroma_w) - 1)`), and `crop` rounds per-frame offsets via `lrint(d)` into `int x` (its `exact` flag does not change this). Measured on a static 1080p source at 4 px/s: `crop`+`scale` produced **13 distinct frames out of 90**, 4× supersampling recovered 48/90, and Pillow's float `box=` produced **90/90** at 0.1 px steps (sources: https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0/libavfilter/vf_zoompan.c and https://raw.githubusercontent.com/FFmpeg/FFmpeg/n9.0/libavfilter/vf_crop.c).
- `zoompan`'s own defaults are hostile to this job — `s=hd720`, `fps=25`, `d=90` frames per input image — and `t` is not usable in its `x`/`y` expressions (`x='…t*8'` errors); pan must be driven by `on`/`in_time`, and `in_time` is NaN for image inputs (source: https://ffmpeg.org/ffmpeg-filters.html#zoompan).
- `overlay=…:enable='between(t,a,b)'` **is** frame-exact and repeatable: on a static source at 30 fps, `between(t,0.5,2.0)` produced run lengths 13 / 38 / 24, the middle run exactly the 1.5 s window. This is the reliable mechanism for burned-in subtitle cues and callouts (source: https://ffmpeg.org/ffmpeg-filters.html#overlay).
- `xfade` requires both inputs to share resolution, pixel format, frame rate and timebase, and this build offers 58 named transitions (`transition` −1…57, default `fade`), including `fadeblack`, `dissolve`, `smoothleft`, `circleopen` — enough for scene changes without an NLE. A `trim`+`setpts`+`xfade` chain was verified to yield exactly 75 frames / 2.5 s (sources: https://ffmpeg.org/ffmpeg-filters.html#xfade and `ffmpeg -h filter=xfade`).
- `sendcmd` still matters for things ffmpeg must animate itself: it "read[s] commands to be sent to other filters" with `START[-END] COMMANDS;` interval syntax and a `filename` option, so a timeline file can retarget filters without regenerating the graph (source: https://ffmpeg.org/ffmpeg-filters.html#sendcmd).
- **MLT is the only way to burn real SRT with zero extra libraries**: its `subtitle` filter takes an SRT path as `resource` and renders through Qt6 `qtext` (pango/text fallback), and `affine` exposes an animatable float `rect`; `pixbuf` accepts `anim-%04d.png` sequences (source: https://raw.githubusercontent.com/mltframework/mlt/v7.42.0/src/modules/plus/filter_subtitle.cpp).
- Remotion's licence is a headcount gate, not a copyleft one: the Free License covers "an individual", "a for-profit organization with up to 3 employees", non-profits and evaluation; otherwise a Company License is required, and the npm tarball declares `"license": "SEE LICENSE IN LICENSE.md"` (sources: https://raw.githubusercontent.com/remotion-dev/remotion/v4.0.536/LICENSE.md and https://www.remotion.dev/docs/license/pricing).
- Two "declarative JSON timeline" options are dead on arrival here: editly's `gl@8.1.6` prebuilds stop at ABI 127 (Node 22) so Node 24 needs a source build, and MoviePy pins `pillow<12.0` against the installed 12.3 (source: https://raw.githubusercontent.com/Zulko/moviepy/v2.2.1/pyproject.toml).
- Reproducibility is achievable with plain ffmpeg: streaming raw `rgb24` frames into `ffmpeg -f rawvideo … -c:v libx264` with `-threads 1` produced byte-identical output across runs (measured here), so a timeline + fixed encoder settings is a checkable build artifact, not a hand edit.

**Recommendation:** **Pillow renders, ffmpeg encodes.** A ~150-line script reads a timeline JSON (`[{t0,t1,zoom,center,ease}]`, `{t,callout}`, `{t0,t1,text}`), pulls each frame from a PNG sequence or a decoded 4K master, applies `Image.resize(size, LANCZOS, box=(float,…))`, composites subtitle/callout RGBA layers, and pipes `rgb24` into `ffmpeg -f rawvideo … -c:v libx264 -crf 18 -pix_fmt yuv420p -threads 1`; ffmpeg additionally does `xfade` scene joins and the Kokoro audio mux (`amix`/`adelay`/`atempo`). Fallback when a declarative XML timeline is preferred: **MLT `melt`** with `.mlt` and its `subtitle` filter (SRT, no libass). Do **not** build camera movement on `zoompan`/`crop` — measured 13/90 distinct frames makes a slow zoom visibly stair-step.

# 6. Explainer-style TUI demo precedents

Real projects doing scripted/edited terminal demos, with the pipeline visible in the repo (tapes, scripts), not in blog commentary.

| Project | Repo | Stars | Demo artifact in repo | Pipeline read from the repo | Verdict |
|---|---|---|---|---|---|
| **lazygit** | https://github.com/jesseduffield/lazygit | 83,283 | `demo/settings.tape`, `scripts/record_demo.sh`, `scripts/rerecord_demos.sh` | VHS + ttyd + ffmpeg; demos are *integration tests* with `IsDemo: true`; captions are drawn by the app in a quieted last row; post-processing pads 90 px for the player chrome and trims blank tail frames by measuring `signalstats YAVG` | **Best model.** Recording = running the real test harness; re-record all demos with one command. |
| gh-dash | https://github.com/dlvhdr/gh-dash | 12,641 | `docs/src/assets/overview.tape` (3 tapes) | VHS tape declares `Output overview.mp4` + `.webm` + `.gif`, 1600×800, `Set Theme TokyoNight`, `Set PlaybackSpeed 1.3`, `Set TypingSpeed 600ms`, heavy `Hide/Show` around setup | Good template for a 16:10 hero video; shows `Hide` as the cut mechanism. |
| Posting | https://github.com/darrenburns/posting | 12,523 | `demo/readme.tape`, `demo/record.sh` | `record.sh` builds the binary into `$DEMO_HOME`, writes a temp config, starts a local server, then `vhs demo/readme.tape`; tape pins `FontFamily "BlexMono Nerd Font Mono"`, 1400×760 | **Best isolation model**: demo runs against a throwaway HOME + local server, so no personal data leaks into the video. |
| gum | https://github.com/charmbracelet/gum | 24,516 | `examples/demo.tape`, `examples/demo.sh`, `convert-to-gif.sh` | Plain VHS tape with `Set FontSize 22`, 800×450; a shell script drives the interaction | Minimal, readable VHS usage; good for a "what is this tool" 30-second clip. |
| aidemo | https://github.com/tandryukha/aidemo | 16 | `storyboard.json` + `docs/AUTHORING.md`, `docs/CI.md` | One JSON storyboard (narration + fixed action spec) → headless Chrome deterministic replay → TTS → captions → MP4; re-renders in CI with no key | **Best model for narration+captions from one file**, though it targets web UIs. |
| OpenScreen | https://github.com/getopenscreen/openscreen | 4,537 | `.openscreen` project JSON + CLI docs | `record --project`, edit JSON, `export --auto-zoom --audio`, `captions` (local Whisper) | Useful if you prefer a GUI editor that also has a headless path. |

**Findings**

- The strongest precedent treats the demo as a **test run**: lazygit's demos are integration tests whose `IsDemo` flag quiets the status row so captions have room, and it adds artificial network latency so the recording looks natural — reproducibility comes from the test harness, not from careful typing (source: https://github.com/jesseduffield/lazygit/blob/master/docs/dev/Demo_Recordings.md).
- Its post-processing is plain ffmpeg and measurable: `pad=iw:ih+90` for player chrome, and tail-trim by finding the first blank frame via `signalstats` + `aw`k on `YAVG` (<0.5 ink) (source: https://github.com/jesseduffield/lazygit/blob/master/demo/record_demo.sh).
- It also pins a known-good VHS: "vhs 0.12.0 runs the tape, reports success and writes no video at all … so pin the release before it" — independent confirmation of the 0.12.0 bug (source: https://github.com/jesseduffield/lazygit/blob/master/docs/dev/Demo_Recordings.md).
- Posting's `record.sh` is the cleanest answer to "don't leak your dotfiles": build into `$(mktemp -d)`, point `XDG_CONFIG_HOME`/`XDG_DATA_HOME` at it, and start a local fixture server before `vhs` (source: https://github.com/darrenburns/posting/blob/main/demo/record.sh).
- gh-dash demonstrates multi-format output from one tape (`Output overview.webm`, `.mp4`, `.gif`) and uses `Hide`/`Show` to skip setup typing — the cheapest form of "cut" (source: https://github.com/dlvhdr/gh-dash/blob/main/docs/src/assets/overview.tape).
- aidemo's `storyboard.json` is the closest existing schema to "one file drives narration, actions, zooms, captions" and is worth copying conceptually even though it targets Chrome (source: https://github.com/tandryukha/aidemo/blob/main/README.md).

**Recommendation:** copy **lazygit's** structure (demo defined in code, VHS tape sourced from a shared `settings.tape`, post-processing in a script with a blank-frame tail trim) plus **Posting's** throwaway-HOME isolation. Put a `demo/` directory in this repo with `settings.tape`, one `.tape` per scene, and `record.sh`; that satisfies the "reproducible" requirement without inventing a new format.

---

# 7. LLM-eval / agent-eval dashboards

What a viewer needs to see, taken from what shipping tools actually render.

| Name | Repo / docs | Stars | Last release (date) | License | Local, no account | UI primitives worth copying |
|---|---|---|---|---|---|---|
| **promptfoo** | https://github.com/promptfoo/promptfoo | 26,127 | 0.124.1 (2026-10-08) | MIT | yes (`npx promptfoo@latest view`) | Matrix + display-mode filters (All/Failures/Passes/Errors/Different), per-cell pass/fail/score, eval **Compare** diff |
| **Inspect AI** | https://github.com/UKGovernmentBEIS/inspect_ai | 3,041 | 0.3.281 (2026-10-15) | MIT | yes (`inspect view`) | Sample list with column picker; Messages/Scoring/Metadata tabs; score chips |
| DeepEval | https://github.com/confident-ai/deepeval | 18,942 | 4.3.1 (2026-10-16) | Apache-2.0 | yes | `deepeval inspect` **TUI** trace tree (j/k, h/l fold, `/` filter) |
| Harbor | https://github.com/harbor-framework/harbor | 6,237 | v0.24.0 (2026-10-05) | Apache-2.0 | yes | Trial/reward browser, keyboard-first, per-trial tabs |
| NVIDIA SkillEvaluator | https://github.com/NVIDIA/SkillEvaluator | 576 | v0.5.0 (2026-10-06) | Apache-2.0 | mostly | One headline verdict `PASS/NEUTRAL/FAIL/INCOMPLETE`, `NO SCORE` never 0.0 |
| Langfuse | https://github.com/langfuse/langfuse | 36,011 | v4.63.0 (2026-10-16) | MIT core + EE dirs commercial | yes (docker) | Baseline compare; "a missing case is not a passing case" |
| Arize Phoenix | https://github.com/Arize-ai/phoenix | 11,905 | v20.23.0 (2026-10-16) | **Elastic License 2.0** | yes | Experiment compare view |
| Laminar | https://github.com/lmnr-ai/lmnr | 3,403 | v0.3.2 (2026-10-16) | Apache-2.0 | yes | `0.83 → 0.74 ▼11.5%` delta badges |
| Braintrust | https://www.braintrust.dev/docs | — | SDK 3.37.2 | Apache-2.0 SDKs / proprietary platform | **no** | Diff directions (Base→Comparison→Expected), sort-by-regressions |
| OpenAI evals | https://github.com/openai/evals | 19,618 | no releases | MIT | yes | none (JSONL only) |
| lm-evaluation-harness | https://github.com/EleutherAI/lm-evaluation-harness | 14,264 | v0.4.13 (2026-08-31) | MIT | yes | CLI tables only; no dashboard |

**Findings**

- promptfoo's viewer is the best skeleton to imitate: a matrix with a display-mode cycle (All → Failures → Passes → Errors → **Different** → Highlights), per-cell score override, and an eval-level Compare that marks added/removed cases (source: https://github.com/promptfoo/promptfoo/blob/0.124.1/site/docs/usage/web-ui.md).
- Inspect never shows a bare verdict: the Scoring tab prints input, target, extracted answer **and** the model's explanation, and the sample list has a configurable column set (`sampleStatus, sampleId, epoch, input, target, answer, tokens, duration, retries, error`) (source: https://github.com/UKGovernmentBEIS/inspect_ai/blob/0.3.281/docs/log-viewer.qmd).
- Inspect formalises colour roles (`good`/`bad`/`warn`/`info`/`muted`, plus `diverging` for signed deltas) and "chips" vs "grid" density for multi-score samples — a ready-made palette contract for a TUI (source: https://github.com/UKGovernmentBEIS/inspect_ai/blob/0.3.281/docs/task-views.qmd).
- SkillEvaluator is the only tool here built for **SKILL.md-style** evaluation and it makes the non-technical-friendly choice: one decision-first card with `PASS | NEUTRAL | FAIL | INCOMPLETE`, failing closed to `INCOMPLETE`, and an unscored metric rendered as `NO SCORE` "never coerced to 0.0" (source: https://docs.nvidia.com/skills/skillevaluator/reports).
- Laminar's compare page is the cleanest delta visual: `0.83 → 0.74` with a coloured `▼ 11.5%` badge, per-row deltas, baseline in the URL (source: https://laminar.sh/docs/evaluations/comparing-runs).
- Langfuse supplies the sentence a non-technical viewer needs: a compared case that is absent in one run must not inherit the other run's verdict; and two runs can both average 50% while swapping which cases pass (source: https://langfuse.com/docs/evaluation/experiments/compare-experiments).
- DeepEval proves the TUI medium is sufficient for this job: `deepeval inspect` is a terminal trace-tree viewer with `j/k`, `h/l` fold, `/` filter, `y` copy node JSON (source: https://deepeval.com/docs/command-line-interface).

**Recommendation for the dashboard:** an outcome-first screen (one headline `PASS/PARTIAL/FAIL` + count chips), a **scenario × step matrix** whose cells are `pass / fail / needs_human / not_reached` (never a 0–1 decimal), a drill-down pane showing the finding's evidence quote next to the pointer (`turn`, `event_index`) — mirroring `findings.json` — and a confidence bar rendered 0–100 rather than `0.83`. Colours: use Inspect's semantic roles, not literal red/green.

---

# Awesome lists consulted

| List | URL | Last updated | What I took from it |
|---|---|---|---|
| awesome-tuis | https://github.com/rothgar/awesome-tuis | 2026-10-12 (commit) | The Libraries section: Textual, Rich, blessed, urwid, prompt_toolkit, notcurses, Bubble Tea, tview, tcell, FTXUI |
| awesome-terminal-recorder | https://github.com/orangekame3/awesome-terminal-recorder | 2026-05-05 (commit) | asciinema, agg, VHS, terminalizer, t-rec, termtosvg, ttygif, menyoki |
| awesome-ratatui | https://github.com/ratatui/awesome-ratatui | 2026-10-17 (commit) | Ratatui widget/app ecosystem (context on widget maturity) |
| awesome-cli-apps | https://github.com/agarrharr/awesome-cli-apps | 2026-10-12 (commit) | Cross-check of surviving CLI/TUI projects (README not fetchable at HEAD as Markdown; used repo metadata only) `[UNVERIFIED]` contents |
| awesome-ffmpeg | https://github.com/transitive-bullshit/awesome-ffmpeg | 2026-09-18 (commit) | ffmpeg wrapper landscape (README not fetchable at HEAD as Markdown; used repo metadata only) `[UNVERIFIED]` contents |
| awesome-video-editing | https://github.com/wentianli/awesome-video-editing | 2026-09-30 (commit) | editly, MoviePy, MLT-class tools |
| Awesome-Text-to-Speech | https://github.com/ishandutta2007/Awesome-Text-to-Speech | 2026-10-13 (commit) | Long-tail TTS candidates (F5, StyleTTS2, Fish, VoxCPM, Qwen3-TTS, Supertonic, Soprano) — each then verified at its own repo |
| awesome-controllable-speech-synthesis | https://github.com/imxtx/awesome-controllable-speech-synthesis | 2026-10-13 (commit) | Prosody/emotion control candidates (all heavier than Kokoro) |
| awesome-textualize-projects | https://github.com/oleksis/awesome-textualize-projects | 2024-03-18 (commit) | Textual app examples; list itself stale, used only as a lead |

---

# Gaps and unverified

- **OpenTUI on this machine:** `@opentui/core@0.6.6` requires Node ≥26.4.0; host is 24.22. Whether a Node 24 install *works anyway* is `[UNVERIFIED]` — I did not install.
- **Kokoro realtime factor on this exact host:** `kokoro-onnx` README claims "near real-time on macOS M1"; not measured here. `[UNVERIFIED]` for M-series beyond M1.
- **Kokoro `create_timed()` on the fp16/int8 graphs:** release notes say the duration output is in every variant, but whether int8's timings stay within subtitle tolerance is `[UNVERIFIED]`; plan to spot-check int8 against fp32.
- **VHS `Output frames/` with `--fps 60` at 4K:** the frame loop writes `frame-text-%05d.png` at `Framerate`; whether Chrome's canvas upscales cleanly to a 3840-wide terminal is `[UNVERIFIED]` — the tape's `Set Width` is in pixels, so this needs a test render.
- **`tui-test` MP4 path:** README says MP4 requires ffmpeg and does not support transparency; the exact encoder/flags it invokes are `[UNVERIFIED]` (not read in source).
- **`asciinema` v3 `.cast` → high-res raster:** agg is GIF-only and pyte is the obvious emulator (LGPL, last release 2023, handles `38;5`/`48;5` but truecolor `38;2` handling I did not confirm) `[UNVERIFIED]`. That is why the recommended recorder-to-frames path uses VHS/tui-test rather than agg.
- **Motion-fidelity numbers are single-run measurements**, not a published benchmark: 13/90 vs 90/90 distinct frames at 4 px/s, 37.7 ms/frame, and md5-identical re-encodes were obtained on this host with a static synthetic source. They establish the direction of the effect (integer quantization) but the exact counts will differ on real footage. `[MEASURED, not from docs]`
- **`ffmpeg-full` bottle on macOS 27:** formula lists `arm64_tahoe`/`arm64_sequoia` bottles; a macOS 27 bottle is `[UNVERIFIED]`, and if absent it builds from source (long).
- **Piper per-voice licenses:** `rhasspy/piper-voices` card metadata is `mit`, but `docs/VOICES.md` warns some voices are restrictive; I did not read individual `MODEL_CARD` files. `[UNVERIFIED]` for the specific voice we would ship.
- **ctc-forced-aligner licensing conflict:** `LICENSE` is BSD-2-Clause, `pyproject.toml` says `CC-BY-NC 4.0`. Treat as non-commercial until clarified. `[UNVERIFIED]`
- **`awesome-cli-apps` / `awesome-ffmpeg` contents:** README at HEAD returned 404 as raw Markdown, so only repo metadata was used. `[UNVERIFIED]`
- **Remotion license for a 4-person team:** pricing page is explicit (free ≤3 people) but whether an internal-only demo counts as "commercial use" is a legal call. `[UNVERIFIED]`
- **aidemo, Screenize, Recordly-alikes:** several are days-to-weeks old with tiny star counts; maturity is `[UNVERIFIED]` beyond their own READMEs.
- macOS 27 screen-capture permission prompts for `screencapture`/`avfoundation`/ScreenCaptureKit were not exercised (`[UNVERIFIED]` whether a TCC prompt blocks an unattended run).

---

# Open questions for the human

1. **Voice taste:** Kokoro `af_heart` (warm, default in most demos) vs `af_sarah` (crisper) vs `am_michael` (male). This is a taste call I cannot make; it changes only one string.
2. **Resolution:** 1080p (37.7 ms/frame measured for a 4K→1080p camera; a 4-minute 60 fps piece is ~2.7 min of rendering) vs 4K delivery (crisper terminal text when the viewer zooms the player, but ~4× the pixels to move and encode). Recommend a 1080p60 master; render a 4K master only if the video will be watched full-screen on a large display.
3. **Subtitle style:** burned-in always, or soft `.srt` track in the MP4 plus a burned variant for social? Burning needs either `ffmpeg-full` (new install) or the Pillow overlay path; soft subs can be muxed with the current ffmpeg (`-c:s mov_text`) with no install at all.
4. **Runtime target:** a 60–90 s teaser or a 3–4 minute walkthrough? That decides whether the real eval run is shown end-to-end or cut to two scenarios with a time-lapse.
