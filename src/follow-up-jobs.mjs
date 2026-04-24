import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';

const MAX_CREATE_ATTEMPTS = 100;

const FOLLOW_UP_JOB_SCHEMA_VERSION = 1;
const REMEDIATION_REPLY_SCHEMA_VERSION = 1;
const REMEDIATION_REPLY_KIND = 'adversarial-review-remediation-reply';
const FOLLOW_UP_JOB_DIRS = Object.freeze({
  pending: ['data', 'follow-up-jobs', 'pending'],
  inProgress: ['data', 'follow-up-jobs', 'in-progress'],
  failed: ['data', 'follow-up-jobs', 'failed'],
  workspaces: ['data', 'follow-up-jobs', 'workspaces'],
});

function getFollowUpJobDir(rootDir, key) {
  const parts = FOLLOW_UP_JOB_DIRS[key];
  if (!parts) {
    throw new Error(`Unknown follow-up job directory key: ${key}`);
  }

  return join(rootDir, ...parts);
}

function ensureFollowUpJobDirs(rootDir) {
  Object.keys(FOLLOW_UP_JOB_DIRS).forEach((key) => {
    mkdirSync(getFollowUpJobDir(rootDir, key), { recursive: true });
  });
}

function writeFollowUpJob(jobPath, job) {
  writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
}

function readFollowUpJob(jobPath) {
  return JSON.parse(readFileSync(jobPath, 'utf8'));
}

function listPendingFollowUpJobPaths(rootDir) {
  const pendingDir = getFollowUpJobDir(rootDir, 'pending');
  if (!existsSync(pendingDir)) return [];

  return readdirSync(pendingDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(pendingDir, name));
}

function listPendingFollowUpJobs(rootDir) {
  return listPendingFollowUpJobPaths(rootDir).map((jobPath) => ({
    job: readFollowUpJob(jobPath),
    jobPath,
  }));
}

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

function buildRemediationReplyArtifact(outputPath) {
  return {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    state: 'awaiting-worker-write',
    path: outputPath ?? null,
  };
}

function buildRemediationReply({
  job,
  outcome = 'completed',
  summary,
  validation = [],
  blockers = [],
  reReviewRequested = false,
  reReviewReason = null,
}) {
  if (!job?.jobId) {
    throw new Error('Cannot build remediation reply without a job record');
  }

  return {
    kind: REMEDIATION_REPLY_KIND,
    schemaVersion: REMEDIATION_REPLY_SCHEMA_VERSION,
    jobId: job.jobId,
    repo: job.repo,
    prNumber: job.prNumber,
    outcome,
    summary,
    validation,
    blockers,
    reReview: {
      requested: Boolean(reReviewRequested),
      reason: reReviewRequested ? (reReviewReason || 'Remediation applied and ready for another adversarial review pass.') : null,
    },
  };
}

function validateRemediationReply(reply, { expectedJob = null } = {}) {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    throw new Error('Remediation reply must be a JSON object');
  }

  if (reply.kind !== REMEDIATION_REPLY_KIND) {
    throw new Error(`Remediation reply kind must be ${REMEDIATION_REPLY_KIND}`);
  }

  if (reply.schemaVersion !== REMEDIATION_REPLY_SCHEMA_VERSION) {
    throw new Error(`Unsupported remediation reply schemaVersion: ${reply.schemaVersion}`);
  }

  if (typeof reply.jobId !== 'string' || !reply.jobId.trim()) {
    throw new Error('Remediation reply jobId is required');
  }

  if (typeof reply.repo !== 'string' || !reply.repo.trim()) {
    throw new Error('Remediation reply repo is required');
  }

  if (!Number.isInteger(reply.prNumber) || reply.prNumber <= 0) {
    throw new Error('Remediation reply prNumber must be a positive integer');
  }

  if (typeof reply.summary !== 'string' || !reply.summary.trim()) {
    throw new Error('Remediation reply summary is required');
  }

  const allowedOutcomes = new Set(['completed', 'blocked', 'partial']);
  if (!allowedOutcomes.has(reply.outcome)) {
    throw new Error(`Remediation reply outcome must be one of: ${Array.from(allowedOutcomes).join(', ')}`);
  }

  if (!Array.isArray(reply.validation)) {
    throw new Error('Remediation reply validation must be an array');
  }

  if (!Array.isArray(reply.blockers)) {
    throw new Error('Remediation reply blockers must be an array');
  }

  if (!reply.reReview || typeof reply.reReview !== 'object' || Array.isArray(reply.reReview)) {
    throw new Error('Remediation reply reReview must be an object');
  }

  if (typeof reply.reReview.requested !== 'boolean') {
    throw new Error('Remediation reply reReview.requested must be a boolean');
  }

  if (reply.reReview.requested && (typeof reply.reReview.reason !== 'string' || !reply.reReview.reason.trim())) {
    throw new Error('Remediation reply reReview.reason is required when reReview.requested is true');
  }

  if (expectedJob) {
    if (reply.jobId !== expectedJob.jobId) {
      throw new Error(`Remediation reply jobId mismatch: expected ${expectedJob.jobId}, got ${reply.jobId}`);
    }

    if (reply.repo !== expectedJob.repo) {
      throw new Error(`Remediation reply repo mismatch: expected ${expectedJob.repo}, got ${reply.repo}`);
    }

    if (reply.prNumber !== expectedJob.prNumber) {
      throw new Error(`Remediation reply prNumber mismatch: expected ${expectedJob.prNumber}, got ${reply.prNumber}`);
    }
  }

  return reply;
}

