/** Value-free first-failure codes; never include review or plan content. */
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
