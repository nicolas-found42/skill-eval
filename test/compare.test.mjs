import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, readJson, writeJson, ROOT } from './helpers.mjs';

/** @type {Record<string, string>} */
const ENV = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' };
const SESSIONS = path.join(ROOT, 'fixtures', 'sessions');
const TOY = path.join(ROOT, 'fixtures', 'toy-skill', 'pirate-notes');

/** A fully analyzed run folder (findings.json + per-session grading.json) built through the real pipeline. */
async function analyzed(names, { scenarios_hash = 'a'.repeat(64), model = 'ollama-cloud/deepseek-v4.1-flash', skill_hash = 'b'.repeat(64) } = {}) {
  const run = tmpdir('cmp-');
  for (const n of names) { fs.cpSync(path.join(SESSIONS, n), path.join(run, n), { recursive: true }); fs.rmSync(path.join(run, n, 'expected.json')); }
  fs.cpSync(TOY, path.join(run, 'skill'), { recursive: true });
  writeJson(path.join(run, 'run.json'), { skill: { name: 'pirate-notes', path: TOY }, skill_hash, scenarios_hash, model: { alias: 'ollama-cloud', model }, session_cost: 0 });
  const r = await cli(['analyze', run], { env: ENV });
  assert.equal(r.code, 0, r.stderr);
  return run;
}
const compare = (a, b) => cli(['compare', a, b], { env: ENV });
const result = async (a, b) => { const r = await compare(a, b); assert.equal(r.code, 0, r.stderr); return readJson(path.join(b, 'compare.json')); };
const statusOf = (cmp, pred) => cmp.findings.find(pred)?.status;

test('a finding present before and gone after is reported fixed', async () => {
  const before = await analyzed(['no_wc']);
  const after = await analyzed(['no_wc'].map(() => 'intact'));
  // same scenario id is required to compare: rename intact -> no_wc in the "after" run
  fs.renameSync(path.join(after, 'intact'), path.join(after, 'no_wc'));
  const sj = path.join(after, 'no_wc', 'scenario.json'); writeJson(sj, { ...readJson(sj), id: 'no_wc' });
  await cli(['analyze', after], { env: ENV });
  const cmp = await result(before, after);
  assert.equal(statusOf(cmp, f => f.label === 'skipped' && f.step === 'wc'), 'fixed');
});

test('a finding present in both runs is reported still_failing', async () => {
  const a = await analyzed(['no_wc']);
  const b = await analyzed(['no_wc']);
  const cmp = await result(a, b);
  assert.equal(statusOf(cmp, f => f.label === 'skipped' && f.step === 'wc'), 'still_failing');
});

test('a finding only in the after run is new', async () => {
  const a = await analyzed(['no_wc']);
  const b = await analyzed(['no_wc', 'no_sign']);
  const cmp = await result(a, b);
  assert.equal(statusOf(cmp, f => f.step === 'signed'), 'new');
});

test('a scenario that passed before and fails after is a regression', async () => {
  const a = await analyzed(['intact']);
  const b = await analyzed(['intact']);
  // make the "after" intact session fail by replacing it with the no_wc content under the same scenario id
  fs.rmSync(path.join(b, 'intact'), { recursive: true });
  fs.cpSync(path.join(SESSIONS, 'no_wc'), path.join(b, 'intact'), { recursive: true });
  fs.rmSync(path.join(b, 'intact', 'expected.json'));
  const sj = path.join(b, 'intact', 'scenario.json'); writeJson(sj, { ...readJson(sj), id: 'intact' });
  await cli(['analyze', b], { env: ENV });
  const cmp = await result(a, b);
  const f = cmp.findings.find(x => x.step === 'wc');
  assert.equal(f.status, 'regressed');
  const sc = cmp.scenarios.find(s => s.scenario === 'intact');
  assert.equal(sc.before.pass_rate, 1);
  assert.equal(sc.after.pass_rate < 1, true);
});

test('wording drift does not turn a same-cause finding into fixed+new: the judge matches them', async () => {
  const a = await analyzed(['no_wc']);
  const b = await analyzed(['no_wc']);
  // reword the after finding AND rename its step id, so deterministic label+step pairing cannot match; only the judge can
  const fj = path.join(b, 'findings.json'); const doc = readJson(fj);
  for (const f of doc.findings) if (f.step === 'wc') { f.step = 'count'; f.description = 'The model never counted the lines of memo.md with wc and did not report a count to the user.'; }
  writeJson(fj, doc);
  const cmp = await result(a, b);
  const wc = cmp.findings.filter(f => f.label === 'skipped');
  assert.deepEqual(wc.map(f => f.status), ['still_failing'], JSON.stringify(wc));
});

test('runs with different scenarios or a different model are flagged not comparable', async () => {
  const a = await analyzed(['no_wc']);
  const b = await analyzed(['no_wc'], { scenarios_hash: 'c'.repeat(64) });
  const c = await analyzed(['no_wc'], { model: 'mistral/devstral-latest' });
  assert.equal((await result(a, b)).comparable, false);
  assert.match((await result(a, b)).reasons.join(' '), /scenarios/i);
  assert.equal((await result(a, c)).comparable, false);
  assert.match((await result(a, c)).reasons.join(' '), /model/i);
});

test('a different skill hash is expected and keeps the runs comparable', async () => {
  const a = await analyzed(['no_wc']);
  const b = await analyzed(['no_wc'], { skill_hash: 'd'.repeat(64) });
  const cmp = await result(a, b);
  assert.equal(cmp.comparable, true);
  assert.equal(cmp.skill_changed, true);
});

test('compare fails clearly when a run folder has not been analyzed', async () => {
  const a = await analyzed(['no_wc']);
  const bare = tmpdir('cmp-bare-');
  const r = await compare(a, bare);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /analyze/i);
});
