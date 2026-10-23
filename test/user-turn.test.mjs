import test from 'node:test';
import assert from 'node:assert/strict';
import { flatten } from '../lib/grade.mjs';
import { normalizeSession } from '../lib/normalize.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * A scripted followup arrives as a second user message in the same container.
 * The transcript must mark where it landed: an ordering claim like "did not
 * render before the approval turn" is unjudgeable against one flat sequence,
 * which is how a correct refusal-then-render scored 0.25.
 */
test('flatten renders a user turn as its own line', () => {
  const text = flatten([
    { turn: 1, kind: 'tool_call', tool: 'read', args: '{}' },
    { turn: 1, kind: 'assistant_text', text: 'Plan ready; approve it?' },
    { turn: 2, kind: 'user_turn', text: 'Approved, go ahead' },
    { turn: 2, kind: 'tool_call', tool: 'bash', args: '{"command":"node render.mjs"}' },
  ]);
  assert.match(text, /\[turn 2\] USER: Approved, go ahead/);
  assert.ok(text.indexOf('USER:') < text.indexOf('render.mjs'), 'approval precedes the render');
});

test('a followup user message becomes a user_turn event after the first assistant turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-'));
  const lines = [
    { type: 'session', timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'build a deck' }], timestamp: 1 } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Plan ready.' }], timestamp: 2, usage: {} } },
    { type: 'turn_end', message: { duration: 10 } },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'approved' }], timestamp: 3 } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Rendered.' }], timestamp: 4, usage: {} } },
  ];
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ id: 's', kind: 'positive', prompt: 'build a deck', expected: { steps: [] } }));
  normalizeSession(dir);
  const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
  const users = events.filter(e => e.kind === 'user_turn');
  assert.equal(users.length, 1, 'the opening prompt is not a followup');
  assert.equal(users[0].text, 'approved');
  assert.ok(users[0].turn > 1);
});
