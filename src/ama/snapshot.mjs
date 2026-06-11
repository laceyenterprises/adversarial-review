import { isNoneFindingsSentinelOnly, parseBlockingFindingsSection } from '../kernel/remediation-reply.mjs';

function normalizeVerdict(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeScopedLabelEvidence(event) {
  if (!event) return null;
  return {
    applied: true,
    observedRevisionRef: event.headSha || event.head_sha || event.observedRevisionRef || event.commit_id || null,
    actor: event.actor?.login || event.actor || null,
    eventId: event.id || event.nodeId || event.node_id || null,
    observedAt: event.createdAt || event.created_at || null,
  };
}

function classifyBlockingFindings(reviewBody, { lastVerdict = null } = {}) {
  const parsed = parseBlockingFindingsSection(reviewBody);
  if (parsed && parsed.length > 0) {
    return { count: parsed.length, state: 'known' };
  }
  const match = String(reviewBody ?? '').match(/##\s+Blocking\s+Issues?\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  const normalizedVerdict = normalizeVerdict(lastVerdict);
  if (!match) {
    return normalizedVerdict === 'request-changes'
      ? { count: 0, state: 'unknown' }
      : { count: 0, state: 'known' };
  }
  const section = match[1].trim();
  if (!section) return { count: 0, state: 'known' };
  return isNoneFindingsSentinelOnly(section)
    ? { count: 0, state: 'known' }
    : { count: 1, state: 'known' };
}

function deriveRemediationPending({ verdict, blockingFindingCount, blockingFindingState }) {
  if (normalizeVerdict(verdict) === 'request-changes') return true;
  if (String(blockingFindingState || '').trim().toLowerCase() !== 'known') return true;
  return Number(blockingFindingCount) > 0;
}

function buildAmaReviewStateFromDispatchJob({
  dispatchJob,
  currentRevisionRef = null,
  operatorApprovalEvent = null,
  remediationPending = null,
} = {}) {
  const headSha = dispatchJob?.headSha || currentRevisionRef || null;
  return {
    verdict: normalizeVerdict(dispatchJob?.lastVerdict),
    headSha,
    riskClass: String(dispatchJob?.riskClass || 'unknown').toLowerCase(),
    remediationPending: typeof remediationPending === 'boolean'
      ? remediationPending
      : Boolean(dispatchJob?.latestFollowUpJobStatus && dispatchJob.latestFollowUpJobStatus !== 'completed'),
    operatorApprovedEvidence: normalizeScopedLabelEvidence(operatorApprovalEvent),
    blockingFindingCount: Number.isFinite(Number(dispatchJob?.blockingFindingCount))
      ? Number(dispatchJob.blockingFindingCount)
      : 0,
    blockingFindingState: dispatchJob?.blockingFindingState || 'unknown',
    prAuthor: dispatchJob?.prAuthor || null,
  };
}

function buildAmaPrMetadata({
  prNumber,
  headSha,
  prState,
  isDraft = false,
  mergeableState,
  labels = [],
  statusCheckRollup = [],
  requiredContexts = [],
  author = null,
} = {}) {
  return {
    prNumber: Number(prNumber),
    headSha: headSha || null,
    isOpen: String(prState || 'open').toLowerCase() === 'open',
    isDraft: Boolean(isDraft),
    mergeableState: String(mergeableState || '').toUpperCase(),
    labels: Array.isArray(labels) ? labels : [],
    statusCheckRollup: Array.isArray(statusCheckRollup) ? statusCheckRollup : [],
    branchProtection: { requiredContexts: Array.isArray(requiredContexts) ? requiredContexts : [] },
    author,
  };
}

function pickLatestReviewForHead(reviews = [], reviewedSha) {
  const reviewsForHead = reviews.filter((review) => review?.commit?.oid === reviewedSha);
  return reviewsForHead
    .slice()
    .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))[0]
    || null;
}

function latestLabeledFor(timeline = [], labelName) {
  return timeline
    .filter((event) => event?.event === 'labeled' && String(event?.label?.name || '').toLowerCase() === labelName)
    .slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0]
    || null;
}

function buildAmaReviewSnapshotFromCloserInputs({
  reviewsJson,
  prJson,
  timelineJson,
  reviewedSha,
  riskClass,
} = {}) {
  const reviews = Array.isArray(reviewsJson?.reviews) ? reviewsJson.reviews : [];
  const timeline = Array.isArray(timelineJson) ? timelineJson : [];
  const latest = pickLatestReviewForHead(reviews, reviewedSha);
  if (!latest) {
    return {
      reviewState: {
        verdict: '',
        headSha: reviewedSha,
        riskClass,
        remediationPending: true,
        operatorApprovedEvidence: normalizeScopedLabelEvidence(latestLabeledFor(timeline, 'operator-approved')),
        blockingFindingCount: 0,
        blockingFindingState: 'unknown',
        prAuthor: prJson?.author?.login || null,
        reviewerFamily: null,
      },
      options: {
        adversarialMergeRequested: normalizeScopedLabelEvidence(latestLabeledFor(timeline, 'adversarial-merge-requested')),
      },
    };
  }
  const ghState = String(latest?.state || '').toUpperCase();
  const verdictMap = {
    APPROVED: 'approved',
    COMMENTED: 'comment-only',
    CHANGES_REQUESTED: 'request-changes',
  };
  const verdict = verdictMap[ghState] || normalizeVerdict(latest?.state);
  const blockingFindings = classifyBlockingFindings(latest?.body || '', { lastVerdict: verdict });
  const reviewState = {
    verdict,
    headSha: reviewedSha,
    riskClass,
    remediationPending: deriveRemediationPending({
      verdict,
      blockingFindingCount: blockingFindings.count,
      blockingFindingState: blockingFindings.state,
    }),
    operatorApprovedEvidence: normalizeScopedLabelEvidence(latestLabeledFor(timeline, 'operator-approved')),
    blockingFindingCount: blockingFindings.count,
    blockingFindingState: blockingFindings.state,
    prAuthor: prJson?.author?.login || null,
    reviewerFamily: latest?.author?.login || null,
  };
  const options = {
    adversarialMergeRequested: normalizeScopedLabelEvidence(latestLabeledFor(timeline, 'adversarial-merge-requested')),
  };
  return { reviewState, options };
}

export {
  buildAmaPrMetadata,
  buildAmaReviewSnapshotFromCloserInputs,
  buildAmaReviewStateFromDispatchJob,
  classifyBlockingFindings,
  normalizeScopedLabelEvidence,
};
