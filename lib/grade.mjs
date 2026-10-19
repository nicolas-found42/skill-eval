import fs from 'node:fs';
import path from 'node:path';
import { Jev } from './jev.mjs';
import { readSkill } from './skill.mjs';
import { pool } from './pool.mjs';
import { requireRunFrozen } from './validate.mjs';

export const EVIDENCE_CAP = 200_000;
export const DONE_AT = 0.8;
export const NOT_DONE_AT = 0.8;
export const UNCLEAR_AT = 0.4;
export const WRONG_AT = 0.5;

/** Flatten the event timeline into the transcript text the judge reads. */
export function flatten(events) {
  return events.map(e => e.kind === 'tool_call' ? `[turn ${e.turn}] TOOL CALL ${e.tool}: ${e.args}`
    : e.kind === 'tool_result' ? `[turn ${e.turn}] TOOL RESULT (${e.tool ?? 'tool'}): ${e.text}`
    : `[turn ${e.turn}] ASSISTANT: ${e.text}`).join('\n');
}

/** Read every file under the session workspace (text only), keyed by relative path. */
export function readWorkspace(dir, maxFileChars = 20_000) {
  const root = path.join(dir, 'workspace');
  const out = {};
  if (!fs.existsSync(root)) return out;
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        const buf = fs.readFileSync(p);
        if (buf.includes(0)) continue; // binary
        const text = buf.toString('utf8');
        out[path.relative(root, p)] = text.length > maxFileChars ? text.slice(0, maxFileChars) : text;
      }
    }
  };
  walk(root);
  return out;
}

/** Order steps so every step comes after its requirements; the validator already rejected cycles. */
function topo(steps) {
  const byId = new Map(steps.map(s => [s.id, s]));
  const done = new Set(), out = [];
  const visit = s => { if (done.has(s.id)) return; done.add(s.id); for (const r of s.requires ?? []) visit(byId.get(r)); out.push(s); };
  steps.forEach(visit);
  return out;
}

/** Pure verdict mapping from the judge's probabilities (the spec's table). */
export function mapVerdict({ pDone, pNotDone, pUnclear, pAttemptedWrong, truncated }) {
  if (pUnclear >= UNCLEAR_AT) return 'needs_human';
  if (pDone >= DONE_AT) return truncated ? 'needs_human' : 'done';
  if (pNotDone >= NOT_DONE_AT) return (pAttemptedWrong ?? 0) >= WRONG_AT ? 'wrong' : 'skipped';
  return 'needs_human';
}

/**
 * Judge the claim exactly as worded. A step phrased as an expected non-action ("the agent did not create a file")
 * is a claim that is true only when that thing did not happen; asking "did this step happen" inverted those in testing.
 */
const stepQuestion = st => ({
  type: 'choice',
  instructions: { claim: st.description, evidence_hint: st.evidence_hint ?? null, question: 'Using only `transcript` and `workspace_files` (and `skill_instructions` for what was required), is `claim` true of this session? Judge the claim exactly as worded: if it says something did NOT happen, it is true only when the evidence shows that thing did not happen. A claim in prose without the matching tool call or file content does not count.' },
  criteria: {
    done: 'The claim, exactly as worded, is clearly true according to the evidence.',
    not_done: 'The claim, exactly as worded, is false according to the evidence, or the evidence it would require is absent.',
    unclear: 'The evidence is genuinely ambiguous about whether the claim is true.',
  },
});
const attemptedWrongQuestion = st => ({
  type: 'noul',
  instructions: { claim: st.description, question: 'Setting aside whether the step succeeded: did the agent make a real attempt at this step (a relevant tool call or edit) that was done incorrectly, on the wrong target, or with the wrong content?' },
  criteria: { true: 'The agent tried the step but did it wrongly (wrong file, wrong content, wrong command, wrong result).', false: 'The agent made no attempt at this step at all.' },
});

