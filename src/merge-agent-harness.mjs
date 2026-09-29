// The worker class a merge-agent dispatch runs on.
//
// `roles.merge_agent_worker_class` names the class. CLOSERREUSE-01 (SEV2
// 2026-09-29): this host pins it to `hammer`, a codex harness, and the
// watcher's AMA recovery fallback kept dispatching it through the codex weekly
// cap. Every fallback hammer crashed or was refused as `harness_unhealthy`
// (agent-os#7348, #7349). The AMA closer already avoided that: HHR resolves
// its class through fleet-quota grounding and
// `roles.adversarial.merge_authority.worker_class_fallback`
// (src/ama/harness-fallback.mjs). The merge-agent now resolves through the
// same resolver and the same fallback list. While openai/oauth is grounded,
// `hammer` dispatches as `hammer-claude`, and it returns to `hammer` once
// openai recovers.
//
// One difference from the closer: when the configured class is grounded and
// no fallback is available, the closer still dispatches on the primary ("a
// doomed spawn is no worse"). The merge-agent is itself the fallback lane, so
// it defers instead and never dispatches a quota-grounded class. An unreadable
// or ambiguous quota status is not grounding; both paths keep the primary then.

import { resolveCloserDispatchHarness } from './ama/harness-fallback.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { MODULE_CONFIG_PATH, resolveDefaultMergeAgentWorkerClass } from './role-config.mjs';

// Worker class used for merge-orchestration dispatch. Default is the
// `merge-agent` stub adapter; operators pin to a real model class
// (`codex`, `claude-code`) via env when the merge-agent surface is being
// validated against live models, or during a budget-squeeze where the
// stub's behavior needs to be substituted by a known-working coding
// worker class.
export const DEFAULT_MERGE_AGENT_WORKER_CLASS = 'merge-agent';
export const MERGE_AGENT_WORKER_CLASS_ENV = 'ADVERSARIAL_REVIEW_MERGE_AGENT_WORKER_CLASS';
export const ALLOWED_MERGE_AGENT_WORKER_CLASSES = Object.freeze([
  'merge-agent',
  'codex',
  'claude-code',
]);
export const MERGE_AGENT_HARNESS_GROUNDED_REASON = 'merge-agent-harness-grounded';

// Cascade-aware merge-agent worker class resolver. Consults config.yaml
// FIRST (module → top → *.local) and env LAST per SPEC §3. The top-level
// canonical key `roles.merge_agent_worker_class` overrides the module's
// `merge_agent.worker_class` via the SPEC §10.2 `__aliases` block. The
// loader fails loud on enum violations, env-alias conflicts, and YAML 1.2
// boolean-coercion attempts.
//
// The `_isMergeAgentConfigError` flag and `configKey` / `requestedValue`
// shape on the error are preserved for downstream callers that key off
// them (e.g. the dispatch refusal path).
// CFG-02 round-1 review B6 fix (2026-05-30): requestedValue defaults
// to null so downstream templating doesn't render the multi-value
// diagnostic blob the loader puts in err.got for env-alias conflicts.
// (B1 mislabel fix deferred — see follow-up-remediation.mjs for the
// matching rationale.)
export function resolveMergeAgentWorkerClass(env = process.env, opts = {}) {
  try {
    return resolveDefaultMergeAgentWorkerClass({ env, ...opts });
  } catch (err) {
    if (err && err.name === 'AgentOSConfigError') {
      err.isMergeAgentConfigError = true;
      err.configKey = err.envName || MERGE_AGENT_WORKER_CLASS_ENV;
      err.requestedValue = null;
    }
    throw err;
  }
}

// The closer's fallback list (schema default `[hammer-claude]`). A config that
// cannot be read gives no fallback, which still never dispatches a grounded
// class: the primary's grounding is probed either way.
export function mergeAgentFallbackWorkerClasses(env = process.env, { logger = console } = {}) {
  try {
    const cfg = loadConfigCached({ env, modulePaths: [MODULE_CONFIG_PATH] }).getMergeAuthorityConfig();
    return Array.isArray(cfg?.workerClassFallback) ? cfg.workerClassFallback : [];
  } catch (err) {
    if (err instanceof ReferenceError) throw err;
    logger?.warn?.(
      '[merge-agent] could not read roles.adversarial.merge_authority.worker_class_fallback; '
        + `no harness fallback for this dispatch: ${err?.message || err}`,
    );
    return [];
  }
}

/**
 * @param {object} args
 * @param {string} args.workerClass  The configured merge-agent class.
 * @returns {Promise<object>} resolveCloserDispatchHarness's result, plus
 *   `deferred: true` and `reason: 'merge-agent-harness-grounded'` when the
 *   class is grounded and nothing can take its place.
 */
export async function resolveMergeAgentDispatchHarness({
  workerClass,
  env = process.env,
  hqPath,
  execFileImpl,
  logger = console,
  fallbackWorkerClasses = mergeAgentFallbackWorkerClasses(env, { logger }),
  resolveHarnessImpl = resolveCloserDispatchHarness,
} = {}) {
  let harness;
  try {
    harness = await resolveHarnessImpl({
      workerClass,
      fallbackWorkerClasses,
      hqPath,
      execFileImpl,
      env,
      probeWithoutFallbacks: true,
    });
  } catch (err) {
    // Fail open, like the closer: a resolver fault is not proof of grounding.
    harness = { workerClass, fellBack: false, reason: 'harness-fallback-resolver-error', error: String(err?.message || err) };
  }
  if (harness?.fellBack === true && harness.workerClass) {
    logger?.warn?.(
      `[merge-agent] harness fallback: ${harness.from} -> ${harness.to} `
        + `(${harness.provider} ${harness.groundedBy || 'hard'}-grounded, state=${harness.primaryState}); `
        + `returns to ${harness.from} when ${harness.provider} recovers`,
    );
    return { ...harness, deferred: false };
  }
  if (harness?.groundedBy) {
    return {
      ...harness,
      workerClass,
      deferred: true,
      reason: MERGE_AGENT_HARNESS_GROUNDED_REASON,
      harnessReason: harness.reason,
    };
  }
  return { ...harness, workerClass, deferred: false };
}
