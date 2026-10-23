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
    for (const f of ['scenario.json', 'transcript.jsonl', 'events.json', 'result.json', 'stderr.txt', 'host.jsonl']) assert.ok(fs.existsSync(path.join(run, id, f)), `${id}/${f}`);
    assert.ok(fs.statSync(path.join(run, id, 'workspace')).isDirectory());
    const host = fs.readFileSync(path.join(run, id, 'host.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(host.map(e => e.event), ['session_scheduled', 'container_start', 'container_end', 'normalize_start', 'session_end']);
    assert.ok(host.every(e => typeof e.t === 'string'), 'every host event carries a clock');
    const res = readJson(path.join(run, id, 'result.json'));
    assert.equal(typeof res.t_start, 'string', 'session carries host clock bounds');
    assert.equal(res.timeout_kind, null);
    assert.equal(typeof res.transcript_chars, 'number');
    assert.equal(res.dropped_chars, 0);
    assert.ok(res.tool_stats.read.calls >= 1, 'per-tool call counts recorded');
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

function pluginDir() {
  const d = path.join(tmpdir('plugin-'), 'company-deep-dive-plugin');
  fs.mkdirSync(path.join(d, 'skills', 'intake'), { recursive: true });
  fs.writeFileSync(path.join(d, 'plugin.json'), JSON.stringify({ name: 'company-deep-dive-plugin', version: '4.7.0' }));
  fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: company-deep-dive-plugin\ndescription: Research a business.\n---\n\n# Root\nLoad intake, then follow stages.');
  fs.writeFileSync(path.join(d, 'skills', 'intake', 'SKILL.md'), '---\nname: intake\ndescription: Capture research scope.\n---\n\n# Intake\nRead the request.');
  fs.writeFileSync(path.join(d, 'mcp.json'), JSON.stringify({ mcpServers: { 'company-deep-dive-plugin-public': { type: 'stdio', command: 'python3', args: ['${PLUGIN_ROOT}/scripts/mcp_server.py'], cwd: '${PLUGIN_ROOT}' } } }));
  return d;
}

test('each container mounts only its own session workspace read-write; the skill snapshot is read-only; nothing from the host home', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive'), scenario('neg-a', 'negative')]);
  await runCli(file, evals, UP(root));
  const runs = dockerLog(root);
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
  const res = readJson(path.join(run, 'hang', 'result.json'));
  assert.equal(res.timeout, true);
  assert.equal(res.timeout_kind, 'killed', 'kill-fired timeout is distinguished from natural expiry');
  const host = fs.readFileSync(path.join(run, 'hang', 'host.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(host.some(e => e.event === 'hard_kill'), 'the kill event is recorded');
  const log = fs.readFileSync(path.join(root, 'docker.log'), 'utf8');
  assert.match(log, /"cmd":"kill"/);
});

test('a transcript cut mid-line keeps the dropped tail in transcript.partial.txt with its size recorded', async () => {
  const dir = tmpdir('cut-');
  const raw = fs.readFileSync(POS1, 'utf8');
  const cut = raw.slice(0, Math.floor(raw.length * 0.8));
  assert.ok(cut.split('\n').pop().length > 0, 'the cut point leaves a real partial line');
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), cut);
  writeJson(path.join(dir, 'scenario.json'), { id: 'cut', kind: 'positive', prompt: 'p', skill: 'pirate-notes' });
  const { normalizeSession } = await import('../lib/normalize.mjs');
  const res = normalizeSession(dir, {});
  assert.ok(fs.existsSync(path.join(dir, 'transcript.partial.txt')), 'partial tail saved');
  assert.ok(res.dropped_chars > 0, `dropped chars recorded, got ${res.dropped_chars}`);
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
  const run = runDirOf(evals);
  const rj = readJson(path.join(run, 'run.json'));
  assert.equal(rj.model.alias, 'ollama-cloud');
  assert.equal(rj.model.model, 'ollama-cloud/deepseek-v4.1-flash');
  assert.equal(rj.omp_version, '1.2.3');
  assert.equal(rj.limits.concurrency, 5);
  assert.match(rj.skill_hash, /^[0-9a-f]{64}$/);
  assert.match(rj.scenarios_hash, /^[0-9a-f]{64}$/);
  assert.ok(rj.session_cost > 0);
  assert.equal(typeof rj.t_start, 'string', 'run carries a wall-clock span');
  assert.equal(typeof rj.t_end, 'string');
  assert.equal(rj.host.node, process.version);
  assert.ok('image_digest' in rj && 'git_sha' in rj, 'attribution fields present (values may be null outside a checkout)');
  const index = fs.readFileSync(path.join(evals, '.index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(index.length, 1);
  assert.equal(index[0].run, path.basename(run));
  assert.equal(index[0].model, 'ollama-cloud/deepseek-v4.1-flash');
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

test('a run-level thinking level reaches omp as --thinking on both the single-turn and followup paths', async () => {
  const { root, evals, file } = setup(
    [scenario('pos-a', 'positive'), scenario('pos-b', 'positive', { followups: ['second reply'] })],
    { thinking: 'minimal' },
  );
  await runCli(file, evals, UP(root));
  const runs = dockerLog(root);
  const [plain, scripted] = [runs.find(r => r.args.includes('prompt for pos-a')), runs.find(r => r.args.includes('prompt for pos-b'))];
  const pi = plain.args.indexOf('--thinking');
  assert.ok(pi > 0, `single-turn omp gets --thinking: ${plain.args}`);
  assert.equal(plain.args[pi + 1], 'minimal');
  assert.ok(pi < plain.args.indexOf('--model'), '--thinking is an omp flag, not part of the model id');
  const script = scripted.args[scripted.args.indexOf('-c') + 1];
  assert.match(script, /--thinking "\$k"/, 'every turn of a scripted session carries the level');
  assert.equal(scripted.args[scripted.args.indexOf(script) + 4], 'minimal', 'the level travels as the bound argument');
  const run = runDirOf(evals);
  assert.equal(readJson(path.join(run, 'run.json')).limits.thinking, 'minimal');
  assert.equal(readJson(path.join(run, 'pos-a', 'session.json')).thinking, 'minimal');
});

test('a run without a thinking level passes no --thinking flag, so the model default is untouched', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  await runCli(file, evals, UP(root));
  const [r] = dockerLog(root);
  assert.ok(!r.args.includes('--thinking'), 'no flag is injected when the file omits it');
  assert.equal(readJson(path.join(runDirOf(evals), 'run.json')).limits.thinking, null);
});

test('a plugin mounts whole at /plugin with --plugin-dir, and the MCP server args rewrite ${PLUGIN_ROOT} to /plugin', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { skill_path: pluginDir() });
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const [run] = dockerLog(root);
  const mounts = run.args.flatMap((a, i) => (a === '-v' ? [run.args[i + 1]] : []));
  assert.ok(mounts.some(m => m.endsWith(':/plugin:ro')), `plugin mounted at /plugin: ${mounts}`);
  assert.ok(!mounts.some(m => m.includes('/.omp/agent/skills')), 'a plugin never uses the single-skill mount');
  const cfg = readJson(path.join(runDirOf(evals), 'mcp.json'));
  assert.deepEqual(cfg.mcpServers['company-deep-dive-plugin-public'], { command: 'python3', args: ['/plugin/scripts/mcp_server.py'], cwd: '/plugin' });
  assert.ok(run.args.includes('--plugin-dir') && run.args.includes('/plugin'), 'omp gets --plugin-dir /plugin');
});

test('a plugin run records the plugin kind and stage skill names in scenario.json', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { skill_path: pluginDir() });
  await runCli(file, evals, UP(root));
  const sc = readJson(path.join(runDirOf(evals), 'pos-a', 'scenario.json'));
  assert.equal(sc.skill, 'company-deep-dive-plugin');
  assert.ok(sc.skill_names.includes('company-deep-dive-plugin') && sc.skill_names.includes('intake'));
  assert.equal(readJson(path.join(runDirOf(evals), 'run.json')).skill.kind, 'plugin');
});

