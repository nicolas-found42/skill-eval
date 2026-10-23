import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, readJson, writeJson, ROOT } from './helpers.mjs';
import { JEV_MODEL } from '../lib/jev.mjs';

// Live Jev judge. Mutations are applied to a real recorded session (fixtures/base/pos1) so the right answer is known by construction.
const BASE = path.join(ROOT, 'fixtures', 'base', 'pos1');
const TOY = path.join(ROOT, 'fixtures', 'toy-skill', 'pirate-notes');
/** @type {Record<string, string>} */
const ENV = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' };

const STEPS = [
  { id: 'title', description: 'The first line of memo.md starts with "# Arr:".', evidence_hint: 'workspace/memo.md' },
  { id: 'signed', description: "memo.md contains the line 'Signed: Captain Skill'.", evidence_hint: 'workspace/memo.md' },
  { id: 'wc', description: 'The agent ran `wc -l memo.md`.', evidence_hint: 'bash tool call', requires: ['title'] },
  { id: 'reported', description: 'The agent told the user the line count that `wc -l memo.md` printed.', evidence_hint: 'final message', requires: ['wc'] },
];

/** Build a run folder containing one session derived from the recorded pos1 session, with `mutate(events, memo)` applied. */
async function session(mutate = (ev, memo) => [ev, memo], { steps = STEPS, kind = 'positive' } = {}) {
  const run = tmpdir('grade-');
  const dir = path.join(run, 's1');
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  fs.copyFileSync(path.join(BASE, 'transcript.jsonl'), path.join(dir, 'transcript.jsonl'));
  writeJson(path.join(dir, 'scenario.json'), {
    id: 's1', kind, skill: 'pirate-notes', prompt: 'Write a short memo to a file about the quarterly planning meeting.',
    expected: { outcome: 'memo written, signed, counted', steps },
  });
  const n = await cli(['normalize', dir]);
  assert.equal(n.code, 0, n.stderr);
  const ev = readJson(path.join(dir, 'events.json'));
  const memo = fs.readFileSync(path.join(BASE, 'workspace', 'memo.md'), 'utf8');
  const [ev2, memo2] = mutate(ev, memo);
  writeJson(path.join(dir, 'events.json'), ev2);
  fs.writeFileSync(path.join(dir, 'workspace', 'memo.md'), memo2);
  writeJson(path.join(run, 'run.json'), { skill: { name: 'pirate-notes', path: TOY }, skill_hash: 'x', scenarios_hash: 'y' });
  fs.cpSync(TOY, path.join(run, 'skill'), { recursive: true });
  return { run, dir };
}

const grade = async (run, env = ENV) => cli(['grade', run], { env });
const verdicts = dir => Object.fromEntries(readJson(path.join(dir, 'grading.json')).steps.map(s => [s.id, s.verdict]));

test('an intact session grades every step done with the probabilities recorded', async () => {
  const { run, dir } = await session();
  const r = await grade(run);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(verdicts(dir), { title: 'done', signed: 'done', wc: 'done', reported: 'done' });
  const g = readJson(path.join(dir, 'grading.json'));
  for (const s of g.steps) { assert.ok(s.p_done >= 0.8, `${s.id} p_done ${s.p_done}`); assert.equal(typeof s.p_not_done, 'number'); }
  assert.equal(g.truncated, false);
});

test('a step the model never performed is skipped, not wrong, and its dependents are blocked without being judged', async () => {
  const { run, dir } = await session((ev, memo) => [
    ev.filter(e => !(e.kind !== 'assistant_text' && e.turn === 3))
      .map(e => (e.kind === 'assistant_text' ? { ...e, text: 'Wrote memo.md with the pirate-voice lunch memo.' } : e)),
    memo]);
  await grade(run);
  const v = verdicts(dir);
  assert.equal(v.wc, 'skipped');
  assert.equal(v.reported, 'blocked');
  assert.equal(v.title, 'done');
  const g = readJson(path.join(dir, 'grading.json'));
  const blocked = g.steps.find(s => s.id === 'reported');
  assert.equal(blocked.p_done, null, 'a blocked step is never sent to the judge');
  assert.deepEqual(blocked.blocked_by, ['wc']);
});

test('a missing signature is flagged as not done and the intact steps stay done', async () => {
  const { run, dir } = await session((ev, memo) => [
    ev.map(e => (e.kind === 'tool_call' && e.tool === 'write' ? { ...e, args: e.args.replace(/\\nSigned: Captain Skill/, '') } : e)),
    memo.replace(/Signed: Captain Skill\n?/, '')]);
  await grade(run);
  const v = verdicts(dir);
  assert.ok(['skipped', 'wrong'].includes(v.signed), `signed was ${v.signed}`);
  assert.equal(v.title, 'done');
});

test('a step done on the wrong target is wrong, not skipped (the attempted-but-wrong split)', async () => {
  const { run, dir } = await session((ev, memo) => [
    ev.map(e => e.kind === 'tool_call' && e.tool === 'bash' ? { ...e, args: e.args.replace('memo.md', 'notes.txt') }
      : e.kind === 'tool_result' && e.tool === 'bash' ? { ...e, text: 'wc: notes.txt: No such file or directory' } : e),
    memo]);
  await grade(run);
  const g = readJson(path.join(dir, 'grading.json'));
  const wc = g.steps.find(s => s.id === 'wc');
  assert.notEqual(wc.verdict, 'done');
  assert.ok(typeof wc.p_attempted_wrong === 'number');
  assert.equal(wc.verdict, 'wrong', `p_attempted_wrong=${wc.p_attempted_wrong}`);
});

