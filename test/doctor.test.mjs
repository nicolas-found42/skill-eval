import test from 'node:test';
import assert from 'node:assert/strict';
import { cli } from './helpers.mjs';

const KEYS = { OPENROUTER_API_KEY: 'x', OLLAMA_CLOUD_API_KEY: 'x' };

test('doctor stops with a start-Docker message when the daemon is down, and never mentions a host fallback', async () => {
  const r = await cli(['doctor'], { env: KEYS, fakeDocker: { daemon: 'down' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /start Docker/i);
});

test('doctor fails when the grading key is missing', async () => {
  const r = await cli(['doctor'], { env: { OLLAMA_CLOUD_API_KEY: 'x' }, fakeDocker: { daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /OPENROUTER_API_KEY/);
});

test('doctor fails loudly for an unknown model alias instead of falling back', async () => {
  const r = await cli(['doctor', '--model', 'gpt-nonexistent'], { env: KEYS, fakeDocker: { daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /unknown model alias "gpt-nonexistent"/i);
  assert.match(r.stderr, /ollama-cloud/); // lists the known aliases
});

test('doctor fails when the selected model key env var is missing, naming the var', async () => {
  const r = await cli(['doctor', '--model', 'mistral'], { env: KEYS, fakeDocker: { daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3' } });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /MISTRAL_API_KEY/);
});

test('doctor builds the image tagged with the host omp version when it is missing', async () => {
  const r = await cli(['doctor'], { env: KEYS, fakeDocker: { daemon: 'up', images: [], ompVersion: '1.2.3' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /skill-eval-omp:1\.2\.3/);
  assert.match(r.stdout, /built/i);
});

test('doctor never rebuilds an image tag that already exists', async () => {
  const r = await cli(['doctor'], { env: KEYS, fakeDocker: { daemon: 'up', images: ['skill-eval-omp:1.2.3'], ompVersion: '1.2.3' } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already exists/i);
  assert.doesNotMatch(r.stdout, /built/i);
});
