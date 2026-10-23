import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserError } from './exec.mjs';

export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

/**
 * Installed dependency trees and caches are not part of a skill's identity: they
 * change when someone runs `npm install` or a first-use installer, not when the
 * author edits the skill. Hashing them made two runs of identical instructions
 * look like a different skill, which turns `compare` into a false "skill changed".
 */
const IGNORED_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.git']);

function walk(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!IGNORED_DIRS.has(ent.name)) out.push(...walk(p, base));
    } else if (ent.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

/** A plugin directory carries an Agent Plugins manifest plus a skills/ tree (spec §5/§7.1). */
export function isPluginDir(dir) {
  const mf = path.join(dir, 'plugin.json');
  if (!fs.existsSync(mf)) return false;
  try {
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    return typeof m?.name === 'string' && fs.existsSync(path.join(dir, 'skills'));
  } catch { return false; }
}

/**
 * Read the subject under test: a single skill, or a whole plugin. A plugin keeps its manifest name and hashes
 * every file, but its grading text is the root SKILL.md plus every stage skill, so Jev grounding sees the same
 * instructions the container session does. `skillNames` is every identity `normalize` accepts as a skill load:
 * the single skill name, or the plugin plus each stage skill name. A single skill reads its frontmatter name.
 */
export function readSkill(dir) {
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new UserError(`no SKILL.md in skill path ${dir}`);
  const text = fs.readFileSync(skillMd, 'utf8');
  const files = walk(dir);
  const h = crypto.createHash('sha256');
  for (const f of files) { h.update(f); h.update('\0'); h.update(fs.readFileSync(path.join(dir, f))); h.update('\0'); }
  const hash = h.digest('hex');
  if (!isPluginDir(dir)) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(text);
    const nameLine = fm && /^name:\s*(.+)$/m.exec(fm[1]);
    const name = (nameLine ? nameLine[1].trim().replace(/^["']|["']$/g, '') : path.basename(path.resolve(dir)));
    return { kind: 'skill', name, text, files, hash, skillNames: [name] };
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  const name = manifest.name;
  const stages = fs.readdirSync(path.join(dir, 'skills'), { withFileTypes: true })
    .filter(e => e.isDirectory() && fs.existsSync(path.join(dir, 'skills', e.name, 'SKILL.md')))
    .map(e => e.name).sort();
  let combined = text;
  for (const s of stages) combined += `\n\n# Stage skill: ${s}\n\n` + fs.readFileSync(path.join(dir, 'skills', s, 'SKILL.md'), 'utf8');
  return { kind: 'plugin', name, text: combined, files, hash, skillNames: [name, ...stages] };
}

export function copySkill(from, to) {
  fs.cpSync(from, to, { recursive: true });
}
