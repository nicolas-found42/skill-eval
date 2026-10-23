#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { UserError } from './lib/exec.mjs';
import { doctor } from './lib/doctor.mjs';
import { normalizeSession, normalizeStrandedSession } from './lib/normalize.mjs';
import { runAll } from './lib/run.mjs';
import { validateFile } from './lib/validate.mjs';
import { gradeRun } from './lib/grade.mjs';
import { analyzeRun } from './lib/report.mjs';
import { compareRuns, renderCompare } from './lib/compare.mjs';
import { selftest } from './lib/selftest.mjs';
import { diagnoseRun, diagnoseRunJson } from './lib/diagnose.mjs';
import { runQuery, runQueryWithMeta, indexAllRuns, openMetricsDb } from './lib/query.mjs';
import { archiveRuns } from './lib/archive.mjs';

import { ROOT } from './lib/registry.mjs';

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true; else { flags[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

/**
 * The evidence cap every grader command shares: how many characters of transcript, skill text and workspace
 * the judge may see. Unset means the default; a value that is not a positive number is a usage error, not a NaN.
 */
function evidenceCap(flags) {
  const raw = flags['evidence-cap'];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UserError('--evidence-cap must be a positive number of characters');
  return n;
}

/**
 * One line per run in the shared history file: the fields cross-run queries need without walking folders.
 * Lives at `<repo>/.evals-index.jsonl` so it survives the `evals/*` gitignore that keeps run folders local;
 * `--evals-dir` runs still append their own local `.index.jsonl` (see run.mjs) for folder-local history.
 */
function appendSharedIndex(runDir) {
  try {
    const run = JSON.parse(readFileSync(path.join(runDir, 'run.json'), 'utf8'));
    const line = JSON.stringify({
      run: path.basename(runDir),
      t_start: run.t_start ?? null,
      t_end: run.t_end ?? null,
      skill: run.skill?.name ?? null,
      skill_hash: run.skill_hash ?? null,
      scenarios_hash: run.scenarios_hash ?? null,
      model: run.model?.model ?? null,
      model_alias: run.model?.alias ?? null,
      sessions: run.sessions ?? 0,
      pass_rate: run.pass_rate ?? null,
      verdicts: run.verdicts ?? {},
    });
    // Replace the run's existing line, not append a second one: `run` calls this twice (before
    // and after grading) so the verdicts and pass_rate land, and a double append is what made
    // the root index count runs twice. One corrupt pre-existing line never blocks a run.
    const file = path.join(ROOT, '.evals-index.jsonl');
    let lines = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(l => {
        if (!l.trim()) return false;
        try { return JSON.parse(l).run !== path.basename(runDir); } catch { return true; }
      });
    } catch { /* no index yet */ }
    lines.push(line);
    writeFileSync(file, lines.join('\n') + '\n');
  } catch { /* the index is a convenience, never a failure */ }
}

const COMMANDS = {
  async index({ pos }) {
    const evalsDir = pos[0] ?? path.join(ROOT, 'evals');
    let names;
    try { names = readdirSync(path.resolve(evalsDir)); } catch { throw new UserError(`${evalsDir} does not exist or is not readable`); }
    const runs = [];
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const rf = path.join(path.resolve(evalsDir), n, 'run.json');
      if (!existsSync(rf)) continue;
      try {
        const run = JSON.parse(readFileSync(rf, 'utf8'));
        runs.push({ run: n, t_start: run.t_start ?? null, skill: run.skill?.name ?? null, model: run.model?.model ?? null, sessions: run.sessions ?? 0, timeouts: run.timeouts ?? 0, pass_rate: run.pass_rate ?? null, verdicts: run.verdicts ?? {} });
      } catch { runs.push({ run: n, error: 'unreadable run.json' }); }
    }
    process.stdout.write(JSON.stringify({ evals_dir: path.resolve(evalsDir), runs: runs.sort((a, b) => String(a.run).localeCompare(String(b.run))) }, null, 2) + '\n');
  },
  async query({ pos, flags }) {
    const queryType = pos[0];
    if (!queryType) throw new UserError('usage: eval.mjs query <type> [--evals-dir <dir>] [--skill <name>] [--since <ISO-date>] [--step <step-id>] [--min-failures <n>] [--min-runs <n>] [--limit <n>]\n  types: failing-steps, flaky-steps, error-classes, pass-rate-trend, slow-sessions, resource-usage, runs, provider-errors, recurring-failures');
    const defaultEvals = path.join(ROOT, 'evals');
    const evalsDir = typeof flags['evals-dir'] === 'string' ? flags['evals-dir'] : defaultEvals;
    const opts = {
      skill: typeof flags.skill === 'string' ? flags.skill : null,
      since: typeof flags.since === 'string' ? flags.since : null,
      stepId: typeof flags.step === 'string' ? flags.step : null,
      minFailures: flags['min-failures'] ? Number(flags['min-failures']) : 1,
      minRuns: flags['min-runs'] ? Number(flags['min-runs']) : 3,
      limit: flags.limit ? Number(flags.limit) : 10,
    };
    // The recurring-failures query clusters descriptions with the judge when asked to: the same
    // defect is often worded differently each time, and an exact match would miss it. Without
    // --judge the query stays free and offline, matching identical descriptions only.
    if (queryType === 'recurring-failures' && flags.judge === true) {
      const { Jev } = await import('./lib/jev.mjs');
      opts.jev = new Jev();
    }
    const { results, stale } = await runQueryWithMeta(evalsDir, queryType, opts);
    process.stdout.write(JSON.stringify({ evals_dir: path.resolve(evalsDir), query: queryType, opts: { ...opts, jev: opts.jev ? 'judge' : undefined }, results, stale }, null, 2) + '\n');
    if (stale.stale) {
      process.stdout.write(`\nwarning: the index is behind the runs on disk (${stale.runs_missing} run(s) not indexed: ${stale.missing_runs.slice(0, 3).join(', ')}${stale.missing_runs.length > 3 ? ', …' : ''}). Run \`node eval.mjs indexDb ${path.resolve(evalsDir)}\`.\n`);
    }
  },
  async indexDb({ pos, flags }) {
    const defaultEvals = path.join(ROOT, 'evals');
    const evalsDir = pos[0] ?? (typeof flags['evals-dir'] === 'string' ? flags['evals-dir'] : defaultEvals);
    const { indexed } = indexAllRuns(evalsDir);
    process.stdout.write(`indexed ${indexed} run(s) into ${path.join(path.resolve(evalsDir), '.metrics.db')}\n`);
  },
  async doctor({ flags }) { await doctor({ modelAlias: flags.model }); },
  async normalize({ pos, flags }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs normalize <session-dir> [--timed-out] [--timeout-kind <hung|killed|expired>] [--exit-code <n>]');
    // A session the harness never got to normalize: a transcript and a scenario, no result.
    // This is the command that brings it back into every aggregate.
    const dir = pos[0];
    const result = normalizeStrandedSession(dir, {
      timedOut: flags['timed-out'] === true,
      timeoutKind: typeof flags['timeout-kind'] === 'string' ? flags['timeout-kind'] : null,
      exitCode: flags['exit-code'] !== undefined ? Number(flags['exit-code']) : null,
    });
    process.stdout.write(`normalized ${dir}\n`);
    process.stdout.write(`  events: ${result.turns} turn(s), ${result.tool_results} tool result(s), ${result.assistant_texts} assistant text(s)\n`);
    process.stdout.write(`  wrote: events.json, turns.json, transcript.partial.txt, result.json\n`);
    if (result.provider_retries?.count) process.stdout.write(`  provider retries: ${result.provider_retries.count} (${result.provider_retries.recovered} recovered, ${result.provider_retries.total_delay_ms}ms delay)\n`);
  },
  async archive({ pos, flags }) {
    const defaultEvals = path.join(ROOT, 'evals');
    const evalsDir = pos[0] ?? (typeof flags['evals-dir'] === 'string' ? flags['evals-dir'] : defaultEvals);
    const keep = flags.keep ? Number(flags.keep) : 3;
    if (!Number.isFinite(keep) || keep < 0) throw new UserError('--keep must be a non-negative number of runs to keep uncompressed');
    const r = archiveRuns(evalsDir, { keep });
    process.stdout.write(`archived ${r.sessions} session transcript(s) across ${r.runs_archived} run(s); kept the ${r.runs_kept} newest uncompressed\n`);
    process.stdout.write(`  ${(r.bytes_before / 1e6).toFixed(1)} MB -> ${(r.bytes_after / 1e6).toFixed(1)} MB\n`);
  },
  async validate({ pos }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs validate <scenarios.json>');
    const lock = await validateFile(pos[0]);
    process.stdout.write(`frozen: ${pos[0]} (hash ${lock.scenarios_hash.slice(0, 12)}, lint cost $${lock.lint_cost.toFixed(5)})\n`);
    for (const m of lock.description_match) {
      const flag = m.expected_trigger ? (m.p < 0.5 ? '  LOW MATCH' : '') : (m.p >= 0.5 ? '  HIGH MATCH (negative)' : '');
      process.stdout.write(`  description match ${m.p.toFixed(2)}  ${m.scenario} [${m.kind}]${flag}\n`);
    }
  },
  async analyze({ pos, flags }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs analyze <run-folder> [--evidence-cap <chars>] [--keep-evidence]');
    const doc = await analyzeRun(pos[0], { evidenceCap: evidenceCap(flags), keepEvidence: flags['keep-evidence'] === true });
    process.stdout.write(`analyzed ${doc.sessions.length} session(s): ${doc.findings.filter(f => f.severity === 'high').length} failing finding(s); read ${path.join(pos[0], 'summary.md')}\n`);
  },
  async compare({ pos }) {
    if (pos.length < 2) throw new UserError('usage: eval.mjs compare <run-before> <run-after>');
    const c = await compareRuns(pos[0], pos[1]);
    process.stdout.write(renderCompare(c) + '\n');
  },
  async diagnose({ pos, flags }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs diagnose <run-folder> [--session <name>] [--json]');
    if (flags.json === true) process.stdout.write(JSON.stringify(diagnoseRunJson(pos[0], { session: typeof flags.session === 'string' ? flags.session : null }), null, 2) + '\n');
    else process.stdout.write(diagnoseRun(pos[0], { session: typeof flags.session === 'string' ? flags.session : null }) + '\n');
  },
  async selftest({ flags }) {
    const r = await selftest({ fixturesDir: typeof flags.fixtures === 'string' ? flags.fixtures : undefined });
    process.stdout.write(`${r.sessions} sessions checked; judge cost $${r.cost.toFixed(4)}\nselftest passed\n`);
  },
  async grade({ pos, flags }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs grade <run-folder> [--evidence-cap <chars>] [--keep-evidence]');
    const cap = evidenceCap(flags);
    const res = await gradeRun(pos[0], { evidenceCap: cap, keepEvidence: flags['keep-evidence'] === true });
    process.stdout.write(`graded ${res.length} session(s)\n`);
  },
  async run({ pos, flags }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs run <scenarios.json> [--evals-dir <dir>] [--skip-grading] [--evidence-cap <chars>] [--keep-evidence]');
    const defaultEvals = path.join(ROOT, 'evals');
    const evalsDir = typeof flags['evals-dir'] === 'string' ? flags['evals-dir'] : defaultEvals;
    const runDir = await runAll(pos[0], { evalsDir });
    process.stdout.write(`run folder: ${runDir}\n`);
    if (path.resolve(evalsDir) === path.resolve(defaultEvals)) appendSharedIndex(runDir);
    if (flags['skip-grading'] === true) return;
    const doc = await analyzeRun(runDir, { evidenceCap: evidenceCap(flags), keepEvidence: flags['keep-evidence'] === true });
    if (path.resolve(evalsDir) === path.resolve(defaultEvals)) appendSharedIndex(runDir);
    process.stdout.write(`analyzed ${doc.sessions.length} session(s): ${doc.findings.filter(f => f.severity === 'high').length} failing finding(s); read ${path.join(runDir, 'summary.md')}\n`);
  },
  async stream({ pos, flags }) {
    const { streamToStdout } = await import('./lib/stream.mjs');
    const runDir = pos[0];
    if (!runDir) throw new UserError('usage: eval.mjs stream <run-folder> [--session <name>]');
    const session = typeof flags.session === 'string' ? flags.session : null;
    process.stdout.write(`streaming events from ${runDir}${session ? ` (session: ${session})` : ''}...\n`);
    const stop = await streamToStdout(runDir, { session });
    // Run until Ctrl+C
    process.on('SIGINT', () => { stop(); process.exit(0); });
    await new Promise(() => {}); // never resolves; killed by SIGINT
  },
  async serve({ pos, flags }) {
    const { startStreamServer } = await import('./lib/stream.mjs');
    const runDir = pos[0];
    if (!runDir) throw new UserError('usage: eval.mjs serve <run-folder> [--port <n>]');
    const port = flags.port ? Number(flags.port) : 0;
    const { port: actualPort, close } = await startStreamServer(runDir, port);
    process.stdout.write(`streaming server listening on http://127.0.0.1:${actualPort}/events\n`);
    process.on('SIGINT', () => { close(); process.exit(0); });
    await new Promise(() => {});
  },
};

const { pos, flags } = parseArgs(process.argv.slice(2));
const name = pos[0];
try {
  if (!COMMANDS[name]) throw new UserError(`usage: eval.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
  await COMMANDS[name]({ pos: pos.slice(1), flags });
} catch (e) {
  if (e instanceof UserError) { process.stderr.write(`error: ${e.message}\n`); process.exit(1); }
  throw e;
}
