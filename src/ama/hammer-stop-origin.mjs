// HAMSELFERRORS-01: the world-fact stop rule. Classification grants no edit,
// lease or merge authority. Unknown reasons must be registered before use.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';

export const HAMMER_INFRASTRUCTURE_OUTCOMES = new Set([
  'overload-deferred',
  'hammer-command-error',
  'git-credential-refresh-failed',
  // CLOSERGATES-01: an API credential mint that timed out or failed to run,
  // and a closure gate whose transient read failures outlasted the budget.
  'credential-refresh-unavailable',
  'closure-gate-read-unavailable',
  'launch-environment-read-unavailable',
  // HAMMERLAUNCHREAD-01: the same deferral at the closure step, after work.
  'launch-environment-read-unavailable-at-closure',
  'launch-environment-missing-legacy-dispatch',
  'merge-lease-base-read-failed',
  'verify-head-pr-read-failed',
  'missing-pr-state',
  'published-head-timeout',
  'published-head-probe-failed',
  'published-head-probe-invalid',
  'controller-observation-unavailable',
  'ci-infrastructure-evidence-unavailable',
  'merge-lease-probe-failed',
  'merge-lease-response-invalid',
  'pr-refresh-failed',
  'produced-head-read-failed',
  'rebase-head-timeout',
  'rebase-base-unavailable',
  'history-read-failed',
  'predicate-verdict-unavailable',
  'github-gate-read-failed',
  'protective-predecessor-read-failed',
  'commit-title-read-failed',
  'stacked-base-read-failed',
  'ci-wait-pr-refresh-failed',
  'merge-confirmation-read-failed',
  'merge-confirmation-read-failed-after-merge-accepted',
  'publish-head-read-failed',
  'publish-identity-read-failed',
]);

export const HAMMER_EDIT_PLAN_ERROR_ORIGINS = Object.freeze({
  'run-pin-invalid': 'evidence',
  'review-missing': 'evidence',
  'review-head-mismatch': 'evidence',
  'reviewer-untrusted': 'evidence',
  'review-state-invalid': 'evidence',
  'finding-evidence-invalid': 'evidence',
  'finding-kind-not-authorizing': 'evidence',
  'finding-not-found': 'plan',
  'finding-lines-unreadable': 'evidence',
  'finding-lines-invalid': 'evidence',
  'plan-json-invalid': 'plan',
  'plan-invalid': 'plan',
  'plan-head-invalid': 'plan',
  'finding-citation-invalid': 'plan',
  'edit-kind-invalid': 'plan',
  'edit-location-invalid': 'plan',
  'not-covered-by-cited-finding': 'plan',
});

