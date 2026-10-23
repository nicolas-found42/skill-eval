import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { UserError } from './exec.mjs';
import { collectProviderRetries } from './telemetry.mjs';

export const EVENT_CAP = 4_000;

/**
 * The session's transcript, raw or archived. An archived session has transcript.jsonl.gz and no
 * raw file; the recovery path (`eval.mjs normalize`) has to work on it too, or archiving an
 * interrupted run would throw away the only copy of what happened.
 */
export function readTranscript(dir) {
  const raw = path.join(dir, 'transcript.jsonl');
  if (fs.existsSync(raw)) return fs.readFileSync(raw, 'utf8');
  const gz = path.join(dir, 'transcript.jsonl.gz');
  if (fs.existsSync(gz)) return zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8');
  throw new UserError(`${dir} has no transcript.jsonl (or transcript.jsonl.gz) to read`);
}

const clip = (s, cap = EVENT_CAP) => (s.length > cap
  ? { text: s.slice(0, cap), truncated: true, raw_chars: s.length }
  : { text: s, truncated: false, raw_chars: s.length });

/**
 * Parse omp `--mode json` JSONL. Lines that are not complete JSON (a killed container cuts the last one)
 * are kept as `partial` so diagnosis can see the dropped tail instead of silently losing it.
 */
export function parseJsonl(raw) {
  const records = [];
  const partial = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { partial.push(line); }
  }
  const tail = partial.join('\n');
  return { records, partial: tail, dropped_chars: tail.length };
}

/**
 * Turn raw omp events into a flat, capped timeline plus session totals.
 * `skillName` identifies a skill load: a `read` of `skill://<name>` or of any path ending in `<name>/SKILL.md`.
 * `skillNames` extends that to every stage skill of a plugin under test; a single skill keeps fontmatter-free
 * matching on the one name.
 * Timing: omp puts epoch-ms `message.timestamp` on message/turn records (tool start/end records carry none),
 * so each event carries `t`, the latest clock seen when it was emitted (null when the transcript has no clock).
 * Per-tool wall time comes from `result.details.wallTimeMs` when the tool reports it; per-turn model time from
 * `turn_end` records. All of it is best-effort: missing clocks yield nulls, never errors.
 * Host-measured tool spans: `tool_execution_start` records carry no clock either, so the pairing below uses
 * host arrival order (start record index -> end record index); `host_wall_ms` is only set when an explicit
 * `hostClockMs` array (same length as `records`, Date.now() at read time) is supplied. Without it the field
 * is absent and only model-reported `wall_ms` is kept. Never compare host and model clocks against each other.
 * @param {any[]} records
 * @param {{ skillName?: string, skillNames?: string[] }} [opts]
 * @param {number} [cap]
 * @param {Array<number | null>} [hostClockMs]
 */
