# AGENTS.md

Skill eval system: runs an LLM skill through parallel, containerized `omp` sessions on a cheap model, grades them with Jev, and writes results you can read to fix the skill.

## When the user says "evaluate this skill (path)"

Requirements: Node >= 20, Docker running, `OPENROUTER_API_KEY` (grading, stays on the host) and the key for the chosen model. No install step.

1. `node eval.mjs doctor [--model <alias>]`. Checks Docker, builds the image if missing, checks keys. If it fails, tell the user what it says; never work around it.
2. Read the skill's `SKILL.md` **only** (not past evals). Write `scenarios.json` from it (schema below). Pick the model alias the user named; otherwise omit `model_alias` and the default from `models.json` is used.
3. `node eval.mjs validate scenarios.json`. Jev lints every step (one falsifiable property each, grounded in the skill text) and freezes the file by hash. Fix what it rejects, re-run. Do not edit the file after it is frozen; `run` refuses a changed file.
4. `node eval.mjs run scenarios.json`. Runs every scenario (x reps) in its own container, in parallel, then grades and classifies. Prints the run folder.
5. Read `<run folder>/summary.md` (failures first), then `findings.json`. Each finding has a scenario, step, label, probabilities and a pointer (`turn`, `event_index`) into that session's `events.json`. Open only the pointed-at events, not whole transcripts.
6. Fix the skill, then re-run steps 3-4 with the **same** scenarios and `node eval.mjs compare <before-run> <after-run>` (reports fixed / still failing / new / regressed). A changed skill hash is expected; a changed scenarios hash or model makes runs not comparable.

Other commands: `grade <run>` and `analyze <run>` re-run grading / grading+reporting on an existing run; `run --skip-grading` keeps only raw sessions; `selftest` replays the committed mutation fixtures and fails if grader verdicts drift (run it after changing Jev questions, thresholds or the pinned judge model).

## TUI

`tools/tui.py` is the operator console for the same pipeline: start a run, watch every situation live, read the findings with the proof attached. It is a tool, not a walkthrough — no narration, no tutorial scenes.

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements-tui.txt
.venv/bin/python tools/tui.py --scenarios scenarios.json --evals-dir evals
```

Flags: `--scenarios <file>` (defaults to `./scenarios.json`, else the demo file), `--evals-dir <dir>` (defaults to `./evals`), `--run <folder>` (open a finished run at start), `--run-now` (start an eval on launch, so the console can be watched without touching the keyboard). Keys: `r` run · `1-4` runs / live / findings / sessions · `tab` next view · `↑`/`↓` move · `enter` open the selected run · `q` quit.

Errors show in every view: a failed validate or run says so in the console instead of failing silently.

The TUI never grades or judges anything itself: it drives `node eval.mjs validate` + `node eval.mjs run` and reads the run folder. Every number on screen comes from `run.json`, `findings.json` or a session's `grading.json`.

## scenarios.json

Run level: `skill_path` (a skill directory, or a plugin directory: `plugin.json` + `skills/` + root `SKILL.md`), `model_alias`, `reps` (default 1), `concurrency` (5), `timeout` (600 s; hard kill after +60 s), `hard_kill_grace` (60 s), `no_output_timeout` (300 s of container silence before a hang is recorded), `container_memory_mb` (4096; hard `docker run --memory` limit so OOM is recorded, 0 disables), `max_retries` (0; retries per session on timeout/OOM/exit 137/125, failed attempts kept as `transcript.retry-N.jsonl`), `retry_backoff_ms` (5000), optional `seed` (recorded into every session for attribution; the model is remote and unseeded), optional `cost_cap` (USD).
Per scenario: `id`, `kind` (`positive` | `negative` | `temptation`), `prompt`, optional `followups[]` (scripted user replies delivered as further turns of the same container session, in order; turn numbers in `events.json` keep counting across them), optional `fixtures{path: content}`, optional `env[]` (names of host env vars passed to that scenario's container by name; they must be set, and never the grading key), `rationale`, `expected.outcome`, `expected.steps[]`.
Per step: `id`, `description` (ONE falsifiable property), `evidence_hint`, optional `requires[stepId]`.


## Run folder

```
evals/<YYYYMMDD-HHMMSS>-<skill>-<model-alias>-<skillhash7>/
  run.json  scenarios.json  scenarios.lock.json  skill/  mcp.json (only if the skill declares MCP servers)  summary.md  findings.json
  <scenario-id>[-rN]/  scenario.json  session.json  transcript.jsonl  transcript.partial.txt  host.jsonl  host-clock.json  telemetry.jsonl
    events.json  events.full.json (only on timeout/failure/truncation)  turns.json  result.json  grading.json  analysis.md  stderr.txt  workspace/
