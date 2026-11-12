import { createHash } from 'node:crypto';
import { parseReviewFindings } from './kernel/review-findings.mjs';
import { extractSimplicityNote } from './kernel/verdict.mjs';
import { disputeEvidenceForFinding, normalizeCoverageTitle, validateRemediationReply } from './kernel/remediation-reply.mjs';
import { blockingFindingIdentity, evidenceDigest, REMEDIATOR_WITHDRAWN_RESOLUTION } from './ama/hammer-adjudication.mjs';
import { attributeFindingCommits, findingPath } from './finding-commit-attribution.mjs';
import { withSqliteBusyRetrySync } from './sqlite-busy-retry.mjs';
import { createBackfillWritePacer, DEFAULT_BACKFILL_WRITE_DUTY_CYCLE } from './backfill-write-pacer.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Cross-repo capability flag read by the companion explicit OSG backfill, which
// refuses to run unless it is true. It asserts: backfillReviewFindings persists
// historical_projection=1, and finding_backlog_candidates excludes those rows,
// so a backfill never enrolls remediation work. Pinned by
// test/osgboundaryflag-01.test.mjs; it has no in-repo caller, so do not remove it.
export const HISTORICAL_PROJECTION_SUPPORTED = true;

// Cross-repo capability flag for the same companion backfill. It asserts that
// backfillReviewFindings and backfillFindingGrades accept maxWriteDutyCycle or a
// shared pacer from createBackfillWritePacer, yield after every write
// transaction, skip already-current finding passes without a write transaction,
// and return pacing totals. Pinned by test/osgbackfillpace-01.test.mjs.
export const BACKFILL_WRITE_PACING_SUPPORTED = true;
export { createBackfillWritePacer, DEFAULT_BACKFILL_WRITE_DUTY_CYCLE } from './backfill-write-pacer.mjs';

const REVIEW_KINDS = new Set(['first-pass', 'rereview']);

// Fixed field order makes content identities independent of object key order.
export function findingContent(finding, blocking) {
  return { blocking, title: finding.title ?? null, category: finding.category ?? null,
    file: finding.file ?? null, lines: finding.lines ?? null, problem: finding.problem ?? null,
    whyItMatters: finding.whyItMatters ?? null, recommendedFix: finding.recommendedFix ?? null };
}

const selectPass = db => db.prepare('SELECT * FROM reviewer_passes WHERE pass_id = ?');
const projectable = pass => Boolean(pass?.body_md) && REVIEW_KINDS.has(pass.pass_kind);

// Pure: everything a projection writes, derived from one pass row. The backfill
// runs this outside any transaction; live capture runs it under its write lock.
function planReviewFindings(passId, pass, { parse = parseReviewFindings } = {}) {
  const note = extractSimplicityNote(pass.body_md);
  const parsed = parse(pass.body_md);
  let metadata = {};
  try { metadata = JSON.parse(pass.metadata_json); } catch { /* Legacy metadata is unknown. */ }
  const execution = metadata?.reviewerExecution;
  const attribution = { identity: metadata?.reviewerAttribution?.identity || pass.reviewer_class,
    model: pass.reviewer_model, effort: pass.reasoning_effort, head: pass.head_sha };
  return {
    note,
    // Snapshot advice independently: an advisory-only review has no finding row.
    noteId: note && pass.head_sha ? digest([passId, note]) : null,
    attribution,
    prompt: [execution?.harness ?? null, execution?.promptSet ?? null, execution?.promptDigest ?? null,
      execution?.promptStage ?? null, execution?.promptDigests ? JSON.stringify(execution.promptDigests) : null],
    findings: [...parsed.blocking.findings.map(f => ({ f, blocking: 1 })),
      ...parsed.nonBlocking.findings.map(f => ({ f, blocking: 0 }))].map(({ f, blocking }, index) => {
      const content = findingContent(f, blocking);
      const hash = digest(content);
      return { id: `${passId}:${index + 1}:${hash}`, ordinal: index + 1, hash, content,
        hammer: blockingFindingIdentity(f) };
    }),
  };
}

