import fs from 'node:fs';
import path from 'node:path';

export const EVENT_CAP = 4_000;

const clip = (s, cap = EVENT_CAP) => (s.length > cap ? { text: s.slice(0, cap), truncated: true } : { text: s, truncated: false });

/** Parse omp `--mode json` JSONL, skipping lines that are not complete JSON (a killed container cuts the last one). */
export function parseJsonl(raw) {
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial trailing line */ }
  }
  return out;
}

/**
 * Turn raw omp events into a flat, capped timeline plus session totals.
 * `skillName` identifies a skill load: a `read` of `skill://<name>` or of any path ending in `<name>/SKILL.md`.
 * @param {any[]} records
 * @param {{ skillName?: string }} [opts]
 */
export function normalizeEvents(records, { skillName } = /** @type {{ skillName?: string }} */ ({})) {
  const events = [];
  const toolSequence = [];
  let turn = 0, tokens = 0, cost = 0, skillLoaded = false, skillLoadedTurn = null;
  const loadsSkill = args => {
    const p = String(args?.path ?? '');
    return skillName != null && (p === `skill://${skillName}` || p.startsWith(`skill://${skillName}/`) || p.endsWith(`/${skillName}/SKILL.md`));
  };
  const turnOfCall = new Map();

  for (const e of records) {
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      turn++;
      tokens += e.message.usage?.totalTokens ?? 0;
      cost += e.message.usage?.cost?.total ?? 0;
      for (const part of e.message.content ?? []) {
        if (part.type === 'text' && part.text.trim()) {
          events.push({ turn, kind: 'assistant_text', ...clip(part.text.trim()) });
        } else if (part.type === 'toolCall') {
          turnOfCall.set(part.id, turn);
          toolSequence.push(part.name);
          if (part.name === 'read' && !skillLoaded && loadsSkill(part.arguments)) { skillLoaded = true; skillLoadedTurn = turn; }
          const a = clip(JSON.stringify(part.arguments ?? {}));
          events.push({ turn, kind: 'tool_call', tool: part.name, args: a.text, truncated: a.truncated });
        }
      }
    } else if (e.type === 'tool_execution_end') {
      const text = (e.result?.content ?? []).map(c => c.text ?? '').join('');
      events.push({ turn: turnOfCall.get(e.toolCallId) ?? turn, kind: 'tool_result', tool: e.toolName, ...clip(text) });
    }
  }
  return { events, toolSequence, tokens, cost, skillLoaded, skillLoadedTurn, turns: turn };
}

/** Read a session folder (transcript.jsonl + scenario.json), write events.json and result.json. */
export function normalizeSession(dir, { timedOut = false, exitCode = null, durationMs = null } = {}) {
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8');
  const n = normalizeEvents(parseJsonl(raw), { skillName: scenario.skill });
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(n.events, null, 2));
  const result = {
    scenario: scenario.id,
    kind: scenario.kind,
    exit_code: exitCode,
    timeout: timedOut,
    duration_ms: durationMs,
    skill_loaded: n.skillLoaded,
    skill_loaded_turn: n.skillLoadedTurn,
    tool_sequence: n.toolSequence,
    turns: n.turns,
    tokens: n.tokens,
    cost: n.cost,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}
