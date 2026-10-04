import { createHash } from 'node:crypto';
import { hamAuditCommentAuthorMatches } from './ham-provenance.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { parseBlockingFindingsSection } from '../kernel/remediation-reply.mjs';
import { amaAllAuthoritativeReviewerLogins, latestAuthoritativeReviewInAncestry } from './reviewer-authority.mjs';
import { requestReviewRereview } from '../review-state.mjs';
import { shouldEscalateReviewCycle, resolveReviewCycleCapConfig } from '../review-cycle-cap.mjs';

// HAMINTENT-02: a dispute never waives a finding or grants merge authority.
// The existing review CAS still owns terminal/active-review guards.
export async function disputeFinding({ rootDir, repo, prNumber, headSha, reviewRef, findingNumber, evidence }, {
  db, get, postComment, page, logger = console, loadedConfig = null,
  request = requestReviewRereview,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')
    || !Number.isInteger(prNumber) || prNumber < 1 || !/^[a-f0-9]{40}$/i.test(headSha || '')
    || !Number.isInteger(findingNumber) || findingNumber < 1 || !evidence?.trim()
    || Buffer.byteLength(evidence, 'utf8') > 16000) {
    throw new Error('dispute requires PR identity, exact head, finding and evidence');
  }
  const pr = await get(`repos/${repo}/pulls/${prNumber}`);
  if (pr.state !== 'open' || pr.draft || pr.head?.sha !== headSha) throw new Error('dispute head is not live/open');
  const reviews = await get(`repos/${repo}/pulls/${prNumber}/reviews?per_page=100`);
  if (!Array.isArray(reviews) || reviews.length >= 100) throw new Error('missing or capped reviews');
  const review = reviews.find((entry) => [entry.node_id, entry.html_url].filter(Boolean).includes(reviewRef));
  if (!/^[a-f0-9]{40}$/i.test(review?.commit_id || '') || !['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'APPROVED'].includes(review.state)
    || normalizeEffectiveReviewVerdict(review.body) !== 'request-changes'
    || !amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))) {
    throw new Error('dispute requires authoritative blocking review');
  }
  // REST reviews are ordered oldest first. Only the latest submitted,
  // authoritative review in the live head's ancestry can be disputed.
  const latest = await latestAuthoritativeReviewInAncestry(reviews, headSha,
    (from, to) => get(`repos/${repo}/compare/${from}...${to}`));
  if (latest !== review) throw new Error('dispute requires the latest authoritative review in live head ancestry');
  const finding = parseBlockingFindingsSection(review.body)?.[findingNumber - 1];
  if (!finding) throw new Error('blocking finding not found');
  const identity = createHash('sha256').update(JSON.stringify([finding.title, finding.file])).digest('hex');
  const params = [repo, prNumber, identity];
  db.prepare('INSERT OR IGNORE INTO ham_finding_disputes(repo, pr_number, identity) VALUES (?, ?, ?)').run(...params);
  const cap = shouldEscalateReviewCycle(db, { repo, prNumber, headSha,
    ...resolveReviewCycleCapConfig({ loadedConfig }) });
  const reservation = db.transaction(() => {
    db.prepare(`UPDATE ham_finding_disputes SET requests=MAX(0, requests-1), reserved_at=NULL
      WHERE repo=? AND pr_number=? AND reserved_at IS NOT NULL AND reserved_at < ?`).run(repo, prNumber, new Date(Date.now() - 300000).toISOString());
    const row = db.prepare('SELECT * FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND identity=?').get(...params);
    const total = db.prepare('SELECT COALESCE(SUM(requests), 0) AS count FROM ham_finding_disputes WHERE repo=? AND pr_number=?').get(repo, prNumber).count;
    if (row.reserved_at) throw new Error('dispute reservation already in flight');
    if (cap.escalate || total >= cap.cap || row.requests >= 2 || row.refusals >= 2) return false;
    db.prepare('UPDATE ham_finding_disputes SET requests=requests+1, reserved_at=? WHERE repo=? AND pr_number=? AND identity=?').run(new Date().toISOString(), ...params);
    return row;
  }).immediate();
  const exhaust = async (reason) => {
    const changed = db.prepare('UPDATE ham_finding_disputes SET paged=1 WHERE repo=? AND pr_number=? AND identity=? AND paged=0 AND NOT EXISTS (SELECT 1 FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND paged>0)').run(...params, repo, prNumber);
    const pendingPage = db.prepare('SELECT identity FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND paged=1').get(repo, prNumber);
    if (changed.changes || pendingPage) {
      const pageParams = [repo, prNumber, pendingPage?.identity || identity];
      const payload = { severity: 'SEV1', repo, prNumber, headSha, reviewRef, findingNumber, reason };
      logger.error?.(JSON.stringify({ event: 'ama_finding_dispute_exhausted', ...payload }));
      try {
        await page(`SEV1: finding dispute exhausted for ${repo}#${prNumber}: ${reason}`, {
          event: 'ama_finding_dispute_exhausted', payload,
        });
        db.prepare('UPDATE ham_finding_disputes SET paged=2 WHERE repo=? AND pr_number=? AND identity=?').run(...pageParams);
      } catch (error) {
        // Keep the PR-wide CAS during enqueue, but refund it if no page queued.
        db.prepare('UPDATE ham_finding_disputes SET paged=0 WHERE repo=? AND pr_number=? AND identity=?').run(...pageParams);
        throw error;
      }
    }
    return { triggered: false, exhausted: true, reason };
  };
  if (!reservation) return exhaust('re-review-cap-or-repeated-refusal');
  const restoreProvenance = () => db.prepare(`UPDATE ham_finding_disputes
    SET head_sha=?, comment_id=?, comment_author=?, comment_sha256=?
    WHERE repo=? AND pr_number=? AND identity=? AND comment_id=?`).run(
    reservation.head_sha, reservation.comment_id, reservation.comment_author,
    reservation.comment_sha256, ...params, commentId);
  let commentId = null;
  let result;
  try {
    const commentBody = `HAM finding dispute — ${review.html_url || review.node_id} finding=${findingNumber}\n`
      + `Reviewed-Head: ${headSha}\nFinding-Reviewed-Head: ${review.commit_id}\n\n${evidence.trim()}\n\n`
      + 'Reviewer: evaluate this evidence on the exact head and explicitly confirm or withdraw the blocking finding. '
      + 'Merge remains blocked pending adjudication.';
    const comment = await postComment(commentBody);
    if (!comment?.node_id || !hamAuditCommentAuthorMatches(comment.user?.login)
      || comment.body !== commentBody) throw new Error('dispute comment lacks trusted HAM provenance');
    commentId = comment.node_id;
    const live = await get(`repos/${repo}/pulls/${prNumber}`);
    if (live.state !== 'open' || live.head?.sha !== headSha) throw new Error('head moved before dispute re-review');
    db.prepare(`UPDATE ham_finding_disputes SET head_sha=?, comment_id=?, comment_author=?, comment_sha256=?
      WHERE repo=? AND pr_number=? AND identity=?`).run(headSha, commentId, comment.user.login,
      createHash('sha256').update(commentBody).digest('hex'), ...params);
    result = request({ rootDir, repo, prNumber, targetRevisionRef: headSha, db, logger,
      reason: `HAM finding dispute: ${reviewRef} finding=${findingNumber}; confirm or withdraw using PR evidence` });
  } catch (error) {
    // A failed post or head race is not a delivered re-review request.
    restoreProvenance();
    db.prepare(`UPDATE ham_finding_disputes SET requests=MAX(0, requests-1), reserved_at=NULL
      WHERE repo=? AND pr_number=? AND identity=?`).run(...params);
    throw error;
  }
  db.prepare('UPDATE ham_finding_disputes SET reserved_at=NULL WHERE repo=? AND pr_number=? AND identity=?').run(...params);
  if (!result.triggered && !['pending', 'already-pending'].includes(result.status) && result.reason !== 'review-in-flight') restoreProvenance();
  if (!result.triggered && !['pending', 'already-pending'].includes(result.status) && result.reason !== 'review-in-flight') {
    db.prepare('UPDATE ham_finding_disputes SET refusals=refusals+1 WHERE repo=? AND pr_number=? AND identity=?').run(...params);
    const row = db.prepare('SELECT refusals FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND identity=?').get(...params);
    if (row.refusals >= 2) return exhaust(result.reason);
  }
  return result;
}
