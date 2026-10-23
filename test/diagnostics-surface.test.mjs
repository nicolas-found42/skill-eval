import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, readJson, writeJson, freezeForTest, ROOT } from './helpers.mjs';

const TOY = path.join(ROOT, 'fixtures', 'toy-skill', 'pirate-notes');
const KEYS = { OPENROUTER_API_KEY: 'sk-grade-SECRET', OLLAMA_CLOUD_API_KEY: 'sk-model-SECRET' };

const step = (id, description) => ({ id, description, evidence_hint: 'transcript' });
function scenario(id, kind, extra = {}) {
  return { id, kind, prompt: `prompt for ${id}`, rationale: 'r', expected: { outcome: 'o', steps: [step('s1', 'The agent read the skill.')] }, ...extra };
}

/** A transcript with the records the new surfaces read: a turn with model identity and cost, and a provider retry that recovered. */
const RICH_TRANSCRIPT = path.join(tmpdir('rich-'), 'transcript.jsonl');
const NOW = Date.now();
fs.writeFileSync(RICH_TRANSCRIPT, [
  { type: 'session', version: 3, id: 'x', timestamp: new Date(NOW).toISOString(), cwd: '/work' },
  { type: 'agent_start' },
  { type: 'turn_start' },
  { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }], timestamp: NOW } },
  { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'do the thing' }], timestamp: NOW } },
  { type: 'auto_retry_start', attempt: 1, maxAttempts: 10, delayMs: 429.4, errorMessage: 'Provider returned error finish_reason', errorId: 4329472 },
  { type: 'auto_retry_end', success: true, attempt: 1, retryErrors: [{ entryId: '8cab1b91', note: 'error; retried' }] },
  { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'mistral-chat', provider: 'mistral', model: 'mistral-small-latest', usage: { input: 30, output: 422, reasoningTokens: 289, cacheRead: 7856, cacheWrite: 0, totalTokens: 8308, cost: { input: 0.0000045, output: 0.0002532, total: 0.0002577 } }, stopReason: 'stop', responseId: 'a99d7c4e', ttft: 354.3, duration: 356.7, timestamp: NOW + 75 } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: 'mistral-chat', provider: 'mistral', model: 'mistral-small-latest', usage: { input: 30, output: 422, reasoningTokens: 289, cacheRead: 7856, cacheWrite: 0, totalTokens: 8308, cost: { input: 0.0000045, output: 0.0002532, total: 0.0002577 } }, stopReason: 'stop', responseId: 'a99d7c4e', ttft: 354.3, duration: 356.7, timestamp: NOW + 75 } },
  { type: 'turn_end', message: { role: 'assistant', model: 'mistral-small-latest', provider: 'mistral', responseId: 'a99d7c4e', ttft: 354.3, duration: 356.7, stopReason: 'stop', usage: { input: 30, output: 422, reasoningTokens: 289, cacheRead: 7856, cacheWrite: 0, totalTokens: 8308, cost: { input: 0.0000045, output: 0.0002532, total: 0.0002577 } }, timestamp: NOW + 75 } },
].map(r => JSON.stringify(r)).join('\n') + '\n');

function setup(scenarios, runCfg = {}) {
  const root = tmpdir('diag-');
  const evals = path.join(root, 'evals');
  const file = path.join(root, 'scenarios.json');
  writeJson(file, { skill_path: TOY, model_alias: 'ollama-cloud', reps: 1, concurrency: 5, timeout: 600, scenarios, ...runCfg });
  freezeForTest(file);
  return { root, evals, file };
}

