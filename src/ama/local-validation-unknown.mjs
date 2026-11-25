// MRQ-20: a host-local validation has three results. PASS is a pass. A genuine
// local FAILURE blocks, and the hammer remediates it. UNKNOWN (the battery timed
// out, was killed for load, or was denied process inspection) is no verdict at
// all. UNKNOWN defers to GitHub CI on the exact head, and only when that
// repository's declared required contexts are all present and green. It never
// passes when they are red, pending, absent, or when none are declared.
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { classifyCheckRollup } from '../checks-summary.mjs';
import { resolveRequiredCheckContextsFromCfg } from './required-check-contexts.mjs';

// Stop reasons that mean "no local verdict" rather than "a check failed".
// Cleanup uncertainty after a finished battery (`validation-drain-unconfirmed`)
// and process-inspection denial by the Telegram guard require local recovery.
export const PROCESS_INSPECTION_UNAVAILABLE = 'process-inspection-unavailable';
export const processInspectionRefused = checks => checks?.some(
  check => check?.result === 'inconclusive' && check.localReason === PROCESS_INSPECTION_UNAVAILABLE,
) === true;
export const CI_AUTHORITATIVE_UNKNOWN_REASONS = Object.freeze([
  'absolute-timeout',
  'no-progress-timeout',
  'child-check-timeout',
  'external-timeout:SIGALRM',
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
 * HAMCIAUTH-01: the whole UNKNOWN-defers-to-CI rule. Coverage may be partial:
 * checks a timed-out battery never reached are exactly what exact-head CI
 * runs. It applies under the HAM controller too. It requires a deferrable stop
 * reason, no local failure anywhere in the battery (flag or a failed check
 * row), a checkout that was clean at the exact validated head (the remediation
 * is committed, so it can be published) and declared required contexts.
 *
 * @returns {{ciAuthoritative: boolean, requiredContexts: string[], reason?: string}}
 */
export function unknownDefersToCi({ reason, requiredContexts, localFailureObserved = false, checks = [], cleanCheckout }) {
  if (Array.isArray(checks) && processInspectionRefused(checks)) {
    return { ciAuthoritative: false, requiredContexts: declared(requiredContexts), reason: PROCESS_INSPECTION_UNAVAILABLE };
  }
  const failed = localFailureObserved === true || (Array.isArray(checks) && checks.some(check => check?.result === 'fail'));
  const decision = unknownValidationDeferral({ reason, requiredContexts, localFailureObserved: failed });
  if (decision.ciAuthoritative && cleanCheckout !== true) {
    return { ciAuthoritative: false, requiredContexts: decision.requiredContexts, reason: 'checkout-not-clean-at-head' };
  }
  return decision;
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
  if (!path) return null;
  try {
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    return receipt && receipt.schemaVersion === 1 && receipt.head === head ? receipt : { unreadable: true };
  } catch (error) { return error.code === 'ENOENT' ? null : { unreadable: true }; }
}

// Read the private check receipt after its process group has drained.
export function readDeferredValidationChecks(runDir, head, recorded) {
  if (!recorded?.localValidationReceipt) return null;
  if (typeof recorded.localValidationReceipt !== 'string') throw new Error('invalid validation receipt path');
  const receiptPath = resolve(runDir, recorded.localValidationReceipt);
  const path = relative(runDir, receiptPath);
  if (!path || isAbsolute(path) || path.split(sep)[0] === '..') throw new Error('invalid validation receipt path');
  let evidence;
  try { evidence = JSON.parse(readFileSync(receiptPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('invalid validation receipt', { cause: error });
  }
  if (evidence?.head !== head || !Array.isArray(evidence.checks)
    || evidence.checks.some(check => !check || typeof check !== 'object')) throw new Error('invalid validation receipt');
  return evidence;
}

// Re-judge a recorded UNKNOWN against current configuration. An unreadable
// receipt, absent/withdrawn CI authority, a recorded local failure, unconfirmed
// cleanup or an ineligible reason stays deferred. HAMCIAUTH-01: partial
// coverage qualifies when the battery ran on the clean, committed exact head.
// Receipts written before that rule recorded only complete coverage.
export function hasCompletedUnknownValidationEvidence(receipt) {
  return receipt?.ciAuthoritative === true && receipt.cleanup === 'finished'
    && (receipt.cleanCheckout === true
      || (receipt.cleanCheckout === undefined && receipt.coverageComplete === true))
    && receipt.localFailureObserved === false;
}

export function recordedUnknownDefersToCi(receipt, requiredContexts) {
  if (receipt?.validation !== 'unknown' || !hasCompletedUnknownValidationEvidence(receipt)) return false;
  return unknownValidationDeferral({ reason: receipt.reason, requiredContexts,
    localFailureObserved: receipt.localFailureObserved === true }).ciAuthoritative;
}

// Reuse the final check evidence at close, queue publication and merge.
export function finalizedUnknownDefersToCi(runDir, head, receipt, requiredContexts) {
  if (!recordedUnknownDefersToCi(receipt, requiredContexts)) return false;
  // Older complete-coverage receipts did not always carry a check reference.
  if (receipt.cleanCheckout === undefined && !receipt.localValidationReceipt) return true;
  try {
    const evidence = readDeferredValidationChecks(runDir, head, receipt);
    return Boolean(evidence && unknownDefersToCi({
      ...receipt, requiredContexts, checks: evidence.checks,
      cleanCheckout: receipt.cleanCheckout ?? receipt.coverageComplete,
    }).ciAuthoritative);
  } catch { return false; }
}