function writeReviewFindings(db, passId, pass, plan, historicalProjection) {
  const { note, noteId, attribution } = plan;
  db.prepare(`DELETE FROM finding_batch_notes WHERE pass_id=? AND batch_id IS NULL
    AND (? IS NULL OR note_id<>?)`).run(passId, noteId, noteId);
  if (noteId) db.prepare(`INSERT INTO finding_batch_notes
    (note_id,pass_id,repo,pr_number,head_sha,note,historical_projection) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(note_id) DO UPDATE SET historical_projection=min(finding_batch_notes.historical_projection,excluded.historical_projection)`)
    .run(noteId, passId, pass.repo, pass.pr_number, pass.head_sha, note, Number(historicalProjection));
  db.prepare('UPDATE review_findings SET current_body=0 WHERE pass_id=?').run(passId);
  const insert = db.prepare(`INSERT INTO review_findings
    (finding_id, pass_id, ordinal, content_sha256, blocking, category, file, lines, title,
     finding_json, reviewer_identity, reviewer_model, reasoning_effort, head_sha, hammer_identity, historical_projection)
    VALUES (@id, @pass, @ordinal, @hash, @blocking, @category, @file, @lines, @title,
      @json, @identity, @model, @effort, @head, @hammer, @historical)
    ON CONFLICT(finding_id) DO UPDATE SET reviewer_identity=excluded.reviewer_identity,
      reviewer_model=excluded.reviewer_model, reasoning_effort=excluded.reasoning_effort,
      head_sha=excluded.head_sha, current_body=1,
      historical_projection=min(review_findings.historical_projection,excluded.historical_projection)`);
  const exists = db.prepare('SELECT historical_projection FROM review_findings WHERE finding_id=?');
  const promoted = [];
  let inserted = 0;
  for (const { id, ordinal, hash, content, hammer } of plan.findings) {
    const previous = exists.get(id);
    if (!previous) inserted++;
    else if (!historicalProjection && previous.historical_projection === 1) promoted.push(id);
    insert.run({ id, pass: passId, ordinal, hash, ...content, json: JSON.stringify(content),
      ...attribution, hammer, historical: Number(historicalProjection) });
  }
  db.prepare(`UPDATE review_findings SET reviewer_harness=?,prompt_set=?,prompt_digest=?,prompt_stage=?,prompt_digests_json=?
    WHERE pass_id=?`).run(...plan.prompt, passId);
  // A genuine live capture can arrive after a historical projection. The
  // receipt trigger ran before this projection promoted the existing rows.
  if (promoted.length) db.prepare(`INSERT OR IGNORE INTO finding_backlog
    (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area)
    SELECT c.* FROM finding_backlog_candidates c
    JOIN review_findings f USING(finding_id)
    JOIN reviewed_prs r ON r.repo=c.repo AND r.pr_number=c.pr_number
    WHERE f.finding_id IN (SELECT value FROM json_each(?)) AND r.pr_state='merged'`)
    .run(JSON.stringify(promoted));
  syncFindingDisputes(db, { passId });
  return inserted;
}

