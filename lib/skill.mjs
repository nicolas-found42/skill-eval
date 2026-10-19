import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UserError } from './exec.mjs';

export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

function walk(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p, base));
    else if (ent.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

/** Read a skill directory: its name (frontmatter `name:` or directory name), file list and a content hash. */
export function readSkill(dir) {
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) throw new UserError(`no SKILL.md in skill path ${dir}`);
  const text = fs.readFileSync(skillMd, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const nameLine = fm && /^name:\s*(.+)$/m.exec(fm[1]);
  const name = (nameLine ? nameLine[1].trim().replace(/^["']|["']$/g, '') : path.basename(path.resolve(dir)));
  const files = walk(dir);
  const h = crypto.createHash('sha256');
  for (const f of files) { h.update(f); h.update('\0'); h.update(fs.readFileSync(path.join(dir, f))); h.update('\0'); }
  return { name, text, files, hash: h.digest('hex') };
}

export function copySkill(from, to) {
  fs.cpSync(from, to, { recursive: true });
}
