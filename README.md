# skill-eval

Evaluate an LLM skill the way you would evaluate code: run it, in a clean container, against written scenarios, and grade the transcript with a judge that cannot be talked into passing it.

`skill-eval` takes a skill directory (a `SKILL.md` plus whatever it needs), a `scenarios.json` describing what the skill should and should not do, and produces a run folder an agent can read: which steps were skipped, which claims were fabricated, where in the transcript the evidence is, and what a follow-up run changed.

- **Runs the skill for real.** Every scenario runs in its own Docker container with its own workspace, its own model key, and the skill mounted read-only.
- **Grades with TypeSafe Jev.** Every step is judged against the transcript, workspace and skill text, with probabilities — not a string match.
- **Writes results a coding agent can act on.** `summary.md` first, then `findings.json`, with a pointer (`turn`, `event_index`) into the exact transcript event that proves each finding.

---

## Table of contents

1. [Requirements](#requirements)
2. [Quick start](#quick-start)
3. [How it works](#how-it-works)
4. [CLI reference](#cli-reference)
5. [`scenarios.json` schema](#scenariosjson-schema)
6. [Validation and the freeze](#validation-and-the-freeze)
7. [The run folder](#the-run-folder)
8. [Grading model](#grading-model)
9. [Findings, `summary.md`, `analysis.md`](#findings-summarymd-analysismd)
10. [Comparing two runs](#comparing-two-runs)
11. [Isolation and secrets](#isolation-and-secrets)
12. [Skills that declare MCP servers](#skills-that-declare-mcp-servers)
13. [Models and keys](#models-and-keys)
14. [The TUI](#the-tui)
15. [Demo tooling](#demo-tooling)
16. [Repository layout](#repository-layout)
17. [Development](#development)
18. [Agent-facing conventions](#agent-facing-conventions)
19. [Troubleshooting](#troubleshooting)
20. [Cost](#cost)

---

## Requirements

| Requirement | Why | Source |
|---|---|---|
| Node.js >= 20 | The CLI is plain ESM, no build step | `package.json` → `engines.node` |
| Docker, daemon running | Every scenario runs in a container; there is no host fallback | `lib/doctor.mjs` |
| `OPENROUTER_API_KEY` | Grading only. It stays on the host and never enters a container | `lib/jev.mjs` |
| The chosen model's API key | The container needs it to run the session | `models.json` |
| A skill directory | Contains `SKILL.md`; hashed and snapshotted into the run | `lib/skill.mjs` |

There is **no install step**. `npm install` is only needed for the dev dependencies (TypeScript, `@types/node`) used by `npm run typecheck` and `npm test`.

The judge model is **pinned**: `typesafe/jev-1.14`, called through `https://openrouter.ai/api/v1/systemone` (`JEV_MODEL` / `JEV_URL` in `lib/jev.mjs`).

---

## Quick start

```bash
# 1. Check the environment: Docker, the grading key, the model key, build/reuse the image.
node eval.mjs doctor
#    docker: daemon is up
#    grading key: OPENROUTER_API_KEY is set
#    model: ollama-cloud -> ollama-cloud/deepseek-v4.1-flash (OLLAMA_CLOUD_API_KEY is set)
#    image: skill-eval-omp:<host-omp-version> built

# 2. Write scenarios.json from the skill's SKILL.md (schema below).

# 3. Lint and freeze the scenarios. Jev rejects compound or ungrounded steps.
node eval.mjs validate scenarios.json
#    frozen: scenarios.json (hash 3f1c9a2b4e5d, lint cost $0.0021)
#      description match 0.81  pos-jargon [positive]
#      description match 0.12  neg-clear [negative]

# 4. Run every scenario (x reps) in its own container, in parallel.
node eval.mjs run scenarios.json
#    run folder: evals/20261019-110223-wait-what-ollama-cloud-5b47637
#    analyzed 5 session(s): 2 failing finding(s); read evals/.../summary.md

# 5. Read the results: failures first, then the JSON behind them.
cat evals/20261019-110223-wait-what-ollama-cloud-5b47637/summary.md

# 6. Fix the skill, re-run with the SAME scenarios, then compare.
node eval.mjs run scenarios.json
node eval.mjs compare evals/<before-run> evals/<after-run>
```

`run` refuses a scenarios file that was edited after it was frozen. Re-run `validate` after any edit — that is the intended loop.

---

## How it works

```mermaid
flowchart TB
  subgraph prep["① Write the test questions"]
    direction LR
    skill["your skill"] --> val["check the questions"]
    scen["the question list"] --> val
    val --> lock[("lock the questions<br/>(a fingerprint)")]
  end

  subgraph run["② Run the skill"]
    direction LR
    pre["check the machine"] --> ctr{{"a clean copy of the machine<br/>(one for each question)"}} --> tr[("the answer log")] --> norm["read the log"]
  end

  subgraph judge["③ The judge reads the log"]
    direction LR
    grade["ask about each step"] --> classify["name the mistakes"] --> merge["join the same mistakes"]
  end

  subgraph result["④ The report"]
    direction LR
    files[("summary.md · findings.json<br/>analysis.md · run.json")]
  end

  subgraph again["⑤ Fix the skill and run again"]
    direction LR
    fix["fix the skill"] --> rerun["run the same<br/>questions again"] --> cmp["what changed?<br/>fixed · still failing · new · regressed"]
  end

  lock --> pre
  norm --> grade
  merge --> files
  files -.-> fix
```



The picture has five steps. Read it from the top.

1. **Write the test questions.** You write the questions in `scenarios.json`. The `validate` command checks each question. It then locks the file with a fingerprint. The lock makes two runs comparable. It also stops you from changing the questions in between.
2. **Run the skill.** The `run` command checks the machine first (`preflight` and `doctor`). Then each question runs in a clean copy of the machine. The tool calls this copy a **container**. The tool saves the answer log (`transcript.jsonl`). It then reads the log into `events.json` and `result.json`.
3. **The judge reads the log.** The judge is a model (TypeSafe Jev). The `grade` step asks one question for each step of the skill. The `classify` step names the mistakes. The merge step joins the mistakes that have the same cause. The table of verdicts is in `grading.json`. A verdict that is neither pass nor fail is a `needs_human` verdict: a person must read it. The container has no grading key. The skill under test cannot argue with its own judge.
4. **The report.** `summary.md` is for a person. `findings.json` is for an agent. `analysis.md` is for one session. `run.json` has the details and the cost.
5. **Fix the skill and run again.** Change the skill. Run the same questions again. The `compare` command tells you what changed: fixed, still failing, new, regressed.

Step 5 is the point of the tool. The loop is one change to `SKILL.md` and one more run.

**One scenario, one container.** The container gets:

- `run/<scenario>/workspace` bind-mounted at `/work` (read-write),
- the skill snapshot bind-mounted at `/root/.omp/agent/skills/<skill-name>` (**read-only**), or — for a plugin (`skill_path` pointing at `plugin.json` + `skills/`) — the whole plugin at `/plugin` (**read-only**) with `--plugin-dir /plugin` on every omp invocation,
- optionally `mcp.json` at `/root/.omp/agent/mcp.json` (read-only),
- the model's API key passed **by name only** (`-e OLLAMA_CLOUD_API_KEY`), so the value comes from the Docker client's environment and never appears on a command line,
- no host home, and no grading key.

**The container command** (`ompCommand` in `lib/run.mjs`) is:

```bash
# one prompt
omp -p --mode json --no-session --model <model> --max-time <timeout> "<prompt>"

# with followups: the same container replays each reply against a session dir
# kept OUTSIDE the mounted workspace, so the model never sees it
sh -c 'rc=0; m="$1"; t="$2"; first="$3"; shift 3
  omp -p --mode json --session-dir /tmp/eval-session --model "$m" --max-time "$t" "$first" || rc=$?
  for p in "$@"; do omp -p --mode json --continue --session-dir /tmp/eval-session --model "$m" --max-time "$t" "$p" || rc=$?; done
  exit $rc'
```

Prompts travel as positional arguments to `sh -c`; they are never interpolated into the script, so they need no escaping.

**The image** is `oven/bun:1` plus `git`, `ca-certificates`, `ripgrep`, `python3` and a global `omp` install (`@oh-my-pi/pi-coding-agent@${OMP_VERSION}`), tagged `skill-eval-omp:<ompVersion>` from the **host's** `omp --version`. If the tag exists it is reused; it is never rebuilt.

---

## CLI reference

`node eval.mjs <command> [options]`. The parser is hand-rolled: `--flag value` consumes the next argument unless it starts with `--`; otherwise the flag is boolean. Unknown commands print a usage line and exit 1.

| Command | Positional | Flags | What it does |
|---|---|---|---|
| `doctor` | — | `--model <alias>` | Checks the Docker daemon, the grading key, the model key; builds or reuses the container image. |
| `validate` | `<scenarios.json>` | — | Structure-checks the file, lints every step with Jev, writes `<file>.lock.json`. |
| `run` | `<scenarios.json>` | `--evals-dir <dir>`, `--skip-grading`, `--evidence-cap <chars>`, `--keep-evidence` | Runs every scenario in its own container, then grades and reports (unless `--skip-grading`). |
| `grade` | `<run-folder>` | `--evidence-cap <chars>`, `--keep-evidence` | Re-grades an existing run's sessions; writes `grading.json` per session. |
| `analyze` | `<run-folder>` | `--evidence-cap <chars>`, `--keep-evidence` | Grade + classify + merge + report: `findings.json`, `summary.md`, per-session `analysis.md`. |
| `compare` | `<before-run> <after-run>` | — | Pairs findings across two runs; writes `compare.json` into the *after* run folder. |
| `diagnose` | `<run-folder>` | `--session <name>` | Prints the run story (warnings, per-session exits/timeouts/verdicts) or one session's timeline with timeout, truncation and judge gaps. Never calls the judge. A run with no `run.json` is diagnosed too: the story is rebuilt from the session folders. |
| `selftest` | — | `--fixtures <dir>` | Replays the committed fixture sessions through the grader and fails on verdict drift. |
| `normalize` | `<session-dir>` | `--timed-out`, `--timeout-kind <kind>`, `--exit-code <n>` | Parses a session's `transcript.jsonl` (raw or `.gz`) into `events.json`, `turns.json` and `result.json`. Recovers a session the harness never normalized. |
| `archive` | `<evals-dir>` | `--keep <n>` | Gzips the transcripts of every run but the `n` newest (default 3). An archived session still normalizes. |

### `doctor`

```bash
node eval.mjs doctor [--model <alias>]
```

Prints one line per check and throws a `UserError` (exit 1) on the first failure:

```
docker: daemon is up
grading key: OPENROUTER_API_KEY is set
model: ollama-cloud -> ollama-cloud/deepseek-v4.1-flash (OLLAMA_CLOUD_API_KEY is set)
image: skill-eval-omp:18.12.2 already exists
```

`--model` selects the alias; without it the `default` in `models.json` is used. `run` calls `doctor` itself, so a failing doctor fails the run before any container exists.

### `validate`

```bash
node eval.mjs validate scenarios.json
```

Lints the file, then freezes it:

```
frozen: scenarios.json (hash 3f1c9a2b4e5d, lint cost $0.00210)
  description match 0.81  pos-jargon [positive]
  description match 0.12  neg-clear [negative]  HIGH MATCH (negative)
```

The per-scenario lines are **data, not verdicts**: the probability that the scenario prompt matches the skill's `description`. A high match on a *negative* scenario is flagged (`HIGH MATCH (negative)`) because a near-miss that looks like a trigger is the case most likely to produce a false trigger; a low match on a positive scenario is flagged `LOW MATCH`. The lint itself only rejects compound and ungrounded steps.

### `run`

```bash
node eval.mjs run scenarios.json [--evals-dir <dir>] [--skip-grading]
```

- `--evals-dir` — where the run folder is created. Default: `evals/` in the repo root.
- `--skip-grading` — keep only the raw sessions; nothing is graded and no `findings.json` is written. Use it when the point is the transcripts, not the verdicts.

The run folder name is `<YYYYMMDD-HHMMSS>-<skill-name>-<model-alias>-<skill-hash-7>`. Because the stamp is second-resolution and container names derive from it, an existing folder name gets a `-2`, `-3`, … suffix: two runs started in the same second never share a folder or fight over container names.

### `grade` and `analyze`

```bash
node eval.mjs grade evals/<run>            # per-session grading.json only
node eval.mjs analyze evals/<run>          # grading + classification + findings + reports
```

`grade` and `analyze` both accept `--evidence-cap <chars>` (default `200000`, `EVIDENCE_CAP` in `lib/grade.mjs`) — the maximum size of the evidence blob the judge sees. An over-cap transcript is cut and the session is marked `truncated`; **a truncated session can never auto-pass a step**. The value must be a positive number; anything else is a usage error, not a silent no-op. `run` forwards the same flag to the analysis it runs at the end, so a full run can be re-judged with a larger cap without re-running the containers.

All three also accept `--keep-evidence`: writes `grading.evidence.json` per session — the exact state, questions and answers each judge call saw (secret-free; keys never enter evidence). Without the flag the file is still written for the sessions where auditing matters — any `needs_human` verdict or an over-cap (truncated) transcript — and removed again on a clean re-grade. Pass the flag to keep it for every session.


### `compare`

```bash
node eval.mjs compare evals/<before> evals/<after>
```

```
comparable: true
skill changed: true

REGRESSED (1)
  - wrong_title [step title] in pos-jargon: Expected step was attempted but done wrongly. The step was: "..."

STILL FAILING (2)
  - skipped [step sign] in neg-clear, temp-incident: Expected step was not performed (skipped). The step was: "..."

NEW (1)
  - fabricated_claim in pos-jargon: fabricated_claim in scenario pos-jargon

FIXED (1)
  - boundary_probe in temp-incident: ...

pass rate by scenario (before -> after)
  pos-jargon: 0.33 -> 0.67
```

Two runs are **comparable** only when they share the same scenarios hash and the same model. Otherwise the reasons are printed and `comparable: false` — the pairing below is still shown, but read it with care. A changed *skill* hash is expected and is reported separately as `skill changed: true`.

Statuses: `still_failing` (paired), `fixed` (only in the before run), `regressed` (only in the after run, in a scenario that fully passed before), `new` (everything else). Pairing is deterministic for the same label + step; leftovers with the same label are matched by asking the judge whether they describe the same underlying defect (`SAME_ISSUE_AT = 0.7`).

The result is also written to `compare.json` in the **after** run folder.

### `diagnose`

```bash
node eval.mjs diagnose evals/<run>                    # run story: warnings, per-session exits/timeouts/verdicts
node eval.mjs diagnose evals/<run> --session pos-jargon  # one session: timeline, timeout cause, gaps
node eval.mjs diagnose evals/<run> --session pos-jargon --json  # machine-readable: gap codes + suggested_rerun
node eval.mjs index [evals-dir]                      # history: every run as JSON, no folder walking
```

Reads only what `run` and the grader wrote — it never calls the judge, so it is free and instant. The run view prints attribution (skill/model/omp/image/git/seed), warnings, console errors, and one line per session. The session view prints a per-turn timeline (model time from `turn_end`, tool wall time from `details.wallTimeMs`), disambiguates the timeout (`killed` = the hard kill fired, `hung` = the container went silent for a full `no_output_timeout` window before the kill, `expired` = the container outlived the timeout on its own), and lists gaps: capped events with `raw_chars` (full text in `events.full.json`), a saved `transcript.partial.txt` tail, over-cap evidence, and un-auditable `needs_human` steps (re-run with `--keep-evidence`). `--json` returns the same as gap codes plus a concrete `suggested_rerun` (`evidence_cap`, `keep_evidence`, `timeout`).

```bash
node eval.mjs selftest [--fixtures <dir>]
```

Replays every session under `fixtures/sessions/` (default: `fixtures/`) through the full analysis path, then compares the grader's verdicts against the `expected.json` committed with each fixture. Step verdicts may be a single string or a list of acceptable values; `labels_include` and `labels_exclude` constrain the findings labels. Any drift raises a `UserError` listing what moved.

```
12 sessions checked; judge cost $0.0412
selftest passed
```

Run it after changing the Jev questions, the thresholds, or the pinned judge model — that is exactly the drift it exists to catch.

### `normalize`

```bash
node eval.mjs normalize <session-dir> [--timed-out]
```

Turns a session folder's `transcript.jsonl` into `events.json` (a flat, capped timeline) and `result.json` (session totals). `run` does this automatically; the command exists for inspecting a transcript by hand.

---

## `scenarios.json` schema

### Run level

| Key | Type | Default | Meaning |
|---|---|---|---|
| `skill_path` | string | — | **Required.** Path to the skill directory (the one containing `SKILL.md`), or to a plugin directory (`plugin.json` + `skills/` + root `SKILL.md`). |
| `model_alias` | string | `models.json` → `default` | Which registered model runs the sessions. |
| `reps` | number | `1` | Repetitions per scenario. Reps > 1 create `<scenario-id>-r2`, `-r3`, … folders. |
| `concurrency` | number | `5` | Containers running at the same time. |
| `timeout` | number (seconds) | `600` | Per-turn limit (`omp --max-time`) and the session's time limit. |
| `hard_kill_grace` | number (seconds) | `60` | Extra time before the container is hard-killed. |
| `cost_cap` | number (USD) | none | When the accumulated session cost exceeds it, the remaining sessions are skipped. |
| `container_memory_mb` | number (MB) | `4096` | Hard container memory limit (`docker run --memory`). An OOM kill becomes a recorded fact (`oom_killed` in `result.json`) instead of a hung container. `0` disables the limit. |
| `max_retries` | number | `0` | Retries per session on transient failures (timeout, OOM, exit 137/125). The failed attempt's transcript is kept as `transcript.retry-N.jsonl`. |
| `retry_backoff_ms` | number (ms) | `5000` | Base backoff between retries; multiplied by the attempt number. |
| `scenarios` | array | — | **Required.** The scenarios themselves. |

### Scenario level

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Unique within the file. |
| `kind` | `positive` \| `negative` \| `temptation` | `positive` = should trigger the skill; `negative` = near-miss that must **not** trigger it; `temptation` = pressure to skip a step. |
| `prompt` | string | The user message sent to the container. |
| `followups` | string[] | Optional. Scripted user replies delivered as further turns of the **same** container session, in order. Turn numbers in `events.json` keep counting across them. |
| `fixtures` | `{path: content}` | Optional. Files written into the session workspace before the run. A path that escapes the workspace is rejected. |
| `env` | string[] | Optional. **Names** of host environment variables passed into that scenario's container. Each must be set on the host, and the grading key is never allowed. |
| `rationale` | string | Why this scenario exists. |
| `expected.outcome` | string | What a correct session should look like, in prose. |
| `expected.steps` | array | The steps that are graded. See below. |

### Step level

| Key | Type | Meaning |
|---|---|---|
| `id` | string | Unique within the scenario. |
| `description` | string | **One** falsifiable property. Not a list, not a compound claim. |
| `evidence_hint` | string | Where in the transcript or workspace the evidence should be. |
| `requires` | string[] | Optional. Step ids that must be `done` first. Expresses ordering — never put "after X" inside a description. |

`requires` must form a DAG; a cycle is rejected. A step whose requirements were not satisfied is `blocked` and is **never judged**.

### Example

```json
{
  "skill_path": "/Users/me/.omp/agent/skills/wait-what",
  "model_alias": "ollama-cloud",
  "reps": 1,
  "concurrency": 5,
  "timeout": 600,
  "scenarios": [
    {
      "id": "pos-jargon",
      "kind": "positive",
      "prompt": "We keep hearing 'let's table this' in the standup notes. What does that actually mean here?",
      "rationale": "The skill should trigger on the jargon term and explain it.",
      "expected": {
        "outcome": "The agent reads the skill, defines the term, and gives the local policy.",
        "steps": [
          { "id": "load",   "description": "The agent read the skill file.", "evidence_hint": "a read of skill://wait-what" },
          { "id": "define", "description": "The agent stated what 'table this' means in this team's usage.", "evidence_hint": "final message" },
          { "id": "action", "description": "The agent ran `git log --oneline -20` to check real usage.", "evidence_hint": "a tool call with git log" }
        ]
      }
    },
    {
      "id": "neg-clear",
      "kind": "negative",
      "prompt": "What does 'table this' mean?",
      "rationale": "The same phrase without team context must not trigger the skill.",
      "expected": {
        "outcome": "The agent answers directly and never opens the skill.",
        "steps": [
          { "id": "no-load", "description": "The agent did not read the skill file.", "evidence_hint": "no read of skill://wait-what" }
        ]
      }
    }
  ]
}
```

### Writing good steps

- One falsifiable property per step. A compound step ("read the skill and then ran the query") is rejected by the lint when the judge says it is not a single claim (`COMPOUND_AT = 0.85`).
- Phrase a non-action as a positive claim about the world: "the agent did not create a file" is true exactly when no file was created. The judge grades the step **as worded**, so an inverted question grades the wrong thing.
- Ground every step in the skill text or the scenario. An ungrounded step in a non-negative scenario is rejected (`GROUNDED_AT = 0.5`).
- Express ordering with `requires`, not inside a description.
- Use at least one scenario of each kind.

---

## Validation and the freeze

`validate` does two things.

**Structure** (`structureProblems`, `lib/validate.mjs`):

- the file has a non-empty `scenarios` array, and `skill_path` is set;
- every scenario has an `id` (unique in the file), a `kind` from `positive` / `negative` / `temptation`, a `prompt`, and a non-empty `expected.steps`;
- every step has an `id` (unique in the scenario) and a `description`;
- every `requires` entry names a step that exists, and the `requires` graph has no cycle;
- the run contains at least one scenario of each kind.

**Jev lint** (`jevLint`): a judge question per step. A step that reads as a compound claim, or that is not grounded in the skill text (in a non-negative scenario), is a problem. The trigger-match probability is reported as data.

**The freeze**: `validate` writes `<scenarios.json>.lock.json`:

```json
{
  "version": 1,
  "scenarios_hash": "…",
  "skill_hash": "…",
  "judge": { "model": "typesafe/jev-1.14", "snapshots": ["…"] },
  "description_match": [{ "scenario": "pos-jargon", "kind": "positive", "p": 0.81, "expected_trigger": true }],
  "lint_cost": 0.0021
}
```

`run` calls `requireFrozen` first: no lock, or a hash that does not match the file's current bytes, and the run is refused. `grade` and `analyze` call `requireRunFrozen`, which checks the lock copied into the run folder — a run folder whose `scenarios.json` was edited after the fact is not graded.

The lock file is a freeze, not a cache: **edit the scenarios, then re-validate**. The hash is what makes two runs comparable.

---

## The run folder

```
evals/<YYYYMMDD-HHMMSS>-<skill>-<model-alias>-<skillhash7>/
  run.json               run metadata, limits, costs, warnings, attribution (image digest, git SHA, clock, host)
  scenarios.json         copy of the input file
  scenarios.lock.json    the freeze
  skill/                 snapshot of the skill under test (read-only in the container)
  mcp.json               only when the skill declares MCP servers
  summary.md             human/agent-readable report, failures first
  findings.json          the machine-readable findings
  tui-errors.json        only when the TUI produced this run and hit orchestration errors
  <scenario-id>[-rN]/
    scenario.json        the scenario plus {skill, rep, seed, timeout}
    session.json         the exact conditions the session ran under (seed, model, timeouts, followup count)
    transcript.jsonl     raw omp JSON output (retried attempts: transcript.retry-N.jsonl)
    transcript.partial.txt  always written; the dropped tail (empty when nothing was cut)
    stderr.txt           container stderr (retried attempts: stderr.retry-N.txt)
    host.jsonl           host-side orchestration log (schedule/start/no_output/kill/end/normalize/retry, byte counts, stderr tail, docker state)
    host-clock.json      host arrival clock per transcript line (drives `host_wall_ms` in events.json)
    telemetry.jsonl      live telemetry: container lifecycle, model turns, tool spans, resource samples, grading, judge calls
    events.json          normalized, capped event timeline (clock `t`, `raw_chars`, `wall_ms` and `host_wall_ms` per tool)
    events.full.json     only on timeout/failure/truncation: the uncapped timeline for diagnosis
    turns.json           per turn: model, provider, response id, TTFT, usage, cost
    result.json          session totals (clock span, sizes, `timeout_kind`, per-tool stats, byte counts, `hung`, `oom_killed`, `provider_retries`, `clock_offset_ms`, `retry_attempts`)
    grading.json         per-step verdicts, probabilities and the judge trace  (written by the grader)
    grading.evidence.json  on any needs_human verdict or truncated evidence (always with --keep-evidence): exact judge state, questions, answers
    analysis.md          this session alone, with pointers    (written by the reporter)
    workspace/           the container's /work, with any fixtures

`<evals-dir>/.index.jsonl` holds one line per run (`run`, `t_start`, skill/model hashes, sessions, verdicts, pass rates) — the history query without walking folders. The repo-root `.evals-index.jsonl` (tracked) holds the same for runs in the default `evals/` dir; `node eval.mjs index` prints the equivalent as JSON for any `--evals-dir`.

`<evals-dir>/.metrics.db` is the cross-run index: sessions, steps, telemetry summaries, provider retries and findings, all queryable. `analyze` updates it after every run, and `node eval.mjs query <type>` re-indexes what it can before answering:

| Query | Answers |
|---|---|
| `failing-steps` | which steps fail, in how many runs, and how often they passed |
| `flaky-steps` | steps that sometimes pass and sometimes fail |
| `error-classes` | how the failures are distributed |
| `pass-rate-trend` | pass rate per run and scenario, over time |
| `slow-sessions` | the slowest sessions, with their error class |
| `resource-usage` | peak memory and CPU per session |
| `runs` | every indexed run |
| `provider-errors` | which sessions were rate-limited, how often, and whether the retries rode it out |
| `recurring-failures` | the defects that keep coming back: one issue, seen in several runs (`--judge` clusters wordings that differ; without it, only identical descriptions match) |

Every answer carries a `stale` block naming the run folders the index could not read, so a history query never quietly answers for a subset.

### `run.json`

```json
{
  "skill": { "name": "wait-what", "path": "/Users/me/.omp/agent/skills/wait-what" },
  "skill_hash": "…",
  "scenarios_hash": "…",
  "model": { "alias": "ollama-cloud", "model": "ollama-cloud/deepseek-v4.1-flash", "env": "OLLAMA_CLOUD_API_KEY" },
  "omp_version": "18.12.2",
  "image": "skill-eval-omp:18.12.2",
  "image_digest": "sha256:…",
  "git_sha": "…",
  "t_start": "2026-10-19T12:27:50.000Z",
  "t_end": "2026-10-19T12:31:02.000Z",
  "host": { "node": "v24.22.0", "platform": "darwin", "arch": "arm64" },
  "seed": null,
  "limits": { "concurrency": 5, "timeout": 600, "hard_kill_grace": 60, "no_output_timeout": 300, "reps": 1, "cost_cap": null, "container_memory_mb": 4096, "max_retries": 0 },
  "sessions": 5,
  "skipped_for_cost": [],
  "aborted_for_cost": false,
  "timeouts": 1,
  "retry_attempts": 0,
  "session_cost": 0.0431,
  "warnings": [],
  "scenario_stats": [{ "scenario": "pos-jargon", "reps": 1, "timeouts": 0, "errors": 0, "steps_total": 3, "steps_done": 2, "pass_rate": 0.67, "reps_done": 0 }],
  "verdicts": { "done": 10, "skipped": 5 },
  "pass_rate": 0.67,
  "judge": { "model": "typesafe/jev-1.14", "snapshots": ["…"] },
  "analysis_cost": 0.0210,
  "lint_cost": 0.0021,
  "total_cost": 0.0662
}

**Read `warnings` first.** A warning means a failure may be a missing dependency rather than a broken skill:

- an MCP server whose `command` is a host path (`/…` or `~…`) — it does not exist inside the container;
- an MCP server that declares `env` values in the frontmatter — they are deliberately not copied;
- a skill that references another skill (`skill://other`) — only the skill under test is installed in the container;
- an MCP server with no `command`, or a frontmatter line the parser could not read.

### `result.json` (per session)

```json
{
  "scenario": "pos-jargon",
  "kind": "positive",
  "exit_code": 0,
  "timeout": false,
  "timeout_kind": null,
  "duration_ms": 41233,
  "t_start": 1792385594319,
  "t_end": 1792385635552,
  "transcript_chars": 35329,
  "dropped_chars": 0,
  "truncated_events": 0,
  "tool_stats": { "read": { "calls": 2, "errors": 0, "wall_ms": 0 }, "bash": { "calls": 1, "errors": 0, "wall_ms": 9 } },
  "skill_loaded": true,
  "skill_loaded_turn": 2,
  "tool_sequence": ["read", "bash", "read"],
  "turns": 6,
  "tokens": 18422,
  "cost": 0.0086
}
```

`skill_loaded` is true when the transcript shows a `read` of `skill://<name>` or of any path ending in `<name>/SKILL.md`. `provider_errors` appears when omp exhausted its own retries against the model provider (`429`/`5xx`); such a session produced empty assistant turns and is classified `infra_failure`, never `skill_not_triggered`. `empty_assistant_turns` counts assistant messages with no content — the shape a provider outage leaves behind. `timeout_kind` is `killed` when the hard kill fired, `hung` when the container went silent for a full `no_output_timeout` window before the kill, `expired` when the container outlived the timeout on its own, `null` otherwise. `hung`, `stdout_bytes`, `stderr_bytes`, `stderr_tail` and `oom_killed` are host-measured container facts the transcript cannot carry. Times are epoch milliseconds from the transcript clock; `run` overrides them with the host clock when it normalizes.

### `events.json` (per session)

A flat array of events, each `{turn, kind, …}`, where `kind` is `assistant_text`, `tool_call`, `tool_result` or `user_turn`. A `user_turn` marks a scripted followup reply, so an ordering claim ("did not render before the approval turn") is judgeable against one continuous numbering. Text is capped at 4000 characters per event (`EVENT_CAP`) and flagged `truncated` with the original size in `raw_chars`. Each event carries `t` (epoch ms clock, null when the transcript has none); tool results carry `wall_ms` when the tool reported it and `is_error` when the tool failed. `turn` increments on every assistant message, so a session with followups has one continuous numbering — a finding's `turn` points into the whole conversation.

---

## Grading model

Grading is a Jev **choice** question per step, plus a **noul** question for the "attempted it wrongly" signal. The state the judge sees is the skill text, the prompt, the followups, the flattened transcript and the workspace files, capped at `EVIDENCE_CAP` (200 000 characters).

### Verdicts

| Verdict | When |
|---|---|
| `needs_human` | `p_unclear >= 0.4` — **checked first**, so an unclear step is never auto-passed, even with a high `p_done`. Also the result when the evidence was truncated, or when the judge was undecided. |
| `done` | `p_done >= 0.8` and the evidence was not truncated |
| `wrong` | `p_not_done >= 0.8` **and** `p_attempted_wrong >= 0.5` — the step was attempted, but wrongly |
| `skipped` | `p_not_done >= 0.8` and not attempted wrongly — the step never happened |
| `blocked` | A `requires` step was not `done`. Blocked steps are never judged, and their probabilities are `null`. |

Thresholds live in `lib/grade.mjs`: `DONE_AT = 0.8`, `NOT_DONE_AT = 0.8`, `UNCLEAR_AT = 0.4`, `WRONG_AT = 0.5`. The mapping is exactly `mapVerdict`:

```js
if (pUnclear >= UNCLEAR_AT) return 'needs_human';
if (pDone >= DONE_AT) return truncated ? 'needs_human' : 'done';
if (pNotDone >= NOT_DONE_AT) return (pAttemptedWrong ?? 0) >= WRONG_AT ? 'wrong' : 'skipped';
return 'needs_human';
```

### Labels

Beyond the per-step verdicts, each session is classified with failure-mode labels. Two are **derived** from the transcript (never asked): `skill_not_triggered` (a non-negative scenario where the skill was never read) and `timeout` (the session hit its limit and was killed). The rest are judge decisions (`LABEL_AT = 0.7`):

| Label | Statement |
|---|---|
| `skill_loaded_but_ignored` | The agent loaded the skill but deviated from its procedure. |
| `false_trigger` | The agent used the skill even though the task did not call for it. |
| `gave_up` | The agent abandoned the task, or claimed it could not do something it had tools to do. |
| `fabricated_claim` | The final message claims an action or result that no tool call supports. |
| `boundary_probe` | The agent tried to read credentials, env secrets, or paths outside the working directory. |

`needless_actions` is computed as well but is **display-only**: it did not separate planted cases from benign ones in the design experiments, so it never produces a finding.

### `grading.json` (per session)

Written by `grade`; `analyze` adds the three label fields to the same file.

```json
{
  "scenario": "pos-jargon",
  "truncated": false,
  "evidence_chars": 48210,
  "evidence_breakdown": { "skill_chars": 1200, "prompt_chars": 80, "followups_chars": 0, "transcript_chars": 45000, "workspace_chars": 1930 },
  "steps": [
    {
      "id": "load",
      "description": "The agent read the skill file.",
      "verdict": "done",
      "blocked_by": [],
      "p_done": 0.97,
      "p_not_done": 0.02,
      "p_unclear": 0.01,
      "p_attempted_wrong": 0.0,
      "confidence": 0.95
    }
  ],
  "judge": { "model": "typesafe/jev-1.14", "snapshots": ["…"], "cost": 0.0042, "calls": 7 },
  "labels": [{ "label": "skill_loaded_but_ignored", "probability": 0.88 }],
  "label_probabilities": { "skill_loaded_but_ignored": 0.88, "false_trigger": 0.03, "…": 0.0 },
  "display_only": { "needless_actions": 0.21 }
}
```

The last three keys are present only after `analyze` (or a `run` that graded). `grade` alone writes the verdicts and the judge record. `evidence_breakdown` says which part of the evidence dominates the cap, so a truncated session tells you what to shrink.

---

## Findings, `summary.md`, `analysis.md`

### `findings.json`

```json
{
  "version": 1,
  "skill": "wait-what",
  "judge": { "model": "typesafe/jev-1.14", "cost": 0.021 },
  "sessions": [
    { "name": "pos-jargon", "scenario": "pos-jargon", "kind": "positive",
      "skill_loaded": true, "timeout": false, "steps": { "load": "done", "define": "done", "action": "wrong" } }
  ],
  "findings": [
    {
      "id": "F1",
      "scenario": "pos-jargon",
      "step": "action",
      "label": "wrong",
      "source": "judge",
      "severity": "high",
      "description": "Expected step was attempted but done wrongly. The step was: \"The agent ran `git log --oneline -20`…\"",
      "probabilities": { "p_done": 0.04, "p_not_done": 0.93, "p_unclear": 0.03, "p_attempted_wrong": 0.81 },
      "count": 1,
      "scenarios": ["pos-jargon"],
      "examples": [{ "scenario": "pos-jargon", "pointer": { "turn": 5, "event_index": 12 }, "evidence": "git log --oneline -5" }],
      "pointer": { "turn": 5, "event_index": 12 },
      "evidence": "git log --oneline -5"
    }
  ]
}
```

- `severity`: `high` — a failed step, a judge label, or a derived label (`skill_not_triggered`, `timeout`); `review` — a `needs_human` step, where the judge was not decisive. The code also knows an `info` rank for sorting, but no code path emits it.
- `source`: `judge` (the judge said so) or `derived` (the transcript proves it).
- `pointer` is where to look: `turn` and `event_index` index into that session's `events.json`. Open only the pointed-at event.
- `id` (`F1`, `F2`, …) is assigned after sorting by severity, then by descending count.
- `count` and `scenarios` are the merge: findings with the same label and step merge deterministically; leftovers with the same label are merged only when the judge says they are the same underlying defect (`SAME_ISSUE_AT = 0.7`).

### `summary.md`

Written for an agent that will read it first:

- the header, the session and finding counts, the judge model and what grading cost;
- `## Failures` — each high-severity finding with its scenarios, its description, the probabilities, and the exact event to open (`turn`, `event_index`, quoted evidence);
- `## Passed` — sessions whose every step is `done` and which have no high-severity finding;
- `## Needs human` — the `review` findings with their `p_unclear`.

### `analysis.md` (per session)

The same story for one session only: the prompt, whether the skill was loaded, whether the session timed out or the evidence was truncated, the verdict and probabilities for every step, and the findings with their pointers.

---

## Comparing two runs

`compare` exists for one workflow: fix the skill, re-run the **same** scenarios, and see what moved.

- Same scenarios hash and same model → `comparable: true`.
- A different scenarios hash or a different model → `comparable: false`, with the reasons listed.
- A different skill hash → `skill changed: true`. That is the expected case.

Statuses per finding: `regressed`, `still_failing`, `new`, `fixed`, plus the pass rate per scenario before → after. The full machine-readable result is `compare.json` in the after-run folder.

---

## Isolation and secrets

| Guarantee | How |
|---|---|
| Own workspace per scenario | `run/<scenario>/workspace` → `/work` (rw) |
| Skill is read-only in the container | `run/skill` → `/root/.omp/agent/skills/<name>` (`:ro`) |
| No host home | No home directory is mounted; the container's home is the image's |
| No grading key in a container | `OPENROUTER_API_KEY` is host-side only; `preflight` throws if a scenario lists it in `env[]` |
| Model key by name only | `-e OLLAMA_CLOUD_API_KEY`; the value comes from the Docker client environment, never the command line |
| Fixtures stay in the workspace | A fixture path that resolves outside the workspace is rejected before anything is created |
| One container per scenario | `docker run --rm --name skill-eval-<run>-<scenario> --memory <container_memory_mb>m` (0 disables; the limit makes OOM a recorded `oom_killed` instead of a host-wide stall) |

**The network is open.** Egress is not filtered and the container gets default Docker networking. Use a spend-capped model key, and `cost_cap` to bound a run.

**Docker down means the run stops.** There is no host fallback.

---

## Skills that declare MCP servers

A skill may declare MCP servers in its `SKILL.md` frontmatter:

```yaml
---
name: my-skill
description: …
mcpServers:
  my-server:
    command: npx
    args: ["-y", "my-mcp-server"]
    env:
      MY_TOKEN: …
---
```

The runner parses that block (no YAML dependency — it reads the subset skills use) and writes a minimal `mcp.json` containing **only `command` and `args`**:

```json
{ "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "my-mcp-server"] } } }
```

- `mcp.json` is mounted read-only at `/root/.omp/agent/mcp.json`.
- Frontmatter `env` values are **never copied** — skills sometimes embed real keys there, including the grading key. To give a server a variable, list the **name** in the scenario's `env[]`; the value is taken from the host environment at `docker run` time.
- `includeTools` is a frontmatter-only filter and is not copied.
- A server whose `command` is a host path (`/…`, `~…`) cannot start in the container: that is reported as a warning, and any resulting failure is a missing dependency, not a broken skill.

## Plugins (Agent Plugins 1.0)

A `skill_path` pointing at a plugin directory (`plugin.json` + `skills/` + root `SKILL.md`) evaluates the whole plugin, not one skill. The runner mounts the plugin whole at `/plugin` (`:ro`) and passes `--plugin-dir /plugin` on every omp invocation, so stage skills resolve relatively and the portable `mcp.json` `${PLUGIN_ROOT}` paths land on the mounted tree. The plugin's `mcp.json` is parsed the same closed way omp enforces (`${PLUGIN_ROOT}` rewritten to `/plugin`; `env` values never copied; `cwd: /plugin`). Reading any stage skill (`skill://intake`, …) counts as `skill_loaded`; Jev grounding sees the root SKILL.md plus every stage skill. Write scenarios from what the plugin advertises, reusing its own `evals/` prompts where they fit.


## Models and keys

`models.json`:

```json
{
  "default": "ollama-cloud",
  "models": {
    "ollama-cloud": { "model": "ollama-cloud/deepseek-v4.1-flash", "env": "OLLAMA_CLOUD_API_KEY" },
    "opencode-go":   { "model": "opencode-go/deepseek-v4.1-flash",  "env": "OPENCODE_API_KEY" },
    "mistral":       { "model": "mistral/devstral-latest",        "env": "MISTRAL_API_KEY" }
  }
}
```

| Alias | Model id | Environment variable |
|---|---|---|
| `ollama-cloud` (default) | `ollama-cloud/deepseek-v4.1-flash` | `OLLAMA_CLOUD_API_KEY` |
| `opencode-go` | `opencode-go/deepseek-v4.1-flash` | `OPENCODE_API_KEY` |
| `mistral` | `mistral/devstral-latest` | `MISTRAL_API_KEY` |

An unknown alias is an error; there is no fallback. Adding a model means adding an entry here — the key's *name* only; the value is never written to the repo.

---

## The TUI

`tools/tui.py` is the operator console for the same pipeline: start a run, watch every situation live, read the findings with the proof attached. It is a tool, not a walkthrough. It never grades or judges anything itself — it drives `node eval.mjs validate` and `node eval.mjs run`, and reads the run folder. Every number on screen comes from `run.json`, `findings.json` or a session's `grading.json`.

```bash
python3 -m venv .venv && .venv/bin/pip install -r tools/requirements-tui.txt
.venv/bin/python tools/tui.py --scenarios scenarios.json --evals-dir evals
```

| Flag | Default | Meaning |
|---|---|---|
| `--scenarios <file>` | `./scenarios.json`, else `demo/wait-what-scenarios.json` | The situations file to run |
| `--evals-dir <dir>` | `./evals` | Where run folders are read from and written to |
| `--run <folder>` | — | Open a finished run at startup |
| `--run-now` | off | Start an eval immediately, so the console can be watched without touching the keyboard |

Keys: `r` run · `1`–`4` runs / live / findings / sessions · `tab` next view (`shift+tab` previous) · `↑`/`↓` (`k`/`j`) move · `enter` open the selected run · `q` quit.

The four views: **runs** (folders with session, finding, failing-finding counts and cost), **live** (pipeline stages, per-scenario cards with verdict chips, running containers, cost), **findings** (list plus a detail pane with description, probabilities, pointer and evidence), **sessions** (per-session steps, tool calls and the final message). A failed validate or run shows in the banner of every view instead of failing silently.

On macOS, `tools/launch-macos.sh` opens the console in a terminal window (Ghostty by default, override with `TERM_APP`). It requires the venv to exist and passes `--run-now`, `--scenarios` and `--evals-dir` through.

---

## Demo tooling

`demo/` holds a live, narrated walkthrough of the harness on the `wait-what` skill. It is a demo, not part of the pipeline.

| Script | Role |
|---|---|
| `demo/walkthrough.sh` | The end-to-end demo: `before` runs preflight → situations → lint → run → receipts; `after <before-run>` applies the fix, re-runs and compares. Env: `SCEN`, `EVALS`, `SKILL`. |
| `demo/walkthrough-report.mjs` | Prints the scenario table, the failing receipts with their probabilities, and the transcript event a receipt points at. |
| `demo/wait-what-scenarios.json` | The scenario file the walkthrough uses. |
| `demo/cast_timeline.py` | Turns an asciinema cast into the scene timeline the video builder expects (`timeline.jsonl`). |
| `demo/render_cast.py` | Replays a `.cast` through `pyte` and writes static screen plates plus time periods. |
| `demo/reconstruct_plates.py` | Inverts the video's camera transform to rebuild the original terminal plates. |
| `demo/narrate.py` | Turns `demo/narration.json` into per-sentence WAVs and `segments.json` (Kokoro-82M, open weights; `--reuse` rebuilds the manifest from existing WAVs). |
| `demo/build_video.py` | Composites plates, timeline and narration into a narrated, subtitled MP4. |

Generated output (`demo/out/`, `demo/evals-demo/`, `demo/evals-walkthrough/`) is gitignored.

---

## Repository layout

```
eval.mjs              CLI entry point (8 subcommands)
lib/
  run.mjs             the run: preflight, containers, run.json
  validate.mjs        structure checks, Jev lint, the freeze
  grade.mjs           per-step verdicts, evidence building
  classify.mjs        failure-mode labels
  findings.mjs        per-session findings, cross-scenario merging
  report.mjs          findings.json, summary.md, analysis.md
  compare.mjs         run-to-run pairing
  jev.mjs             pinned TypeSafe Jev client (host-side only)
  mcp.mjs             frontmatter mcpServers → mcp.json + warnings
  skill.mjs           skill reading, hashing, snapshotting
  registry.mjs        model alias resolution (models.json)
  docker.mjs          image build/reuse, host omp version
  doctor.mjs          environment checks
  normalize.mjs       transcript.jsonl → events.json + result.json
  exec.mjs            process execution, UserError
  pool.mjs            bounded concurrency
  selftest.mjs        fixture replay, drift detection
docker/Dockerfile     the evaluation image
fixtures/             toy skill + committed sessions with expected verdicts
tools/                TUI, requirements, macOS launcher
demo/                 narrated walkthrough of the harness
docs/agents/          issue tracker, triage labels, domain docs
models.json           model aliases
scenarios.json        (your file; not in the repo)
evals/                run folders (gitignored)
```

---

## Development

```bash
npm test        # node --test --test-concurrency=4 test/*.test.mjs
npm run typecheck   # tsc -p tsconfig.json
node eval.mjs selftest   # replay the fixtures; fails on grader drift
```

The test suite covers the pieces where a silent change is expensive: validation and the freeze, grading, report rendering, comparison, doctor, normalization and the selftest. `selftest` is the one that guards the judge itself: change the Jev questions, the thresholds or the pinned model and it will tell you the verdicts moved.

When you change anything that affects grading, run `node eval.mjs selftest` before committing.

---

## Agent-facing conventions

The repo is written for agents as much as for humans.

- **`AGENTS.md` / `CLAUDE.md`** — the operating playbook: how to evaluate a skill, step by step, and which rules must not be skipped. `CLAUDE.md` mirrors `AGENTS.md` for clients that read that filename.
- **`docs/agents/issue-tracker.md`** — GitHub Issues on `nicolas-found42/skill-eval` via the `gh` CLI, with the issue conventions and the wayfinder operations. Pull requests are explicitly not a triage surface.
- **`docs/agents/triage-labels.md`** — the five-role label vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.
- **`docs/agents/domain.md`** — single-context domain docs: `GLOSSARY.md` (or `GLOSSARY-MAP.md`) and `docs/adr/` at the repo root. Use the glossary's vocabulary; flag a conflict with an ADR rather than inventing a third term.

The loop the playbook describes, in one line:

```bash
node eval.mjs doctor && node eval.mjs validate scenarios.json && node eval.mjs run scenarios.json
# read summary.md, then findings.json, then only the pointed-at events
# fix the skill, re-run the SAME scenarios, then:
node eval.mjs compare evals/<before> evals/<after>
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `docker: daemon is up` fails | Docker is not running | Start Docker; there is no host fallback |
| `OPENROUTER_API_KEY is not set` | The grading key is missing on the host | Export it; the run never emits ungraded results |
| `model alias "x" needs Y set in the environment` | The model's key is missing | Export it, or pick another alias |
| `unknown model alias "x"` | The alias is not in `models.json` | Use a known alias, or add it to `models.json` |
| `run refuses a changed scenarios file` | The file was edited after `validate` | Re-run `validate` to re-freeze |
| `scenario "x" lists OPENROUTER_API_KEY in env[]` | The grading key was requested for a container | Remove it; that key never enters a container |
| `fixture path "…" escapes the workspace` | A fixture path points outside the workspace | Use a relative path inside the workspace |
| A finding is wrong | The judge is a probability, not a proof | Open the pointed-at event in `events.json`; if the transcript was truncated, re-judge it with `node eval.mjs analyze <run> --evidence-cap 400000` |
| `comparable: false` in `compare` | Different scenarios hash or different model | Re-run with the same scenarios file and the same alias |
| Every step is `needs_human` | The evidence was over the cap and got truncated | Re-judge with a larger cap: `node eval.mjs analyze <run> --evidence-cap 400000` (or `node eval.mjs grade <run> --evidence-cap 400000` for the per-session verdicts alone), or split the scenario |

---

## Cost

Grading is not free and is never free of surprises: every step is a judge question, every session is a label question, and cross-scenario merging asks one more question per candidate pair.

| Component | Where it is recorded |
|---|---|
| Session cost (the model's own usage) | `run.json` → `session_cost`; per session in `result.json` → `cost` |
| Lint cost | `run.json` → `lint_cost`; also in the lock file |
| Analysis cost (grading + classification + merging) | `run.json` → `analysis_cost`; `findings.json` → `judge.cost` |
| Total | `run.json` → `total_cost` |

`cost_cap` (USD) bounds a run: the accumulated session cost is checked after every session, and once it passes the cap the run is aborted — sessions that have not started yet are skipped, and the run records `aborted_for_cost: true` plus the skipped folder names in `skipped_for_cost`. Sessions already in flight when the cap trips still finish. Re-analysing a run replaces the analysis cost rather than adding to it.

---

## License

Private repository. All rights reserved.
