import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserError } from './exec.mjs';
import { Jev } from './jev.mjs';
import { analyzeRun } from './report.mjs';
import { ROOT } from './registry.mjs';

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const asList = v => (Array.isArray(v) ? v : [v]);

/**
 * Replay the committed mutation fixtures through the real grading pipeline and compare against the answers known
 * by construction. Throws a UserError listing every drift. Run it after changing questions, thresholds or the judge model.
 * @param {{ fixturesDir?: string, jev?: Jev }} [opts]
 */
export async function selftest({ fixturesDir = path.join(ROOT, 'fixtures'), jev = new Jev() } = {}) {
  const sessionsDir = path.join(fixturesDir, 'sessions');
  const names = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort();

  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'selftest-'));
  const expected = {};
  for (const n of names) {
    fs.cpSync(path.join(sessionsDir, n), path.join(run, n), { recursive: true });
    expected[n] = readJson(path.join(run, n, 'expected.json'));
    fs.rmSync(path.join(run, n, 'expected.json'));
  }
  fs.cpSync(path.join(fixturesDir, 'toy-skill', 'pirate-notes'), path.join(run, 'skill'), { recursive: true });
  fs.writeFileSync(path.join(run, 'run.json'), JSON.stringify({ skill: { name: 'pirate-notes' } }));

  const doc = await analyzeRun(run, { jev });
  const drifts = [];
  for (const n of names) {
    const grading = readJson(path.join(run, n, 'grading.json'));
    const got = Object.fromEntries(grading.steps.map(s => [s.id, s.verdict]));
    for (const [step, want] of Object.entries(expected[n].steps ?? {})) {
      const ok = asList(want).includes(got[step]);
      if (!ok) drifts.push(`${n}: step "${step}" expected ${asList(want).join(' or ')}, got ${got[step]}`);
    }
    const labels = new Set(doc.findings.filter(f => f.scenarios.includes(n) && f.label).map(f => f.label));
    for (const l of expected[n].labels_include ?? []) if (!labels.has(l)) drifts.push(`${n}: expected label ${l} was not recorded (got: ${[...labels].join(', ') || 'none'})`);
    for (const l of expected[n].labels_exclude ?? []) if (labels.has(l)) drifts.push(`${n}: label ${l} must not be recorded but was`);
  }
  fs.rmSync(run, { recursive: true, force: true });
  if (drifts.length) throw new UserError(`selftest failed: ${drifts.length} drift(s) from the known answers:\n- ${drifts.join('\n- ')}`);
  return { sessions: names.length, cost: doc.judge.cost };
}