export function normalizeEvents(records, { skillName, skillNames } = /** @type {{ skillName?: string, skillNames?: string[] }} */ ({}), cap = EVENT_CAP, hostClockMs = null) {
  const names = skillNames ?? (skillName != null ? [skillName] : []);
  const events = [];
  const toolSequence = [];
  /** @type {Record<string, { calls: number, errors: number, wall_ms: number, host_wall_ms?: number }>} */
  const toolStats = {};
  /** @type {Record<number, { t: number | null, dur_ms?: number }>} */
  const turnEnds = {};
  /** Per-turn model identity and cost, kept out of `events` so the judge's evidence never changes. */
  const turnMeta = [];
  let turn = 0, tokens = 0, cost = 0, skillLoaded = false, skillLoadedTurn = null;
  let tStart = null, lastTs = null;
  let userTurns = 0, assistantTexts = 0, toolResults = 0, errors = 0, emptyAssistantTurns = 0;
  /** Provider-side refusals (429/5xx after omp's own retries). They are not evidence about the skill. */
  const providerErrors = [];
  const loadsSkill = args => {
    const p = String(args?.path ?? '');
    return names.some(n => (p === `skill://${n}` || p.startsWith(`skill://${n}/`) || p.endsWith(`/${n}/SKILL.md`)));
  };
  const turnOfCall = new Map();
  const startOfCall = new Map();
  const stat = name => (toolStats[name] ??= { calls: 0, errors: 0, wall_ms: 0 });

  for (let i = 0; i < records.length; i++) {
    const e = records[i];
    if (e.type === 'session' && tStart == null && typeof e.timestamp === 'string') {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t)) tStart = t;
    }
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      turn++;
      // An assistant turn with no content at all is the shape a provider failure leaves
      // behind: omp gave up before generating anything.
      if (!(e.message.content ?? []).length) emptyAssistantTurns++;
      if (typeof e.message.timestamp === 'number') lastTs = e.message.timestamp;
      tokens += e.message.usage?.totalTokens ?? 0;
      cost += e.message.usage?.cost?.total ?? 0;
      for (const part of e.message.content ?? []) {
        if (part.type === 'text' && part.text.trim()) {
          assistantTexts++;
          events.push({ turn, t: lastTs, kind: 'assistant_text', ...clip(part.text.trim(), cap) });
        } else if (part.type === 'toolCall') {
          turnOfCall.set(part.id, turn);
          toolSequence.push(part.name);
          stat(part.name).calls++;
          if (part.name === 'read' && !skillLoaded && loadsSkill(part.arguments)) { skillLoaded = true; skillLoadedTurn = turn; }
          const a = clip(JSON.stringify(part.arguments ?? {}), cap);
          events.push({ turn, t: lastTs, kind: 'tool_call', tool: part.name, args: a.text, truncated: a.truncated, raw_chars: a.raw_chars });
        }
      }
    } else if (e.type === 'tool_execution_start') {
      startOfCall.set(e.toolCallId, hostClockMs?.[i] ?? null);
    } else if (e.type === 'tool_execution_end') {
      const text = (e.result?.content ?? []).map(c => c.text ?? '').join('');
      const s = stat(e.toolName ?? 'unknown');
      const wall = e.result?.details?.wallTimeMs;
      if (typeof wall === 'number') s.wall_ms += wall;
      if (e.isError) { s.errors++; errors++; }
      toolResults++;
      const startedAt = startOfCall.get(e.toolCallId);
      const endedAt = hostClockMs?.[i] ?? null;
      const hostWall = (startedAt != null && endedAt != null) ? Math.max(0, endedAt - startedAt) : null;
      if (hostWall != null) s.host_wall_ms = (s.host_wall_ms ?? 0) + hostWall;
      events.push({
        turn: turnOfCall.get(e.toolCallId) ?? turn, t: lastTs, kind: 'tool_result', tool: e.toolName,
        is_error: !!e.isError, ...(typeof wall === 'number' ? { wall_ms: wall } : {}),
        ...(hostWall != null ? { host_wall_ms: hostWall } : {}), ...clip(text, cap),
      });
    } else {
      // User messages, turn_end, and anything else: still harvest the clock for what follows.
      if (e.type === 'message_end' && e.message?.role === 'user') {
        userTurns++;
        // The initial prompt arrives before any assistant turn; a later user message is a
        // scripted followup. Marking it is what makes an ordering step ("did not render
        // before the approval turn") judgeable at all: without a boundary in the transcript,
        // the judge sees one flat sequence and cannot tell which turn the human spoke in.
        const text = (e.message.content ?? []).map(c => c.text ?? '').join('').trim();
        if (turn > 0 && text) {
          events.push({ turn: turn + 1, t: lastTs, kind: 'user_turn', ...clip(text, cap) });
        }
      }
      if (typeof e.message?.timestamp === 'number') lastTs = e.message.timestamp;
      if (e.type === 'turn_end') {
        turnEnds[turn] = { t: lastTs, ...(typeof e.message?.duration === 'number' ? { dur_ms: e.message.duration } : {}) };
        // Who actually served this turn, and what it cost. The transcript carries this per turn
        // but a 4 MB file is not a query surface, and `events` must stay byte-identical for the
        // judge: a new event kind there would silently change every verdict.
        turnMeta.push({
          turn,
          t: lastTs,
          model: e.message?.model ?? null,
          provider: e.message?.provider ?? null,
          response_id: e.message?.responseId ?? null,
          ttft_ms: typeof e.message?.ttft === 'number' ? e.message.ttft : null,
          duration_ms: typeof e.message?.duration === 'number' ? e.message.duration : null,
          stop_reason: e.message?.stopReason ?? null,
          usage: e.message?.usage
            ? {
                input: e.message.usage.input ?? null,
                output: e.message.usage.output ?? null,
                reasoning: e.message.usage.reasoningTokens ?? null,
                cache_read: e.message.usage.cacheRead ?? null,
                cache_write: e.message.usage.cacheWrite ?? null,
                total: e.message.usage.totalTokens ?? null,
              }
            : null,
          cost: e.message?.usage?.cost ?? null,
        });
      }
      // A failed auto-retry means the provider rejected the request; the empty assistant
      // turn that follows is not the model declining to act. Recorded so grading can say
      // "no verdict" instead of scoring a session the provider never ran.
      if (e.type === 'auto_retry_end' && e.success === false && e.finalError) {
        providerErrors.push(String(e.finalError).slice(0, 500));
      }
    }
  }
  return { events, toolSequence, toolStats, turnEnds, turnMeta, tokens, cost, skillLoaded, skillLoadedTurn, turns: turn, tStart, tEnd: lastTs, userTurns, assistantTexts, toolResults, errors, providerErrors, emptyAssistantTurns };
}

