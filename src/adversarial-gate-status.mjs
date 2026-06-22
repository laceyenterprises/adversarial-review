import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import {
  buildScopedOperatorApproval,
  classifyBlockingFindings,
  classifyNonBlockingFindings,
  extractReviewVerdict,
  findLatestFollowUpJobForPR,
  normalizeFollowUpJobStatus,
  normalizeReviewVerdict,
  OPERATOR_APPROVED_LABEL,
  OPERATOR_SKIP_LABELS,
} from './follow-up-merge-agent.mjs';
import {
  ensureReviewStateSchema,
  getReviewRow,
  openReviewStateDb,
} from './review-state.mjs';
import { reviewerFailureClassFromStoredRow } from './reviewer-failure-classification.mjs';
import { normalizeGithubMergeability } from './github-mergeability.mjs';
import { extractNonBlockingFindingIdentities } from './kernel/remediation-reply.mjs';

const execFileAsync = promisify(execFile);

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
    record.context === decision.context &&
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

/**
 * Resolve a PR's settled review verdict + remediation-pending state from the
 * SAME canonical source `pickAdversarialGateStatus()` uses: the latest
 * follow-up job's review body when remediation ran (else the stored review
 * row), and the job status for remediation activity.
 *
 * The AMA closure path needs this because `reviewed_prs` has NO `last_verdict`
 * or `remediation_pending` columns — the AMA review-state builder read them off
 * the row, got `undefined` -> verdict `''` -> never in SETTLED_SUCCESS_VERDICTS
 * -> AMA reported `verdict-not-settled-success` for every PR and closed 0 ever
 * (the same phantom-column class as the `risk_class` fix in the AMA path). This
 * mirrors the gate's ordering: non-posted review rows and active or
 * queued-re-review remediation are NOT settled, and review-based authority is
 * only current when reviewer_head_sha matches the live head.
 *
 * FAIL-OPEN GUARD (`liveHeadReview`): the stored follow-up-job / review-row body
 * can be STALE relative to a fresh review posted on the SAME head. A completed
 * remediation job's `reviewBody` (a comment-only round) is not updated when a
 * later adversarial pass posts `Request changes` on the remediated head, so the
 * AMA closer read the stale comment-only body and fail-open merged PRs whose
 * live verdict was `Request changes` (#1824 / #1816, head trailers falsely
 * claimed `latest_review_settled_success`). When the caller supplies the live
 * latest reviews on `currentHeadSha`, those are AUTHORITATIVE and override the
 * stored body; a lookup failure fails closed (verdict ''). Callers that don't
 * pass `liveHeadReview` (e.g. the advisory gate path) keep the prior behavior.
 *
 * @param {{resolved: boolean, bodies?: string[]}=} options.liveHeadReview
 *        Live latest review bodies on `currentHeadSha`, newest-first. Omit to
 *        skip reconciliation. `{resolved:false}` (or malformed) => fail closed.
 * @returns {{verdict: string, remediationPending: boolean, reviewedHeadSha: string|null}}
 */
// Blocking-finding state for a return path that has NO authoritative body to
// classify (non-posted row, stale head, remediation-pending, live-lookup
// failure). The AMA gate fails closed on `unknown`; never synthesize `known:0`
// out of nothing.
const UNKNOWN_BLOCKERS = {
  blockingFindingState: 'unknown',
  blockingFindingCount: 0,
  nonBlockingFindingState: 'unknown',
  nonBlockingFindingCount: 0,
  // `null` = non-blocking finding identities could not be resolved. The AMA
  // coverage gate fails closed on a null identity list (no waiver). Never
  // synthesize `[]` out of an unresolved body — `[]` means "present section,
  // zero findings" and would be read as "coverage trivially satisfied".
  nonBlockingFindingIdentities: null,
};

/**
 * Classify standing blocking findings from the SAME authoritative body the
 * verdict is derived from, reusing the merge-agent classifier so the AMA-closer
 * path and the merge-agent path agree. An empty / `- None.` `## Blocking Issues`
 * section on a settled body resolves to `known: 0`; a populated section yields
 * `count >= 1`; a legacy `request-changes` body with no structured section stays
 * `unknown`. A missing/blank body fails closed to `unknown`.
 */
function classifyBlockersFromBody(body, verdict) {
  if (!String(body ?? '').trim()) return { ...UNKNOWN_BLOCKERS };
  const blocking = classifyBlockingFindings(body, { lastVerdict: verdict || null });
  const nonBlocking = classifyNonBlockingFindings(body, { lastVerdict: verdict || null });
  return {
    blockingFindingState: blocking.state,
    blockingFindingCount: blocking.count,
    nonBlockingFindingState: nonBlocking.state,
    nonBlockingFindingCount: nonBlocking.count,
    // Per-finding non-blocking identities (normalized titles) from the SAME
    // authoritative body the verdict + counts came from. `null` when the body
    // has no parseable non-blocking section → AMA coverage gate fails closed.
    nonBlockingFindingIdentities: extractNonBlockingFindingIdentities(body),
  };
}

