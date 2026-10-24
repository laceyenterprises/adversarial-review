import { createHash } from 'node:crypto';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { disputeEvidenceForFinding, normalizeCoverageTitle, validateRemediationReply } from './kernel/remediation-reply.mjs';
import { blockingFindingIdentity, evidenceDigest, REMEDIATOR_WITHDRAWN_RESOLUTION } from './ama/hammer-adjudication.mjs';
import { attributeFindingCommits, findingPath } from './finding-commit-attribution.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const REVIEW_KINDS = new Set(['first-pass', 'rereview']);

// Fixed field order makes content identities independent of object key order.
export function findingContent(finding, blocking) {
  return { blocking, title: finding.title ?? null, category: finding.category ?? null,
    file: finding.file ?? null, lines: finding.lines ?? null, problem: finding.problem ?? null,
    whyItMatters: finding.whyItMatters ?? null, recommendedFix: finding.recommendedFix ?? null };
}

export function persistReviewFindings(db, passId) {
  return db.transaction(() => {
    const pass = db.prepare('SELECT * FROM reviewer_passes WHERE pass_id = ?').get(passId);
    if (!pass?.body_md || !REVIEW_KINDS.has(pass.pass_kind)) return 0;
    const parsed = parseReviewFindings(pass.body_md);
    const findings = [...parsed.blocking.findings.map(f => ({ f, blocking: 1 })),
      ...parsed.nonBlocking.findings.map(f => ({ f, blocking: 0 }))];
    let metadata = {};
    try { metadata = JSON.parse(pass.metadata_json); } catch { /* Legacy metadata is unknown. */ }
    db.prepare('UPDATE review_findings SET current_body=0 WHERE pass_id=?').run(passId);
    const insert = db.prepare(`INSERT INTO review_findings
      (finding_id, pass_id, ordinal, content_sha256, blocking, category, file, lines, title,
       finding_json, reviewer_identity, reviewer_model, reasoning_effort, head_sha, hammer_identity)
      VALUES (@id, @pass, @ordinal, @hash, @blocking, @category, @file, @lines, @title,
        @json, @identity, @model, @effort, @head, @hammer)
      ON CONFLICT(finding_id) DO UPDATE SET reviewer_identity=excluded.reviewer_identity,
        reviewer_model=excluded.reviewer_model, reasoning_effort=excluded.reasoning_effort,
        head_sha=excluded.head_sha, current_body=1`);
    const exists = db.prepare('SELECT 1 FROM review_findings WHERE finding_id=?');
    let inserted = 0;
    for (const [index, { f, blocking }] of findings.entries()) {
      const content = findingContent(f, blocking);
      const hash = digest(content);
      const id = `${passId}:${index + 1}:${hash}`;
      if (!exists.get(id)) inserted++;
      insert.run({ id, pass: passId, ordinal: index + 1, hash, ...content,
        json: JSON.stringify(content), identity: metadata?.reviewerAttribution?.identity || pass.reviewer_class,
        model: pass.reviewer_model, effort: pass.reasoning_effort, head: pass.head_sha,
        hammer: blockingFindingIdentity(f) });
    }
    syncFindingDisputes(db, { passId });
    return inserted;
  })();
}

// These records are observations only. Errors never change review or dispatch
// results; the stored bodies and jobs remain the repair source for backfill.
export function persistReviewFindingsSafe(db, passId, log = console) {
  try { return persistReviewFindings(db, passId); }
  catch { log.warn?.(`[review-findings] projection failed for pass ${passId}; backfill required`); return 0; }
}

export function syncFindingDisputes(db, { passId = null } = {}) {
  return db.prepare(`INSERT INTO review_finding_disputes
    (finding_id, identity, head_sha, comment_id, resolution, evidence_sha256, requests, refusals)
    SELECT f.finding_id, d.identity, COALESCE(d.head_sha, ''), COALESCE(d.comment_id, ''),
      d.resolution, d.evidence_sha256, d.requests, d.refusals
    FROM review_findings f JOIN reviewer_passes p ON p.pass_id=f.pass_id
    JOIN ham_finding_disputes d ON d.repo=p.repo AND d.pr_number=p.pr_number
      AND d.identity=f.hammer_identity AND d.finding_reviewed_head=f.head_sha
    WHERE f.blocking=1 AND d.comment_id IS NOT NULL AND d.head_sha IS NOT NULL
      AND d.head_sha <> '' AND (? IS NULL OR f.pass_id=?)
    ON CONFLICT(finding_id, head_sha, comment_id) DO UPDATE SET
      resolution=excluded.resolution, evidence_sha256=excluded.evidence_sha256,
      requests=excluded.requests, refusals=excluded.refusals`).run(passId, passId).changes;
}

