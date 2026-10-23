/**
 * Structured telemetry for auto-diagnosis.
 *
 * Every session writes `telemetry.jsonl`: one JSON object per line, capturing
 * model requests, tool execution, resource samples, errors, and retries.
 * This is the primary data source for diagnosing intermittent and historical issues.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * A telemetry writer that appends events to a JSONL file.
 * Events are flushed immediately so a killed container never loses the last event.
 */
export class TelemetryWriter {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    this.fd = null;
    try {
      this.fd = fs.openSync(filePath, 'a');
    } catch {
      // Directory may not exist yet; will retry on first write
    }
  }

  /**
   * Emit a telemetry event.
   * @param {string} event - event type (model_request_start, tool_start, resource_sample, error, retry, etc.)
   * @param {Record<string, any>} [data] - event payload
   */
  emit(event, data = {}) {
    const record = {
      t: new Date().toISOString(),
      event,
      ...data,
    };
    this.events.push(record);
    this._flush(record);
  }

  _flush(record) {
    try {
      if (!this.fd) this.fd = fs.openSync(this.filePath, 'a');
      fs.writeSync(this.fd, JSON.stringify(record) + '\n');
    } catch {
      // Telemetry is best-effort; never fail the session for a logging error
    }
  }

  /** Close the file descriptor. */
  close() {
    if (this.fd) {
      try { fs.closeSync(this.fd); } catch { /* already closed */ }
      this.fd = null;
    }
  }

  /** Read all events from the telemetry file. */
  static read(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim())
      .flatMap(l => {
        try { return [JSON.parse(l)]; } catch { return []; }
      });
  }
}

/**
 * Event type constants for consistency across the codebase.
 */
export const TELEMETRY_EVENTS = {
  // Session lifecycle
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  SESSION_SKIPPED: 'session_skipped',

  // Container lifecycle
  CONTAINER_START: 'container_start',
  CONTAINER_END: 'container_end',
  CONTAINER_KILL: 'container_kill',
  NO_OUTPUT: 'no_output',

  // Model API (from omp transcript)
  MODEL_REQUEST_START: 'model_request_start',
  MODEL_REQUEST_END: 'model_request_end',
  MODEL_REQUEST_ERROR: 'model_request_error',
  MODEL_TURN_END: 'model_turn_end',

  // Tool execution
  TOOL_START: 'tool_start',
  TOOL_END: 'tool_end',
  TOOL_ERROR: 'tool_error',

  // Resource monitoring
  RESOURCE_SAMPLE: 'resource_sample',

  // Grading
  GRADE_START: 'grade_start',
  GRADE_STEP: 'grade_step',
  GRADE_END: 'grade_end',
  JEV_REQUEST: 'jev_request',
  JEV_RETRY: 'jev_retry',
  JEV_ERROR: 'jev_error',

  // Retry logic
  RETRY_ATTEMPT: 'retry_attempt',
  RETRY_EXHAUSTED: 'retry_exhausted',

  // Provider-side throttling: the model endpoint refused a request and omp retried it.
  // Recorded whether or not the retry worked — a recovered 429 is invisible otherwise.
  PROVIDER_RETRY: 'provider_retry',

  // Errors
  ERROR: 'error',
  WARNING: 'warning',
};

/**
 * Parse omp transcript events into telemetry events.
 * Extracts model request timing, tool execution, and error information.
 * @param {any[]} records - raw omp JSONL records
 * @param {TelemetryWriter} [writer]
 */
export function extractTelemetryFromTranscript(records, writer = null) {
  const ex = createTelemetryExtractor(writer);
  for (const r of records) ex.record(r);
  return ex.events;
}

/**
 * An extractor that can be fed one transcript record at a time, so telemetry can be written while
 * the container is still running. A session that dies mid-flight keeps everything it had reached;
 * the post-session pass only has to feed the records that never made it through the live path.
 * @param {TelemetryWriter} [writer]
 */
