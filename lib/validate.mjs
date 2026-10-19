import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './exec.mjs';
import { Jev } from './jev.mjs';
import { readSkill, sha256 } from './skill.mjs';
import { pool } from './pool.mjs';

export const KINDS = ['positive', 'negative', 'temptation'];
export const lockFile = file => `${file}.lock.json`;

/** Pure structure checks: returns a list of human-readable problems (empty when fine). */
export function structureProblems(cfg) {
  const problems = [];
  const scenarios = cfg.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length === 0) return ['scenarios.json has no scenarios'];
  if (!cfg.skill_path) problems.push('skill_path is required');
  const ids = new Set();
  for (const s of scenarios) {
    if (!s.id) { problems.push('a scenario has no id'); continue; }
    if (ids.has(s.id)) problems.push(`duplicate scenario id "${s.id}"`);
    ids.add(s.id);
    if (!KINDS.includes(s.kind)) problems.push(`scenario "${s.id}": kind must be one of ${KINDS.join(', ')}`);
    if (!s.prompt) problems.push(`scenario "${s.id}": prompt is required`);
    const steps = s.expected?.steps;
    if (!Array.isArray(steps) || steps.length === 0) { problems.push(`scenario "${s.id}": expected.steps must list at least one step`); continue; }
    const stepIds = new Set();
    for (const st of steps) {
      if (!st.id || !st.description) problems.push(`scenario "${s.id}": every step needs id and description`);
      if (stepIds.has(st.id)) problems.push(`scenario "${s.id}": duplicate step id "${st.id}"`);
      stepIds.add(st.id);
    }
    for (const st of steps) for (const req of st.requires ?? []) {
      if (!stepIds.has(req)) problems.push(`scenario "${s.id}": step "${st.id}" requires unknown step "${req}"`);
    }
    if (hasCycle(steps)) problems.push(`scenario "${s.id}": step requires form a cycle`);
  }
  for (const kind of KINDS) if (!scenarios.some(s => s.kind === kind)) problems.push(`the run needs at least one ${kind} scenario`);
  return problems;
}

function hasCycle(steps) {
  const deps = new Map(steps.map(s => [s.id, s.requires ?? []]));
  const state = new Map();
  const visit = id => {
    if (state.get(id) === 'done') return false;
    if (state.get(id) === 'open') return true;
    state.set(id, 'open');
    for (const d of deps.get(id) ?? []) if (deps.has(d) && visit(d)) return true;
    state.set(id, 'done');
    return false;
  };
  return [...deps.keys()].some(visit);
}

const COMPOUND_AT = 0.85;
const GROUNDED_AT = 0.5;

/**
 * Jev-based lint. Returns { problems, description_match }.
 * Compound and ungrounded steps are problems; trigger match is data only.
 */
export async function jevLint(cfg, skill, jev) {
  const problems = [];
  const desc = /^description:\s*(.*)$/m.exec(skill.text)?.[1] ?? '';

  const stepJobs = cfg.scenarios.flatMap(s => s.expected.steps.map(st => ({ s, st })));
  await pool(stepJobs, 8, async ({ s, st }) => {
    const answers = await jev.ask({ step: st.description }, {
      compound: {
        type: 'noul',
        instructions: { step: st.description, question: 'Does `step` bundle two or more independently checkable properties (separate actions, separate file contents, or an action plus an ordering/outcome), such that one could be true while another is false?' },
        criteria: { true: 'Two or more separately falsifiable properties are packed into the step.', false: 'One single falsifiable property.' },
      },
    });
    if (answers.compound.noul >= COMPOUND_AT) {
      problems.push(`scenario "${s.id}", step "${st.id}" bundles more than one property (compound, p=${answers.compound.noul.toFixed(2)}): "${st.description}". Split it into one falsifiable property per step; express ordering with requires.`);
    }
    const g = await jev.ask({ skill_text: skill.text, step: st.description }, {
      grounded: {
        type: 'noul',
        instructions: { skill_text: skill.text, step: st.description, question: 'Does `skill_text` require, or directly entail, this step? A step the skill never asks for is not grounded.' },
        criteria: { true: 'The skill text states or directly implies this step.', false: 'The skill text does not require it, or contradicts it.' },
      },
    });
    // a negative scenario's steps describe expected non-behavior; they are exempt from skill grounding
    if (s.kind !== 'negative' && g.grounded.noul < GROUNDED_AT) {
      problems.push(`scenario "${s.id}", step "${st.id}" is not grounded in the skill text (p=${g.grounded.noul.toFixed(2)}, the skill does not require it): "${st.description}"`);
    }
  });

  const description_match = await pool(cfg.scenarios, 8, async s => {
    const p = await jev.noul(
      { skill_description: desc, user_prompt: s.prompt },
      'Judging ONLY from `skill_description`, should an agent load this skill for `user_prompt`?',
      { true: 'The prompt is the kind of task the description says the skill is for.', false: 'The prompt is outside what the description covers.' },
    );
    return { scenario: s.id, kind: s.kind, expected_trigger: s.kind !== 'negative', p };
  });
  return { problems, description_match };
}

export async function validateFile(file, { jev = null } = {}) {
  const raw = fs.readFileSync(file);
  const cfg = JSON.parse(raw.toString('utf8'));
  const structural = structureProblems(cfg);
  if (structural.length) throw new UserError(`scenarios are invalid:\n- ${structural.join('\n- ')}`);
  const skill = readSkill(cfg.skill_path);
  const j = jev ?? new Jev();
  const { problems, description_match } = await jevLint(cfg, skill, j);
  if (problems.length) throw new UserError(`scenarios failed lint:\n- ${problems.join('\n- ')}`);
  const lock = {
    version: 1,
    scenarios_hash: sha256(raw),
    skill_hash: skill.hash,
    judge: { model: j.model, snapshots: [...j.snapshots] },
    description_match,
    lint_cost: j.cost,
  };
  fs.writeFileSync(lockFile(file), JSON.stringify(lock, null, 2));
  return lock;
}

/** `run` calls this: the scenarios file must have a lock whose hash matches its current bytes. */
export function requireFrozen(file) {
  const lf = lockFile(file);
  if (!fs.existsSync(lf)) throw new UserError(`${file} has not been validated. Run \`eval.mjs validate ${file}\` first.`);
  const lock = JSON.parse(fs.readFileSync(lf, 'utf8'));
  const now = sha256(fs.readFileSync(file));
  if (lock.scenarios_hash !== now) throw new UserError(`${file} changed since validation (hash mismatch). Re-run \`validate\`; scenarios are frozen before sessions run.`);
  return lock;
}

/**
 * Grading and analysis call this on an existing run folder: if the folder carries the lock `run` copied into it,
 * its scenarios.json must still hash to the frozen value. Folders without a lock (recorded fixtures) are not scenario-frozen.
 * @returns the lock, or null when the folder has none
 */
export function requireRunFrozen(runDir) {
  const lf = path.join(runDir, 'scenarios.lock.json');
  if (!fs.existsSync(lf)) return null;
  const lock = JSON.parse(fs.readFileSync(lf, 'utf8'));
  const file = path.join(runDir, 'scenarios.json');
  if (!fs.existsSync(file)) throw new UserError(`${runDir} has a scenarios lock but no scenarios.json`);
  if (lock.scenarios_hash !== sha256(fs.readFileSync(file))) throw new UserError(`${file} changed since validation (hash mismatch); refusing to grade tampered scenarios. Scenarios are frozen before sessions run.`);
  return lock;
}
