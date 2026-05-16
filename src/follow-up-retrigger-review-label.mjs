// PR-side surface for the `retrigger-review` label.
//
// Lets ANY actor with PR-label permission (operator, merge-agent, codex
// worker, claude-code worker) request a one-shot fresh adversarial
// review on the current PR HEAD by applying the `retrigger-review`
// label. The watcher detects the label here, resets the review row to
// 'pending' (so the next watcher tick claims and re-reviews), removes
// the label, and posts an acknowledgement comment.
//
// Crucially: this label is REVIEW-ONLY. It does NOT bump the
// remediation budget or requeue a remediation follow-up worker. It is
// the "I'm done, look again" signal — for example, after a coding
// agent pushes a fix it believes addresses the prior review. If the
// fresh review verdict is `Comment only`, the existing merge-agent
// dispatch path picks up from there. If it's `Request changes`, the
// existing follow-up-job remediation flow takes over normally.
//
// This refactor (2026-05-16) replaces the previous semantic where
// `retrigger-review` was a write-only marker added by the merge-agent
// with no consumer. Now it's a real signal that any actor can use.
//
// Companion docs:
//   - SPEC §5.1 (PR-side operator surfaces)
//   - follow-up-retrigger-label.mjs (the remediation label, parallel structure)
//   - retrigger-review.mjs (the CLI; this handler wraps the same
//     requestReviewRereview mutation)

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { requestReviewRereview } from './review-state.mjs';
import {
  appendOperatorMutationAuditRow,
  digestSha256,
  findOperatorMutationAuditRow,
  isCommittedOperatorMutationOutcome,
  resolveIdempotencyKey,
} from './operator-mutation-audit.mjs';
import { buildCodePrSubjectIdentity } from './identity-shapes.mjs';
import { createGitHubPRCommentsAdapter } from './adapters/comms/github-pr-comments/index.mjs';

const VERB = 'hq.adversarial.retrigger-review';

export const RETRIGGER_REVIEW_LABEL = 'retrigger-review';

const DEFAULT_REASON = 'retrigger-review label applied; re-review requested on current HEAD.';
const ACK_COMMENT_TIMEOUT_MS = 10_000;
const ACK_COMMENT_LOOKUP_TIMEOUT_MS = 15_000;
const ACK_COMMENT_RETRY_BUDGET_PER_TICK = 5;
const ACK_COMMENT_MAX_ATTEMPTS = 5;
const ACK_COMMENT_MARKER_PREFIX = 'adversarial-review-retrigger-review-ack';

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
    `${safePathSegment(RETRIGGER_REVIEW_LABEL)}-${digest}.json`
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
    return `github-label:${repo}#${prNumber}:${RETRIGGER_REVIEW_LABEL}:${createdAt}`;
  }
  return null;
}

function normalizeRevisionRef(revisionRef) {
  const normalized = String(revisionRef || '').trim();
  return normalized || null;
}