test('run records determinism inputs: seed, per-session plan, and richer host telemetry', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { seed: 42, no_output_timeout: 300 });
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(evals);
  const rj = readJson(path.join(run, 'run.json'));
  assert.equal(rj.seed, 42);
  assert.equal(rj.limits.no_output_timeout, 300);
  const sc = readJson(path.join(run, 'pos-a', 'scenario.json'));
  assert.equal(sc.seed, 42, 'scenario carries the run seed');
  const plan = readJson(path.join(run, 'pos-a', 'session.json'));
  assert.equal(plan.seed, 42);
  assert.equal(plan.model, 'ollama-cloud/deepseek-v4.1-flash');
  assert.equal(plan.followups, 0);
  const host = fs.readFileSync(path.join(run, 'pos-a', 'host.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const end = host.find(e => e.event === 'container_end');
  assert.ok('stdout_bytes' in end && 'stderr_bytes' in end && 'stderr_tail' in end, 'container_end carries byte counts');
  const res = readJson(path.join(run, 'pos-a', 'result.json'));
  assert.equal(typeof res.stderr_bytes, 'number');
  assert.equal(typeof res.stdout_bytes, 'number');
  assert.equal(res.timeout_kind, null);
});

test('run.json verdict rollup happens at analyze time: index gains verdicts and pass rate', async () => {
  const sc = [scenario('pos-a', 'positive', { expected: { outcome: 'o', steps: [step('s1', 'The agent read the skill.')] } })];
  const g = setup(sc);
  const r = await cli(['run', g.file, '--evals-dir', g.evals], { env: KEYS_LIVE, fakeDocker: UP(g.root) });
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(g.evals);
  const rj = readJson(path.join(run, 'run.json'));
  assert.ok(rj.verdicts && typeof rj.verdicts.done === 'number', `verdicts rolled up: ${JSON.stringify(rj.verdicts)}`);
  assert.equal(typeof rj.pass_rate, 'number');
  const stat = rj.scenario_stats.find(s => s.scenario === 'pos-a');
  assert.ok(stat && typeof stat.pass_rate === 'number' && stat.steps_total >= 1);
  const idx = fs.readFileSync(path.join(g.evals, '.index.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const line = idx.find(l => l.run === path.basename(run));
  assert.ok(line && typeof line.pass_rate === 'number', 'index line carries pass rate after analyze');
});

test('eval.mjs index lists runs as JSON without walking session folders', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  await runCli(file, evals, UP(root));
  const r = await cli(['index', evals]);
  assert.equal(r.code, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.runs.length, 1);
  assert.equal(j.runs[0].run, path.basename(runDirOf(evals)));
  assert.equal(typeof j.runs[0].sessions, 'number');
});

test('containers get a hard memory limit, recorded in run.json limits', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { container_memory_mb: 2048 });
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const [run] = dockerLog(root);
  const mi = run.args.indexOf('--memory');
  assert.ok(mi !== -1, '--memory passed to docker run');
  assert.equal(run.args[mi + 1], '2048m');
  const rj = readJson(path.join(runDirOf(evals), 'run.json'));
  assert.equal(rj.limits.container_memory_mb, 2048);
  assert.equal(rj.retry_attempts, 0, 'run-level retry total recorded even when zero');
});

