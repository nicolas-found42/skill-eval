import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, readJson, writeJson, ROOT } from './helpers.mjs';

const BASE = path.join(ROOT, 'fixtures', 'base');

/** A minimal session folder the way `run` leaves one; run.json is added per test. */
function fakeSession() {
  const run = tmpdir('diag-');
  const dir = path.join(run, 'pos-a');
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
  fs.copyFileSync(path.join(BASE, 'pos1', 'transcript.jsonl'), path.join(dir, 'transcript.jsonl'));
  writeJson(path.join(dir, 'scenario.json'), { id: 'pos-a', kind: 'positive', prompt: 'Write a memo.', skill: 'pirate-notes', expected: { outcome: 'o', steps: [] } });
  return { run, dir };
}

const hostOk = () => [
  { event: 'session_scheduled', t: new Date().toISOString(), session: 'pos-a', rep: 1 },
  { event: 'container_start', t: new Date().toISOString(), container: 'c' },
  { event: 'container_end', t: new Date().toISOString(), container: 'c', exit_code: 0, killed: false, timed_out: false, kill_fired: false, duration_ms: 1000 },
  { event: 'normalize_start', t: new Date().toISOString(), session: 'pos-a' },
  { event: 'session_end', t: new Date().toISOString(), session: 'pos-a', exit_code: 0, timeout: false },
];

const runJsonOk = () => ({
  skill: { name: 'pirate-notes', path: '/x', kind: 'skill' }, skill_hash: 'a'.repeat(64),
  scenarios_hash: 'b'.repeat(64), model: { alias: 'ollama-cloud', model: 'ollama-cloud/deepseek-v4.1-flash' },
  omp_version: '1.2.3', image: 'skill-eval-omp:1.2.3', image_digest: null, git_sha: null,
  t_start: new Date().toISOString(), t_end: new Date().toISOString(),
  host: { node: process.version, platform: process.platform, arch: process.arch },
  sessions: 1, warnings: [],
});

test('diagnose reports run sessions and per-session timelines without calling the judge', async () => {
  const { run, dir } = fakeSession();
  // normalize exit codes are host-driven; the runner passes the container code, so set it here
  const { normalizeSession } = await import('../lib/normalize.mjs');
  normalizeSession(dir, { exitCode: 0, durationMs: 1000 });
  fs.writeFileSync(path.join(dir, 'host.jsonl'), hostOk().map(e => JSON.stringify(e)).join('\n') + '\n');
  writeJson(path.join(run, 'run.json'), runJsonOk());

  const summary = await cli(['diagnose', run]);
  assert.equal(summary.code, 0, summary.stderr);
  assert.match(summary.stdout, /pos-a/);
  assert.match(summary.stdout, /exit=0/);

  const one = await cli(['diagnose', run, '--session', 'pos-a']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /timeline/i);
  assert.match(one.stdout, /clean, within the timeout/);
  assert.match(one.stdout, /tools:.*read/);
});

test('diagnose flags timeout kind and truncation gaps', async () => {
  const { run, dir } = fakeSession();
  const { normalizeSession } = await import('../lib/normalize.mjs');
  normalizeSession(dir, { timedOut: true, timeoutKind: 'killed', exitCode: null, durationMs: 2000 });
  fs.writeFileSync(path.join(dir, 'host.jsonl'), [
    { event: 'container_start', t: new Date().toISOString(), container: 'c' },
    { event: 'hard_kill', t: new Date().toISOString(), container: 'c', after_ms: 2000 },
    { event: 'container_end', t: new Date().toISOString(), container: 'c', exit_code: null, killed: true, timed_out: true, kill_fired: true, duration_ms: 2000 },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  writeJson(path.join(dir, 'grading.json'), { scenario: 'pos-a', truncated: true, evidence_chars: 300_000, steps: [{ id: 's1', description: 'd', verdict: 'needs_human', p_done: 0.5, p_not_done: 0.2, p_unclear: 0.5, p_attempted_wrong: 0 }] });
  writeJson(path.join(run, 'run.json'), { skill: { name: 'pirate-notes' }, model: { model: 'm' }, sessions: 1, warnings: [] });
  const one = await cli(['diagnose', run, '--session', 'pos-a']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /hard kill fired/);
  assert.match(one.stdout, /over cap/);
  assert.match(one.stdout, /--keep-evidence/);
});

test('the timeline shows the host clock next to the container clock', async () => {
  const { run, dir } = fakeSession();
  const { normalizeSession } = await import('../lib/normalize.mjs');
  // The host clock bounds the session; the transcript carries the container's own clock.
  const hostStart = new Date().toISOString();
  normalizeSession(dir, { exitCode: 0, durationMs: 1000, tStart: hostStart });
  const res = readJson(path.join(dir, 'result.json'));
  assert.equal(typeof res.clock_offset_ms, 'number', 'the offset between the two clocks is recorded');
  writeJson(path.join(run, 'run.json'), runJsonOk());
  const one = await cli(['diagnose', run, '--session', 'pos-a']);
  assert.equal(one.code, 0, one.stderr);
  assert.match(one.stdout, /container clock offset from host/);
  assert.match(one.stdout, /host=/);
});

test('diagnose rebuilds a run view when run.json is missing, and names the sessions it found', async () => {
  const d = tmpdir('diag-');
  // A session with a transcript but no result.json: the harness died before normalizing it.
  const dir = path.join(d, 'pos-a');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'scenario.json'), { id: 'pos-a', kind: 'positive', prompt: 'p' });
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '{"type":"session","timestamp":"2026-01-01T00:00:00.000Z"}\n');
  const r = await cli(['diagnose', d]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /no run\.json/);
  assert.match(r.stdout, /never normalized/);
  assert.match(r.stdout, /eval\.mjs normalize/);
});

