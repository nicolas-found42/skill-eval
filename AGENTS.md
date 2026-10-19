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

## scenarios.json

Run level: `skill_path`, `model_alias`, `reps` (default 1), `concurrency` (5), `timeout` (600 s; hard kill after +60 s), optional `cost_cap` (USD).
Per scenario: `id`, `kind` (`positive` | `negative` | `temptation`), `prompt`, optional `followups[]`, optional `fixtures{path: content}`, optional `env[]` (names of host env vars passed to that scenario's container by name; they must be set, and never the grading key), `rationale`, `expected.outcome`, `expected.steps[]`.
Per step: `id`, `description` (ONE falsifiable property), `evidence_hint`, optional `requires[stepId]`.

Rules: at least one of each kind, default five scenarios. Positive = should trigger the skill. Negative = near-miss that must not trigger it. Temptation = pressure to skip a step. Express ordering with `requires`, never inside a description. Phrase "did not" steps as claims that are true when nothing happened.

## Run folder

```
evals/<YYYYMMDD-HHMMSS>-<skill>-<model-alias>-<skillhash7>/
  run.json  scenarios.json  scenarios.lock.json  skill/  mcp.json (only if the skill declares MCP servers)  summary.md  findings.json
  <scenario-id>[-rN]/  scenario.json  transcript.jsonl  events.json  result.json  grading.json  analysis.md  stderr.txt  workspace/
```

`run.json` records model, skill and scenarios hashes, omp version, the pinned Jev model, session / lint / analysis / total cost, limits and `warnings`. Read the warnings first: a host-path MCP server, ignored frontmatter env, or a referenced skill the container does not have means a failure may be a missing dependency, not a broken skill. `analysis.md` in a session folder is that session alone: verdict and probabilities per step, labels, and the `events.json` turn/event to open.

For skills that declare MCP servers in their frontmatter, the runner writes a minimal `mcp.json` (command and args only; frontmatter `env` values are never copied) and mounts it read-only. Pass the variables such a server needs through scenario `env[]`.

## Isolation

Each container gets only its own `workspace/` (rw) and the skill snapshot (ro), one model key, no host home, no grading key. The network is open and egress is not filtered: use a spend-capped model key. Docker down means the run stops; there is no host fallback.

## Agent skills

### Issue tracker

GitHub Issues on `nicolas-found42/skill-eval` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
