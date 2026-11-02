import { classifyOperatorGatedFindings } from './ama/operator-label-gates.mjs';
import { readFollowUpOperatorLabel, operatorLabelEvidenceSatisfies, requiredFollowUpOperatorLabel } from './follow-up-operator-label.mjs';
import { requestReviewRereview } from './review-state.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import { requeueFollowUpJobForNextRound } from './follow-up-jobs.mjs';
import { clearNoProgressLane } from './watcher-no-progress-lane.mjs';
import { REVIEWER_PASS_NORMALIZED_POSTED_AT_SQL, DELIVERED_REVIEW_SQL } from './reviewer-pass-posted-review-sql.mjs';

// LABELREARM-01: discovery runs before posted-row lane admission. A generic
// watcher wake cannot observe a waiver: arm the existing exact-head intent.
export function observeOperatorLabelReviewWake({ rootDir, db, repo, prNumber, headSha,
  readOperatorLabelImpl = readFollowUpOperatorLabel,
  requestReviewImpl = requestReviewRereview, latestJobFinder = findLatestFollowUpJob,
  requeueImpl = requeueFollowUpJobForNextRound, logger = console,
  now = () => new Date().toISOString(),
}) {
  const row = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber);
  if (row?.pr_state !== 'open' || row.review_status !== 'posted' || row.reviewer_head_sha !== headSha) return null;
  const review = db.prepare(`SELECT pass_id, body_md, ${REVIEWER_PASS_NORMALIZED_POSTED_AT_SQL} AS posted_at
    FROM reviewer_passes WHERE repo = ? AND pr_number = ? AND head_sha = ?
      AND pass_kind IN ('first-pass', 'rereview') AND ${DELIVERED_REVIEW_SQL}
    ORDER BY attempt_number DESC, pass_id DESC LIMIT 1`).get(repo, prNumber, headSha);
  const findings = classifyOperatorGatedFindings(review?.body_md);
  if (!findings.allGated || !review.posted_at) return null;
  const evidence = [];
  for (const label of [...new Set(findings.gated.map(finding => finding.label))].sort()) {
    const observed = readOperatorLabelImpl({ repo, prNumber, label });
    if (!operatorLabelEvidenceSatisfies({ repo, prNumber, label, headSha, after: review.posted_at }, observed)) return null;
    evidence.push(observed);
  }
  // Event identity, not tick/review time, spends the gesture. The existing
  // immediate transaction records this receipt atomically with the row reset.
  const requestId = `operator-waiver-observation:${JSON.stringify([headSha, ...evidence.map(item => [item.label, item.eventId])])}`;
  const result = db.transaction(() => {
    const current = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?').get(repo, prNumber);
    const latest = db.prepare(`SELECT pass_id FROM reviewer_passes WHERE repo = ? AND pr_number = ?
      AND head_sha = ? AND pass_kind IN ('first-pass', 'rereview') AND ${DELIVERED_REVIEW_SQL}
      ORDER BY attempt_number DESC, pass_id DESC LIMIT 1`).get(repo, prNumber, headSha);
    if (current?.pr_state !== 'open' || current.review_status !== 'posted'
      || current.reviewer_head_sha !== headSha || current.posted_at !== row.posted_at
      || latest?.pass_id !== review.pass_id) return { triggered: false, status: 'changed' };
    return requestReviewImpl({ rootDir, db, repo, prNumber, targetRevisionRef: headSha,
      requestedAt: now(), reason: `operator-waiver-observation: ${evidence.map(item => item.label).join(', ')}`,
      preserveBudgets: true, inTransaction: true,
      explicitReviewRequest: { requestId, actor: evidence.map(item => item.actor).join(',') }, logger });
  }).immediate();
  // Valid operator action is progress even when its receipt was already spent.
  // A changed snapshot, however, belongs to its newer review/head owner.
  if (result.status !== 'changed') clearNoProgressLane(rootDir, { repo, prNumber }, { logger });
  if (!result.triggered && result.status !== 'already-pending') return result;
  const latest = latestJobFinder(rootDir, { repo, prNumber });
  const required = requiredFollowUpOperatorLabel(latest?.job);
  if (required && evidence.some(item => item.label === required)) {
    // Re-read in the queue writer: removal/head movement between discovery and
    // rearming must retain the stop. No round-budget override is granted.
    requeueImpl({ rootDir, jobPath: latest.jobPath, revisionRef: headSha,
      requestedAt: now(), requestedBy: 'operator-label', reason: 'Operator waiver observation requested.',
      readOperatorLabelImpl });
  }
  return result;
}