const UP = (logDir, transcript) => ({ daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3', logDir, run: { transcript } });

function runDirOf(evals) {
  const names = fs.readdirSync(evals).filter(n => !n.startsWith('.'));
  assert.equal(names.length, 1, `exactly one run folder, got ${names}`);
  return path.join(evals, names[0]);
}

test('the session record keeps the provider retries, including the ones that recovered', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await cli(['run', file, '--evals-dir', evals, '--skip-grading'], { env: KEYS, fakeDocker: UP(root, RICH_TRANSCRIPT) });
  assert.equal(r.code, 0, r.stderr);
  const res = readJson(path.join(runDirOf(evals), 'pos-a', 'result.json'));
  assert.equal(res.provider_retries.count, 1);
  assert.equal(res.provider_retries.recovered, 1);
  assert.equal(res.provider_retries.total_delay_ms, 429);
  assert.equal(res.provider_retries.events[0].error, 'Provider returned error finish_reason');
});

test('per-turn model identity, latency and cost are queryable without opening the transcript', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await cli(['run', file, '--evals-dir', evals, '--skip-grading'], { env: KEYS, fakeDocker: UP(root, RICH_TRANSCRIPT) });
  assert.equal(r.code, 0, r.stderr);
  const turns = readJson(path.join(runDirOf(evals), 'pos-a', 'turns.json'));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].model, 'mistral-small-latest');
  assert.equal(turns[0].provider, 'mistral');
  assert.equal(turns[0].response_id, 'a99d7c4e');
  assert.equal(turns[0].ttft_ms, 354.3);
  assert.equal(turns[0].usage.reasoning, 289);
  assert.equal(turns[0].cost.total, 0.0002577);
});

test('telemetry is written while the session runs, and every turn is counted once', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await cli(['run', file, '--evals-dir', evals, '--skip-grading'], { env: KEYS, fakeDocker: UP(root, RICH_TRANSCRIPT) });
  assert.equal(r.code, 0, r.stderr);
  const tel = fs.readFileSync(path.join(runDirOf(evals), 'pos-a', 'telemetry.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const turns = tel.filter(e => e.event === 'model_turn_end');
  assert.equal(turns.length, 1, 'one model turn, counted once');
  const retries = tel.filter(e => e.event === 'provider_retry');
  assert.equal(retries.length, 2, 'the retry is recorded as a start and an end');
  assert.equal(retries[0].phase, 'start');
  assert.equal(retries[1].recovered, true);
  const res = readJson(path.join(runDirOf(evals), 'pos-a', 'result.json'));
  assert.equal(res.telemetry_summary.provider_retries, 1);
  assert.equal(res.telemetry_summary.provider_retries_recovered, 1);
});

test('the run record says the run is complete and how many sessions it ran', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive'), scenario('neg-a', 'negative')]);
  const r = await cli(['run', file, '--evals-dir', evals, '--skip-grading'], { env: KEYS, fakeDocker: UP(root, RICH_TRANSCRIPT) });
  assert.equal(r.code, 0, r.stderr);
  const rj = readJson(path.join(runDirOf(evals), 'run.json'));
  assert.equal(rj.status, 'complete');
  assert.equal(rj.sessions_planned, 2);
  assert.equal(rj.sessions_done, 2);
  assert.equal(rj.sessions, 2);
});

test('a stranded session is recovered by the normalize command', async () => {
  const dir = path.join(tmpdir('stranded-'), 'pos-a');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'scenario.json'), { id: 'pos-a', kind: 'positive', prompt: 'p', skill: 'pirate-notes' });
  fs.copyFileSync(RICH_TRANSCRIPT, path.join(dir, 'transcript.jsonl'));
  const r = await cli(['normalize', dir]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /normalized/);
  assert.ok(fs.existsSync(path.join(dir, 'events.json')));
  const res = readJson(path.join(dir, 'result.json'));
  assert.equal(res.scenario, 'pos-a');
  assert.equal(res.provider_retries.count, 1);
  assert.ok(fs.existsSync(path.join(dir, 'turns.json')));
});

test('diagnose names a session that was never normalized and says how to recover it', async () => {
  const dir = path.join(tmpdir('stranded-'), 'pos-a');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'scenario.json'), { id: 'pos-a', kind: 'positive', prompt: 'p' });
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), '{"type":"session","timestamp":"2026-01-01T00:00:00.000Z"}\n');
  const r = await cli(['diagnose', path.dirname(dir), '--json']);
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  const session = doc.sessions_detail.find(s => s.name === 'pos-a');
  assert.ok(session.gaps.includes('not_normalized'), `gaps: ${JSON.stringify(session.gaps)}`);
});

