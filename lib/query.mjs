/**
 * Historical query layer for auto-diagnosis.
 *
 * Indexes completed runs into a SQLite database (`<evalsDir>/metrics.db`) and
 * provides query functions for finding patterns across runs: failure trends,
 * flaky steps, error classes, and per-scenario pass rates over time.
 *
 * Uses node:sqlite (built into Node 22.5+, stable in 24.x).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sameIssueJudge, SAME_ISSUE_AT } from './findings.mjs';
import { UserError } from './exec.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run TEXT PRIMARY KEY,
  t_start TEXT,
  t_end TEXT,
  skill TEXT,
  skill_kind TEXT,
  skill_hash TEXT,
  scenarios_hash TEXT,
  model TEXT,
  model_alias TEXT,
  omp_version TEXT,
  image_digest TEXT,
  git_sha TEXT,
  seed TEXT,
  timeout INTEGER,
  reps INTEGER,
  sessions INTEGER,
  timeouts INTEGER,
  session_cost REAL,
  total_cost REAL,
  pass_rate REAL,
  aborted_for_cost INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  run TEXT NOT NULL,
  session TEXT NOT NULL,
  scenario TEXT NOT NULL,
  kind TEXT NOT NULL,
  rep INTEGER,
  t_start TEXT,
  t_end TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  timeout INTEGER DEFAULT 0,
  timeout_kind TEXT,
  error_class TEXT,
  skill_loaded INTEGER,
  turns INTEGER,
  tokens INTEGER,
  cost REAL,
  errors INTEGER DEFAULT 0,
  stdout_bytes INTEGER,
  stderr_bytes INTEGER,
  oom_killed INTEGER,
  transcript_chars INTEGER,
  PRIMARY KEY (run, session),
  FOREIGN KEY (run) REFERENCES runs(run)
);

CREATE TABLE IF NOT EXISTS steps (
  run TEXT NOT NULL,
  session TEXT NOT NULL,
  scenario TEXT NOT NULL,
  step_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  p_done REAL,
  p_not_done REAL,
  p_unclear REAL,
  p_attempted_wrong REAL,
  confidence REAL,
  PRIMARY KEY (run, session, step_id),
  FOREIGN KEY (run, session) REFERENCES sessions(run, session)
);

CREATE TABLE IF NOT EXISTS telemetry_summary (
  run TEXT NOT NULL,
  session TEXT NOT NULL,
  model_turns INTEGER,
  tool_calls INTEGER,
  tool_errors INTEGER,
  total_tool_wall_ms INTEGER,
  total_model_duration_ms INTEGER,
  max_memory_mb REAL,
  max_cpu_pct REAL,
  resource_samples INTEGER,
  retries INTEGER,
  PRIMARY KEY (run, session),
  FOREIGN KEY (run) REFERENCES runs(run)
);

-- Provider throttling: the model endpoint refused a request and omp retried it. A recovered
-- retry is the case that used to be invisible, so it is recorded as its own row.
CREATE TABLE IF NOT EXISTS provider_events (
  run TEXT NOT NULL,
  session TEXT NOT NULL,
  scenario TEXT,
  attempt INTEGER,
  max_attempts INTEGER,
  delay_ms INTEGER,
  error TEXT,
  error_id TEXT,
  recovered INTEGER,
  t TEXT
);

-- The findings of a run, as the reporter wrote them: one row per label+step.
CREATE TABLE IF NOT EXISTS findings (
  run TEXT NOT NULL,
  label TEXT,
  step TEXT,
  description TEXT,
  severity TEXT,
  count INTEGER,
  scenarios TEXT,
  PRIMARY KEY (run, label, step)
);

CREATE INDEX IF NOT EXISTS idx_sessions_scenario ON sessions(scenario);
CREATE INDEX IF NOT EXISTS idx_sessions_error_class ON sessions(error_class);
CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run);
CREATE INDEX IF NOT EXISTS idx_steps_step_id ON steps(step_id);
CREATE INDEX IF NOT EXISTS idx_steps_verdict ON steps(verdict);
CREATE INDEX IF NOT EXISTS idx_runs_skill ON runs(skill);
CREATE INDEX IF NOT EXISTS idx_runs_t_start ON runs(t_start);
CREATE INDEX IF NOT EXISTS idx_provider_events_run ON provider_events(run);
CREATE INDEX IF NOT EXISTS idx_provider_events_session ON provider_events(session);
CREATE INDEX IF NOT EXISTS idx_findings_step ON findings(step);
CREATE INDEX IF NOT EXISTS idx_findings_label ON findings(label);
`;

/**
 * Open (or create) the metrics database.
 * @param {string} evalsDir
 * @returns {DatabaseSync}
 */
