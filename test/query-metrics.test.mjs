import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, writeJson, readJson } from './helpers.mjs';
import { openMetricsDb, indexRun, indexAllRuns, queryProviderErrors, queryRecurringFailures, queryStaleness } from '../lib/query.mjs';

/** A run folder with one session, as the runner leaves it. */
function runFolder(evalsDir, name, { providerRetries = null, findings = null, skill = 'toy', t_start = '2026-10-21T00:00:00.000Z' } = {}) {
  const dir = path.join(evalsDir, name);
  fs.mkdirSync(path.join(dir, 's1'), { recursive: true });
  writeJson(path.join(dir, 'run.json'), {
    status: 'complete', skill: { name: skill }, model: { model: 'm', alias: 'a' },
    t_start, sessions: 1, timeouts: 0, session_cost: 0, total_cost: 0, pass_rate: 1, aborted_for_cost: false,
  });
  const result = { scenario: 'pos-a', kind: 'positive', exit_code: 0, duration_ms: 1000, turns: 2, tokens: 10, cost: 0.01, errors: 0 };
  if (providerRetries) result.provider_retries = providerRetries;
  writeJson(path.join(dir, 's1', 'result.json'), result);
  writeJson(path.join(dir, 's1', 'grading.json'), { scenario: 'pos-a', truncated: false, evidence_chars: 10, steps: [{ id: 's1', verdict: 'done', p_done: 0.9 }] });
  if (findings) writeJson(path.join(dir, 'findings.json'), { version: 1, skill, findings, sessions: [] });
  fs.mkdirSync(path.join(dir, 'skill'), { recursive: true });
  return dir;
}

test('provider retries are indexed per session and answer what the run looked like', () => {
  const evals = tmpdir('q-');
  const dir = runFolder(evals, '20261021-000000-toy-a-1111111', {
    providerRetries: {
      count: 2, recovered: 1, total_delay_ms: 900,
      events: [
        { attempt: 1, max_attempts: 10, delay_ms: 400, error: 'HTTP 429 rate limit', error_id: 1, recovered: false },
        { attempt: 2, max_attempts: 10, delay_ms: 500, error: 'HTTP 429 rate limit', error_id: 2, recovered: true },
      ],
    },
  });
  const db = openMetricsDb(evals);
  indexRun(db, dir);
  const rows = queryProviderErrors(db, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session, 's1');
  assert.equal(rows[0].attempts, 2);
  assert.equal(rows[0].recovered, 1);
  assert.equal(rows[0].fatal, 1);
  assert.equal(rows[0].kind, 'fatal');
  assert.equal(rows[0].total_delay_ms, 900);
  assert.match(rows[0].first_error, /429/);
  db.close();
});

test('a session with no provider retries produces no row', () => {
  const evals = tmpdir('q-');
  const dir = runFolder(evals, '20261021-000000-toy-a-1111111');
  const db = openMetricsDb(evals);
  indexRun(db, dir);
  assert.deepEqual(queryProviderErrors(db, {}), []);
  db.close();
});

test('findings are indexed, and the same defect in two runs is one recurring cluster', async () => {
  const evals = tmpdir('q-');
  const finding = { label: 'wrong', step: 'refuses-render', description: 'The agent rendered before the approval turn.', severity: 'high', count: 1, scenarios: ['temptation-unapproved-render'] };
  for (const name of ['20261021-000000-toy-a-1111111', '20261021-010000-toy-a-2222222']) {
    const dir = runFolder(evals, name, { findings: [finding] });
    const db = openMetricsDb(evals);
    indexRun(db, dir);
    db.close();
  }
  const db = openMetricsDb(evals);
  const clusters = await queryRecurringFailures(db, { minRuns: 2 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].label, 'wrong');
  assert.equal(clusters[0].step, 'refuses-render');
  assert.equal(clusters[0].runs.length, 2);
  assert.equal(clusters[0].occurrences, 2);
  assert.deepEqual(clusters[0].scenarios, ['temptation-unapproved-render']);
  db.close();
});

