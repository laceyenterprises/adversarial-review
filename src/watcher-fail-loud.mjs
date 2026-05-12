import { buildMalformedTitleFailureComment } from './watcher-title-guardrails.mjs';
import { createGitHubPRCommentsAdapter } from './adapters/comms/github-pr-comments/index.mjs';
import { buildDeliveryKey } from './identity-shapes.mjs';

<<<<<<< HEAD
async function signalMalformedTitleFailure(octokit, { repoPath, owner, repo, prNumber, prTitle, revisionRef = 'unknown', rootDir = null }) {
=======
function requireRevisionRef(revisionRef, context) {
  const normalized = String(revisionRef || '').trim();
  if (!normalized) {
    throw new TypeError(`${context} requires a revisionRef`);
  }
  return normalized;
}

async function signalMalformedTitleFailure(octokit, { repoPath, owner, repo, prNumber, prTitle, revisionRef, rootDir = null }) {
  const normalizedRevisionRef = requireRevisionRef(revisionRef, 'signalMalformedTitleFailure');
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
  const structuredFailure = {
    repo: repoPath,
    prNumber,
    title: prTitle,
    reason: 'missing-or-invalid-creation-time-reviewer-tag',
  };
  console.error(`[watcher] MALFORMED_PR_TITLE ${JSON.stringify(structuredFailure)}`);

  const body = buildMalformedTitleFailureComment({ prTitle });
  const deliveryKey = buildDeliveryKey({
    repo: repoPath,
    prNumber,
<<<<<<< HEAD
    revisionRef,
=======
    revisionRef: normalizedRevisionRef,
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
    round: 0,
    kind: 'operator-notice',
    noticeRef: 'malformed-title',
  });
  const adapter = createGitHubPRCommentsAdapter({ octokit, rootDir });

  try {
    await adapter.postOperatorNotice(
      {
        type: 'halted',
        subjectRef: {
          domainId: deliveryKey.domainId,
          subjectExternalId: deliveryKey.subjectExternalId,
          revisionRef: deliveryKey.revisionRef,
        },
        revisionRef: deliveryKey.revisionRef,
        eventExternalId: 'malformed-title',
        observedAt: new Date().toISOString(),
        reason: structuredFailure.reason,
      },
      body,
      deliveryKey
    );
    console.error(`[watcher] Fail-loud comment posted for ${repoPath}#${prNumber}`);
  } catch (err) {
    console.error(`[watcher] Failed to post malformed-title comment for ${repoPath}#${prNumber}:`, err.message);
  }
}

export {
  signalMalformedTitleFailure,
};
