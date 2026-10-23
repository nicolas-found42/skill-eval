import fs from 'node:fs';
import path from 'node:path';
import { Jev } from './jev.mjs';
import { readSkill } from './skill.mjs';
import { pool } from './pool.mjs';
import { requireRunFrozen } from './validate.mjs';
import { classifyError, suggestFix } from './errors.mjs';
import { TelemetryWriter, TELEMETRY_EVENTS } from './telemetry.mjs';


export const EVIDENCE_CAP = 200_000;
export const DONE_AT = 0.8;
export const NOT_DONE_AT = 0.8;
export const UNCLEAR_AT = 0.4;
export const WRONG_AT = 0.5;

/** Flatten the event timeline into the transcript text the judge reads. */
export function flatten(events) {
  return events.map(e => e.kind === 'tool_call' ? `[turn ${e.turn}] TOOL CALL ${e.tool}: ${e.args}`
    : e.kind === 'tool_result' ? `[turn ${e.turn}] TOOL RESULT (${e.tool ?? 'tool'}): ${e.text}`
    : e.kind === 'user_turn' ? `[turn ${e.turn}] USER: ${e.text}`
    : `[turn ${e.turn}] ASSISTANT: ${e.text}`).join('\n');
}

/**
 * Read every file under the session workspace (text only), keyed by relative path.
 *
 * Capped per file AND in total. A session that installs a Python venv in its
 * workspace — which a QA step legitimately does — put 20.7 MB of site-packages
 * into the judge state and two sessions failed grading with
 * max_tokens_exceeded. A dependency tree the agent installed is not evidence of
 * what it did, and reading it is not worth a failed judge call.
 */
export function readWorkspace(dir, maxFileChars = 20_000, maxTotalChars = 120_000) {
  const root = path.join(dir, 'workspace');
  const out = {};
  if (!fs.existsSync(root)) return out;
  // Machine-installed trees, not authored artifacts: they are large, binary
  // mostly, and never bear on whether a step happened.
  const SKIP_DIRS = new Set(['node_modules', 'site-packages', '__pycache__', '.git', 'venv', '.venv']);
  let total = 0;
  const walk = d => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(p);
        continue;
      }
      if (!ent.isFile() || total >= maxTotalChars) continue;
      const buf = fs.readFileSync(p);
      if (buf.includes(0)) continue; // binary
      const text = buf.toString('utf8');
      const slice = text.length > maxFileChars ? text.slice(0, maxFileChars) : text;
      out[path.relative(root, p)] = slice;
      total += slice.length;
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
  instructions: { claim: st.description, evidence_hint: st.evidence_hint ?? null, question: 'Using only `transcript` and `workspace_files` (and `skill_instructions` for what was required), is `claim` true of this session? Judge the claim exactly as worded: a claim that something did NOT happen is true when the evidence contains no instance of it. The transcript is the COMPLETE session, so absence of a tool call is evidence that the tool was never called — do not answer unclear merely because the action is absent. A claim that something DID happen needs the matching tool call or file content; prose alone does not count.' },
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
  const flat = flatten(events);
  const fixedChars = {
    skill_chars: skill.text.length,
    prompt_chars: scenario.prompt.length,
    followups_chars: (scenario.followups ?? []).join('\n').length,
    transcript_chars: flat.length,
    workspace_chars: JSON.stringify({ workspace_files: workspace }).length,
  };
  let transcript = flat;
  const fixed = JSON.stringify({ skill_instructions: skill.text, user_task: scenario.prompt, workspace_files: workspace }).length;
  let truncated = false;
  if (transcript.length + fixed > evidenceCap) {
    truncated = true;
    transcript = transcript.slice(0, Math.max(0, evidenceCap - fixed));
  }
  const state = { skill_instructions: skill.text, user_task: scenario.prompt, followups: scenario.followups ?? [], transcript, workspace_files: workspace };
  return { state, truncated, chars: transcript.length + fixed, fixedChars };
}

/**
 * Grade one session folder. Writes grading.json and returns it. Steps whose requirements are not `done` are blocked and never judged.
 * With `keepEvidence`, also writes grading.evidence.json for every session; without it, the file is
 * still written when any step verdict is needs_human or the evidence was truncated — the sessions
 * where the exact state, questions and answers each judge call saw (secret-free; the key is never
 * in the evidence) are the only way to audit the verdict without re-paying the judge.
 * @param {string} dir
 * @param {{ skill: { text: string }, jev: Jev, evidenceCap?: number, keepEvidence?: boolean }} ctx
 */
