import { parseBlockingFindingsSection, parseNonBlockingFindingsSection } from '../kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { amaAllAuthoritativeReviewerLogins } from './reviewer-authority.mjs';
import { checkReversalFinding } from './reversal-finding.mjs';

export const HAMMER_REVIEW_EVIDENCE_DIAGNOSTICS = Object.freeze([
  'run-pin-invalid',
  'plan-invalid',
  'plan-head-invalid',
  'review-missing',
  'review-head-mismatch',
  'reviewer-untrusted',
  'review-state-invalid',
]);

/**
 * @param {import('./hammer-edit-plan-contracts.js').HammerReviewEvidenceDiagnostic} diagnostic
 * @returns {import('./hammer-edit-plan-contracts.js').HammerReviewEvidenceRefusal}
 */
export function refuseHammerReviewEvidence(diagnostic) {
  if (!HAMMER_REVIEW_EVIDENCE_DIAGNOSTICS.includes(diagnostic)) {
    throw new TypeError('Unknown hammer review evidence diagnostic');
  }
  return { action: 'stop', reason: 'review-evidence-invalid', diagnostic };
}

export function checkHammerEditPlan(review, plan, { strictNonBlockingRemediation = false } = {}) {
  const refuse = reason => ({ action: 'stop', reason });
  const correct = (reason, expectedShape, prefix = 'Do not edit. Correct the plan once: ') => ({
    action: 'correct', reason, message: `${prefix}${expectedShape}` });
  const locationValid = () => typeof plan.path === 'string' && plan.path.trim()
    && Number.isSafeInteger(plan.startLine) && Number.isSafeInteger(plan.endLine)
    && plan.startLine >= 1 && plan.endLine >= plan.startLine;
  if (!review) return refuseHammerReviewEvidence('review-missing');
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return refuseHammerReviewEvidence('plan-invalid');
  if (typeof plan.reviewedHead !== 'string' || !/^[a-f0-9]{40}$/i.test(plan.reviewedHead)) {
    return refuseHammerReviewEvidence('plan-head-invalid');
  }
  if (review.commit_id !== plan.reviewedHead) return refuseHammerReviewEvidence('review-head-mismatch');
  if (!amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))) {
    return refuseHammerReviewEvidence('reviewer-untrusted');
  }
  if (!['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(review.state)) {
    return refuseHammerReviewEvidence('review-state-invalid');
  }
  const parsed = { verdict: normalizeEffectiveReviewVerdict(review.body),
    findings: { blocking: parseBlockingFindingsSection(review.body),
      'non-blocking': parseNonBlockingFindingsSection(review.body) } };
  if (!['request-changes', 'approved', 'comment-only'].includes(parsed.verdict)) return refuse('finding-evidence-invalid');
  const uncitedCiRepair = plan.kind === undefined && plan.findingNumber === undefined && plan.requiredCiRepair === true;
  if (uncitedCiRepair) {
    if (plan.editKind !== 'in-place') {
      return correct('edit-kind-invalid', 'editKind must be in-place for uncited CI repairs.');
    }
    if (plan.editKind === 'in-place') {
      if (!locationValid()) return correct('edit-location-invalid',
        'supply a nonempty path and integer reviewed coordinates 1 <= startLine <= endLine.');
      return { action: 'allow', reason: 'in-place-repair' };
    }
  }
  if (!['blocking', 'non-blocking'].includes(plan.kind)
    || !Number.isSafeInteger(plan.findingNumber) || plan.findingNumber < 1
    || !parsed.findings[plan.kind]?.[plan.findingNumber - 1]) return refuse('finding-evidence-invalid');
  if (!['author-lines', 'additive', 'in-place'].includes(plan.editKind)) {
    return correct('edit-kind-invalid', 'editKind must be author-lines, additive or in-place.');
  }
  if (plan.kind === 'non-blocking' && plan.editKind === 'in-place') {
    return correct('edit-kind-invalid',
      'allowed editKinds for kind=non-blocking are additive|author-lines (author-lines only where checkReversalFinding authorizes)',
      'correctable: ');
  }
  const admissible = checkReversalFinding(parsed, plan.kind, plan.findingNumber, strictNonBlockingRemediation);
  if (plan.editKind !== 'additive' && !admissible.ok) {
    return { action: plan.kind === 'non-blocking' && admissible.reason === 'finding-kind-not-authorizing'
      ? 'defer' : 'stop', reason: admissible.reason };
  }
  if (plan.requiredCiRepair === true) return correct('edit-kind-invalid',
    'use the cited repair shape without requiredCiRepair; retain kind and findingNumber.');
  // Additive means no existing author line is removed, replaced or neutralized.
  if (plan.editKind === 'additive') return { action: 'allow', reason: 'additive-fix' };
  if (plan.editKind === 'in-place') {
    // Redundant today: retain this safety check against future dispatch changes.
    if (plan.kind !== 'blocking') return refuse('edit-kind-invalid');
    if (!locationValid()) return correct('edit-location-invalid',
      'supply a nonempty path and integer reviewed coordinates 1 <= startLine <= endLine.');
    return { action: 'allow', reason: 'in-place-repair' };
  }
  if (!locationValid()) return correct('edit-location-invalid',
    'supply a nonempty path and integer reviewed coordinates 1 <= startLine <= endLine.');
  if (!admissible.locations.some(location => location.path === plan.path
      && location.ranges.some(range => range.start <= plan.startLine && range.end >= plan.endLine))) {
    const ranges = admissible.locations.flatMap(location => location.ranges.map(range =>
      `${location.path}:${range.start}-${range.end}`)).join(', ');
    return correct('not-covered-by-cited-finding',
      `plan region ${plan.path}:${plan.startLine}-${plan.endLine} is outside the cited finding's ranges ${ranges}; re-plan within a cited range, or as editKind=additive if no existing author line is removed or replaced`,
      'correctable: ');
  }
  return { action: 'allow', reason: 'finding-authorizes-planned-region' };
}
