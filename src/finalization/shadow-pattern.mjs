// Exact, versioned classes. Unknown/dynamic text is deliberately unkeyable:
// never collapse new evidence, identifiers or error messages into a wildcard.
import { V1_ACTION_KINDS, v2DecisionBucket } from './shadow-actions.mjs';

const DETAILS = new Set([
  null,
  // src/pr-next-action.mjs: fixed row and bounded builder-handoff pairs.
  'hammer:live-owner', 'remediate:live-owner', 'review:live-owner',
  'hammer:dispatched', 'hammer:review-findings-final', 'remediate:review-findings',
  'hammer:ci-red-final', 'remediate:ci-red', 'daemon-merge:clean-exact-head',
  'done:merged', 'done:closed',
  'operator-hold:hold-label', 'operator-hold:draft', 'operator-hold:merge-execution-disabled',
  'remediate:repair-in-place-owned', 'remediate:conflict-primary-unproven', 'remediate:final-fix-all',
  'hammer:ownership-unreadable', 'hammer:lease-expired', 'hammer:empty-diff-close',
  'hammer:safety-refusal', 'hammer:primary-change-unreadable', 'hammer:primary-change-repair',
  'hammer:merge-receipt-unconfirmed', 'daemon-merge:merge-receipt-unconfirmed',
  'hammer:automated-stop', 'hammer:conflict-rebase', 'hammer:operator-approval-applied',
  'hammer:lifetime-exhausted', 'hammer:retry-exhausted', 'hammer:hammer-final-no-merge',
  'hammer:required-checks-resume', 'hammer:retry-no-merge', 'hammer:ci-runnerless',
  'hammer:ci-red-clean-verdict', 'hammer:suppressed-final-push', 'hammer:daemon-failed-closed',
  'hammer:review-ceiling', 'hammer:hammer-owned-head', 'daemon-merge:carried-clean-head',
  'review:attestation-invalid', 'review:exact-head-review', 'review:handed-to-review', 'review:stale-verdict',
  'wait-for-CI:pr-unknown', 'wait-for-CI:policy-unknown', 'wait-for-CI:structural-restriction-pending',
  'wait-for-CI:ci-infrastructure', 'wait-for-CI:ci-infrastructure-evidence-pending',
  'wait-for-CI:checks-pending', 'wait-for-CI:checks-unknown', 'wait-for-CI:mergeability-unknown',
  'wait-for-CI:rounds-unknown', 'wait-for-CI:reviews-unknown', 'wait-for-CI:verdict-unknown',
  'wait-for-CI:snapshot-refresh', 'wait-for-CI:attestation-unknown', 'wait-for-CI:snapshot-malformed',
  // src/pr-next-action-consumer.mjs: fixed legacy closure and posted-review outcomes.
  'daemon-merge:merged-this-pass', 'remediate:clean-review-drain',
  'operator-hold:retry-exhausted', 'operator-hold:lifetime-exhausted',
  'operator-hold:primary-change-repair', 'operator-hold:lease-expired',
  'operator-hold:checks-pending', 'operator-hold:review-findings-final',
  'operator-hold:needs-operator', 'operator-hold:operator-decision-required', 'done:terminal-observed',
]);
const REASONS = new Set([
  // src/finalization/eligibility.mjs: fixed eligibility reasons.
  'no revision advanced yet', 'no verdict at current revision',
  'verdict patience expired at current revision', 'verdict indeterminate past patience',
  'verdict indeterminate at current revision', 'checks patience expired',
  'checks not yet settled at current revision', 'required checks not yet present at current revision',
  'required checks still running at current revision', 'attestation patience expired',
  'blocking review finding at current revision',
  'non-blocking comments must be addressed before merge (strict_mode)',
  'clean verdict, green checks at current revision', 'final remediation in progress',
  'final remediation did not conclude within patience',
  'final coverage-gated remediation (budget exhausted; addresses all comments before merge)',
  'exhaustion final remediation reached validated full coverage',
  'remediation budget exhausted; exhaustion-always-closes disabled',
  // src/finalization/workflow-decision.mjs (actors closed by finalization/live-owner.mjs).
  'live-owner: hammer holds an unexpired lease',
  'live-owner: remediator holds an unexpired lease',
  'merge and delivery verified', 'merged; post-merge activation pending', 'autonomous execution disabled',
  'unknown safety-relevant event', 'terminal launch retains dirty workspace',
  'workspace release requires exact holder evidence', 'launch observation expired',
  'verified launch in progress', 'launch requires verified progress',
  'worker kill requires effect reconciliation', 'operation effect requires readback',
  'primary-change evidence unknown', 'conflict requires owned repair', 'mergeability unknown',
  'remediation admission or completion pending', 'awaiting verdict for requested final remediator head',
  'final remediator head requires strict exact-head review',
  'failed final remediation requires recovery', 'primary-change provenance unavailable',
]);

export function shadowPatternKey(observation) {
  const { v1Action: v1, v2Decision: v2 } = observation;
  if (!V1_ACTION_KINDS.includes(v1?.kind) || !v2DecisionBucket(v2?.kind)
    || !DETAILS.has(v1?.detail ?? null) || !REASONS.has(v2?.reason)) return null;
  return JSON.stringify(['shadow-pattern-v1', v1.kind, v1.detail ?? null, v2.kind, v2.reason]);
}
