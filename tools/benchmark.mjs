/**
 * Latency baseline for the three latency-critical local-compute paths:
 *
 *   1. readSkill        (lib/skill.mjs)    — skill/plugin identity hashing; runs in `validate` and `run`
 *   2. normalizeSession (lib/normalize.mjs) — per-session transcript normalization; runs once per session in `run`
 *   3. grade evidence   (lib/grade.mjs)    — flatten + readWorkspace + buildEvidence; runs once per session in `grade`
 *
 * Zero external dependencies: Node builtins plus the lib modules under test.
 * Each path runs REPS times against realistic fixtures recovered from a recorded
 * eval run; wall-clock latency is measured per iteration with
 * `performance.now()` (sub-millisecond) and resident memory via
 * `process.memoryUsage().rss` sampled before/after each batch.
 *
 * Usage:  node tools/benchmark.mjs [--reps 1000] [--out fixtures/baseline-latency.json]
 *         --check <fixture> compares against a recorded baseline and exits 1 on regression.
 *
 * The JSON fixture is the durable baseline: future PRs compare against the p99
 * and mean recorded here on the same machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { readSkill } from '../lib/skill.mjs';
import { normalizeSession, parseJsonl, normalizeEvents } from '../lib/normalize.mjs';
import { flatten, readWorkspace, buildEvidence } from '../lib/grade.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const argVal = name => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const REPS = Number(argVal('--reps') ?? 1000);
const OUT = argVal('--out') ?? path.join(ROOT, 'fixtures', 'baseline-latency.json');
const CHECK = argVal('--check');
// Regression threshold: a path regresses when its mean exceeds the baseline
// mean by more than this fraction (timer noise on shared machines is a few %).
const REGRESSION_TOLERANCE = Number(argVal('--tolerance') ?? 0.25);

// --- fixture discovery ----------------------------------------------------
// Realistic inputs are recovered from the newest recorded eval run under
// evals/: a skill/plugin directory, a session transcript, and a session
// workspace. Nothing here is synthesized; sizes match production inputs.
function newestRunDir() {
  const evalsDir = path.join(ROOT, 'evals');
  const runs = fs.readdirSync(evalsDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()
    .reverse();
  for (const name of runs) {
    const dir = path.join(evalsDir, name);
    if (fs.existsSync(path.join(dir, 'skill', 'SKILL.md'))) return dir;
  }
  throw new Error('no recorded eval run with a skill/ directory under evals/; run an eval first');
}

function firstSessionWithTranscript(runDir) {
  const entries = fs.readdirSync(runDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
  for (const name of entries) {
    const dir = path.join(runDir, name);
    if (fs.existsSync(path.join(dir, 'transcript.jsonl')) && fs.existsSync(path.join(dir, 'scenario.json'))) {
      return dir;
    }
  }
  throw new Error(`no session with transcript.jsonl under ${runDir}`);
}

const RUN_DIR = newestRunDir();
const SKILL_DIR = path.join(RUN_DIR, 'skill');
const SESSION_DIR = firstSessionWithTranscript(RUN_DIR);

// normalizeSession writes events.json/result.json/turns.json into the session
// dir, so the benchmark works on a scratch copy and never mutates evals/.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-eval-bench-'));
fs.cpSync(SESSION_DIR, SCRATCH, { recursive: true });
for (const f of ['events.json', 'result.json', 'turns.json', 'events.full.json']) {
  fs.rmSync(path.join(SCRATCH, f), { force: true });
}

// --- measurement helpers --------------------------------------------------
const percentile = (sorted, p) => {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
};

const rss = () => process.memoryUsage().rss;

/**
 * Time `fn` REPS times. Per-iteration wall clock in ms (float, performance.now)
 * and a coarse RSS delta sampled around the whole batch (a single iteration's
 * allocation is mostly sub-KB and invisible against allocator noise).
 */
function measure(name, fn) {
  // Warmup: JIT + page cache. 10% of reps, capped, never recorded.
  const warmup = Math.min(REPS, Math.max(20, Math.floor(REPS / 10)));
  for (let i = 0; i < warmup; i++) fn();

  const samples = new Array(REPS);
  // Drop the outputs so nothing accumulates across iterations; the paths under
  // test are pure with respect to retained state.
  const rssBefore = rss();
  for (let i = 0; i < REPS; i++) {
    const t0 = performance.now();
    fn();
    samples[i] = performance.now() - t0;
  }
  const rssAfter = rss();
  globalThis.gc?.(); // no-op unless --expose-gc; RSS delta is batch-level anyway

  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / REPS;
  return {
    path: name,
    reps: REPS,
    latency_ms: {
      min: sorted[0],
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
      mean,
    },
    rss_delta_bytes: rssAfter - rssBefore,
  };
}

