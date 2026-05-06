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

import { existsSync, readFileSync } from 'node:fs';
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

  return {
    outcome: 'label-already-consumed',
    detail: 'label event was already consumed; retried label removal without bumping budget',
    jobPath: nextConsumption?.jobPath || null,
  };
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
    rereviewOutcome: rereviewResult?.outcome || (rereviewResult?.ok ? 'rearmed' : 'rearm-failed'),
    outcome: 'bumped-and-rearmed',
  };
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

  // Remove the label only AFTER the bump succeeds. If we fail to
  // remove the label, the next tick will see the same GitHub labeled
  // event and the consumption check above will short-circuit it.
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

  return {
    outcome: 'bumped-and-rearmed',
    detail: `bumped maxRounds ${bumpResult.priorMaxRounds} → ${bumpResult.newMaxRounds}, re-armed watcher row for fresh review`,
    jobPath: bumpResult.jobPath,
    newMaxRounds: bumpResult.newMaxRounds,
    labelRemoved,
    rereviewOutcome: rereviewResult?.outcome,
  };
}
