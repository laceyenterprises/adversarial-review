// PR-side operator surface for the `retrigger-remediation` label.
//
// Mirrors `npm run retrigger-remediation` (src/retrigger-remediation.mjs)
// but is invoked from the watcher when an operator applies the
// `retrigger-remediation` label to a PR — typically from the GitHub
// iOS / Android app or web UI on a halted PR. After successfully
// requeueing, the watcher removes the label so the next tick doesn't
// re-fire.
//
// Eligibility: the latest follow-up job must be in a halted-terminal
// state (`stopped:max-rounds-reached`, `stopped:round-budget-exhausted`,
// `failed`, or `completed` with `reReview.requested = true`). Active
// jobs leave the label in place; the operator can wait out the
// in-flight round and the next tick will re-evaluate.
//
// SPEC §5.1.3 documents this as the PR-side counterpart to the CLI.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { requestReviewRereview } from './review-state.mjs';
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
  if (job.status === 'stopped') {
    const stopCode = job?.remediationPlan?.stop?.code || null;
    return ['max-rounds-reached', 'round-budget-exhausted'].includes(stopCode);
  }
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

function rereviewOutcomeFromResult(rereviewResult) {
  if (rereviewResult?.outcome) return rereviewResult.outcome;
  if (rereviewResult?.ok) return 'rearmed';
  return 'rearm-failed';
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
  rereviewResult,
}) {
  const marker = buildAckCommentMarker(labelEventKey);
  const rereviewOutcome = rereviewOutcomeFromResult(rereviewResult);
  const rereviewReason = rereviewResult?.reason || rereviewResult?.error || null;
  const safeActor = sanitizeAckCommentText(labelEventActor || 'unknown', 120) || 'unknown';
  const safeRereviewReason = rereviewReason ? sanitizeAckCommentText(rereviewReason, 500) : null;
  const safeReason = reason ? sanitizeAckCommentText(reason, 500) : null;
  const lines = [
    `<!-- ${marker} -->`,
    '### Remediation retrigger accepted',
    '',
    `The \`${RETRIGGER_REMEDIATION_LABEL}\` label was accepted by the adversarial-review watcher.`,
    '',
    `- Requested by: \`${safeActor}\``,
    `- Remediation budget: \`${bumpResult.priorMaxRounds} -> ${bumpResult.newMaxRounds}\` rounds`,
    `- Fresh review queue: \`${rereviewOutcome}\`${safeRereviewReason ? ` (${safeRereviewReason})` : ''}`,
    '',
    'Next: the watcher will post a fresh adversarial review when it reaches this PR. If that review requests changes, the remediation worker will claim the new follow-up job.',
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
  repo,
  prNumber,
  execFileImpl,
  labelEventKey,
  labelEventActor,
  reason,
  bumpResult,
  rereviewResult,
}) {
  const body = buildAckCommentBody({
    labelEventKey,
    labelEventActor,
    reason,
    bumpResult,
    rereviewResult,
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
    const result = await execFileImpl('gh', [
      'pr',
      'comment',
      String(prNumber),
      '--repo',
      repo,
      '--body',
      body,
    ], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: ACK_COMMENT_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
    return { posted: true, stdout: result?.stdout || '', marker };
  } catch (err) {
    return {
      posted: false,
      reason: err?.killed === true ? 'gh-cli-timeout' : 'gh-cli-failure',
      error: err?.message || String(err),
    };
  }
}

function buildPendingAckComment({ labelEventKey, labelEventActor, reason, bumpResult, rereviewResult }) {
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
      rereviewResult: {
        ok: rereviewResult?.ok ?? null,
        outcome: rereviewResult?.outcome || null,
        status: rereviewResult?.status || null,
        reason: rereviewResult?.reason || null,
        error: rereviewResult?.error || null,
      },
    },
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
  if (previousAttempts >= ACK_COMMENT_MAX_ATTEMPTS) return consumption;
  const ackComment = await postRetriggerAckComment({
    repo,
    prNumber,
    execFileImpl,
    labelEventKey,
    labelEventActor: context.labelEventActor,
    reason: context.reason,
    bumpResult: context.bumpResult,
    rereviewResult: context.rereviewResult,
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
  labelEvent = null,
}) {
  const labelEventKey = normalizeLabelEventKey({ repo, prNumber, labelEvent });
  if (!labelEventKey) {
    return {
      outcome: 'label-event-missing',
      detail: 'cannot attribute retrigger-remediation to a GitHub labeled event',
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
  const auditRow = {
    ts,
    verb: VERB,
    repo,
    pr: prNumber,
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

  // Re-arm the watcher row to `review_status='pending'` instead of
  // force-requeueing the follow-up job. Rationale (post-2026-05-06):
  // force-requeueing causes the daemon to spawn a remediation worker
  // IMMEDIATELY in parallel with the rereview the budget bump just
  // unlocked — observed live during PR #48 verification, where round
  // 2's worker pushed commits BEFORE the review #2 verdict was
  // posted. Letting the natural cycle drive (review fires → if
  // request-changes, reviewer creates new follow-up job → daemon
  // claims and spawns) preserves the convergence loop's expected
  // sequencing. The CLI keeps its old "force requeue" semantic for
  // operators who explicitly want to skip the review step.
  let rereviewResult;
  try {
    rereviewResult = requestReviewRereview({
      rootDir,
      repo,
      prNumber,
      requestedAt: ts,
      reason: `pr-label retrigger-remediation: ${reason}`,
    });
  } catch (err) {
    rereviewResult = { ok: false, error: err?.message || String(err) };
  }

  const terminalAuditRow = {
    ...auditRow,
    priorMaxRounds: bumpResult.priorMaxRounds,
    newMaxRounds: bumpResult.newMaxRounds,
    rereviewOutcome: rereviewOutcomeFromResult(rereviewResult),
    outcome: 'bumped-and-rearmed',
  };
  const pendingAckComment = buildPendingAckComment({
    labelEventKey,
    labelEventActor,
    reason,
    bumpResult,
    rereviewResult,
  });
  writeLabelConsumption(rootDir, labelEventKey, {
    schemaVersion: 1,
    label: RETRIGGER_REMEDIATION_LABEL,
    labelEventKey,
    idempotencyKey,
    repo,
    prNumber: Number(prNumber),
    jobPath: bumpResult.jobPath,
    auditStatus: 'pending',
    auditRow: terminalAuditRow,
    ackComment: pendingAckComment,
    consumedAt: ts,
  });

  try {
    appendAuditRow(auditRootDir, terminalAuditRow);
    writeLabelConsumption(rootDir, labelEventKey, {
      schemaVersion: 1,
      label: RETRIGGER_REMEDIATION_LABEL,
      labelEventKey,
      idempotencyKey,
      repo,
      prNumber: Number(prNumber),
      jobPath: bumpResult.jobPath,
      auditStatus: 'written',
      auditRow: terminalAuditRow,
      ackComment: pendingAckComment,
      consumedAt: ts,
      auditedAt: ts,
    });
  } catch (err) {
    return {
      outcome: 'bumped-audit-failed',
      detail: `bumped + re-armed OK but operator mutation audit append failed: ${err?.message || err}`,
      jobPath: bumpResult.jobPath,
      newMaxRounds: bumpResult.newMaxRounds,
    };
  }

  // Remove the label before posting the human-visible ack so a slow
  // GitHub comment path does not leave operators staring at a stale
  // retrigger-remediation label. The pending ack record above keeps the
  // comment recoverable if the daemon dies before or during the post.
  let labelRemoved = false;
  try {
    await removeLabelFromPR({ repo, prNumber, execFileImpl });
    labelRemoved = true;
  } catch (err) {
    return {
      outcome: 'bumped-label-removal-failed',
      detail: `bumped + re-armed OK but label removal failed: ${err?.message || err}`,
      jobPath: bumpResult.jobPath,
      newMaxRounds: bumpResult.newMaxRounds,
    };
  }

  const ackComment = await postRetriggerAckComment({
    repo,
    prNumber,
    execFileImpl,
    labelEventKey,
    labelEventActor,
    reason,
    bumpResult,
    rereviewResult,
  });
  writeLabelConsumption(rootDir, labelEventKey, {
    schemaVersion: 1,
    label: RETRIGGER_REMEDIATION_LABEL,
    labelEventKey,
    idempotencyKey,
    repo,
    prNumber: Number(prNumber),
    jobPath: bumpResult.jobPath,
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
  });

  return {
    outcome: 'bumped-and-rearmed',
    detail: `bumped maxRounds ${bumpResult.priorMaxRounds} → ${bumpResult.newMaxRounds}, re-armed watcher row for fresh review`,
    jobPath: bumpResult.jobPath,
    newMaxRounds: bumpResult.newMaxRounds,
    labelRemoved,
    ackComment,
    rereviewOutcome: rereviewOutcomeFromResult(rereviewResult),
  };
}