export function backfillReviewFindings(db, { afterPassId = 0, limit = 500, repo = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('limit must be 1..5000');
  const rows = db.prepare(`SELECT pass_id FROM reviewer_passes
    WHERE pass_id>? AND body_md IS NOT NULL AND pass_kind IN ('first-pass','rereview')
      AND (? IS NULL OR repo=?) ORDER BY pass_id LIMIT ?`).all(afterPassId, repo, repo, limit);
  let inserted = 0;
  for (const row of rows) inserted += persistReviewFindings(db, row.pass_id);
  return { scanned: rows.length, inserted, nextPassId: rows.at(-1)?.pass_id ?? afterPassId };
}

export function linkFindingRemediation(db, { job, workspaceDir, roundNumber = job?.remediationPlan?.currentRound,
  attribute = attributeFindingCommits } = {}) {
  const round = job?.remediationPlan?.rounds?.find(r => r.round === roundNumber);
  if (!job?.jobId || !round) return { linked: 0, reason: 'missing-round' };
  const start = round.startHeadSha;
  const published = round.publishedHeadSha || round.resultingHeadSha;
  const artifact = round.remediationReply || job.remediationReply;
  const payload = artifact?.payload ?? null;
  let validated = false;
  try { validateRemediationReply(payload, { expectedJob: job }); validated = true; } catch { /* Legacy/missing replies are observations only. */ }
  // Exact body AND reviewed head avoid linking a repeated title from another
  // review, or from a later round, to this reply.
  const passes = db.prepare(`SELECT pass_id FROM reviewer_passes WHERE repo=? AND pr_number=?
    AND head_sha=? AND body_md=? AND pass_kind IN ('first-pass','rereview')`)
    .all(job.repo, job.prNumber, job.revisionRef || start, job.reviewBody || '');
  const findings = passes.flatMap(p => {
    persistReviewFindings(db, p.pass_id);
    return db.prepare('SELECT * FROM review_findings WHERE pass_id=? AND current_body=1 ORDER BY ordinal').all(p.pass_id);
  });
  if (!findings.length) return { linked: 0, reason: 'no-matching-review' };
  const attribution = attribute({ findings, workspaceDir, startHead: start, publishedHead: published });
  const replyId = digest([job.jobId, roundNumber, start ?? null, published ?? null, payload]);
  return db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO review_finding_replies
      (reply_id, job_id, round_number, reply_path, payload_json, start_head_sha, published_head_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(replyId, job.jobId, roundNumber,
      artifact?.path ?? null, payload ? JSON.stringify(payload) : null, start ?? null, published ?? null);
    for (const f of findings) {
      const fields = f.blocking ? ['addressed', 'pushback', 'blockers'] : ['nonBlocking', 'addressed'];
      const matchesFinding = (entry, finding, field) => entry
        && normalizeCoverageTitle(entry.title || entry.finding) === normalizeCoverageTitle(finding.title)
        && (!entry.files?.length || entry.files.some(file => findingPath(file) === findingPath(finding.file)))
        && (field !== 'pushback' || !entry.evidence
          || disputeEvidenceForFinding(entry, JSON.parse(finding.finding_json), job.revisionRef));
      const matches = fields.flatMap(field => (Array.isArray(payload?.[field]) ? payload[field] : [])
        .map((entry, ordinal) => ({ field, ordinal, entry }))
        .filter(({ entry }) => matchesFinding(entry, f, field)));
      const match = matches.length === 1 ? matches[0] : null;
      const ambiguous = match && findings.some(other => other.pass_id === f.pass_id
        && other.finding_id !== f.finding_id && matchesFinding(match.entry, other, match.field));
      const overlap = attribution.get(f.finding_id);
      const addressed = match && !ambiguous && ['addressed', 'nonBlocking'].includes(match.field);
      const disputed = validated && job.status === 'completed' && round.state === 'completed'
        && match?.field === 'pushback' && !ambiguous
        && disputeEvidenceForFinding(match.entry, JSON.parse(f.finding_json), job.revisionRef);
      const reason = disputed ? 'disputed-with-evidence' : ambiguous ? 'ambiguous-reply' : !match ? (matches.length ? 'ambiguous-reply' : 'no-matching-reply')
        : !addressed ? match.field : overlap?.reason || 'missing-history';
      if (disputed) {
        // Cache admission at the completion event. Gate readers keep their
        // existing single keyed query; they never scan reply artifacts.
        db.prepare(`INSERT INTO ham_finding_disputes
          (repo, pr_number, identity, head_sha, finding_reviewed_head, resolution, resolved_at,
           evidence_sha256, reply_id, review_body_sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(repo, pr_number, identity) DO UPDATE SET head_sha=excluded.head_sha,
            finding_reviewed_head=excluded.finding_reviewed_head, resolution=excluded.resolution,
            resolved_at=excluded.resolved_at, evidence_sha256=excluded.evidence_sha256,
            reply_id=excluded.reply_id, review_body_sha256=excluded.review_body_sha256,
            comment_id=NULL, comment_author=NULL, comment_sha256=NULL
          WHERE ham_finding_disputes.reserved_at IS NULL AND
            (ham_finding_disputes.resolution IS NOT 'withdrawn-by-hammer'
             OR ham_finding_disputes.head_sha IS NOT excluded.head_sha)`)
          .run(job.repo, job.prNumber, f.hammer_identity, disputed.headSha, f.head_sha,
            REMEDIATOR_WITHDRAWN_RESOLUTION, job.completedAt || round.finishedAt,
            evidenceDigest(JSON.stringify(disputed)), replyId, evidenceDigest(job.reviewBody));
      }
      db.prepare(`INSERT INTO review_finding_remediations
        (finding_id, reply_id, reply_field, reply_ordinal, commit_sha, reason) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(finding_id, reply_id) DO UPDATE SET reply_field=excluded.reply_field,
          reply_ordinal=excluded.reply_ordinal, commit_sha=excluded.commit_sha, reason=excluded.reason`)
        .run(f.finding_id, replyId, match?.field ?? null, match?.ordinal ?? null,
          addressed ? overlap?.commitSha ?? null : null, reason);
    }
    return { linked: findings.length, replyId };
  })();
}

