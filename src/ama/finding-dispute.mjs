import { createHash } from 'node:crypto';
import { parseBlockingFindingsSection } from '../kernel/remediation-reply.mjs';
import { amaAllAuthoritativeReviewerLogins } from './reviewer-authority.mjs';
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
  if (!/^[a-f0-9]{40}$/i.test(review?.commit_id || '') || review.state !== 'CHANGES_REQUESTED'
    || !amaAllAuthoritativeReviewerLogins().includes(String(review.user?.login || '').replace(/\[bot\]$/, ''))) {
    throw new Error('dispute requires authoritative blocking review');
  }
  if (review.commit_id !== headSha) {
    const ancestry = await get(`repos/${repo}/compare/${review.commit_id}...${headSha}`);
    if (!['ahead', 'identical'].includes(ancestry.status)) throw new Error('disputed review is outside live head ancestry');
  }
  const finding = parseBlockingFindingsSection(review.body)?.[findingNumber - 1];
  if (!finding) throw new Error('blocking finding not found');
  db.exec(`CREATE TABLE IF NOT EXISTS ham_finding_disputes (
    repo TEXT NOT NULL, pr_number INTEGER NOT NULL, identity TEXT NOT NULL,
    requests INTEGER NOT NULL DEFAULT 0, refusals INTEGER NOT NULL DEFAULT 0,
    paged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repo, pr_number, identity))`);
  const identity = createHash('sha256').update(JSON.stringify([finding.title, finding.file])).digest('hex');
  const params = [repo, prNumber, identity];
  db.prepare('INSERT OR IGNORE INTO ham_finding_disputes(repo, pr_number, identity) VALUES (?, ?, ?)').run(...params);
  const cap = shouldEscalateReviewCycle(db, { repo, prNumber, headSha,
    ...resolveReviewCycleCapConfig({ loadedConfig }) });
  const reservation = db.transaction(() => {
    const row = db.prepare('SELECT * FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND identity=?').get(...params);
    const total = db.prepare('SELECT COALESCE(SUM(requests), 0) AS count FROM ham_finding_disputes WHERE repo=? AND pr_number=?').get(repo, prNumber).count;
    if (cap.count >= cap.cap || total >= cap.cap || row.requests >= 2 || row.refusals >= 2) return false;
    db.prepare('UPDATE ham_finding_disputes SET requests=requests+1 WHERE repo=? AND pr_number=? AND identity=?').run(...params);
    return true;
  }).immediate();
  const exhaust = async (reason) => {
    const changed = db.prepare('UPDATE ham_finding_disputes SET paged=1 WHERE repo=? AND pr_number=? AND identity=? AND paged=0 AND NOT EXISTS (SELECT 1 FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND paged=1)').run(...params, repo, prNumber);
    if (changed.changes) {
      const payload = { severity: 'SEV1', repo, prNumber, headSha, reviewRef, findingNumber, reason };
      logger.error?.(JSON.stringify({ event: 'ama_finding_dispute_exhausted', ...payload }));
      await page(`SEV1: finding dispute exhausted for ${repo}#${prNumber}: ${reason}`, {
        event: 'ama_finding_dispute_exhausted', payload,
      });
    }
    return { triggered: false, exhausted: true, reason };
  };
  if (!reservation) return exhaust('re-review-cap-or-repeated-refusal');
  await postComment(`HAM finding dispute — ${review.html_url || review.node_id} finding=${findingNumber}\n`
    + `Reviewed-Head: ${headSha}\nFinding-Reviewed-Head: ${review.commit_id}\n\n${evidence.trim()}\n\n`
    + 'Reviewer: evaluate this evidence on the exact head and explicitly confirm or withdraw the blocking finding. '
    + 'Merge remains blocked pending adjudication.');
  const live = await get(`repos/${repo}/pulls/${prNumber}`);
  if (live.state !== 'open' || live.head?.sha !== headSha) throw new Error('head moved before dispute re-review');
  const result = request({ rootDir, repo, prNumber, targetRevisionRef: headSha, db, logger,
    reason: `HAM finding dispute: ${reviewRef} finding=${findingNumber}; confirm or withdraw using PR evidence` });
  if (!result.triggered && result.status !== 'pending' && result.reason !== 'review-in-flight') {
    db.prepare('UPDATE ham_finding_disputes SET refusals=refusals+1 WHERE repo=? AND pr_number=? AND identity=?').run(...params);
    const row = db.prepare('SELECT refusals FROM ham_finding_disputes WHERE repo=? AND pr_number=? AND identity=?').get(...params);
    if (row.refusals >= 2) return exhaust(result.reason);
  }
  return result;
}