export const HAMMER_STOP_ORIGINS = Object.freeze({
  ...Object.fromEntries([
    'base-head', 'context', 'edit-plan-usage', 'review-read', 'conflict-primary',
    'dispute-finding', 'primary-change-context', 'submodule-sync', 'rebase-result',
    'pushed-attestation', 'merge-action-receipt', 'head-context', 'api-publish',
  ].flatMap(step => [[`${step}-failed`, 'closer'], [`${step}-timeout`, 'infrastructure']])),
  ...Object.fromEntries(Object.entries(HAMMER_EDIT_PLAN_ERROR_ORIGINS).map(([reason, origin]) => [reason, origin === 'plan' ? 'closer' : 'world'])),
  'already-merged': 'world',
  'parked': 'world',
  'ci-infrastructure': 'world',
  'ci-not-green': 'world',
  'conflict-primary-unproven': 'world',
  'conflict-repair-exhausted': 'world',
  'conflict-semantic-unsafe': 'world',
  'controller-cancelled': 'world',
  'controller-launch-environment-identity-unconfirmed': 'world',
  'controller-launch-environment-malformed': 'world',
  'dispute-review-evidence-invalid': 'world',
  'dispute-review-currency-unproven': 'world',
  'dispute-reservation-in-flight': 'world',
  'dispute-owner-refused': 'world',
  'dispute-identity-refused': 'world',
  'controller-owner-lost': 'world',
  'controller-owner-unconfirmed': 'world',
  'exact-head-review-required': 'world',
  'findings-unresolved': 'world',
  'github-gate-not-green': 'world',
  'github-gate-red': 'world',
  'github-gate-timeout': 'world',
  'ham-commit-identity-unlinked': 'world',
  'head-changed': 'world',
  'launch-ended': 'world',
  'lease-state-unavailable': 'world',
  'merge-action-failed': 'world',
  'merge-lease-admission-refused': 'world',
  'merge-lease-lost': 'world',
  'merge-lease-not-held': 'world',
  'merge-lease-owner-shell-required': 'world',
  'merge-lease-release-unconfirmed': 'world',
  'merge-refused': 'world',
  'merged': 'world',
  'merge-retry-budget-exhausted': 'world',
  'targeted-validation-failed': 'world',
  'operator-cancelled': 'world',
  'predicate-not-eligible': 'world',
  'protective-predecessor-open': 'world',
  'protective-predecessor-state-unreadable': 'world',
  'predicate-input-malformed': 'world',
  'predicate-input-refresh-failed': 'world',
  'protection-branch-not-found': 'world',
  'protection-read-failed': 'world',
  'timeline-read-failed': 'world',
  'commit-read-failed': 'world',
  'primary-change-reverted': 'world',
  'primary-change-unknown': 'world',
  'rebase-attempt-cap-exceeded': 'world',
  'rebase-conflict': 'world',
  'rebase-result-unproven': 'world',
  'rebase-target-changed': 'world',
  'retry-predicate-not-eligible': 'world',
  'reversal-not-authorized': 'world',
  'review-evidence-invalid': 'world',
  'stale-review-head': 'world',
  'validation-failed': 'world',
  'verdict-not-eligible': 'world',
  'verdict-not-settled-success': 'world',
  'protective-predecessor-malformed-trailer': 'world',
  'base-changed-file-overlap': 'world',
  'blocking-findings-present': 'world',
  'blocking-findings-unknown': 'world',
  'non-blocking-findings-present': 'world',
  'non-blocking-findings-unknown': 'world',
  'review-currency-unproven': 'world',
  'permanent-merge-rejection': 'world',
  'audit-attestation-record-failed': 'closer',
  'audit-comment-unavailable': 'closer',
  'controller-setup-failed': 'closer',
  'conflict-sync-failed': 'closer',
  'claim-build-failed': 'closer',
  'hammer-verify-head-failed': 'closer',
  'hammer-publish-failed': 'closer',
  'hammer-merge-failed': 'closer',
  'controller-shell-ended': 'closer',
  'dispatch-inputs-missing': 'closer',
  'dispatch-phase-scripts-missing': 'closer',
  'hammer-command-error': 'closer',
  'hammer-publish-error': 'closer',
  'helper-input-invalid': 'closer',
  'helper-kind-mismatch': 'closer',
  'helper-step-unavailable': 'closer',
  'invalid-pr-context-request': 'closer',
  'invalid-pr-reference': 'closer',
  'invalid-procedure-request': 'closer',
  'merge-error': 'closer',
  'merge-lease-acquire-failed': 'closer',
  'merge-lease-admission-failed': 'closer',
  'merge-lease-deferral-audit-failed': 'closer',
  'merge-lease-id-missing': 'closer',
  'merge-lease-probe-directory-failed': 'closer',
  'node-runtime-unavailable': 'closer',
  'pending-attestation-unavailable': 'closer',
  'persistent-shell-setup-failed': 'closer',
  'pr-context-unavailable': 'closer',
  'procedure-render-failed': 'closer',
  'procedure-stalled': 'closer',
  'procedure-step-failed': 'closer',
  'predicate-input-request-invalid': 'closer',
  'published-head-probe-directory-failed': 'closer',
  'published-head-snapshot-write-failed': 'closer',
  'published-head-sync-failed': 'closer',
  'pushed-attestation-unavailable': 'closer',
  'rebase-snapshot-write-failed': 'closer',
  'rebased-head-sync-failed': 'closer',
  'reviewed-head-unavailable': 'closer',
  'starting-pr-state-unavailable': 'closer',
  'stop-reason-unregistered': 'closer',
  'update-branch-failed': 'closer',
  'validation-command-invalid': 'closer',
  'validation-config-failed': 'closer',
  'validation-environment-failed': 'closer',
  ...Object.fromEntries([...HAMMER_INFRASTRUCTURE_OUTCOMES].map(reason => [reason, 'infrastructure'])),
  // Command construction belongs to the closer even though older read wrappers
  // already deferred it.
  'hammer-command-error': 'closer',
});

export function hammerStopOrigin(reason) {
  const [code, diagnostic] = String(reason || '').split(':');
  if (code === 'review-evidence-invalid'
    && HAMMER_EDIT_PLAN_ERROR_ORIGINS[diagnostic] === 'plan') return 'closer';
  if (!Object.hasOwn(HAMMER_STOP_ORIGINS, code)) throw new TypeError(`Unregistered hammer stop reason: ${code}`);
  return HAMMER_STOP_ORIGINS[code];
}

export function closerHelperError(reason, message) {
  if (!HAMMER_CLOSER_FAULTS.has(reason)) throw new TypeError('Not a closer fault');
  return Object.assign(new Error(message), { phaseOutcome: reason });
}

export function worldFactError(reason, message) {
  if (hammerStopOrigin(reason) !== 'world') throw new TypeError('Not a world fact');
  return Object.assign(new Error(message), { phaseOutcome: reason });
}

export const HAMMER_CLOSER_FAULTS = new Set(Object.keys(HAMMER_STOP_ORIGINS)
  .filter(reason => HAMMER_STOP_ORIGINS[reason] === 'closer'));

// One correction per operation in the private controller run, across helper
// processes. Never replay a mutation here: exit 21 asks its caller to re-plan.
export function closerFaultRecovery(reason, { env = process.env, operation = reason } = {}) {
  if (!HAMMER_CLOSER_FAULTS.has(reason)) throw new TypeError('Not a closer fault');
  if (!env.HAM_RUN_DIR) return 'defer';
  const file = join(env.HAM_RUN_DIR, 'self-error-corrections.json');
  let corrections;
  try { corrections = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') return 'defer'; corrections = {}; }
  if (!corrections || typeof corrections !== 'object' || Array.isArray(corrections)
    || Object.values(corrections).some(value => !HAMMER_CLOSER_FAULTS.has(value))) return 'defer';
  if (Object.hasOwn(corrections, operation)
    || (operation === reason && Object.values(corrections).includes(reason))) return 'defer';
  try { writeFileAtomic(file, `${JSON.stringify({ ...corrections, [operation]: reason })}\n`, { mode: 0o600 }); }
  catch { return 'defer'; }
  return 'correct';
}