function resolveSettledReviewVerdict(
  rootDir,
  {
    repo,
    prNumber,
    reviewRow = null,
    currentHeadSha = null,
    latestJobFinder = findLatestFollowUpJobForPR,
    liveHeadReview = undefined,
  } = {}
) {
  const reviewedHeadSha = reviewRow?.reviewer_head_sha || null;
  const reviewStatus = normalizeReviewStatus(reviewRow?.review_status);
  if (reviewStatus !== 'posted') {
    return { verdict: '', remediationPending: false, reviewedHeadSha, ...UNKNOWN_BLOCKERS };
  }
  if (currentHeadSha && reviewedHeadSha && String(reviewedHeadSha) !== String(currentHeadSha)) {
    return { verdict: '', remediationPending: false, reviewedHeadSha, ...UNKNOWN_BLOCKERS };
  }

  const latestJobQuery = { repo, prNumber };
  if (currentHeadSha) latestJobQuery.revisionRef = currentHeadSha;
  const latestJob = latestJobFinder(rootDir, latestJobQuery);
  const latestJobStatus = normalizeFollowUpJobStatus(latestJob?.status);
  if (latestJobStatus === 'pending' || latestJobStatus === 'in-progress') {
    return { verdict: '', remediationPending: true, reviewedHeadSha, ...UNKNOWN_BLOCKERS };
  }
  if (latestJobStatus === 'completed' && latestJob?.reReview?.requested === true) {
    return { verdict: '', remediationPending: true, reviewedHeadSha, ...UNKNOWN_BLOCKERS };
  }

  // Live-review reconciliation: when supplied, the live latest review on the
  // current head wins over the (possibly stale) stored body. Fail closed if the
  // lookup did not resolve or returned no verdict-bearing review on this head.
  // The blocking-findings classification is derived from the SAME live body the
  // verdict came from so the two can never disagree.
  if (liveHeadReview !== undefined) {
    if (!liveHeadReview || liveHeadReview.resolved !== true || !Array.isArray(liveHeadReview.bodies)) {
      return { verdict: '', remediationPending: false, reviewedHeadSha, ...UNKNOWN_BLOCKERS };
    }
    let liveVerdict = '';
    let liveBodyForBlockers = '';
    for (const liveBody of liveHeadReview.bodies) {
      const candidate = String(normalizeReviewVerdict(extractReviewVerdict(liveBody)) || '').toLowerCase();
      if (candidate) {
        liveVerdict = candidate;
        liveBodyForBlockers = liveBody;
        break;
      }
    }
    return {
      verdict: liveVerdict,
      remediationPending: false,
      reviewedHeadSha,
      ...classifyBlockersFromBody(liveBodyForBlockers, liveVerdict),
    };
  }

  const body = latestJob
    ? latestJob.reviewBody
    : extractReviewBodyFromRow(reviewRow);
  const verdict = String(normalizeReviewVerdict(extractReviewVerdict(body)) || '').toLowerCase();
  return {
    verdict,
    remediationPending: false,
    reviewedHeadSha,
    ...classifyBlockersFromBody(body, verdict),
  };
}

/**
 * Return only the head SHA proven by the settled review source. Falling back to
 * the live/current PR head when this is absent would defeat the stale-review
 * guard and let AMA close a commit that was never proven reviewed.
 */
function resolveProvenReviewedHead(settledReview) {
  return settledReview?.reviewedHeadSha || null;
}

