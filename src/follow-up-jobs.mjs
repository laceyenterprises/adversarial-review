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

const FOLLOW_UP_JOB_SCHEMA_VERSION = 2;
const DEFAULT_MAX_REMEDIATION_ROUNDS = 2;
const FOLLOW_UP_JOB_DIRS = Object.freeze({
  pending: ['data', 'follow-up-jobs', 'pending'],
  inProgress: ['data', 'follow-up-jobs', 'in-progress'],
  completed: ['data', 'follow-up-jobs', 'completed'],
  failed: ['data', 'follow-up-jobs', 'failed'],
  stopped: ['data', 'follow-up-jobs', 'stopped'],
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

function listFollowUpJobsInDir(rootDir, key) {
  const dir = getFollowUpJobDir(rootDir, key);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      job: readFollowUpJob(join(dir, name)),
      jobPath: join(dir, name),
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
    executionModel: 'bounded-manual-rounds',
    maxRounds: DEFAULT_MAX_REMEDIATION_ROUNDS,
    futureArchitectureNote: 'Long term this should resume the original build session and preserve original build intent/context instead of spawning a fresh session from a file handoff.',
  };
}

function buildRemediationRoundPlan(maxRounds = DEFAULT_MAX_REMEDIATION_ROUNDS) {
  const normalizedMaxRounds = Number.isInteger(maxRounds) && maxRounds > 0
    ? maxRounds
    : DEFAULT_MAX_REMEDIATION_ROUNDS;

  return {
    mode: 'bounded-manual-rounds',
    maxRounds: normalizedMaxRounds,
    currentRound: 0,
    rounds: [],
    stopReason: null,
    nextAction: {
      type: 'consume-pending-round',
      round: 1,
      operatorVisibility: 'explicit',
    },
  };
}

function getCurrentRound(job) {
  const roundNumber = Number(job?.remediationPlan?.currentRound || 0);
  if (roundNumber <= 0) return null;
  return job?.remediationPlan?.rounds?.find((round) => round.round === roundNumber) || null;
}

function updateCurrentRound(job, updater) {
  const currentRound = getCurrentRound(job);
  if (!currentRound) {
    throw new Error(`Follow-up job ${job?.jobId || '<unknown>'} has no active remediation round`);
  }

  return {
    ...job,
    remediationPlan: {
      ...job.remediationPlan,
      rounds: job.remediationPlan.rounds.map((round) => (
        round.round === currentRound.round ? updater(round) : round
      )),
    },
  };
}

function moveFollowUpJob(rootDir, jobPath, targetKey, nextJob) {
  ensureFollowUpJobDirs(rootDir);
  const targetPath = join(getFollowUpJobDir(rootDir, targetKey), basename(jobPath));
  writeFollowUpJob(jobPath, nextJob);
  if (targetPath !== jobPath) {
    renameSync(jobPath, targetPath);
  }
  return { job: nextJob, jobPath: targetPath };
}

function buildFollowUpJob({
  repo,
  prNumber,
  reviewerModel,
  linearTicketId = null,
  reviewBody,
  reviewPostedAt,
  critical,
  maxRemediationRounds = DEFAULT_MAX_REMEDIATION_ROUNDS,
}) {
  const createdAt = reviewPostedAt || new Date().toISOString();
  const jobId = `${sanitizeRepo(repo)}-pr-${prNumber}-${sanitizeTimestamp(createdAt)}`;
  const remediationPlan = buildRemediationRoundPlan(maxRemediationRounds);

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
    recommendedFollowUpAction: {
      ...buildRecommendedFollowUpAction({ critical }),
      maxRounds: remediationPlan.maxRounds,
    },
    remediationPlan,
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
    const currentRound = Number(job?.remediationPlan?.currentRound || 0);
    const maxRounds = Number(job?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);
    if (currentRound >= maxRounds) {
      markFollowUpJobStopped({
        rootDir,
        jobPath: inProgressPath,
        stoppedAt: claimedAt,
        stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}) before claim.`,
      });
      continue;
    }

    const nextRoundNumber = currentRound + 1;
    const claimedJob = {
      ...job,
      status: 'in_progress',
      claimedAt,
      claimedBy: {
        workerType,
        launcherPid,
      },
      remediationPlan: {
        ...(job.remediationPlan || buildRemediationRoundPlan()),
        currentRound: nextRoundNumber,
        stopReason: null,
        nextAction: {
          type: 'worker-spawn',
          round: nextRoundNumber,
          operatorVisibility: 'explicit',
        },
        rounds: [
          ...(job?.remediationPlan?.rounds || []),
          {
            round: nextRoundNumber,
            state: 'claimed',
            claimedAt,
            claimedBy: {
              workerType,
              launcherPid,
            },
          },
        ],
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
  let nextJob = {
    ...currentJob,
    status: 'in_progress',
    remediationWorker: {
      model: 'codex',
      state: 'spawned',
      spawnedAt,
      ...worker,
    },
    remediationPlan: {
      ...currentJob.remediationPlan,
      nextAction: {
        type: 'reconcile-worker',
        round: currentJob?.remediationPlan?.currentRound || 1,
        operatorVisibility: 'explicit',
      },
    },
  };

  nextJob = updateCurrentRound(nextJob, (round) => ({
    ...round,
    state: 'spawned',
    spawnedAt,
    worker: {
      model: 'codex',
      ...worker,
    },
  }));

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
  failureCode = 'worker-failure',
}) {
  const currentJob = readFollowUpJob(jobPath);
  let nextJob = {
    ...currentJob,
    status: 'failed',
    failedAt,
    failure: {
      code: failureCode,
      message: error?.message || String(error),
    },
    remediationPlan: {
      ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
      nextAction: null,
    },
  };

  if (currentJob?.remediationPlan?.currentRound > 0) {
    nextJob = updateCurrentRound(nextJob, (round) => ({
      ...round,
      state: 'failed',
      finishedAt: failedAt,
      failure: {
        code: failureCode,
        message: error?.message || String(error),
      },
    }));
  }

  return moveFollowUpJob(rootDir, jobPath, 'failed', nextJob);
}

function markFollowUpJobCompleted({
  rootDir,
  jobPath,
  finishedAt = new Date().toISOString(),
  completionPreview = null,
}) {
  const currentJob = readFollowUpJob(jobPath);
  let nextJob = {
    ...currentJob,
    status: 'completed',
    completedAt: finishedAt,
    completion: {
      preview: completionPreview,
    },
    remediationPlan: {
      ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
      nextAction: null,
    },
  };

  nextJob = updateCurrentRound(nextJob, (round) => ({
    ...round,
    state: 'completed',
    finishedAt,
    completion: {
      preview: completionPreview,
    },
  }));

  return moveFollowUpJob(rootDir, jobPath, 'completed', nextJob);
}

function markFollowUpJobStopped({
  rootDir,
  jobPath,
  stoppedAt = new Date().toISOString(),
  stopReason,
}) {
  const currentJob = readFollowUpJob(jobPath);
  const nextJob = {
    ...currentJob,
    status: 'stopped',
    stoppedAt,
    remediationPlan: {
      ...(currentJob.remediationPlan || buildRemediationRoundPlan()),
      stopReason,
      nextAction: null,
    },
  };

  return moveFollowUpJob(rootDir, jobPath, 'stopped', nextJob);
}

function requeueFollowUpJobForNextRound({
  rootDir,
  jobPath,
  requestedAt = new Date().toISOString(),
  requestedBy = 'operator',
  reason = 'Additional remediation round requested.',
}) {
  const currentJob = readFollowUpJob(jobPath);
  const currentRound = Number(currentJob?.remediationPlan?.currentRound || 0);
  const maxRounds = Number(currentJob?.remediationPlan?.maxRounds || DEFAULT_MAX_REMEDIATION_ROUNDS);

  if (currentJob.status === 'in_progress') {
    throw new Error(`Cannot requeue follow-up job ${currentJob.jobId} while remediation is still in progress`);
  }

  if (currentRound >= maxRounds) {
    return markFollowUpJobStopped({
      rootDir,
      jobPath,
      stoppedAt: requestedAt,
      stopReason: `Reached max remediation rounds (${currentRound}/${maxRounds}). ${reason}`,
    });
  }

  const nextJob = {
    ...currentJob,
    status: 'pending',
    pendingAt: requestedAt,
    claimedAt: null,
    claimedBy: null,
    remediationWorker: null,
    failure: null,
    completedAt: null,
    stoppedAt: null,
    completion: null,
    remediationPlan: {
      ...(currentJob.remediationPlan || buildRemediationRoundPlan(maxRounds)),
      stopReason: null,
      nextAction: {
        type: 'consume-pending-round',
        round: currentRound + 1,
        operatorVisibility: 'explicit',
        requestedAt,
        requestedBy,
        reason,
      },
    },
  };

  return moveFollowUpJob(rootDir, jobPath, 'pending', nextJob);
}

export {
  DEFAULT_MAX_REMEDIATION_ROUNDS,
  FOLLOW_UP_JOB_DIRS,
  FOLLOW_UP_JOB_SCHEMA_VERSION,
  buildFollowUpJob,
  claimNextFollowUpJob,
  createFollowUpJob,
  ensureFollowUpJobDirs,
  extractReviewSummary,
  getCurrentRound,
  getFollowUpJobDir,
  listFollowUpJobsInDir,
  listPendingFollowUpJobPaths,
  listPendingFollowUpJobs,
  markFollowUpJobCompleted,
  markFollowUpJobFailed,
  markFollowUpJobSpawned,
  markFollowUpJobStopped,
  requeueFollowUpJobForNextRound,
  readFollowUpJob,
  writeFollowUpJob,
};
