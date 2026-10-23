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
import { declaredMcpServers, declaredPluginMcp, mcpConfig, mcpWarnings, missingDependencies } from './mcp.mjs';
import { TelemetryWriter, TELEMETRY_EVENTS, createTelemetryExtractor, summarizeTelemetry } from './telemetry.mjs';
import { classifyError, suggestFix } from './errors.mjs';

const DEFAULTS = { reps: 1, concurrency: 5, timeout: 600, hard_kill_grace: 60, no_output_timeout: 300, max_retries: 0, retry_backoff_ms: 5000, container_memory_mb: 4096 };

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

/** Best-effort image digest for attribution; null when the daemon cannot report it (tests, missing image). */
export async function imageDigest(tag) {
  try {
    const r = await exec('docker', ['image', 'inspect', tag, '--format', '{{.Id}}']);
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* best-effort */ }
  return null;
}

/** Best-effort git SHA of the eval repo itself; null outside a checkout. */
export async function gitSha() {
  try {
    const r = await exec('git', ['rev-parse', 'HEAD'], { cwd: path.dirname(new URL(import.meta.url).pathname) });
    if (r.code === 0 && /^[0-9a-f]{4,40}\s*$/.test(r.stdout)) return r.stdout.trim();
  } catch { /* best-effort */ }
  return null;
}

/** Best-effort docker exit inspection; null when the daemon cannot report it (tests, removed container). */
async function containerInspect(name) {
  try {
    const r = await exec('docker', ['inspect', name, '--format', '{{json .State}}']);
    if (r.code === 0 && r.stdout.trim()) return JSON.parse(r.stdout);
  } catch { /* best-effort */ }
  return null;
}

/**
 * One line per run in `<evalsDir>/.index.jsonl`: the fields history queries need without walking folders.
 * Dot-prefixed so folder-enumerating code (tests, older TUI versions) keeps seeing only run folders.
 * Appends only; a corrupt pre-existing index line never blocks a run.
 */
