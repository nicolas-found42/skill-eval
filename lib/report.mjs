import fs from 'node:fs';
import path from 'node:path';
import { Jev } from './jev.mjs';
import { readSkill } from './skill.mjs';
import { gradeSession, sessionDirs, EVIDENCE_CAP } from './grade.mjs';
import { classifySession, derivedLabels } from './classify.mjs';
import { sessionFindings, mergeFindings, sameIssueJudge } from './findings.mjs';
import { pool } from './pool.mjs';
import { requireRunFrozen } from './validate.mjs';
import { appendIndex } from './run.mjs';
import { openMetricsDb, indexRun } from './query.mjs';

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Attribute the run: which Jev model judged it and what the whole run cost. The total is recomputed from the session cost
 * every time, so re-analysing a run replaces the analysis cost instead of adding to it. Also folds the
 * per-step verdicts up into run-level history fields (verdict counts, pass rate, per-scenario pass rates),
 * so the index answers "what actually happened" without walking session folders.
 */
function recordJudge(runDir, { model, snapshots, cost, lintCost, per }) {
  const file = path.join(runDir, 'run.json');
  const rj = readJson(file);
  rj.judge = { model, snapshots };
  rj.analysis_cost = cost;
  rj.lint_cost = lintCost;
  rj.total_cost = (rj.session_cost ?? 0) + lintCost + cost;
  if (per) {
    const verdicts = {};
    const byScenario = new Map();
    let stepsTotal = 0, stepsDone = 0;
    for (const p of per) {
      const scn = byScenario.get(p.scenario.id) ?? { reps: 0, reps_done: 0, steps_total: 0, steps_done: 0 };
      scn.reps++;
      let allDone = true;
      for (const s of p.grading.steps) {
        verdicts[s.verdict] = (verdicts[s.verdict] ?? 0) + 1;
        stepsTotal++;
        if (s.verdict === 'done') stepsDone++;
        else allDone = false;
        scn.steps_total++;
        if (s.verdict === 'done') scn.steps_done++;
      }
      if (allDone) scn.reps_done++;
      byScenario.set(p.scenario.id, scn);
    }
    rj.verdicts = verdicts;
    rj.pass_rate = stepsTotal ? stepsDone / stepsTotal : null;
    const prev = new Map((rj.scenario_stats ?? []).map(s => [s.scenario, s]));
    rj.scenario_stats = [...byScenario.entries()].map(([scenario, s]) => ({
      scenario, ...(prev.get(scenario) ?? { reps: s.reps, timeouts: 0, errors: 0 }),
      steps_total: s.steps_total, steps_done: s.steps_done,
      pass_rate: s.steps_total ? s.steps_done / s.steps_total : null,
      reps_done: s.reps_done,
    }));
    rj.timeouts = per.filter(p => p.result.timeout).length;
  }
  fs.writeFileSync(file, JSON.stringify(rj, null, 2));
  // The index is history: refresh this run's line so verdicts/pass rates stay queryable.
  try {
    const evalsDir = path.dirname(runDir);
    const idx = path.join(evalsDir, '.index.jsonl');
    if (fs.existsSync(idx)) {
      const keep = fs.readFileSync(idx, 'utf8').split('\n').filter(l => {
        if (!l.trim()) return false;
        try { return JSON.parse(l).run !== path.basename(runDir); } catch { return true; }
      });
      fs.writeFileSync(idx, (keep.length ? keep.join('\n') + '\n' : ''));
    }
  } catch { /* the index is a convenience, never a failure */ }
  appendIndex(path.dirname(runDir), path.basename(runDir), rj);
}

/** Grade + classify every session, merge findings, write grading.json per session, findings.json and summary.md. */
export async function analyzeRun(runDir, { jev = new Jev(), evidenceCap = EVIDENCE_CAP, keepEvidence = false } = {}) {
  const lock = requireRunFrozen(runDir);
  const skill = readSkill(path.join(runDir, 'skill'));
  const names = sessionDirs(runDir);
  const per = await pool(names, 4, async name => {
    const dir = path.join(runDir, name);
    const j = jev.fork();
    const scenario = readJson(path.join(dir, 'scenario.json'));
    const events = readJson(path.join(dir, 'events.json'));
    const result = readJson(path.join(dir, 'result.json'));
    const grading = await gradeSession(dir, { skill, jev: j, evidenceCap, keepEvidence });
    const labels = await classifySession({ jev: j, skill, scenario, events, dir, evidenceCap });
    grading.labels = labels.judged;
    grading.label_probabilities = labels.all;
    grading.display_only = labels.display_only;
    grading.judge.cost = j.cost; grading.judge.calls = j.calls;
    fs.writeFileSync(path.join(dir, 'grading.json'), JSON.stringify(grading, null, 2));
    const derived = derivedLabels(scenario, result);
    return { name, scenario, events, result, grading, jev: j, findings: sessionFindings({ scenario, events, grading, labels, derived }) };
  });

  const mergeJev = jev.fork();
  const merged = await mergeFindings(per.flatMap(p => p.findings), sameIssueJudge(mergeJev));
  for (const p of per) fs.writeFileSync(path.join(runDir, p.name, 'analysis.md'), renderSessionAnalysis(p));

  const cost = per.reduce((a, p) => a + p.jev.cost, 0) + mergeJev.cost;
  const doc = {
    version: 1,
    skill: skill.name,
    judge: { model: mergeJev.model, cost },
    sessions: per.map(p => ({ name: p.name, scenario: p.scenario.id, kind: p.scenario.kind, skill_loaded: p.result.skill_loaded, timeout: p.result.timeout, steps: Object.fromEntries(p.grading.steps.map(s => [s.id, s.verdict])) })),
    findings: merged,
  };
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(doc, null, 2));
  fs.writeFileSync(path.join(runDir, 'summary.md'), renderSummary(doc));
  recordJudge(runDir, { model: mergeJev.model, snapshots: [...new Set([...per.flatMap(p => [...p.jev.snapshots]), ...mergeJev.snapshots])], cost, lintCost: lock?.lint_cost ?? 0, per });
  // Keep the cross-run index current. A metrics database that lags the runs on disk answers
  // historical questions with holes, and nothing used to say so.
  indexRunIntoMetrics(runDir);
  return doc;
}