// Read-only: true only when writeReviewFindings would leave every row it can
// touch unchanged (notes, findings, attribution, prompts, promotion, disputes).
// A false result only costs a write; a wrong true result would lose a repair.
function reviewFindingsProjectionCurrent(db, passId, plan, historicalProjection) {
  const historical = Number(historicalProjection);
  const notes = db.prepare('SELECT note_id FROM finding_batch_notes WHERE pass_id=? AND batch_id IS NULL').all(passId);
  if (notes.some(row => row.note_id !== plan.noteId)) return false;
  if (plan.noteId) {
    const note = db.prepare('SELECT historical_projection FROM finding_batch_notes WHERE note_id=?').get(plan.noteId);
    if (!note || note.historical_projection > historical) return false;
  }
  const rows = new Map(db.prepare(`SELECT finding_id,current_body,reviewer_identity,reviewer_model,
    reasoning_effort,head_sha,historical_projection,reviewer_harness,prompt_set,prompt_digest,prompt_stage,
    prompt_digests_json FROM review_findings WHERE pass_id=?`).all(passId).map(row => [row.finding_id, row]));
  const expected = new Set(plan.findings.map(f => f.id));
  const { identity, model, effort, head } = plan.attribution;
  for (const id of expected) {
    const row = rows.get(id);
    if (!row || row.current_body !== 1 || row.historical_projection > historical
      || row.reviewer_identity !== identity || row.reviewer_model !== model
      || row.reasoning_effort !== effort || row.head_sha !== head) return false;
  }
  for (const row of rows.values()) {
    if (!expected.has(row.finding_id) && row.current_body !== 0) return false;
    if ([row.reviewer_harness, row.prompt_set, row.prompt_digest, row.prompt_stage, row.prompt_digests_json]
      .some((value, index) => value !== plan.prompt[index])) return false;
  }
  // Same source rows as syncFindingDisputes, keyed exactly as its upsert.
  return !db.prepare(`SELECT 1 FROM review_findings f JOIN reviewer_passes p ON p.pass_id=f.pass_id
    JOIN ham_finding_disputes d ON d.repo=p.repo AND d.pr_number=p.pr_number
      AND d.identity=f.hammer_identity AND d.finding_reviewed_head=f.head_sha
    WHERE f.blocking=1 AND d.comment_id IS NOT NULL AND d.head_sha IS NOT NULL
      AND d.head_sha <> '' AND f.pass_id=?
      AND NOT EXISTS (SELECT 1 FROM review_finding_disputes x WHERE x.finding_id=f.finding_id
        AND x.head_sha=COALESCE(d.head_sha, '') AND x.comment_id=COALESCE(d.comment_id, '')
        AND x.resolution IS d.resolution AND x.evidence_sha256 IS d.evidence_sha256
        AND x.requests IS d.requests AND x.refusals IS d.refusals)
    LIMIT 1`).get(passId);
}

const sameRow = (a, b) => Boolean(a && b) && Object.keys(a).length === Object.keys(b).length
  && Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key]);

export function persistReviewFindings(db, passId, { historicalProjection = false } = {}) {
  // Acquire the WAL write lock before reading a snapshot. A deferred snapshot
  // upgrade can fail immediately without consulting the connection busy timeout.
  return db.transaction(() => {
    const pass = selectPass(db).get(passId);
    if (!projectable(pass)) return 0;
    return writeReviewFindings(db, passId, pass, planReviewFindings(passId, pass), historicalProjection);
  }).immediate();
}

// Historical projection of one pass for a bulk backfill that shares the
// database with live writers. Parse outside any transaction; skip a pass whose
// projection is already current with reads only; otherwise write under a short
// immediate transaction that first re-checks the pass row. A row a live writer
// changed is re-read and re-parsed outside the lock, so a stale parse is never
// written. Only a pass that keeps changing is finally re-planned under the lock.
const STALE_PLAN = Symbol('stale-plan');
const OUTSIDE_LOCK_PLAN_ATTEMPTS = 3;

function backfillReviewFindingPass(db, passId, pacer, parse) {
  const select = selectPass(db);
  for (let attempt = 1; ; attempt++) {
    const snapshot = select.get(passId);
    if (!projectable(snapshot)) return { inserted: 0, wrote: false, replanned: attempt > 1 };
    const plan = planReviewFindings(passId, snapshot, { parse });
    // A deferred transaction that only reads takes no write lock; it gives the
    // row re-read and the projection reads one consistent snapshot.
    if (db.transaction(() => sameRow(select.get(passId), snapshot)
      && reviewFindingsProjectionCurrent(db, passId, plan, true))()) {
      return { inserted: 0, wrote: false, replanned: attempt > 1 };
    }
    const lastAttempt = attempt >= OUTSIDE_LOCK_PLAN_ATTEMPTS;
    const inserted = pacer.write(() => db.transaction(() => {
      const pass = select.get(passId);
      if (sameRow(pass, snapshot)) return writeReviewFindings(db, passId, pass, plan, true);
      if (!lastAttempt) return STALE_PLAN;
      return projectable(pass) ? writeReviewFindings(db, passId, pass, planReviewFindings(passId, pass, { parse }), true) : 0;
    }).immediate());
    if (inserted !== STALE_PLAN) return { inserted, wrote: true, replanned: attempt > 1 };
  }
}

