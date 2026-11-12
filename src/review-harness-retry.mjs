import { createHash } from 'node:crypto';
import { isHarnessFault } from './harness-fault.mjs';
import { mutateRepairEpochs } from './ama/hammer-retry-cap.mjs';
import { closerInconclusiveRetryDelayMs } from './ama/closer-inconclusive-retry.mjs';

// The failure CAS refunds only the latest failed claim, once. The pass journal
// retains its raw outcome; a PR-wide attempt count is never wiped. Reservations
// precede the CAS, so interruption between stores retries the same refund.
export function refundReviewHarnessFault({ rootDir, db, row, now = Date.now() }) {
  if (!row || !['failed', 'pending', 'pending-upstream'].includes(row.review_status)
    || !isHarnessFault(row.failure_message)) return { row, wait: false };
  const applied = row.failure_message.match(/\[harness-budget-refunded:([a-f0-9]+)\]/)?.[1];
  const id = applied || createHash('sha256').update(JSON.stringify([
    row.failed_at, row.failure_message, row.reviewer_session_uuid, row.reviewer_head_sha,
  ])).digest('hex');
  const receipt = mutateRepairEpochs(rootDir, { repo: row.repo, prNumber: row.pr_number }, ledger => {
    const refunds = ledger.reviewHarnessRefunds ||= {};
    if (!refunds[id]) {
      const count = Object.values(refunds).filter(refund => refund.headSha === row.reviewer_head_sha).length + 1;
      refunds[id] = { id, headSha: row.reviewer_head_sha, failure: row.failure_message,
        reservedAt: new Date(now).toISOString(),
        nextRetryAt: new Date(now + closerInconclusiveRetryDelayMs(count)).toISOString() };
    }
    return refunds[id];
  });
  if (!applied) {
    db.prepare(`UPDATE reviewed_prs SET review_status='pending-upstream',
      review_attempts=MAX(0, review_attempts-1),
      infra_auto_recover_attempts=MAX(0, COALESCE(infra_auto_recover_attempts,0)-1),
      failure_message=?
      WHERE repo=? AND pr_number=? AND review_status=?
      AND failed_at IS ? AND failure_message IS ? AND reviewer_session_uuid IS ?`)
      .run(`${row.failure_message}\n[harness-budget-refunded:${id}]`, row.repo, row.pr_number,
        row.review_status, row.failed_at, row.failure_message, row.reviewer_session_uuid);
  }
  return { row: db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?').get(row.repo, row.pr_number),
    wait: Date.parse(receipt.nextRetryAt) > now, receipt };
}