// A caller-owned SQLite connection can be read-only. Missing/legacy schema is
// reported to the corpus caller; it must not turn missing data into zero findings.
export function readReviewFindings(db, { repo = null, prNumber = null, afterPassId = 0, afterOrdinal = 0, limit = 500 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('limit must be 1..5000');
  const rows = db.prepare(`SELECT f.*, p.repo, p.pr_number, p.verdict, p.started_at,
    b.outcome AS backlog_outcome,b.reason AS backlog_reason,b.batch_id AS backlog_batch_id,b.result_pr AS backlog_result_pr
    FROM review_findings f JOIN reviewer_passes p ON p.pass_id=f.pass_id
    LEFT JOIN finding_backlog b ON b.finding_id=f.finding_id WHERE f.current_body=1 AND (f.pass_id>? OR (f.pass_id=? AND f.ordinal>?))
      AND (? IS NULL OR p.repo=?) AND (? IS NULL OR p.pr_number=?)
    ORDER BY f.pass_id, f.ordinal LIMIT ?`).all(afterPassId, afterPassId, afterOrdinal, repo, repo, prNumber, prNumber, limit);
  if (!rows.length) return [];
  // JSON1 is already required by the schema. One bound array avoids both N+1
  // reads and SQLite's parameter-count limit for a 5,000-finding page.
  const ids = JSON.stringify(rows.map(row => row.finding_id));
  const groupByFinding = linkedRows => {
    const groups = new Map();
    for (const row of linkedRows) {
      if (!groups.has(row.finding_id)) groups.set(row.finding_id, []);
      groups.get(row.finding_id).push(row);
    }
    return groups;
  };
  const remediationRows = db.prepare(`SELECT m.*, r.job_id, r.round_number, r.reply_path,
    r.start_head_sha, r.published_head_sha,
    CASE WHEN m.reason='disputed-with-evidence' THEN
      json_extract(r.payload_json, '$.pushback[' || m.reply_ordinal || '].evidence') END AS dispute_evidence_json
    FROM review_finding_remediations m
    JOIN review_finding_replies r ON r.reply_id=m.reply_id
    WHERE m.finding_id IN (SELECT value FROM json_each(?))
    ORDER BY m.finding_id, r.round_number, r.reply_id`).all(ids);
  const disputeRows = db.prepare(`SELECT * FROM review_finding_disputes
    WHERE finding_id IN (SELECT value FROM json_each(?))
    ORDER BY finding_id, head_sha, comment_id`).all(ids);
  const remediationsByFinding = groupByFinding(remediationRows);
  const disputesByFinding = groupByFinding(disputeRows);
  return rows.map(row => {
    const remediations = remediationsByFinding.get(row.finding_id) || [];
    const disputes = disputesByFinding.get(row.finding_id) || [];
    const status = remediations.some(m => m.reason === 'disputed-with-evidence')
      || disputes.some(d => d.resolution === 'withdrawn-by-hammer' && d.comment_id)
      ? 'withdrawn' : row.verdict === 'dismissed' ? 'dismissed'
        : remediations.some(m => m.commit_sha) ? 'addressed' : 'unaddressed';
    return { ...row, status, remediations, disputes };
  });
}
