import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, readJson, writeJson, freezeForTest, ROOT } from './helpers.mjs';

const POS1 = path.join(ROOT, 'fixtures', 'base', 'pos1', 'transcript.jsonl');
const TOY = path.join(ROOT, 'fixtures', 'toy-skill', 'pirate-notes');
const KEYS = { OPENROUTER_API_KEY: 'sk-grade-SECRET', OLLAMA_CLOUD_API_KEY: 'sk-model-SECRET', MISTRAL_API_KEY: 'sk-mistral-SECRET' };
/** Real grading key for tests that let `run` call Jev; the fake docker still keeps containers out of the picture. */
const KEYS_LIVE = { ...KEYS, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' };

const step = (id, description, extra = {}) => ({ id, description, evidence_hint: 'transcript', ...extra });
function scenario(id, kind, extra = {}) {
  return { id, kind, prompt: `prompt for ${id}`, rationale: 'r', expected: { outcome: 'o', steps: [step('s1', 'The agent read the skill.')] }, ...extra };
}

/** Build a workspace the way `validate` leaves it: scenarios.json + frozen marker, skill snapshot. Returns {root, evals}. */
function setup(scenarios, runCfg = {}) {
  const root = tmpdir('run-');
  const evals = path.join(root, 'evals');
  const file = path.join(root, 'scenarios.json');
  writeJson(file, { skill_path: TOY, model_alias: 'ollama-cloud', reps: 1, concurrency: 5, timeout: 600, scenarios, ...runCfg });
  freezeForTest(file);
  return { root, evals, file };
}

const runCli = (file, evals, docker, extra = [], env = KEYS) =>
  cli(['run', file, '--evals-dir', evals, '--skip-grading', ...extra], { env, fakeDocker: docker });

const dockerLog = dir => fs.existsSync(path.join(dir, 'docker.log'))
  ? fs.readFileSync(path.join(dir, 'docker.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.cmd === 'run')
  : [];

const UP = (logDir, run = {}) => ({ daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3', logDir, run: { transcript: POS1, ...run } });

function runDirOf(evals) {
  const names = fs.readdirSync(evals).filter(n => !n.startsWith('.'));
  assert.equal(names.length, 1, `exactly one run folder, got ${names}`);
  return path.join(evals, names[0]);
}

test('run creates one folder per scenario inside a run folder named timestamp-skill-alias-hash', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive'), scenario('neg-a', 'negative'), scenario('tempt-a', 'temptation')]);
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(evals);
  assert.match(path.basename(run), /^\d{8}-\d{6}-pirate-notes-ollama-cloud-[0-9a-f]{7}$/);
  for (const id of ['pos-a', 'neg-a', 'tempt-a']) {
    for (const f of ['scenario.json', 'transcript.jsonl', 'events.json', 'result.json', 'stderr.txt']) assert.ok(fs.existsSync(path.join(run, id, f)), `${id}/${f}`);
    assert.ok(fs.statSync(path.join(run, id, 'workspace')).isDirectory());
  }
  for (const f of ['run.json', 'scenarios.json']) assert.ok(fs.existsSync(path.join(run, f)), f);
  assert.ok(fs.existsSync(path.join(run, 'skill', 'SKILL.md')), 'skill snapshot');
});

test('reps produce suffixed session folders', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { reps: 3 });
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(evals);
  for (const n of ['pos-a-r1', 'pos-a-r2', 'pos-a-r3']) assert.ok(fs.existsSync(path.join(run, n, 'result.json')), n);
});

test('each container mounts only its own session workspace read-write; the skill snapshot is read-only; nothing from the host home', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive'), scenario('neg-a', 'negative')]);
  await runCli(file, evals, UP(root));
  const runs = dockerLog(root);
  assert.equal(runs.length, 2);
  const run = runDirOf(evals);
  for (const r of runs) {
    const mounts = r.args.flatMap((a, i) => (a === '-v' ? [r.args[i + 1]] : []));
    const rw = mounts.filter(m => m.endsWith(':/work'));
    assert.equal(rw.length, 1, 'exactly one rw /work mount');
    assert.ok([path.join(run, 'pos-a', 'workspace'), path.join(run, 'neg-a', 'workspace')].some(w => rw[0].startsWith(w + ':')), rw[0]);
    const skillMounts = mounts.filter(m => m.includes('/.omp/agent/skills'));
    assert.equal(skillMounts.length, 1);
    assert.match(skillMounts[0], /:ro$/);
    for (const m of mounts) assert.ok(!m.startsWith(process.env.HOME + ':') && !m.includes('/.omp/agent:') && !m.includes('agent.db'), `no host home/credential mount: ${m}`);
  }
});

test('each container receives only the selected model key; the grading key never enters a container', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  await runCli(file, evals, UP(root));
  const [r] = dockerLog(root);
  const envs = r.args.flatMap((a, i) => (a === '-e' ? [r.args[i + 1]] : []));
  assert.ok(envs.some(e => e.startsWith('OLLAMA_CLOUD_API_KEY')), 'model key passed');
  assert.ok(!envs.some(e => /OPENROUTER_API_KEY/.test(e)), 'grading key absent');
  assert.ok(!envs.some(e => /MISTRAL_API_KEY/.test(e)), 'unrelated key absent');
  assert.ok(!r.args.join(' ').includes('sk-grade-SECRET'), 'grading secret value absent from the whole command line');
  assert.ok(!r.args.join(' ').includes('sk-model-SECRET'), 'key value never on the command line (passed by name only)');
});

