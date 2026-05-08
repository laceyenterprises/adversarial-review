import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import {
  buildScopedOperatorApproval,
  extractReviewVerdict,
  findLatestFollowUpJobForPR,
  OPERATOR_APPROVED_LABEL,
} from './follow-up-merge-agent.mjs';

const execFileAsync = promisify(execFile);

const ADVERSARIAL_GATE_CONTEXT = 'agent-os/adversarial-gate';
const ADVERSARIAL_GATE_RECORD_DIR = ['data', 'adversarial-gate-status'];
const DESCRIPTION_MAX_CHARS = 140;

function sanitizePathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

function gateRecordDir(rootDir) {
  return join(rootDir, ...ADVERSARIAL_GATE_RECORD_DIR);
}

function gateRecordPath(rootDir, { repo, prNumber, headSha }) {
  const safeRepo = sanitizePathSegment(String(repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizePathSegment(headSha || 'no-sha');
  return join(gateRecordDir(rootDir), `${safeRepo}-pr-${Number(prNumber)}-${safeSha}.json`);
}

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label.trim().toLowerCase();
      if (typeof label?.name === 'string') return label.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

function normalizeReviewVerdict(verdict) {
  const text = String(verdict ?? '')
    .replace(/[*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!text) return null;
  if (text.startsWith('request changes')) return 'request-changes';
  if (text.startsWith('comment only')) return 'comment-only';
  if (text.startsWith('approved')) return 'approved';
  return 'unknown';
}

function normalizeReviewStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

function normalizeJobStatus(status) {
  const text = String(status ?? '').trim().toLowerCase();
  if (text === 'in_progress') return 'in-progress';
  return text;
}

function truncateDescription(description) {
  const text = String(description ?? '').trim().replace(/\s+/g, ' ');
  if (text.length <= DESCRIPTION_MAX_CHARS) return text;
  return `${text.slice(0, DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

function readGateRecord(rootDir, coordinates) {
  try {
    return JSON.parse(readFileSync(gateRecordPath(rootDir, coordinates), 'utf8'));
  } catch {
    return null;
  }
}

function remediationRoundsRemainClaimable(latestJob) {
  const currentRound = Number(latestJob?.remediationPlan?.currentRound);
  const maxRounds = Number(latestJob?.remediationPlan?.maxRounds);
  if (!Number.isFinite(currentRound) || !Number.isFinite(maxRounds) || maxRounds <= 0) {
    return false;
  }
  return currentRound < maxRounds;
}

function makeDecision(state, description, reason, extra = {}) {
  return {
    context: ADVERSARIAL_GATE_CONTEXT,
    state,
    description: truncateDescription(description),
    reason,
    ...extra,
  };
}

function pickAdversarialGateStatus({
  reviewRow = null,
  latestJob = null,
  operatorApproval = null,
} = {}) {
  if (!reviewRow) {
    return makeDecision('pending', 'Adversarial review has not posted yet.', 'review-not-posted');
  }

  const reviewStatus = normalizeReviewStatus(reviewRow.review_status);
  const latestJobStatus = normalizeJobStatus(latestJob?.status);

  if (reviewStatus === 'pending') {
    if (latestJobStatus === 'completed' && latestJob?.reReview?.requested === true) {
      return makeDecision('pending', 'Queued re-review has not posted yet.', 'rereview-queued');
    }
    return makeDecision('pending', 'Adversarial review is queued.', 'review-queued');
  }
  if (reviewStatus === 'reviewing') {
    return makeDecision('pending', 'Adversarial review is in progress.', 'review-in-progress');
  }
  if (reviewStatus === 'pending-upstream') {
    return makeDecision('pending', 'Adversarial review retry is pending.', 'review-retry-pending');
  }
  if (reviewStatus === 'malformed') {
    return makeDecision('failure', 'Adversarial review ledger is malformed.', 'review-malformed');
  }
  if (reviewStatus === 'failed') {
    return makeDecision('failure', 'Adversarial review failed before posting.', 'review-failed');
  }
  if (reviewStatus === 'failed-orphan') {
    return makeDecision('failure', 'Adversarial review needs operator verification.', 'review-failed-orphan');
  }
  if (reviewStatus !== 'posted') {
    return makeDecision(
      'failure',
      `Unexpected adversarial review state: ${reviewStatus || 'missing'}.`,
      'review-state-unknown'
    );
  }

  if (!latestJob) {
    return makeDecision('failure', 'Posted review is missing from the follow-up ledger.', 'missing-ledger');
  }

  if (latestJobStatus === 'pending') {
    return makeDecision('pending', 'Remediation is queued.', 'remediation-queued');
  }
  if (latestJobStatus === 'in-progress') {
    return makeDecision('pending', 'Remediation is in progress.', 'remediation-in-progress');
  }
  if (latestJobStatus === 'failed') {
    return makeDecision('failure', 'Remediation failed and needs operator action.', 'remediation-failed');
  }
  if (latestJobStatus === 'stopped') {
    return makeDecision('failure', 'Remediation stopped and needs operator action.', 'remediation-stopped');
  }
  if (latestJobStatus === 'completed' && latestJob?.reReview?.requested === true) {
    return makeDecision('pending', 'Queued re-review has not posted yet.', 'rereview-queued');
  }

  const normalizedVerdict = normalizeReviewVerdict(extractReviewVerdict(latestJob.reviewBody));
  if (normalizedVerdict === 'comment-only' || normalizedVerdict === 'approved') {
    return makeDecision('success', 'Non-blocking adversarial review is settled.', 'review-settled');
  }
  if (normalizedVerdict === 'request-changes') {
    if (operatorApproval) {
      if (remediationRoundsRemainClaimable(latestJob)) {
        return makeDecision(
          'failure',
          'Operator override is present, but remediation rounds remain.',
          'override-remediation-claimable'
        );
      }
      return makeDecision(
        'success',
        'Scoped operator override accepts the current blocking review.',
        'operator-approved'
      );
    }
    return makeDecision('failure', 'Blocking adversarial review is still unsettled.', 'blocking-review');
  }
  if (normalizedVerdict === null) {
    return makeDecision('failure', 'Posted review is missing a verdict in the ledger.', 'missing-verdict');
  }
  return makeDecision('failure', 'Posted review verdict is malformed.', 'unknown-verdict');
}

async function readReviewRowForGate(rootDir, { repo, prNumber }) {
  const {
    getReviewRow,
    openReviewStateDb,
    ensureReviewStateSchema,
  } = await import('./review-state.mjs');
  const db = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(db);
    return getReviewRow(db, { repo, prNumber });
  } finally {
    db.close();
  }
}

async function buildAdversarialGateSnapshot(rootDir, {
  repo,
  prNumber,
  headSha,
  labels = [],
  prUpdatedAt = null,
  reviewRow = null,
  execFileImpl = execFileAsync,
  fetchLatestLabelEventImpl,
} = {}) {
  const resolvedRow = reviewRow || await readReviewRowForGate(rootDir, { repo, prNumber });
  const latestJob = findLatestFollowUpJobForPR(rootDir, { repo, prNumber });

  let operatorApproval = null;
  const hasOperatorApprovedLabel = normalizeLabelNames(labels).includes(OPERATOR_APPROVED_LABEL);
  if (
    hasOperatorApprovedLabel
    && latestJob
    && headSha
    && typeof fetchLatestLabelEventImpl === 'function'
  ) {
    const event = await fetchLatestLabelEventImpl(repo, prNumber, OPERATOR_APPROVED_LABEL, {
      execFileImpl,
    });
    operatorApproval = buildScopedOperatorApproval(
      {
        headSha,
        prUpdatedAt,
        operatorApprovalEvent: event,
      },
      latestJob
    );
  }

  return {
    reviewRow: resolvedRow,
    latestJob,
    operatorApproval,
  };
}

async function publishAdversarialGateStatus(rootDir, {
  repo,
  prNumber,
  headSha,
  decision,
  execFileImpl = execFileAsync,
  env = process.env,
  readRecordImpl = readGateRecord,
  mkdirImpl = mkdirSync,
  writeRecordImpl = writeFileAtomic,
} = {}) {
  if (!repo || !headSha || !decision?.state) {
    return { posted: false, reason: 'missing-input' };
  }

  const existing = readRecordImpl(rootDir, { repo, prNumber, headSha });
  if (
    existing?.context === ADVERSARIAL_GATE_CONTEXT
    && existing?.state === decision.state
    && existing?.description === decision.description
  ) {
    return { posted: false, reason: 'already-current', record: existing };
  }

  const token = env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required to publish adversarial gate status');
  }

  const [owner, repoName] = String(repo).split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo slug: ${repo}`);
  }

  const allowlistedEnv = {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: env.HOME ?? '',
    GH_TOKEN: token,
  };

  await execFileImpl(
    'gh',
    [
      'api',
      '--method',
      'POST',
      `repos/${owner}/${repoName}/statuses/${headSha}`,
      '-f',
      `state=${decision.state}`,
      '-f',
      `context=${ADVERSARIAL_GATE_CONTEXT}`,
      '-f',
      `description=${decision.description}`,
    ],
    {
      env: allowlistedEnv,
      maxBuffer: 2 * 1024 * 1024,
    }
  );

  mkdirImpl(gateRecordDir(rootDir), { recursive: true });
  const record = {
    context: ADVERSARIAL_GATE_CONTEXT,
    repo,
    prNumber: Number(prNumber),
    headSha,
    state: decision.state,
    description: decision.description,
    reason: decision.reason,
    postedAt: new Date().toISOString(),
  };
  writeRecordImpl(
    gateRecordPath(rootDir, { repo, prNumber, headSha }),
    `${JSON.stringify(record, null, 2)}\n`
  );
  return { posted: true, record };
}

async function projectAdversarialGateStatus(rootDir, {
  repo,
  prNumber,
  headSha,
  labels = [],
  prUpdatedAt = null,
  reviewRow = null,
  execFileImpl = execFileAsync,
  fetchLatestLabelEventImpl,
  env = process.env,
} = {}) {
  const snapshot = await buildAdversarialGateSnapshot(rootDir, {
    repo,
    prNumber,
    headSha,
    labels,
    prUpdatedAt,
    reviewRow,
    execFileImpl,
    fetchLatestLabelEventImpl,
  });
  const decision = pickAdversarialGateStatus(snapshot);
  const publish = await publishAdversarialGateStatus(rootDir, {
    repo,
    prNumber,
    headSha,
    decision,
    execFileImpl,
    env,
  });
  return { decision, publish, snapshot };
}

export {
  ADVERSARIAL_GATE_CONTEXT,
  buildAdversarialGateSnapshot,
  pickAdversarialGateStatus,
  projectAdversarialGateStatus,
  publishAdversarialGateStatus,
};
