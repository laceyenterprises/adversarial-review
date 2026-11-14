// Exact, versioned classes. Unknown/dynamic text is deliberately unkeyable:
// never collapse new evidence, identifiers or error messages into a wildcard.
import { V1_ACTION_KINDS, v2DecisionBucket } from './shadow-actions.mjs';

const DETAILS = new Set([
  null,
  'hammer:live-owner', 'remediate:live-owner', 'review:live-owner',
  'hammer:dispatched', 'hammer:review-findings-final', 'remediate:review-findings',
  'hammer:ci-red-final', 'remediate:ci-red', 'daemon-merge:clean-exact-head',
]);
const REASONS = new Set([
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
]);

export function shadowPatternKey(observation) {
  const { v1Action: v1, v2Decision: v2 } = observation;
  if (!V1_ACTION_KINDS.includes(v1?.kind) || !v2DecisionBucket(v2?.kind)
    || !DETAILS.has(v1?.detail ?? null) || !REASONS.has(v2?.reason)) return null;
  return JSON.stringify(['shadow-pattern-v1', v1.kind, v1.detail ?? null, v2.kind, v2.reason]);
}