test('the session record anchors the container clock to the host clock', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await cli(['run', file, '--evals-dir', evals, '--skip-grading'], { env: KEYS, fakeDocker: UP(root, RICH_TRANSCRIPT) });
  assert.equal(r.code, 0, r.stderr);
  const res = readJson(path.join(runDirOf(evals), 'pos-a', 'result.json'));
  assert.equal(typeof res.clock_offset_ms, 'number');
  // The offset must be small: the container and the host share a clock on this machine.
  assert.ok(Math.abs(res.clock_offset_ms) < 60_000, `offset ${res.clock_offset_ms}ms is not a clock skew`);
});

test('archiving compresses old transcripts and keeps the newest runs raw', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await cli(['run', file, '--evals-dir', evals, '--skip-grading'], { env: KEYS, fakeDocker: UP(root, RICH_TRANSCRIPT) });
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(evals);
  // An older run, so the newest one is the one that stays raw.
  const older = path.join(evals, '20200101-000000-pirate-notes-ollama-cloud-abcdef0');
  fs.mkdirSync(path.join(older, 'pos-a'), { recursive: true });
  writeJson(path.join(older, 'pos-a', 'scenario.json'), { id: 'pos-a', kind: 'positive', prompt: 'p' });
  fs.copyFileSync(RICH_TRANSCRIPT, path.join(older, 'pos-a', 'transcript.jsonl'));
  const a = await cli(['archive', evals, '--keep', '1']);
  assert.equal(a.code, 0, a.stderr);
  assert.ok(fs.existsSync(path.join(older, 'pos-a', 'transcript.jsonl.gz')));
  assert.ok(!fs.existsSync(path.join(older, 'pos-a', 'transcript.jsonl')));
  assert.ok(fs.existsSync(path.join(run, 'pos-a', 'transcript.jsonl')), 'the newest run stays raw');
});

test('an archived session can still be normalized: the transcript is not lost', async () => {
  const dir = path.join(tmpdir('archived-'), 'pos-a');
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'scenario.json'), { id: 'pos-a', kind: 'positive', prompt: 'p', skill: 'pirate-notes' });
  const { gzipTranscript } = await import('../lib/archive.mjs');
  fs.copyFileSync(RICH_TRANSCRIPT, path.join(dir, 'transcript.jsonl'));
  gzipTranscript(dir);
  const r = await cli(['normalize', dir]);
  assert.equal(r.code, 0, r.stderr);
  const res = readJson(path.join(dir, 'result.json'));
  assert.equal(res.provider_retries.count, 1);
  assert.equal(res.turns, 1);
});

test('extracted telemetry events carry the host write timestamp, correlatable with host.jsonl', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await cli(['run', file, '--evals-dir', evals, '--skip-grading'], { env: KEYS, fakeDocker: UP(root, RICH_TRANSCRIPT) });
  assert.equal(r.code, 0, r.stderr);
  const tel = fs.readFileSync(path.join(runDirOf(evals), 'pos-a', 'telemetry.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const modelEvents = tel.filter(e => e.event === 'model_turn_end' || e.event === 'provider_retry' || e.event === 'tool_end');
  assert.ok(modelEvents.length > 0, 'extractor events present');
  for (const e of modelEvents) {
    assert.equal(typeof e.t, 'string', `event ${e.event} keeps a timestamp`);
    assert.ok(!Number.isNaN(Date.parse(e.t)), `event ${e.event} timestamp parses`);
  }
  // and it is the host clock, not the container's: within the run's wall-clock span
  const host = fs.readFileSync(path.join(runDirOf(evals), 'pos-a', 'host.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const t0 = Date.parse(host.find(e => e.event === 'container_start').t);
  const t1 = Date.parse(host.find(e => e.event === 'container_end').t);
  for (const e of modelEvents) {
    const t = Date.parse(e.t);
    assert.ok(t >= t0 - 1000 && t <= t1 + 1000, `event ${e.event} timestamp ${e.t} within the container's host span`);
  }
});
