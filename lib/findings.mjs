export const SAME_ISSUE_AT = 0.7;

/** The one question behind every "same issue?" decision: cross-scenario merging and run-to-run compare must agree. */
export const sameIssueJudge = jev => (a, b) => jev.noul(
  { finding_a: a, finding_b: b },
  'Do `finding_a` and `finding_b` describe the same underlying defect (same missing step or same wrong behavior), regardless of wording?',
  { true: 'Same underlying defect.', false: 'Different defects.' });

const FAIL_VERDICTS = new Set(['skipped', 'wrong']);
const quote = (s, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s+/g, ' ').trim();

/**
 * Full-sentence description of what went wrong. Merging and `compare` ask the judge whether two descriptions
 * share a cause; a terse "Step skipped: X" prefix scored a genuine rewording at 0.19, this sentence form at 0.97.
 */
export function stepDescription(verdict, text) {
  if (verdict === 'skipped') return `Expected step was not performed (skipped). The step was: "${text}"`;
  if (verdict === 'wrong') return `Expected step was attempted but done wrongly. The step was: "${text}"`;
  return `It is unclear whether the expected step was performed. The step was: "${text}"`;
}

/**
 * Where in events.json to look for a step: the tool call that matches one of its quoted terms, else the last assistant
 * message, else the first event. Only tool calls are matched: the skill text and tool results quote the same commands,
 * which pointed a skipped step at the skill file instead of at what the agent actually did.
 */
function pointFor(step, events) {
  const words = [...step.description.matchAll(/`([^`]+)`|"([^"]+)"|'([^']+)'/g)].map(m => m[1] ?? m[2] ?? m[3]);
  const probes = words.filter(Boolean);
  let idx = -1;
  for (const p of probes) { idx = events.findIndex(e => e.kind === 'tool_call' && (e.args ?? '').includes(p)); if (idx >= 0) break; }
  if (idx < 0) idx = events.map(e => e.kind).lastIndexOf('assistant_text');
  if (idx < 0) idx = 0;
  const e = events[idx] ?? { turn: 0, kind: 'none' };
  return { pointer: { turn: e.turn, event_index: idx }, evidence: quote(e.args ?? e.text ?? '(no events)') };
}

/**
 * Per-session findings from grading + classification + derived facts.
 * `description` is the plain-language text used for cross-scenario merging.
 */
export function sessionFindings({ scenario, events, grading, labels, derived }) {
  const out = [];
  for (const s of grading.steps) {
    if (!FAIL_VERDICTS.has(s.verdict) && s.verdict !== 'needs_human') continue;
    const pt = pointFor(scenario.expected.steps.find(x => x.id === s.id), events);
    out.push({
      scenario: scenario.id, step: s.id, label: s.verdict === 'needs_human' ? 'needs_human' : s.verdict, source: 'judge',
      severity: s.verdict === 'needs_human' ? 'review' : 'high',
      description: stepDescription(s.verdict, scenario.expected.steps.find(x => x.id === s.id).description),
      probabilities: { p_done: s.p_done, p_not_done: s.p_not_done, p_unclear: s.p_unclear, p_attempted_wrong: s.p_attempted_wrong },
      ...pt,
    });
  }
  for (const d of derived) {
    out.push({ scenario: scenario.id, step: null, label: d.label, source: 'derived', severity: d.severity, description: d.note, probability: 1, pointer: { turn: 0, event_index: 0 }, evidence: d.note });
  }
  for (const l of labels.judged) {
    const idx = Math.max(0, events.map(e => e.kind).lastIndexOf('assistant_text'));
    const e = events[idx] ?? { turn: 0 };
    out.push({
      scenario: scenario.id, step: null, label: l.label, source: 'judge', severity: 'high', probability: l.probability,
      description: `${l.label.replace(/_/g, ' ')} in scenario ${scenario.id}`,
      pointer: { turn: e.turn, event_index: idx }, evidence: quote(e.text ?? e.args ?? ''),
    });
  }
  return out;
}

/**
 * Merge findings with the same cause across scenarios. Same label + same step merge directly (deterministic);
 * remaining step-less judged findings with the same label merge too. A judge call is used only to decide
 * whether two *different-step* findings share a cause, via `sameIssue(a, b) -> probability`.
 */
export async function mergeFindings(all, sameIssue) {
  const groups = [];
  for (const f of all) {
    let g = groups.find(x => x.label === f.label && x.step === f.step && x.source === f.source);
    if (!g && sameIssue && f.step != null) {
      for (const x of groups) {
        if (x.label !== f.label || x.step == null || x.step === f.step) continue;
        if ((await sameIssue(x.description, f.description)) >= SAME_ISSUE_AT) { g = x; break; }
      }
    }
    if (g) {
      g.count++;
      if (!g.scenarios.includes(f.scenario)) g.scenarios.push(f.scenario);
      g.examples.push({ scenario: f.scenario, pointer: f.pointer, evidence: f.evidence });
      if (f.probability != null) g.probability = Math.max(g.probability ?? 0, f.probability);
    } else {
      groups.push({ ...f, count: 1, scenarios: [f.scenario], examples: [{ scenario: f.scenario, pointer: f.pointer, evidence: f.evidence }] });
    }
  }
  const rank = { high: 0, review: 1, info: 2 };
  return groups.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count).map((g, i) => ({ id: `F${i + 1}`, ...g }));
}
