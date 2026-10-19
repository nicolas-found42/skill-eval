import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './exec.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadRegistry(file = path.join(ROOT, 'models.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Resolve an alias to {alias, model, env}. Unknown aliases fail; there is no fallback. */
export function resolveModel(alias, registry = loadRegistry()) {
  const a = alias ?? registry.default;
  const entry = registry.models[a];
  if (!entry) throw new UserError(`unknown model alias "${a}". Known aliases: ${Object.keys(registry.models).join(', ')}`);
  return { alias: a, model: entry.model, env: entry.env };
}

/** Throw if the model's API key env var is not set. Returns the key value. */
export function requireKey(resolved, env = process.env) {
  const v = env[resolved.env];
  if (!v) throw new UserError(`model alias "${resolved.alias}" needs ${resolved.env} set in the environment`);
  return v;
}