function truncateDescription(description) {
  const text = String(description ?? '').trim().replace(/\s+/g, ' ');
  if (text.length <= DESCRIPTION_MAX_CHARS) return text;
  return `${text.slice(0, DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

function makeDecision(state, description, reason, context) {
  return {
    context,
    state,
    description: truncateDescription(description),
    reason,
  };
}

function reviewerFailureClass(reviewRow) {
  return reviewerFailureClassFromStoredRow(reviewRow);
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
  env = process.env,
} = {}) {
  const context = resolveGateStatusContext(env);
  const decide = (state, description, reason) =>
    makeDecision(state, description, reason, context);

  if (normalizeLabelNames(labels).some((label) => OPERATOR_SKIP_LABELS.has(label))) {
    return decide(
      'failure',
      'Explicit operator skip label blocks adversarial gate.',
      'operator-skip-label'
    );
  }

  if (hasMinimumOperatorApprovalFields(operatorApproval, headSha)) {
    return decide(
      'success',
      'Scoped operator override approves the current head.',
      'operator-approved'
    );
  }

  if (!reviewRow) {
    return decide('pending', 'Adversarial review has not posted yet.', 'review-not-posted');
  }

  const reviewStatus = normalizeReviewStatus(reviewRow.review_status);
  const latestJobStatus = normalizeFollowUpJobStatus(latestJob?.status);

  if (reviewStatus === 'pending') {
    if (latestJobStatus === 'completed' && latestJob?.reReview?.requested === true) {
      return decide('pending', 'Queued re-review has not posted yet.', 'rereview-queued');
    }
    return decide('pending', 'Adversarial review is queued.', 'review-queued');
  }
  if (reviewStatus === 'reviewing') {
    return decide('pending', 'Adversarial review is in progress.', 'review-in-progress');
  }
  if (reviewStatus === 'pending-upstream') {
    const failureClass = reviewerFailureClass(reviewRow);
    if (failureClass === 'reviewer-timeout') {
      return decide('pending', 'Adversarial reviewer timed out; retry is pending.', 'reviewer-timeout-retry-pending');
    }
    if (failureClass === 'launchctl-bootstrap') {
      return decide('pending', 'Claude reviewer bootstrap failed; retry is pending.', 'reviewer-bootstrap-retry-pending');
    }
    if (failureClass === 'cascade') {
      return decide('pending', 'Adversarial reviewer hit an upstream cascade; retry is pending.', 'reviewer-cascade-retry-pending');
    }
    return decide('pending', 'Adversarial review retry is pending.', 'review-retry-pending');
  }
  if (reviewStatus === 'fast_merge_skipped') {
    return decide(
      'pending',
      'Fast-merge review skip is recorded for this head.',
      'fast-merge-skipped'
    );
  }
  if (reviewStatus === 'malformed') {
    return decide('failure', 'Adversarial review ledger is malformed.', 'review-malformed');
  }

  // Stale-review-head guard. Stored review rows can intentionally publish a
  // green, operator-decides gate even when the reviewer never posted a clean
  // verdict (for example infra `failed` / `failed-orphan` rows), so the head
  // comparison must run before any stored-state branch that can return
  // `success`, not only before settled posted verdict handling. When the PR's
  // live head advances past the row's reviewer_head_sha, the stored outcome no
  // longer describes the tree being merged; report pending until the watcher
  // refreshes/re-reviews the current head.
  //
  // Fall through when either side is unknown: a null `headSha` means the caller
  // didn't supply a live head to compare, and a null `reviewer_head_sha` means a
  // legacy row predating that column. Operator override (`operator-approved`,
  // handled above) already pins to the current head, so it is unaffected.
  const reviewedHead = reviewRow.reviewer_head_sha || null;
  if (headSha && reviewedHead && String(reviewedHead) !== String(headSha)) {
    return decide(
      'pending',
      'Live head has advanced past the reviewed head; re-review of the current head is pending.',
      'stale-review-head'
    );
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
      return decide('success', 'Adversarial reviewer timed out before posting; operator decides.', 'reviewer-timeout');
    }
    if (failureClass === 'launchctl-bootstrap') {
      return decide('success', 'Claude reviewer bootstrap failed before posting; operator decides.', 'reviewer-launchctl-bootstrap');
    }
    if (failureClass === 'cascade') {
      return decide('success', 'Adversarial reviewer hit an upstream cascade before posting; operator decides.', 'reviewer-cascade');
    }
    return decide('success', 'Adversarial review failed before posting; operator decides.', 'review-failed');
  }
  if (reviewStatus === 'failed-orphan') {
    return decide('success', 'Adversarial review needs operator verification (orphaned reviewer).', 'review-failed-orphan');
  }
  if (reviewStatus !== 'posted') {
    return decide(
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
        return decide('success', 'Non-blocking adversarial review is settled.', 'review-settled');
      }
      if (normalizedVerdict === 'request-changes') {
        return decide('failure', 'Blocking adversarial review is still unsettled.', 'blocking-review');
      }
    }
    return decide('pending', 'Posted review is waiting for follow-up ledger reconciliation.', 'awaiting-ledger');
  }

  if (latestJobStatus === 'pending') {
    return decide('pending', 'Remediation is queued.', 'remediation-queued');
  }
  if (latestJobStatus === 'in-progress') {
    return decide('pending', 'Remediation is in progress.', 'remediation-in-progress');
  }
  const normalizedVerdict = normalizeReviewVerdict(extractReviewVerdict(latestJob.reviewBody));
  if (normalizedVerdict === 'comment-only' || normalizedVerdict === 'approved') {
    return decide('success', 'Non-blocking adversarial review is settled.', 'review-settled');
  }
  if (latestJobStatus === 'failed') {
    // Pipeline gave up (remediation worker died / infra issue) — don't block
    // operator's merge button. Real adversarial findings still surface in
    // the PR review comment thread; the operator decides without needing
    // admin override on mobile. See note in the `failed` branch above.
    return decide('success', 'Remediation failed; operator decides (see review thread).', 'remediation-failed');
  }
  if (latestJobStatus === 'stopped') {
    // Round budget exhausted. Last verdict may genuinely be Request-changes,
    // but at this point the operator has full context (the review thread)
    // and `request-changes` below still posts `failure` for the "verdict is
    // really request-changes after a settled remediation" case. The
    // `stopped` state itself is a pipeline-give-up signal, not an
    // adversarial signal — don't block the merge button on infra giving up.
    return decide('success', 'Remediation stopped; operator decides (see review thread).', 'remediation-stopped');
  }
  if (latestJobStatus === 'completed' && latestJob?.reReview?.requested === true) {
    return decide('pending', 'Queued re-review has not posted yet.', 'rereview-queued');
  }

  if (normalizedVerdict === 'request-changes') {
    return decide('failure', 'Blocking adversarial review is still unsettled.', 'blocking-review');
  }
  if (normalizedVerdict === null) {
    return decide('failure', 'Posted review is missing a verdict in the ledger.', 'missing-verdict');
  }
  return decide('failure', 'Posted review verdict is malformed.', 'unknown-verdict');
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
  mergeability = null,
  labels = [],
  prUpdatedAt = null,
  prAuthor = null,
  reviewRow = null,
  includeSettledReview = false,
  liveHeadReview = undefined,
  execFileImpl = execFileAsync,
  fetchLatestLabelEventImpl,
  operatorApprovalEvent = undefined,
} = {}) {
  const resolvedRow = reviewRow || await readReviewRowForGate(rootDir, { repo, prNumber });
  const latestJob = findLatestFollowUpJobForPR(rootDir, { repo, prNumber });
  const settledReview = includeSettledReview
    ? resolveSettledReviewVerdict(rootDir, {
      repo,
      prNumber,
      reviewRow: resolvedRow,
      currentHeadSha: headSha,
      liveHeadReview,
    })
    : null;
  const reviewedHeadSha = resolveProvenReviewedHead(settledReview);

  let operatorApproval = null;
  const hasOperatorApprovedLabel = normalizeLabelNames(labels).includes(OPERATOR_APPROVED_LABEL);
  if (hasOperatorApprovedLabel && headSha) {
    const event = operatorApprovalEvent === undefined && typeof fetchLatestLabelEventImpl === 'function'
      ? await fetchLatestLabelEventImpl(repo, prNumber, OPERATOR_APPROVED_LABEL, {
        execFileImpl,
      })
      : operatorApprovalEvent;
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
    settledReview,
    reviewedHeadSha,
    mergeableState: includeSettledReview ? normalizeGithubMergeability(mergeability || {}) : '',
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
  const context = decision.context || resolveGateStatusContext(env);

  // Operator kill-switch for the adversarial-gate status check.
  // Set ADVERSARIAL_GATE_STATUS_DISABLED=true in the watcher's
  // launchd plist (or the operator's local env) to skip the
  // `gh api POST /statuses` call. The watcher's other behavior
  // (reviews, remediation, audit) is unaffected; only the GitHub
  // status-check posting is suppressed. To re-enable, unset the
  // env var and bounce the watcher.
  const disabledByConfig = String(env.ADVERSARIAL_GATE_STATUS_DISABLED ?? '')
    .trim()
    .toLowerCase() === 'true';
  if (disabledByConfig) {
    return {
      posted: false,
      reason: 'disabled-by-config',
      record: { context, repo, prNumber: normalizedPrNumber, headSha, state: decision.state },
    };
  }

  const existingRecord = readGateRecord(
    rootDir,
    { repo, prNumber: normalizedPrNumber, headSha },
    readRecordImpl
  );
  if (matchesPublishedDecision(existingRecord, { ...decision, context })) {
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
      `context=${context}`,
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
    context,
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
  operatorApprovalEvent = undefined,
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
    includeSettledReview: false,
    execFileImpl,
    fetchLatestLabelEventImpl,
    operatorApprovalEvent,
  });
  const decision = pickAdversarialGateStatus({ ...snapshot, env });
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
  buildAdversarialGateSnapshot,
  deleteGateRecordsForPR,
  pickAdversarialGateStatus,
  projectAdversarialGateStatus,
  pruneGateRecordsForPR,
  publishAdversarialGateStatus,
  resolveProvenReviewedHead,
  resolveSettledReviewVerdict,
};
