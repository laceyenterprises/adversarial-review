// MRQ-11: fixed v2 reasons shared by the workflow decision (producer) and the
// shadow pattern vocabulary (keying). A leaf module: no imports, no I/O.

// D8: typed unknown live observations, in precedence order. A missing or
// regressed fact is a refresh on an explicit cause; it never borrows earlier
// evidence and never folds to an error.
export const LIVE_EVIDENCE_UNKNOWN_REASONS = Object.freeze({
  'out-of-order-snapshot': 'live evidence unknown: out-of-order snapshot',
  'snapshot-translation-error': 'live evidence unknown: snapshot translation error',
  'snapshot-observation-error': 'live evidence unknown: snapshot observation error',
  'launch-ownership-unreadable': 'live evidence unknown: launch ownership unreadable',
  'checks-evidence-regressed': 'live evidence unknown: checks evidence regressed at settled head',
  'verdict-evidence-regressed': 'live evidence unknown: verdict evidence regressed at recorded verdict head',
});

// D3: findings only an operator label can waive. No agent can remediate them.
export const OPERATOR_DECISION_REASON = 'operator decision required: findings gated on an operator label';
