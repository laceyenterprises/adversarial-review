// HAMSELFERRORS-01: the world-fact stop rule. Classification grants no edit,
// lease or merge authority. Registration documents a code's origin; an
// unregistered code is an infrastructure stop (MRQ-02), never a closer fault
// that ends a launch as a silent success.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic-write.mjs';
import { SOCKET_PATH_HARNESS_FAULT } from '../harness-fault.mjs';

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
  'canonical-validation-deferred',
  'node-pin-unavailable',
  // The counted socket-path stop is registered below with the world outcomes.
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
  // STOPREASONREG-01: observation, transport and helper deadlines may recover.
  'conflict-pr-read-failed',
  'conflict-source-unavailable',
  'conflict-base-unavailable',
  'checkout-timeout',
  'live-head-read-failed',
  'pr-mergeability-unknown',
  'withdrawn-review-dismissal-failed',
  'terminal-review-evidence-unavailable',
  // HAMWRITERTIMEOUT-01: the in-lane review-proof read used up its deadline.
  // That is a transport/observation deadline, not a fact about the PR: no
  // merge was invoked, so the same head is retried under a fresh lease.
  'legacy-writer-timeout',
  'legacy-writer-preflight-refused',
  'merge-writer-audit-unreadable',
  // MRQ-02: the durable reason of a stop whose own code is unregistered. The
  // attempt keeps the original code in originalReason and reasonDetail; the
  // stop rides the same owned retry as every other infrastructure deferral.
  'unregistered-stop-code',
  // MRQ-21: a queue-v2 handoff whose durable admission could not be confirmed.
  // Nothing merged; the same attested head is re-driven under a fresh lease.
  'queue-handoff-unadmitted',
  // The handoff step itself failed before naming an outcome; nothing merged.
  'queue-handoff-failed',
]);

// MRQ-21: emitted only by the queue-v2 close step, never by a rendered phase.
// Phase scripts omit them from their retryable list, so a legacy lane's
// rendered procedure stays byte-identical.
export const HAMMER_QUEUE_CONTROLLER_OUTCOMES = Object.freeze(['queue-handoff-unadmitted', 'queue-handoff-failed']);

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
  // STOPREASONREG-01: unresolved source/base conflicts, branch custody and
  // live merge gates do not become repairable by retrying the same head.
  'conflict-resolver-failed': 'world',
  'conflict-markers-pending': 'world',
  'conflict-source-not-fetched-head': 'world',
  'conflict-checkout-failed': 'world',
  'conflict-rebase-failed': 'world',
  'conflict-rebase-unfinished': 'world',
  'conflict-submodule-sync-failed': 'world',
  'checkout-failed': 'world',
  'builder-token-merge-refused': 'world',
  'live-head-moved-before-merge': 'world',
  'required-checks-pending': 'world',
  'retry-base-not-contained': 'world',
  'stacked-base-merged': 'world',
  'lane-busy': 'world',
  'merge-lease-timeout': 'world',
  'merge-not-confirmed': 'world',
  // An unresolved writer observation parks for readback, without a refund.
  'merge-writer-deferred': 'world',
  'merge-queue-pending': 'world',
  'unclassified-merge-failure': 'world',
  // Missing/corrupt private state and command construction can be corrected
  // by the closer; these are not evidence of an unresolvable PR conflict.
  'conflict-repair-helper-missing': 'closer',
  'conflict-state-missing': 'closer',
  'conflict-state-unwritable': 'closer',
  'audit-not-published': 'closer',
  'predicate-failed': 'closer',
  'merge-title-missing': 'closer',
  // HAMWRITERTIMEOUT-01: the writer could not read an explicit PR identity from
  // the merge command the closer built; command construction is the closer's.
  'merge-target-unparseable': 'closer',
  'commit-body-sanitization-failed': 'closer',
  'commit-body-decode-failed': 'closer',
  'commit-subject-decode-failed': 'closer',
  'commit-rewrites-decode-failed': 'closer',
  'local-validation-failed': 'world',
  'node-pin-undeclared': 'world',
  // Socket length faults can recur unchanged for the same head and host.
  // Keep the public diagnostic code and use the ordinary counted stop.
  [SOCKET_PATH_HARNESS_FAULT]: 'world',
  'review-changed-since-validation': 'world',
  'operator-review-changes-requested': 'world',
  'terminal-review-issuer-unverifiable': 'world',
  'already-merged': 'world',
  // MRQ-21: the queue-v2 handoff found the PR closed without a merge.
  'pr-closed': 'world',
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
  'review-handoff-unconfirmed': 'infrastructure',
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
  'needs-rebase-repair': 'world',
  'conflict-state-unwritable': 'infrastructure',
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
  // HAMCONTROLLERSCRIPT-01: the shipped close command's own data/build stops.
  'close-plan-invalid': 'closer',
  'predicate-build-failed': 'closer',
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
  'source-publication-refused': 'closer',
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
  // Older read wrappers deferred command errors. Command construction belongs to the closer.
  ...Object.fromEntries(Array.from(HAMMER_INFRASTRUCTURE_OUTCOMES, reason =>
    [reason, reason === 'hammer-command-error' ? 'closer' : 'infrastructure'])),
});

