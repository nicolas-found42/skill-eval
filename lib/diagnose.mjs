import fs from 'node:fs';
import path from 'node:path';
import { UserError } from './exec.mjs';
import { sessionDirs } from './grade.mjs';
import { suggestFix } from './errors.mjs';
import { TelemetryWriter, summarizeTelemetry } from './telemetry.mjs';


const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
/** Host lines are append-only orchestration log; one corrupt line (crashed writer) must not hide the rest. */
const readLines = p => fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim()).flatMap(l => {
  try { return [JSON.parse(l)]; } catch { return []; }
});
const fmtMs = ms => (ms == null ? 'n/a' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtT = t => (t == null ? 'n/a' : new Date(t).toISOString().slice(11, 19));

function sessionTimeline(dir) {
  const scenario = readJson(path.join(dir, 'scenario.json'));
  const hasResult = fs.existsSync(path.join(dir, 'result.json'));
  // A session the harness never got to normalize has a transcript but no result.json. Reading
  // it as a missing file is what made a crashed run look like a run that never happened.
  const result = hasResult
    ? readJson(path.join(dir, 'result.json'))
    : { scenario: scenario.id, kind: scenario.kind, exit_code: null, timeout: false, duration_ms: null, turns: null, tokens: null, cost: null, not_normalized: true };
  const eventsPath = path.join(dir, 'events.json');
  const events = fs.existsSync(eventsPath) ? readJson(eventsPath) : [];
  const host = fs.existsSync(path.join(dir, 'host.jsonl')) ? readLines(path.join(dir, 'host.jsonl')) : null;
  const grading = fs.existsSync(path.join(dir, 'grading.json')) ? readJson(path.join(dir, 'grading.json')) : null;
  const partial = fs.existsSync(path.join(dir, 'transcript.partial.txt'))
    ? fs.readFileSync(path.join(dir, 'transcript.partial.txt'), 'utf8') : null;
  const sessionPlan = fs.existsSync(path.join(dir, 'session.json')) ? readJson(path.join(dir, 'session.json')) : null;
  const hasFullEvents = fs.existsSync(path.join(dir, 'events.full.json'));
  const telemetryPath = path.join(dir, 'telemetry.jsonl');
  const telemetry = fs.existsSync(telemetryPath) ? TelemetryWriter.read(telemetryPath) : null;
  const telemetrySummary = telemetry ? summarizeTelemetry(telemetry) : null;
  return { name: path.basename(dir), scenario, result, events, host, grading, partial, sessionPlan, hasFullEvents, telemetry, telemetrySummary, notNormalized: !hasResult };
}

/** Structured gap list shared by the text and JSON session views. */
function sessionGaps(dir, s) {
  const r = s.result;
  const gaps = [];
  if (s.notNormalized) {
    const transcript = path.join(dir, 'transcript.jsonl');
    const chars = fs.existsSync(transcript) ? fs.statSync(transcript).size : 0;
    gaps.push({
      code: 'not_normalized',
      message: `the session has a ${chars}-byte transcript but was never normalized: the harness stopped before it could write events.json/result.json.`,
      hint: `run \`eval.mjs normalize ${dir}\` to recover it`,
    });
  }
  const truncEv = s.events.filter(e => e.truncated);
  if (truncEv.length) gaps.push({ code: 'capped_events', message: `${truncEv.length} event(s) capped at EVENT_CAP with raw_chars preserved; the judge saw the first 4000 chars only${s.hasFullEvents ? '; full text in events.full.json' : ''}.`, hint: 'open events.full.json at the same turn/event' });
  if (s.partial) gaps.push({ code: 'dropped_tail', message: `${s.partial.length} chars of cut trailing transcript saved in transcript.partial.txt.`, hint: 'read transcript.partial.txt' });
  else if ((r.dropped_chars ?? 0) > 0) gaps.push({ code: 'dropped_tail', message: `${r.dropped_chars} transcript chars were dropped (no transcript.partial.txt saved).`, hint: 're-run the scenario; the tail is lost for this session' });
  if (s.grading) {
    if (s.grading.truncated) gaps.push({ code: 'over_cap_evidence', message: `evidence over cap (${s.grading.evidence_chars} chars): no step could auto-pass.`, hint: 're-run grade with a larger --evidence-cap' });
    const unclear = s.grading.steps.filter(x => x.verdict === 'needs_human');
    if (unclear.length) {
      const ev = fs.existsSync(path.join(dir, 'grading.evidence.json'));
      gaps.push({ code: 'needs_human', message: `steps needing a human: ${unclear.map(x => x.id).join(', ')}${ev ? ' (judge state saved in grading.evidence.json)' : ''}.`, hint: ev ? 'audit grading.evidence.json' : 're-run with --keep-evidence to audit the judge state' });
    }
  } else {
    gaps.push({ code: 'ungraded', message: 'not graded yet.', hint: 'run `eval.mjs grade <run>` first' });
  }
  if (!r.skill_loaded && s.scenario.kind !== 'negative') gaps.push({ code: 'skill_never_loaded', message: 'skill was never loaded in a scenario that should trigger it.', hint: 'check events.json turn 1 for the skill read' });
  if (r.timeout) gaps.push({ code: r.timeout_kind === 'hung' ? 'timeout_hung' : r.timeout_kind === 'expired' ? 'timeout_expired' : 'timeout_killed', message: r.timeout_kind === 'hung' ? 'the container went silent before the hard kill (no output for a full window).' : r.timeout_kind === 'expired' ? 'the container outlived the timeout without a kill firing (natural expiry / slow drain).' : 'the hard kill fired; the session outlived timeout+grace.', hint: 'check host.jsonl no_output/container_end for bytes and timing' });
  else if (r.exit_code !== 0 && r.exit_code != null) gaps.push({ code: 'nonzero_exit', message: `nonzero exit ${r.exit_code} without timeout: the container failed, not the clock.`, hint: 'check stderr.txt and host.jsonl container_end' });
  if (r.oom_killed) gaps.push({ code: 'oom_killed', message: 'the container was OOM-killed.', hint: 'reduce concurrency or raise the container memory limit' });
  if ((r.stderr_bytes ?? 0) > 0 && !r.timeout && r.exit_code === 0) gaps.push({ code: 'stderr_nonempty', message: `${r.stderr_bytes} stderr bytes on a clean exit.`, hint: 'read stderr.txt; docker warnings live there' });
  if (!s.host) gaps.push({ code: 'no_host_log', message: 'no host.jsonl: session predates host logging; timeout kind unknown.', hint: 're-run to get host telemetry' });
  if (r.error_class && r.error_class !== 'unknown') {
    gaps.push({ code: `error_${r.error_class}`, message: `classified as: ${r.error_class}${r.error_fix ? ` — ${r.error_fix}` : ''}.`, hint: `query more sessions with this class: eval.mjs query error-classes` });
  }
  if (s.telemetrySummary) {
    if (s.telemetrySummary.max_memory_mb > 1024) gaps.push({ code: 'high_memory', message: `peak memory ${s.telemetrySummary.max_memory_mb.toFixed(0)} MB during session.`, hint: 'reduce concurrency or raise the container memory limit' });
    if (s.telemetrySummary.retries > 0) gaps.push({ code: 'retries_occurred', message: `${s.telemetrySummary.retries} retry event(s) recorded.`, hint: 'check telemetry.jsonl for retry_attempt events' });
    if (s.telemetrySummary.tool_errors > 0) gaps.push({ code: 'tool_errors', message: `${s.telemetrySummary.tool_errors} tool error(s) during session.`, hint: 'check telemetry.jsonl for tool_error events' });
    if (s.telemetrySummary.provider_retries > 0) {
      gaps.push({
        code: 'provider_retries',
        message: `${s.telemetrySummary.provider_retries} provider retry/retry-cycle(s), ${s.telemetrySummary.provider_retries_recovered} recovered, ${s.telemetrySummary.provider_retry_delay_ms}ms of provider-imposed delay.`,
        hint: 'check telemetry.jsonl for provider_retry events; a recovered 429 explains a slow session',
      });
    }
  }
  return gaps;
}

/** Concrete re-run suggestion derived from the gaps; null fields mean "no change needed". */
function suggestedRerun(s) {
  const out = { evidence_cap: null, keep_evidence: false, timeout: null, reps: null, reasons: [] };
  const unclear = s.grading?.steps?.filter(x => x.verdict === 'needs_human') ?? [];
  if (s.grading?.truncated) {
    const fixed = s.grading.evidence_breakdown ? Object.values(s.grading.evidence_breakdown).reduce((a, v) => a + (v ?? 0), 0) : 0;
    out.evidence_cap = Math.ceil(((s.grading.evidence_chars ?? 0) + fixed + 50_000) / 50_000) * 50_000;
    out.reasons.push(`evidence was ${s.grading.evidence_chars} chars over cap; re-grade with --evidence-cap ${out.evidence_cap}`);
  }
  if (unclear.length && !s.grading) { /* unreachable: unclear implies graded */ }
  if (unclear.length) {
    out.keep_evidence = true;
    out.reasons.push(`steps needing a human (${unclear.map(x => x.id).join(', ')}); keep judge state to audit`);
  }
  if (s.result.timeout) {
    out.timeout = 'increase';
    out.reasons.push(`session hit the ${s.result.timeout_kind ?? 'timeout'} limit after ${s.result.duration_ms}ms; raise timeout or split the scenario`);
  }
  return out;
}

function sessionContainer(s) {
  const r = s.result;
  const host = s.host ?? [];
  return {
    hung: r.hung ?? host.some(e => e.event === 'no_output'),
    no_output_events: host.filter(e => e.event === 'no_output').length,
    oom_killed: r.oom_killed ?? null,
    stdout_bytes: r.stdout_bytes ?? null,
    stderr_bytes: r.stderr_bytes ?? null,
    stderr_tail: r.stderr_tail ?? null,
    docker_state: r.docker_state ?? null,
  };
}

function sessionTimelineRows(s) {
  const byTurn = new Map();
  for (const e of s.events) {
    if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
    byTurn.get(e.turn).push(e);
  }
  // The transcript's clock is the container's; the host log's is the host's. The offset recorded
  // at normalize time is what makes the two comparable in one timeline.
  const offset = typeof s.result.clock_offset_ms === 'number' ? s.result.clock_offset_ms : null;
  return [...byTurn.entries()].sort((a, b) => a[0] - b[0]).map(([turn, evs]) => {
    const te = s.result.turn_ends?.[turn];
    const t = evs[0]?.t ?? null;
    return {
      turn,
      t,
      host_t: t != null && offset != null ? t + offset : null,
      model_ms: te?.dur_ms ?? null,
      tools_ms: evs.filter(e => typeof e.wall_ms === 'number').reduce((a, e) => a + e.wall_ms, 0) || null,
      host_tools_ms: evs.filter(e => typeof e.host_wall_ms === 'number').reduce((a, e) => a + e.host_wall_ms, 0) || null,
      calls: evs.filter(e => e.kind === 'tool_call').map(e => e.tool),
      errors: evs.filter(e => e.kind === 'tool_result' && e.is_error).map(e => e.tool),
    };
  });
}

/** Machine-readable session diagnosis: every gap as a code plus a concrete re-run suggestion. */
export function diagnoseSessionJson(dir) {
  const s = sessionTimeline(dir);
  const r = s.result;
  return {
    session: s.name,
    kind: s.scenario.kind,
    prompt: s.scenario.prompt,
    seed: s.scenario.seed ?? s.sessionPlan?.seed ?? null,
    exit_code: r.exit_code,
    timeout: r.timeout,
    timeout_kind: r.timeout_kind,
    duration_ms: r.duration_ms,
    clock: { start: r.t_start ?? null, end: r.t_end ?? null },
    turns: r.turns, user_turns: r.user_turns ?? null, assistant_texts: r.assistant_texts ?? null,
    tool_results: r.tool_results ?? null, errors: r.errors ?? null,
    tokens: r.tokens, cost: r.cost,
    clock_offset_ms: r.clock_offset_ms ?? null,
    provider_retries: r.provider_retries ?? null,
    provider_errors: r.provider_errors ?? null,
    transcript: { chars: r.transcript_chars ?? null, dropped_chars: r.dropped_chars ?? 0, truncated_events: r.truncated_events ?? 0, has_full_events: s.hasFullEvents, partial_chars: s.partial?.length ?? 0 },
    tool_stats: r.tool_stats ?? {},
    container: sessionContainer(s),
    timeline: sessionTimelineRows(s),
    steps: s.grading ? s.grading.steps.map(x => ({ id: x.id, verdict: x.verdict, blocked_by: x.blocked_by ?? null })) : null,
    truncated_evidence: s.grading?.truncated ?? null,
    gaps: sessionGaps(dir, s),
    suggested_rerun: suggestedRerun(s),
  };
}

/** One session's diagnosis: timeline, timeout disambiguation, truncation and judge gaps. */
export function diagnoseSession(dir) {
  const s = sessionTimeline(dir);
  const L = [`# diagnose: ${s.name} [${s.scenario.kind}]`, ''];
  L.push(`prompt: ${s.scenario.prompt}`);
  const r = s.result;
  L.push(`exit=${r.exit_code ?? 'killed'} timeout=${r.timeout}${r.timeout_kind ? ` (${r.timeout_kind})` : ''} duration=${fmtMs(r.duration_ms)} turns=${r.turns} tokens=${r.tokens} cost=$${(r.cost ?? 0).toFixed(5)}`);
  L.push(`clock: ${r.t_start ?? 'n/a'} -> ${r.t_end ?? 'n/a'}`);
  L.push(`transcript: ${r.transcript_chars ?? 'n/a'} chars, ${r.dropped_chars ?? 0} dropped, ${r.truncated_events ?? 0} truncated events${s.hasFullEvents ? ' (full text in events.full.json)' : ''}`);
  if (r.tool_stats) {
    const tools = Object.entries(r.tool_stats).map(([t, v]) => `${t} x${v.calls}${v.errors ? ` (${v.errors} err)` : ''}${v.wall_ms ? ` ${fmtMs(Math.round(v.wall_ms))}` : ''}${v.host_wall_ms ? ` host=${fmtMs(Math.round(v.host_wall_ms))}` : ''}`);
    if (tools.length) L.push(`tools: ${tools.join(', ')}`);
  }
  const c = sessionContainer(s);
  if (c.stdout_bytes != null || c.oom_killed || c.hung || c.no_output_events) {
    L.push(`container: stdout=${c.stdout_bytes ?? 'n/a'} bytes, stderr=${c.stderr_bytes ?? 'n/a'} bytes${c.hung ? `, silent x${c.no_output_events} (hung)` : ''}${c.oom_killed ? ', OOM-KILLED' : ''}`);
    if (c.stderr_tail?.trim()) L.push(`stderr tail: ${c.stderr_tail.trim().split('\n').pop()}`);
  }
  L.push('');

  // Timeout disambiguation: kill fired vs natural expiry vs clean exit.
  if (s.host) {
    const kill = s.host.find(e => e.event === 'hard_kill');
    const end = s.host.find(e => e.event === 'container_end');
    if (r.timeout && kill) L.push(`timeout: hard kill fired ${fmtMs(kill.after_ms)} in${r.timeout_kind === 'hung' ? ' after the container went silent' : ''}; container exited ${end?.exit_code ?? '?'}. The session outlived timeout+grace.`);
    else if (r.timeout) L.push('timeout: container outlived the timeout without a kill firing (natural expiry / slow drain).');
    else if (r.exit_code !== 0) L.push(`nonzero exit ${r.exit_code} without timeout: the container failed, not the clock.`);
    else L.push('exit: clean, within the timeout.');
    L.push('');
  } else {
    L.push('(no host.jsonl: session predates host logging; timeout kind unknown.)', '');
  }

  // Turn timeline with per-turn model time and tool wall time.
  L.push('## timeline', '');
  const offset = typeof s.result.clock_offset_ms === 'number' ? s.result.clock_offset_ms : null;
  if (offset != null) L.push(`(container clock offset from host: ${offset}ms; both times are shown)`);
  for (const row of sessionTimelineRows(s)) {
    L.push(`- turn ${row.turn} @${fmtT(row.t)}${row.host_t != null ? ` host=${fmtT(row.host_t)}` : ''}${row.model_ms != null ? ` model=${fmtMs(Math.round(row.model_ms))}` : ''}${row.tools_ms ? ` tools=${fmtMs(Math.round(row.tools_ms))}` : ''}${row.calls.length ? `: ${row.calls.join(', ')}` : ''}${row.errors.length ? ` ERRORS: ${row.errors.join(', ')}` : ''}`);
  }
  L.push('');

  // Truncation and judge gaps.
  const gaps = sessionGaps(dir, s);
  L.push('## gaps', '');
  L.push(...(gaps.length ? gaps.map(g => `- [${g.code}] ${g.message} (${g.hint})`) : ['- none: clean exit, full evidence, every step judged.']));
  L.push('');
  return L.join('\n');
}

/** Every session folder in a run folder, normalized or not. A stranded session still counts. */
function sessionFolderNames(runDir) {
  return fs.readdirSync(runDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(runDir, e.name, 'scenario.json')))
    .map(e => e.name).sort();
}

