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
import { join } from 'node:path';

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

function buildAckCommentBody({
  labelEventKey,
  labelEventActor,
  reason,
  bumpResult,
  requeueResult,
}) {
  const marker = buildAckCommentMarker(labelEventKey);
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
}) {
  const body = buildAckCommentBody({
    labelEventKey,
    labelEventActor,
    reason,
    bumpResult,
    requeueResult,
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
<<<<<<< HEAD
=======
<<<<<<< HEAD
    const subjectIdentity = buildCodePrSubjectIdentity({
      repo,
      prNumber,
      revisionRef: revisionRef || 'unknown',
=======
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
    const normalizedRevisionRef = requireRevisionRef(revisionRef, 'postRetriggerAckComment');
    const subjectIdentity = buildCodePrSubjectIdentity({
      repo,
      prNumber,
      revisionRef: normalizedRevisionRef,
<<<<<<< HEAD
=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
    });
    const deliveryRound = Math.max(0, Number(requeueResult?.job?.remediationPlan?.currentRound || 0));
    const adapter = createGitHubPRCommentsAdapter({
      rootDir,
      execFileImpl,
      commentTimeoutMs: ACK_COMMENT_TIMEOUT_MS,
<<<<<<< HEAD
=======
<<<<<<< HEAD
      resolveGhToken: () => ({ tokenEnvName: 'GITHUB_TOKEN' }),
=======
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
      resolveGhToken: () => ({
        tokenEnvName: 'GITHUB_TOKEN',
        fallbackTokenEnvNames: ['GH_TOKEN'],
        allowGhAuthFallback: true,
      }),
<<<<<<< HEAD
=======
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
>>>>>>> 1fc0304a213929e5aba65ec63b39fbf38a0d62aa
    });
    const receipt = await adapter.postOperatorNotice(
      {
        type: 'raised-round-cap',
        subjectRef: {
          domainId: subjectIdentity.domainId,
          subjectExternalId: subjectIdentity.subjectExternalId,
          revisionRef: subjectIdentity.revisionRef,
        },
        revisionRef: subjectIdentity.revisionRef,
        eventExternalId: labelEventKey,
        observedAt: new Date().toISOString(),
        reason,
        roundCap: bumpResult?.newMaxRounds ?? null,
      },
      body,
      {
        domainId: subjectIdentity.domainId,
        subjectExternalId: subjectIdentity.subjectExternalId,
        revisionRef: subjectIdentity.revisionRef,
        round: deliveryRound,
        kind: 'operator-notice',
        noticeRef: labelEventKey,
      }
    );
    return { posted: true, stdout: '', marker, commentId: receipt.deliveryExternalId };
  } catch (err) {
    return {
      posted: false,
      reason: err?.killed === true ? 'gh-cli-timeout' : 'gh-cli-failure',
      error: err?.message || String(err),
    };
  }
}

function buildPendingAckComment({ labelEventKey, labelEventActor, reason, bumpResult, requeueResult, revisionRef = null }) {
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
    },
  };
}

<<<<<<< HEAD
function requireRevisionRef(revisionRef, context) {
  const normalized = String(revisionRef || '').trim();
=======
function normalizeRevisionRef(revisionRef) {
  const normalized = String(revisionRef || '').trim();
  return normalized || null;
}

function requireRevisionRef(revisionRef, context) {
  const normalized = normalizeRevisionRef(revisionRef);
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
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
<<<<<<< HEAD
  const subjectIdentity = buildCodePrSubjectIdentity({ repo, prNumber, revisionRef });
=======
  const subjectIdentity = buildCodePrSubjectIdentity({ repo, prNumber, revisionRef: normalizedRevisionRef });
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
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
<<<<<<< HEAD
    revisionRef,
=======
    revisionRef: normalizedRevisionRef,
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
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
<<<<<<< HEAD
      revisionRef,
=======
      revisionRef: normalizedRevisionRef,
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
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
<<<<<<< HEAD
      revisionRef,
=======
      revisionRef: normalizedRevisionRef,
>>>>>>> 986782eb62007568c81e2e2b6f40d86a55492f85
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