/**
 * Read a session folder (transcript.jsonl + scenario.json), write events.json and result.json.
 * partial_tail always lands in `transcript.partial.txt` (empty string when nothing was cut), and
 * `events.full.json` keeps the uncapped timeline on sessions that need diagnosis (timeout, nonzero
 * exit, truncation, or dropped chars); `events.json` stays capped so the judge's input is unchanged.
 * @param {string} dir
 * @param {{ timedOut?: boolean, timeoutKind?: string|null, exitCode?: number|null, durationMs?: number|null, tStart?: string|null, tEnd?: string|null, hostClockMs?: Array<number|null>|null }} [opts]
 */
export function normalizeSession(dir, { timedOut = false, timeoutKind = null, exitCode = null, durationMs = null, tStart = null, tEnd = null, hostClockMs = null } = {}) {
  const scenario = JSON.parse(fs.readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  const raw = readTranscript(dir);
  const { records, partial, dropped_chars } = parseJsonl(raw);
  const n = normalizeEvents(records, { skillName: scenario.skill, skillNames: scenario.skill_names }, undefined, hostClockMs);
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(n.events, null, 2));
  fs.writeFileSync(path.join(dir, 'transcript.partial.txt'), partial);
  // Per-turn model identity, latency and cost: a query surface for "which model served this
  // turn" and "where did the tokens go" that does not need the 4 MB transcript opened.
  fs.writeFileSync(path.join(dir, 'turns.json'), JSON.stringify(n.turnMeta, null, 2));
  const truncated = n.events.some(e => e.truncated);
  const needsFull = timedOut || (exitCode != null && exitCode !== 0) || truncated || dropped_chars > 0;
  if (needsFull) {
    const full = normalizeEvents(records, { skillName: scenario.skill, skillNames: scenario.skill_names }, Number.MAX_SAFE_INTEGER, hostClockMs);
    fs.writeFileSync(path.join(dir, 'events.full.json'), JSON.stringify(full.events, null, 2));
  } else if (fs.existsSync(path.join(dir, 'events.full.json'))) {
    fs.rmSync(path.join(dir, 'events.full.json'));
  }
  const providerRetries = collectProviderRetries(records);
  // The transcript's clock is the container's; host.jsonl's is the host's. The offset between
  // them is what makes "the model was slow" vs "the host stalled" a measurement instead of a
  // guess. Null when either side has no clock.
  const hostStartMs = tStart ? Date.parse(tStart) : null;
  const clockOffsetMs = Number.isFinite(hostStartMs) && typeof n.tStart === 'number' ? hostStartMs - n.tStart : null;
  const result = {
    scenario: scenario.id,
    kind: scenario.kind,
    exit_code: exitCode,
    timeout: timedOut,
    timeout_kind: timeoutKind,
    duration_ms: durationMs,
    t_start: tStart ?? n.tStart,
    t_end: tEnd ?? n.tEnd,
    transcript_chars: raw.length,
    dropped_chars,
    truncated_events: n.events.filter(e => e.truncated).length,
    has_full_events: needsFull,
    tool_stats: n.toolStats,
    turn_ends: n.turnEnds,
    skill_loaded: n.skillLoaded,
    skill_loaded_turn: n.skillLoadedTurn,
    tool_sequence: n.toolSequence,
    turns: n.turns,
    turn_count: n.turns,
    tokens: n.tokens,
    cost: n.cost,
    user_turns: n.userTurns,
    assistant_texts: n.assistantTexts,
    tool_results: n.toolResults,
    errors: n.errors,
    // Provider-side failures: the session was never actually run, so its verdicts mean
    // nothing. Kept in the record so the report can say so instead of blaming the skill.
    provider_errors: n.providerErrors.length ? n.providerErrors : undefined,
    // Provider throttling, recovered or not. A session that was 429'd and rode it out looks
    // like a slow session otherwise.
    provider_retries: providerRetries.count ? providerRetries : undefined,
    clock_offset_ms: clockOffsetMs,
    empty_assistant_turns: n.emptyAssistantTurns,
  };
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

/**
 * Normalize a session folder that was left half-written: a container that was killed with the
 * harness down leaves a transcript and no events.json/result.json, and every aggregate then
 * treats the session as if it never ran. This turns that folder into a normal one.
 * @param {string} dir - a session folder
 * @param {{ timedOut?: boolean, timeoutKind?: string, exitCode?: number|null, durationMs?: number|null, tStart?: string|null, tEnd?: string|null, hostClockMs?: Array<number|null>|null }} [opts]
 */
export function normalizeStrandedSession(dir, opts = {}) {
  const raw = path.join(dir, 'transcript.jsonl');
  const archived = path.join(dir, 'transcript.jsonl.gz');
  if (!fs.existsSync(raw) && !fs.existsSync(archived)) throw new UserError(`${dir} has no transcript.jsonl to normalize`);
  if (!fs.existsSync(path.join(dir, 'scenario.json'))) throw new UserError(`${dir} has no scenario.json; it was never a session folder`);
  return normalizeSession(dir, opts);
}
