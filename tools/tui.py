#!/usr/bin/env python3
"""skill-eval TUI.

Run an eval, watch every situation live, read the findings with the proof
attached. No narration, no tutorial: this is the tool you drive.

    python3 tools/tui.py                        # open the newest run, or start one
    python3 tools/tui.py --run <folder>         # open a finished run
    python3 tools/tui.py --scenarios other.json # different situations file
    python3 tools/tui.py --evals-dir demo/evals-demo

Keys:  r run · 1-4 views · tab next view · up/down move · enter open · q quit

The TUI only drives the real pipeline (`node eval.mjs validate` + `node eval.mjs
run`) and reads the artefacts it writes. It never grades or judges anything
itself: every number on screen comes from the run folder.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import textwrap
import threading
import time
from pathlib import Path

# Textual installs its Monochrome filter when NO_COLOR is set; recording shells
# often export it. Drop it before the App is constructed.
os.environ.pop("NO_COLOR", None)

from textual.app import App, ComposeResult  # noqa: E402
from textual.containers import Vertical  # noqa: E402
from textual.widgets import Static  # noqa: E402

REPO = Path(__file__).resolve().parent.parent

# Grader enum (lib/grade.mjs) -> glyph + palette key + words.
VERDICT_STYLE = {
    "done": ("✓", "good", "done"),
    "skipped": ("✗", "bad", "skipped"),
    "wrong": ("✗", "bad", "done wrong"),
    "needs_human": ("?", "warn", "needs a human"),
    "blocked": ("–", "dim", "not reached"),
}
KIND_WORDS = {
    "positive": "should fire",
    "negative": "should stay quiet",
    "temptation": "tempted to cut corners",
}
C = {
    "title": "ansi_bright_white",
    "body": "ansi_white",
    "dim": "ansi_256_245",
    "accent": "ansi_bright_cyan",
    "good": "ansi_bright_green",
    "bad": "ansi_bright_red",
    "warn": "ansi_bright_yellow",
    "rule": "ansi_256_238",
}

# Markup tags and escaped characters, for measuring plain width.
_TAG = re.compile(r"\\.|\[[^\]]*\]")


def style(kind: str, text: str) -> str:
    # An unknown palette key must never take the console down mid-run.
    return f"[{C.get(kind, 'body')}]{text}[/]"


def plain(text: str) -> str:
    """Strip markup tags and escapes: the text a human would read."""
    return _TAG.sub("", str(text))


def esc(text: object) -> str:
    """Escape model- or file-sourced text so brackets cannot become markup."""
    return str(text).replace("\\", "\\\\").replace("[", "\\[")


def short(text: str, limit: int = 96) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def wrap(text: str, width: int = 100, indent: str = "") -> list[str]:
    lines = textwrap.wrap(" ".join(str(text).split()), width=width) or [""]
    return [indent + line for line in lines]


def step_label(step_id: str) -> str:
    """`context-first` -> `Context first`; ids are the stable contract."""
    return step_id.replace("-", " ").replace("_", " ").strip().capitalize() or "?"


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return None


class Tui(App):
    """Live console for one eval: run it, watch it, read what it found."""

    CSS = """
    Screen { background: #0d1018; color: #e0e0e0; }
    #body { padding: 0; }
    #topbar { background: #16233a; color: #cfe3ff; padding: 0 2; height: 1; }
    #hintbar { background: #12161f; color: #8a8a99; padding: 0 2; height: 1; }
    #scene { height: 1fr; padding: 1 3; content-align: left middle; }
    """

    BINDINGS = [
        ("q", "quit", "Quit"),
        ("r", "start_run", "Run"),
        ("1", "view_runs", "Runs"),
        ("2", "view_live", "Live"),
        ("3", "view_findings", "Findings"),
        ("4", "view_sessions", "Sessions"),
        ("tab", "next_view", "Next view"),
        ("shift+tab", "prev_view", "Previous view"),
        ("up", "cursor_up", "Up"),
        ("down", "cursor_down", "Down"),
        ("k", "cursor_up", "Up"),
        ("j", "cursor_down", "Down"),
        ("enter", "activate", "Open"),
    ]

    VIEWS = ["runs", "live", "findings", "sessions"]
    VIEW_TITLES = {"runs": "Runs", "live": "Live run", "findings": "Findings", "sessions": "Sessions"}

    def __init__(self, scenarios: Path, evals_dir: Path, initial_run: Path | None,
                 run_now: bool = False) -> None:
        super().__init__()
        self.scenarios_path = scenarios
        self.evals_dir = evals_dir
        self.cfg: dict = {}
        self.run_dir: Path | None = None
        self.proc: subprocess.Popen | None = None
        self.lines: queue.Queue[str] = queue.Queue()
        self.stage = "idle"
        self.stage_note = ""
        self.errors: list[str] = []
        self.notices: list[str] = []
        self.view = "runs"
        self.sel = {"runs": 0, "findings": 0, "sessions": 0}
        self.started_at: float | None = None
        self.started_wall: float = 0.0
        self.finished_at: float | None = None
        self._run_done = False
        self._starting = False
        self._pre_run_dirs: set[str] = set()
        self._meta_cache: dict[str, tuple] = {}
        self._initial_run = initial_run
        self._run_now = run_now

    # ---------- composition ----------
    def compose(self) -> ComposeResult:
        with Vertical(id="body"):
            yield Static("", id="topbar", markup=True)
            yield Static(id="scene", markup=True)
            yield Static("", id="hintbar", markup=True)

    def on_mount(self) -> None:
        self.load_config()
        if self._initial_run and self._initial_run.exists():
            self.open_run(self._initial_run)
        self.set_interval(0.5, self.tick)
        if self._run_now:
            self.action_start_run()

    # ---------- model ----------
    def load_config(self) -> None:
        cfg = read_json(self.scenarios_path)
        if cfg is None:
            self.errors.append(f"cannot read {self.scenarios_path}")
            return
        self.cfg = cfg

    def run_folders(self) -> list[Path]:
        if not self.evals_dir.exists():
            return []
        folders = [d for d in self.evals_dir.iterdir()
                   if d.is_dir() and ((d / "run.json").exists() or (d / "scenarios.json").exists())]
        return sorted(folders, key=lambda d: d.stat().st_mtime, reverse=True)

    def session_dirs(self) -> list[Path]:
        if not self.run_dir:
            return []
        dirs = [d for d in self.run_dir.iterdir()
                if d.is_dir() and ((d / "result.json").exists() or (d / "scenario.json").exists())]
        return sorted(dirs, key=lambda d: d.name)

    def findings(self) -> list[dict]:
        doc = read_json(self.run_dir / "findings.json") if self.run_dir else None
        return (doc or {}).get("findings", []) or []

    def run_meta(self) -> dict:
        if not self.run_dir:
            return {}
        key = str(self.run_dir)
        mtime = self.run_dir.stat().st_mtime
        cached = self._meta_cache.get(key)
        if cached and cached[0] == mtime:
            return cached[1]
        meta = read_json(self.run_dir / "run.json") or {}
        self._meta_cache[key] = (mtime, meta)
        return meta

    def assistant_text(self, session: Path) -> str:
        events = read_json(session / "events.json") or []
        texts = [e.get("text", "") for e in events if e.get("kind") == "assistant_text"]
        return texts[-1] if texts else ""

    def tool_calls(self, session: Path) -> list[str]:
        events = read_json(session / "events.json") or []
        out = []
        for e in events:
            if e.get("kind") != "tool_call":
                continue
            args = e.get("args", "")
            try:
                args = json.loads(args)
            except Exception:  # noqa: BLE001
                pass
            if isinstance(args, dict):
                arg = args.get("path") or args.get("command") or args.get("pattern") or ""
            else:
                arg = str(args)
            out.append(f"{e.get('tool', '?')} {arg}".strip())
        return out

    def expected_step(self, scenario_id: str, step_id: str) -> str:
        for s in self.cfg.get("scenarios", []):
            if s.get("id") != scenario_id:
                continue
            for st in s.get("expected", {}).get("steps", []):
                if st.get("id") == step_id:
                    return st.get("description", "")
        return ""

    # ---------- actions ----------
    def action_view_runs(self) -> None:
        self.view = "runs"

    def action_view_live(self) -> None:
        self.view = "live"

    def action_view_findings(self) -> None:
        self.view = "findings"

    def action_view_sessions(self) -> None:
        self.view = "sessions"

    def action_next_view(self) -> None:
        self.view = self.VIEWS[(self.VIEWS.index(self.view) + 1) % len(self.VIEWS)]

    def action_prev_view(self) -> None:
        self.view = self.VIEWS[(self.VIEWS.index(self.view) - 1) % len(self.VIEWS)]

    def action_cursor_up(self) -> None:
        if self.view in self.sel:
            self.sel[self.view] = max(0, self.sel.get(self.view, 0) - 1)

    def action_cursor_down(self) -> None:
        if self.view in self.sel:
            self.sel[self.view] = self.sel.get(self.view, 0) + 1

    def action_activate(self) -> None:
        """Enter: in the run list, open the selected run; elsewhere, nothing to open."""
        if self.view != "runs":
            return
        folders = self.run_folders()
        idx = min(self.sel.get("runs", 0), len(folders) - 1)
        if idx < 0:
            return
        self.open_run(folders[idx])
        self.view = "live"

    def open_run(self, folder: Path) -> None:
        self.run_dir = folder
        self.stage = "done" if (folder / "findings.json").exists() else "reading a finished run"
        self.stage_note = folder.name
        self.sel["findings"] = 0
        self.sel["sessions"] = 0

    def action_start_run(self) -> None:
        if self.proc is not None or self._starting:
            self.notices.append("a run is already in flight")
            return
        self.errors.clear()
        self.notices.clear()
        self.stage = "freeze (validate)"
        self.stage_note = "hashing the test…"
        self.started_at = time.monotonic()
        self.started_wall = time.time()
        self.finished_at = None
        self._run_done = False
        self._starting = True
        self._pre_run_dirs = {d.name for d in self.evals_dir.iterdir()} if self.evals_dir.exists() else set()
        self.view = "live"
        threading.Thread(target=self._validate_then_run, daemon=True).start()

    # ---------- pipeline ----------
    def _validate_then_run(self) -> None:
        try:
            v = subprocess.run(["node", "eval.mjs", "validate", str(self.scenarios_path)],
                               cwd=REPO, capture_output=True, text=True, timeout=300)
        except Exception as e:  # noqa: BLE001
            self._starting = False
            self.errors.append(f"validate error: {e}")
            self.stage = "failed"
            return
        if v.returncode != 0:
            self._starting = False
            self.errors.append("validate failed: " + (v.stderr or v.stdout or "").strip()[-200:])
            self.stage = "failed"
            return
        self.stage = "run (sealed containers)"
        self.stage_note = "frozen ✓"
        self._start_run()

    def _start_run(self) -> None:
        self.evals_dir.mkdir(parents=True, exist_ok=True)
        try:
            self.proc = subprocess.Popen(
                ["node", "eval.mjs", "run", str(self.scenarios_path), "--evals-dir", str(self.evals_dir)],
                cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        except Exception as e:  # noqa: BLE001
            self._starting = False
            self.errors.append(f"run error: {e}")
            self.stage = "failed"
            return
        self._starting = False
        threading.Thread(target=self._read_pipe, daemon=True).start()

    def _read_pipe(self) -> None:
        assert self.proc and self.proc.stdout
        for line in self.proc.stdout:
            self.lines.put(line)

    def persist_errors(self) -> None:
        """Errors live in memory for the banner; they also land in the run folder,
        so a later `diagnose` sees the orchestration failure, not just the sessions."""
        if not self.run_dir or not self.errors:
            return
        try:
            p = self.run_dir / "tui-errors.json"
            prev = json.loads(p.read_text()) if p.exists() else []
            prev += [{"t": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "error": e} for e in self.errors]
            p.write_text(json.dumps(prev, indent=2))
        except Exception:  # noqa: BLE001
            pass

    def pump(self) -> None:
        while True:
            try:
                line = self.lines.get_nowait()
            except queue.Empty:
                break
            line = line.strip()
            if line.startswith("run folder:"):
                self.open_run(Path(line.split("run folder:", 1)[1].strip()))
            elif line.startswith("analyzed"):
                self.stage = "done"
                self.stage_note = line.split(";", 1)[0].split("analyzed", 1)[1].strip()
                self.finished_at = time.monotonic()
                self._run_done = True
                self.view = "findings"
            elif line:
                self.stage_note = line
        if self.proc is not None and self.proc.poll() is not None:
            rc = self.proc.returncode
            if not self._run_done:
                if rc != 0:
                    self.errors.append(f"run exited rc={rc}")
                    self.stage = "run failed"
                self.finished_at = self.finished_at or time.monotonic()
                self._run_done = True
            self.persist_errors()
            self.proc = None
    def poll_run(self) -> None:
        """Adopt the run folder as soon as it appears: `eval.mjs run` prints its
        path only after every container finished. Only a folder that this run
        could have created is adopted, so a second console never steals it."""
        if self.run_dir is not None or not self.evals_dir.exists():
            return
        started = self.started_at or time.monotonic()
        for d in sorted((d for d in self.evals_dir.iterdir()
                         if d.is_dir() and d.name not in self._pre_run_dirs),
                        key=lambda d: d.stat().st_mtime, reverse=True):
            if self.own_run_name(d.name):
                self.open_run(d)
                return

    def own_run_name(self, name: str) -> bool:
        """A run folder of ours: same skill and model, stamped after we started."""
        stamp = name[:15]
        if len(stamp) != 15 or not stamp.isdigit():
            return False
        try:
            when = time.mktime(time.strptime(stamp, "%Y%m%d-%H%M%S"))
        except ValueError:
            return False
        skill = (self.cfg.get("skill_path") or "").split("/")[-1]
        alias = self.cfg.get("model_alias") or ""
        if skill and skill not in name:
            return False
        if alias and alias not in name:
            return False
        return self.started_wall - 5 <= when <= time.time() + 5

    # ---------- render ----------
    def tick(self) -> None:
        self.pump()
        if self.proc is not None:
            self.poll_run()
        self.render()

    def render(self) -> None:
        self.query_one("#topbar", Static).update(self.topbar())
        body = getattr(self, f"view_{self.view}")()
        self.query_one("#scene", Static).update(self.error_banner() + body)
        self.query_one("#hintbar", Static).update(self.hintbar())

    def error_banner(self) -> str:
        """Errors show in every view: a failure must never be invisible."""
        lines = []
        if self.errors:
            lines += ["", style("bad", "errors:")]
            lines += ["  " + style("bad", "✗ ") + style("body", esc(e)) for e in self.errors[-4:]]
        if self.notices:
            lines += ["", style("warn", "notes:")]
            lines += ["  " + style("warn", "· ") + style("body", esc(n)) for n in self.notices[-3:]]
        if not lines:
            return ""
        lines.append("")
        return "\n".join(lines)

    def topbar(self) -> str:
        skill = (self.cfg.get("skill_path") or "").split("/")[-1] or "?"
        model = (self.cfg.get("model_alias") or "?")
        run = self.run_dir.name if self.run_dir else "no run"
        frozen = "frozen ✓" if (self.scenarios_path.parent / (self.scenarios_path.name + ".lock.json")).exists() else "not validated"
        bits = [style("accent", "skill-eval"), style("dim", "·"), style("title", skill),
                style("dim", "·"), style("body", model), style("dim", "·"),
                style("dim", self.scenarios_path.name), style("dim", "·"),
                style("dim", frozen), style("dim", "·"), style("accent", run)]
        return " ".join(bits)

    def hintbar(self) -> str:
        names = {"runs": "1 runs", "live": "2 live", "findings": "3 findings", "sessions": "4 sessions"}
        parts = [style("accent" if v == self.view else "dim", label) for v, label in names.items()]
        parts += [style("dim", "r run"), style("dim", "↑↓ move"), style("dim", "enter open"), style("dim", "q quit")]
        return "  ".join(parts)

    def rule(self, char: str = "─", width: int = 110) -> str:
        return style("rule", char * width)

    # ---------- view: runs ----------
    def view_runs(self) -> str:
        folders = self.run_folders()
        out = ["", style("title", "Runs"), ""]
        if not folders:
            out.append("  " + style("dim", f"no runs in {self.evals_dir}"))
            out.append("")
            out.append("  " + style("dim", "press r to run the eval on") + " " + style("body", str(self.scenarios_path)))
            return "\n".join(out)
        sel = min(self.sel.get("runs", 0), len(folders) - 1)
        self.sel["runs"] = sel
        window = folders[max(0, sel - 8): sel + 9]
        for folder in window:
            idx = folders.index(folder)
            meta = read_json(folder / "run.json") or {}
            findings = (read_json(folder / "findings.json") or {}).get("findings", [])
            sessions = len([d for d in folder.iterdir() if d.is_dir() and (d / "result.json").exists()]) if folder.exists() else 0
            cost = meta.get("total_cost", 0) or 0
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(folder.stat().st_mtime))
            high = [f for f in findings if f.get("severity") == "high"]
            mark = style("accent", "▸") if idx == sel else " "
            line = (f" {mark} {style('dim', when)}  {style('title', esc(folder.name))}")
            line += style("dim", f"  {sessions} sessions · {len(findings)} findings")
            if high:
                line += style("bad", f" · {len(high)} failing")
            # A run whose record still says "running" is one the harness never finished.
            if meta.get("status") == "running":
                done = meta.get("sessions_done", sessions)
                planned = meta.get("sessions_planned", "?")
                line += style("warn", f" · interrupted at {done}/{planned}")
            elif not (folder / "run.json").exists():
                line += style("warn", " · interrupted")
            line += style("dim", f" · ${cost:.4f}")
            out.append(line)
        out.append("")
        out.append("  " + style("dim", "enter opens the selected run"))
        return "\n".join(out)

    # ---------- view: live ----------
    def view_live(self) -> str:
        out = ["", f"{style('title', 'Live run')}   {style('dim', 'stage:')} {style('accent', self.stage)}  {style('dim', esc(self.stage_note))}", ""]
        if self.run_dir is None:
            out += self.queued_cards()
            return "\n".join(out)
        out += self.live_cards()
        return "\n".join(out)

    def queued_cards(self) -> list[str]:
        out = []
        for s in self.cfg.get("scenarios", []):
            out.append(f" {style('dim', '○')}  {style('title', s.get('id', '?'))}   "
                       f"{style('dim', KIND_WORDS.get(s.get('kind', ''), s.get('kind', '')))}   "
                       f"{style('dim', 'queued')}")
        out += ["", style("dim", "press r to run these")]
        return out

    def running_sessions(self) -> set[str]:
        running: set[str] = set()
        if not self.run_dir:
            return running
        try:
            ps = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                                capture_output=True, text=True, timeout=5)
            for n in ps.stdout.splitlines():
                m = re.match(rf"skill-eval-{re.escape(self.run_dir.name)}-(.+)$", n.strip())
                if m:
                    running.add(m.group(1))
        except Exception:  # noqa: BLE001
            pass
        return running

    def live_cards(self) -> list[str]:
        running = self.running_sessions()
        sessions = self.session_dirs()
        by_base: dict[str, list[Path]] = {}
        for d in sessions:
            by_base.setdefault(re.sub(r"-r\d+$", "", d.name), []).append(d)
        planned_ids = [s.get("id", "?") for s in self.cfg.get("scenarios", [])]

        # One card per session directory; repeats live in sid-r1, sid-r2, ...
        entries: list[tuple[str, str, Path | None]] = []
        for s in self.cfg.get("scenarios", []):
            sid, kind = s.get("id", "?"), s.get("kind", "")
            dirs = by_base.get(sid, [])
            if dirs:
                entries += [(d.name, kind, d) for d in dirs]
            else:
                entries.append((sid, kind, None))
        for d in sessions:
            if re.sub(r"-r\d+$", "", d.name) not in planned_ids:
                entries.append((d.name, "", d))

        out: list[str] = []
        counts = {"done": 0, "skipped": 0, "wrong": 0, "needs_human": 0, "blocked": 0}
        cost = 0.0
        for sid, kind, d in entries:
            head = f" {style('title', esc(sid))}   {style('dim', esc(KIND_WORDS.get(kind, kind)))}"
            res = d / "result.json" if d else None
            grd = d / "grading.json" if d else None
            r = read_json(res) if res and res.exists() else None
            if r:
                cost += r.get("cost", 0) or 0
            if grd and grd.exists():
                g = read_json(grd) or {}
                chips = []
                for st in g.get("steps", []):
                    v = st.get("verdict", "needs_human")
                    glyph, col, words = VERDICT_STYLE.get(v, ("?", "warn", v))
                    counts[v] = counts.get(v, 0) + 1
                    p = {"done": st.get("p_done"), "skipped": st.get("p_not_done"),
                         "wrong": st.get("p_not_done")}.get(v)
                    p_s = f" {p:.0%}" if isinstance(p, (int, float)) else ""
                    chips.append(f"{style(col, glyph)} {style('body', esc(step_label(st.get('id', ''))))}"
                                 f"{style('dim', p_s)}")
                out.append(head)
                out.append("     " + "   ".join(chips))
            elif r:
                secs = (r.get("duration_ms") or 0) / 1000
                code = r.get("exit_code")
                if r.get("timeout"):
                    kind = r.get("timeout_kind")
                    timed = f"timed out ({kind})" if kind else "timed out"
                    out.append(head)
                    out.append(f"     {style('bad', '✗')} {style('bad', timed)} · {style('body', f'{secs:.0f}s')}")
                    continue
                if code not in (0, None):
                    # the container failed: the judge would grade an empty
                    # session, which reads as real findings but is not
                    err = (d / "stderr.txt").read_text().strip() if d and (d / "stderr.txt").exists() else ""
                    out.append(head)
                    out.append(f"     {style('bad', '✗')} {style('bad', f'container failed (exit {code})')}"
                               f" · {style('body', f'{secs:.0f}s')}")
                    if err:
                        out.append("       " + style("dim", esc(short(err.splitlines()[-1], 90))))
                    continue
                loaded = bool(r.get("skill_loaded"))
                if kind == "negative":
                    read = style("good", "skill stayed quiet ✓") if not loaded else style("warn", "skill fired ✗")
                else:
                    read = style("good", "skill read ✓") if loaded else style("warn", "skill not read ✗")
                out.append(head)
                out.append(f"     {style('accent', '●')} {style('good', 'answered')} · "
                           f"{style('body', f'{secs:.0f}s')} · {read} · {style('dim', 'judging next…')}")
            elif sid in running:
                out.append(head)
                out.append(f"     {style('accent', '●')} {style('accent', 'live in its container')} …")
            else:
                out.append(head)
                out.append(f"     {style('dim', '○ queued')}")
        if any(counts.values()):
            out += ["", self.rule()]
            legend = (f"{style('good', '✓')} {style('dim', str(counts['done']) + ' done')}    "
                      f"{style('bad', '✗')} {style('dim', str(counts['skipped'] + counts['wrong']) + ' failed')}    "
                      f"{style('warn', '?')} {style('dim', str(counts['needs_human']) + ' need a human')}")
            out.append(" " + legend + "     " + style("dim", f"spend ${cost:.4f}"))
        out += self.run_meta_lines()
        return out

    def run_meta_lines(self) -> list[str]:
        meta = self.run_meta()
        if not meta:
            return []
        model = meta.get("model") or {}
        model = model.get("model", "") if isinstance(model, dict) else str(model)
        judge = meta.get("judge") or {}
        judge = judge.get("model", "") if isinstance(judge, dict) else str(judge)
        out = ["", style("dim", f"helper {esc(model)} · judge {esc(judge)} · test {str(meta.get('scenarios_hash', ''))[:8]}"
                          f" · skill {str(meta.get('skill_hash', ''))[:8]} · ${meta.get('total_cost', 0):.4f}")]
        for w in meta.get("warnings", []) or []:
            out.append(style("warn", "warning: ") + style("body", esc(w)))
        return out

    # ---------- view: findings ----------
    def view_findings(self) -> str:
        findings = self.findings()
        out = ["", style("title", "Findings"), ""]
        if not self.run_dir:
            out.append("  " + style("dim", "no run open — press r to run one"))
            return "\n".join(out)
        if not (self.run_dir / "findings.json").exists():
            out.append("  " + style("dim", "the run is still going; findings appear when it finishes"))
            return "\n".join(out)
        if not findings:
            out.append("  " + style("good", "✓  no findings — every expected step was done."))
            out.append("")
            out += self.run_meta_lines()
            return "\n".join(out)
        sel = min(self.sel.get("findings", 0), len(findings) - 1)
        self.sel["findings"] = sel
        for idx, f in enumerate(findings):
            label = f.get("label", "?")
            high = f.get("severity") == "high"
            glyph, col = ("✗", "bad") if high else ("?", "warn")
            step = f.get("step") or ""
            p = f.get("probability")
            p_s = f" {p:.0%}" if isinstance(p, (int, float)) else ""
            mark = style("accent", "▸") if idx == sel else " "
            what = step_label(step) if step else label.replace("_", " ")
            row = f" {mark} {style(col, glyph)}  {style('title', esc(f.get('scenario', '?')))}"
            row += f"{style('dim', ' / ')}{style('body', esc(what))}"
            if step:
                row += style("dim", "  " + esc(label))
            row += style("dim", p_s)
            if f.get("count", 1) > 1:
                row += style("dim", f"  ×{f['count']}")
            out.append(row)
        out.append("")
        out += self.finding_detail(findings[sel])
        out += self.run_meta_lines()
        return "\n".join(out)

    def finding_detail(self, f: dict) -> list[str]:
        out = [self.rule(), ""]
        out.append(" " + style("title", esc(f.get("description", ""))))
        expected = self.expected_step(f.get("scenario", ""), f.get("step", "") or "")
        if expected:
            out.append(" " + style("dim", "expected: ") + style("body", esc(expected)))
        probs = f.get("probabilities") or {}
        if probs:
            out.append(" " + style("dim", "judge: ") + style("body", " · ".join(
                f"{k.replace('_', ' ')} {v:.0%}" for k, v in probs.items() if isinstance(v, (int, float)))))
        pointer = f.get("pointer") or {}
        out.append(" " + style("dim", f"at turn {pointer.get('turn', '?')}, event {pointer.get('event_index', '?')}"))
        evidence = (f.get("evidence") or "").strip()
        if evidence:
            out.append(" " + style("dim", "proof: ") + style("body", esc(short(evidence, 110))))
        session = self.find_session(f.get("scenario", ""))
        answer = self.assistant_text(session) if session else ""
        if answer:
            out.append(" " + style("dim", "the helper said:"))
            out += [style("body", "  " + esc(line)) for line in wrap(answer, 100)]
        return out

    def find_session(self, scenario_id: str) -> Path | None:
        for d in self.session_dirs():
            if d.name == scenario_id or re.sub(r"-r\d+$", "", d.name) == scenario_id:
                return d
        return None

    # ---------- view: sessions ----------
    def view_sessions(self) -> str:
        sessions = self.session_dirs()
        out = ["", style("title", "Sessions"), ""]
        if not sessions:
            out.append("  " + style("dim", "no run open — press r to run one"))
            return "\n".join(out)
        sel = min(self.sel.get("sessions", 0), len(sessions) - 1)
        self.sel["sessions"] = sel
        for idx, d in enumerate(sessions):
            r = read_json(d / "result.json") or {}
            mark = style("accent", "▸") if idx == sel else " "
            secs = (r.get("duration_ms") or 0) / 1000
            cost = r.get("cost", 0) or 0
            kind = r.get("kind", "")
            loaded = bool(r.get("skill_loaded"))
            line = f" {mark} {style('title', esc(d.name))}"
            line += style("dim", f"  {esc(KIND_WORDS.get(kind, kind))}")
            line += style("dim", f"  {secs:.0f}s  ${cost:.4f}")
            code = r.get("exit_code")
            if r.get("timeout"):
                tkind = r.get("timeout_kind")
                line += style("bad", f"  timed out ({tkind})" if tkind else "  timed out")
            elif code not in (0, None):
                line += style("bad", f"  container failed (exit {code})")
            else:
                line += style("good", "  skill read ✓") if loaded else style("dim", "  skill not read")
            out.append(line)
        out.append("")
        out += self.session_detail(sessions[sel])
        return "\n".join(out)

    def session_detail(self, session: Path) -> list[str]:
        out = [self.rule(), ""]
        r = read_json(session / "result.json") or {}
        gaps = []
        if r.get("dropped_chars"):
            gaps.append(f"{r['dropped_chars']} transcript chars cut mid-line (see transcript.partial.txt)")
        if (session / "transcript.partial.txt").exists():
            gaps.append("cut transcript tail saved in transcript.partial.txt")
        if (session / "events.full.json").exists():
            gaps.append("uncapped timeline in events.full.json")
        if r.get("timeout_kind") == "hung":
            gaps.append("container went silent before the hard kill (see host.jsonl no_output)")
        if r.get("oom_killed"):
            gaps.append("container was OOM-killed (see host.jsonl container_end)")
        if (r.get("stderr_bytes") or 0) > 0 and not r.get("timeout") and r.get("exit_code") == 0:
            gaps.append(f"{r['stderr_bytes']} stderr bytes on a clean exit (see stderr.txt)")
        g = read_json(session / "grading.json")
        if g and g.get("truncated"):
            gaps.append(f"evidence over cap ({g.get('evidence_chars', '?')} chars): no step could auto-pass")
        if gaps:
            out.append(" " + style("warn", "gaps: ") + style("body", esc("; ".join(gaps))))
            out.append("")
        if g:
            for st in g.get("steps", []):
                v = st.get("verdict", "needs_human")
                glyph, col, words = VERDICT_STYLE.get(v, ("?", "warn", v))
                p = st.get("p_done")
                p_s = f" {p:.0%}" if isinstance(p, (int, float)) else ""
                out.append(f" {style(col, glyph)} {style('body', esc(step_label(st.get('id', ''))))}"
                           f"{style('dim', '  ' + words)}{style('dim', p_s)}")
                desc = st.get("description", "")
                if desc:
                    out.append("    " + style("dim", esc(desc)))
            out.append("")
        calls = self.tool_calls(session)
        if calls:
            out.append(" " + style("dim", "tool calls:"))
            for c in calls[:8]:
                out.append("    " + style("body", esc(short(c, 96))))
            out.append("")
        answer = self.assistant_text(session)


def default_scenarios() -> Path | None:
    for candidate in (REPO / "scenarios.json", REPO / "demo" / "wait-what-scenarios.json"):
        if candidate.exists():
            return candidate
    return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Run a skill eval and read its findings.")
    ap.add_argument("--scenarios", type=Path, default=None, help="situations file to run")
    ap.add_argument("--evals-dir", type=Path, default=REPO / "evals", help="where run folders live")
    ap.add_argument("--run", type=Path, default=None, help="open this run folder at start")
    ap.add_argument("--run-now", action="store_true", help="start an eval immediately on launch")
    args = ap.parse_args()

    # An explicit path is used as given: a missing or unreadable file is reported
    # inside the app, so a permission prompt on the way in cannot kill the tool.
    scenarios = args.scenarios or default_scenarios()
    if scenarios is None:
        ap.error(f"no situations file found (tried {REPO / 'scenarios.json'})")

    Tui(scenarios.resolve(), args.evals_dir.resolve(),
        args.run.resolve() if args.run else None,
        run_now=args.run_now).run()


if __name__ == "__main__":
    main()