// These records are observations only. Errors never change review or dispatch
// results; the stored bodies and jobs remain the repair source for backfill.
export function persistReviewFindingsSafe(db, passId, log = console, options = {}) {
  try {
    return withSqliteBusyRetrySync(() => persistReviewFindings(db, passId, options),
      { delaysMs: [100], label: `review-findings:${passId}`, log });
  }
  catch { log.warn?.(`[review-findings] projection failed for pass ${passId}; backfill required for evidence only; automatic enrollment is not restored`); return 0; }
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

export function backfillReviewFindings(db, { afterPassId = 0, limit = 500, repo = null,
  onPass = () => {}, maxWriteDutyCycle = DEFAULT_BACKFILL_WRITE_DUTY_CYCLE,
  pacer = createBackfillWritePacer({ maxWriteDutyCycle }), parse = parseReviewFindings } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('limit must be 1..5000');
  const rows = db.prepare(`SELECT pass_id FROM reviewer_passes
    WHERE pass_id>? AND body_md IS NOT NULL AND pass_kind IN ('first-pass','rereview')
      AND (? IS NULL OR repo=?) ORDER BY pass_id LIMIT ?`).all(afterPassId, repo, repo, limit);
  let inserted = 0;
  let written = 0;
  let replanned = 0;
  for (const row of rows) {
    const pass = backfillReviewFindingPass(db, row.pass_id, pacer, parse);
    inserted += pass.inserted;
    written += Number(pass.wrote);
    replanned += Number(Boolean(pass.replanned));
    // Report only committed work, including passes before a later busy failure.
    onPass({ passId: row.pass_id, inserted: pass.inserted });
  }
  return { scanned: rows.length, inserted, nextPassId: rows.at(-1)?.pass_id ?? afterPassId,
    written, skipped: rows.length - written, replanned, pacing: pacer.summary() };
}

export function linkFindingRemediation(db, { job, workspaceDir, roundNumber = job?.remediationPlan?.currentRound,
  attribute = attributeFindingCommits, historicalProjection = false } = {}) {
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
    persistReviewFindings(db, p.pass_id, { historicalProjection });
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
  }).immediate();
}