export function createTelemetryExtractor(writer = null) {
  const events = [];
  let turn = 0;
  let lastTs = null;
  const toolStarts = new Map();
  let processed = 0;

  const emit = ev => {
    events.push(ev);
    // The extractor's `t` is the container's clock; the writer's is the host's. Strip the
    // container clock here so the writer's timestamp survives: every telemetry event stays
    // time-correlatable with host.jsonl instead of losing `t` to a JSON.stringify(undefined).
    const { t, ...rest } = ev;
    writer?.emit(ev.event, rest);
  };

  return {
    events,
    /** How many records have been fed so far; the caller uses it to avoid replaying. */
    get processed() { return processed; },
    record(e) {
      processed++;
      // Track turn numbers
      if (e.type === 'turn_start' || e.type === 'user_message') {
        if (e.type === 'turn_start') turn++;
      }

      // Track timestamps
      if (typeof e.message?.timestamp === 'number') lastTs = e.message.timestamp;
      if (typeof e.timestamp === 'string') lastTs = Date.parse(e.timestamp);

      // Model request end (turn_end has duration)
      if (e.type === 'turn_end') {
        emit({
          event: TELEMETRY_EVENTS.MODEL_TURN_END,
          turn,
          t: lastTs,
          duration_ms: typeof e.message?.duration === 'number' ? e.message.duration : null,
          tokens: e.message?.usage?.totalTokens ?? null,
          cost: e.message?.usage?.cost?.total ?? null,
        });
      }

      // Tool execution start
      if (e.type === 'tool_execution_start') {
        const key = `${e.tool_name ?? 'unknown'}-${turn}`;
        toolStarts.set(key, { t: lastTs, turn, tool: e.tool_name });
      }

      // Tool execution end
      if (e.type === 'tool_execution_end') {
        const key = `${e.tool_name ?? 'unknown'}-${turn}`;
        const start = toolStarts.get(key);
        const wallMs = typeof e.result?.details?.wallTimeMs === 'number' ? e.result.details.wallTimeMs : null;
        const isError = !!e.isError;
        emit({
          event: isError ? TELEMETRY_EVENTS.TOOL_ERROR : TELEMETRY_EVENTS.TOOL_END,
          turn,
          tool: e.tool_name,
          t: lastTs,
          wall_ms: wallMs,
          // No host_wall_ms here: `t` is the container's clock, so lastTs - start.t measures
          // container time, not host time, and labeled it as host time it misreported 0 ms
          // spans. Host-measured tool spans live in events.json (hostClockMs), where the
          // clock is actually the host's.
          is_error: isError,
          error: isError ? (e.result?.details?.error ?? e.result?.output?.slice(0, 500) ?? null) : null,
        });
      }

      // Assistant text (model output)
      if (e.type === 'assistant_message' && e.message?.content) {
        for (const part of Array.isArray(e.message.content) ? e.message.content : []) {
          if (part.type === 'text' && part.text) {
            emit({
              event: TELEMETRY_EVENTS.MODEL_REQUEST_END,
              turn,
              t: lastTs,
              text_chars: part.text.length,
              tokens: e.message?.usage?.totalTokens ?? null,
            });
          }
        }
      }

      // Provider throttling: omp's own retry loop around a refused request. Both halves are
      // recorded, because the recovered case (a 429 that the retry rode out) is the one that
      // was invisible: the session looked slow for no visible reason.
      if (e.type === 'auto_retry_start') {
        emit({
          event: TELEMETRY_EVENTS.PROVIDER_RETRY,
          phase: 'start',
          turn,
          t: lastTs,
          attempt: e.attempt ?? null,
          max_attempts: e.maxAttempts ?? null,
          delay_ms: typeof e.delayMs === 'number' ? Math.round(e.delayMs) : null,
          error: e.errorMessage ? String(e.errorMessage).slice(0, 200) : null,
          error_id: e.errorId ?? null,
          recovered: null,
        });
      }
      if (e.type === 'auto_retry_end') {
        emit({
          event: TELEMETRY_EVENTS.PROVIDER_RETRY,
          phase: 'end',
          turn,
          t: lastTs,
          attempt: e.attempt ?? null,
          error: e.finalError ? String(e.finalError).slice(0, 200) : null,
          recovered: e.success !== false,
        });
      }
    },
  };
}