function readRemediationReplyArtifact(replyPath, { expectedJob = null } = {}) {
  return validateRemediationReply(
    JSON.parse(readFileSync(replyPath, 'utf8')),
    { expectedJob }
  );
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
    remediationReply: buildRemediationReplyArtifact(null),
    sessionHandoff: {
      originalBuildSessionId: null,
      resumePreferred: true,
      resumeAvailable: false,
    },
  };
}

function createFollowUpJob({ rootDir, ...jobInput }) {
  const baseJob = buildFollowUpJob(jobInput);
  const queueDir = getFollowUpJobDir(rootDir, 'pending');

  mkdirSync(queueDir, { recursive: true });

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    const job = attempt === 0
      ? baseJob
      : {
          ...baseJob,
          jobId: `${baseJob.jobId}-${attempt + 1}`,
        };
    const jobPath = join(queueDir, `${job.jobId}.json`);

    try {
      writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return { job, jobPath };
    } catch (err) {
      if (err?.code === 'EEXIST') continue;
      throw err;
    }
  }

  throw new Error(`Unable to create unique follow-up job file for ${baseJob.jobId} after ${MAX_CREATE_ATTEMPTS} attempts`);
}

function claimNextFollowUpJob({
  rootDir,
  workerType = 'codex-remediation',
  claimedAt = new Date().toISOString(),
  launcherPid = process.pid,
} = {}) {
  ensureFollowUpJobDirs(rootDir);

  for (const pendingPath of listPendingFollowUpJobPaths(rootDir)) {
    const inProgressPath = join(getFollowUpJobDir(rootDir, 'inProgress'), basename(pendingPath));

    try {
      renameSync(pendingPath, inProgressPath);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }

    const job = readFollowUpJob(inProgressPath);
    const claimedJob = {
      ...job,
      status: 'in_progress',
      claimedAt,
      claimedBy: {
        workerType,
        launcherPid,
      },
    };

    writeFollowUpJob(inProgressPath, claimedJob);
    return { job: claimedJob, jobPath: inProgressPath };
  }

  return null;
}

function markFollowUpJobSpawned({
  jobPath,
  worker,
  spawnedAt = new Date().toISOString(),
}) {
  const currentJob = readFollowUpJob(jobPath);
  const nextJob = {
    ...currentJob,
    status: 'in_progress',
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      spawnedAt,
      ...worker,
    },
    remediationReply: buildRemediationReplyArtifact(worker?.replyPath || currentJob?.remediationReply?.path || null),
  };

  if (worker?.workspaceDir) {
    nextJob.workspaceDir = worker.workspaceDir;
  }

  writeFollowUpJob(jobPath, nextJob);
  return { job: nextJob, jobPath };
}

function markFollowUpJobFailed({
  rootDir,
  jobPath,
  error,
  failedAt = new Date().toISOString(),
}) {
  ensureFollowUpJobDirs(rootDir);

  const failedPath = join(getFollowUpJobDir(rootDir, 'failed'), basename(jobPath));
  const currentJob = readFollowUpJob(jobPath);
  const nextJob = {
    ...currentJob,
    status: 'failed',
    failedAt,
    failure: {
      message: error?.message || String(error),
    },
  };

  writeFollowUpJob(jobPath, nextJob);
  renameSync(jobPath, failedPath);
  return { job: nextJob, jobPath: failedPath };
}

export {
  FOLLOW_UP_JOB_DIRS,
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  REMEDIATION_REPLY_KIND,
  REMEDIATION_REPLY_SCHEMA_VERSION,
  buildFollowUpJob,
  buildRemediationReply,
  buildRemediationReplyArtifact,
  claimNextFollowUpJob,
  createFollowUpJob,
  ensureFollowUpJobDirs,
  extractReviewSummary,
  getFollowUpJobDir,
  listPendingFollowUpJobPaths,
  listPendingFollowUpJobs,
  markFollowUpJobFailed,
  markFollowUpJobSpawned,
  readRemediationReplyArtifact,
  readFollowUpJob,
  validateRemediationReply,
  writeFollowUpJob,
};