export const UNREGISTERED_STOP_CODE = 'unregistered-stop-code';
export const STOP_CODE_UNREGISTERED_EVENT = 'ama_closer.stop_code_unregistered';
const STOP_CODE = /^[a-z][a-z0-9-]*$/;

/** The registered origin, or null for an unregistered or malformed reason. No side effects. */
export function registeredHammerStopOrigin(reason) {
  if (reason === SOCKET_PATH_HARNESS_FAULT) return HAMMER_STOP_ORIGINS[reason];
  const [code, diagnostic] = String(reason || '').split(':');
  if (code === 'history-read-failed' && diagnostic === 'permanent') return 'world';
  if (code === 'review-evidence-invalid'
    && HAMMER_EDIT_PLAN_ERROR_ORIGINS[diagnostic] === 'plan') return 'closer';
  return Object.hasOwn(HAMMER_STOP_ORIGINS, code) ? HAMMER_STOP_ORIGINS[code] : null;
}

// One alert per unregistered code per UTC day. The process set suppresses
// repeats for the active day; the alert outbox keys (code, day) durably.
const alertedUnregisteredCodes = new Set();
let alertedUnregisteredDay;
function defaultUnregisteredStopCodeSink({ code, day }) {
  // Offline tests inject a sink; they never queue a real alert.
  if (process.env.NODE_TEST_CONTEXT) return;
  import('../alert-delivery.mjs')
    .then(({ deliverAlert }) => deliverAlert(
      `Closer stop code ${code} is not registered; it was retried as an infrastructure stop. `
        + 'Register its origin in the hammer stop-origin table.',
      { event: STOP_CODE_UNREGISTERED_EVENT, payload: { code, day } }))
    .catch(() => { /* Telemetry only: classification never fails on alert delivery. */ });
}
let unregisteredStopCodeSink = defaultUnregisteredStopCodeSink;

/** Test seam: replace the alert sink and reset the daily set. Returns a restore function. */
export function setUnregisteredStopCodeSink(sink) {
  const previous = unregisteredStopCodeSink;
  unregisteredStopCodeSink = typeof sink === 'function' ? sink : defaultUnregisteredStopCodeSink;
  alertedUnregisteredCodes.clear();
  return () => { unregisteredStopCodeSink = previous; alertedUnregisteredCodes.clear(); };
}

function noteUnregisteredStopCode(code, now) {
  const at = now instanceof Date ? now : new Date(now ?? Date.now());
  const day = (Number.isFinite(at.getTime()) ? at : new Date()).toISOString().slice(0, 10);
  if (day !== alertedUnregisteredDay) {
    alertedUnregisteredCodes.clear();
    alertedUnregisteredDay = day;
  }
  const key = `${day}|${code}`;
  if (alertedUnregisteredCodes.has(key)) return;
  alertedUnregisteredCodes.add(key);
  try { unregisteredStopCodeSink({ event: STOP_CODE_UNREGISTERED_EVENT, code, day }); }
  catch { /* Telemetry only. */ }
}

/**
 * Origin of a stop reason. MRQ-02: an unregistered but well-formed code is
 * `infrastructure` (retryable under the existing owned retry, no extra
 * credit) and alerts once per code per day. Only a malformed reason throws.
 */
export function hammerStopOrigin(reason, { now } = {}) {
  const origin = registeredHammerStopOrigin(reason);
  if (origin) return origin;
  const [code] = String(reason || '').split(':');
  if (!STOP_CODE.test(code)) throw new TypeError(`Malformed hammer stop reason: ${code}`);
  noteUnregisteredStopCode(code, now);
  return 'infrastructure';
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
