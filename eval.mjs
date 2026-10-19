#!/usr/bin/env node
import { UserError } from './lib/exec.mjs';
import { doctor } from './lib/doctor.mjs';
import { normalizeSession } from './lib/normalize.mjs';
import { runAll } from './lib/run.mjs';
import { validateFile } from './lib/validate.mjs';
import { gradeRun } from './lib/grade.mjs';
import { analyzeRun } from './lib/report.mjs';
import { compareRuns, renderCompare } from './lib/compare.mjs';
import { selftest } from './lib/selftest.mjs';
import { ROOT } from './lib/registry.mjs';
import path from 'node:path';

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

const COMMANDS = {
  async doctor({ flags }) { await doctor({ modelAlias: flags.model }); },
  async normalize({ pos, flags }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs normalize <session-dir> [--timed-out]');
    normalizeSession(pos[0], { timedOut: flags['timed-out'] === true });
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
    if (!pos[0]) throw new UserError('usage: eval.mjs analyze <run-folder> [--evidence-cap <chars>]');
    const doc = await analyzeRun(pos[0], { evidenceCap: evidenceCap(flags) });
    process.stdout.write(`analyzed ${doc.sessions.length} session(s): ${doc.findings.filter(f => f.severity === 'high').length} failing finding(s); see summary.md\n`);
  },
  async compare({ pos }) {
    if (pos.length < 2) throw new UserError('usage: eval.mjs compare <run-before> <run-after>');
    const c = await compareRuns(pos[0], pos[1]);
    process.stdout.write(renderCompare(c) + '\n');
  },
  async selftest({ flags }) {
    const r = await selftest({ fixturesDir: typeof flags.fixtures === 'string' ? flags.fixtures : undefined });
    process.stdout.write(`${r.sessions} sessions checked; judge cost $${r.cost.toFixed(4)}\nselftest passed\n`);
  },
  async grade({ pos, flags }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs grade <run-folder> [--evidence-cap <chars>]');
    const cap = evidenceCap(flags);
    const res = await gradeRun(pos[0], { evidenceCap: cap });
    process.stdout.write(`graded ${res.length} session(s)\n`);
  },
  async run({ pos, flags }) {
    if (!pos[0]) throw new UserError('usage: eval.mjs run <scenarios.json> [--evals-dir <dir>] [--skip-grading] [--evidence-cap <chars>]');
    const runDir = await runAll(pos[0], { evalsDir: typeof flags['evals-dir'] === 'string' ? flags['evals-dir'] : path.join(ROOT, 'evals') });
    process.stdout.write(`run folder: ${runDir}\n`);
    if (flags['skip-grading'] === true) return;
    const doc = await analyzeRun(runDir, { evidenceCap: evidenceCap(flags) });
    process.stdout.write(`analyzed ${doc.sessions.length} session(s): ${doc.findings.filter(f => f.severity === 'high').length} failing finding(s); read ${path.join(runDir, 'summary.md')}\n`);
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
