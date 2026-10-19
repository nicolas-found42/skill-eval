import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { exec, UserError } from './exec.mjs';
import { doctor } from './doctor.mjs';
import { GRADING_KEY } from './jev.mjs';
import { pool } from './pool.mjs';
import { readSkill, copySkill, sha256 } from './skill.mjs';
import { resolveModel } from './registry.mjs';
import { normalizeSession } from './normalize.mjs';
import { requireFrozen } from './validate.mjs';
import { declaredMcpServers, mcpConfig, mcpWarnings, missingDependencies } from './mcp.mjs';

const DEFAULTS = { reps: 1, concurrency: 5, timeout: 600, hard_kill_grace: 60 };

const stamp = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** A fixture path must stay inside the session workspace. */
function fixtureTarget(workspace, rel) {
  const target = path.resolve(workspace, rel);
  if (target !== workspace && !target.startsWith(workspace + path.sep)) throw new UserError(`fixture path "${rel}" escapes the workspace`);
  return target;
}

/** Everything that can be rejected without side effects is rejected here, before any container or folder exists. */
export function preflight(cfg, env = process.env) {
  if (!Array.isArray(cfg.scenarios) || cfg.scenarios.length === 0) throw new UserError('scenarios.json has no scenarios');
  const probe = path.resolve('/probe-workspace');
  for (const s of cfg.scenarios) {
    for (const rel of Object.keys(s.fixtures ?? {})) fixtureTarget(probe, rel);
    for (const name of s.env ?? []) {
      if (name === GRADING_KEY) throw new UserError(`scenario "${s.id}" lists ${GRADING_KEY} in env[]; that is the grading key and never enters a container`);
      if (!env[name]) throw new UserError(`scenario "${s.id}" lists ${name} in env[] but it is not set in the environment`);
    }
  }
}

/**
 * The command a container runs. One prompt: plain `omp -p --no-session`. With scripted followups: the same container
 * replays each reply with `--continue` against a session dir kept OUTSIDE the mounted workspace (the model never sees it).
 * Prompts travel as positional arguments to `sh -c`, never interpolated into the script, so they need no escaping.
 * `--max-time` applies per turn; the container-wide hard kill still bounds the whole session.
 */
export function ompCommand({ model, timeout, prompts }) {
  const common = ['-p', '--mode', 'json'];
  if (prompts.length === 1) return ['omp', ...common, '--no-session', '--model', model, '--max-time', String(timeout), prompts[0]];
  const dir = '/tmp/eval-session';
  const script = [
    'rc=0; m="$1"; t="$2"; first="$3"; shift 3',
    `omp -p --mode json --session-dir ${dir} --model "$m" --max-time "$t" "$first" || rc=$?`,
    `for p in "$@"; do omp -p --mode json --continue --session-dir ${dir} --model "$m" --max-time "$t" "$p" || rc=$?; done`,
    'exit $rc',
  ].join('\n');
  return ['sh', '-c', script, 'sh', model, String(timeout), ...prompts];
}

function sessionPlan(cfg) {
  const plan = [];
  for (const s of cfg.scenarios) {
    for (let r = 1; r <= cfg.reps; r++) plan.push({ scenario: s, rep: r, dir: cfg.reps > 1 ? `${s.id}-r${r}` : s.id });
  }
  return plan;
}

async function runContainer({ args, name, transcript, stderrFile, timeoutMs, graceMs }) {
  const started = Date.now();
  const out = fs.createWriteStream(transcript);
  const err = fs.createWriteStream(stderrFile);
  // Register before the process can close: pipe() ends these streams as soon as the child's pipes close.
  const flushed = Promise.all([once(out, 'finish'), once(err, 'finish')]);
  const p = spawn('docker', args, { env: process.env });
  p.stdout.pipe(out);
  p.stderr.pipe(err);
  let killed = false;
  const hard = setTimeout(async () => {
    killed = true;
    await exec('docker', ['kill', name]);
    setTimeout(() => p.kill('SIGKILL'), 1000);
  }, timeoutMs + graceMs);
  const closed = once(p, 'close');
  const failed = once(p, 'error').then(([e]) => { throw e; });
  let code;
  try { [code] = await Promise.race([closed, failed]); } finally { clearTimeout(hard); }
  await flushed;
  const durationMs = Date.now() - started;
  return { code, killed, durationMs, timedOut: killed || durationMs >= timeoutMs };
}

