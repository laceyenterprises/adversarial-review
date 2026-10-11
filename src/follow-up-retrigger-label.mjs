// PR-side operator surface for the `retrigger-remediation` label.
//
// Mirrors `npm run retrigger-remediation` (src/retrigger-remediation.mjs)
// but is invoked from the watcher when an operator applies the
// `retrigger-remediation` label to a PR — typically from the GitHub
// iOS / Android app or web UI on a halted PR. After successfully
// requeueing, the watcher removes the label so the next tick doesn't
// re-fire.
//
// Eligibility: the latest follow-up job must be an eligible terminal
// state (`failed`, `completed` with `reReview.requested = true`, or an
// explicitly retriggerable stopped code). `review-settled` is retriggerable:
// the automatic loop stops on Comment-only reviews, but an operator-applied
// label means "address the remaining non-blocking flags." Active or
// non-retriggerable stopped jobs leave the label in place; the operator can
// resolve the blocking state and the next tick will re-evaluate.
//
// SPEC §5.1.3 documents this as the PR-side counterpart to the CLI.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import {
  isRetriggerableStoppedFollowUpJob,
  requeueFollowUpJobForNextRound,
} from './follow-up-jobs.mjs';
import {
  bumpRemediationBudget,
  findLatestFollowUpJob,
} from './operator-retrigger-helpers.mjs';
import {
  appendOperatorMutationAuditRow,
  digestSha256,
  findOperatorMutationAuditRow,
  isCommittedOperatorMutationOutcome,
  resolveIdempotencyKey,
} from './operator-mutation-audit.mjs';
import { buildCodePrSubjectIdentity } from './identity-shapes.mjs';
import { createGitHubPRCommentsAdapter } from './adapters/comms/github-pr-comments/index.mjs';
import { findLiveAmaCloserLease, isHeldAmaCloserLease } from './ama/closer-lease.mjs';

const VERB = 'hq.adversarial.retrigger-remediation';

export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation';

const DEFAULT_REASON = 'Operator applied retrigger-remediation label.';
const DEFAULT_BUMP_BUDGET = 1;
const ACK_COMMENT_TIMEOUT_MS = 10_000;
const ACK_COMMENT_LOOKUP_TIMEOUT_MS = 15_000;
const ACK_COMMENT_RETRY_BUDGET_PER_TICK = 5;
const ACK_COMMENT_MAX_ATTEMPTS = 5;
const ACK_COMMENT_MARKER_PREFIX = 'adversarial-review-retrigger-remediation-ack';

function safePathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

function labelConsumptionPath(rootDir, labelEventKey) {
  const digest = digestSha256(labelEventKey).replace(/^sha256:/, '');
  return join(
    rootDir,
    'data',
    'follow-up-jobs',
    'label-consumptions',
    `${safePathSegment(RETRIGGER_REMEDIATION_LABEL)}-${digest}.json`
  );
}