/**
 * The provider retries a session went through, paired and summarized.
 *
 * omp writes an `auto_retry_start` when it decides to retry and an `auto_retry_end` when the
 * loop ends; the end record says whether it worked. A start with no end means the harness
 * stopped the session mid-retry, which is a different thing from a clean failure and is
 * reported as `recovered: null`.
 * @param {any[]} records - raw omp JSONL records
 * @param {{ limit?: number }} [opts] - how many events to keep (newest last)
 */
export function collectProviderRetries(records, { limit = 50 } = {}) {
  const pending = [];
  const out = [];
  for (const e of records) {
    if (e.type === 'auto_retry_start') {
      pending.push({
        attempt: e.attempt ?? null,
        max_attempts: e.maxAttempts ?? null,
        delay_ms: typeof e.delayMs === 'number' ? Math.round(e.delayMs) : null,
        error: e.errorMessage ? String(e.errorMessage).slice(0, 200) : null,
        error_id: e.errorId ?? null,
        recovered: null,
      });
    } else if (e.type === 'auto_retry_end') {
      const open = pending.shift();
      const recovered = e.success !== false;
      if (open) {
        open.recovered = recovered;
        if (e.finalError) open.error = String(e.finalError).slice(0, 200);
        out.push(open);
      } else {
        out.push({ attempt: e.attempt ?? null, max_attempts: null, delay_ms: null, error: e.finalError ? String(e.finalError).slice(0, 200) : null, error_id: null, recovered });
      }
    }
  }
  // A retry still open when the session ended: the harness stopped the session mid-retry.
  for (const open of pending) out.push(open);
  const events = out.slice(-limit);
  return {
    count: out.length,
    recovered: out.filter(e => e.recovered === true).length,
    total_delay_ms: out.reduce((a, e) => a + (e.delay_ms ?? 0), 0),
    events,
  };
}

/**
 * Summarize telemetry events into aggregate statistics.
 * @param {any[]} events
 */
export function summarizeTelemetry(events) {
  const summary = {
    total_events: events.length,
    model_turns: 0,
    tool_calls: 0,
    tool_errors: 0,
    total_tool_wall_ms: 0,
    total_model_duration_ms: 0,
    total_tokens: 0,
    total_cost: 0,
    resource_samples: 0,
    max_memory_mb: 0,
    max_cpu_pct: 0,
    retries: 0,
    provider_retries: 0,
    provider_retries_recovered: 0,
    provider_retry_delay_ms: 0,
    errors: [],
  };

  for (const e of events) {
    switch (e.event) {
      case TELEMETRY_EVENTS.MODEL_TURN_END:
        summary.model_turns++;
        if (typeof e.duration_ms === 'number') summary.total_model_duration_ms += e.duration_ms;
        if (typeof e.tokens === 'number') summary.total_tokens += e.tokens;
        if (typeof e.cost === 'number') summary.total_cost += e.cost;
        break;
      case TELEMETRY_EVENTS.TOOL_END:
        summary.tool_calls++;
        if (typeof e.wall_ms === 'number') summary.total_tool_wall_ms += e.wall_ms;
        break;
      case TELEMETRY_EVENTS.TOOL_ERROR:
        summary.tool_errors++;
        if (e.error) summary.errors.push({ turn: e.turn, tool: e.tool, error: String(e.error).slice(0, 200) });
        break;
      case TELEMETRY_EVENTS.RESOURCE_SAMPLE:
        summary.resource_samples++;
        if (typeof e.mem_mb === 'number') summary.max_memory_mb = Math.max(summary.max_memory_mb, e.mem_mb);
        if (typeof e.cpu_pct === 'number') summary.max_cpu_pct = Math.max(summary.max_cpu_pct, e.cpu_pct);
        break;
      case TELEMETRY_EVENTS.RETRY_ATTEMPT:
        summary.retries++;
        break;
      case TELEMETRY_EVENTS.PROVIDER_RETRY:
        if (e.phase === 'start') {
          summary.provider_retries++;
          if (typeof e.delay_ms === 'number') summary.provider_retry_delay_ms += e.delay_ms;
        } else if (e.recovered === true) {
          summary.provider_retries_recovered++;
        }
        break;
    }
  }

  return summary;
}
