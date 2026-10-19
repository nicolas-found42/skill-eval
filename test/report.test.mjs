import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cli, tmpdir, readJson, writeJson, ROOT } from './helpers.mjs';

const SESSIONS = path.join(ROOT, 'fixtures', 'sessions');
const TOY = path.join(ROOT, 'fixtures', 'toy-skill', 'pirate-notes');
/** @type {Record<string, string>} */
const ENV = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' };

/** Assemble a run folder from named fixture sessions; `analyze` (grade + classify + report) is the seam under test. */
function runFrom(names) {
  const run = tmpdir('report-');
  for (const n of names) fs.cpSync(path.join(SESSIONS, n), path.join(run, n), { recursive: true });
  for (const n of names) fs.rmSync(path.join(run, n, 'expected.json'));
  fs.cpSync(TOY, path.join(run, 'skill'), { recursive: true });
  writeJson(path.join(run, 'run.json'), { skill: { name: 'pirate-notes', path: TOY }, skill_hash: 'a'.repeat(64), scenarios_hash: 'b'.repeat(64), model: { alias: 'ollama-cloud', model: 'ollama-cloud/deepseek-v4.1-flash' }, session_cost: 0.01 });
  return run;
}
const analyze = (run, env = ENV) => cli(['analyze', run], { env });
const findings = run => readJson(path.join(run, 'findings.json')).findings;
const labelsOf = (run, scenario) => findings(run).filter(f => f.scenario === scenario && f.label).map(f => f.label);

test('a clean run produces no findings and a summary that says so', async () => {
  const run = runFrom(['intact']);
  const r = await analyze(run);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(findings(run).filter(f => f.severity !== 'info'), []);
  assert.match(fs.readFileSync(path.join(run, 'summary.md'), 'utf8'), /no failures/i);
});

test('a skipped step becomes a skipped finding pointing at the exact turn', async () => {
  const run = runFrom(['no_wc']);
  await analyze(run);
  const f = findings(run).find(x => x.scenario === 'no_wc' && x.step === 'wc');
  assert.equal(f.label, 'skipped');
  assert.equal(typeof f.pointer.turn, 'number');
  assert.equal(typeof f.pointer.event_index, 'number');
  assert.ok(f.probabilities.p_not_done >= 0.8);
  assert.ok(f.evidence.length > 0, 'a finding carries an evidence quote');
  const events = readJson(path.join(run, 'no_wc', 'events.json'));
  assert.ok(f.pointer.event_index >= 0 && f.pointer.event_index < events.length, 'pointer lands inside events.json');
  assert.notEqual(events[f.pointer.event_index].kind, 'tool_result', 'a skipped step must not point at a tool result that merely quotes the command (e.g. the skill file read)');
});

/** A run folder the way `run` leaves it: scenarios.json plus the lock `validate` wrote for it. */
function lockedRun(names) {
  const run = runFrom(names);
  const scenarios = JSON.stringify({ skill_path: TOY, scenarios: [] });
  fs.writeFileSync(path.join(run, 'scenarios.json'), scenarios);
  writeJson(path.join(run, 'scenarios.lock.json'), { version: 1, scenarios_hash: crypto.createHash('sha256').update(scenarios).digest('hex'), judge: { model: 'typesafe/jev-1.14', snapshots: ['typesafe/jev-1.14-20261014'] }, lint_cost: 0.0004 });
  return run;
}

test('analyze and grade refuse a run folder whose scenarios changed after they were frozen', async () => {
  const run = lockedRun(['intact']);
  fs.appendFileSync(path.join(run, 'scenarios.json'), ' ');
  for (const cmd of ['analyze', 'grade']) {
    const r = await cli([cmd, run], { env: ENV });
    assert.notEqual(r.code, 0, cmd);
    assert.match(r.stderr, /changed since validation|hash/i, cmd);
  }
  assert.ok(!fs.existsSync(path.join(run, 'findings.json')), 'nothing may be graded from tampered scenarios');
  assert.ok(!fs.existsSync(path.join(run, 'intact', 'grading.json')));
});

test('analyze records the judge model and the run total cost in run.json', async () => {
  const run = lockedRun(['intact']);
  const r = await analyze(run);
  assert.equal(r.code, 0, r.stderr);
  const rj = readJson(path.join(run, 'run.json'));
  const doc = readJson(path.join(run, 'findings.json'));
  assert.equal(rj.judge.model, 'typesafe/jev-1.14');
  assert.equal(rj.judge.snapshots.length >= 1, true);
  assert.ok(doc.judge.cost > 0);
  assert.ok(Math.abs(rj.total_cost - (0.01 + 0.0004 + doc.judge.cost)) < 1e-9, `total_cost ${rj.total_cost}`);
});

