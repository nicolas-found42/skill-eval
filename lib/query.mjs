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
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { UserError } from './exec.mjs';
import { SAME_ISSUE_AT, sameIssueJudge } from './findings.mjs';

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
  FOREIGN KEY (run, session) REFERENCES sessions(run, session)
);

CREATE TABLE IF NOT EXISTS provider_events (
  run TEXT NOT NULL, session TEXT NOT NULL, scenario TEXT,
  attempt INTEGER, max_attempts INTEGER, delay_ms INTEGER,
  error TEXT, error_id TEXT, recovered INTEGER, t TEXT,
  PRIMARY KEY (run, session, attempt, recovered)
);

CREATE TABLE IF NOT EXISTS findings (
  run TEXT NOT NULL, label TEXT, step TEXT, description TEXT, severity TEXT,
  count INTEGER, scenarios TEXT, PRIMARY KEY (run, label, step)
);

CREATE INDEX IF NOT EXISTS idx_provider_events_run ON provider_events(run);
CREATE INDEX IF NOT EXISTS idx_provider_events_scenario ON provider_events(scenario);
CREATE INDEX IF NOT EXISTS idx_findings_step ON findings(step);
CREATE INDEX IF NOT EXISTS idx_findings_label ON findings(label);
CREATE INDEX IF NOT EXISTS idx_sessions_scenario ON sessions(scenario);
CREATE INDEX IF NOT EXISTS idx_sessions_error_class ON sessions(error_class);
CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run);
CREATE INDEX IF NOT EXISTS idx_steps_step_id ON steps(step_id);
CREATE INDEX IF NOT EXISTS idx_steps_verdict ON steps(verdict);
CREATE INDEX IF NOT EXISTS idx_runs_skill ON runs(skill);
CREATE INDEX IF NOT EXISTS idx_runs_t_start ON runs(t_start);
`;

/**
 * Open (or create) the metrics database.
 * @param {string} evalsDir
 * @returns {DatabaseSync}
 */
export function openMetricsDb(evalsDir) {
  // Dot-prefixed: the evals dir also holds run folders, and a plain `metrics.db` file there
  // looks like a run folder to every code path that enumerates the directory.
  const dbPath = path.join(path.resolve(evalsDir), '.metrics.db');
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

/**
 * Index a completed run folder into the metrics database.
 * @param {DatabaseSync} db
 * @param {string} runDir
 */
export function indexRun(db, runDir) {
  const runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8'));
  const runName = path.basename(runDir);
  // Re-indexing a run must not leave rows of a previous state behind (a finding that was
  // fixed, a provider event that disappeared): drop the run's rows first.
  db.prepare(`DELETE FROM provider_events WHERE run = ?`).run(runName);
  db.prepare(`DELETE FROM findings WHERE run = ?`).run(runName);
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

    // Index provider retry events if present. `recovered: true` means the provider retried
    // and then succeeded; `recovered: false` means the request finally failed.
    const retries = result.provider_retries;
    if (retries && Array.isArray(retries.events)) {
      retries.events.forEach((ev, i) => {
        db.prepare(`INSERT OR REPLACE INTO provider_events
          (run, session, scenario, attempt, max_attempts, delay_ms, error, error_id, recovered, t)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          runName,
          ent.name,
          result.scenario ?? null,
          ev.attempt ?? i,
          ev.max_attempts ?? null,
          ev.delay_ms ?? null,
          ev.error ?? null,
          ev.error_id ?? null,
          ev.recovered ? 1 : 0,
          ev.t ?? null,
        );
      });
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
  }

  // Index the merged findings of the run (findings.json at the run root).
  const findingsPath = path.join(runDir, 'findings.json');
  if (fs.existsSync(findingsPath)) {
    try {
      const doc = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
      for (const f of doc.findings ?? []) {
        db.prepare(`INSERT OR REPLACE INTO findings
          (run, label, step, description, severity, count, scenarios)
          VALUES (?,?,?,?,?,?,?)`).run(
          runName,
          // SQLite treats NULL primary-key columns as distinct, so a missing label/step
          // would never be replaced and every re-index would duplicate the row.
          f.label ?? '',
          f.step ?? '',
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
    if (!fs.existsSync(path.join(runDir, 'run.json'))) continue;
    try {
      indexRun(db, runDir);
      indexed++;
    } catch { /* skip unreadable runs */ }
  }
  return { db, indexed };
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

/** Shorten an error string so a long provider stack trace cannot flood a report. */
const truncate = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) : s ?? null);

/** Lowercase, dash-separated form of a label or step, for use in a cluster key. */
const slug = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Short stable hash of a cluster's representative description. */
const shortHash = s => crypto.createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 8);

/** Parse a stored JSON list column; a corrupt value is an empty list, not a crash. */
const parseList = v => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
};

/** Directory entries of a directory that may not exist. */
const safeEntries = dir => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

