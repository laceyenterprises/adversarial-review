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

import { requeueFollowUpJobForNextRound } from './follow-up-jobs.mjs';
import {
  bumpRemediationBudget,
  findLatestFollowUpJob,
} from './operator-retrigger-helpers.mjs';
import {
  appendOperatorMutationAuditRow,
  resolveIdempotencyKey,
} from './operator-mutation-audit.mjs';

const VERB = 'hq.adversarial.retrigger-remediation';

export const RETRIGGER_REMEDIATION_LABEL = 'retrigger-remediation';

const DEFAULT_REASON = 'Operator applied retrigger-remediation label.';
const DEFAULT_BUMP_BUDGET = 1;

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
  // Best-effort removal. If gh fails (network, permissions), the
  // label stays — the next watcher tick re-fires the
  // bumpRemediationBudget call, which is idempotency-keyed so a
  // duplicate trigger is a safe no-op.
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
}) {
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
  // resolveIdempotencyKey takes the canonical request shape and
  // returns a deterministic fingerprint + key. Using the latest
  // jobId in the reason makes each halted-state generation produce
  // a distinct fingerprint, so a second label tap on the SAME
  // halted state is a no-op while a fresh halt (after a follow-up
  // remediation) gets a new key and re-triggers cleanly.
  const fingerprintReason = `${reason}|jobId=${latest.job.jobId}`;
  const { requestFingerprint, idempotencyKey } = resolveIdempotencyKey({
    verb: VERB,
    repo,
    pr: prNumber,
    reason: fingerprintReason,
  });
  const ts = now();
  const auditRow = {
    ts,
    verb: VERB,
    repo,
    pr: prNumber,
    reason,
    operator: `pr-label:${labelActor}`,
    jobKey,
    idempotencyKey,
    source: 'pr-label',
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
      operator: `pr-label:${labelActor}`,
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

  const requeueResult = requeueFollowUpJobForNextRound({
    rootDir,
    jobPath: bumpResult.jobPath,
    requeuedAt: ts,
    reason,
  });

  try {
    appendAuditRow(auditRootDir, {
      ...auditRow,
      priorMaxRounds: bumpResult.priorMaxRounds,
      newMaxRounds: bumpResult.newMaxRounds,
      outcome: 'requeued',
    });
  } catch {
    // Audit failure is non-blocking; the bump+requeue already
    // landed, the operator-mutation ledger may need manual repair.
  }

  // Remove the label only AFTER the bump+requeue succeeds. If we
  // fail to remove the label, the next tick will see the label
  // again, hit the bumpRemediationBudget idempotency check, and
  // safely no-op.
  let labelRemoved = false;
  try {
    await removeLabelFromPR({ repo, prNumber, execFileImpl });
    labelRemoved = true;
  } catch (err) {
    return {
      outcome: 'requeued-label-removal-failed',
      detail: `requeued OK but label removal failed: ${err?.message || err}`,
      jobPath: bumpResult.jobPath,
      newMaxRounds: bumpResult.newMaxRounds,
    };
  }

  return {
    outcome: 'requeued',
    detail: `bumped maxRounds ${bumpResult.priorMaxRounds} → ${bumpResult.newMaxRounds}, requeued for next round`,
    jobPath: bumpResult.jobPath,
    newMaxRounds: bumpResult.newMaxRounds,
    labelRemoved,
    requeueOutcome: requeueResult?.outcome || 'requeued',
  };
}