test('diagnose says a run whose record says "running" was interrupted', async () => {
  const { run } = fakeSession();
  writeJson(path.join(run, 'run.json'), { status: 'running', skill: { name: 'pirate-notes' }, model: { model: 'm' }, sessions: 1, sessions_done: 0, sessions_planned: 3, warnings: [] });
  const r = await cli(['diagnose', run]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /interrupted/);
  assert.match(r.stdout, /0\/3 sessions done/);
});

test('diagnose tolerates a corrupt host.jsonl line instead of crashing', async () => {
  const { run, dir } = fakeSession();
  const { normalizeSession } = await import('../lib/normalize.mjs');
  normalizeSession(dir, { exitCode: 0, durationMs: 1000 });
  fs.writeFileSync(path.join(dir, 'host.jsonl'), '{"event":"container_start"}\nNOT JSON\n{"event":"session_end"}\n');
  writeJson(path.join(run, 'run.json'), { skill: { name: 'pirate-notes' }, model: { model: 'm' }, sessions: 1, warnings: [] });
  const one = await cli(['diagnose', run, '--session', 'pos-a']);
  assert.equal(one.code, 0, one.stderr);
});

test('diagnose --json returns gap codes and a concrete re-run suggestion', async () => {
  const { run, dir } = fakeSession();
  const { normalizeSession } = await import('../lib/normalize.mjs');
  normalizeSession(dir, { timedOut: true, timeoutKind: 'hung', exitCode: null, durationMs: 2000 });
  fs.writeFileSync(path.join(dir, 'host.jsonl'), [
    { event: 'container_start', t: new Date().toISOString(), container: 'c' },
    { event: 'no_output', t: new Date().toISOString(), container: 'c', silent_ms: 300000, stdout_bytes: 10, stderr_bytes: 0, last_chunk: 'stdout', count: 1 },
    { event: 'hard_kill', t: new Date().toISOString(), container: 'c', after_ms: 2000, hung: true, stdout_bytes: 10, stderr_bytes: 0 },
    { event: 'container_end', t: new Date().toISOString(), container: 'c', exit_code: null, killed: true, timed_out: true, kill_fired: true, hung: true, duration_ms: 2000, stdout_bytes: 10, stderr_bytes: 0, stderr_tail: '', docker_state: null, oom_killed: null },
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  writeJson(path.join(run, 'run.json'), { skill: { name: 'pirate-notes' }, model: { model: 'm' }, sessions: 1, warnings: [] });
  const r = await cli(['diagnose', run, '--session', 'pos-a', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.timeout_kind, 'hung');
  assert.ok(j.gaps.some(g => g.code === 'timeout_hung'), `gap codes: ${j.gaps.map(g => g.code)}`);
  assert.ok(j.container.hung === true && j.container.no_output_events === 1);
  assert.match(j.suggested_rerun.reasons.join(' '), /timeout/i);
});

test('diagnose run --json summarizes sessions without calling the judge', async () => {
  const { run, dir } = fakeSession();
  const { normalizeSession } = await import('../lib/normalize.mjs');
  normalizeSession(dir, { exitCode: 0, durationMs: 1000 });
  fs.writeFileSync(path.join(dir, 'host.jsonl'), hostOk().map(e => JSON.stringify(e)).join('\n') + '\n');
  writeJson(path.join(dir, 'grading.json'), { scenario: 'pos-a', truncated: false, evidence_chars: 10, steps: [] });
  writeJson(path.join(run, 'run.json'), runJsonOk());
  const r = await cli(['diagnose', run, '--json']);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.skill, 'pirate-notes');
  assert.equal(j.sessions_detail.length, 1);
  assert.deepEqual(j.sessions_detail[0].gaps, []);
});