/**
 * Provider retries and failures, one row per session that had any.
 *
 * A row is `fatal` when at least one provider event was not recovered (the request finally
 * failed); otherwise it is `retry` (the provider recovered after retrying).
 * @param {DatabaseSync} db
 * @param {{ since?: string, skill?: string, limit?: number }} [opts]
 */
export function queryProviderErrors(db, { since = null, skill = null, limit = 50 } = {}) {
  // The first/last error of a session are read with window functions: inside a session the
  // order of the events is the attempt order, not the order the rows were written.
  const sql = `
    WITH ev AS (
      SELECT pe.run, pe.session, pe.scenario, pe.attempt, pe.delay_ms, pe.error, pe.recovered, pe.t,
        ROW_NUMBER() OVER (PARTITION BY pe.run, pe.session ORDER BY (pe.attempt IS NULL), pe.attempt, pe.t) AS rn_first,
        ROW_NUMBER() OVER (PARTITION BY pe.run, pe.session ORDER BY (pe.attempt IS NULL), pe.attempt DESC, pe.t DESC) AS rn_last
      FROM provider_events pe
    ),
    agg AS (
      SELECT e.run, e.session,
        COUNT(*) AS attempts,
        SUM(CASE WHEN e.recovered = 1 THEN 1 ELSE 0 END) AS recovered,
        SUM(CASE WHEN e.recovered = 0 THEN 1 ELSE 0 END) AS fatal,
        SUM(COALESCE(e.delay_ms, 0)) AS total_delay_ms,
        MAX(CASE WHEN e.rn_first = 1 THEN e.error END) AS first_error,
        MAX(CASE WHEN e.rn_last = 1 THEN e.error END) AS last_error,
        MAX(e.t) AS last_event_t,
        MIN(e.scenario) AS event_scenario
      FROM ev e
      GROUP BY e.run, e.session
    )
    SELECT a.run, a.session,
      COALESCE(s.scenario, a.event_scenario) AS scenario,
      CASE WHEN a.fatal > 0 THEN 'fatal' ELSE 'retry' END AS kind,
      a.attempts, a.recovered, a.fatal, a.total_delay_ms,
      a.first_error, a.last_error,
      COALESCE(s.t_start, a.last_event_t, r.t_start) AS t_start
    FROM agg a
    LEFT JOIN sessions s ON s.run = a.run AND s.session = a.session
    LEFT JOIN runs r ON r.run = a.run
    WHERE a.attempts > 0
  `;
  const params = [];
  if (since) { sql += ` AND COALESCE(s.t_start, a.last_event_t, r.t_start) >= ?`; params.push(since); }
  if (skill) { sql += ` AND a.run IN (SELECT run FROM runs WHERE skill = ?)`; params.push(skill); }
  sql += ` ORDER BY t_start DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params).map(row => ({
    ...row,
    first_error: truncate(row.first_error, 200),
    last_error: truncate(row.last_error, 200),
  }));
}

/** The failing findings of the indexed runs, grouped by (label, step). */
function groupedFindings(db, { skill, since }) {
  let sql = `
    SELECT f.run AS run, f.label AS label, f.step AS step, f.description AS description,
           f.count AS count, f.scenarios AS scenarios, r.t_start AS t_start
    FROM findings f
    LEFT JOIN runs r ON r.run = f.run
    WHERE (LOWER(COALESCE(f.severity, '')) = 'high' OR (f.step IS NOT NULL AND f.step <> ''))
  `;
  const params = [];
  if (skill) { sql += ` AND r.skill = ?`; params.push(skill); }
  if (since) { sql += ` AND r.t_start >= ?`; params.push(since); }
  sql += ` ORDER BY f.run, f.label, f.step`;
  const rows = db.prepare(sql).all(...params);

  // Same label + same step: only those findings are comparable to each other, anything
  // else would merge unrelated defects.
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.label}\u0000${row.step}`;
    if (!groups.has(key)) groups.set(key, { label: row.label, step: row.step, rows: [] });
    groups.get(key).rows.push(row);
  }
  return groups;
}

