import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { classifyError, suggestFix, ERROR_CLASSES } from '../lib/errors.mjs';
import { TelemetryWriter, TELEMETRY_EVENTS, extractTelemetryFromTranscript, summarizeTelemetry } from '../lib/telemetry.mjs';
import { openMetricsDb, indexRun, queryFailingSteps, queryFlakySteps, queryErrorClasses, queryRuns, querySlowSessions } from '../lib/query.mjs';
import { startStreamServer } from '../lib/stream.mjs';
import { tmpdir, writeJson, readJson } from './helpers.mjs';

// ============ Error Taxonomy Tests ============

test('classifyError classifies timeout correctly', () => {
  assert.equal(classifyError({ timeout: true, timeout_kind: 'hung' }), 'timeout');
  assert.equal(classifyError({ timeout: true, timeout_kind: 'killed' }), 'timeout');
});

test('classifyError classifies OOM and resource exhaustion', () => {
  assert.equal(classifyError({ oom_killed: true }), 'resource_exhaustion');
  assert.equal(classifyError({ exit_code: 137 }), 'resource_exhaustion');
});

test('classifyError classifies infra failures by exit code', () => {
  assert.equal(classifyError({ exit_code: 125 }), 'infra_failure');
  assert.equal(classifyError({ exit_code: 126 }), 'infra_failure');
  assert.equal(classifyError({ exit_code: 127 }), 'infra_failure');
});

test('classifyError classifies nonzero exit', () => {
  assert.equal(classifyError({ exit_code: 1 }), 'nonzero_exit');
  assert.equal(classifyError({ exit_code: 2 }), 'nonzero_exit');
});

test('classifyError detects skill_not_loaded from grading', () => {
  const result = { exit_code: 0, skill_loaded: false };
  const grading = { steps: [{ verdict: 'wrong', description: 'agent must follow the skill gate' }] };
  const scenario = { kind: 'positive' };
  assert.equal(classifyError(result, grading, scenario), 'skill_not_loaded');
});

test('classifyError detects skill_ignored from grading', () => {
  const result = { exit_code: 0, skill_loaded: true };
  const grading = { steps: [{ verdict: 'wrong', description: 'agent must get approval before render' }] };
  const scenario = { kind: 'positive' };
  assert.equal(classifyError(result, grading, scenario), 'skill_ignored');
});

test('classifyError detects grader_uncertainty', () => {
  const result = { exit_code: 0 };
  const grading = { steps: [
    { verdict: 'needs_human', description: 'step 1' },
    { verdict: 'needs_human', description: 'step 2' },
  ] };
  assert.equal(classifyError(result, grading, { kind: 'positive' }), 'grader_uncertainty');
});

test('classifyError returns unknown for clean sessions', () => {
  assert.equal(classifyError({ exit_code: 0, timeout: false }), 'unknown');
});

test('suggestFix returns actionable advice for every error class', () => {
  for (const cls of Object.keys(ERROR_CLASSES)) {
    const fix = suggestFix(cls);
    assert.ok(typeof fix === 'string' && fix.length > 10, `fix for ${cls} should be a non-trivial string`);
  }
});

// ============ Telemetry Tests ============

test('TelemetryWriter writes and reads JSONL events', () => {
  const file = path.join(tmpdir('telemetry-'), 'telemetry.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tw = new TelemetryWriter(file);
  tw.emit(TELEMETRY_EVENTS.SESSION_START, { session: 'test' });
  tw.emit(TELEMETRY_EVENTS.RESOURCE_SAMPLE, { cpu_pct: 50, mem_mb: 256 });
  tw.close();

  const events = TelemetryWriter.read(file);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'session_start');
  assert.equal(events[1].event, 'resource_sample');
  assert.equal(events[1].mem_mb, 256);
});

test('TelemetryWriter handles missing directory gracefully', () => {
  const tw = new TelemetryWriter('/nonexistent/path/telemetry.jsonl');
  tw.emit(TELEMETRY_EVENTS.SESSION_START, {}); // should not throw
  tw.close();
});