async function removeLabelFromPR({ repo, prNumber, execFileImpl }) {
  await execFileImpl(
    'gh',
    [
      'pr',
      'edit',
      String(prNumber),
      '--repo',
      repo,
      '--remove-label',
      RETRIGGER_REVIEW_LABEL,
    ],
    { maxBuffer: 5 * 1024 * 1024 }
  );
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
  rereviewResult,
}) {
  const marker = buildAckCommentMarker(labelEventKey);
  const safeActor = sanitizeAckCommentText(labelEventActor || 'unknown', 120) || 'unknown';
  const safeReason = reason ? sanitizeAckCommentText(reason, 500) : null;
  const triggered = rereviewResult?.triggered === true;
  const rerunReason = rereviewResult?.reason || (triggered ? 'review-status-reset' : 'unknown');
  const lines = [
    `<!-- ${marker} -->`,
    triggered ? '### Re-review queued' : '### Re-review label noted (already in review pipeline)',
    '',
    triggered
      ? `The \`${RETRIGGER_REVIEW_LABEL}\` label was accepted by the adversarial-review watcher. The next watcher tick will run a fresh review on the current HEAD.`
      : `The \`${RETRIGGER_REVIEW_LABEL}\` label was consumed, but the review row was not reset because: \`${sanitizeAckCommentText(rerunReason, 200)}\`. No fresh review will fire from this label event; the existing review pipeline state already covers this PR.`,
    '',
    `- Requested by: \`${safeActor}\``,
    `- Mutation: \`${rerunReason}\``,
    triggered
      ? '- This is a one-shot signal — the label has been removed. Apply it again to request another re-review.'
      : '- The label has been removed. If you need to force a re-review, wait for the current pipeline state to clear, then re-apply.',
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
    const { stdout } = await execFileImpl(
      'gh',
      [
        'api',
        '--paginate',
        `repos/${repo}/issues/${encodeURIComponent(prNumber)}/comments`,
        '-q',
        '.[] | {id: .id, body: .body}',
      ],
      {
        maxBuffer: 25 * 1024 * 1024,
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
      }
    );
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

async function postRetriggerReviewAckComment({
  rootDir,
  repo,
  prNumber,
  execFileImpl,
  labelEventKey,
  labelEventActor,
  reason,
  rereviewResult,
  revisionRef,
}) {
  const normalizedRevisionRef = normalizeRevisionRef(revisionRef);
  if (!normalizedRevisionRef) {
    return {
      posted: false,
      reason: 'missing-revision-ref',
      error: 'cannot post retrigger-review acknowledgement without a revisionRef',
    };
  }
  const body = buildAckCommentBody({
    labelEventKey,
    labelEventActor,
    reason,
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
    const subjectIdentity = buildCodePrSubjectIdentity({
      repo,
      prNumber,
      revisionRef: normalizedRevisionRef,
    });
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
    const receipt = await adapter.postOperatorNotice(
      {
        type: 'review-retriggered',
        subjectRef: {
          domainId: subjectIdentity.domainId,
          subjectExternalId: subjectIdentity.subjectExternalId,
          revisionRef: subjectIdentity.revisionRef,
        },
        revisionRef: subjectIdentity.revisionRef,
        eventExternalId: labelEventKey,
        observedAt: new Date().toISOString(),
        reason,
      },
      body,
      {
        domainId: subjectIdentity.domainId,
        subjectExternalId: subjectIdentity.subjectExternalId,
        revisionRef: subjectIdentity.revisionRef,
        round: 0,
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

function buildLabelConsumptionDoc({
  labelEventKey,
  idempotencyKey,
  repo,
  prNumber,
  auditStatus,
  auditRow,
  ackComment,
  consumedAt,
  auditedAt = null,
  labelRemoved = false,
  rereviewResult = null,
}) {
  return {
    schemaVersion: 1,
    label: RETRIGGER_REVIEW_LABEL,
    labelEventKey,
    idempotencyKey,
    repo,
    prNumber: Number(prNumber),
    auditStatus,
    auditRow,
    ackComment,
    labelRemoved,
    rereviewResult: rereviewResult
      ? {
          triggered: rereviewResult.triggered === true,
          status: rereviewResult.status || null,
          reason: rereviewResult.reason || null,
        }
      : null,
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
        error: 'cannot retry retrigger-review ack without a revisionRef',
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
  const ackComment = await postRetriggerReviewAckComment({
    rootDir,
    repo,
    prNumber,
    execFileImpl,
    labelEventKey,
    labelEventActor: context.labelEventActor,
    reason: context.reason,
    rereviewResult: context.rereviewResult,
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

async function retryConsumedLabelResiduals({
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
    detail: 'label event was already consumed; retried residuals (audit/label/ack)',
    ackComment: nextConsumption?.ackComment || null,
  };
}

/**
 * Periodically retry ack comments for prior label consumptions that
 * landed the review mutation + audit but failed to post the PR comment.
 * The watcher calls this once per tick (bounded by
 * ACK_COMMENT_RETRY_BUDGET_PER_TICK).
 */
export async function retryPendingRetriggerReviewAckComments({
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
      consumption?.label !== RETRIGGER_REVIEW_LABEL ||
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

/**
 * Consume the retrigger-review label on a PR: reset the review row to
 * 'pending' (so the next watcher tick claims and re-reviews), record
 * an operator-mutation audit row, remove the label, and post an
 * acknowledgement comment.
 *
 * Idempotency: label-consumption file under
 * data/follow-up-jobs/label-consumptions/ keyed by the GitHub label
 * event id (or label timestamp fallback). If a consumption record
 * exists for the same event, we retry the residual steps (audit write,
 * label removal, ack post) but do NOT re-run the review reset.
 */
export async function tryRetriggerReviewFromLabel({
  rootDir,
  repo,
  prNumber,
  labelActor = 'unknown',
  reason = DEFAULT_REASON,
  auditRootDir = rootDir,
  execFileImpl,
  now = () => new Date().toISOString(),
  appendAuditRow = appendOperatorMutationAuditRow,
  findAuditRow = findOperatorMutationAuditRow,
  rereviewImpl = requestReviewRereview,
  labelEvent = null,
  revisionRef = null,
}) {
  const labelEventKey = normalizeLabelEventKey({ repo, prNumber, labelEvent });
  if (!labelEventKey) {
    return {
      outcome: 'label-event-missing',
      detail: 'cannot attribute retrigger-review to a GitHub labeled event',
    };
  }
  const normalizedRevisionRef = normalizeRevisionRef(
    revisionRef || labelEvent?.headSha || labelEvent?.head_sha
  );
  if (!normalizedRevisionRef) {
    return {
      outcome: 'missing-revision-ref',
      detail:
        'retrigger-review label requires the current PR head revisionRef before it can reset the review row',
      ackComment: { posted: false, reason: 'missing-revision-ref' },
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
    return retryConsumedLabelResiduals({
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
    return retryConsumedLabelResiduals({
      repo,
      prNumber,
      execFileImpl,
      consumption: {
        auditStatus: 'written',
        auditRow: existingAuditRow,
      },
      auditRootDir,
      appendAuditRow,
      rootDir,
      labelEventKey,
    });
  }

  // The actual mutation: ask review-state.mjs to reset the review row
  // for this PR. Idempotent via its CAS — if the row is already
  // 'pending' or otherwise not resettable, we still proceed to write
  // audit / remove label / post ack, but the ack body explains the
  // no-op.
  let rereviewResult;
  try {
    rereviewResult = rereviewImpl({
      rootDir,
      repo,
      prNumber,
      requestedAt: now(),
      reason,
    });
  } catch (err) {
    return {
      outcome: 'rereview-call-failed',
      detail: `requestReviewRereview threw: ${err?.message || err}`,
    };
  }

  const consumedAt = now();
  const auditRow = {
    ts: consumedAt,
    verb: VERB,
    repo,
    pr: String(prNumber),
    reason,
    operator: labelEventActor,
    requestFingerprint,
    idempotencyKey,
    outcome: rereviewResult?.triggered ? 'triggered' : `noop:${rereviewResult?.reason || 'unknown'}`,
    rereviewStatus: rereviewResult?.status || null,
    rereviewReason: rereviewResult?.reason || null,
    labelEventKey,
    revisionRef: normalizedRevisionRef,
  };

  // Write the consumption record FIRST (auditStatus=pending) so a crash
  // between this point and the audit append leaves enough state for
  // the next tick to retry residuals without re-running the mutation.
  let consumption = buildLabelConsumptionDoc({
    labelEventKey,
    idempotencyKey,
    repo,
    prNumber,
    auditStatus: 'pending',
    auditRow,
    ackComment: { posted: false, reason: 'not-attempted' },
    consumedAt,
    rereviewResult,
  });
  writeLabelConsumption(rootDir, labelEventKey, consumption);

  try {
    appendAuditRow(auditRootDir, auditRow);
    consumption = {
      ...consumption,
      auditStatus: 'written',
      auditedAt: now(),
    };
    writeLabelConsumption(rootDir, labelEventKey, consumption);
  } catch (err) {
    return {
      outcome: 'audit-append-failed',
      detail: `operator mutation audit append failed: ${err?.message || err}`,
      rereviewResult,
    };
  }

  try {
    await removeLabelFromPR({ repo, prNumber, execFileImpl });
    consumption = { ...consumption, labelRemoved: true };
    writeLabelConsumption(rootDir, labelEventKey, consumption);
  } catch (err) {
    // Label removal failure is recoverable on the next tick via
    // retryConsumedLabelResiduals. Continue to the ack post so the PR
    // still gets a visible signal.
    consumption = {
      ...consumption,
      labelRemoved: false,
      labelRemoveError: err?.message || String(err),
    };
    writeLabelConsumption(rootDir, labelEventKey, consumption);
  }

  const ackComment = await postRetriggerReviewAckComment({
    rootDir,
    repo,
    prNumber,
    execFileImpl,
    labelEventKey,
    labelEventActor,
    reason,
    rereviewResult,
    revisionRef: normalizedRevisionRef,
  });
  consumption = {
    ...consumption,
    ackComment: {
      ...ackComment,
      context: {
        labelEventActor,
        reason,
        rereviewResult: {
          triggered: rereviewResult?.triggered === true,
          status: rereviewResult?.status || null,
          reason: rereviewResult?.reason || null,
        },
        revisionRef: normalizedRevisionRef,
      },
      attempts: 1,
      maxAttempts: ACK_COMMENT_MAX_ATTEMPTS,
      attemptedAt: now(),
    },
  };
  writeLabelConsumption(rootDir, labelEventKey, consumption);

  return {
    outcome: rereviewResult?.triggered
      ? 'review-retriggered'
      : `noop:${rereviewResult?.reason || 'unknown'}`,
    detail: rereviewResult?.triggered
      ? 'review row reset to pending; next watcher tick will re-review'
      : `review row not reset: ${rereviewResult?.reason || 'unknown'}`,
    rereviewResult,
    ackComment: consumption.ackComment,
    labelRemoved: consumption.labelRemoved,
  };
}