test('the model alias in the scenario file selects the provider/model passed to omp', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { model_alias: 'mistral' });
  await runCli(file, evals, UP(root));
  const [r] = dockerLog(root);
  const i = r.args.indexOf('--model');
  assert.equal(r.args[i + 1], 'mistral/devstral-latest');
  const envs = r.args.flatMap((a, k) => (a === '-e' ? [r.args[k + 1]] : []));
  assert.ok(envs.some(e => e.startsWith('MISTRAL_API_KEY')));
  assert.ok(!envs.some(e => e.startsWith('OLLAMA_CLOUD_API_KEY')));
});

test('fixtures are written into the session workspace before the container starts', async () => {
  const { root, evals, file } = setup([scenario('fx', 'positive', { fixtures: { 'src/a.txt': 'hello', 'b.md': '# b' } })]);
  await runCli(file, evals, UP(root));
  const run = runDirOf(evals);
  assert.equal(fs.readFileSync(path.join(run, 'fx', 'workspace', 'src', 'a.txt'), 'utf8'), 'hello');
  assert.equal(fs.readFileSync(path.join(run, 'fx', 'workspace', 'b.md'), 'utf8'), '# b');
});

test('a fixture path that escapes the workspace is rejected before anything runs', async () => {
  const { root, evals, file } = setup([scenario('fx', 'positive', { fixtures: { '../../escape.txt': 'x' } })]);
  const r = await runCli(file, evals, UP(root));
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /escapes the workspace/i);
  assert.equal(dockerLog(root).length, 0);
});

test('session transcript, exit code and skill-loaded flag land in the session folder', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  await runCli(file, evals, UP(root, { stderr: 'warn: something\n', exit: 0 }));
  const run = runDirOf(evals);
  const res = readJson(path.join(run, 'pos-a', 'result.json'));
  assert.equal(res.exit_code, 0);
  assert.equal(res.skill_loaded, true);
  assert.equal(res.timeout, false);
  assert.match(fs.readFileSync(path.join(run, 'pos-a', 'stderr.txt'), 'utf8'), /warn: something/);
  assert.equal(fs.readFileSync(path.join(run, 'pos-a', 'transcript.jsonl'), 'utf8'), fs.readFileSync(POS1, 'utf8'));
});

test('files the session wrote are visible in its workspace folder after the run', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  await runCli(file, evals, UP(root, { files: { 'memo.md': '# Arr: hi\nSigned: Captain Skill\n' } }));
  const run = runDirOf(evals);
  assert.match(fs.readFileSync(path.join(run, 'pos-a', 'workspace', 'memo.md'), 'utf8'), /Signed: Captain Skill/);
});

test('a hung container is hard-killed after the timeout and the session is marked timeout', async () => {
  const { root, evals, file } = setup([scenario('hang', 'positive')], { timeout: 1, hard_kill_grace: 1 });
  const t0 = Date.now();
  const r = await runCli(file, evals, UP(root, { sleepMs: 30_000 }));
  assert.ok(Date.now() - t0 < 15_000, 'did not wait for the 30s hang');
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(evals);
  assert.equal(readJson(path.join(run, 'hang', 'result.json')).timeout, true);
  const log = fs.readFileSync(path.join(root, 'docker.log'), 'utf8');
  assert.match(log, /"cmd":"kill"/);
});