test('summarizeTelemetry aggregates events correctly', () => {
  const events = [
    { event: TELEMETRY_EVENTS.MODEL_TURN_END, duration_ms: 1000, tokens: 100, cost: 0.01 },
    { event: TELEMETRY_EVENTS.MODEL_TURN_END, duration_ms: 2000, tokens: 200, cost: 0.02 },
    { event: TELEMETRY_EVENTS.TOOL_END, wall_ms: 500 },
    { event: TELEMETRY_EVENTS.TOOL_ERROR, turn: 1, tool: 'bash', error: 'failed' },
    { event: TELEMETRY_EVENTS.RESOURCE_SAMPLE, cpu_pct: 80, mem_mb: 1024 },
    { event: TELEMETRY_EVENTS.RESOURCE_SAMPLE, cpu_pct: 90, mem_mb: 512 },
    { event: TELEMETRY_EVENTS.RETRY_ATTEMPT, attempt: 1 },
  ];
  const s = summarizeTelemetry(events);
  assert.equal(s.model_turns, 2);
  assert.equal(s.total_model_duration_ms, 3000);
  assert.equal(s.total_tokens, 300);
  assert.equal(s.total_cost, 0.03);
  assert.equal(s.tool_calls, 1);
  assert.equal(s.tool_errors, 1);
  assert.equal(s.resource_samples, 2);
  assert.equal(s.max_memory_mb, 1024);
  assert.equal(s.max_cpu_pct, 90);
  assert.equal(s.retries, 1);
  assert.equal(s.errors.length, 1);
});

test('extractTelemetryFromTranscript extracts model and tool events', () => {
  const records = [
    { type: 'turn_end', message: { timestamp: Date.now(), duration: 3000, usage: { totalTokens: 500, cost: { total: 0.005 } } } },
    { type: 'tool_execution_start', tool_name: 'bash' },
    { type: 'tool_execution_end', tool_name: 'bash', result: { details: { wallTimeMs: 1200 } } },
    { type: 'tool_execution_end', tool_name: 'read', isError: true, result: { details: { error: 'file not found' } } },
  ];
  const events = extractTelemetryFromTranscript(records);
  assert.ok(events.some(e => e.event === TELEMETRY_EVENTS.MODEL_TURN_END));
  assert.ok(events.some(e => e.event === TELEMETRY_EVENTS.TOOL_END && e.tool === 'bash'));
  assert.ok(events.some(e => e.event === TELEMETRY_EVENTS.TOOL_ERROR && e.tool === 'read'));
});

// ============ Query Layer Tests ============

function makeFakeRun(evalsDir, name, sessions = []) {
  const runDir = path.join(evalsDir, name);
  fs.mkdirSync(runDir, { recursive: true });
  writeJson(path.join(runDir, 'run.json'), {
    skill: { name: 'test-skill', kind: 'skill' },
    skill_hash: 'a'.repeat(64),
    scenarios_hash: 'b'.repeat(64),
    model: { model: 'test/model', alias: 'test' },
    t_start: new Date().toISOString(),
    t_end: new Date().toISOString(),
    limits: { timeout: 600, reps: 1 },
    sessions: sessions.length,
    timeouts: sessions.filter(s => s.timeout).length,
    session_cost: 0.1,
    pass_rate: null,
  });
  for (const s of sessions) {
    const dir = path.join(runDir, s.name);
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
    writeJson(path.join(dir, 'result.json'), {
      scenario: s.scenario,
      kind: s.kind ?? 'positive',
      exit_code: s.exit_code ?? 0,
      timeout: s.timeout ?? false,
      timeout_kind: s.timeout ? 'killed' : null,
      duration_ms: s.duration_ms ?? 1000,
      error_class: s.error_class ?? null,
      skill_loaded: s.skill_loaded ?? true,
      turns: 5,
      tokens: 1000,
      cost: 0.01,
      errors: 0,
      stdout_bytes: 1000,
      stderr_bytes: 0,
      oom_killed: false,
      transcript_chars: 5000,
      telemetry_summary: s.telemetry_summary ?? null,
    });
    writeJson(path.join(dir, 'scenario.json'), { id: s.scenario, kind: s.kind ?? 'positive', prompt: 'test', expected: { steps: [] } });
    writeJson(path.join(dir, 'events.json'), []);
    if (s.steps) {
      writeJson(path.join(dir, 'grading.json'), { scenario: s.scenario, steps: s.steps });
    }
  }
  return runDir;
}

