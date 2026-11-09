import { parseBlockingFindingsSection, parseNonBlockingFindingsSection } from '../kernel/review-findings.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { amaAllAuthoritativeReviewerLogins } from './reviewer-authority.mjs';
import { checkReversalFinding } from './reversal-finding.mjs';

export function checkHammerEditPlan(review, plan, { strictNonBlockingRemediation = false } = {}) {
  const refuse = reason => ({ action: 'stop', reason });
  const correct = (reason, expectedShape) => ({ action: 'correct', reason,
    message: `Do not edit. Correct the plan once: ${expectedShape}` });
  const locationValid = () => typeof plan.path === 'string' && plan.path.trim()
    && Number.isSafeInteger(plan.startLine) && Number.isSafeInteger(plan.endLine)
    && plan.startLine >= 1 && plan.endLine >= plan.startLine;
  if (!review || !plan || !/^[a-f0-9]{40}$/i.test(plan.reviewedHead || '')
    || review.commit_id !== plan.reviewedHead
    || !amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))
    || !['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(review.state)) {
    return refuse('review-evidence-invalid');
  }
  const parsed = { verdict: normalizeEffectiveReviewVerdict(review.body),
    findings: { blocking: parseBlockingFindingsSection(review.body),
      'non-blocking': parseNonBlockingFindingsSection(review.body) } };
  if (!['request-changes', 'approved', 'comment-only'].includes(parsed.verdict)) return refuse('finding-evidence-invalid');
  const uncitedCiRepair = plan.kind === undefined && plan.findingNumber === undefined && plan.requiredCiRepair === true;
  if (uncitedCiRepair) {
    if (!['author-lines', 'additive', 'in-place'].includes(plan.editKind)) {
      return correct('edit-kind-invalid', 'editKind must be author-lines, additive or in-place.');
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
  // Additive means no existing author line is removed, replaced or neutralized.
  if (plan.editKind === 'additive') return { action: 'allow', reason: 'additive-fix' };
  const admissible = checkReversalFinding(parsed, plan.kind, plan.findingNumber, strictNonBlockingRemediation);
  if (!admissible.ok) {
    return { action: plan.kind === 'non-blocking' && admissible.reason === 'finding-kind-not-authorizing'
      ? 'defer' : 'stop', reason: admissible.reason };
  }
  if (plan.editKind === 'in-place') {
    if (plan.requiredCiRepair === true) return correct('edit-kind-invalid',
      'use the cited repair shape without requiredCiRepair; retain kind and findingNumber.');
    if (plan.kind !== 'blocking') return refuse('edit-kind-invalid');
    if (!locationValid()) return correct('edit-location-invalid',
      'supply a nonempty path and integer reviewed coordinates 1 <= startLine <= endLine.');
    return { action: 'allow', reason: 'in-place-repair' };
  }
  if (!locationValid()) return correct('edit-location-invalid',
    'supply a nonempty path and integer reviewed coordinates 1 <= startLine <= endLine.');
  if (!admissible.locations.some(location => location.path === plan.path
      && location.ranges.some(range => range.start <= plan.startLine && range.end >= plan.endLine))) {
    return refuse('not-covered-by-cited-finding');
  }
  return { action: 'allow', reason: 'finding-authorizes-planned-region' };
}
