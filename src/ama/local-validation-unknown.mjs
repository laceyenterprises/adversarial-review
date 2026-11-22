// MRQ-20: a host-local validation has three results. PASS is a pass. A genuine
// local FAILURE blocks, and the hammer remediates it. UNKNOWN (the battery timed
// out, was killed for load, or was denied process inspection) is no verdict at
// all. UNKNOWN defers to GitHub CI on the exact head, and only when that
// repository's declared required contexts are all present and green. It never
// passes when they are red, pending, absent, or when none are declared.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCheckRollup } from '../checks-summary.mjs';
import { resolveRequiredCheckContextsFromCfg } from './required-check-contexts.mjs';

// Stop reasons that mean "no local verdict" rather than "a check failed".
// Cleanup uncertainty after a finished battery (`validation-drain-unconfirmed`)
// and operator cancellation keep their existing handling.
export const CI_AUTHORITATIVE_UNKNOWN_REASONS = Object.freeze([
  'absolute-timeout',
  'no-progress-timeout',
  'child-check-timeout',
  'external-timeout:SIGALRM',
  'process-inspection-unavailable',
  'validation-budget-exceeded',
  'validation-killed',
]);

export const UNKNOWN_CONTEXTS_UNDECLARED = 'local-validation-unknown-required-contexts-undeclared';
export const UNKNOWN_CONTEXTS_NOT_GREEN = 'local-validation-unknown-required-contexts-not-green';

const declared = contexts => (Array.isArray(contexts) ? contexts : [])
  .filter(context => typeof context === 'string' && context.trim() !== '');

// The exact-head contexts an UNKNOWN result would defer to (global plus
// repository-scoped). Empty means UNKNOWN cannot defer for this repository.
export function declaredRequiredContexts(cfg, repository) {
  if (typeof repository !== 'string' || !repository.includes('/')) return [];
  return declared(resolveRequiredCheckContextsFromCfg(cfg, { repository }));
}

/**
 * Decide whether an UNKNOWN local result may hand its verdict to exact-head CI.
 * A failure already observed in the same battery keeps it blocking.
 *
 * @returns {{ciAuthoritative: boolean, requiredContexts: string[], reason?: string}}
 */
export function unknownValidationDeferral({ reason, requiredContexts, localFailureObserved = false }) {
  const contexts = declared(requiredContexts);
  if (localFailureObserved) return { ciAuthoritative: false, requiredContexts: contexts, reason: 'local-failure-observed' };
  if (!CI_AUTHORITATIVE_UNKNOWN_REASONS.includes(reason)) {
    return { ciAuthoritative: false, requiredContexts: contexts, reason: 'unknown-reason-not-deferrable' };
  }
  if (!contexts.length) return { ciAuthoritative: false, requiredContexts: contexts, reason: UNKNOWN_CONTEXTS_UNDECLARED };
  return { ciAuthoritative: true, requiredContexts: contexts };
}

/**
 * The merge-time half: with an UNKNOWN local result for this head, the declared
 * contexts must be non-empty and the shared classifier must read SUCCESS. An
 * absent declared context reads PENDING, so it is never green.
 *
 * @returns {{ok: boolean, reason?: string, conclusion?: string|null}}
 */
export function unknownValidationCiGate({ checks, requiredContexts }) {
  const contexts = declared(requiredContexts);
  if (!contexts.length) return { ok: false, reason: UNKNOWN_CONTEXTS_UNDECLARED, conclusion: null };
  const conclusion = classifyCheckRollup(checks, { requiredContexts: contexts });
  return conclusion === 'SUCCESS' ? { ok: true, conclusion }
    : { ok: false, reason: UNKNOWN_CONTEXTS_NOT_GREEN, conclusion };
}

// The run-local UNKNOWN receipt bin/hammer-validate.mjs writes for one head.
export function unknownValidationReceiptPath(runDir, head) {
  return runDir && /^[a-f0-9]{40}$/.test(head || '') ? join(runDir, `validation-deferred-${head}.json`) : null;
}

export function readUnknownValidationReceipt(runDir, head) {
  const path = unknownValidationReceiptPath(runDir, head);
  if (!path || !existsSync(path)) return null;
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    return receipt && typeof receipt === 'object' ? receipt : { unreadable: true };
  } catch { return { unreadable: true }; }
}

// Re-judge a recorded UNKNOWN against current configuration. An unreadable
// receipt, absent/withdrawn CI authority, a recorded local failure or an
// ineligible reason stays deferred.
export function recordedUnknownDefersToCi(receipt, requiredContexts) {
  if (!receipt || receipt.unreadable || receipt.validation !== 'unknown' || receipt.ciAuthoritative !== true) return false;
  return unknownValidationDeferral({ reason: receipt.reason, requiredContexts,
    localFailureObserved: receipt.localFailureObserved === true }).ciAuthoritative;
}