// --- the three paths ------------------------------------------------------
// Pre-loaded inputs: parsing the transcript is part of path 2's cost in
// production only once (normalizeSession reads + parses), so path 2 measures
// the full normalizeSession including parseJsonl; paths 1 and 3 receive their
// inputs pre-read, matching how `run`/`grade` actually call them.

const transcriptRaw = fs.readFileSync(path.join(SCRATCH, 'transcript.jsonl'), 'utf8');
const scenarioJson = JSON.parse(fs.readFileSync(path.join(SCRATCH, 'scenario.json'), 'utf8'));
const { records } = parseJsonl(transcriptRaw);
const normalized = normalizeEvents(records, { skillName: scenarioJson.skill, skillNames: scenarioJson.skill_names });
const skillForEvidence = readSkill(SKILL_DIR);
const workspace = readWorkspace(SCRATCH);

const results = [
  measure('readSkill (skill/plugin identity hash)', () => readSkill(SKILL_DIR)),
  measure('normalizeSession (transcript -> events/result)', () => normalizeSession(SCRATCH)),
  measure('grade evidence (flatten + readWorkspace + buildEvidence)', () => {
    const flat = flatten(normalized.events);
    const ws = readWorkspace(SCRATCH);
    return buildEvidence({
      skill: skillForEvidence,
      scenario: scenarioJson,
      events: normalized.events,
      workspace: ws,
    });
  }),
];

fs.rmSync(SCRATCH, { recursive: true, force: true });

// --- record ---------------------------------------------------------------
const baseline = {
  recorded_at: new Date().toISOString(),
  machine: {
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpu_count: os.cpus().length,
    total_mem_bytes: os.totalmem(),
    node: process.version,
  },
  inputs: {
    run_dir: path.relative(ROOT, RUN_DIR),
    skill_dir: path.relative(ROOT, SKILL_DIR),
    session_dir: path.relative(ROOT, SESSION_DIR),
    transcript_bytes: Buffer.byteLength(transcriptRaw),
    transcript_records: records.length,
    events: normalized.events.length,
    workspace_files: Object.keys(workspace).length,
    skill_text_chars: skillForEvidence.text.length,
  },
  reps: REPS,
  paths: results,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(baseline, null, 2) + '\n');

// --- report ---------------------------------------------------------------
const fmt = n => (n < 0.001 ? n.toExponential(2) : n.toFixed(3));
console.log(`baseline written to ${path.relative(ROOT, OUT)}`);
console.log(`machine: ${baseline.machine.cpu} (${baseline.machine.cpu_count} cores), node ${process.version}, ${REPS} reps/path\n`);
console.log('| path | p50 ms | p95 ms | p99 ms | mean ms | max ms | RSS delta (batch) |');
console.log('|---|---|---|---|---|---|---|');
for (const r of results) {
  console.log(`| ${r.path} | ${fmt(r.latency_ms.p50)} | ${fmt(r.latency_ms.p95)} | ${fmt(r.latency_ms.p99)} | ${fmt(r.latency_ms.mean)} | ${fmt(r.latency_ms.max)} | ${(r.rss_delta_bytes / 1024).toFixed(1)} KiB |`);
}

// --- check mode -----------------------------------------------------------
if (CHECK) {
  const base = JSON.parse(fs.readFileSync(CHECK, 'utf8'));
  console.log(`\ncheck against ${path.relative(ROOT, CHECK)} (tolerance +${(REGRESSION_TOLERANCE * 100).toFixed(0)}% mean):`);
  let failed = false;
  for (const r of results) {
    const b = base.paths.find(p => p.path === r.path);
    if (!b) { console.log(`  ? ${r.path}: not in baseline`); continue; }
    const ratio = r.latency_ms.mean / b.latency_ms.mean;
    const ok = ratio <= 1 + REGRESSION_TOLERANCE;
    if (!ok) failed = true;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${r.path}: mean ${fmt(r.latency_ms.mean)} ms vs baseline ${fmt(b.latency_ms.mean)} ms (${(ratio * 100).toFixed(1)}%)`);
  }
  process.exit(failed ? 1 : 0);
}
