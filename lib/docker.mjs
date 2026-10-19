import path from 'node:path';
import { exec, UserError } from './exec.mjs';
import { ROOT } from './registry.mjs';

export const IMAGE_REPO = 'skill-eval-omp';

/** Fail fast with an actionable message when the daemon is unreachable. Never falls back to the host. */
export async function requireDaemon() {
  let r;
  try { r = await exec('docker', ['info', '--format', '{{.ServerVersion}}']); }
  catch { throw new UserError('docker CLI not found. Install Docker Desktop and start Docker, then retry.'); }
  if (r.code !== 0) throw new UserError('Docker daemon is not running. Please start Docker and retry. (Sessions are never run on the host.)');
}

export async function hostOmpVersion() {
  let r;
  try { r = await exec('omp', ['--version']); }
  catch { throw new UserError('omp not found on PATH; it is needed to pin the container image to your omp version.'); }
  const m = /(\d+\.\d+\.\d+\S*)/.exec(r.stdout);
  if (r.code !== 0 || !m) throw new UserError(`could not read omp version from "omp --version": ${r.stdout}${r.stderr}`);
  return m[1];
}

export const imageTag = ompVersion => `${IMAGE_REPO}:${ompVersion}`;

/** Ensure the image for this omp version exists. Never rebuilds an existing tag. Returns {tag, built}. */
export async function ensureImage(ompVersion) {
  const tag = imageTag(ompVersion);
  const have = await exec('docker', ['image', 'inspect', tag]);
  if (have.code === 0) return { tag, built: false };
  const b = await exec('docker', ['build', '--build-arg', `OMP_VERSION=${ompVersion}`, '-t', tag, path.join(ROOT, 'docker')]);
  if (b.code !== 0) throw new UserError(`docker build failed for ${tag}:\n${b.stderr || b.stdout}`);
  return { tag, built: true };
}