test('query layer indexes runs and answers failing-steps', () => {
  const dir = tmpdir('query-');
  makeFakeRun(dir, 'run-1', [
    { name: 'pos-a-r1', scenario: 'pos-a', steps: [
      { id: 'step-1', verdict: 'done', p_done: 1, p_not_done: 0, p_unclear: 0 },
      { id: 'step-2', verdict: 'wrong', p_done: 0, p_not_done: 1, p_unclear: 0 },
    ] },
    { name: 'pos-a-r2', scenario: 'pos-a', steps: [
      { id: 'step-1', verdict: 'done', p_done: 1, p_not_done: 0, p_unclear: 0 },
      { id: 'step-2', verdict: 'wrong', p_done: 0, p_not_done: 1, p_unclear: 0 },
    ] },
  ]);
  const db = openMetricsDb(dir);
  indexRun(db, path.join(dir, 'run-1'));
  const failing = queryFailingSteps(db, { minFailures: 1 });
  assert.ok(failing.some(r => r.step_id === 'step-2' && r.fail_count === 1));
  db.close();
});

test('query layer detects flaky steps', () => {
  const dir = tmpdir('flaky-');
  makeFakeRun(dir, 'run-1', [
    { name: 'pos-a-r1', scenario: 'pos-a', steps: [{ id: 'flaky-step', verdict: 'done', p_done: 1, p_not_done: 0, p_unclear: 0 }] },
    { name: 'pos-a-r2', scenario: 'pos-a', steps: [{ id: 'flaky-step', verdict: 'wrong', p_done: 0, p_not_done: 1, p_unclear: 0 }] },
  ]);
  const db = openMetricsDb(dir);
  indexRun(db, path.join(dir, 'run-1'));
  const flaky = queryFlakySteps(db, { minRuns: 1 });
  assert.ok(flaky.some(r => r.step_id === 'flaky-step'));
  db.close();
});

test('query layer aggregates error classes', () => {
  const dir = tmpdir('errors-');
  makeFakeRun(dir, 'run-1', [
    { name: 's1', scenario: 'pos', error_class: 'timeout' },
    { name: 's2', scenario: 'pos', error_class: 'timeout' },
    { name: 's3', scenario: 'pos', error_class: 'skill_ignored' },
  ]);
  const db = openMetricsDb(dir);
  indexRun(db, path.join(dir, 'run-1'));
  const errors = queryErrorClasses(db);
  const timeoutRow = errors.find(r => r.error_class === 'timeout');
  assert.equal(timeoutRow?.count, 2);
  db.close();
});

test('query layer lists runs and slow sessions', () => {
  const dir = tmpdir('slow-');
  makeFakeRun(dir, 'run-1', [
    { name: 'fast', scenario: 'pos', duration_ms: 1000 },
    { name: 'slow', scenario: 'pos', duration_ms: 60000 },
  ]);
  const db = openMetricsDb(dir);
  indexRun(db, path.join(dir, 'run-1'));
  const runs = queryRuns(db);
  assert.equal(runs.length, 1);
  const slow = querySlowSessions(db, { limit: 1 });
  assert.equal(slow[0].session, 'slow');
  db.close();
});

// ============ Stream Server Tests ============

test('startStreamServer serves SSE events', async () => {
  const dir = tmpdir('stream-');
  const runDir = path.join(dir, 'test-run');
  fs.mkdirSync(path.join(runDir, 'session-1'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'session-1', 'telemetry.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), event: 'session_start', session: 'session-1' }) + '\n');

  const server = await startStreamServer(runDir, 0);
  assert.ok(server.port > 0);

  // Test SSE endpoint
  const http = await import('node:http');
  const data = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${server.port}/events`, (res) => {
      let body = '';
      res.on('data', chunk => {
        body += chunk;
        if (body.includes('sessions_list')) {
          req.destroy();
          resolve(body);
        }
      });
    });
    req.on('error', () => {}); // expected when we destroy
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  assert.ok(data.includes('session-1'));
  server.close();
});

test('startStreamServer returns 404 for unknown paths', async () => {
  const dir = tmpdir('stream404-');
  const server = await startStreamServer(dir, 0);
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${server.port}/unknown`, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 404);
  server.close();
});
