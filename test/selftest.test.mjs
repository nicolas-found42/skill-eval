import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cli, tmpdir, readJson, writeJson, ROOT } from './helpers.mjs';

/** @type {Record<string, string>} */
const ENV = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? '' };

test('selftest passes on the committed fixtures and reports every session it checked', async () => {
  const r = await cli(['selftest'], { env: ENV });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const n = fs.readdirSync(path.join(ROOT, 'fixtures', 'sessions')).length;
  assert.match(r.stdout, new RegExp(`${n} sessions`));
  assert.match(r.stdout, /selftest passed/i);
});

test('selftest fails and names the session and step when a verdict drifts from the known answer', async () => {
  // point selftest at a copy of the fixtures whose expectation for no_wc is deliberately wrong
  const dir = tmpdir('selftest-');
  fs.cpSync(path.join(ROOT, 'fixtures'), dir, { recursive: true });
  const ej = path.join(dir, 'sessions', 'no_wc', 'expected.json');
  const e = readJson(ej); e.steps.wc = 'done'; writeJson(ej, e);
  const r = await cli(['selftest', '--fixtures', dir], { env: ENV });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /no_wc/);
  assert.match(r.stderr, /wc/);
  assert.match(r.stderr, /expected done/i);
});

test('selftest fails when an expected failure label is missing', async () => {
  const dir = tmpdir('selftest-');
  fs.cpSync(path.join(ROOT, 'fixtures'), dir, { recursive: true });
  const ej = path.join(dir, 'sessions', 'intact', 'expected.json');
  const e = readJson(ej); e.labels_include = ['fabricated_claim']; writeJson(ej, e);
  const r = await cli(['selftest', '--fixtures', dir], { env: ENV });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /intact/);
  assert.match(r.stderr, /fabricated_claim/);
});

test('selftest requires the grading key and says so', async () => {
  const r = await cli(['selftest'], { env: {} });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
});