test('a defect seen in one run is not a recurring failure', async () => {
  const evals = tmpdir('q-');
  const dir = runFolder(evals, '20261021-000000-toy-a-1111111', {
    findings: [{ label: 'wrong', step: 's', description: 'one-off', severity: 'high', count: 1, scenarios: ['x'] }],
  });
  const db = openMetricsDb(evals);
  indexRun(db, dir);
  assert.deepEqual(await queryRecurringFailures(db, { minRuns: 2 }), []);
  db.close();
});

test('the skill filter narrows the recurring failures to one skill', async () => {
  const evals = tmpdir('q-');
  const finding = { label: 'wrong', step: 's', description: 'same text', severity: 'high', count: 1, scenarios: ['x'] };
  for (const [name, skill] of [['20261021-000000-toy-a-1111111', 'toy'], ['20261021-010000-other-b-2222222', 'other']]) {
    const dir = runFolder(evals, name, { findings: [finding], skill });
    const db = openMetricsDb(evals);
    indexRun(db, dir);
    db.close();
  }
  const db = openMetricsDb(evals);
  assert.equal((await queryRecurringFailures(db, { minRuns: 2, skill: 'toy' })).length, 0);
  assert.equal((await queryRecurringFailures(db, { minRuns: 2 })).length, 1);
  db.close();
});

test('the index reports the runs on disk that it does not know about', () => {
  const evals = tmpdir('q-');
  const dir = runFolder(evals, '20261021-000000-toy-a-1111111');
  const db = openMetricsDb(evals);
  indexRun(db, dir);
  // A run folder that was never indexed: an interrupted run, or one the indexer skipped.
  fs.mkdirSync(path.join(evals, '20261021-020000-toy-a-3333333', 'skill'), { recursive: true });
  const stale = queryStaleness(db, evals);
  assert.equal(stale.stale, true);
  assert.equal(stale.runs_missing, 1);
  assert.deepEqual(stale.missing_runs, ['20261021-020000-toy-a-3333333']);
  assert.equal(stale.newest_run_indexed, '20261021-000000-toy-a-1111111');
  db.close();
});

test('a run whose harness died is indexed from its session folders', async () => {
  const evals = tmpdir('q-');
  // A run folder with sessions but no run.json: the harness stopped before writing one.
  const dir = path.join(evals, '20261021-000000-toy-a-1111111');
  fs.mkdirSync(path.join(dir, 's1'), { recursive: true });
  writeJson(path.join(dir, 's1', 'scenario.json'), { id: 'pos-a', kind: 'positive', prompt: 'p' });
  writeJson(path.join(dir, 's1', 'result.json'), { scenario: 'pos-a', kind: 'positive', exit_code: 0, duration_ms: 1000, turns: 2, tokens: 10, cost: 0.01, errors: 0, t_start: '2026-10-21T00:00:00.000Z' });
  writeJson(path.join(dir, 's1', 'session.json'), { session: 's1', scenario: 'pos-a', model: 'm', model_alias: 'a', timeout: 600 });
  const db = openMetricsDb(evals);
  const { indexed } = indexAllRuns(evals);
  assert.equal(indexed, 1, 'the interrupted run is indexed, not skipped');
  const runs = db.prepare('SELECT run, skill, model_alias FROM runs').all();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].model_alias, 'a');
  const sessions = db.prepare('SELECT session, scenario FROM sessions').all();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session, 's1');
  assert.equal(queryStaleness(db, evals).runs_missing, 0);
  db.close();
});

test('the metrics database is dot-prefixed, so it is never mistaken for a run folder', () => {
  const evals = tmpdir('q-');
  const db = openMetricsDb(evals);
  db.close();
  assert.ok(fs.existsSync(path.join(evals, '.metrics.db')));
  assert.ok(!fs.existsSync(path.join(evals, 'metrics.db')));
  const names = fs.readdirSync(evals).filter(n => !n.startsWith('.'));
  assert.deepEqual(names, []);
});