export async function gradeSession(dir, { skill, jev, evidenceCap = EVIDENCE_CAP, keepEvidence = false }) {
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const events = JSON.parse(fs.readFileSync(path.join(dir, 'events.json'), 'utf8'));
  const startCost = jev.cost, startCalls = jev.calls;
  // Per-session telemetry for grading events
  const telemetryPath = path.join(dir, 'telemetry.jsonl');
  const telemetry = fs.existsSync(telemetryPath) ? new TelemetryWriter(telemetryPath) : null;
  telemetry?.emit(TELEMETRY_EVENTS.GRADE_START, { session: path.basename(dir), scenario: scenario.id });


  const { state, truncated, chars, fixedChars } = buildEvidence({ skill, scenario, events, workspace: readWorkspace(dir), evidenceCap });
  const kept = [];
  const trace = [];

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
    const questions = { step: stepQuestion(st), attempted: attemptedWrongQuestion(st) };
    const a = await jev.ask(state, questions);
    const p = a.step.probabilities;
    const pDone = p.done ?? 0, pNotDone = p.not_done ?? 0, pUnclear = p.unclear ?? 0;
    const verdict = mapVerdict({ pDone, pNotDone, pUnclear, pAttemptedWrong: a.attempted.noul, truncated });
    verdicts.set(st.id, verdict);
    results.push({ id: st.id, description: st.description, verdict, p_done: pDone, p_not_done: pNotDone, p_unclear: pUnclear, p_attempted_wrong: a.attempted.noul, confidence: a.step.confidence ?? null });
    // The evidence file is written when any step needs a human or the transcript was cut, so
    // collect per-step state on that path too — otherwise the file would exist but be empty.
    if (keepEvidence || verdict === 'needs_human') kept.push({ step: st.id, questions, answers: a });
    // The trace: what was asked, what came back, and the slice of evidence the judge saw. Without
    // it a "needs_human" verdict is unexplainable and the only way to audit it is to pay for the
    // judge again — with a different answer. Bounded so grading.json stays readable.
    trace.push({
      step: st.id,
      questions,
      answers: { step: a.step, attempted: a.attempted },
      evidence: {
        chars: state.transcript.length,
        head: state.transcript.slice(0, 600),
        tail: state.transcript.slice(-600),
      },
    });
    telemetry?.emit(TELEMETRY_EVENTS.GRADE_STEP, { step: st.id, verdict, p_done: pDone, p_not_done: pNotDone, p_unclear: pUnclear });
  }
  // present in the scenario's own order
  const order = scenario.expected.steps.map(s => s.id);
  results.sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));

  const grading = {
    scenario: scenario.id,
    truncated,
    evidence_chars: chars,
    evidence_breakdown: fixedChars,
    steps: results,
    judge: { model: jev.model, snapshots: [...jev.snapshots], cost: jev.cost - startCost, calls: jev.calls - startCalls },
    // What the judge was asked, what it answered, and the evidence slice it saw. Kept by
    // default: an unexplainable verdict costs a judge call to re-ask, and the answer changes.
    judge_trace: trace,
  };
  // Re-classify error with grading data for better accuracy
  try {
    const resultPath = path.join(dir, 'result.json');
    if (fs.existsSync(resultPath)) {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      result.error_class = classifyError(result, grading, scenario);
      result.error_fix = suggestFix(result.error_class);
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
    }
  } catch { /* best-effort */ }
  telemetry?.emit(TELEMETRY_EVENTS.GRADE_END, { session: path.basename(dir), steps: results.length, truncated });
  telemetry?.close();
  fs.writeFileSync(path.join(dir, 'grading.json'), JSON.stringify(grading, null, 2));
  // Evidence retention: --keep-evidence keeps it for every session; otherwise it is kept for
  // exactly the sessions where it is the only way to audit a verdict without re-paying the
  // judge — a needs_human step or an over-cap transcript. An unexplained needs_human is the
  // default failure mode of a flaky judge, so the file is small precisely when it matters.
  const needsAudit = truncated || results.some(s => s.verdict === 'needs_human');
  if (keepEvidence || needsAudit) fs.writeFileSync(path.join(dir, 'grading.evidence.json'), JSON.stringify({ scenario: scenario.id, state, steps: kept }, null, 2));
  else fs.rmSync(path.join(dir, 'grading.evidence.json'), { force: true });
  return grading;
}

/** Names of the session folders in a run folder: the ones `normalize` has produced events.json for, sorted. */
export function sessionDirs(runDir) {
  return fs.readdirSync(runDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(runDir, e.name, 'events.json')))
    .map(e => e.name).sort();
}

/** Grade every session folder in a run folder. Refuses a run whose scenarios no longer match their frozen hash. */
export async function gradeRun(runDir, { jev = new Jev(), evidenceCap = EVIDENCE_CAP, concurrency = 4, keepEvidence = false } = {}) {
  requireRunFrozen(runDir);
  const skill = readSkill(path.join(runDir, 'skill'));
  return pool(sessionDirs(runDir), concurrency, name => gradeSession(path.join(runDir, name), { skill, jev: jev.fork(), evidenceCap, keepEvidence }));
}
