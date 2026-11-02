import { classifyOperatorGatedFindings } from './ama/operator-label-gates.mjs';
import { operatorLabelEvidenceSatisfies } from './follow-up-operator-label.mjs';
import { requestReviewRereview } from './review-state.mjs';
import { clearNoProgressLane } from './watcher-no-progress-lane.mjs';
import { REVIEWER_PASS_NORMALIZED_POSTED_AT_SQL, DELIVERED_REVIEW_SQL } from './reviewer-pass-posted-review-sql.mjs';

// LABELREARM-01: discovery runs before posted-row lane admission. A generic
// watcher wake cannot observe a waiver: arm the existing exact-head intent.
export async function observeOperatorLabelReviewWake({ rootDir, db, repo, prNumber, headSha,
  labelNames = [], subjectRef, observeLabelControlImpl,
  requestReviewImpl = requestReviewRereview, logger = console,
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
  const labels = [...new Set(findings.gated.map(finding => finding.label))].sort();
  // Cached absence retains the hold without I/O. Presence still needs the
  // shared async operator observation, cached with sibling consumers this tick.
  if (!labels.every(label => labelNames.includes(label)) || typeof observeLabelControlImpl !== 'function') return null;
  const evidence = [];
  for (const label of labels) {
    const control = await observeLabelControlImpl(subjectRef, headSha, label);
    if (!control?.applied) return null;
    const observed = { repo, prNumber, label, headSha: control.observedRevisionRef,
      actor: control.actor, eventId: control.eventId, appliedAt: control.observedAt, observedAt: now() };
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
  // Spent/refused gestures must retain backoff and alert debouncing. Leave
  // stopped jobs untouched: only the fresh review can replace their old body.
  if (result.triggered === true) clearNoProgressLane(rootDir, { repo, prNumber }, { logger });
  return result;
}