// A caller-owned SQLite connection can be read-only. Missing/legacy schema is
// reported to the corpus caller; it must not turn missing data into zero findings.
export function readReviewFindings(db, { repo = null, prNumber = null, prNumbers = null,
  findingId = null, reviewerModel = null, reviewerHarness = null, promptDigest = null,
  since = null, until = null, area = null, blocking = 'any', labelState = null,
  afterPassId = 0, afterOrdinal = 0, limit = 500 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('limit must be 1..5000');
  if (!['any', true, false, 0, 1].includes(blocking)
    || ![null, 'ungraded', 'graded', 'disputed'].includes(labelState)
    || (prNumbers !== null && (!Array.isArray(prNumbers) || !prNumbers.length
      || prNumbers.some(n => !Number.isSafeInteger(n) || n < 1)))
    || [since, until].some(t => t !== null && !Number.isFinite(Date.parse(t)))
    || (since && until && Date.parse(since) >= Date.parse(until))
    || (area !== null && (!area || area.startsWith('/') || area.split('/').includes('..')))) {
    throw new Error('invalid finding filters');
  }
  // Apply filters before keyset pagination. Area is a literal path prefix, not
  // a LIKE expression; timestamps compare instants, with an exclusive end.
  const where = ['f.current_body=1', '(f.pass_id>? OR (f.pass_id=? AND f.ordinal>?))'];
  const params = [afterPassId, afterPassId, afterOrdinal];
  for (const [column, value] of [['p.repo', repo], ['p.pr_number', prNumber],
    ['f.finding_id', findingId], ['f.reviewer_model', reviewerModel],
    ['f.reviewer_harness', reviewerHarness], ['f.prompt_digest', promptDigest]]) {
    if (value !== null) { where.push(`${column}=?`); params.push(value); }
  }
  if (prNumbers !== null) { where.push('p.pr_number IN (SELECT value FROM json_each(?))'); params.push(JSON.stringify(prNumbers)); }
  if (blocking !== 'any') { where.push('f.blocking=?'); params.push(Number(blocking)); }
  if (since !== null) { where.push('julianday(p.started_at)>=julianday(?)'); params.push(new Date(Date.parse(since)).toISOString()); }
  if (until !== null) { where.push('julianday(p.started_at)<julianday(?)'); params.push(new Date(Date.parse(until)).toISOString()); }
  if (area !== null) {
    area = area.replace(/\/+$/, '');
    // Captured File fields retain Markdown code quoting and may contain
    // padding spaces both outside and inside the backticks.
    const file = "trim(trim(trim(f.file),'`'))";
    where.push(`(${file}=? OR substr(${file},1,length(?)+1)=? OR b.area=?)`);
    params.push(area, area, `${area}/`, area);
  }
  const graded = `EXISTS (SELECT 1 FROM review_finding_grades g WHERE g.finding_id=f.finding_id
    AND g.lifecycle=0 AND g.taxonomy_code NOT LIKE 'sev.%')`;
  const disputed = `(EXISTS (SELECT 1 FROM review_finding_grades g JOIN review_finding_grades h
    ON h.finding_id=g.finding_id WHERE g.finding_id=f.finding_id
    AND g.lifecycle=0 AND h.lifecycle=0 AND g.label='real' AND h.label='false'
    AND g.taxonomy_code NOT LIKE 'sev.%' AND h.taxonomy_code NOT LIKE 'sev.%')
    OR EXISTS (SELECT 1 FROM review_finding_remediations m WHERE m.finding_id=f.finding_id AND m.reason='disputed-with-evidence')
    OR EXISTS (SELECT 1 FROM review_finding_disputes d WHERE d.finding_id=f.finding_id
      AND d.resolution='withdrawn-by-hammer' AND d.comment_id<>''))`;
  if (labelState === 'graded') where.push(graded);
  if (labelState === 'ungraded') where.push(`NOT ${graded}`);
  if (labelState === 'disputed') where.push(disputed);
  const rows = db.prepare(`SELECT f.*, p.repo, p.pr_number, p.verdict, p.started_at,
    b.outcome AS backlog_outcome,b.reason AS backlog_reason,b.batch_id AS backlog_batch_id,b.result_pr AS backlog_result_pr,
    ${graded} AS graded, ${disputed} AS disputed
    FROM review_findings f JOIN reviewer_passes p ON p.pass_id=f.pass_id
    LEFT JOIN finding_backlog b ON b.finding_id=f.finding_id WHERE ${where.join(' AND ')}
    ORDER BY f.pass_id, f.ordinal LIMIT ?`).all(...params, limit);
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
  const gradesByFinding = groupByFinding(db.prepare(`SELECT * FROM review_finding_grades
    WHERE finding_id IN (SELECT value FROM json_each(?)) ORDER BY finding_id,grade_id`).all(ids));
  const remediationsByFinding = groupByFinding(remediationRows);
  const disputesByFinding = groupByFinding(disputeRows);
  return rows.map(row => {
    const remediations = remediationsByFinding.get(row.finding_id) || [];
    const disputes = disputesByFinding.get(row.finding_id) || [];
    const status = remediations.some(m => m.reason === 'disputed-with-evidence')
      || disputes.some(d => d.resolution === 'withdrawn-by-hammer' && d.comment_id)
      ? 'withdrawn' : row.verdict === 'dismissed' ? 'dismissed'
        : remediations.some(m => m.commit_sha) ? 'addressed' : 'unaddressed';
    return { ...row, status, remediations, disputes, grades: gradesByFinding.get(row.finding_id) || [] };
  });
}