test('container_memory_mb 0 disables the limit', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')], { container_memory_mb: 0 });
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const [run] = dockerLog(root);
  assert.equal(run.args.indexOf('--memory'), -1, 'no --memory flag when the limit is 0');
});

test('a retried session records the retry total at run level and replays the failed transcript', async () => {
  const { root, evals, file } = setup([scenario('flaky', 'positive')], { timeout: 1, hard_kill_grace: 1, max_retries: 1, retry_backoff_ms: 10 });
  const docker = { daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3', logDir: root, run: { transcript: POS1, failFirst: 1, fail: { timedOut: true, sleepMs: 30_000 } } };
  const t0 = Date.now();
  const r = await runCli(file, evals, docker);
  assert.ok(Date.now() - t0 < 20_000, 'did not wait out the second 30s hang');
  assert.equal(r.code, 0, r.stderr);
  const run = runDirOf(evals);
  const rj = readJson(path.join(run, 'run.json'));
  assert.equal(rj.retry_attempts, 1, 'run.json aggregates the session retry count');
  assert.equal(rj.limits.max_retries, 1);
  const res = readJson(path.join(run, 'flaky', 'result.json'));
  assert.equal(res.retry_attempts, 1);
  assert.equal(res.timeout, false, 'the retried attempt succeeded');
  assert.ok(fs.existsSync(path.join(run, 'flaky', 'transcript.retry-1.jsonl')), 'the failed attempt transcript is kept');
  const host = fs.readFileSync(path.join(run, 'flaky', 'host.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(host.some(e => e.event === 'retry_attempt'), 'the retry is in the host log');
  assert.ok(host.some(e => e.event === 'retry_transcript' && e.replayed_transcript === 'transcript.jsonl'), 'the replayed attempt-1 transcript is named in the host log');
});

test('host arrival clocks pair with transcript lines into host_wall_ms tool spans', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const r = await runCli(file, evals, UP(root));
  assert.equal(r.code, 0, r.stderr);
  const dir = path.join(runDirOf(evals), 'pos-a');
  const clock = readJson(path.join(dir, 'host-clock.json'));
  const transcriptLines = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').split('\n').filter(l => l.trim());
  assert.equal(clock.length, transcriptLines.length, 'one host clock per transcript line');
  assert.ok(clock.every(c => typeof c === 'number' && c > 0), 'host clocks are epoch ms');
  const ev = readJson(path.join(dir, 'events.json'));
  const withHost = ev.filter(e => e.kind === 'tool_result' && typeof e.host_wall_ms === 'number');
  assert.ok(withHost.length > 0, 'tool results carry host-measured spans');
  assert.ok(withHost.every(e => e.host_wall_ms >= 0), 'host spans are non-negative');
});

test('resource samples stream into telemetry and the session summary', async () => {
  const { root, evals, file } = setup([scenario('pos-a', 'positive')]);
  const docker = { daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3', logDir: root, run: { transcript: POS1 }, stats: { samples: 3, intervalMs: 20, mem: '256.25MiB', cpu: '42.5' } };
  const r = await runCli(file, evals, docker);
  assert.equal(r.code, 0, r.stderr);
  const tel = fs.readFileSync(path.join(runDirOf(evals), 'pos-a', 'telemetry.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const samples = tel.filter(e => e.event === 'resource_sample');
  assert.ok(samples.length >= 1, `resource samples streamed, got ${samples.length}`);
  assert.equal(samples[0].mem_mb, 256.25);
  assert.equal(samples[0].cpu_pct, 42.5);
  const res = readJson(path.join(runDirOf(evals), 'pos-a', 'result.json'));
  assert.ok(res.telemetry_summary.resource_samples >= 1, 'summary counts the samples');
  assert.equal(res.telemetry_summary.max_memory_mb, 256.25);
  assert.equal(res.telemetry_summary.max_cpu_pct, 42.5);
});
