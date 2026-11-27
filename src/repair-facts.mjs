import { readHammerRetryCapLedger } from './ama/hammer-retry-cap.mjs';
import { repairEpochDeadline, repairCause, repairOperatorHoldReason, REPAIR_EPOCH_CAP } from './repair-epochs.mjs';
import { resolveFirstPassReviewBudgetSuppression } from './first-pass-review-suppression.mjs';
import {
  BUDGET_EXHAUSTED_CLOSURE_REASON, isBudgetExhaustedReviewSuppression, resolveMaxRemediationRounds,
} from './hamclose-review-admission.mjs';
import { resolveRoundBudgetForJob, summarizePRRemediationLedger } from './follow-up-jobs.mjs';
import { countCompletedReviewerRereviewRounds, wasBudgetExhaustedByUnpublishedCloserRounds } from './review-ceiling-metrics.mjs';

export function automaticRemediationBudgetExhausted(rootDir, identity) {
  const ledger = summarizePRRemediationLedger(rootDir, identity);
  const { roundBudget } = resolveRoundBudgetForJob({ riskClass: ledger.latestRiskClass }, { rootDir });
  const maxRounds = resolveMaxRemediationRounds({ roundBudget, latestMaxRounds: ledger.latestMaxRounds });
  return Number.isInteger(maxRounds) && maxRounds >= 0 && ledger.completedRoundsForPR >= maxRounds;
}

export function readRepairFacts({ rootDir, db, repo, prNumber, headSha, row, conflicting = false }) {
  const ledger = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  const suppression = resolveFirstPassReviewBudgetSuppression({ rootDir, db, repoPath: repo,
    prNumber, domainId: 'code-pr', currentHeadSha: headSha, reviewRow: row });
  const cycleExhausted = isBudgetExhaustedReviewSuppression(suppression);
  // Recheck only the automatic handoff, whose stored reason may predate the
  // closer-round correction. An operator or repair epoch still owns its hold.
  let repairRow = row;
  if (!cycleExhausted && Number.isInteger(suppression?.roundBudget)
    && row?.rereview_reason === BUDGET_EXHAUSTED_CLOSURE_REASON) {
    const { completedRoundsForPR, unpublishedCloserTerminals } = summarizePRRemediationLedger(rootDir, { repo, prNumber });
    if (unpublishedCloserTerminals > 0 && wasBudgetExhaustedByUnpublishedCloserRounds({
      effectiveRoundBudget: suppression.roundBudget,
      completedRemediationRounds: completedRoundsForPR,
      completedRereviewRounds: countCompletedReviewerRereviewRounds({ db, rootDir, repoPath: repo, prNumber }),
      unpublishedCloserTerminals,
    })) {
      repairRow = { ...row, rereview_reason: null };
    }
  }
  const epochs = ledger?.repairEpochs || [];
  const pending = epochs.findLast(epoch => !epoch.reviewHead && !epoch.terminalAt);
  return { cause: repairCause({ ledger, row: repairRow, cycleExhausted, conflicting }),
    epochCap: REPAIR_EPOCH_CAP, epochs, operatorHold: repairOperatorHoldReason(pending), refundedSpend: {
      closer: Object.values(ledger?.selfErrorRefunds || {})
        .reduce((sum, launches) => sum + (Array.isArray(launches) ? launches.length : 0), 0),
      review: Object.values(ledger?.reviewHarnessRefunds || {}).filter(receipt =>
        receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)
        && typeof receipt.id === 'string' && receipt.id.length > 0
        && typeof receipt.headSha === 'string' && receipt.headSha.length > 0).length,
    } };
}

export function readRepairClosureDeadline(rootDir, identity, row, epoch) {
  const { completedRoundTimestamps } = summarizePRRemediationLedger(rootDir, identity);
  return repairEpochDeadline(epoch, Date.parse(row?.posted_at),
    ...(completedRoundTimestamps || []).map(entry => Date.parse(entry.terminalAt)));
}
