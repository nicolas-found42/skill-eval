import fs from 'node:fs';
import path from 'node:path';
import { Jev } from './jev.mjs';
import { UserError } from './exec.mjs';
import { SAME_ISSUE_AT, sameIssueJudge } from './findings.mjs';

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

function load(runDir) {
  const f = path.join(runDir, 'findings.json');
  if (!fs.existsSync(f)) throw new UserError(`${runDir} has no findings.json. Run \`eval.mjs analyze ${runDir}\` first.`);
  return { dir: runDir, run: readJson(path.join(runDir, 'run.json')), doc: readJson(f) };
}

const passRate = (steps) => {
  const v = Object.values(steps);
  return v.length ? v.filter(x => x === 'done').length / v.length : 0;
};

/**
 * Pair findings across two runs. Same label+step pairs directly (cheap, deterministic). A leftover finding is matched
 * to a leftover on the other side only when the judge says they describe the same defect.
 */
async function pair(beforeFindings, afterFindings, jev) {
  const sameIssue = sameIssueJudge(jev);
  const pairs = [];
  const bLeft = [...beforeFindings], aLeft = [...afterFindings];
  for (const b of [...bLeft]) {
    const i = aLeft.findIndex(a => a.label === b.label && a.step === b.step);
    if (i >= 0) { pairs.push({ before: b, after: aLeft[i] }); aLeft.splice(i, 1); bLeft.splice(bLeft.indexOf(b), 1); }
  }
  for (const b of [...bLeft]) {
    for (let i = 0; i < aLeft.length; i++) {
      const a = aLeft[i];
      if (a.label !== b.label) continue;
      const p = await sameIssue(b.description, a.description);
      if (p >= SAME_ISSUE_AT) { pairs.push({ before: b, after: a }); aLeft.splice(i, 1); bLeft.splice(bLeft.indexOf(b), 1); break; }
    }
  }
  return { pairs, onlyBefore: bLeft, onlyAfter: aLeft };
}

export async function compareRuns(beforeDir, afterDir, { jev = new Jev() } = {}) {
  const B = load(beforeDir), A = load(afterDir);
  const reasons = [];
  if (B.run.scenarios_hash !== A.run.scenarios_hash) reasons.push('the runs used different scenarios (scenarios hash differs)');
  if (B.run.model?.model !== A.run.model?.model) reasons.push(`the runs used different models (${B.run.model?.model} vs ${A.run.model?.model})`);

  const { pairs, onlyBefore, onlyAfter } = await pair(B.doc.findings, A.doc.findings, jev);
  const beforeScn = new Map(B.doc.sessions.map(s => [s.scenario, s]));

  const findings = [];
  for (const p of pairs) findings.push({ status: 'still_failing', label: p.after.label, step: p.after.step, scenarios: p.after.scenarios, description: p.after.description, before_count: p.before.count, after_count: p.after.count });
  for (const f of onlyBefore) findings.push({ status: 'fixed', label: f.label, step: f.step, scenarios: f.scenarios, description: f.description, before_count: f.count, after_count: 0 });
  for (const f of onlyAfter) {
    // a failure in a scenario that fully passed before is a regression; anything else is simply new
    const regressed = f.scenarios.some(s => { const b = beforeScn.get(s); return b && passRate(b.steps) === 1 && !B.doc.findings.some(x => x.severity === 'high' && x.scenarios.includes(s)); });
    findings.push({ status: regressed ? 'regressed' : 'new', label: f.label, step: f.step, scenarios: f.scenarios, description: f.description, before_count: 0, after_count: f.count });
  }

  const scenarios = A.doc.sessions.map(a => {
    const b = beforeScn.get(a.scenario);
    return { scenario: a.scenario, before: b ? { pass_rate: passRate(b.steps) } : null, after: { pass_rate: passRate(a.steps) } };
  });

  const out = {
    version: 1,
    comparable: reasons.length === 0,
    reasons,
    skill_changed: B.run.skill_hash !== A.run.skill_hash,
    before: beforeDir, after: afterDir,
    findings, scenarios,
    judge: { model: jev.model, cost: jev.cost },
  };
  fs.writeFileSync(path.join(afterDir, 'compare.json'), JSON.stringify(out, null, 2));
  return out;
}

export function renderCompare(c) {
  const L = [`comparable: ${c.comparable}${c.reasons.length ? ` (${c.reasons.join('; ')})` : ''}`, `skill changed: ${c.skill_changed}`];
  for (const s of ['regressed', 'still_failing', 'new', 'fixed']) {
    const fs_ = c.findings.filter(f => f.status === s);
    if (fs_.length) { L.push('', `${s.toUpperCase()} (${fs_.length})`); for (const f of fs_) L.push(`  - ${f.label}${f.step ? ` [${f.step}]` : ''} in ${f.scenarios.join(', ')}: ${f.description}`); }
  }
  L.push('', 'pass rate by scenario (before -> after)');
  for (const s of c.scenarios) L.push(`  ${s.scenario}: ${s.before ? s.before.pass_rate.toFixed(2) : 'n/a'} -> ${s.after.pass_rate.toFixed(2)}`);
  return L.join('\n');
}
