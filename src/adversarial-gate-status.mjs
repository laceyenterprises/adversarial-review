import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import {
  buildScopedOperatorApproval,
  extractReviewVerdict,
  findLatestFollowUpJobForPR,
  normalizeReviewVerdict,
  OPERATOR_APPROVED_LABEL,
  OPERATOR_SKIP_LABELS,
} from './follow-up-merge-agent.mjs';
import {
  ensureReviewStateSchema,
  getReviewRow,
  openReviewStateDb,
} from './review-state.mjs';
import { classifyReviewerFailure } from './reviewer-cascade.mjs';

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

function normalizePrNumber(prNumber) {
  const value = Number(prNumber);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid PR number for adversarial gate status: ${prNumber}`);
  }
  return value;
}

function gateRecordPath(rootDir, { repo, prNumber, headSha }) {
  const safeSha = sanitizePathSegment(headSha || 'no-sha');
  return join(gateRecordDir(rootDir), `${gateRecordPrefix({ repo, prNumber })}${safeSha}.json`);
}

function readGateRecord(rootDir, { repo, prNumber, headSha }, readRecordImpl = readFileSync) {
  try {
    return JSON.parse(String(readRecordImpl(gateRecordPath(rootDir, { repo, prNumber, headSha }), 'utf8')));
  } catch {
    return null;
  }
}

function matchesPublishedDecision(record, decision) {
  if (!record || !decision) return false;
  return (
    record.context === ADVERSARIAL_GATE_CONTEXT &&
    record.state === decision.state &&
    record.description === decision.description &&
    record.reason === decision.reason &&
    Boolean(record.postedAt)
  );
}

function gateRecordPrefix({ repo, prNumber }) {
  const safeRepo = sanitizePathSegment(String(repo ?? '').replace(/\//g, '__'));
  return `${safeRepo}-pr-${normalizePrNumber(prNumber)}-`;
}

function pruneGateRecordsForPR(rootDir, {
  repo,
  prNumber,
  keepHeadSha = null,
  readdirImpl = readdirSync,
  rmImpl = rmSync,
} = {}) {
  const dir = gateRecordDir(rootDir);
  const prefix = gateRecordPrefix({ repo, prNumber });
  const keepName = keepHeadSha
    ? `${prefix}${sanitizePathSegment(keepHeadSha)}.json`
    : null;
  let removed = 0;
  let scanned = [];
  try {
    scanned = readdirImpl(dir);
  } catch {
    return { removed };
  }
  for (const name of scanned) {
    if (!name.startsWith(prefix) || !name.endsWith('.json') || name === keepName) {
      continue;
    }
    rmImpl(join(dir, name), { force: true });
    removed += 1;
  }
  return { removed };
}

function deleteGateRecordsForPR(rootDir, coordinates) {
  return pruneGateRecordsForPR(rootDir, {
    ...coordinates,
    keepHeadSha: null,
  });
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

function normalizeReviewStatus(status) {
  return String(status ?? '').trim().toLowerCase();
}

function extractReviewBodyFromRow(reviewRow) {
  return reviewRow?.reviewBody ?? reviewRow?.review_body ?? reviewRow?.review_text ?? null;
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

function makeDecision(state, description, reason) {
  return {
    context: ADVERSARIAL_GATE_CONTEXT,
    state,
    description: truncateDescription(description),
    reason,
  };
}

function reviewerFailureClass(reviewRow) {
  const rawMessage = String(reviewRow?.failure_message || '');
  const message = rawMessage.toLowerCase();
  const tagMatch = message.match(/^\[(reviewer-timeout|launchctl-bootstrap|cascade)\]/);
  if (tagMatch) return tagMatch[1];
  const legacyClass = classifyReviewerFailure(rawMessage, null);
  if (legacyClass === 'cascade' || legacyClass === 'reviewer-timeout' || legacyClass === 'launchctl-bootstrap') {
    return legacyClass;
  }
  if (message.includes('claude launchctl session bootstrap failed') || message.includes('launchctlsessionerror')) {
    return 'launchctl-bootstrap';
  }
  if (message.includes('command timed out after')) {
    return 'reviewer-timeout';
  }
  if (/litellm\/upstream cascade|watcher backoff engaged/.test(message)) return 'cascade';
  return null;
}

function hasMinimumOperatorApprovalFields(operatorApproval, currentHeadSha = null) {
  if (!operatorApproval) return false;
  if (!operatorApproval.actor || String(operatorApproval.actor).trim().toLowerCase() === 'unknown') return false;
  if (!operatorApproval.headSha) return false;
  if (!currentHeadSha || String(operatorApproval.headSha) !== String(currentHeadSha)) return false;
  if (!operatorApproval.labelEventId && !operatorApproval.labelEventNodeId) return false;
  if (!operatorApproval.createdAt) return false;
  return true;
}

function pickAdversarialGateStatus({
  reviewRow = null,
  latestJob = null,
  operatorApproval = null,
  labels = [],
  headSha = null,
} = {}) {
  if (normalizeLabelNames(labels).some((label) => OPERATOR_SKIP_LABELS.has(label))) {
    return makeDecision(
      'failure',
      'Explicit operator skip label blocks adversarial gate.',
      'operator-skip-label'
    );
  }

  if (hasMinimumOperatorApprovalFields(operatorApproval, headSha)) {
    return makeDecision(
      'success',
      'Scoped operator override approves the current head.',
      'operator-approved'
    );
  }

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
    const failureClass = reviewerFailureClass(reviewRow);
    if (failureClass === 'reviewer-timeout') {
      return makeDecision('pending', 'Adversarial reviewer timed out; retry is pending.', 'reviewer-timeout-retry-pending');
    }
    if (failureClass === 'launchctl-bootstrap') {
      return makeDecision('pending', 'Claude reviewer bootstrap failed; retry is pending.', 'reviewer-bootstrap-retry-pending');
    }
    if (failureClass === 'cascade') {
      return makeDecision('pending', 'Adversarial reviewer hit an upstream cascade; retry is pending.', 'reviewer-cascade-retry-pending');
    }
    return makeDecision('pending', 'Adversarial review retry is pending.', 'review-retry-pending');
  }
  if (reviewStatus === 'malformed') {
    return makeDecision('failure', 'Adversarial review ledger is malformed.', 'review-malformed');
  }
  if (reviewStatus === 'failed') {
    // Infrastructure failures (reviewer crashed before posting any verdict)
    // intentionally post `success` so the GitHub status check does NOT block
    // a mobile merge. A red gate that exists because our own pipeline broke
    // is operator-hostile — there's no real adversarial finding here, only a
    // missing one. The description carries the failure class so the operator
    // can read it on the PR; if they want to merge anyway it doesn't take
    // admin override. Real adversarial findings (`blocking-review` below)
    // still post `failure`.
    const failureClass = reviewerFailureClass(reviewRow);
    if (failureClass === 'reviewer-timeout') {
      return makeDecision('success', 'Adversarial reviewer timed out before posting; operator decides.', 'reviewer-timeout');
    }
    if (failureClass === 'launchctl-bootstrap') {
      return makeDecision('success', 'Claude reviewer bootstrap failed before posting; operator decides.', 'reviewer-launchctl-bootstrap');
    }
    if (failureClass === 'cascade') {
      return makeDecision('success', 'Adversarial reviewer hit an upstream cascade before posting; operator decides.', 'reviewer-cascade');
    }
    return makeDecision('success', 'Adversarial review failed before posting; operator decides.', 'review-failed');
  }
  if (reviewStatus === 'failed-orphan') {
    return makeDecision('success', 'Adversarial review needs operator verification (orphaned reviewer).', 'review-failed-orphan');
  }
  if (reviewStatus !== 'posted') {
    return makeDecision(
      'failure',
      `Unexpected adversarial review state: ${reviewStatus || 'missing'}.`,
      'review-state-unknown'
    );
  }

  if (!latestJob) {
    const reviewBody = extractReviewBodyFromRow(reviewRow);
    if (typeof reviewBody === 'string' && reviewBody.trim()) {
      const normalizedVerdict = normalizeReviewVerdict(extractReviewVerdict(reviewBody));
      if (normalizedVerdict === 'comment-only' || normalizedVerdict === 'approved') {
        return makeDecision('success', 'Non-blocking adversarial review is settled.', 'review-settled');
      }
      if (normalizedVerdict === 'request-changes') {
        return makeDecision('failure', 'Blocking adversarial review is still unsettled.', 'blocking-review');
      }
    }
    return makeDecision('pending', 'Posted review is waiting for follow-up ledger reconciliation.', 'awaiting-ledger');
  }

  if (latestJobStatus === 'pending') {
    return makeDecision('pending', 'Remediation is queued.', 'remediation-queued');
  }
  if (latestJobStatus === 'in-progress') {
    return makeDecision('pending', 'Remediation is in progress.', 'remediation-in-progress');
  }
  const normalizedVerdict = normalizeReviewVerdict(extractReviewVerdict(latestJob.reviewBody));
  if (normalizedVerdict === 'comment-only' || normalizedVerdict === 'approved') {
    return makeDecision('success', 'Non-blocking adversarial review is settled.', 'review-settled');
  }
  if (latestJobStatus === 'failed') {
    // Pipeline gave up (remediation worker died / infra issue) — don't block
    // operator's merge button. Real adversarial findings still surface in
    // the PR review comment thread; the operator decides without needing
    // admin override on mobile. See note in the `failed` branch above.
    return makeDecision('success', 'Remediation failed; operator decides (see review thread).', 'remediation-failed');
  }
  if (latestJobStatus === 'stopped') {
    // Round budget exhausted. Last verdict may genuinely be Request-changes,
    // but at this point the operator has full context (the review thread)
    // and `request-changes` below still posts `failure` for the "verdict is
    // really request-changes after a settled remediation" case. The
    // `stopped` state itself is a pipeline-give-up signal, not an
    // adversarial signal — don't block the merge button on infra giving up.
    return makeDecision('success', 'Remediation stopped; operator decides (see review thread).', 'remediation-stopped');
  }
  if (latestJobStatus === 'completed' && latestJob?.reReview?.requested === true) {
    return makeDecision('pending', 'Queued re-review has not posted yet.', 'rereview-queued');
  }

  if (normalizedVerdict === 'request-changes') {
    return makeDecision('failure', 'Blocking adversarial review is still unsettled.', 'blocking-review');
  }
  if (normalizedVerdict === null) {
    return makeDecision('failure', 'Posted review is missing a verdict in the ledger.', 'missing-verdict');
  }
  return makeDecision('failure', 'Posted review verdict is malformed.', 'unknown-verdict');
}

async function readReviewRowForGate(rootDir, { repo, prNumber }) {
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
  prAuthor = null,
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
        prAuthor,
        operatorApprovalEvent: event,
      },
      latestJob
    );
  }

  return {
    reviewRow: resolvedRow,
    latestJob,
    operatorApproval,
    labels,
    headSha,
  };
}

async function publishAdversarialGateStatus(rootDir, {
  repo,
  prNumber,
  headSha,
  decision,
  execFileImpl = execFileAsync,
  env = process.env,
  mkdirImpl = mkdirSync,
  readRecordImpl = readFileSync,
  writeRecordImpl = writeFileAtomic,
} = {}) {
  if (!repo || !headSha || !decision?.state) {
    return { posted: false, reason: 'missing-input' };
  }
  const normalizedPrNumber = normalizePrNumber(prNumber);

  const existingRecord = readGateRecord(
    rootDir,
    { repo, prNumber: normalizedPrNumber, headSha },
    readRecordImpl
  );
  if (matchesPublishedDecision(existingRecord, decision)) {
    return { posted: false, reason: 'unchanged', record: existingRecord };
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
    prNumber: normalizedPrNumber,
    headSha,
    state: decision.state,
    description: decision.description,
    reason: decision.reason,
    postedAt: new Date().toISOString(),
  };
  writeRecordImpl(
    gateRecordPath(rootDir, { repo, prNumber, headSha }),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o640 }
  );
  pruneGateRecordsForPR(rootDir, { repo, prNumber, keepHeadSha: headSha });
  return { posted: true, record };
}

async function projectAdversarialGateStatus(rootDir, {
  repo,
  prNumber,
  headSha,
  labels = [],
  prUpdatedAt = null,
  prAuthor = null,
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
    prAuthor,
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
  deleteGateRecordsForPR,
  pickAdversarialGateStatus,
  projectAdversarialGateStatus,
  pruneGateRecordsForPR,
  publishAdversarialGateStatus,
};
