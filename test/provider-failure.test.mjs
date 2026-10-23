import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../lib/errors.mjs';
import { derivedLabels } from '../lib/classify.mjs';

/**
 * A provider 429 exhausts omp's retries and leaves an empty assistant turn. That is an
 * outage, not the model declining to act: scoring it as `skill_not_triggered` blames the
 * skill for the provider. Measured on one run, 5 of 18 sessions were scored that way.
 */
const limited = {
  exit_code: 0,
  timeout: false,
  skill_loaded: false,
  errors: 0,
  provider_errors: ['429 Upstream request failed: Rate limit exceeded. retry-after-ms=72839000'],
  empty_assistant_turns: 2,
};

test('a provider rate limit is an infra failure, not a skill judgement', () => {
  assert.equal(classifyError(limited), 'infra_failure');
});

test('a rate-limited session does not claim the skill failed to trigger', () => {
  const labels = derivedLabels({ kind: 'positive' }, limited);
  assert.deepEqual(labels.map(l => l.label), ['infra_failure']);
  assert.match(labels[0].note, /never ran/);
});

test('a session with no provider error still reports a missed trigger', () => {
  const labels = derivedLabels({ kind: 'positive' }, { skill_loaded: false });
  assert.deepEqual(labels.map(l => l.label), ['skill_not_triggered']);
});
