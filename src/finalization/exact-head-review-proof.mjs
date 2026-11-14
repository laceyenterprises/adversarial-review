import { isRemediationRoundBudgetSpent } from '../remediation-round-recovery.mjs';

export function isFinalRemediatorHead(proof, subject, head) {
  return subject?.domainId === 'code-pr' && proof?.suppressed === true
    && proof.headSha === head && /^[0-9a-f]{40}$/iu.test(head)
    && `${proof.repo}#${proof.prNumber}` === subject.subjectExternalId
    && typeof proof.jobId === 'string' && proof.jobId.length > 0
    && typeof proof.sourceRef === 'string' && proof.sourceRef.length > 0
    && isRemediationRoundBudgetSpent(proof);
}

export const exactHeadReviewRequestId = head => `final-remediator-review:${head}`;
