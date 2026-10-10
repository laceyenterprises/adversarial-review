import { createHash } from 'node:crypto';
import { hamAuditCommentAuthorMatches } from './ham-provenance.mjs';
import { normalizeEffectiveReviewVerdict } from '../kernel/verdict.mjs';
import { parseBlockingFindingsSection } from '../kernel/remediation-reply.mjs';
import { amaAllAuthoritativeReviewerLogins, isCurrentAuthoritativeFamilyReview } from './reviewer-authority.mjs';
import {
  HAMMER_WITHDRAWN_RESOLUTION, blockingFindingIdentity, buildWithdrawalComment, evidenceDigest,
  hasConcreteExactHeadEvidence,
} from './hammer-adjudication.mjs';

// HAMFINAL-01: the hammer's adjudication is final (operator decision 2026-10-10,
// "Hammers judgement is final"). A blocking finding disputed with concrete
// exact-head evidence is RESOLVED as `withdrawn-by-hammer`, recorded here and in
// the PR comment with its evidence digest and exact head. No re-review is
// requested: on agent-os PR 7987 the same-head request was silently dropped by
// the watcher's duplicate guard and the PR stranded on "operator decision
// required". The hammer continues remediating the other findings and merges.
// HAMINTENT-02's identity, liveness, authority and provenance checks still run.
export async function disputeFinding({ rootDir, repo, prNumber, headSha, reviewRef, findingNumber, evidence }, {
  db, get, postComment, wake = null, logger = console,
} = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')
    || !Number.isInteger(prNumber) || prNumber < 1 || !/^[a-f0-9]{40}$/i.test(headSha || '')
    || !Number.isInteger(findingNumber) || findingNumber < 1 || !evidence?.trim()
    || Buffer.byteLength(evidence, 'utf8') > 16000) {
    throw new Error('dispute requires PR identity, exact head, finding and evidence');
  }
  if (!hasConcreteExactHeadEvidence(evidence)) {
    throw new Error('dispute evidence must quote an exact-head repro command and output, or the head file, in a fenced block');
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
  if (!await isCurrentAuthoritativeFamilyReview(review, reviews, headSha,
    (from, to) => get(`repos/${repo}/compare/${from}...${to}`))) {
    throw new Error('dispute requires the latest authoritative review in live head ancestry for its family, without a newer reviewed head');
  }
  const finding = parseBlockingFindingsSection(review.body)?.[findingNumber - 1];
  if (!finding) throw new Error('blocking finding not found');
  const identity = blockingFindingIdentity(finding);
  const params = [repo, prNumber, identity];
  const digest = evidenceDigest(evidence);
  db.prepare('INSERT OR IGNORE INTO ham_finding_disputes(repo, pr_number, identity) VALUES (?, ?, ?)').run(...params);
  const reservation = db.transaction(() => {
    db.prepare(`UPDATE ham_finding_disputes SET requests=MAX(0, requests-1), reserved_at=NULL
      WHERE repo=? AND pr_number=? AND reserved_at IS NOT NULL AND reserved_at < ?`).run(repo, prNumber, new Date(Date.now() - 300000).toISOString());
    const row = db.prepare('SELECT * FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND identity=?').get(...params);
    if (row.reserved_at) throw new Error('dispute reservation already in flight');
    // Idempotent per finding, evidence head and reviewed head: a re-run reuses
    // the recorded adjudication instead of posting a second comment.
    if (row.resolution === HAMMER_WITHDRAWN_RESOLUTION && row.head_sha === headSha
      && row.finding_reviewed_head === review.commit_id && row.comment_id) return { done: row };
    db.prepare('UPDATE ham_finding_disputes SET requests=requests+1, reserved_at=? WHERE repo=? AND pr_number=? AND identity=?').run(new Date().toISOString(), ...params);
    return { row };
  }).immediate();
  const result = (row) => ({ withdrawn: true, resolution: HAMMER_WITHDRAWN_RESOLUTION, identity,
    headSha: row.head_sha, findingReviewedHead: row.finding_reviewed_head,
    evidenceSha256: row.evidence_sha256, commentId: row.comment_id });
  if (reservation.done) return { ...result(reservation.done), alreadyRecorded: true };
  try {
    const commentBody = buildWithdrawalComment({ reviewRef: review.html_url || review.node_id, findingNumber,
      identity, headSha, findingReviewedHead: review.commit_id, evidence });
    const comment = await postComment(commentBody);
    if (!comment?.node_id || !hamAuditCommentAuthorMatches(comment.user?.login)
      || comment.body !== commentBody) throw new Error('dispute comment lacks trusted HAM provenance');
    const live = await get(`repos/${repo}/pulls/${prNumber}`);
    if (live.state !== 'open' || live.head?.sha !== headSha) throw new Error('head moved before the withdrawal was recorded');
    db.prepare(`UPDATE ham_finding_disputes SET head_sha=?, comment_id=?, comment_author=?, comment_sha256=?,
      resolution=?, resolved_at=?, finding_reviewed_head=?, evidence_sha256=?, reserved_at=NULL
      WHERE repo=? AND pr_number=? AND identity=?`).run(headSha, comment.node_id, comment.user.login,
      createHash('sha256').update(commentBody).digest('hex'), HAMMER_WITHDRAWN_RESOLUTION,
      new Date().toISOString(), review.commit_id, digest, ...params);
  } catch (error) {
    // A failed post, untrusted identity or head race records nothing.
    db.prepare(`UPDATE ham_finding_disputes SET requests=MAX(0, requests-1), reserved_at=NULL
      WHERE repo=? AND pr_number=? AND identity=?`).run(...params);
    throw error;
  }
  logger?.info?.(JSON.stringify({ event: 'ama_finding_withdrawn_by_hammer', repo, prNumber, headSha,
    reviewRef, findingNumber, identity, evidenceSha256: digest }));
  // Nudge the watcher so the gate re-projects this head now; never fatal.
  try { await wake?.({ rootDir, repo, prNumber, headSha, reason: 'hammer-finding-withdrawn' }); } catch (error) {
    logger?.warn?.(`[ama] watcher wake after withdrawal failed: ${error?.message || error}`);
  }
  return result(db.prepare('SELECT * FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND identity=?').get(...params));
}
