import { TelemetryWriter, TELEMETRY_EVENTS } from './telemetry.mjs';

import { UserError } from './exec.mjs';

export const JEV_MODEL = 'typesafe/jev-1.14';
export const JEV_URL = 'https://openrouter.ai/api/v1/systemone';
/** The one host-side key: grading only, never passed into a container. */
export const GRADING_KEY = 'OPENROUTER_API_KEY';

export function requireGradingKey(env = process.env) {
  if (!env[GRADING_KEY]) throw new UserError(`${GRADING_KEY} is not set. It is required for grading (TypeSafe Jev via OpenRouter); the run never emits ungraded results.`);
}

/**
 * Thin client for the TypeSafe System One API through OpenRouter. The judge model is pinned.
 * Tracks cost and call count so a run can report what grading spent.
 */
export class Jev {
  /** @param {{ key?: string, fetchImpl?: typeof fetch, retries?: number, telemetry?: TelemetryWriter|null }} [opts] */
  constructor({ key = process.env.OPENROUTER_API_KEY, fetchImpl = fetch, retries = 2, telemetry = null } = {}) {
    requireGradingKey({ [GRADING_KEY]: key });
    this.key = key;
    this.fetch = fetchImpl;
    this.retries = retries;
    this.telemetry = telemetry;
    this.model = JEV_MODEL;
    this.cost = 0;
    this.calls = 0;
    this.snapshots = new Set();
  }

  /** A fresh client with this one's key, transport and retry policy but its own cost/call counters (for concurrent work). */
  fork() {
    return new Jev({ key: this.key, fetchImpl: this.fetch, retries: this.retries, telemetry: this.telemetry });
  }

  /**
   * One System One request: a state and a map of typed questions. Returns the `answers` map.
   * @param {unknown} state
   * @param {Record<string, any>} questions
   */
  async ask(state, questions) {
    const body = JSON.stringify({ model: this.model, state, questions });
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      this.telemetry?.emit(TELEMETRY_EVENTS.JEV_REQUEST, {
        attempt: attempt + 1,
        request_bytes: body.length,
        question_count: Object.keys(questions).length,
      });
      const r = await this.fetch(JEV_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
        body,
      });
      const latencyMs = Date.now() - t0;
      const text = await r.text();
      if (r.ok) {
        const j = JSON.parse(text);
        this.calls++;
        this.cost += j.usage?.cost ?? 0;
        if (j.model) this.snapshots.add(j.model);
        this.telemetry?.emit(TELEMETRY_EVENTS.JEV_REQUEST, {
          attempt: attempt + 1,
          status: r.status,
          latency_ms: latencyMs,
          response_bytes: text.length,
          cost: j.usage?.cost ?? 0,
          success: true,
        });
        for (const id of Object.keys(questions)) {
          if (!j.answers?.[id]) throw new UserError(`Jev returned no answer for question "${id}" (invalid response); refusing to treat it as a pass.`);
        }
        return j.answers;
      }
      this.telemetry?.emit(TELEMETRY_EVENTS.JEV_ERROR, {
        attempt: attempt + 1,
        status: r.status,
        latency_ms: latencyMs,
        response_bytes: text.length,
        error: text.slice(0, 500),
      });
      const retryable = r.status === 429 || r.status >= 500;
      if (!retryable || attempt >= this.retries) {
        if (r.status === 401 || r.status === 403) throw new UserError(`OpenRouter rejected OPENROUTER_API_KEY (HTTP ${r.status}).`);
        throw new UserError(`Jev request failed: HTTP ${r.status} ${text.slice(0, 300)}`);
      }
      const backoffMs = 1000 * (attempt + 1);
      this.telemetry?.emit(TELEMETRY_EVENTS.JEV_RETRY, {
        attempt: attempt + 1,
        status: r.status,
        backoff_ms: backoffMs,
      });
      await new Promise(res => setTimeout(res, backoffMs));
    }
  }

  /** One Noul question over a state: probability the statement holds. */
  async noul(state, instructions, criteria) {
    const a = await this.ask(state, { q: { type: 'noul', instructions, criteria } });
    return a.q.noul;
  }
}
