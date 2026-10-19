import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE_BIN = path.join(ROOT, 'test', 'fake-bin');

export function tmpdir(prefix = 'skill-eval-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
/** Run the CLI as a subprocess (the primary seam). Resolves {code, stdout, stderr}. */
export function cli(args, { env = {}, cwd = ROOT, fakeDocker = null, input = null } = {}) {
  /** @type {Record<string, string>} */
  const e = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env };
  if (fakeDocker) e.PATH = `${FAKE_BIN}:${e.PATH}`;
  if (fakeDocker) e.FAKE_DOCKER_CONFIG = JSON.stringify(fakeDocker);
  return new Promise(resolve => {
    const p = spawn('node', [path.join(ROOT, 'eval.mjs'), ...args], { cwd, env: e });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => (stdout += d));
    p.stderr.on('data', d => (stderr += d));
    p.on('close', code => resolve({ code, stdout, stderr }));
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

export const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
export const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };

/** The lock file `validate` leaves next to a scenarios file; `run` refuses a scenarios file without a matching one. */
export const lockPath = file => `${file}.lock.json`;
export function freezeForTest(file) {
  const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  writeJson(lockPath(file), { version: 1, scenarios_hash: hash });
}