/** Add a finished run to the metrics database next to it. Best-effort: never fail a run for it. */
function indexRunIntoMetrics(runDir) {
  try {
    const db = openMetricsDb(path.dirname(runDir));
    try { indexRun(db, runDir); } finally { db.close(); }
  } catch { /* the index is a convenience, never a failure */ }
}

export function renderSummary(doc) {
  const fails = doc.findings.filter(f => f.severity === 'high');
  const review = doc.findings.filter(f => f.severity === 'review');
  const passed = doc.sessions.filter(s => Object.values(s.steps).every(v => v === 'done') && !doc.findings.some(f => f.scenarios.includes(s.scenario) && f.severity === 'high'));
  const L = [`# Eval summary: ${doc.skill}`, ''];
  L.push(`Sessions: ${doc.sessions.length}. Findings: ${fails.length} failing, ${review.length} need a human. Judge: ${doc.judge.model}, $${doc.judge.cost.toFixed(4)}.`, '');
  L.push('## Failures', '');
  if (!fails.length) L.push('No failures.', '');
  for (const f of fails) {
    const where = f.scenarios.join(', ');
    L.push(`### ${f.id} ${f.label}${f.step ? ` (step \`${f.step}\`)` : ''} ×${f.count}`, `- Scenarios: ${where}`, `- ${f.description}`);
    const p = f.probabilities ? `p_not_done=${f.probabilities.p_not_done?.toFixed(2)}, p_attempted_wrong=${f.probabilities.p_attempted_wrong?.toFixed(2)}` : `p=${(f.probability ?? 1).toFixed(2)} (${f.source})`;
    L.push(`- Evidence: ${p}; turn ${f.pointer.turn}, event ${f.pointer.event_index}: "${f.evidence}"`, '');
  }
  L.push('## Passed', '');
  for (const s of passed) L.push(`- ${s.scenario} [${s.kind}]`);
  if (!passed.length) L.push('None.');
  L.push('');
  if (review.length) {
    L.push('## Needs human', '');
    for (const f of review) L.push(`- ${f.id} ${f.scenarios.join(', ')} step \`${f.step}\`: ${f.description} (p_unclear=${f.probabilities?.p_unclear?.toFixed(2)})`);
    L.push('');
  }
  return L.join('\n');
}

/** One session's story for an agent that opens only this folder: verdict per step, labels, and where to look in events.json. */
export function renderSessionAnalysis({ name, scenario, grading, findings, result }) {
  const L = [`# ${name} [${scenario.kind}]`, '', `Prompt: ${scenario.prompt}`, `Skill loaded: ${result.skill_loaded}${result.timeout ? '. Timed out.' : ''}${grading.truncated ? '. Evidence was truncated; no step could auto-pass.' : ''}`, '', '## Steps', ''];
  for (const s of grading.steps) {
    const p = s.p_done == null ? '' : ` (p_done=${s.p_done.toFixed(2)}, p_not_done=${s.p_not_done.toFixed(2)}, p_unclear=${s.p_unclear.toFixed(2)}, p_attempted_wrong=${s.p_attempted_wrong.toFixed(2)})`;
    L.push(`- \`${s.id}\` ${s.verdict}${s.blocked_by ? ` (blocked by ${s.blocked_by.join(', ')})` : ''}${p}: ${s.description}`);
  }
  const fails = findings.filter(f => f.severity === 'high' || f.severity === 'review');
  L.push('', '## Findings', '');
  if (!fails.length) L.push('No failures.');
  for (const f of fails) L.push(`- ${f.label}${f.step ? ` (step \`${f.step}\`)` : ''}: ${f.description}`, `  Look at events.json turn ${f.pointer.turn}, event ${f.pointer.event_index}: "${f.evidence}"`);
  L.push('');
  return L.join('\n');
}