test('concurrency is respected: never more containers running than the limit', async () => {
  const sc = Array.from({ length: 6 }, (_, i) => scenario(`s${i}`, i === 0 ? 'positive' : i === 1 ? 'negative' : 'temptation'));
  const { root, evals, file } = setup(sc, { concurrency: 2 });
  const t0 = Date.now();
  const r = await runCli(file, evals, UP(root, { sleepMs: 600, exit: 0 }));
  const dt = Date.now() - t0;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(dockerLog(root).length, 6);
  // 6 sessions x 0.6s at concurrency 2 needs >= 3 waves (~1.8s); unlimited concurrency would take ~0.6s + startup
  assert.ok(dt >= 1700, `too fast for concurrency 2: ${dt}ms`);
});

test('daemon down: run fails with a start-Docker message and starts no container and no run folder', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await runCli(file, evals, { daemon: 'down', logDir: root });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /start Docker/i);
  assert.equal(dockerLog(root).length, 0);
  assert.ok(!fs.existsSync(evals) || fs.readdirSync(evals).filter(n => !n.startsWith('.')).length === 0);
});

test('run.json records model, versions, limits and per-run totals', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  await runCli(file, evals, UP(root));
  const rj = readJson(path.join(runDirOf(evals), 'run.json'));
  assert.equal(rj.model.alias, 'ollama-cloud');
  assert.equal(rj.model.model, 'ollama-cloud/deepseek-v4.1-flash');
  assert.equal(rj.omp_version, '1.2.3');
  assert.equal(rj.limits.concurrency, 5);
  assert.match(rj.skill_hash, /^[0-9a-f]{64}$/);
  assert.match(rj.scenarios_hash, /^[0-9a-f]{64}$/);
  assert.ok(rj.session_cost > 0);
});

test('cost cap stops launching further sessions once the summed cost exceeds it', async () => {
  const sc = Array.from({ length: 6 }, (_, i) => scenario(`s${i}`, i === 0 ? 'positive' : i === 1 ? 'negative' : 'temptation'));
  const { root, evals, file } = setup(sc, { concurrency: 1, cost_cap: 0.0001 });
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const n = dockerLog(root).length;
  assert.ok(n >= 1 && n < 6, `expected the cap to stop the run early, ran ${n}`);
  const rj = readJson(path.join(runDirOf(evals), 'run.json'));
  assert.equal(rj.aborted_for_cost, true);
});

test('run grades and reports by default; --skip-grading leaves only the raw session folders', async () => {
  const sc = [scenario('pos-a', 'positive', { expected: { outcome: 'o', steps: [step('read', 'The agent read the pirate-notes skill before writing any file.')] } })];
  const graded = setup(sc);
  const r = await cli(['run', graded.file, '--evals-dir', graded.evals], { env: KEYS_LIVE, fakeDocker: UP(graded.root) });
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(graded.evals);
  for (const f of ['pos-a/grading.json', 'findings.json', 'summary.md']) assert.ok(fs.existsSync(path.join(run, f)), f);
  assert.match(r.stdout, /summary\.md/);

  const raw = setup(sc);
  await runCli(raw.file, raw.evals, UP(raw.root));
  const rawRun = runDirOf(raw.evals);
  for (const f of ['pos-a/grading.json', 'findings.json', 'summary.md']) assert.ok(!fs.existsSync(path.join(rawRun, f)), `${f} must not exist with --skip-grading`);
});

test('a run whose grading key is missing fails before any container starts', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await cli(['run', file, '--evals-dir', evals], { env: { OLLAMA_CLOUD_API_KEY: 'x' }, fakeDocker: UP(root) });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
  assert.equal(dockerLog(root).length, 0);
});

const MCP_SKILL = `---
name: mcp-skill
description: Use when asked to look things up.
mcpServers:
  lookup:
    command: npx
    args: ["-y", "some-mcp"]
    includeTools: ["a", "b"]
    env:
      LOOKUP_TOKEN: "sk-embedded-IN-FRONTMATTER"
  local:
    command: /Users/someone/.venv/bin/python
    args: ["-m", "srv"]
---
# Lookup
Use the lookup tool, then load skill://other-skill.
`;

function mcpSkillDir() {
  const d = path.join(tmpdir('skill-'), 'mcp-skill');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), MCP_SKILL);
  return d;
}

const mountsOf = r => r.args.flatMap((a, i) => (a === '-v' ? [r.args[i + 1]] : []));
const envNamesOf = r => r.args.flatMap((a, i) => (a === '-e' ? [r.args[i + 1]] : []));

