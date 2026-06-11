import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function amaAuditPath({ hqRoot, repo, prNumber, headSha }) {
  return join(
    hqRoot,
    'dispatch',
    'audit',
    'adversarial-merge-authority',
    `${repo.replace('/', '-')}-pr-${prNumber}-${headSha}.json`,
  );
}

function readAmaAuditRecord(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeAmaAuditRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8');
}

function buildAmaInProgressRecord({
  repo,
  prNumber,
  headSha,
  reviewState,
  prMetadata,
  dispatchContext,
  eligibilityReasons = [],
  now,
} = {}) {
  return {
    repo,
    prNumber,
    headSha,
    status: 'in_progress',
    attemptedAt: now,
    reviewedBy: dispatchContext?.reviewedBy || null,
    reviewSha: reviewState?.headSha || headSha,
    riskClass: reviewState?.riskClass || null,
    requiredGateContexts: prMetadata?.branchProtection?.requiredContexts || [],
    eligibilityReasons,
    authorizingEvidence: {
      verdict: reviewState?.verdict || null,
      blockingFindingCount: reviewState?.blockingFindingCount ?? null,
      blockingFindingState: reviewState?.blockingFindingState || null,
      remediationPending: reviewState?.remediationPending ?? null,
      operatorApprovedEvidence: reviewState?.operatorApprovedEvidence || null,
    },
    closerDispatch: null,
    attempts: [],
    reconciliation: {
      needsRepair: false,
      lastVerifiedAt: now,
    },
  };
}

export {
  amaAuditPath,
  buildAmaInProgressRecord,
  readAmaAuditRecord,
  writeAmaAuditRecord,
};
