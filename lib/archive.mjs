import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { UserError } from './exec.mjs';

/**
 * Compressing a session's transcript. The transcript is the ground truth of what the agent did,
 * and it is by far the biggest thing in a run folder: a 97-second session produced 4.2 MB,
 * mostly streaming deltas. Gzip takes that to a few hundred KB.
 *
 * The raw file is removed only after the compressed copy is written, and every reader
 * (`normalize`, `diagnose`) reads both, so an archived session stays recoverable.
 */
export function gzipTranscript(dir) {
  const raw = path.join(dir, 'transcript.jsonl');
  const gz = path.join(dir, 'transcript.jsonl.gz');
  if (!fs.existsSync(raw)) return null;
  const before = fs.statSync(raw).size;
  if (fs.existsSync(gz)) {
    // Already archived: drop the raw copy, the compressed one is the same transcript.
    fs.rmSync(raw);
    return { dir, before, after: fs.statSync(gz).size, already: true };
  }
  const out = zlib.gzipSync(fs.readFileSync(raw));
  fs.writeFileSync(gz, out);
  fs.rmSync(raw);
  return { dir, before, after: out.length, already: false };
}

/** The run folders in an evals directory, oldest first. Folder names start with a timestamp. */
export function runFolders(evalsDir) {
  const dir = path.resolve(evalsDir);
  if (!fs.existsSync(dir)) throw new UserError(`${evalsDir} does not exist`);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => path.join(dir, e.name))
    .filter(d => isRunFolder(d))
    .sort();
}

/** A run folder holds a run record, a skill snapshot, or session folders. Anything else is not a run. */
function isRunFolder(dir) {
  if (fs.existsSync(path.join(dir, 'run.json')) || fs.existsSync(path.join(dir, 'skill'))) return true;
  return fs.readdirSync(dir, { withFileTypes: true })
    .some(e => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'scenario.json')));
}

/**
 * Archive every session transcript of every run except the newest `keep` runs.
 *
 * The newest runs stay raw because they are the ones being worked on: a diagnosis that needs the
 * transcript should not need a decompression step, and the live TUI reads them directly.
 */
export function archiveRuns(evalsDir, { keep = 3 } = {}) {
  const folders = runFolders(evalsDir);
  const stale = folders.slice(0, Math.max(0, folders.length - keep));
  const archived = [];
  for (const runDir of stale) {
    for (const ent of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const r = gzipTranscript(path.join(runDir, ent.name));
      if (r) archived.push({ run: path.basename(runDir), session: ent.name, ...r });
    }
  }
  const before = archived.reduce((a, r) => a + r.before, 0);
  const after = archived.reduce((a, r) => a + r.after, 0);
  return {
    runs_total: folders.length,
    runs_archived: stale.length,
    runs_kept: folders.length - stale.length,
    sessions: archived.length,
    bytes_before: before,
    bytes_after: after,
    archived,
  };
}