function readLabelConsumption(rootDir, labelEventKey) {
  const filePath = labelConsumptionPath(rootDir, labelEventKey);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeLabelConsumption(rootDir, labelEventKey, doc) {
  writeFileAtomic(
    labelConsumptionPath(rootDir, labelEventKey),
    `${JSON.stringify(doc, null, 2)}\n`,
    { mode: 0o640 }
  );
}

function normalizeLabelEventKey({ repo, prNumber, labelEvent }) {
  const eventId = labelEvent?.id || labelEvent?.nodeId || null;
  if (eventId) return `github-label-event:${eventId}`;
  const createdAt = labelEvent?.createdAt || null;
  if (createdAt) {
    return `github-label:${repo}#${prNumber}:${RETRIGGER_REMEDIATION_LABEL}:${createdAt}`;
  }
  return null;
}

function isHaltedTerminal(job) {
  if (!job) return false;
  if (job.status === 'failed') return true;
  if (job.status === 'completed' && job?.reReview?.requested === true) return true;
  if (job.status === 'stopped') return isRetriggerableStoppedFollowUpJob(job);
  return false;
}

async function removeLabelFromPR({
  repo,
  prNumber,
  execFileImpl,
}) {
  await execFileImpl('gh', [
    'pr',
    'edit',
    String(prNumber),
    '--repo',
    repo,
    '--remove-label',
    RETRIGGER_REMEDIATION_LABEL,
  ], { maxBuffer: 5 * 1024 * 1024 });
}

function requeueOutcomeFromResult(requeueResult) {
  if (requeueResult?.job?.status === 'pending') return 'requeued';
  if (requeueResult?.outcome) return requeueResult.outcome;
  return 'requeue-failed';
}

function buildAckCommentMarker(labelEventKey) {
  const markerDigest = digestSha256(labelEventKey).replace(/^sha256:/, '');
  return `${ACK_COMMENT_MARKER_PREFIX}:${markerDigest}`;
}

function sanitizeAckCommentText(value, maxChars = 500) {
  const normalized = String(value ?? '')
    .replace(/<\/?[^>\n]+>/g, '')
    .replace(/`/g, "'")
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const escapedHeadings = normalized.replace(/^#+\s*/g, '# ');
  if (escapedHeadings.length <= maxChars) return escapedHeadings;
  return `${escapedHeadings.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

// NOOWNER-01: the acknowledgement for a label consumed on a PR with no
// follow-up job, naming what the watcher did instead of a requeue.
function buildNoJobAckCommentBody({ marker, safeActor, safeReason, noJobHandoff }) {
  const action = String(noJobHandoff?.action || 'none');
  const outcome = sanitizeAckCommentText(noJobHandoff?.outcome || 'unknown', 120) || 'unknown';
  const detail = noJobHandoff?.detail ? sanitizeAckCommentText(noJobHandoff.detail, 500) : null;
  const actionText = {
    hammer: 'handed the PR to the hammer through the CI-blocked owner route (CIBLOCKHAM-01)',
    job: 'created a follow-up job from the latest posted adversarial review, pinned to the live head',
  }[action] || 'found nothing to remediate';
  const needsOperator = action === 'none'
    || /error|not-handled|not-created|unavailable/.test(outcome);
  const lines = [
    `<!-- ${marker} -->`,
    needsOperator
      ? '### Remediation retrigger needs operator attention'
      : '### Remediation retrigger accepted (no follow-up job)',
    '',
    `The \`${RETRIGGER_REMEDIATION_LABEL}\` label was consumed. This PR had no follow-up job to requeue, `
      + `so the watcher ${actionText}.`,
    '',
    `- Requested by: \`${safeActor}\``,
    `- Action: \`${action}\``,
    `- Outcome: \`${outcome}\`${detail ? ` (${detail})` : ''}`,
    '',
    needsOperator
      ? 'Next: the label has been removed. Resolve the outcome above, then apply the label again or apply `retrigger-review` for a fresh adversarial pass.'
      : 'Next: the owner named above acts on this PR. The label has been removed so this request is not applied again.',
  ];
  if (safeReason) {
    lines.push('', `Reason: ${safeReason}`);
  }
  return lines.join('\n');
}

function buildAckCommentBody({
  labelEventKey,
  labelEventActor,
  reason,
  bumpResult,
  requeueResult,
  noJobHandoff = null,
}) {
  const marker = buildAckCommentMarker(labelEventKey);
  if (noJobHandoff) {
    return buildNoJobAckCommentBody({
      marker,
      safeActor: sanitizeAckCommentText(labelEventActor || 'unknown', 120) || 'unknown',
      safeReason: reason ? sanitizeAckCommentText(reason, 500) : null,
      noJobHandoff,
    });
  }
  const requeueOutcome = requeueOutcomeFromResult(requeueResult);
  const requeueReason = requeueResult?.reason || requeueResult?.error || null;
  const requeueFailed = requeueOutcome !== 'requeued';
  const safeActor = sanitizeAckCommentText(labelEventActor || 'unknown', 120) || 'unknown';
  const safeRequeueReason = requeueReason ? sanitizeAckCommentText(requeueReason, 500) : null;
  const safeReason = reason ? sanitizeAckCommentText(reason, 500) : null;
  const lines = [
    `<!-- ${marker} -->`,
    requeueFailed ? '### Remediation retrigger needs operator attention' : '### Remediation retrigger accepted',
    '',
    requeueFailed
      ? `The \`${RETRIGGER_REMEDIATION_LABEL}\` label was consumed after the remediation budget bump, but the watcher could not requeue the follow-up worker.`
      : `The \`${RETRIGGER_REMEDIATION_LABEL}\` label was accepted by the adversarial-review watcher.`,
    '',
    `- Requested by: \`${safeActor}\``,
    `- Remediation budget: \`${bumpResult.priorMaxRounds} -> ${bumpResult.newMaxRounds}\` rounds`,
    `- Remediation queue: \`${requeueOutcome}\`${safeRequeueReason ? ` (${safeRequeueReason})` : ''}`,
    '',
    requeueFailed
      ? 'Next: inspect the follow-up job and re-run the operator retrigger after the queue failure is fixed. The label has been removed so this accepted budget bump is not applied again.'
      : 'Next: the remediation worker will respond to the latest adversarial review. If it requests re-review, the watcher will post the follow-up review afterward. If the worker fails or is stopped before requesting re-review, apply `retrigger-review` separately to force a fresh adversarial pass.',
  ];
  if (safeReason) {
    lines.push('', `Reason: ${safeReason}`);
  }
  return lines.join('\n');
}

async function findExistingAckComment({
  repo,
  prNumber,
  marker,
  execFileImpl,
  timeoutMs = ACK_COMMENT_LOOKUP_TIMEOUT_MS,
}) {
  if (!marker) return { found: false };
  try {
    const { stdout } = await execFileImpl('gh', [
      'api',
      '--paginate',
      `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
      '-q',
      '.[] | {id: .id, body: .body}',
    ], {
      maxBuffer: 25 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    });
    for (const line of String(stdout).split('\n').filter(Boolean)) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (String(entry?.body || '').includes(marker)) {
        return { found: true, marker, commentId: entry?.id ?? null };
      }
    }
    return { found: false };
  } catch (err) {
    return {
      found: false,
      lookupFailed: true,
      reason: err?.killed === true ? 'lookup-timeout' : 'lookup-failure',
      error: err?.message || String(err),
    };
  }
}

async function postRetriggerAckComment({
  rootDir,
  repo,
  prNumber,
  execFileImpl,
  labelEventKey,
  labelEventActor,
  reason,
  bumpResult,
  requeueResult,
  revisionRef = null,
  noJobHandoff = null,
}) {
  const body = buildAckCommentBody({
    labelEventKey,
    labelEventActor,
    reason,
    bumpResult,
    requeueResult,
    noJobHandoff,
  });
  const marker = buildAckCommentMarker(labelEventKey);
  const existing = await findExistingAckComment({
    repo,
    prNumber,
    marker,
    execFileImpl,
  });
  if (existing.found) {
    return {
      posted: true,
      deduped: true,
      marker: existing.marker,
      commentId: existing.commentId ?? null,
    };
  }
  try {
    const receipt = await deliverRetriggerOperatorNotice({
      rootDir,
      repo,
      prNumber,
      execFileImpl,
      revisionRef: requireRevisionRef(revisionRef, 'postRetriggerAckComment'),
      noticeRef: labelEventKey,
      type: 'raised-round-cap',
      round: Math.max(0, Number(requeueResult?.job?.remediationPlan?.currentRound || 0)),
      reason,
      roundCap: bumpResult?.newMaxRounds ?? null,
      body,
    });
    return { posted: true, stdout: '', marker, commentId: receipt.deliveryExternalId };
  } catch (err) {
    return {
      posted: false,
      reason: err?.killed === true ? 'gh-cli-timeout' : 'gh-cli-failure',
      error: err?.message || String(err),
    };
  }
}

async function deliverRetriggerOperatorNotice({
  rootDir, repo, prNumber, execFileImpl, revisionRef, noticeRef, type, round, reason, roundCap = null, body,
}) {
  const subjectIdentity = buildCodePrSubjectIdentity({ repo, prNumber, revisionRef });
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    execFileImpl,
    commentTimeoutMs: ACK_COMMENT_TIMEOUT_MS,
    resolveGhToken: () => ({
      tokenEnvName: 'GITHUB_TOKEN',
      fallbackTokenEnvNames: ['GH_TOKEN'],
      allowGhAuthFallback: true,
    }),
  });
  return adapter.postOperatorNotice(
    {
      type,
      subjectRef: {
        domainId: subjectIdentity.domainId,
        subjectExternalId: subjectIdentity.subjectExternalId,
        revisionRef: subjectIdentity.revisionRef,
      },
      revisionRef: subjectIdentity.revisionRef,
      eventExternalId: noticeRef,
      observedAt: new Date().toISOString(),
      reason,
      roundCap,
    },
    body,
    {
      domainId: subjectIdentity.domainId,
      subjectExternalId: subjectIdentity.subjectExternalId,
      revisionRef: subjectIdentity.revisionRef,
      round,
      kind: 'operator-notice',
      noticeRef,
    }
  );
}

function buildPendingAckComment({
  labelEventKey, labelEventActor, reason, bumpResult, requeueResult, revisionRef = null, noJobHandoff = null,
}) {
  return {
    posted: false,
    reason: 'pending',
    attempts: 0,
    maxAttempts: ACK_COMMENT_MAX_ATTEMPTS,
    marker: buildAckCommentMarker(labelEventKey),
    context: {
      labelEventActor: labelEventActor || 'unknown',
      reason: reason || null,
      bumpResult: {
        priorMaxRounds: bumpResult?.priorMaxRounds ?? null,
        newMaxRounds: bumpResult?.newMaxRounds ?? null,
      },
      requeueResult: {
        outcome: requeueOutcomeFromResult(requeueResult),
        status: requeueResult?.job?.status || requeueResult?.status || null,
        jobPath: requeueResult?.jobPath || null,
        reason: requeueResult?.reason || null,
        error: requeueResult?.error || null,
      },
      revisionRef: revisionRef || null,
      ...(noJobHandoff ? { noJobHandoff } : {}),
    },
  };
}

function normalizeRevisionRef(revisionRef) {
  const normalized = String(revisionRef || '').trim();
  return normalized || null;
}

function requireRevisionRef(revisionRef, context) {
  const normalized = normalizeRevisionRef(revisionRef);
  if (!normalized) {
    throw new TypeError(`${context} requires a revisionRef`);
  }
  return normalized;
}

function buildLabelConsumptionDoc({
  labelEventKey,
  idempotencyKey,
  repo,
  prNumber,
  jobPath,
  auditStatus,
  auditRow,
  ackComment,
  consumedAt,
  auditedAt = null,
  labelRemoved = false,
}) {
  return {
    schemaVersion: 1,
    label: RETRIGGER_REMEDIATION_LABEL,
    labelEventKey,
    idempotencyKey,
    repo,
    prNumber: Number(prNumber),
    jobPath,
    auditStatus,
    auditRow,
    ackComment,
    labelRemoved,
    consumedAt,
    ...(auditedAt ? { auditedAt } : {}),
  };
}

async function retryAckCommentForConsumption({
  repo,
  prNumber,
  execFileImpl,
  consumption,
  rootDir,
  labelEventKey,
}) {
  if (consumption?.ackComment?.posted === true) return consumption;
  const context = consumption?.ackComment?.context;
  if (!context) return consumption;
  const previousAttempts = Number(consumption?.ackComment?.attempts || 0);
  if (!normalizeRevisionRef(context.revisionRef)) {
    const nextConsumption = {
      ...consumption,
      ackComment: {
        posted: false,
        reason: 'missing-revision-ref',
        error: 'cannot retry retrigger acknowledgement without a revisionRef',
        context,
        attempts: ACK_COMMENT_MAX_ATTEMPTS,
        maxAttempts: ACK_COMMENT_MAX_ATTEMPTS,
        attemptedAt: new Date().toISOString(),
      },
    };
    writeLabelConsumption(rootDir, labelEventKey, nextConsumption);
    return nextConsumption;
  }
  if (previousAttempts >= ACK_COMMENT_MAX_ATTEMPTS) return consumption;
  const ackComment = await postRetriggerAckComment({
    rootDir,
    repo,
    prNumber,
    execFileImpl,
    labelEventKey,
    labelEventActor: context.labelEventActor,
    reason: context.reason,
    bumpResult: context.bumpResult,
    requeueResult: context.requeueResult,
    revisionRef: context.revisionRef,
    noJobHandoff: context.noJobHandoff || null,
  });
  const nextConsumption = {
    ...consumption,
    ackComment: {
      ...ackComment,
      context,
      attempts: previousAttempts + 1,
      maxAttempts: ACK_COMMENT_MAX_ATTEMPTS,
      attemptedAt: new Date().toISOString(),
    },
  };
  writeLabelConsumption(rootDir, labelEventKey, nextConsumption);
  return nextConsumption;
}

async function retryConsumedLabelRemoval({
  repo,
  prNumber,
  execFileImpl,
  consumption,
  auditRootDir,
  appendAuditRow,
  rootDir,
  labelEventKey,
}) {
  let nextConsumption = consumption;
  if (nextConsumption?.auditStatus === 'pending') {
    try {
      appendAuditRow(auditRootDir, nextConsumption.auditRow);
    } catch (err) {
      return {
        outcome: 'label-already-consumed-audit-failed',
        detail: `label event was already consumed; operator mutation audit append failed: ${err?.message || err}`,
        jobPath: nextConsumption?.jobPath || null,
      };
    }
    nextConsumption = {
      ...nextConsumption,
      auditStatus: 'written',
      auditedAt: nextConsumption.auditedAt || new Date().toISOString(),
    };
    writeLabelConsumption(rootDir, labelEventKey, nextConsumption);
  }

  try {
    await removeLabelFromPR({ repo, prNumber, execFileImpl });
  } catch (err) {
    return {
      outcome: 'label-already-consumed-removal-failed',
      detail: `label event was already consumed; label removal failed: ${err?.message || err}`,
      jobPath: nextConsumption?.jobPath || null,
    };
  }

  nextConsumption = await retryAckCommentForConsumption({
    repo,
    prNumber,
    execFileImpl,
    consumption: nextConsumption,
    rootDir,
    labelEventKey,
  });

  return {
    outcome: 'label-already-consumed',
    detail: 'label event was already consumed; retried label removal without bumping budget',
    jobPath: nextConsumption?.jobPath || null,
    ackComment: nextConsumption?.ackComment || null,
  };
}

export async function retryPendingRetriggerAckComments({
  rootDir,
  execFileImpl,
  budget = ACK_COMMENT_RETRY_BUDGET_PER_TICK,
} = {}) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'label-consumptions');
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (err) {
    if (err?.code === 'ENOENT') return { attempted: 0, posted: 0 };
    throw err;
  }
  let attempted = 0;
  let posted = 0;
  for (const name of names) {
    if (attempted >= budget) break;
    const filePath = join(dir, name);
    let consumption;
    try {
      consumption = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (
      consumption?.label !== RETRIGGER_REMEDIATION_LABEL ||
      consumption?.auditStatus !== 'written' ||
      consumption?.ackComment?.posted === true ||
      Number(consumption?.ackComment?.attempts || 0) >= ACK_COMMENT_MAX_ATTEMPTS ||
      !consumption?.ackComment?.context
    ) {
      continue;
    }
    attempted += 1;
    const next = await retryAckCommentForConsumption({
      repo: consumption.repo,
      prNumber: consumption.prNumber,
      execFileImpl,
      consumption,
      rootDir,
      labelEventKey: consumption.labelEventKey,
    });
    if (next?.ackComment?.posted === true) posted += 1;
  }
  return { attempted, posted };
}

// REMCONFLICT-01 (SEV1, 2026-10-10): an accepted retrigger always ends in a
// visible outcome. Operator: "there are examples in this queue of accepted
// retriggers that never got actioned". The label path above only re-arms a
// pending job file. A refusal after that (closer lease held,
// `max-rounds-reached`, `stale-review-head`, `round-budget-exhausted`, a failed
// `hq dispatch`) was visible only in daemon logs. So once a label consumed
// with `bumped-and-requeued` is older than the outcome timeout (default 10
// minutes, `ADVERSARIAL_RETRIGGER_OUTCOME_TIMEOUT_MS`), the watcher checks
// whether a worker was spawned for that job since. If none was, it appends one
// operator-mutation audit row and posts ONE comment naming the refusal code and
// what the operator can do. The marker and the consumption record make it
// exactly one. This only reports; it gates nothing. Labels consumed more than
// OUTCOME_MAX_AGE_MS ago are not reported, so the first deploy does not comment
// on old PRs, and a PR that has since merged or closed is closed out silently.
export const RETRIGGER_OUTCOME_TIMEOUT_ENV = 'ADVERSARIAL_RETRIGGER_OUTCOME_TIMEOUT_MS';
export const DEFAULT_RETRIGGER_OUTCOME_TIMEOUT_MS = 10 * 60_000;
const OUTCOME_COMMENT_MARKER_PREFIX = 'adversarial-review-retrigger-remediation-outcome';
const OUTCOME_SWEEP_BUDGET_PER_TICK = 5;
// Keep enumeration progress across ticks, including malformed and young files,
// so the read budget cannot starve later records. Settled receipts are immutable.
const outcomeScans = new Map();
const OUTCOME_DONE_CACHE_LIMIT = 1024;

function rememberDoneOutcome(scan, name) {
  scan.done.delete(name);
  scan.done.add(name);
  if (scan.done.size > OUTCOME_DONE_CACHE_LIMIT) {
    scan.done.delete(scan.done.values().next().value);
  }
}
const OUTCOME_MAX_ATTEMPTS = 5;
const OUTCOME_MAX_AGE_MS = 24 * 60 * 60_000;
const PR_GONE_CODES = new Set(['operator-merged-pr', 'operator-closed-pr']);
const JOB_STATUS_DIRS = ['pending', 'in-progress', 'completed', 'failed', 'stopped', 'stopped-archived'];
const HEAD_MOVED_CODES = new Set(['stale-review-head', 'revision-superseded', 'newer-review-pending']);
const ROUND_CAP_CODES = new Set(['max-rounds-reached', 'round-budget-exhausted']);

export function resolveRetriggerOutcomeTimeoutMs(env = process.env) {
  const configured = Number(env?.[RETRIGGER_OUTCOME_TIMEOUT_ENV]);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_RETRIGGER_OUTCOME_TIMEOUT_MS;
}

function findFollowUpJobByFile(rootDir, jobPath) {
  const name = jobPath ? basename(jobPath) : '';
  if (!name) return null;
  for (const dir of JOB_STATUS_DIRS) {
    const candidate = join(rootDir, 'data', 'follow-up-jobs', dir, name);
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (err) {
      // Only an absent record is evidence to try the next status directory.
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return null;
}

function firstSpawnSince(job, sinceMs) {
  const spawns = [job?.remediationWorker?.spawnedAt, ...(job?.remediationPlan?.rounds || []).map((round) => round?.spawnedAt)]
    .map((value) => Date.parse(value || ''))
    .filter((ms) => Number.isFinite(ms) && ms >= sinceMs)
    .sort((a, b) => a - b);
  return spawns.length ? new Date(spawns[0]).toISOString() : null;
}

function closerLeaseHeldFor(rootDir, job, now) {
  try {
    const held = findLiveAmaCloserLease(rootDir, { repo: job.repo, prNumber: job.prNumber });
    return Boolean(held && isHeldAmaCloserLease(rootDir, { repo: job.repo, prNumber: job.prNumber, headSha: held.headSha }, { now }));
  } catch {
    return false;
  }
}

/**
 * What happened to the job an accepted retrigger re-armed: either a worker was
 * spawned for it after `consumedAt`, or the code that kept one from starting.
 */
export function classifyRetriggerOutcome({ rootDir, job, consumedAt, now }) {
  if (!job) return { spawned: false, code: 'job-not-found', detail: 'the requeued follow-up job record is gone' };
  const spawnedAt = firstSpawnSince(job, Date.parse(consumedAt));
  if (spawnedAt) return { spawned: true, spawnedAt };
  const plan = job.remediationPlan || {};
  if (job.status === 'stopped') {
    return { spawned: false, code: plan.stop?.code || 'stopped', detail: plan.stop?.reason || null, status: 'stopped' };
  }
  if (job.status === 'failed') {
    return { spawned: false, code: job.failure?.code || 'failed', detail: job.failure?.message || null, status: 'failed' };
  }
  if (job.status === 'completed') return { spawned: false, code: 'completed-without-worker', detail: null, status: 'completed' };
  if (job.status === 'in_progress') return { spawned: false, code: 'claimed-not-spawned', detail: null, status: 'in_progress' };
  const retryAfterMs = Date.parse(plan.retryAfter || '');
  if (Number.isFinite(retryAfterMs) && retryAfterMs > Date.parse(now)) {
    const lastRetry = (plan.retryHistory || []).at(-1)?.retryMetadata || {};
    return {
      spawned: false,
      code: lastRetry.code || job.lastWorkflowPushPreflightFailure?.code || 'retry-scheduled',
      detail: `next attempt after ${plan.retryAfter}`,
      status: 'pending',
    };
  }
  if (closerLeaseHeldFor(rootDir, job, now)) {
    return { spawned: false, code: 'closer-lease-held', detail: 'the AMA closer (hammer) holds this PR', status: 'pending' };
  }
  return { spawned: false, code: 'not-yet-claimed', detail: null, status: 'pending' };
}

function retriggerOutcomeNextStep({ code, status, retriggerable }) {
  if (code === 'job-not-found') {
    return 'The requeued job record is missing. Apply `retrigger-remediation` again to generate a new job record.';
  }
  if (code === 'closer-lease-held') {
    return 'The hammer (AMA closer) owns this PR right now and remediation waits for its lease to end. It owns merge-conflict resolution too. If the lease does not end, check the closer dispatch for this PR.';
  }
  if (ROUND_CAP_CODES.has(code)) {
    return 'The remediation round budget is spent, so the round-cap hammer handoff owns the final close. Apply `retrigger-remediation` again to grant one more round.';
  }
  if (HEAD_MOVED_CODES.has(code)) {
    return 'The PR head moved after the review this job answers. Apply `retrigger-review` for a fresh review of the current head; remediation follows it.';
  }
  if (code === 'hq-conflicted-base-unsupported') {
    return 'The PR has merge conflicts and the installed `hq dispatch` could not pass `--allow-conflicted-base`. Check or upgrade agent-os hq, then apply `retrigger-remediation`.';
  }
  if (status === 'failed') {
    return 'The dispatch failed before a worker started. Inspect the job under `data/follow-up-jobs/failed/` and the follow-up daemon log, fix the cause, then apply `retrigger-remediation`.';
  }
  if (status === 'stopped') {
    return retriggerable
      ? 'Fix the cause named above, then apply `retrigger-remediation` again.'
      : 'This stop is not retriggerable from the label; clear the operator hold it names before retriggering.';
  }
  return 'The job is queued but the remediation daemon has not started a worker (capacity, an active job on this PR, a scheduled retry, or the daemon is down). Check the follow-up daemon; the job will start when it is claimed.';
}

function buildRetriggerOutcomeCommentBody({ marker, report, timeoutMinutes }) {
  const detail = report.detail ? sanitizeAckCommentText(report.detail, 400) : null;
  const lines = [
    `<!-- ${marker} -->`,
    '### Remediation retrigger did not start a worker',
    '',
    `The \`${RETRIGGER_REMEDIATION_LABEL}\` label was accepted at ${report.consumedAt}, but no remediation worker had started for the requeued job ${timeoutMinutes} minutes later.`,
    '',
    `- Refusal: \`${sanitizeAckCommentText(report.code, 120)}\`${detail ? ` (${detail})` : ''}`,
    `- Job state: \`${report.status || 'unknown'}\``,
    '',
    `Next: ${report.nextStep}`,
  ];
  return lines.join('\n');
}

export async function reportStalledRetriggerOutcomes({
  rootDir,
  execFileImpl,
  auditRootDir = rootDir,
  appendAuditRow = appendOperatorMutationAuditRow,
  now = () => new Date().toISOString(),
  env = process.env,
  timeoutMs = resolveRetriggerOutcomeTimeoutMs(env),
  budget = OUTCOME_SWEEP_BUDGET_PER_TICK,
  logger = console,
} = {}) {
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'label-consumptions');
  let scan = outcomeScans.get(dir);
  if (!scan) {
    scan = { iterator: null, done: new Set() };
    outcomeScans.set(dir, scan);
  }
  if (!scan.iterator && budget > 0) {
    try {
      scan.iterator = (await opendir(dir, { bufferSize: OUTCOME_SWEEP_BUDGET_PER_TICK }))[Symbol.asyncIterator]();
    } catch (err) {
      if (err?.code === 'ENOENT') return { checked: 0, spawned: 0, reported: 0 };
      throw err;
    }
  }
  let checked = 0;
  let spawned = 0;
  let reported = 0;
  for (let scanned = 0; scanned < budget; scanned += 1) {
    const entry = await scan.iterator.next();
    if (entry.done) {
      scan.iterator = null;
      break;
    }
    const name = entry.value.name;
    if (!name.endsWith('.json') || scan.done.has(name)) continue;
    let consumption;
    try {
      consumption = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const outcome = consumption?.outcomeReport || null;
    if (outcome?.done === true) rememberDoneOutcome(scan, name);
    if (
      consumption?.label !== RETRIGGER_REMEDIATION_LABEL
      || consumption?.auditStatus !== 'written'
      || consumption?.auditRow?.outcome !== 'bumped-and-requeued'
      || !consumption?.jobPath
      || outcome?.done === true
      || Number(outcome?.attempts || 0) >= OUTCOME_MAX_ATTEMPTS
    ) {
      continue;
    }
    const at = now();
    const consumedAtMs = Date.parse(consumption.consumedAt || '');
    const ageMs = Date.parse(at) - consumedAtMs;
    if (!Number.isFinite(consumedAtMs) || ageMs < timeoutMs || ageMs > OUTCOME_MAX_AGE_MS + timeoutMs) continue;
    checked += 1;
    const write = (next) => {
      writeLabelConsumption(rootDir, consumption.labelEventKey, { ...consumption, outcomeReport: next });
      if (next.done === true) rememberDoneOutcome(scan, name);
    };

    if (!outcome?.code) {
      const job = findFollowUpJobByFile(rootDir, consumption.jobPath);
      const classified = classifyRetriggerOutcome({ rootDir, job, consumedAt: consumption.consumedAt, now: at });
      if (classified.spawned) {
        spawned += 1;
        write({ done: true, state: 'spawned', spawnedAt: classified.spawnedAt, checkedAt: at });
        continue;
      }
      if (PR_GONE_CODES.has(classified.code)) {
        write({ done: true, state: 'pr-gone', code: classified.code, checkedAt: at });
        continue;
      }
      // Freeze what is reported, so a retried post says the same thing.
      const report = {
        state: 'reporting',
        code: classified.code,
        detail: classified.detail ? sanitizeAckCommentText(classified.detail, 400) : null,
        status: classified.status || null,
        consumedAt: consumption.consumedAt,
        nextStep: retriggerOutcomeNextStep({
          ...classified,
          retriggerable: Boolean(job && isRetriggerableStoppedFollowUpJob(job)),
        }),
        jobId: job?.jobId || null,
        classifiedAt: at,
        audited: false,
        attempts: 0,
      };
      consumption.outcomeReport = report;
      write(report);
    }
    const report = consumption.outcomeReport;
    const repo = consumption.repo;
    const prNumber = consumption.prNumber;
    const revisionRef = normalizeRevisionRef(consumption.auditRow?.revisionRef || consumption.ackComment?.context?.revisionRef);
    if (!report.audited) {
      try {
        appendAuditRow(auditRootDir, {
          ts: at,
          verb: VERB,
          repo,
          pr: prNumber,
          revisionRef,
          reason: consumption.auditRow?.reason || DEFAULT_REASON,
          operator: 'system:retrigger-outcome-watch',
          jobKey: consumption.auditRow?.jobKey || null,
          idempotencyKey: `${consumption.idempotencyKey}:outcome`,
          source: 'retrigger-outcome-watch',
          labelEventKey: consumption.labelEventKey,
          refusalCode: report.code,
          jobStatus: report.status,
          outcome: 'retrigger-not-actioned',
        });
        report.audited = true;
        write(report);
      } catch (err) {
        logger?.error?.(`[retrigger-remediation-label] outcome audit append failed for ${repo}#${prNumber}: ${err?.message || err}`);
      }
    }
    const marker = `${OUTCOME_COMMENT_MARKER_PREFIX}:${digestSha256(consumption.labelEventKey).replace(/^sha256:/, '')}`;
    let posted;
    const existing = await findExistingAckComment({ repo, prNumber, marker, execFileImpl });
    if (existing.found) {
      posted = { posted: true, deduped: true, commentId: existing.commentId ?? null };
    } else if (!revisionRef) {
      posted = { posted: false, reason: 'missing-revision-ref' };
    } else {
      try {
        const receipt = await deliverRetriggerOperatorNotice({
          rootDir,
          repo,
          prNumber,
          execFileImpl,
          revisionRef,
          noticeRef: `${consumption.labelEventKey}:outcome`,
          type: 'retrigger-outcome',
          round: 0,
          reason: `retrigger outcome: ${report.code}`,
          body: buildRetriggerOutcomeCommentBody({ marker, report, timeoutMinutes: Math.round(timeoutMs / 60_000) }),
        });
        posted = { posted: true, commentId: receipt.deliveryExternalId };
      } catch (err) {
        posted = { posted: false, reason: err?.killed === true ? 'gh-cli-timeout' : 'gh-cli-failure', error: err?.message || String(err) };
      }
    }
    const attempts = Number(report.attempts || 0) + 1;
    if (posted.posted) {
      reported += 1;
      write({ ...report, done: true, state: 'reported', reportedAt: at, attempts, commentId: posted.commentId ?? null });
      logger?.log?.(`[retrigger-remediation-label] ${repo}#${prNumber}: accepted retrigger did not start a worker; reported ${report.code}`);
    } else {
      write({ ...report, attempts, lastError: posted.error || posted.reason, attemptedAt: at });
    }
  }
  return { checked, spawned, reported };
}

export async function tryRetriggerRemediationFromLabel({
  rootDir,
  repo,
  prNumber,
  labelActor = 'unknown',
  reason = DEFAULT_REASON,
  bumpBudget = DEFAULT_BUMP_BUDGET,
  auditRootDir = rootDir,
  execFileImpl,
  now = () => new Date().toISOString(),
  appendAuditRow = appendOperatorMutationAuditRow,
  findAuditRow = findOperatorMutationAuditRow,
  requeueImpl = requeueFollowUpJobForNextRound,
  labelEvent = null,
  revisionRef = null,
  // NOOWNER-01: `async ({ repo, prNumber, revisionRef }) => ({ action, outcome,
  // detail })`, called when the PR has no follow-up job (see
  // src/retrigger-no-job-handoff.mjs). Without it, `no-job` leaves the label.
  noJobHandoffImpl = null,
}) {
  const labelEventKey = normalizeLabelEventKey({ repo, prNumber, labelEvent });
  if (!labelEventKey) {
    return {
      outcome: 'label-event-missing',
      detail: 'cannot attribute retrigger-remediation to a GitHub labeled event',
    };
  }
  const normalizedRevisionRef = normalizeRevisionRef(
    revisionRef || labelEvent?.headSha || labelEvent?.head_sha
  );
  if (!normalizedRevisionRef) {
    return {
      outcome: 'missing-revision-ref',
      detail: 'retrigger-remediation label requires the current PR head revisionRef before it can bump or requeue',
      ackComment: {
        posted: false,
        reason: 'missing-revision-ref',
      },
    };
  }
  const labelEventActor = labelEvent?.actor || labelActor || 'unknown';
  const fingerprintReason = `${reason}|labelEvent=${labelEventKey}`;
  const { requestFingerprint, idempotencyKey } = resolveIdempotencyKey({
    verb: VERB,
    repo,
    pr: prNumber,
    reason: fingerprintReason,
  });

  const existingConsumption = readLabelConsumption(rootDir, labelEventKey);
  if (existingConsumption) {
    return retryConsumedLabelRemoval({
      repo,
      prNumber,
      execFileImpl,
      consumption: existingConsumption,
      auditRootDir,
      appendAuditRow,
      rootDir,
      labelEventKey,
    });
  }

  const existingAuditRow = findAuditRow(auditRootDir, idempotencyKey);
  if (existingAuditRow && isCommittedOperatorMutationOutcome(existingAuditRow.outcome)) {
    return retryConsumedLabelRemoval({
      repo,
      prNumber,
      execFileImpl,
      consumption: {
        auditStatus: 'written',
        auditRow: existingAuditRow,
        jobPath: null,
      },
      auditRootDir,
      appendAuditRow,
      rootDir,
      labelEventKey,
    });
  }

  const latest = findLatestFollowUpJob(rootDir, { repo, prNumber });
  if (!latest && typeof noJobHandoffImpl === 'function') {
    return consumeLabelWithoutJob({
      rootDir, repo, prNumber, execFileImpl, now, appendAuditRow, auditRootDir, reason,
      labelEvent, labelEventKey, labelEventActor, idempotencyKey,
      revisionRef: normalizedRevisionRef, noJobHandoffImpl,
    });
  }
  if (!latest) {
    return { outcome: 'no-job', detail: 'no follow-up job exists for this PR yet' };
  }
  if (!isHaltedTerminal(latest.job)) {
    return {
      outcome: 'job-active',
      detail: `job is in '${latest.job.status}' state; leaving label in place for next tick`,
    };
  }

  const jobKey = `${latest.job.repo}#${latest.job.prNumber}@${latest.job.jobId}`;
  const ts = now();
  const subjectIdentity = buildCodePrSubjectIdentity({ repo, prNumber, revisionRef: normalizedRevisionRef });
  const auditRow = {
    ts,
    verb: VERB,
    repo,
    pr: prNumber,
    domainId: subjectIdentity.domainId,
    subjectExternalId: subjectIdentity.subjectExternalId,
    revisionRef: subjectIdentity.revisionRef,
    reason,
    operator: `pr-label:${labelEventActor}`,
    jobKey,
    idempotencyKey,
    source: 'pr-label',
    labelEvent: {
      id: labelEvent?.id || null,
      nodeId: labelEvent?.nodeId || null,
      actor: labelEventActor,
      createdAt: labelEvent?.createdAt || null,
      label: RETRIGGER_REMEDIATION_LABEL,
    },
  };

  const bumpResult = bumpRemediationBudget({
    rootDir,
    repo,
    prNumber,
    bumpBudget,
    auditEntry: {
      idempotencyKey,
      requestFingerprint,
      reason,
      operator: `pr-label:${labelEventActor}`,
      ts,
      auditRow,
    },
  });

  if (!bumpResult.bumped) {
    return {
      outcome: `bump-refused:${bumpResult.reason}`,
      detail: `bumpRemediationBudget refused: ${bumpResult.reason}`,
      jobPath: bumpResult.jobPath,
    };
  }

  const bumpedAuditRow = {
    ...auditRow,
    priorMaxRounds: bumpResult.priorMaxRounds,
    newMaxRounds: bumpResult.newMaxRounds,
    requeueOutcome: 'not-attempted',
    outcome: 'bumped-requeue-pending',
  };
  const initialAckComment = buildPendingAckComment({
    labelEventKey,
    labelEventActor,
    reason,
    bumpResult,
    requeueResult: {
      outcome: 'not-attempted',
      reason: 'requeue step pending',
      jobPath: bumpResult.jobPath,
    },
    revisionRef: normalizedRevisionRef,
  });
  const baseConsumption = buildLabelConsumptionDoc({
    labelEventKey,
    idempotencyKey,
    repo,
    prNumber,
    jobPath: bumpResult.jobPath,
    auditStatus: 'pending',
    auditRow: bumpedAuditRow,
    ackComment: initialAckComment,
    consumedAt: ts,
  });
  writeLabelConsumption(rootDir, labelEventKey, baseConsumption);

  try {
    appendAuditRow(auditRootDir, bumpedAuditRow);
    writeLabelConsumption(rootDir, labelEventKey, {
      ...baseConsumption,
      auditStatus: 'written',
      auditedAt: ts,
    });
  } catch (err) {
    return {
      outcome: 'bumped-audit-failed',
      detail: `bumped OK but operator mutation audit append failed: ${err?.message || err}`,
      jobPath: bumpResult.jobPath,
      newMaxRounds: bumpResult.newMaxRounds,
    };
  }

  async function finishAfterRequeueAttempt({ requeueResult, terminalAuditRow, detail, outcome }) {
    const pendingAckComment = buildPendingAckComment({
      labelEventKey,
      labelEventActor,
      reason,
      bumpResult,
      requeueResult,
      revisionRef: normalizedRevisionRef,
    });

    try {
      appendAuditRow(auditRootDir, terminalAuditRow);
    } catch (err) {
      console.error(
        `[retrigger-remediation-label] terminal audit append failed for ${repo}#${prNumber}:`,
        err?.message || err
      );
    }

    const nextJobPath = requeueResult?.jobPath || bumpResult.jobPath;
    writeLabelConsumption(rootDir, labelEventKey, buildLabelConsumptionDoc({
      labelEventKey,
      idempotencyKey,
      repo,
      prNumber,
      jobPath: nextJobPath,
      auditStatus: 'written',
      auditRow: terminalAuditRow,
      ackComment: pendingAckComment,
      consumedAt: ts,
      auditedAt: ts,
    }));

    let labelRemoved = false;
    try {
      await removeLabelFromPR({ repo, prNumber, execFileImpl });
      labelRemoved = true;
    } catch (err) {
      return {
        outcome: outcome === 'bumped-and-requeued'
          ? 'bumped-label-removal-failed'
          : 'bumped-requeue-failed-label-removal-failed',
        detail: `${detail}; label removal failed: ${err?.message || err}`,
        jobPath: nextJobPath,
        newMaxRounds: bumpResult.newMaxRounds,
      };
    }

    const ackComment = await postRetriggerAckComment({
      rootDir,
      repo,
      prNumber,
      execFileImpl,
      labelEventKey,
      labelEventActor,
      reason,
      bumpResult,
      requeueResult,
      revisionRef: normalizedRevisionRef,
    });
    writeLabelConsumption(rootDir, labelEventKey, buildLabelConsumptionDoc({
      labelEventKey,
      idempotencyKey,
      repo,
      prNumber,
      jobPath: nextJobPath,
      auditStatus: 'written',
      auditRow: terminalAuditRow,
      ackComment: {
        ...ackComment,
        context: pendingAckComment.context,
        attempts: 1,
        maxAttempts: ACK_COMMENT_MAX_ATTEMPTS,
        attemptedAt: new Date().toISOString(),
      },
      labelRemoved,
      consumedAt: ts,
      auditedAt: ts,
    }));

    return {
      outcome,
      detail,
      jobPath: nextJobPath,
      newMaxRounds: bumpResult.newMaxRounds,
      labelRemoved,
      ackComment,
      requeueOutcome: requeueOutcomeFromResult(requeueResult),
    };
  }

  // `retrigger-remediation` means "run another remediation worker
  // against the latest posted review." Rationale (post-2026-05-08,
  // PR #48 regression): force-requeue is safe only because the watcher
  // defers reviewer dispatch while the latest follow-up job is
  // pending/inProgress for the same PR. `requeueFollowUpJobForNextRound`
  // writes the pending job before this function returns, so even if the
  // watcher row was already `review_status='pending'`, the same tick
  // will skip the fresh review until the worker terminates and the
  // normal worker completion path requests re-review.
  let requeueResult;
  try {
    requeueResult = requeueImpl({
      rootDir,
      jobPath: bumpResult.jobPath,
      requestedAt: ts,
      requestedBy: `pr-label:${labelEventActor}`,
      reason,
      // Pass the resolved current head so the requeue path can write it
      // into nextJob.revisionRef. Without this, a stopped:stale-review-head
      // requeue would re-fire the same stop on the next consume tick
      // (round-1 review B1).
      revisionRef: normalizedRevisionRef,
    });
  } catch (err) {
    const failedRequeue = {
      outcome: 'requeue-failed',
      status: 'failed',
      jobPath: bumpResult.jobPath,
      error: err?.message || String(err),
    };
    return finishAfterRequeueAttempt({
      requeueResult: failedRequeue,
      terminalAuditRow: {
        ...bumpedAuditRow,
        requeueOutcome: requeueOutcomeFromResult(failedRequeue),
        requeueError: failedRequeue.error,
        outcome: 'bumped-requeue-failed',
      },
      outcome: 'bumped-requeue-failed',
      detail: `bumped OK but follow-up requeue failed: ${failedRequeue.error}`,
    });
  }

  if (requeueResult?.job?.status !== 'pending') {
    return finishAfterRequeueAttempt({
      requeueResult,
      terminalAuditRow: {
        ...bumpedAuditRow,
        requeueOutcome: requeueOutcomeFromResult(requeueResult),
        requeueStatus: requeueResult?.job?.status || requeueResult?.status || null,
        outcome: 'bumped-requeue-failed',
      },
      outcome: 'bumped-requeue-failed',
      detail: 'bumped OK but follow-up requeue did not produce a pending job',
    });
  }

  const terminalAuditRow = {
    ...bumpedAuditRow,
    priorMaxRounds: bumpResult.priorMaxRounds,
    newMaxRounds: bumpResult.newMaxRounds,
    requeueOutcome: requeueOutcomeFromResult(requeueResult),
    outcome: 'bumped-and-requeued',
  };
  return finishAfterRequeueAttempt({
    requeueResult,
    terminalAuditRow,
    outcome: 'bumped-and-requeued',
    detail: `bumped maxRounds ${bumpResult.priorMaxRounds} → ${bumpResult.newMaxRounds}, requeued remediation worker`,
  });
}

// NOOWNER-01: consume a label applied to a PR with no follow-up job. Same
// durability order as the requeue path: consumption record, audit row, label
// removal, acknowledgement. A failed removal or comment is retried by the
// `label-already-consumed` path and `retryPendingRetriggerAckComments`.
async function consumeLabelWithoutJob({
  rootDir, repo, prNumber, execFileImpl, now, appendAuditRow, auditRootDir, reason,
  labelEvent, labelEventKey, labelEventActor, idempotencyKey, revisionRef, noJobHandoffImpl,
}) {
  let noJobHandoff;
  try {
    const handoff = await noJobHandoffImpl({ repo, prNumber, revisionRef });
    noJobHandoff = {
      action: String(handoff?.action || 'none'),
      outcome: String(handoff?.outcome || 'unknown'),
      detail: handoff?.detail ? String(handoff.detail) : null,
    };
  } catch (err) {
    noJobHandoff = { action: 'none', outcome: 'handoff-error', detail: err?.message || String(err) };
  }
  const ts = now();
  const subjectIdentity = buildCodePrSubjectIdentity({ repo, prNumber, revisionRef });
  const auditRow = {
    ts,
    verb: VERB,
    repo,
    pr: prNumber,
    domainId: subjectIdentity.domainId,
    subjectExternalId: subjectIdentity.subjectExternalId,
    revisionRef: subjectIdentity.revisionRef,
    reason,
    operator: `pr-label:${labelEventActor}`,
    jobKey: null,
    idempotencyKey,
    source: 'pr-label',
    labelEvent: {
      id: labelEvent?.id || null,
      nodeId: labelEvent?.nodeId || null,
      actor: labelEventActor,
      createdAt: labelEvent?.createdAt || null,
      label: RETRIGGER_REMEDIATION_LABEL,
    },
    noJobHandoff,
    outcome: `no-job-${noJobHandoff.action}`,
  };
  const ackContext = buildPendingAckComment({
    labelEventKey, labelEventActor, reason, revisionRef, noJobHandoff,
  });
  const consumption = buildLabelConsumptionDoc({
    labelEventKey, idempotencyKey, repo, prNumber, jobPath: null,
    auditStatus: 'pending', auditRow, ackComment: ackContext, consumedAt: ts,
  });
  writeLabelConsumption(rootDir, labelEventKey, consumption);
  try {
    appendAuditRow(auditRootDir, auditRow);
  } catch (err) {
    return {
      outcome: 'no-job-audit-failed',
      detail: `no follow-up job; ${noJobHandoff.action} -> ${noJobHandoff.outcome}; operator mutation audit append failed: ${err?.message || err}`,
      noJobHandoff,
    };
  }
  writeLabelConsumption(rootDir, labelEventKey, { ...consumption, auditStatus: 'written', auditedAt: ts });

  let labelRemoved = false;
  try {
    await removeLabelFromPR({ repo, prNumber, execFileImpl });
    labelRemoved = true;
  } catch (err) {
    return {
      outcome: 'no-job-label-removal-failed',
      detail: `no follow-up job; ${noJobHandoff.action} -> ${noJobHandoff.outcome}; label removal failed: ${err?.message || err}`,
      noJobHandoff,
    };
  }
  const ackComment = await postRetriggerAckComment({
    rootDir, repo, prNumber, execFileImpl, labelEventKey, labelEventActor, reason,
    bumpResult: null, requeueResult: null, revisionRef, noJobHandoff,
  });
  writeLabelConsumption(rootDir, labelEventKey, {
    ...consumption,
    auditStatus: 'written',
    auditedAt: ts,
    labelRemoved,
    ackComment: {
      ...ackComment,
      context: ackContext.context,
      attempts: 1,
      maxAttempts: ACK_COMMENT_MAX_ATTEMPTS,
      attemptedAt: new Date().toISOString(),
    },
  });
  return {
    outcome: `no-job-${noJobHandoff.action}`,
    detail: `no follow-up job; ${noJobHandoff.action} -> ${noJobHandoff.outcome}`
      + (noJobHandoff.detail ? ` (${noJobHandoff.detail})` : ''),
    noJobHandoff,
    labelRemoved,
    ackComment,
  };
}