export function appendIndex(evalsDir, runName, runJson) {
  const perScenario = {};
  for (const s of runJson.scenario_stats ?? []) perScenario[s.scenario] = { reps: s.reps, done: s.done, pass_rate: s.pass_rate };
  const line = JSON.stringify({
    run: runName,
    t_start: runJson.t_start ?? null,
    t_end: runJson.t_end ?? null,
    skill: runJson.skill?.name ?? null,
    kind: runJson.skill?.kind ?? null,
    skill_hash: runJson.skill_hash ?? null,
    scenarios_hash: runJson.scenarios_hash ?? null,
    model: runJson.model?.model ?? null,
    model_alias: runJson.model?.alias ?? null,
    omp_version: runJson.omp_version ?? null,
    image_digest: runJson.image_digest ?? null,
    git_sha: runJson.git_sha ?? null,
    seed: runJson.seed ?? null,
    timeout: runJson.limits?.timeout ?? null,
    reps: runJson.limits?.reps ?? null,
    sessions: runJson.sessions ?? 0,
    skipped_for_cost: runJson.skipped_for_cost ?? [],
    aborted_for_cost: runJson.aborted_for_cost ?? false,
    timeouts: runJson.timeouts ?? 0,
    verdicts: runJson.verdicts ?? {},
    pass_rate: runJson.pass_rate ?? null,
    per_scenario: perScenario,
    session_cost: runJson.session_cost ?? 0,
    total_cost: runJson.total_cost ?? null,
  }) + '\n';
  try { fs.appendFileSync(path.join(path.resolve(evalsDir), '.index.jsonl'), line); }
  catch { /* the index is a convenience, never a failure */ }
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
 * A plugin passes `--plugin-dir /plugin` on every omp invocation (before `-p`), so stage skills and MCP land together.
 */
export function ompCommand({ model, timeout, prompts, pluginDir = null, thinking = null }) {
  const plug = pluginDir ? ['--plugin-dir', pluginDir] : [];
  // A thinking level is a flag, not part of the model id: `provider/model:minimal` is
  // "model not found", while `--thinking minimal` is honoured. Recorded explicitly so a run
  // says which reasoning budget produced it.
  const think = thinking ? ['--thinking', thinking] : [];
  const common = ['-p', '--mode', 'json', ...think];
  if (prompts.length === 1) return ['omp', ...plug, ...common, '--no-session', '--model', model, '--max-time', String(timeout), prompts[0]];
  const dir = '/tmp/eval-session';
  const head = pluginDir
    ? 'rc=0; m="$1"; t="$2"; g="$3"; k="$4"; first="$5"; shift 5'
    : 'rc=0; m="$1"; t="$2"; k="$3"; first="$4"; shift 4';
  const thinkArgs = thinking ? ' --thinking "$k"' : '';
  const invoke = pluginDir
    ? `omp --plugin-dir "$g" -p --mode json${thinkArgs}`
    : `omp -p --mode json${thinkArgs}`;
  const script = [
    head,
    `${invoke} --session-dir ${dir} --model "$m" --max-time "$t" "$first" || rc=$?`,
    `for p in "$@"; do ${invoke} --continue --session-dir ${dir} --model "$m" --max-time "$t" "$p" || rc=$?; done`,
    'exit $rc',
  ].join('\n');
  return ['sh', '-c', script, 'sh', model, String(timeout), ...(pluginDir ? [pluginDir] : []), String(thinking ?? ''), ...prompts];
}

function sessionPlan(cfg) {
  const plan = [];
  for (const s of cfg.scenarios) {
    for (let r = 1; r <= cfg.reps; r++) plan.push({ scenario: s, rep: r, dir: cfg.reps > 1 ? `${s.id}-r${r}` : s.id });
  }
  return plan;
}

/**
 * One container execution, streaming raw stdout/stderr to files. Distinguishes the three ways a session can
 * end past its deadline: `docker kill` fired (natural expiry is only inferred when the child outlives
 * `timeoutMs` without a kill being needed); `no_output` when stdout stays silent past `silentMs`.
 * Host-measured telemetry: every stdout/stderr byte updates the output clock, and a hang watchdog emits
 * `no_output` events while the container is still alive, so `killed` splits into `hung` vs `slow` later.
 * The tail of stderr is kept in memory (bounded) and returned as `stderrTail` for the `container_end` event.
 */
async function runContainer({ args, name, transcript, stderrFile, timeoutMs, graceMs, silentMs = null, onEvent, telemetry = null, resourceMonitoring = true, onLine = null, onRetryTranscript = null }) {
  const tStart = new Date().toISOString();
  const started = Date.now();
  let lastOutputAt = started;
  let lastChunkKind = null;
  onEvent?.({ event: 'container_start', t: tStart, container: name });
  telemetry?.emit(TELEMETRY_EVENTS.CONTAINER_START, { container: name });
  // A retry replays the failed attempt's transcript first: its bytes are evidence, but its lines
  // must not feed the live extractor or host clock — normalize reads only the final transcript,
  // and the live clock array has to stay aligned with that file. Drained to a file, named in
  // host.jsonl so the pairing stays auditable.
  if (onRetryTranscript) {
    try {
      const prev = fs.readFileSync(onRetryTranscript, 'utf8');
      onEvent?.({ event: 'retry_transcript', t: new Date().toISOString(), container: name, replayed_transcript: path.basename(onRetryTranscript), replayed_bytes: Buffer.byteLength(prev) });
    } catch { /* the failed attempt may not have written a transcript */ }
  }
  const out = fs.createWriteStream(transcript);
  const err = fs.createWriteStream(stderrFile);
  // Register before the process can close: pipe() ends these streams as soon as the child's pipes close.
  const flushed = Promise.all([once(out, 'finish'), once(err, 'finish')]);
  const p = spawn('docker', args, { env: process.env });
  let stdoutBytes = 0, stderrBytes = 0;
  const TAIL_CAP = 8_000;
  let stderrTail = '';
  let stdoutPending = '';
  p.stdout.on('data', d => {
    stdoutBytes += d.length;
    lastOutputAt = Date.now();
    lastChunkKind = 'stdout';
    // omp writes one JSON object per line. Handing each complete line to the caller as it
    // arrives is what lets telemetry be written while the session is still running, so a
    // session that dies mid-flight keeps the turns it had already reached.
    if (onLine) {
      stdoutPending += d.toString('utf8');
      const lines = stdoutPending.split('\n');
      stdoutPending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    }
  });
  p.stderr.on('data', d => { stderrBytes += d.length; lastOutputAt = Date.now(); lastChunkKind = 'stderr'; stderrTail = (stderrTail + d.toString('utf8')).slice(-TAIL_CAP); });
  p.stdout.pipe(out);
  p.stderr.pipe(err);
  let killed = false, hung = false;
  // Set when the hard kill fires and inspect runs before the kill: with --rm the container is
  // gone by the time the post-exit inspect runs, so a kill-time OOM is otherwise invisible.
  let oomAtKill = null;
  let silenceEvents = 0;
  const silenceLimit = silentMs ?? DEFAULTS.no_output_timeout * 1000;
  const watchdog = setInterval(() => {
    const silentFor = Date.now() - lastOutputAt;
    if (silentFor >= silenceLimit) {
      silenceEvents++;
      hung = true;
      onEvent?.({ event: 'no_output', t: new Date().toISOString(), container: name, silent_ms: silentFor, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, last_chunk: lastChunkKind, count: silenceEvents });
      telemetry?.emit(TELEMETRY_EVENTS.NO_OUTPUT, { container: name, silent_ms: silentFor, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, count: silenceEvents });
      lastOutputAt = Date.now(); // re-arm: one event per silent window, not a flood
    }
  }, Math.min(silenceLimit, 30_000));
  watchdog.unref?.();

  // Resource monitoring: stream `docker stats` for CPU/memory/disk/network. Streaming, not
  // --no-stream: the one-shot form races container startup (the container often does not exist
  // yet when stats runs, so zero samples were ever recorded). Samples are thinned to one per
  // ~1s so a long session does not flood telemetry.jsonl.
  let statsProc = null;
  let statsCleanup = null;
  if (resourceMonitoring) {
    try {
      statsProc = spawn('docker', ['stats', '--format', '{{json .}}', name], { env: process.env });
      let statsPending = '';
      let lastSampleAt = 0;
      statsProc.stdout.on('data', d => {
        statsPending += d.toString('utf8');
        const lines = statsPending.split('\n');
        statsPending = lines.pop() ?? '';
        for (const line of lines.filter(l => l.trim())) {
          try {
            const s = JSON.parse(line);
            const now = Date.now();
            if (now - lastSampleAt < 1000) continue;
            lastSampleAt = now;
            const memParts = (s.MemUsage ?? '0B / 0B').split(' / ');
            const memUsed = parseFloat(memParts[0]) || 0;
            const memUnit = (memParts[0] ?? '').replace(/[0-9.]/g, '');
            const memMb = memUnit === 'GiB' ? memUsed * 1024 : memUnit === 'MiB' ? memUsed : memUsed / 1024;
            const cpuPct = parseFloat((s.CPUPerc ?? '0%').replace('%', '')) || 0;
            telemetry?.emit(TELEMETRY_EVENTS.RESOURCE_SAMPLE, {
              container: name,
              cpu_pct: cpuPct,
              mem_mb: Math.round(memMb * 100) / 100,
              net_io: s.NetIO ?? null,
              block_io: s.BlockIO ?? null,
            });
          } catch { /* partial line, skip */ }
        }
      });
      statsProc.on('error', () => { /* docker stats not available, skip silently */ });
      statsCleanup = () => { try { statsProc.kill('SIGKILL'); } catch { /* already dead */ } };
    } catch { /* docker stats unavailable */ }
  }

  const hard = setTimeout(async () => {
    killed = true;
    // Inspect before `docker kill`: the kill plus `--rm` removes the container, and its State
    // (OOMKilled in particular) is the only host-side proof of how it died.
    oomAtKill = (await containerInspect(name))?.OOMKilled ?? null;
    onEvent?.({ event: 'hard_kill', t: new Date().toISOString(), container: name, after_ms: Date.now() - started, hung, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes });
    telemetry?.emit(TELEMETRY_EVENTS.CONTAINER_KILL, { container: name, after_ms: Date.now() - started, hung, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes });
    await exec('docker', ['kill', name]);
    setTimeout(() => p.kill('SIGKILL'), 1000);
  }, timeoutMs + graceMs);
  const closed = once(p, 'close');
  const failed = once(p, 'error').then(([e]) => { throw e; });
  let code;
  try { [code] = await Promise.race([closed, failed]); } finally { clearTimeout(hard); clearInterval(watchdog); statsCleanup?.(); }
  await flushed;
  const durationMs = Date.now() - started;
  const timedOut = durationMs >= timeoutMs;
  // `--rm` may have removed the container already; inspect is best-effort and never fails the run.
  // When it finds nothing (the common case under --rm), the kill-time inspect's OOM flag is the
  // only surviving evidence of how the container died.
  const state = await containerInspect(name);
  const oomKilled = state?.OOMKilled ?? oomAtKill;
  const stderrText = (() => { try { return fs.readFileSync(stderrFile, 'utf8'); } catch { return ''; } })();
  onEvent?.({ event: 'container_end', t: new Date().toISOString(), container: name, exit_code: code, killed, timed_out: timedOut, kill_fired: killed, hung, duration_ms: durationMs, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, stderr_tail: stderrText.slice(-2000), docker_state: state, oom_killed: oomKilled });
  telemetry?.emit(TELEMETRY_EVENTS.CONTAINER_END, { container: name, exit_code: code, killed, timed_out: timedOut, duration_ms: durationMs, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, oom_killed: oomKilled });
  return { code, killed, hung, durationMs, timedOut, killFired: killed, stdoutBytes, stderrBytes, stderrTail, dockerState: state, oomKilled, tStart, tEnd: new Date().toISOString() };
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
  const isPlugin = skill.kind === 'plugin';
  const pluginMcp = isPlugin ? declaredPluginMcp(cfg.skill_path) : { servers: {}, warnings: [] };
  const front = isPlugin ? { servers: {}, warnings: [] } : declaredMcpServers(skill.text);
  const mcp = isPlugin ? pluginMcp : front;
  const mcpDoc = mcpConfig(mcp.servers);
  const warnings = isPlugin
    ? [...pluginMcp.warnings, ...mcpWarnings(pluginMcp.servers), ...missingDependencies(skill.text, skill.name, skill.skillNames)]
    : [...front.warnings, ...mcpWarnings(front.servers), ...missingDependencies(skill.text, skill.name)];
  const scenariosHash = sha256(fs.readFileSync(scenariosFile));

  // The run name is second-resolution, and container names derive from it: two runs
  // started in the same second would share a folder and fight over container names,
  // so one run's sessions would land in the other run's folder. Never reuse a name.
  const base = `${stamp(new Date())}-${skill.name}-${model.alias}-${skill.hash.slice(0, 7)}`;
  let runName = base;
  for (let n = 2; fs.existsSync(path.join(path.resolve(evalsDir), runName)); n++) runName = `${base}-${n}`;
  const runDir = path.join(path.resolve(evalsDir), runName);
  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(scenariosFile, path.join(runDir, 'scenarios.json'));
  fs.writeFileSync(path.join(runDir, 'scenarios.lock.json'), JSON.stringify(lock, null, 2));
  copySkill(cfg.skill_path, path.join(runDir, 'skill'));
  const mcpFile = path.join(runDir, 'mcp.json');
  const hasMcp = Object.keys(mcpDoc.mcpServers).length > 0;
  if (hasMcp) fs.writeFileSync(mcpFile, JSON.stringify(mcpDoc, null, 2));

  const plan = sessionPlan(cfg);
  const runTStart = new Date().toISOString();
  // Determinism inputs: what a re-run needs to reproduce this run's conditions. The model itself
  // is remote and unseeded, so `seed` records the runner's plan seed when one is configured
  // (null otherwise) rather than promising reproducible model output.
  const seed = cfg.seed ?? null;
  let spent = 0, aborted = false;
  const skipped = [];
  // The run record is written after every session, not once at the end: a run whose harness
  // dies leaves a run.json that says how far it got, instead of nothing at all.
  const imageDigestValue = await imageDigest(env.image);
  const gitShaValue = await gitSha();
  const completed = [];
  const writeRunJson = (status, tEnd = new Date().toISOString()) => {
    const results = completed.slice();
    const verdicts = {};
    let timeouts = 0;
    const byScenario = new Map();
    for (const res of results) {
      if (!res) continue;
      if (res.timeout) timeouts++;
      const s = byScenario.get(res.scenario) ?? { reps: 0, done: 0, timeouts: 0, errors: 0 };
      s.reps++;
      if (res.timeout) s.timeouts++;
      s.errors += res.errors ?? 0;
      byScenario.set(res.scenario, s);
    }
    const runJson = {
      status,
      skill: { name: skill.name, path: cfg.skill_path, kind: skill.kind },
      skill_hash: skill.hash,
      scenarios_hash: scenariosHash,
      model,
      seed,
      omp_version: env.ompVersion,
      image: env.image,
      image_digest: imageDigestValue,
      git_sha: gitShaValue,
      t_start: runTStart,
      t_end: tEnd,
      host: { node: process.version, platform: process.platform, arch: process.arch },
      limits: { concurrency: cfg.concurrency, timeout: cfg.timeout, hard_kill_grace: cfg.hard_kill_grace, no_output_timeout: cfg.no_output_timeout, reps: cfg.reps, cost_cap: cfg.cost_cap ?? null, thinking: cfg.thinking ?? null, container_memory_mb: cfg.container_memory_mb ?? null, max_retries: cfg.max_retries ?? 0 },
      sessions_planned: plan.length,
      sessions: results.filter(Boolean).length,
      sessions_done: completed.filter(Boolean).length,
      skipped_for_cost: skipped,
      aborted_for_cost: aborted,
      timeouts,
      // Run-level retry usage: per-session retry_attempts exists in result.json, but without
      // the total a run with max_retries > 0 cannot say at a glance whether retries happened.
      retry_attempts: results.reduce((a, r) => a + (r?.retry_attempts ?? 0), 0),
      session_cost: results.reduce((a, r) => a + (r?.cost ?? 0), 0),
      warnings,
      scenario_stats: [...byScenario.entries()].map(([scenario, s]) => ({ scenario, ...s, pass_rate: null })),
      verdicts,
      pass_rate: null,
    };
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(runJson, null, 2));
    return runJson;
  };
  writeRunJson('running');
  const results = await pool(plan, cfg.concurrency, async item => {
    const dir = path.join(runDir, item.dir);
    // Per-session telemetry writer
    const telemetry = new TelemetryWriter(path.join(dir, 'telemetry.jsonl'));
    telemetry.emit(TELEMETRY_EVENTS.SESSION_START, { session: item.dir, scenario: item.scenario.id, rep: item.rep, model: model.model });
    if (aborted) {
      skipped.push(item.dir);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'host.jsonl'), JSON.stringify({ event: 'session_skipped', t: new Date().toISOString(), session: item.dir, reason: 'cost_cap' }) + '\n');
      return null;
    }
    const workspace = path.join(dir, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const hostLog = [];
    const onEvent = e => hostLog.push(e);
    onEvent({ event: 'session_scheduled', t: new Date().toISOString(), session: item.dir, rep: item.rep });
    for (const [rel, content] of Object.entries(item.scenario.fixtures ?? {})) {
      const f = fixtureTarget(workspace, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify({ ...item.scenario, skill: skill.name, skill_names: skill.skillNames, rep: item.rep, seed, timeout: cfg.timeout }) + '\n');
    // Per-session plan record: the exact conditions this session ran under.
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ session: item.dir, scenario: item.scenario.id, rep: item.rep, seed, model: model.model, model_alias: model.alias, timeout: cfg.timeout, hard_kill_grace: cfg.hard_kill_grace, no_output_timeout: cfg.no_output_timeout, followups: (item.scenario.followups ?? []).length, thinking: cfg.thinking ?? null }, null, 2));

    const name = `skill-eval-${runName}-${item.dir}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    // Telemetry is written as the session runs, not after it: the extractor is fed each
    // transcript line the moment the container emits it.
    const extractor = createTelemetryExtractor(telemetry);
    let linesOffered = 0;
    // Host arrival clock per transcript line: the host-side pairing normalizeEvents needs for
    // true host_wall_ms tool spans. One Date.now() per non-empty line, in arrival order.
    const hostClockMs = [];
    const onLine = line => {
      linesOffered++;
      hostClockMs.push(Date.now());
      try { extractor.record(JSON.parse(line)); } catch { /* not a JSON line; the transcript keeps it */ }
    };
    // A plugin mounts whole at /plugin with --plugin-dir, so stage skills resolve relatively and the MCP
    // server runs from the mounted tree. A single skill keeps the legacy skills-dir mount (no plugin discovery).
    // --plugin-dir must precede the subcommand; --model/--max-time travel inside ompCommand.
    const skillMount = isPlugin
      ? [`-v`, `${path.join(runDir, 'skill')}:/plugin:ro`]
      : [`-v`, `${path.join(runDir, 'skill')}:/root/.omp/agent/skills/${skill.name}:ro`];
    const args = [
      'run', '--rm', '--name', name,
      // A hard memory limit makes OOM a recorded fact (docker_state.OOMKilled) instead of a
      // host-wide near-OOM that shows up only as a hung container. 0 disables the limit.
      ...(cfg.container_memory_mb > 0 ? ['--memory', `${cfg.container_memory_mb}m`] : []),
      ...(item.scenario.env ?? []).flatMap(n => ['-e', n]),
      '-e', model.env, // by name only: the value comes from the docker client's environment, never the command line
      '-v', `${workspace}:/work`,
      ...skillMount,
      ...(hasMcp ? ['-v', `${mcpFile}:/root/.omp/agent/mcp.json:ro`] : []),
      env.image,
      ...ompCommand({ model: model.model, timeout: cfg.timeout, prompts: [item.scenario.prompt, ...(item.scenario.followups ?? [])], pluginDir: isPlugin ? '/plugin' : null, thinking: cfg.thinking ?? null }),
    ];
    // Retry loop for transient failures (timeouts, OOM, nonzero exit)
    const maxRetries = cfg.max_retries ?? 0;
    let r;
    let attempt = 0;
    let lastError = null;
    for (;;) {
      attempt++;
      r = await runContainer({
        args, name,
        transcript: path.join(dir, attempt > 1 ? `transcript.retry-${attempt - 1}.jsonl` : 'transcript.jsonl'),
        stderrFile: path.join(dir, attempt > 1 ? `stderr.retry-${attempt - 1}.txt` : 'stderr.txt'),
        onRetryTranscript: attempt > 1 ? path.join(dir, attempt === 2 ? 'transcript.jsonl' : `transcript.retry-${attempt - 2}.jsonl`) : null,
        timeoutMs: cfg.timeout * 1000,
        graceMs: cfg.hard_kill_grace * 1000,
        silentMs: (cfg.no_output_timeout ?? DEFAULTS.no_output_timeout) * 1000,
        onEvent,
        telemetry,
        onLine,
        resourceMonitoring: true,
      });
      // Retry only on transient failures: timeout, OOM, or specific exit codes
      const retryable = r.timedOut || r.dockerState?.OOMKilled || r.code === 137 || r.code === 125;
      if (!retryable || attempt > maxRetries) break;
      const backoffMs = (cfg.retry_backoff_ms ?? 5000) * attempt;
      telemetry.emit(TELEMETRY_EVENTS.RETRY_ATTEMPT, {
        session: item.dir,
        attempt,
        reason: r.timedOut ? 'timeout' : r.dockerState?.OOMKilled ? 'oom' : `exit_${r.code}`,
        backoff_ms: backoffMs,
      });
      onEvent({ event: 'retry_attempt', t: new Date().toISOString(), session: item.dir, attempt, reason: r.timedOut ? 'timeout' : 'oom_or_exit', backoff_ms: backoffMs });
      await new Promise(res => setTimeout(res, backoffMs));
    }
    if (attempt > 1) {
      telemetry.emit(TELEMETRY_EVENTS.RETRY_EXHAUSTED, { session: item.dir, attempts: attempt, final_code: r.code, timed_out: r.timedOut });
      onEvent({ event: 'retry_exhausted', t: new Date().toISOString(), session: item.dir, attempts: attempt });
    }
    r.retry_attempts = attempt - 1;
    onEvent({ event: 'normalize_start', t: new Date().toISOString(), session: item.dir });
    // The transcript's line count and the host clock array must align index-for-index; the array
    // is written before normalizeSession reads it back. A retried session replays only its final
    // transcript, so the live array always matches the file on disk.
    fs.writeFileSync(path.join(dir, 'host-clock.json'), JSON.stringify(hostClockMs));
    const res = normalizeSession(dir, {
      timedOut: r.timedOut, timeoutKind: r.timedOut ? (r.killFired ? (r.hung ? 'hung' : 'killed') : 'expired') : null,
      exitCode: r.killed ? null : r.code, durationMs: r.durationMs, tStart: r.tStart, tEnd: r.tEnd,
      hostClockMs,
    });
    // Feed the extractor anything the live path did not see: the last line of a transcript
    // that ended without a newline, or a line that arrived after the container closed. Feeding
    // the whole transcript again would double every event.
    try {
      const raw = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8');
      const lines = raw.split('\n');
      for (const line of lines.slice(linesOffered)) {
        if (!line.trim()) continue;
        // Same arrival-clock pairing as the live path; appended after normalize so the array
        // already written stays aligned with the transcript lines it covered. Rewritten below.
        hostClockMs.push(Date.now());
        try { extractor.record(JSON.parse(line)); } catch { /* not a JSON line */ }
      }
      fs.writeFileSync(path.join(dir, 'host-clock.json'), JSON.stringify(hostClockMs));
    } catch { /* transcript may not exist on early failure */ }
    // Host-measured container facts that the transcript cannot carry: bytes, stderr, docker state.
    res.stdout_bytes = r.stdoutBytes;
    res.stderr_bytes = r.stderrBytes;
    res.stderr_tail = r.stderrTail.slice(-2000);
    res.docker_state = r.dockerState;
    res.oom_killed = r.dockerState?.OOMKilled ?? r.oomKilled ?? null;
    res.hung = r.hung;
    res.retry_attempts = r.retry_attempts ?? 0;
    // Error taxonomy classification
    res.error_class = classifyError(res, null, item.scenario);
    res.error_fix = suggestFix(res.error_class);
    // Telemetry summary
    try {
      const events = TelemetryWriter.read(path.join(dir, 'telemetry.jsonl'));
      res.telemetry_summary = summarizeTelemetry(events);
    } catch { res.telemetry_summary = null; }
    telemetry.emit(TELEMETRY_EVENTS.SESSION_END, { session: item.dir, exit_code: res.exit_code, timeout: res.timeout, error_class: res.error_class, duration_ms: res.duration_ms });
    telemetry.close();
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(res, null, 2));
    onEvent({ event: 'session_end', t: new Date().toISOString(), session: item.dir, exit_code: res.exit_code, timeout: res.timeout, timeout_kind: res.timeout_kind, stdout_bytes: r.stdoutBytes, stderr_bytes: r.stderrBytes, oom_killed: res.oom_killed, error_class: res.error_class });
    fs.writeFileSync(path.join(dir, 'host.jsonl'), hostLog.map(e => JSON.stringify(e)).join('\n') + '\n');
    spent += res.cost;
    if (cfg.cost_cap != null && spent > cfg.cost_cap) {
      aborted = true;
      onEvent({ event: 'cost_cap_abort', t: new Date().toISOString(), spent });
      fs.appendFileSync(path.join(dir, 'host.jsonl'), JSON.stringify({ event: 'cost_cap_abort', t: new Date().toISOString(), spent }) + '\n');
    }
    // The run record advances with every finished session, so a run that dies leaves a
    // run.json that says exactly how far it got and which sessions survived.
    completed.push(res);
    writeRunJson('running');
    return res;
  });

  const runJson = writeRunJson('complete');
  appendIndex(evalsDir, runName, runJson);
  return runDir;
}
