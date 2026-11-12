import { readHammerRetryCapLedger } from './ama/hammer-retry-cap.mjs';
import { repairCause, REPAIR_EPOCH_CAP } from './repair-epochs.mjs';
import { resolveFirstPassReviewBudgetSuppression } from './first-pass-review-suppression.mjs';
import { isBudgetExhaustedReviewSuppression } from './hamclose-review-admission.mjs';

export function readRepairFacts({ rootDir, db, repo, prNumber, headSha, row, conflicting = false }) {
  const ledger = readHammerRetryCapLedger(rootDir, { repo, prNumber });
  const suppression = resolveFirstPassReviewBudgetSuppression({ rootDir, db, repoPath: repo,
    prNumber, domainId: 'code-pr', currentHeadSha: headSha, reviewRow: row });
  return { cause: repairCause({ ledger, row, cycleExhausted: isBudgetExhaustedReviewSuppression(suppression), conflicting }),
    epochCap: REPAIR_EPOCH_CAP, epochs: ledger?.repairEpochs || [], refundedSpend: {
      closer: Object.values(ledger?.selfErrorRefunds || {}).reduce((sum, launches) => sum + launches.length, 0),
      review: Object.keys(ledger?.reviewHarnessRefunds || {}).length,
    } };
}