/**
 * Run every scenario (x reps) in its own container. Returns the run folder path.
 * @param {string} scenariosFile
 * @param {{ evalsDir: string }} opts
 */
export async function runAll(scenariosFile, { evalsDir }) {
  const lock = requireFrozen(scenariosFile);
  const cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(scenariosFile, 'utf8')) };
  preflight(cfg);
  const model = resolveModel(cfg.model_alias);

  const env = await doctor({ modelAlias: model.alias });
  const skill = readSkill(cfg.skill_path);
  const mcp = declaredMcpServers(skill.text);
  const mcpDoc = mcpConfig(mcp.servers);
  const warnings = [...mcp.warnings, ...mcpWarnings(mcp.servers), ...missingDependencies(skill.text, skill.name)];
  const scenariosHash = sha256(fs.readFileSync(scenariosFile));

  const runName = `${stamp(new Date())}-${skill.name}-${model.alias}-${skill.hash.slice(0, 7)}`;
  const runDir = path.join(path.resolve(evalsDir), runName);
  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(scenariosFile, path.join(runDir, 'scenarios.json'));
  fs.writeFileSync(path.join(runDir, 'scenarios.lock.json'), JSON.stringify(lock, null, 2));
  copySkill(cfg.skill_path, path.join(runDir, 'skill'));
  const mcpFile = path.join(runDir, 'mcp.json');
  const hasMcp = Object.keys(mcpDoc.mcpServers).length > 0;
  if (hasMcp) fs.writeFileSync(mcpFile, JSON.stringify(mcpDoc, null, 2));

  const plan = sessionPlan(cfg);
  let spent = 0, aborted = false;
  const skipped = [];
  const results = await pool(plan, cfg.concurrency, async item => {
    if (aborted) { skipped.push(item.dir); return null; }
    const dir = path.join(runDir, item.dir);
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    for (const [rel, content] of Object.entries(item.scenario.fixtures ?? {})) {
      const f = fixtureTarget(workspace, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ ...item.scenario, skill: skill.name, rep: item.rep }, null, 2));

    const name = `skill-eval-${runName}-${item.dir}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const args = [
      'run', '--rm', '--name', name,
      ...(item.scenario.env ?? []).flatMap(n => ['-e', n]),
      '-e', model.env, // by name only: the value comes from the docker client's environment, never the command line
      '-v', `${workspace}:/work`,
      '-v', `${path.join(runDir, 'skill')}:/root/.omp/agent/skills/${skill.name}:ro`,
      ...(hasMcp ? ['-v', `${mcpFile}:/root/.omp/agent/mcp.json:ro`] : []),
      env.image,
      ...ompCommand({ model: model.model, timeout: cfg.timeout, prompts: [item.scenario.prompt, ...(item.scenario.followups ?? [])] }),
    ];
    const r = await runContainer({
      args, name,
      transcript: path.join(dir, 'transcript.jsonl'),
      stderrFile: path.join(dir, 'stderr.txt'),
      timeoutMs: cfg.timeout * 1000,
      graceMs: cfg.hard_kill_grace * 1000,
    });
    const res = normalizeSession(dir, { timedOut: r.timedOut, exitCode: r.killed ? null : r.code, durationMs: r.durationMs });
    spent += res.cost;
    if (cfg.cost_cap != null && spent > cfg.cost_cap) aborted = true;
    return res;
  });

  const runJson = {
    skill: { name: skill.name, path: cfg.skill_path },
    skill_hash: skill.hash,
    scenarios_hash: scenariosHash,
    model,
    omp_version: env.ompVersion,
    image: env.image,
    limits: { concurrency: cfg.concurrency, timeout: cfg.timeout, hard_kill_grace: cfg.hard_kill_grace, reps: cfg.reps, cost_cap: cfg.cost_cap ?? null },
    sessions: results.filter(Boolean).length,
    skipped_for_cost: skipped,
    aborted_for_cost: aborted,
    session_cost: results.reduce((a, r) => a + (r?.cost ?? 0), 0),
    warnings,
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(runJson, null, 2));
  return runDir;
}