/**
 * The state every judge call sees: skill text, task, followups, the flattened transcript and the workspace files.
 * The whole state is capped; an over-cap transcript is cut and `truncated` is set, which grading never lets auto-pass.
 */
export function buildEvidence({ skill, scenario, events, workspace, evidenceCap = EVIDENCE_CAP }) {
  let transcript = flatten(events);
  const fixed = JSON.stringify({ skill_instructions: skill.text, user_task: scenario.prompt, workspace_files: workspace }).length;
  let truncated = false;
  if (transcript.length + fixed > evidenceCap) {
    truncated = true;
    transcript = transcript.slice(0, Math.max(0, evidenceCap - fixed));
  }
  const state = { skill_instructions: skill.text, user_task: scenario.prompt, followups: scenario.followups ?? [], transcript, workspace_files: workspace };
  return { state, truncated, chars: transcript.length + fixed };
}

/**
 * Grade one session folder. Writes grading.json and returns it. Steps whose requirements are not `done` are blocked and never judged.
 * @param {string} dir
 * @param {{ skill: { text: string }, jev: Jev, evidenceCap?: number }} ctx
 */
export async function gradeSession(dir, { skill, jev, evidenceCap = EVIDENCE_CAP }) {
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
  const startCost = jev.cost, startCalls = jev.calls;

  const { state, truncated, chars } = buildEvidence({ skill, scenario, events, workspace: readWorkspace(dir), evidenceCap });

  const verdicts = new Map();
  const results = [];
  for (const st of topo(scenario.expected.steps)) {
    const unmet = (st.requires ?? []).filter(r => verdicts.get(r) !== 'done');
    if (unmet.length) {
      verdicts.set(st.id, 'blocked');
      results.push({ id: st.id, description: st.description, verdict: 'blocked', blocked_by: unmet, p_done: null, p_not_done: null, p_unclear: null, p_attempted_wrong: null });
      continue;
    }
    // independent questions over the same state are asked together (they cannot see each other)
    const a = await jev.ask(state, { step: stepQuestion(st), attempted: attemptedWrongQuestion(st) });
    const p = a.step.probabilities;
    const pDone = p.done ?? 0, pNotDone = p.not_done ?? 0, pUnclear = p.unclear ?? 0;
    const verdict = mapVerdict({ pDone, pNotDone, pUnclear, pAttemptedWrong: a.attempted.noul, truncated });
    verdicts.set(st.id, verdict);
    results.push({ id: st.id, description: st.description, verdict, p_done: pDone, p_not_done: pNotDone, p_unclear: pUnclear, p_attempted_wrong: a.attempted.noul, confidence: a.step.confidence ?? null });
  }
  // present in the scenario's own order
  const order = scenario.expected.steps.map(s => s.id);
  results.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));

  const grading = {
    scenario: scenario.id,
    truncated,
    evidence_chars: chars,
    steps: results,
    judge: { model: jev.model, snapshots: [...jev.snapshots], cost: jev.cost - startCost, calls: jev.calls - startCalls },
  };
  fs.writeFileSync(path.join(dir, 'grading.json'), JSON.stringify(grading, null, 2));
  return grading;
}

/** Names of the session folders in a run folder: the ones `normalize` has produced events.json for, sorted. */
export function sessionDirs(runDir) {
  return fs.readdirSync(runDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(runDir, e.name, 'events.json')))
    .map(e => e.name).sort();
}

/** Grade every session folder in a run folder. Refuses a run whose scenarios no longer match their frozen hash. */
export async function gradeRun(runDir, { jev = new Jev(), evidenceCap = EVIDENCE_CAP, concurrency = 4 } = {}) {
  requireRunFrozen(runDir);
  const skill = readSkill(path.join(runDir, 'skill'));
  return pool(sessionDirs(runDir), concurrency, name => gradeSession(path.join(runDir, name), { skill, jev: jev.fork(), evidenceCap }));
}