/** The distinct descriptions of a group, most frequent first. */
function distinctDescriptions(rows) {
  const byDescription = new Map();
  for (const row of rows) {
    const d = row.description ?? '';
    if (!byDescription.has(d)) byDescription.set(d, []);
    byDescription.get(d).push(row);
  }
  return [...byDescription.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/** Cluster the descriptions of one group by exact description equality (offline fallback). */
function clusterByExactMatch(descriptions) {
  return descriptions.map(([description, rows]) => ({ representative: description, rows: [...rows] }));
}

/**
 * Cluster the descriptions of one group with the judge.
 *
 * Greedy against the cluster representatives: a description joins the first cluster whose
 * representative it matches, so the number of judge calls stays proportional to the number
 * of descriptions instead of the number of pairs.
 */
async function clusterByJudge(descriptions, jev) {
  const same = sameIssueJudge(jev);
  const clusters = [];
  for (const [description, rows] of descriptions) {
    let target = null;
    for (const c of clusters) {
      if (await same(c.representative, description) >= SAME_ISSUE_AT) { target = c; break; }
    }
    if (target) target.rows.push(...rows);
    else clusters.push({ representative: description, rows: [...rows] });
  }
  return clusters;
}

/** The sessions of a run whose scenario the finding names. */
function sessionsOfFinding(db, finding) {
  const mentioned = parseList(finding.scenarios);
  const rows = db.prepare(`SELECT session, scenario FROM sessions WHERE run = ?`).all(finding.run);
  if (!mentioned.length) return rows.map(r => r.session);
  const wanted = new Set(mentioned);
  return rows.filter(r => wanted.has(r.scenario)).map(r => r.session);
}

/**
 * Recurring failures: one defect that shows up in at least `minRuns` distinct runs.
 *
 * The distinct descriptions of a (label, step) group are clustered with the same judge the
 * rest of the harness uses (`SAME_ISSUE_AT`), so a reworded description lands in the
 * cluster of the defect it describes. Without a judge the clustering falls back to exact
 * description matching and stays offline.
 *
 * Returns the clusters directly when no judge is given and a promise of them when a judge
 * is used, because judge calls are remote. Awaiting the result works in both cases.
 * @param {DatabaseSync} db
 * @param {{ skill?: string, since?: string, minRuns?: number, jev?: any }} [opts]
 * @returns {Array<{ key: string, step: string, label: string, description: string, runs: string[], sessions: string[], occurrences: number, scenarios: string[] }>|Promise<Array<{ key: string, step: string, label: string, description: string, runs: string[], sessions: string[], occurrences: number, scenarios: string[] }>>}
 */
export function queryRecurringFailures(db, { skill = null, since = null, minRuns = 2, jev = null } = {}) {
  const groups = groupedFindings(db, { skill, since });
  if (!groups.size) return jev ? Promise.resolve([]) : [];

  const build = clustersPerGroup => {
    const out = [];
    for (const [group, clusters] of clustersPerGroup) {
      for (const cluster of clusters) {
        const runs = [...new Set(cluster.rows.map(r => r.run))];
        if (runs.length < minRuns) continue;
        const scenarios = [...new Set(cluster.rows.flatMap(r => parseList(r.scenarios)))].sort();
        const sessions = [...new Set(cluster.rows.flatMap(r => sessionsOfFinding(db, r)))].sort();
        out.push({
          key: `${slug(group.label) || 'none'}:${slug(group.step) || 'none'}-${shortHash(cluster.representative)}`,
          step: group.step || null,
          label: group.label || null,
          description: cluster.representative,
          runs: runs.sort(),
          sessions,
          occurrences: cluster.rows.reduce((sum, r) => sum + (Number.isFinite(Number(r.count)) && Number(r.count) > 0 ? Number(r.count) : 1), 0),
          scenarios,
        });
      }
    }
    out.sort((a, b) => b.occurrences - a.occurrences || b.runs.length - a.runs.length);
    return out;
  };

  if (!jev) {
    return build(new Map([...groups].map(([group, g]) => [group, clusterByExactMatch(distinctDescriptions(g.rows))])));
  }

  // One judge pass per group, then the same assembly the offline path uses.
  return (async () => {
    const clustersPerGroup = new Map();
    for (const [group, g] of groups) {
      clustersPerGroup.set(group, await clusterByJudge(distinctDescriptions(g.rows), jev));
    }
    return build(clustersPerGroup);
  })();
}

/**
 * How far the metrics database lags behind the runs on disk.
 * @param {DatabaseSync} db
 * @param {string} evalsDir
 */
export function queryStaleness(db, evalsDir) {
  const dir = path.resolve(evalsDir);
  const onDisk = [];
  for (const ent of safeEntries(dir)) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const runDir = path.join(dir, ent.name);
    if (!fs.existsSync(path.join(runDir, 'run.json'))) continue;
    let tStart = null;
    try { tStart = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf8')).t_start ?? null; } catch { /* unreadable run.json */ }
    onDisk.push({ name: ent.name, when: tStart ?? null, mtime: fs.statSync(runDir).mtimeMs });
  }
  const indexed = db.prepare(`SELECT run, t_start FROM runs`).all().map(r => ({ name: r.run, when: r.t_start ?? null }));
  const indexedNames = new Set(indexed.map(r => r.name));
  const missing = onDisk.filter(r => !indexedNames.has(r.name));
  // The folder name carries the run stamp, so the name orders the runs even when a
  // run.json has no readable timestamp.
  const newest = rows => rows.slice().sort((a, b) => String(b.when ?? '').localeCompare(String(a.when ?? '')) || b.name.localeCompare(a.name))[0]?.name ?? null;
  return {
    stale: missing.length > 0,
    runs_missing: missing.length,
    newest_run_on_disk: newest(onDisk),
    newest_run_indexed: newest(indexed),
  };
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
      default: throw new UserError(`unknown query type "${queryType}". Known: failing-steps, flaky-steps, error-classes, pass-rate-trend, slow-sessions, resource-usage, runs`);
    }
  } finally {
    db.close();
  }
}
