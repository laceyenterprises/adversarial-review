/** Value-free first-failure codes; the refusal helper enforces the runtime allow-list. */
export type HammerReviewEvidenceDiagnostic =
  | 'run-pin-invalid'
  | 'plan-invalid'
  | 'plan-head-invalid'
  | 'review-missing'
  | 'review-head-mismatch'
  | 'reviewer-untrusted'
  | 'review-state-invalid';

export type HammerReviewEvidenceRefusal = {
  action: 'stop';
  reason: 'review-evidence-invalid';
  diagnostic: HammerReviewEvidenceDiagnostic;
};
