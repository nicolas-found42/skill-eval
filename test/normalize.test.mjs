import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, readJson, writeJson, ROOT } from './helpers.mjs';

const BASE = path.join(ROOT, 'fixtures', 'base');

/** Copy a recorded session into a fresh dir with a scenario.json, as the runner would leave it. */
function sessionFrom(id, scenario) {
  const d = tmpdir('norm-');
  fs.copyFileSync(path.join(BASE, id, 'transcript.jsonl'), path.join(d, 'transcript.jsonl'));
  writeJson(path.join(d, 'scenario.json'), { id, kind: 'positive', prompt: 'p', skill: 'pirate-notes', ...scenario });
  return d;
}

test('normalize writes events.json with the real tool-call sequence in order', async () => {
  const d = sessionFrom('pos1');
  const r = await cli(['normalize', d]);
  assert.equal(r.code, 0, r.stderr);
  const res = readJson(path.join(d, 'result.json'));
  assert.deepEqual(res.tool_sequence, ['read', 'write', 'bash']);
});

test('normalize flags skill_loaded true when the skill was read via skill://', async () => {
  const d = sessionFrom('pos1');
  await cli(['normalize', d]);
  const res = readJson(path.join(d, 'result.json'));
  assert.equal(res.skill_loaded, true);
  assert.equal(res.skill_loaded_turn, 1);
});

test('normalize flags skill_loaded false for a session that never read the skill', async () => {
  const d = sessionFrom('neg1', { kind: 'negative' });
  await cli(['normalize', d]);
  assert.equal(readJson(path.join(d, 'result.json')).skill_loaded, false);
});

test('normalize reports exact token and cost totals summed over assistant messages', async () => {
  const d = sessionFrom('pos1');
  await cli(['normalize', d]);
  const res = readJson(path.join(d, 'result.json'));
  // literal totals of the recorded pos1 session, computed once from its raw transcript by a separate script
  assert.equal(res.tokens, 32181);
  assert.ok(Math.abs(res.cost - 0.000499578) < 1e-9, `cost ${res.cost}`);
});

test('events.json events carry turn, kind, and the tool arguments the model used', async () => {
  const d = sessionFrom('pos1');
  await cli(['normalize', d]);
  const ev = readJson(path.join(d, 'events.json'));
  const wc = ev.find(e => e.kind === 'tool_call' && e.tool === 'bash');
  assert.ok(wc, 'bash call present');
  assert.match(wc.args, /wc -l memo\.md/);
  assert.equal(typeof wc.turn, 'number');
  const out = ev.find(e => e.kind === 'tool_result' && e.turn === wc.turn);
  assert.match(out.text, /^\d+ memo\.md/);
});

test('events.json caps each event text so one huge tool result cannot dominate', async () => {
  const d = tmpdir('norm-');
  const lines = [
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'bash', arguments: { command: 'cat big' } }], usage: { totalTokens: 1, cost: { total: 0 } } } },
    { type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', result: { content: [{ type: 'text', text: 'x'.repeat(50_000) }] } },
  ];
  fs.writeFileSync(path.join(d, 'transcript.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'));
  writeJson(path.join(d, 'scenario.json'), { id: 'big', kind: 'positive', prompt: 'p', skill: 's' });
  await cli(['normalize', d]);
  const ev = readJson(path.join(d, 'events.json'));
  const res = ev.find(e => e.kind === 'tool_result');
  assert.ok(res.text.length <= 4_000 + 50, `capped, got ${res.text.length}`);
  assert.equal(res.truncated, true);
});

test('normalize tolerates a transcript cut mid-line (killed container) and marks the session timeout when asked', async () => {
  const d = sessionFrom('pos1');
  const raw = fs.readFileSync(path.join(d, 'transcript.jsonl'), 'utf8');
  fs.writeFileSync(path.join(d, 'transcript.jsonl'), raw.slice(0, Math.floor(raw.length * 0.8)));
  const r = await cli(['normalize', d, '--timed-out']);
  assert.equal(r.code, 0, r.stderr);
  const res = readJson(path.join(d, 'result.json'));
  assert.equal(res.timeout, true);
  assert.equal(res.skill_loaded, true);
});