test('a title that fails blocks its dependents: wc and reported are never judged', async () => {
  const { run, dir } = await session((ev, memo) => [
    ev.map(e => (e.kind === 'tool_call' && e.tool === 'write' ? { ...e, args: e.args.replace('# Arr:', '# Memo:') } : e)),
    memo.replace('# Arr:', '# Memo:')]);
  await grade(run);
  const v = verdicts(dir);
  assert.notEqual(v.title, 'done');
  assert.equal(v.wc, 'blocked');
  assert.equal(v.reported, 'blocked');
});

test('evidence over the size cap marks the session truncated and no step can be auto-done', async () => {
  const { run, dir } = await session((ev, memo) => [
    [...ev.slice(0, 2), { turn: 2, kind: 'tool_result', tool: 'bash', text: 'filler line of unrelated build output\n'.repeat(100), truncated: false }, ...ev.slice(2)]
      .flatMap((e, i) => (i === 2 ? Array.from({ length: 60 }, () => e) : [e])),
    memo]);
  const r = await cli(['grade', run, '--evidence-cap', '20000'], { env: ENV });
  assert.equal(r.code, 0, r.stderr);
  const g = readJson(path.join(dir, 'grading.json'));
  assert.equal(g.truncated, true);
  assert.ok(g.steps.every(s => s.verdict !== 'done'), JSON.stringify(g.steps.map(s => [s.id, s.verdict])));
});

test('grading without OPENROUTER_API_KEY fails clearly and leaves the session folder intact', async () => {
  const { run, dir } = await session();
  const r = await grade(run, {});
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
  assert.ok(fs.existsSync(path.join(dir, 'events.json')));
  assert.ok(!fs.existsSync(path.join(dir, 'grading.json')), 'no ungraded grading.json emitted');
});

test('the judge trace is kept by default, so a verdict can be audited without paying for the judge again', async () => {
  const { run, dir } = await session();
  const r = await grade(run);
  assert.equal(r.code, 0, r.stderr);
  const g = readJson(path.join(dir, 'grading.json'));
  assert.ok(Array.isArray(g.judge_trace), 'grading.json carries a judge trace');
  assert.equal(g.judge_trace.length, g.steps.length);
  const first = g.judge_trace[0];
  assert.equal(first.step, g.steps[0].id);
  assert.ok(first.questions.step, 'the exact question is recorded');
  assert.ok(first.answers.step.probabilities, 'the judge answer is recorded');
  assert.equal(typeof first.evidence.chars, 'number');
  assert.ok(first.evidence.head.length > 0, 'a slice of the evidence the judge saw is recorded');
});

test('grading never sends anything but the eval session evidence: grading.json records judge model and cost', async () => {
  const { run, dir } = await session();
  await grade(run);
  const g = readJson(path.join(dir, 'grading.json'));
  assert.equal(g.judge.model, JEV_MODEL);
  assert.ok(g.judge.cost > 0 && g.judge.calls >= 1);
});

test('grading.evidence.json is written by default when a step needs a human, and removed on a clean re-grade', async () => {
  const { gradeSession } = await import('../lib/grade.mjs');
  const { readSkill } = await import('../lib/skill.mjs');
  const { run, dir } = await session();
  const skill = readSkill(path.join(run, 'skill'));
  // A stub judge: every step comes back maximally unclear, which maps to needs_human.
  /** @param {{ done: number, unclear: number, attempted: number }} p */
  const stubJudge = ({ done, unclear, attempted }) => ({
    model: 'stub', snapshots: new Set(), cost: 0, calls: 0,
    /** @param {any} _state @param {Record<string, { type: string }>} questions */
    async ask(_state, questions) {
      this.calls++;
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        answers[id] = q.type === 'choice'
          ? { probabilities: { done, not_done: 1 - done - unclear, unclear }, confidence: 0.9 }
          : { noul: attempted };
      }
      return answers;
    },
  });
  const unclearJudge = /** @type {any} */ (stubJudge({ done: 0.1, unclear: 0.8, attempted: 0.5 }));
  const g = await gradeSession(dir, { skill, jev: unclearJudge });
  assert.ok(g.steps.some(s => s.verdict === 'needs_human'), 'stub verdict is needs_human');
  const evFile = path.join(dir, 'grading.evidence.json');
  assert.ok(fs.existsSync(evFile), 'evidence file written for a needs_human session without --keep-evidence');
  const kept = readJson(evFile);
  assert.equal(kept.scenario, 's1');
  assert.ok(kept.state.transcript.length > 0, 'the judge state is in the file');
  assert.ok(kept.steps.some(s => s.answers.step.probabilities.unclear === 0.8), 'the per-step judge answers are in the file');

  // a clean re-grade (every step done) removes the stale file
  const doneJudge = /** @type {any} */ (stubJudge({ done: 0.95, unclear: 0.02, attempted: 0.1 }));
  const g2 = await gradeSession(dir, { skill, jev: doneJudge });
  assert.ok(g2.steps.every(s => s.verdict === 'done'), 'stub verdict is done');
  assert.ok(!fs.existsSync(evFile), 'a clean re-grade removes the stale evidence file');
});
