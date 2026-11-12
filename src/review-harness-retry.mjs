import { createHash } from 'node:crypto';
import { isHarnessFault } from './harness-fault.mjs';
import { mutateRepairEpochs, readHammerRetryCapLedger } from './ama/hammer-retry-cap.mjs';
import { closerInconclusiveRetryDelayMs } from './ama/closer-inconclusive-retry.mjs';

// PR-wide, including head changes: a sustained outage must eventually reach
// the ordinary infrastructure cap and its alert.
export const REVIEW_HARNESS_REFUND_CAP = 3;
const MAX_REFUNDED_FAILURE_LENGTH = 4096;

// The failure CAS refunds only the latest failed claim, once. The pass journal
// retains its raw outcome; a PR-wide attempt count is never wiped. Reservations
// precede the CAS, so interruption between stores retries the same refund.
export function refundReviewHarnessFault({ rootDir, db, row, now = Date.now() }) {
  if (!row || !['failed', 'pending', 'pending-upstream'].includes(row.review_status)) return { row, wait: false };
  const applied = row.failure_message?.match(/\[harness-budget-refunded:([a-f0-9]+)\]/)?.[1];
  // A receipt remains authoritative even if truncation removed the fault text.
  if (!applied && !isHarnessFault(row.failure_message)) return { row, wait: false };
  const id = applied || createHash('sha256').update(JSON.stringify([
    row.failed_at, row.failure_message, row.reviewer_session_uuid, row.reviewer_head_sha,
  ])).digest('hex');
  const identity = { repo: row.repo, prNumber: row.pr_number };
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  if (ledger?.__corrupt) throw new Error('review refund ledger unreadable');
  const prior = ledger?.reviewHarnessRefunds || {};
  // Already-applied receipts only pace the retry; no flock or rewrite.
  if (applied) {
    const receipt = prior[applied] || null;
    if (!receipt) console.warn(`[watcher] review harness refund receipt missing for ${row.repo}#${row.pr_number}: ${applied}`);
    return { row, wait: Date.parse(receipt?.nextRetryAt) > now, receipt };
  }
  if (!prior[id] && Object.keys(prior).length >= REVIEW_HARNESS_REFUND_CAP) return { row, wait: false };
  const receipt = prior[id] || mutateRepairEpochs(rootDir, identity, ledger => {
    const refunds = ledger.reviewHarnessRefunds ||= {};
    if (!refunds[id]) {
      if (Object.keys(refunds).length >= REVIEW_HARNESS_REFUND_CAP) return null;
      const count = Object.values(refunds).filter(refund =>
        typeof refund.headSha === 'string' && typeof row.reviewer_head_sha === 'string'
        && refund.headSha.toLowerCase() === row.reviewer_head_sha.toLowerCase()).length + 1;
      refunds[id] = { id, headSha: row.reviewer_head_sha, failure: row.failure_message.slice(0, 512),
        reservedAt: new Date(now).toISOString(),
        nextRetryAt: new Date(now + closerInconclusiveRetryDelayMs(count)).toISOString() };
    }
    return refunds[id];
  });
  if (!receipt) return { row, wait: false };
  if (!applied) {
    // Keep the receipt intact: subsequent observations use it to avoid
    // crediting the same failure twice. The pass journal retains raw evidence.
    const marker = `\n[harness-budget-refunded:${id}]`;
    const message = row.failure_message.slice(0, MAX_REFUNDED_FAILURE_LENGTH - marker.length) + marker;
    db.prepare(`UPDATE reviewed_prs SET review_status='pending-upstream',
      review_attempts=MAX(0, COALESCE(review_attempts,0)-1),
      infra_auto_recover_attempts=MAX(0, COALESCE(infra_auto_recover_attempts,0)-1),
      failure_message=?
      WHERE repo=? AND pr_number=? AND review_status=?
      AND failed_at IS ? AND failure_message IS ? AND reviewer_session_uuid IS ?`)
      .run(message, row.repo, row.pr_number,
        row.review_status, row.failed_at, row.failure_message, row.reviewer_session_uuid);
  }
  return { row: db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?').get(row.repo, row.pr_number),
    wait: Date.parse(receipt.nextRetryAt) > now, receipt };
}
