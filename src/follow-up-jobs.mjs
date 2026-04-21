import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FOLLOW_UP_JOB_SCHEMA_VERSION = 1;

function sanitizeRepo(repo) {
  return String(repo ?? '').replace(/\//g, '__').replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function sanitizeTimestamp(timestamp) {
  return String(timestamp ?? '').replace(/[:.]/g, '-');
}

function extractReviewSummary(reviewBody) {
  const text = String(reviewBody ?? '').trim();
  if (!text) return 'No review summary captured.';

  const match = text.match(/(?:^|\n)##\s+Summary\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }

  return text.slice(0, 1000);
}

function buildRecommendedFollowUpAction({ critical }) {
  return {
    type: 'address-adversarial-review',
    priority: critical ? 'high' : 'normal',
    summary: critical
      ? 'Start a follow-up coding session for this PR immediately and address the critical review findings first.'
      : 'Start a follow-up coding session for this PR and address the adversarial review findings.',
    futureArchitectureNote: 'Long term this should resume the original build session and preserve original build intent/context instead of spawning a fresh session from a file handoff.',
  };
}

function buildFollowUpJob({
  repo,
  prNumber,
  reviewerModel,
  linearTicketId = null,
  reviewBody,
  reviewPostedAt,
  critical,
}) {
  const createdAt = reviewPostedAt || new Date().toISOString();
  const jobId = `${sanitizeRepo(repo)}-pr-${prNumber}-${sanitizeTimestamp(createdAt)}`;

  return {
    schemaVersion: FOLLOW_UP_JOB_SCHEMA_VERSION,
    kind: 'adversarial-review-follow-up',
    status: 'pending',
    jobId,
    createdAt,
    trigger: {
      type: 'github-review-posted',
      postedAt: createdAt,
    },
    repo,
    prNumber,
    linearTicketId,
    reviewerModel,
    critical: Boolean(critical),
    reviewSummary: extractReviewSummary(reviewBody),
    reviewBody,
    recommendedFollowUpAction: buildRecommendedFollowUpAction({ critical }),
    sessionHandoff: {
      originalBuildSessionId: null,
      resumePreferred: true,
      resumeAvailable: false,
    },
  };
}

function createFollowUpJob({ rootDir, ...jobInput }) {
  const job = buildFollowUpJob(jobInput);
  const queueDir = join(rootDir, 'data', 'follow-up-jobs', 'pending');
  const jobPath = join(queueDir, `${job.jobId}.json`);

  mkdirSync(queueDir, { recursive: true });
  writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');

  return { job, jobPath };
}

export {
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  buildFollowUpJob,
  createFollowUpJob,
  extractReviewSummary,
};