```

`run.json` records model, skill and scenarios hashes, omp version, image digest, git SHA, clock span, the pinned Jev model, session / lint / analysis / total cost, limits and `warnings`. Read the warnings first: a host-path MCP server, ignored frontmatter env, or a referenced skill the container does not have means a failure may be a missing dependency, not a broken skill. `analysis.md` in a session folder is that session alone: verdict and probabilities per step, labels, and the `events.json` turn/event to open.

`run.json` is written after every session and carries `status` (`running` → `complete`), so a run whose harness died says how far it got. `retry_attempts` aggregates the per-session retry counts at run level. `turns.json` holds per-turn model, provider, response id, TTFT, usage and cost: which model served a turn, and where the tokens went, without opening the transcript. `result.json` carries `provider_retries` (throttling the model endpoint imposed, recovered or not), `clock_offset_ms` (container clock against host clock), and `oom_killed` (true when docker recorded an OOM kill — the container runs with a hard `--memory` limit, and the harness inspects it before the kill removes the container). `host-clock.json` holds the host arrival clock per transcript line; `events.json` pairs it into `host_wall_ms` per tool result. `telemetry.jsonl` events carry the host write timestamp, so they correlate with `host.jsonl` without re-parsing the transcript. `grading.json` carries `judge_trace`: the question, the answer and an evidence slice per step, so a `needs_human` verdict can be audited without paying for the judge again; `grading.evidence.json` (the full judge state) is written automatically for any session with a `needs_human` step or truncated evidence, and for every session with `--keep-evidence`.

For intermittent or historical questions, use `node eval.mjs diagnose <run> [--session <name>] [--json]`: run story or one session's timeline with timeout cause (`killed` vs `hung` vs `expired`), truncation gaps and judge gaps, with gap codes (`timeout_hung`, `oom_killed`, `capped_events`, `not_normalized`, …) and a `suggested_rerun` in `--json`. It never calls the judge. A run with no `run.json` is not refused: the story is rebuilt from the session folders and the interrupted ones are named. `node eval.mjs normalize <session-dir>` recovers a session the harness never normalized (a transcript, no `events.json`/`result.json`). `node eval.mjs archive <evals-dir> [--keep <n>]` gzips the transcripts of every run but the `n` newest; an archived session still normalizes. History: `<evals-dir>/.index.jsonl` (per-folder, alongside the runs) plus the tracked repo-root `.evals-index.jsonl` and `node eval.mjs index [--evals-dir]`. Cross-run questions run off `<evals-dir>/.metrics.db`, which `analyze` updates automatically; `node eval.mjs query <type>` answers `failing-steps`, `flaky-steps`, `error-classes`, `pass-rate-trend`, `slow-sessions`, `resource-usage`, `runs`, `provider-errors` (who was rate-limited and whether the retries recovered) and `recurring-failures` (the defects that keep coming back; add `--judge` to cluster wordings that differ). Every answer carries a `stale` block naming the run folders the index could not read.

For skills that declare MCP servers in their frontmatter, the runner writes a minimal `mcp.json` (command and args only; frontmatter `env` values are never copied) and mounts it read-only. Pass the variables such a server needs through scenario `env[]`.

A plugin (`skill_path` pointing at `plugin.json` + `skills/`) mounts whole at `/plugin` (`--plugin-dir /plugin` on every omp invocation) with its portable `mcp.json` (`${PLUGIN_ROOT}` rewritten to `/plugin`, `env` never copied). Stage skills count as loads for `skill_loaded`; Jev grounding sees the root SKILL.md plus every stage skill. Write scenarios from what the plugin advertises, reusing its own eval prompts where they fit.

## Isolation

## Agent skills

### Issue tracker

GitHub Issues on `nicolas-found42/skill-eval` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
