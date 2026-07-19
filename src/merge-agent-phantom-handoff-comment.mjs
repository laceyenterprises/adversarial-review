import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { buildCodePrSubjectIdentity } from './identity-shapes.mjs';
import { createGitHubPRCommentsAdapter } from './adapters/comms/github-pr-comments/index.mjs';

const execFileAsync = promisify(execFile);

const PHANTOM_HANDOFF_COMMENT_TIMEOUT_MS = 10_000;
const PHANTOM_HANDOFF_COMMENT_MARKER_PREFIX = 'adversarial-review-merge-agent-phantom-handoff';

function buildPhantomHandoffCommentMarker(recordedDispatch) {
  const key = [
    String(recordedDispatch?.repo || ''),
    String(recordedDispatch?.prNumber || ''),
    String(recordedDispatch?.headSha || ''),
    String(recordedDispatch?.launchRequestId || ''),
  ].join(':');
  const digest = createHash('sha256').update(key).digest('hex');
  return `${PHANTOM_HANDOFF_COMMENT_MARKER_PREFIX}:${digest}`;
}

function buildPhantomHandoffEscalationCommentBody({ recordedDispatch, dispatchStatus } = {}) {
  const lrq = recordedDispatch?.launchRequestId || 'unknown';
  const marker = buildPhantomHandoffCommentMarker(recordedDispatch);
  return [
    `<!-- ${marker} -->`,
    '🛑 **merge-agent escalation — phantom handoff**',
    '',
    `The merge-agent dispatch \`${lrq}\` for this PR is terminal (\`${dispatchStatus}\`), but its`,
    '`merge-agent-dispatched` marker was cleared without a recovery worker taking ownership and',
    'without a `merge-agent-stuck` hand-off. So the automated merge path believed recovery owned',
    'this PR when nothing did, and it would otherwise sit behind `skip-already-dispatched`',
    'indefinitely. It has now been labeled `merge-agent-stuck` so it surfaces for operator action.',
    '',
    'To proceed: clear any standing review blockers, then either remove `merge-agent-stuck` and add',
    '`merge-agent-requested` to retry the merge-agent, or merge manually if the PR is safe.',
  ].join('\n');
}

function buildPendingPhantomHandoffCommentDelivery({ recordedDispatch, dispatchStatus, attemptedAt = null } = {}) {
  const body = buildPhantomHandoffEscalationCommentBody({ recordedDispatch, dispatchStatus });
  return {
    posted: false,
    reason: 'pending',
    attempts: 0,
    marker: buildPhantomHandoffCommentMarker(recordedDispatch),
    body,
    context: {
      repo: recordedDispatch?.repo || null,
      prNumber: Number(recordedDispatch?.prNumber) || null,
      revisionRef: recordedDispatch?.headSha || null,
      launchRequestId: recordedDispatch?.launchRequestId || null,
      dispatchStatus: dispatchStatus || null,
    },
    attemptedAt: attemptedAt || null,
  };
}

async function postPhantomHandoffEscalationComment({
  rootDir,
  recordedDispatch,
  dispatchStatus,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const revisionRef = String(recordedDispatch?.headSha || '').trim();
  if (!revisionRef) {
    return {
      posted: false,
      reason: 'missing-revision-ref',
      error: 'cannot post phantom-handoff escalation comment without a revisionRef',
    };
  }
  const subjectIdentity = buildCodePrSubjectIdentity({
    repo: recordedDispatch.repo,
    prNumber: recordedDispatch.prNumber,
    revisionRef,
  });
  const body = buildPhantomHandoffEscalationCommentBody({ recordedDispatch, dispatchStatus });
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    execFileImpl,
    env,
    commentTimeoutMs: PHANTOM_HANDOFF_COMMENT_TIMEOUT_MS,
    resolveGhToken: () => ({
      tokenEnvName: 'GITHUB_TOKEN',
      fallbackTokenEnvNames: ['GH_TOKEN'],
      allowGhAuthFallback: true,
    }),
  });
  try {
    const receipt = await adapter.postOperatorNotice(
      {
        type: 'merge-agent-phantom-handoff',
        subjectRef: {
          domainId: subjectIdentity.domainId,
          subjectExternalId: subjectIdentity.subjectExternalId,
          revisionRef: subjectIdentity.revisionRef,
        },
        revisionRef: subjectIdentity.revisionRef,
        eventExternalId: buildPhantomHandoffCommentMarker(recordedDispatch),
        observedAt: new Date().toISOString(),
      },
      body,
      {
        domainId: subjectIdentity.domainId,
        subjectExternalId: subjectIdentity.subjectExternalId,
        revisionRef: subjectIdentity.revisionRef,
        round: 0,
        kind: 'operator-notice',
        noticeRef: buildPhantomHandoffCommentMarker(recordedDispatch),
      }
    );
    return {
      posted: true,
      marker: buildPhantomHandoffCommentMarker(recordedDispatch),
      commentId: receipt.deliveryExternalId,
      body,
    };
  } catch (err) {
    return {
      posted: false,
      reason: err?.killed === true ? 'gh-cli-timeout' : 'gh-cli-failure',
      error: err?.message || String(err),
      marker: buildPhantomHandoffCommentMarker(recordedDispatch),
      body,
    };
  }
}

export {
  PHANTOM_HANDOFF_COMMENT_TIMEOUT_MS,
  PHANTOM_HANDOFF_COMMENT_MARKER_PREFIX,
  buildPhantomHandoffCommentMarker,
  buildPhantomHandoffEscalationCommentBody,
  buildPendingPhantomHandoffCommentDelivery,
  postPhantomHandoffEscalationComment,
};