/**
 * A run record for a run that never wrote one. Everything known is read from the run folder:
 * the skill from the copied snapshot, the model from the per-session plan.
 */
function synthesizedRun(runDir) {
  const names = sessionFolderNames(runDir);
  const plans = names.map(n => {
    const p = path.join(runDir, n, 'session.json');
    return fs.existsSync(p) ? readJson(p) : null;
  }).filter(Boolean);
  const first = plans[0];
  const results = names.map(n => {
    const p = path.join(runDir, n, 'result.json');
    return fs.existsSync(p) ? readJson(p) : null;
  }).filter(Boolean);
  const tStarts = results.map(r => r.t_start).filter(Boolean).sort();
  return {
    status: 'interrupted',
    skill: { name: skillNameOf(runDir), kind: null },
    model: first ? { model: first.model, alias: first.model_alias } : null,
    sessions: results.length,
    sessions_planned: names.length,
    t_start: tStarts[0] ?? null,
    t_end: null,
    session_cost: results.reduce((a, r) => a + (r.cost ?? 0), 0),
    timeouts: results.filter(r => r.timeout).length,
    warnings: [],
  };
}

/** The skill's own name, from the snapshot the run copied. Folder names cannot be parsed: both parts carry dashes. */
function skillNameOf(runDir) {
  const file = path.join(runDir, 'skill', 'SKILL.md');
  if (fs.existsSync(file)) {
    const m = /^name:\s*(.+)$/m.exec(fs.readFileSync(file, 'utf8'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

/** Machine-readable run diagnosis: per-session summaries with gap codes, no judge calls. */
export function diagnoseRunJson(runDir, { session = null } = {}) {
  const hasRunJson = fs.existsSync(path.join(runDir, 'run.json'));
  if (session) return diagnoseSessionJson(path.join(runDir, session));
  // A run whose harness died has no run.json. Refusing it made a crashed run look like a run
  // that never happened, so the view is synthesized from the session folders instead.
  const run = hasRunJson ? readJson(path.join(runDir, 'run.json')) : synthesizedRun(runDir);
  const names = sessionFolderNames(runDir);
  const sessions = names.map(n => {
    const dir = path.join(runDir, n);
    try {
      const j = diagnoseSessionJson(dir);
      return { name: n, scenario: j.prompt !== undefined ? readJson(path.join(dir, 'scenario.json')).id : n, kind: j.kind, exit_code: j.exit_code, timeout: j.timeout, timeout_kind: j.timeout_kind, duration_ms: j.duration_ms, steps: j.steps, truncated_evidence: j.truncated_evidence, gaps: j.gaps.map(g => g.code), suggested_rerun: j.suggested_rerun };
    } catch {
      return { name: n, error: 'no result.json (skipped or never normalized)' };
    }
  });
  return {
    run: path.basename(runDir),
    incomplete: !hasRunJson || run.status === 'running',
    status: run.status ?? (hasRunJson ? 'complete' : 'unknown'),
    skill: run.skill?.name ?? null, skill_kind: run.skill?.kind ?? null,
    skill_hash: run.skill_hash ?? null, scenarios_hash: run.scenarios_hash ?? null,
    model: run.model?.model ?? null, model_alias: run.model?.alias ?? null,
    seed: run.seed ?? null, omp_version: run.omp_version ?? null, image: run.image ?? null,
    image_digest: run.image_digest ?? null, git_sha: run.git_sha ?? null,
    clock: { start: run.t_start ?? null, end: run.t_end ?? null },
    sessions: run.sessions ?? names.length, timeouts: run.timeouts ?? null,
    aborted_for_cost: run.aborted_for_cost ?? false, skipped_for_cost: run.skipped_for_cost ?? [],
    verdicts: run.verdicts ?? null, pass_rate: run.pass_rate ?? null,
    scenario_stats: run.scenario_stats ?? null,
    warnings: run.warnings ?? [],
    sessions_detail: sessions,
  };
}

/** Diagnose a run folder: per-session verdict lines plus the run-level story (index entry, warnings, cost aborts). */
export function diagnoseRun(runDir, { session = null } = {}) {
  const hasRunJson = fs.existsSync(path.join(runDir, 'run.json'));
  if (session) return diagnoseSession(path.join(runDir, session));
  const run = hasRunJson ? readJson(path.join(runDir, 'run.json')) : synthesizedRun(runDir);
  const names = sessionFolderNames(runDir);
  const tuiErrors = fs.existsSync(path.join(runDir, 'tui-errors.json')) ? readJson(path.join(runDir, 'tui-errors.json')) : [];
  const L = [`# diagnose: ${path.basename(runDir)}`, ''];
  L.push(`skill=${run.skill?.name ?? '?'} model=${run.model?.model ?? '?'} omp=${run.omp_version ?? '?'} image=${run.image ?? '?'}${run.image_digest ? ` (${run.image_digest.slice(0, 19)}…)` : ''}${run.git_sha ? ` git=${run.git_sha.slice(0, 7)}` : ''}`);
  L.push(`clock: ${run.t_start ?? 'n/a'} -> ${run.t_end ?? 'n/a'}; sessions=${names.length} timeouts=${run.timeouts ?? 'n/a'} aborted_for_cost=${run.aborted_for_cost ?? false}${run.pass_rate != null ? ` pass_rate=${run.pass_rate.toFixed(2)}` : ''}${run.seed != null ? ` seed=${run.seed}` : ''}`);
  if (!hasRunJson) {
    L.push('', '## interrupted', '', '- this run has no run.json: the harness stopped before it wrote one.', '- the sessions below were rebuilt from the session folders; run `eval.mjs normalize <session-dir>` on any session marked "never normalized".');
  } else if (run.status === 'running') {
    L.push('', '## interrupted', '', `- the run record says status=running: the harness stopped with ${run.sessions_done ?? 0}/${run.sessions_planned ?? '?'} sessions done.`);
  }
  if (run.warnings?.length) { L.push('', '## warnings (read first: may be missing deps, not a broken skill)', ''); for (const w of run.warnings) L.push(`- ${w}`); }
  if (tuiErrors.length) { L.push('', '## console errors (from the TUI run that produced this folder)', ''); for (const e of tuiErrors) L.push(`- ${(typeof e === 'object' ? e.t + ' ' + e.error : e) ?? ''}`.trim()); }
  L.push('', '## sessions', '');
  for (const n of names) {
    const dir = path.join(runDir, n);
    let res = null, grd = null;
    try { res = readJson(path.join(dir, 'result.json')); } catch { /* skipped or never normalized */ }
    try { grd = readJson(path.join(dir, 'grading.json')); } catch { /* ungraded */ }
    if (!res) { L.push(`- ${n}: never normalized (transcript present, no result.json) — run \`eval.mjs normalize ${dir}\``); continue; }
    const verdicts = grd ? ` steps=${grd.steps.map(s => `${s.id}=${s.verdict}`).join(' ')}${grd.truncated ? ' [TRUNCATED]' : ''}` : ' (ungraded)';
    L.push(`- ${n}: exit=${res.exit_code ?? 'killed'} timeout=${res.timeout}${res.timeout_kind ? `(${res.timeout_kind})` : ''} ${fmtMs(res.duration_ms)}${verdicts}`);
  }
  L.push('', `detail: \`eval.mjs diagnose <run> --session <name>\` for one session's timeline.`);
  return L.join('\n');
}
