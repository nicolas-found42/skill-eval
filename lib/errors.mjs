/**
 * Error taxonomy for session failure classification.
 *
 * Every session failure gets classified into exactly one class so that
 * `eval.mjs query --error-class <class>` can find patterns across runs
 * without reading transcripts.
 */

export const ERROR_CLASSES = {
  model_refusal: 'The model refused or declined to perform the requested action (safety filter, capability limit, or explicit refusal).',
  timeout: 'The session exceeded its time limit (hung, killed, or expired).',
  resource_exhaustion: 'The container ran out of memory (OOM-killed) or hit a resource limit.',
  scenario_defect: 'The scenario itself is broken: bad fixtures, impossible expectations, or contradictory instructions.',
  grader_uncertainty: 'The judge could not decide (needs_human verdicts) — evidence was ambiguous or insufficient.',
  infra_failure: 'Infrastructure problem: docker daemon, network, API key, or image issue.',
  skill_ignored: 'The skill was loaded but the agent deviated from its required procedure.',
  skill_not_loaded: 'The skill was never loaded in a scenario that should have triggered it.',
  nonzero_exit: 'The container exited with a non-zero code without a timeout.',
  unknown: 'Unclassified failure.',
};

/**
 * Classify a session result into an error class.
 * @param {{ timeout?: boolean, timeout_kind?: string|null, oom_killed?: boolean|null, exit_code?: number|null, skill_loaded?: boolean, errors?: number, stderr_bytes?: number, stderr_tail?: string, grading?: any, scenario?: any }} result
 * @returns {string} one of ERROR_CLASSES keys
 */
export function classifyError(result, grading = null, scenario = null) {
  // A provider refusal means the session never ran: 429/5xx after omp's own retries leaves
  // empty assistant turns. Scoring those as skill failures blames the skill for an outage.
  if (result.provider_errors?.length) return 'infra_failure';
  if (result.oom_killed) return 'resource_exhaustion';
  if (result.timeout) return 'timeout';
  if (result.exit_code != null && result.exit_code !== 0) {
    // Docker/infra errors often have specific exit codes
    if (result.exit_code === 137) return 'resource_exhaustion'; // SIGKILL, often OOM
    if (result.exit_code === 125) return 'infra_failure'; // docker run itself failed
    if (result.exit_code === 126 || result.exit_code === 127) return 'infra_failure'; // command not found/executable
    return 'nonzero_exit';
  }
  // Check grading verdicts for skill-related failures
  if (grading?.steps) {
    const hasSkillFailure = grading.steps.some(s =>
      s.verdict === 'wrong' && /skill|gate|approval|plan|refus/i.test(s.description ?? '')
    );
    if (hasSkillFailure && !result.skill_loaded && scenario?.kind !== 'negative') {
      return 'skill_not_loaded';
    }
    if (hasSkillFailure && result.skill_loaded) {
      return 'skill_ignored';
    }
    const allUnclear = grading.steps.length > 0 && grading.steps.every(s => s.verdict === 'needs_human');
    if (allUnclear) return 'grader_uncertainty';
  }
  // Check for stderr output indicating infra issues
  if ((result.stderr_bytes ?? 0) > 0 && result.exit_code === 0) {
    const tail = (result.stderr_tail ?? '').toLowerCase();
    if (/docker|daemon|network|connection refused|dns|tls|certificate/i.test(tail)) {
      return 'infra_failure';
    }
  }
  if ((result.errors ?? 0) > 0 && result.exit_code === 0) {
    // Tool errors during the session — could be model or scenario
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Suggest a concrete fix for an error class.
 * @param {string} errorClass
 * @returns {string}
 */
export function suggestFix(errorClass) {
  const fixes = {
    model_refusal: 'Rephrase the prompt to be less ambiguous; check if the model has safety filters blocking the task.',
    timeout: 'Increase the timeout, split the scenario into smaller steps, or reduce reps/concurrency.',
    resource_exhaustion: 'Reduce concurrency, increase container memory limit, or simplify the scenario.',
    scenario_defect: 'Fix the scenario: check fixtures exist, expectations are achievable, and instructions are clear.',
    grader_uncertainty: 'Re-run with --keep-evidence to audit the judge state; consider rephrasing the step description.',
    infra_failure: 'Check docker daemon, network connectivity, API keys, and image availability.',
    skill_ignored: 'The skill text may need stronger language or more explicit refusal instructions.',
    skill_not_loaded: 'Check the skill description frontmatter matches the scenario prompt; the model may not recognize the trigger.',
    nonzero_exit: 'Check stderr.txt and host.jsonl for the container error; may be a missing dependency in the image.',
    unknown: 'Run `eval.mjs diagnose <run> --session <name>` for details.',
  };
  return fixes[errorClass] ?? fixes.unknown;
}