test('every session folder gets an analysis.md an agent can read alone: verdict per step with probabilities, labels, and the pointer into events.json', async () => {
  const run = runFrom(['no_wc', 'intact']);
  const r = await analyze(run);
  assert.equal(r.code, 0, r.stderr);
  const bad = fs.readFileSync(path.join(run, 'no_wc', 'analysis.md'), 'utf8');
  assert.match(bad, /wc.*skipped/is);
  assert.match(bad, /p_not_done=\d\.\d\d/);
  assert.match(bad, /events\.json.*turn \d+/is);
  const good = fs.readFileSync(path.join(run, 'intact', 'analysis.md'), 'utf8');
  assert.match(good, /no failures/i);
  assert.doesNotMatch(good, /skipped/i);
});

test('a positive scenario that never loaded the skill yields skill_not_triggered, derived from the transcript not the judge', async () => {
  const run = runFrom(['not_triggered']);
  await analyze(run);
  const f = findings(run).find(x => x.scenario === 'not_triggered' && x.label === 'skill_not_triggered');
  assert.ok(f, 'finding present');
  assert.equal(f.source, 'derived');
  assert.equal(f.severity, 'high');
});

test('a negative scenario that loaded the skill yields a false_trigger finding', async () => {
  const run = runFrom(['false_trigger']);
  await analyze(run);
  assert.ok(labelsOf(run, 'false_trigger').includes('false_trigger'), labelsOf(run, 'false_trigger').join(','));
});

test('a timed-out session yields a derived timeout finding', async () => {
  const run = runFrom(['timed_out']);
  await analyze(run);
  const f = findings(run).find(x => x.scenario === 'timed_out' && x.label === 'timeout');
  assert.ok(f);
  assert.equal(f.source, 'derived');
});

test('a fabricated claim and a give-up are classified; every recorded label carries p >= 0.7', async () => {
  const run = runFrom(['fabricated', 'gave_up']);
  await analyze(run);
  assert.ok(labelsOf(run, 'fabricated').includes('fabricated_claim'));
  assert.ok(labelsOf(run, 'gave_up').includes('gave_up'));
  for (const f of findings(run).filter(x => x.source === 'judge' && x.label && x.step == null)) assert.ok(f.probability >= 0.7, `${f.label} ${f.probability}`);
});

test('boundary probing is surfaced as a finding', async () => {
  const run = runFrom(['boundary']);
  await analyze(run);
  assert.ok(labelsOf(run, 'boundary').includes('boundary_probe'));
});

test('needless_actions is kept as display-only data and never becomes a finding', async () => {
  const run = runFrom(['false_trigger', 'fabricated', 'boundary']);
  await analyze(run);
  assert.ok(!findings(run).some(f => f.label === 'needless_actions'));
  const g = readJson(path.join(run, 'false_trigger', 'grading.json'));
  assert.equal(typeof g.display_only.needless_actions, 'number');
});

test('the same missing step across scenarios is merged into one finding with a count', async () => {
  const run = runFrom(['no_wc', 'fabricated']);
  await analyze(run);
  const wc = findings(run).filter(f => f.label === 'skipped' && f.step === 'wc');
  assert.equal(wc.length, 1, 'merged into a single finding');
  assert.equal(wc[0].count, 2);
  assert.deepEqual(wc[0].scenarios.sort(), ['fabricated', 'no_wc']);
});

test('different problems are not merged: a skipped wc and a missing signature stay separate', async () => {
  const run = runFrom(['no_wc', 'no_sign']);
  await analyze(run);
  const steps = findings(run).filter(f => ['skipped', 'wrong'].includes(f.label)).map(f => f.step).sort();
  assert.deepEqual(steps, ['signed', 'wc']);
});

test('summary lists failures before passes and puts needs-human last', async () => {
  const run = runFrom(['intact', 'no_wc', 'not_triggered']);
  await analyze(run);
  const md = fs.readFileSync(path.join(run, 'summary.md'), 'utf8');
  const fail = md.search(/## Failures/i), pass = md.search(/## Passed/i);
  assert.ok(fail >= 0 && pass > fail, 'failures section precedes passes');
  const nh = md.search(/## Needs human/i);
  if (nh >= 0) assert.ok(nh > pass);
  assert.match(md, /skill_not_triggered/);
  assert.match(md, /no_wc/);
});

test('analyze fails clearly without the grading key and writes no findings', async () => {
  const run = runFrom(['intact']);
  const r = await analyze(run, {});
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
  assert.ok(!fs.existsSync(path.join(run, 'findings.json')));
  assert.ok(!fs.existsSync(path.join(run, 'summary.md')));
});

test('analyze --evidence-cap bounds what the judge sees: an over-cap transcript is truncated and no step auto-passes', async () => {
  const run = runFrom(['intact']);
  const r = await cli(['analyze', run, '--evidence-cap', '1'], { env: ENV });
  assert.equal(r.code, 0, r.stderr);
  const g = readJson(path.join(run, 'intact', 'grading.json'));
  assert.equal(g.truncated, true);
  assert.ok(g.steps.every(s => s.verdict !== 'done'), 'truncated evidence never auto-passes a step');
});

test('analyze refuses an evidence cap that is not a positive number', async () => {
  const run = runFrom(['intact']);
  const r = await cli(['analyze', run, '--evidence-cap', 'abc'], { env: ENV });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /evidence-cap/);
});
