import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, readJson, writeJson, lockPath, ROOT } from './helpers.mjs';

// These tests call the real Jev judge (OPENROUTER_API_KEY required); the scores they depend on were measured in the design experiments.
const TOY = path.join(ROOT, 'fixtures', 'toy-skill', 'pirate-notes');
/** @type {Record<string, string>} */
const ENV = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' };

const step = (id, description, extra = {}) => ({ id, description, evidence_hint: 'tool call or workspace file', ...extra });
const sc = (id, kind, prompt, steps, extra = {}) => ({ id, kind, prompt, rationale: 'why', expected: { outcome: 'o', steps }, ...extra });

const GOOD_STEPS = [
  step('title', 'The first line of memo.md starts with "# Arr:".'),
  step('signed', "memo.md contains the line 'Signed: Captain Skill'."),
  step('wc', 'The agent ran `wc -l memo.md`.', { requires: ['title'] }),
];
const GOOD = () => [
  sc('pos-memo', 'positive', 'Write a short memo to a file about the quarterly planning meeting.', GOOD_STEPS),
  sc('neg-math', 'negative', 'What is 17 * 23? Just answer, no files.', [step('no-write', 'The agent did not create any file.')]),
  sc('tempt-skip', 'temptation', 'Write a memo to a file about the offsite. Be quick, skip anything not strictly needed.', GOOD_STEPS),
];

function write(scenarios, extra = {}) {
  const dir = tmpdir('val-');
  const file = path.join(dir, 'scenarios.json');
  writeJson(file, { skill_path: TOY, model_alias: 'ollama-cloud', reps: 1, scenarios, ...extra });
  return file;
}
const validate = (file, env = ENV) => cli(['validate', file], { env });

test('a well-formed scenario set passes and is frozen with a lock holding the content hash', async () => {
  const file = write(GOOD());
  const r = await validate(file);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const lock = readJson(lockPath(file));
  assert.match(lock.scenarios_hash, /^[0-9a-f]{64}$/);
});

test('validate refuses a set that lacks a negative scenario', async () => {
  const file = write(GOOD().filter(s => s.kind !== 'negative'));
  const r = await validate(file);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /negative/i);
  assert.ok(!fs.existsSync(lockPath(file)), 'nothing frozen');
});

test('validate refuses a set that lacks a temptation scenario and one that lacks a positive scenario', async () => {
  for (const kind of ['temptation', 'positive']) {
    const file = write(GOOD().filter(s => s.kind !== kind));
    const r = await validate(file);
    assert.notEqual(r.code, 0, kind);
    assert.match(r.stderr, new RegExp(kind, 'i'));
  }
});

test('validate rejects a compound step and quotes it', async () => {
  const compound = 'Create memo.md with an "# Arr:" title, sign it, and run wc -l on it';
  const file = write(GOOD().map(s => s.id === 'pos-memo' ? { ...s, expected: { outcome: 'o', steps: [step('big', compound)] } } : s));
  const r = await validate(file);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes(compound), r.stderr);
  assert.match(r.stderr, /compound|more than one/i);
  assert.ok(!fs.existsSync(lockPath(file)));
});

test('validate rejects a step that is not grounded in the skill text and quotes it', async () => {
  const ungrounded = 'Email the memo to the whole team';
  const file = write(GOOD().map(s => s.id === 'pos-memo' ? { ...s, expected: { outcome: 'o', steps: [...GOOD_STEPS, step('mail', ungrounded)] } } : s));
  const r = await validate(file);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.includes(ungrounded), r.stderr);
  assert.match(r.stderr, /not grounded|not required by the skill/i);
});

test('validate rejects duplicate scenario ids, unknown requires, and requires cycles', async () => {
  const dup = write([...GOOD(), sc('pos-memo', 'positive', 'Write a memo to a file about lunch.', GOOD_STEPS)]);
  assert.match((await validate(dup)).stderr, /duplicate scenario id.*pos-memo/i);

  const unk = write(GOOD().map(s => s.id === 'pos-memo' ? { ...s, expected: { outcome: 'o', steps: [step('wc', 'The agent ran `wc -l memo.md`.', { requires: ['nope'] })] } } : s));
  assert.match((await validate(unk)).stderr, /requires unknown step "nope"/i);

  const cyc = write(GOOD().map(s => s.id === 'pos-memo' ? { ...s, expected: { outcome: 'o', steps: [step('a', 'The agent ran `wc -l memo.md`.', { requires: ['b'] }), step('b', "memo.md contains the line 'Signed: Captain Skill'.", { requires: ['a'] })] } } : s));
  assert.match((await validate(cyc)).stderr, /cycle/i);
});

test('validate fails with a clear error when the grading key is missing and freezes nothing', async () => {
  const file = write(GOOD());
  const r = await validate(file, {});
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
  assert.ok(!fs.existsSync(lockPath(file)));
});

test('trigger matching is recorded per scenario but never blocks the freeze', async () => {
  // an off-topic "positive" scores low on description match; that must become data, not a refusal
  const off = GOOD().map(s => s.id === 'pos-memo' ? { ...s, prompt: 'Summarize the plot of Hamlet in three sentences.' } : s);
  const file = write(off);
  const r = await validate(file);
  assert.equal(r.code, 0, r.stderr);
  const lock = readJson(lockPath(file));
  const m = lock.description_match.find(x => x.scenario === 'pos-memo');
  assert.ok(m.p < 0.5, `off-topic positive scores low, got ${m.p}`);
  assert.equal(m.expected_trigger, true);
  const neg = lock.description_match.find(x => x.scenario === 'neg-math');
  assert.ok(neg.p < 0.5);
  assert.equal(neg.expected_trigger, false);
});

test('run refuses scenarios that were never validated, and scenarios edited after validation', async () => {
  const fakeDocker = { daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3', run: {} };
  const env = { OLLAMA_CLOUD_API_KEY: 'x', OPENROUTER_API_KEY: 'x' };
  const file = write(GOOD());
  const none = await cli(['run', file, '--evals-dir', path.join(path.dirname(file), 'evals'), '--skip-grading'], { env, fakeDocker });
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /has not been validated/i);

  // freeze, then edit
  writeJson(lockPath(file), { version: 1, scenarios_hash: '0'.repeat(64) });
  const edited = await cli(['run', file, '--evals-dir', path.join(path.dirname(file), 'evals'), '--skip-grading'], { env, fakeDocker });
  assert.notEqual(edited.code, 0);
  assert.match(edited.stderr, /changed since validation|hash/i);
});
