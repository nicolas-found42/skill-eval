import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSkill } from '../lib/skill.mjs';
import { tmpdir } from './helpers.mjs';

/**
 * A skill's hash is what `compare` uses to decide two runs are comparable, so it
 * must change when the author edits instructions and must NOT change when a
 * first-use installer drops a dependency tree beside them. A plugin shipping
 * `scripts/node_modules` otherwise changes identity on every `npm install`.
 */
function writeSkill(dir, body) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: toy\ndescription: A toy skill.\n---\n\n${body}\n`);
  return dir;
}

test('editing a skill changes its hash', () => {
  const a = writeSkill(path.join(tmpdir('sk-'), 'toy'), 'Do the thing.');
  const b = writeSkill(path.join(tmpdir('sk-'), 'toy'), 'Do the other thing.');
  assert.notEqual(readSkill(a).hash, readSkill(b).hash);
});

test('installed dependency trees do not change a skill hash', () => {
  const dir = writeSkill(path.join(tmpdir('sk-'), 'toy'), 'Do the thing.');
  const before = readSkill(dir).hash;

  for (const dep of ['node_modules', '.venv', '__pycache__']) {
    const p = path.join(dir, dep, 'some-package');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'index.js'), 'module.exports = 1;\n');
  }

  const after = readSkill(dir);
  assert.equal(after.hash, before, 'an installer must not change what the skill is');
  assert.ok(!after.files.some((f) => f.includes('node_modules')), 'dependency files are not skill files');
});

test('a plugin hash covers its stage skills and its own files', () => {
  const dir = path.join(tmpdir('sk-'), 'plugin');
  writeSkill(dir, 'Entry point.');
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'toy-plugin' }));
  const stage = path.join(dir, 'skills', 'stage-one');
  writeSkill(stage, 'Stage instructions.');
  const withStage = readSkill(dir);
  assert.equal(withStage.kind, 'plugin');
  assert.ok(withStage.text.includes('Stage instructions.'), 'grounding text includes stage skills');

  fs.writeFileSync(path.join(stage, 'SKILL.md'), '---\nname: stage-one\ndescription: x\n---\n\nChanged.\n');
  assert.notEqual(readSkill(dir).hash, withStage.hash, 'a stage edit is a skill edit');
});
