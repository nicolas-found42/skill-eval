import { spawn } from 'node:child_process';

/**
 * Run a binary, capture output. Never throws on non-zero exit; throws only if the binary cannot be spawned.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, input?: string | null, timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function exec(cmd, args, { env = process.env, cwd, input, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, cwd });
    let stdout = '', stderr = '', timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeoutMs) : undefined;
    p.stdout.on('data', d => (stdout += d));
    p.stderr.on('data', d => (stderr += d));
    p.on('error', reject);
    p.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    if (input != null) p.stdin.end(input); else p.stdin.end();
  });
}

export class UserError extends Error {}