test('a skill that declares MCP servers gets a generated mcp.json with only command and args, mounted read-only; frontmatter secrets never reach it', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { skill_path: mcpSkillDir() });
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(evals);
  const cfg = readJson(path.join(run, 'mcp.json'));
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ['local', 'lookup']);
  assert.deepEqual(cfg.mcpServers.lookup, { command: 'npx', args: ['-y', 'some-mcp'] });
  assert.ok(!fs.readFileSync(path.join(run, 'mcp.json'), 'utf8').includes('sk-embedded'), 'frontmatter env value copied into mcp.json');
  const mcp = mountsOf(dockerLog(root)[0]).filter(m => m.endsWith(':/root/.omp/agent/mcp.json:ro'));
  assert.equal(mcp.length, 1);
  assert.ok(mcp[0].startsWith(path.join(run, 'mcp.json') + ':'));
});

test('a skill without MCP servers gets no mcp.json and no extra mount', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  await runCli(file, evals, UP(root));
  assert.ok(!fs.existsSync(path.join(runDirOf(evals), 'mcp.json')));
  assert.equal(mountsOf(dockerLog(root)[0]).filter(m => m.includes('mcp.json')).length, 0);
});

test('run.json warns about host-path servers, ignored frontmatter env, and skills the container will not have', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { skill_path: mcpSkillDir() });
  await runCli(file, evals, UP(root));
  const w = readJson(path.join(runDirOf(evals), 'run.json')).warnings.join('\n');
  assert.match(w, /local.*host path/s);
  assert.match(w, /lookup.*LOOKUP_TOKEN.*env\[\]/s);
  assert.match(w, /other-skill/);
  assert.ok(!w.includes('sk-embedded'), 'a warning must never echo the secret value');
});

test('scenario env[] names are passed to that scenario container by name only', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive', { env: ['LOOKUP_TOKEN'] }), scenario('neg-a', 'negative')]);
  await runCli(file, evals, UP(root), [], { ...KEYS, LOOKUP_TOKEN: 'sk-lookup-VALUE' });
  const runs = dockerLog(root);
  const withEnv = runs.find(r => envNamesOf(r).includes('LOOKUP_TOKEN'));
  assert.ok(withEnv, 'a scenario listing env[] must receive it');
  assert.equal(runs.filter(r => envNamesOf(r).includes('LOOKUP_TOKEN')).length, 1, 'only the scenario that lists it');
  for (const r of runs) assert.ok(!r.args.join(' ').includes('sk-lookup-VALUE'), 'value must not appear on the command line');
});

test('scenario env[] naming an unset variable, or the grading key, is rejected before any container starts', async () => {
  const unset = setup([scenario('pos-a', 'positive', { env: ['NOT_SET_ANYWHERE'] })]);
  const a = await runCli(unset.file, unset.evals, UP(unset.root));
  assert.notEqual(a.code, 0);
  assert.match(a.stderr, /NOT_SET_ANYWHERE/);
  assert.equal(dockerLog(unset.root).length, 0);

  const grading = setup([scenario('pos-a', 'positive', { env: ['OPENROUTER_API_KEY'] })]);
  const b = await runCli(grading.file, grading.evals, UP(grading.root));
  assert.notEqual(b.code, 0);
  assert.match(b.stderr, /OPENROUTER_API_KEY.*grading/is);
  assert.equal(dockerLog(grading.root).length, 0);
});

test('scripted followups run as further turns of the same container session, with the session dir outside the workspace', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive', { followups: ['second reply', 'third reply'] }), scenario('neg-a', 'negative')]);
  await runCli(file, evals, UP(root));
  const runs = dockerLog(root);
  assert.equal(runs.length, 2, 'followups never start extra containers');
  const withFollowups = runs.find(r => r.args.includes('second reply'));
  assert.ok(withFollowups);
  const a = withFollowups.args;
  const i = a.indexOf('prompt for pos-a');
  assert.deepEqual(a.slice(i, i + 3), ['prompt for pos-a', 'second reply', 'third reply'], 'prompts are delivered in order');
  const script = a[a.indexOf('-c') + 1];
  assert.match(script, /--continue/);
  const sessionDir = /--session-dir\s+"?([^\s"]+)/.exec(script)?.[1];
  assert.ok(sessionDir && !sessionDir.startsWith('/work'), `session dir must be outside the workspace mount, got ${sessionDir}`);
  const plain = runs.find(r => r.args.includes('prompt for neg-a'));
  assert.ok(!plain.args.includes('--continue') && !plain.args.includes('-c'), 'a single-turn scenario keeps the plain command');
});
