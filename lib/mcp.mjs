/**
 * Skills may declare MCP servers in their frontmatter (`mcpServers:`). Frontmatter servers do not start inside the
 * container by themselves, so the runner generates a minimal mcp.json holding only the servers the skill declares.
 *
 * The repo has no YAML dependency; this reads the subset skills use: nested maps by indentation, quoted or bare
 * scalars, and JSON-style flow sequences/maps. Anything else in the block becomes a warning, never a guess.
 */
import fs from 'node:fs';
import path from 'node:path';

const frontmatter = text => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';

function scalar(raw) {
  const v = raw.trim();
  if (v === '') return null;
  if (/^[[{]/.test(v)) { try { return JSON.parse(v); } catch { return undefined; } }
  if (/^"/.test(v)) { try { return JSON.parse(v); } catch { return undefined; } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * @param {string} skillText full SKILL.md
 * @returns {{ servers: Record<string, any>, warnings: string[] }}
 */
export function declaredMcpServers(skillText) {
  const lines = frontmatter(skillText).split('\n');
  const start = lines.findIndex(l => /^mcpServers:\s*$/.test(l));
  if (start < 0) return { servers: {}, warnings: [] };
  const servers = {}, warnings = [];
  let current = null, nested = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) break; // next top-level key ends the block
    const indent = line.match(/^ */)[0].length;
    const m = /^\s*([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!m) { warnings.push(`mcpServers: could not read line "${line.trim()}"; the generated MCP config may be incomplete`); continue; }
    const [, key, rest] = m;
    if (indent <= 2) { current = key; nested = null; servers[key] = {}; if (rest) warnings.push(`mcpServers.${key}: inline value is not supported`); continue; }
    if (!current) continue;
    if (indent <= 4) {
      nested = null;
      if (rest === '') { nested = key; servers[current][key] = {}; continue; }
      const v = scalar(rest);
      if (v === undefined) warnings.push(`mcpServers.${current}.${key}: could not parse "${rest}"`);
      else servers[current][key] = v;
    } else if (nested) {
      const v = scalar(rest);
      if (v === undefined) warnings.push(`mcpServers.${current}.${nested}.${key}: could not parse "${rest}"`);
      else servers[current][nested][key] = v;
    }
  }
  return { servers, warnings };
}

/**
 * A plugin's own mcp.json (Agent Plugins §7.2, portable `mcp.json` at the plugin root). OMP mounts the plugin at
 * /plugin with `--plugin-dir`, so `${PLUGIN_ROOT}` rewrites to /plugin and servers run with cwd /plugin.
 * `env` values are NEVER copied (same secret rule as frontmatter servers). Returns `{ servers, warnings }`.
 */
export function declaredPluginMcp(pluginDir) {
  const file = path.join(pluginDir, 'mcp.json');
  const warnings = [];
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch { return { servers: {}, warnings }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { warnings.push('plugin mcp.json is not valid JSON and was ignored'); return { servers: {}, warnings }; }
  const stanza = parsed?.mcpServers;
  if (stanza == null || typeof stanza !== 'object' || Array.isArray(stanza)) {
    warnings.push('plugin mcp.json has no mcpServers object and was ignored');
    return { servers: {}, warnings };
  }
  const servers = {};
  for (const [name, cfg] of Object.entries(stanza)) {
    if (cfg == null || typeof cfg !== 'object' || Array.isArray(cfg)) { warnings.push(`mcp server "${name}": entry must be an object; left out of the generated config`); continue; }
    if (!cfg.command || typeof cfg.command !== 'string') { warnings.push(`mcp server "${name}" declares no command and was left out of the generated config`); continue; }
    if (cfg.command !== 'python3' && /[/\\]/.test(cfg.command)) { warnings.push(`mcp server "${name}" uses the host path ${cfg.command}, which does not exist in the container; its tools will be unavailable`); continue; }
    const args = cfg.args ?? [];
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) { warnings.push(`mcp server "${name}": args must be an array of strings; left out of the generated config`); continue; }
    const rewritten = args.map(a => a.replaceAll('${PLUGIN_ROOT}', '/plugin').replaceAll('${CLAUDE_PLUGIN_ROOT}', '/plugin'));
    if (rewritten.some(a => a.includes('${PLUGIN_DATA}'))) { warnings.push(`mcp server "${name}" references \${PLUGIN_DATA}, which has no persistent dir in a throwaway container; left out of the generated config`); continue; }
    if (cfg.cwd != null && typeof cfg.cwd !== 'string') { warnings.push(`mcp server "${name}": cwd must be a string; left out of the generated config`); continue; }
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env) && Object.keys(cfg.env).length) warnings.push(`mcp server "${name}" declares env values in mcp.json (${Object.keys(cfg.env).join(', ')}); they are not copied into the container. List the variable names the server needs in each scenario's env[] to pass them through`);
    servers[name] = { command: cfg.command, args: rewritten, cwd: '/plugin' };
  }
  return { servers, warnings };
}

/**
 * The mcp.json document omp reads from its agent dir. Only command, args and cwd are copied: `includeTools` is a
 * frontmatter-only filter, and frontmatter `env` values are NEVER copied, because skills sometimes embed real keys
 * there (including the grading key). The container receives only variables the scenario names in `env[]`.
 */
export function mcpConfig(servers) {
  const out = {};
  for (const [name, s] of Object.entries(servers)) {
    if (!s.command) continue;
    out[name] = { command: s.command, args: s.args ?? [] };
    if (s.cwd) out[name].cwd = s.cwd;
  }
  return { mcpServers: out };
}

/** Problems that make a declared server unlikely to start in the container; reported, never silently dropped. */
export function mcpWarnings(servers) {
  const w = [];
  for (const [name, s] of Object.entries(servers)) {
    if (!s.command) w.push(`mcp server "${name}" declares no command and was left out of the generated config`);
    else if (/^(\/|~)/.test(s.command)) w.push(`mcp server "${name}" uses the host path ${s.command}, which does not exist in the container; its tools will be unavailable`);
    if (s.env && Object.keys(s.env).length) w.push(`mcp server "${name}" declares env values in the skill frontmatter (${Object.keys(s.env).join(', ')}); they are not copied into the container. List the variable names the server needs in each scenario's env[] to pass them through`);
  }
  return w;
}

/** Skills the SKILL.md leans on that will not exist in the container, which has only the skill under test. */
export function missingDependencies(skillText, ownName, present = []) {
  const have = new Set([ownName, ...present]);
  const body = skillText.replace(/^---\n[\s\S]*?\n---/, '');
  const refs = new Set([...body.matchAll(/skill:\/\/([A-Za-z0-9_-]+)/g), ...body.matchAll(/\/skill:([A-Za-z0-9_-]+)/g)].map(m => m[1]));
  for (const n of have) refs.delete(n);
  return [...refs].sort().map(n => `skill references "${n}", which is not installed in the container (only the skill under test is); a failure caused by this is a missing dependency, not necessarily a broken skill`);
}