export function openMetricsDb(evalsDir) {
  // Dot-prefixed: the evals directory holds run folders, and code that enumerates it to find
  // runs must not mistake the database for one.
  const dbPath = path.join(path.resolve(evalsDir), '.metrics.db');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

/**
 * A run record for a run folder that has none: the skill from the snapshot, the model from the
 * session plans, the clock from the sessions that finished. Marked interrupted, because a run
 * without a record is a run whose harness died.
 */
function synthesizedRunRecord(runDir, runName) {
  const sessionDirs = fs.readdirSync(runDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => path.join(runDir, e.name));
  const plans = sessionDirs.map(d => {
    const p = path.join(d, 'session.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  }).filter(Boolean);
  const results = sessionDirs.map(d => {
    const p = path.join(d, 'result.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
  }).filter(Boolean);
  const starts = results.map(r => r.t_start).filter(Boolean).sort();
  const skillFile = path.join(runDir, 'skill', 'SKILL.md');
  const skillName = fs.existsSync(skillFile)
    ? (/^name:\s*(.+)$/m.exec(fs.readFileSync(skillFile, 'utf8'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '') || null
    : null;
  return {
    t_start: starts[0] ?? null,
    t_end: null,
    skill: { name: skillName, kind: null },
    skill_hash: null,
    scenarios_hash: null,
    model: plans[0] ? { model: plans[0].model, alias: plans[0].model_alias } : { model: null, alias: null },
    omp_version: null,
    image_digest: null,
    git_sha: null,
    seed: plans[0]?.seed ?? null,
    limits: { timeout: plans[0]?.timeout ?? null, reps: plans.length ? null : null },
    sessions: results.length,
    timeouts: results.filter(r => r.timeout).length,
    session_cost: results.reduce((a, r) => a + (r.cost ?? 0), 0),
    total_cost: null,
    pass_rate: null,
    aborted_for_cost: false,
    interrupted: true,
  };
}

/**
 * Index a completed run folder into the metrics database.
 * @param {DatabaseSync} db
 * @param {string} runDir
 */
export function indexRun(db, runDir) {
  const runName = path.basename(runDir);
  // A run whose harness died has no run.json. Its sessions still happened, so the run is
  // indexed from what the session folders say, marked as interrupted.
  const runJson = fs.existsSync(path.join(runDir, 'run.json'))
    ? JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'))
    : synthesizedRunRecord(runDir, runName);
  db.prepare(`INSERT OR REPLACE INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    runName,
    runJson.t_start ?? null,
    runJson.t_end ?? null,
    runJson.skill?.name ?? null,
    runJson.skill?.kind ?? null,
    runJson.skill_hash ?? null,
    runJson.scenarios_hash ?? null,
    runJson.model?.model ?? null,
    runJson.model?.alias ?? null,
    runJson.omp_version ?? null,
    runJson.image_digest ?? null,
    runJson.git_sha ?? null,
    runJson.seed ?? null,
    runJson.limits?.timeout ?? null,
    runJson.limits?.reps ?? null,
    runJson.sessions ?? 0,
    runJson.timeouts ?? 0,
    runJson.session_cost ?? 0,
    runJson.total_cost ?? null,
    runJson.pass_rate ?? null,
    runJson.aborted_for_cost ? 1 : 0,
  );

  // Index each session folder
  const entries = fs.readdirSync(runDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sessionDir = path.join(runDir, ent.name);
    const resultPath = path.join(sessionDir, 'result.json');
    if (!fs.existsSync(resultPath)) continue;

    let result;
    try { result = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { continue; }

    db.prepare(`INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runName,
      ent.name,
      result.scenario ?? null,
      result.kind ?? null,
      null, // rep not in result.json directly
      result.t_start ?? null,
      result.t_end ?? null,
      result.duration_ms ?? null,
      result.exit_code ?? null,
      result.timeout ? 1 : 0,
      result.timeout_kind ?? null,
      result.error_class ?? null,
      result.skill_loaded ? 1 : 0,
      result.turns ?? null,
      result.tokens ?? null,
      result.cost ?? 0,
      result.errors ?? 0,
      result.stdout_bytes ?? null,
      result.stderr_bytes ?? null,
      result.oom_killed ? 1 : 0,
      result.transcript_chars ?? null,
    );

    // Index telemetry summary if present
    if (result.telemetry_summary) {
      const ts = result.telemetry_summary;
      db.prepare(`INSERT OR REPLACE INTO telemetry_summary VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        runName,
        ent.name,
        ts.model_turns ?? null,
        ts.tool_calls ?? null,
        ts.tool_errors ?? null,
        ts.total_tool_wall_ms ?? null,
        ts.total_model_duration_ms ?? null,
        ts.max_memory_mb ?? null,
        ts.max_cpu_pct ?? null,
        ts.resource_samples ?? null,
        ts.retries ?? null,
      );
    }

    // Index grading steps if present
    const gradingPath = path.join(sessionDir, 'grading.json');
    if (fs.existsSync(gradingPath)) {
      try {
        const grading = JSON.parse(fs.readFileSync(gradingPath, 'utf8'));
        for (const step of grading.steps ?? []) {
          db.prepare(`INSERT OR REPLACE INTO steps VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
            runName,
            ent.name,
            result.scenario ?? null,
            step.id,
            step.verdict,
            step.p_done ?? null,
            step.p_not_done ?? null,
            step.p_unclear ?? null,
            step.p_attempted_wrong ?? null,
            step.confidence ?? null,
          );
        }
      } catch { /* grading may be partial */ }
    }

    // Index the provider throttling this session went through. A recovered 429 is the case
    // that used to leave no trace at all.
    for (const ev of result.provider_retries?.events ?? []) {
      db.prepare(`INSERT INTO provider_events (run, session, scenario, attempt, max_attempts, delay_ms, error, error_id, recovered, t) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        runName,
        ent.name,
        result.scenario ?? null,
        ev.attempt ?? null,
        ev.max_attempts ?? null,
        ev.delay_ms ?? null,
        ev.error ?? null,
        ev.error_id ?? null,
        ev.recovered === true ? 1 : ev.recovered === false ? 0 : null,
        ev.t ?? null,
      );
    }
  }

  // Index the run's findings: one row per label+step, the unit a recurring failure is counted in.
  const findingsPath = path.join(runDir, 'findings.json');
  if (fs.existsSync(findingsPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
      for (const f of doc.findings ?? []) {
        db.prepare(`INSERT OR REPLACE INTO findings (run, label, step, description, severity, count, scenarios) VALUES (?,?,?,?,?,?,?)`).run(
          runName,
          f.label ?? null,
          f.step ?? null,
          f.description ?? null,
          f.severity ?? null,
          f.count ?? null,
          JSON.stringify(f.scenarios ?? []),
        );
      }
    } catch { /* findings may be partial */ }
  }
}

/**
 * Index all runs in an evals directory.
 * @param {string} evalsDir
 * @returns {{ db: DatabaseSync, indexed: number }}
 */
export function indexAllRuns(evalsDir) {
  const db = openMetricsDb(evalsDir);
  const dir = path.resolve(evalsDir);
  let indexed = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const runDir = path.join(dir, ent.name);
    // A folder without a run.json is a run the harness never finished writing: it is indexed
    // from its session folders rather than skipped, so the history is not missing it.
    if (!fs.existsSync(path.join(runDir, 'run.json')) && !fs.existsSync(path.join(runDir, 'skill')) && !hasSessionFolder(runDir)) continue;
    try {
      indexRun(db, runDir);
      indexed++;
    } catch { /* skip unreadable runs */ }
  }
  return { db, indexed };
}

/** True when a folder holds at least one session folder. */
function hasSessionFolder(runDir) {
  try {
    return fs.readdirSync(runDir, { withFileTypes: true })
      .some(e => e.isDirectory() && fs.existsSync(path.join(runDir, e.name, 'scenario.json')));
  } catch { return false; }
}

/**
 * Query options for common diagnostic questions.
 */

/**
 * Find failing steps across runs (steps that failed in at least minRuns runs).
 * @param {DatabaseSync} db
 * @param {{ stepId?: string, minFailures?: number, since?: string, skill?: string }} [opts]
 */
export function queryFailingSteps(db, { stepId = null, minFailures = 1, since = null, skill = null } = {}) {
  let sql = `
    SELECT step_id, COUNT(DISTINCT s.run) as fail_count, COUNT(*) as total_count,
           AVG(CASE WHEN st.verdict = 'done' THEN 1 ELSE 0 END) as pass_rate
    FROM steps st
    JOIN sessions s ON st.run = s.run AND st.session = s.session
    WHERE st.verdict IN ('wrong', 'skipped')
  `;
  const params = [];
  if (stepId) { sql += ` AND st.step_id = ?`; params.push(stepId); }
  if (since) { sql += ` AND s.t_start >= ?`; params.push(since); }
  if (skill) { sql += ` AND s.run IN (SELECT run FROM runs WHERE skill = ?)`; params.push(skill); }
  sql += ` GROUP BY step_id HAVING fail_count >= ? ORDER BY fail_count DESC, pass_rate ASC`;
  params.push(minFailures);
  return db.prepare(sql).all(...params);
}

/**
 * Find flaky steps: steps that sometimes pass and sometimes fail.
 * @param {DatabaseSync} db
 * @param {{ minRuns?: number, since?: string }} [opts]
 */
export function queryFlakySteps(db, { minRuns = 3, since = null } = {}) {
  let sql = `
    SELECT step_id, COUNT(DISTINCT s.run) as run_count,
           SUM(CASE WHEN st.verdict = 'done' THEN 1 ELSE 0 END) as passes,
           SUM(CASE WHEN st.verdict IN ('wrong', 'skipped') THEN 1 ELSE 0 END) as failures,
           CAST(SUM(CASE WHEN st.verdict = 'done' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as pass_rate
    FROM steps st
    JOIN sessions s ON st.run = s.run AND st.session = s.session
  `;
  const params = [];
  if (since) { sql += ` WHERE s.t_start >= ?`; params.push(since); }
  sql += ` GROUP BY step_id HAVING run_count >= ? AND passes > 0 AND failures > 0 ORDER BY pass_rate ASC`;
  params.push(minRuns);
  return db.prepare(sql).all(...params);
}

/**
 * Get error class distribution.
 * @param {DatabaseSync} db
 * @param {{ since?: string, skill?: string }} [opts]
 */
export function queryErrorClasses(db, { since = null, skill = null } = {}) {
  let sql = `SELECT error_class, COUNT(*) as count FROM sessions WHERE error_class IS NOT NULL`;
  const params = [];
  const conditions = [];
  if (since) { conditions.push(`t_start >= ?`); params.push(since); }
  if (skill) { conditions.push(`run IN (SELECT run FROM runs WHERE skill = ?)`); params.push(skill); }
  if (conditions.length) sql += ` AND ${conditions.join(' AND ')}`;
  sql += ` GROUP BY error_class ORDER BY count DESC`;
  return db.prepare(sql).all(...params);
}

/**
 * Get pass rate trend over time (per run).
 * @param {DatabaseSync} db
 * @param {{ skill?: string, since?: string }} [opts]
 */
export function queryPassRateTrend(db, { skill = null, since = null } = {}) {
  let sql = `
    SELECT s.run, r.t_start, r.skill, s.scenario,
           AVG(CASE WHEN st.verdict = 'done' THEN 1.0 ELSE 0.0 END) as pass_rate,
           COUNT(*) as step_count
    FROM steps st
    JOIN sessions s ON st.run = s.run AND st.session = s.session
    JOIN runs r ON s.run = r.run
  `;
  const params = [];
  const conditions = [];
  if (skill) { conditions.push(`r.skill = ?`); params.push(skill); }
  if (since) { conditions.push(`r.t_start >= ?`); params.push(since); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ` GROUP BY s.run, s.scenario ORDER BY r.t_start ASC`;
  return db.prepare(sql).all(...params);
}

/**
 * Get slow sessions (top N by duration).
 * @param {DatabaseSync} db
 * @param {{ limit?: number, since?: string }} [opts]
 */
export function querySlowSessions(db, { limit = 10, since = null } = {}) {
  let sql = `SELECT run, session, scenario, duration_ms, turns, tokens, error_class, t_start
    FROM sessions WHERE duration_ms IS NOT NULL`;
  const params = [];
  if (since) { sql += ` AND t_start >= ?`; params.push(since); }
  sql += ` ORDER BY duration_ms DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

/**
 * Get resource usage stats (from telemetry summaries).
 * @param {DatabaseSync} db
 * @param {{ since?: string }} [opts]
 */
export function queryResourceUsage(db, { since = null } = {}) {
  let sql = `
    SELECT s.run, s.session, s.scenario,
           ts.max_memory_mb, ts.max_cpu_pct, ts.resource_samples,
           s.duration_ms, s.error_class
    FROM telemetry_summary ts
    JOIN sessions s ON ts.run = s.run AND ts.session = s.session
    WHERE ts.resource_samples > 0
  `;
  const params = [];
  if (since) { sql += ` AND s.t_start >= ?`; params.push(since); }
  sql += ` ORDER BY ts.max_memory_mb DESC`;
  return db.prepare(sql).all(...params);
}

/**
 * List all indexed runs.
 * @param {DatabaseSync} db
 */
export function queryRuns(db) {
  return db.prepare(`SELECT run, t_start, skill, model_alias, sessions, timeouts, pass_rate, total_cost FROM runs ORDER BY t_start DESC`).all();
}

/**
 * The provider throttling across sessions: which sessions were rate-limited, how often, and
 * whether the retries rode it out. A session that was 429'd and recovered looks like a slow
 * session otherwise, and a session whose retries all failed never ran at all.
 * @param {DatabaseSync} db
 * @param {{ since?: string, skill?: string, limit?: number }} [opts]
 */
export function queryProviderErrors(db, { since = null, skill = null, limit = 50 } = {}) {
  let sql = `SELECT pe.run, pe.session, pe.scenario, pe.attempt, pe.delay_ms, pe.error, pe.recovered, s.t_start
    FROM provider_events pe
    LEFT JOIN sessions s ON pe.run = s.run AND pe.session = s.session`;
  const params = [];
  const conditions = [];
  if (since) { conditions.push(`s.t_start >= ?`); params.push(since); }
  if (skill) { conditions.push(`pe.run IN (SELECT run FROM runs WHERE skill = ?)`); params.push(skill); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ` ORDER BY pe.run, pe.session, pe.rowid`;
  const rows = db.prepare(sql).all(...params);
  const bySession = new Map();
  for (const r of rows) {
    const key = `${r.run}|${r.session}`;
    let agg = bySession.get(key);
    if (!agg) {
      agg = { run: r.run, session: r.session, scenario: r.scenario, kind: 'retry', attempts: 0, recovered: 0, fatal: 0, total_delay_ms: 0, first_error: null, last_error: null, t_start: r.t_start };
      bySession.set(key, agg);
    }
    agg.attempts++;
    if (r.recovered === 1) agg.recovered++;
    else if (r.recovered === 0) agg.fatal++;
    agg.total_delay_ms += r.delay_ms ?? 0;
    if (r.error) { if (agg.first_error === null) agg.first_error = r.error; agg.last_error = r.error; }
  }
  const out = [...bySession.values()].map(a => ({ ...a, kind: a.fatal > 0 ? 'fatal' : 'retry' }));
  out.sort((a, b) => (b.t_start ?? '').localeCompare(a.t_start ?? '') || b.attempts - a.attempts);
  return out.slice(0, limit);
}

/**
 * The defects that keep coming back: one issue, seen in several runs.
 *
 * Descriptions are grouped by label+step, then clustered: two descriptions are the same issue
 * when the judge says so (the rule `compare` uses), or when they are identical when no judge
 * is available. A cluster that spans several runs is a defect that survived a fix, not noise.
 * @param {DatabaseSync} db
 * @param {{ skill?: string, since?: string, minRuns?: number, jev?: any }} [opts]
 */
export async function queryRecurringFailures(db, { skill = null, since = null, minRuns = 2, jev = null } = {}) {
  let sql = `SELECT f.run, f.label, f.step, f.description, f.severity, f.count, f.scenarios, r.t_start
    FROM findings f LEFT JOIN runs r ON f.run = r.run`;
  const params = [];
  const conditions = [];
  if (since) { conditions.push(`r.t_start >= ?`); params.push(since); }
  if (skill) { conditions.push(`r.skill = ?`); params.push(skill); }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  const rows = db.prepare(sql).all(...params);
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.label ?? ''}:${r.step ?? ''}`;
    let g = groups.get(key);
    if (!g) { g = { key, label: r.label, step: r.step, descriptions: new Map() }; groups.set(key, g); }
    const desc = r.description ?? '';
    let d = g.descriptions.get(desc);
    if (!d) { d = { description: desc, runs: new Set(), scenarios: new Set(), count: 0 }; g.descriptions.set(desc, d); }
    d.runs.add(r.run);
    d.count += r.count ?? 1;
    for (const s of JSON.parse(r.scenarios ?? '[]')) d.scenarios.add(s);
  }
  const sameIssue = jev ? sameIssueJudge(jev) : null;
  const out = [];
  for (const g of groups.values()) {
    const descs = [...g.descriptions.values()];
    const clusters = [];
    for (const d of descs) {
      let target = null;
      if (sameIssue) {
        for (const c of clusters) {
          if (await sameIssue(c.representative.description, d.description) >= SAME_ISSUE_AT) { target = c; break; }
        }
      } else {
        target = clusters.find(c => c.representative.description === d.description) ?? null;
      }
      if (target) {
        for (const run of d.runs) target.runs.add(run);
        for (const s of d.scenarios) target.scenarios.add(s);
        target.count += d.count;
      } else {
        clusters.push({ representative: d, runs: new Set(d.runs), scenarios: new Set(d.scenarios), count: d.count });
      }
    }
    for (const c of clusters) {
      if (c.runs.size < minRuns) continue;
      out.push({
        key: `${g.key}#${shortHash(c.representative.description)}`,
        label: g.label,
        step: g.step,
        description: c.representative.description,
        runs: [...c.runs].sort(),
        sessions: [],
        occurrences: c.count,
        scenarios: [...c.scenarios].sort(),
      });
    }
  }
  out.sort((a, b) => b.runs.length - a.runs.length || b.occurrences - a.occurrences);
  return out;
}

/** A short, stable hash of a string: cluster keys must not change between runs. */
function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

/**
 * How far the index is behind the runs on disk. A run folder that is not in the database is a
 * run the history cannot answer for, and nothing used to say so.
 * @param {DatabaseSync} db
 * @param {string} evalsDir
 */
export function queryStaleness(db, evalsDir) {
  const dir = path.resolve(evalsDir);
  const onDisk = fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .filter(n => fs.existsSync(path.join(dir, n, 'run.json')) || fs.existsSync(path.join(dir, n, 'skill')) || hasSessionFolder(path.join(dir, n)))
      .sort()
    : [];
  const indexed = new Set(db.prepare('SELECT run FROM runs').all().map(r => r.run));
  const missing = onDisk.filter(n => !indexed.has(n));
  const newestIndexed = db.prepare('SELECT run FROM runs ORDER BY run DESC LIMIT 1').get()?.run ?? null;
  return {
    stale: missing.length > 0,
    runs_missing: missing.length,
    missing_runs: missing,
    newest_run_on_disk: onDisk.length ? onDisk[onDisk.length - 1] : null,
    newest_run_indexed: newestIndexed,
  };
}

/**
 * CLI-friendly query dispatcher.
 * @param {string} evalsDir
 * @param {string} queryType
 * @param {Record<string, any>} opts
 */
export async function runQueryWithMeta(evalsDir, queryType, opts = {}) {
  const { db } = indexAllRuns(evalsDir);
  try {
    const results = await dispatchQuery(db, queryType, opts);
    return { results, stale: queryStaleness(db, evalsDir) };
  } finally {
    db.close();
  }
}

/**
 * The query itself, with the metadata the CLI adds around it.
 * @param {DatabaseSync} db
 * @param {string} queryType
 * @param {Record<string, any>} opts
 */
export async function dispatchQuery(db, queryType, opts = {}) {
  switch (queryType) {
    case 'failing-steps': return queryFailingSteps(db, opts);
    case 'flaky-steps': return queryFlakySteps(db, opts);
    case 'error-classes': return queryErrorClasses(db, opts);
    case 'pass-rate-trend': return queryPassRateTrend(db, opts);
    case 'slow-sessions': return querySlowSessions(db, opts);
    case 'resource-usage': return queryResourceUsage(db, opts);
    case 'runs': return queryRuns(db);
    case 'provider-errors': return queryProviderErrors(db, opts);
    case 'recurring-failures': return queryRecurringFailures(db, opts);
    default: throw new UserError(`unknown query type "${queryType}". Known: failing-steps, flaky-steps, error-classes, pass-rate-trend, slow-sessions, resource-usage, runs, provider-errors, recurring-failures`);
  }
}

/**
 * CLI-friendly query dispatcher.
 * @param {string} evalsDir
 * @param {string} queryType
 * @param {Record<string, any>} opts
 */
export function runQuery(evalsDir, queryType, opts = {}) {
  const { db } = indexAllRuns(evalsDir);
  try {
    switch (queryType) {
      case 'failing-steps': return queryFailingSteps(db, opts);
      case 'flaky-steps': return queryFlakySteps(db, opts);
      case 'error-classes': return queryErrorClasses(db, opts);
      case 'pass-rate-trend': return queryPassRateTrend(db, opts);
      case 'slow-sessions': return querySlowSessions(db, opts);
      case 'resource-usage': return queryResourceUsage(db, opts);
      case 'runs': return queryRuns(db);
      case 'provider-errors': return queryProviderErrors(db, opts);
      default: throw new UserError(`unknown query type "${queryType}". Known: failing-steps, flaky-steps, error-classes, pass-rate-trend, slow-sessions, resource-usage, runs, provider-errors`);
    }
  } finally {
    db.close();
  }
}
