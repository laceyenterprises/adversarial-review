import { createHash } from 'node:crypto';
import { normalizeDroppedReason } from './finding-drop-reason.mjs';
import { syncFindingDisputes } from './review-finding-records.mjs';

export const GRADE_KINDS = Object.freeze(['batch-remediator', 'grader', 'judge', 'hammer', 'remediator', 'lifecycle', 'scar', 'operator']);
export const GRADE_TAXONOMY = Object.freeze({
  'tp.valid': 'real', 'tp.already-fixed-elsewhere': 'real', 'tp.out-of-scope': 'real',
  'fp.misread-code': 'false', 'fp.hallucinated-symbol': 'false', 'fp.wrong-spec': 'false',
  'fp.speculative': 'false', 'fp.duplicate': 'false', 'fp.unclassified': 'false',
  'ind.stale': 'indeterminate', 'ind.cannot-reproduce': 'indeterminate',
  'life.pr-closed': 'indeterminate', 'life.superseded': 'indeterminate',
  'sev.should-block': null, 'sev.should-not-block': null,
});
const hash = text => createHash('sha256').update(text).digest('hex');

// Closed vocabulary: historical prose is not enough to guess a specific error.
export function backlogGradeCode(outcome, reason) {
  if (outcome === 'applied') return 'tp.valid';
  if (outcome !== 'dropped') return null;
  reason = normalizeDroppedReason(reason) || reason;
  if (['pr-closed-without-merge', 'false-positive: Source PR closed without merge; reviewed changes did not land'].includes(reason)) return 'life.pr-closed';
  if (['superseded-final-review', 'stale-code-changed: Final posted review superseded this finding'].includes(reason)) return 'life.superseded';
  if (/^already-fixed-in-[1-9]\d*:/.test(reason)) return 'tp.already-fixed-elsewhere';
  if (/^out-of-scope-with-ticket:/.test(reason)) return 'tp.out-of-scope';
  if (/^stale-code-changed:/.test(reason)) return 'ind.stale';
  if (/^not-reproducible:/.test(reason)) return 'ind.cannot-reproduce';
  if (/^false-positive:/.test(reason)) {
    const explicit = /^false-positive:\s*(?:fp\.)?(misread[- ]code|hallucinated[- ]symbol|wrong[- ]spec|speculative|duplicate)(?=\s*[:;—.]|\s*$|\s+(?:of|finding|symbol|claim|assumption|requirement)\b)/i.exec(reason);
    return explicit ? `fp.${explicit[1].toLowerCase().replaceAll(' ', '-')}` : 'fp.unclassified';
  }
  return null;
}

export function recordFindingGrade(db, grade) {
  const { sourceKey, findingId, taxonomyCode, graderKind, evidence, gradedAt,
    label = GRADE_TAXONOMY[taxonomyCode], gradedHeadSha = null, graderHarness = null,
    graderModel = null, graderEffort = null, promptDigest = null, confidence = null,
    costUsd = null, attempt = 1, interestedParty = false, lifecycle = taxonomyCode?.startsWith('life.') } = grade;
  if (!Object.hasOwn(GRADE_TAXONOMY, taxonomyCode) || !GRADE_KINDS.includes(graderKind)
    || !['real', 'false', 'indeterminate'].includes(label)
    || (GRADE_TAXONOMY[taxonomyCode] && label !== GRADE_TAXONOMY[taxonomyCode])
    || Boolean(lifecycle) !== taxonomyCode.startsWith('life.')
    || !sourceKey || !findingId || !gradedAt || !Number.isFinite(Date.parse(gradedAt))
    || !evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !Object.keys(evidence).length
    || (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))
    || (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0))
    || ![true, false, 0, 1].includes(interestedParty) || ![true, false, 0, 1].includes(lifecycle)
    || (gradedHeadSha !== null && !/^[a-f0-9]{40}$/i.test(gradedHeadSha))
    || !Number.isSafeInteger(attempt) || attempt < 1
    || (promptDigest !== null && !/^[a-f0-9]{64}$/.test(promptDigest))) throw new Error('invalid finding grade');
  const evidenceJson = JSON.stringify(evidence);
  // Source keys identify immutable observations. Never overwrite an earlier grade.
  return db.prepare(`INSERT INTO review_finding_grades
    (source_key,finding_id,graded_head_sha,grader_kind,grader_harness,grader_model,grader_effort,
     prompt_digest,label,taxonomy_code,confidence,evidence_sha256,evidence_json,cost_usd,attempt,
     interested_party,lifecycle,graded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(source_key) DO NOTHING`).run(sourceKey, findingId, gradedHeadSha, graderKind,
    graderHarness, graderModel, graderEffort, promptDigest, label, taxonomyCode, confidence,
    hash(evidenceJson), evidenceJson, costUsd, attempt, Number(Boolean(interestedParty)), Number(Boolean(lifecycle)), gradedAt).changes;
}

// Explicit offline/local operation, never called by review or merge readers.
// Unknown historical model, cost, evaluation head and confidence remain NULL.
export function backfillFindingGrades(db, { onPass = () => {} } = {}) {
  const passes = db.prepare('SELECT DISTINCT pass_id FROM review_findings ORDER BY pass_id').all();
  const projectPass = db.transaction(passId => {
    syncFindingDisputes(db, { passId });
    let inserted = 0;
    const add = (source, row, code, kind, head = null, interested = false, at = null) => {
      if (!code) return;
      const evidence = { source, record: row };
      inserted += recordFindingGrade(db, { sourceKey: `${source}:${row.finding_id}:${hash(JSON.stringify(row))}`,
        findingId: row.finding_id, taxonomyCode: code, graderKind: kind, gradedHeadSha: head,
        interestedParty: interested, evidence, gradedAt: at || new Date().toISOString() });
    };
    for (const row of db.prepare(`SELECT b.* FROM finding_backlog b
      JOIN review_findings f USING(finding_id) WHERE f.pass_id=? AND outcome IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM review_finding_grades g
        WHERE g.source_key='batch:' || b.batch_id || ':' || b.finding_id)
      ORDER BY b.finding_id`).all(passId)) {
      // Selection provenance is not a new worker observation. Keep historical
      // backlog source hashes stable across the additive scope migration.
      delete row.manifest_sha256;
      const code = backlogGradeCode(row.outcome, row.reason);
      add('backlog', row, code, code?.startsWith('life.') ? 'lifecycle' : 'batch-remediator', null, false, row.resolved_at);
    }
    for (const row of db.prepare(`SELECT m.*,r.start_head_sha,r.published_head_sha,r.payload_json,r.round_number
      FROM review_finding_remediations m JOIN review_finding_replies r USING(reply_id)
      JOIN review_findings f USING(finding_id) WHERE f.pass_id=?
      ORDER BY m.finding_id,m.reply_id`).all(passId)) {
      const withdrawn = row.reason === 'disputed-with-evidence' || row.reason === 'withdrawn-by-remediator';
      const code = withdrawn ? 'fp.unclassified' : row.commit_sha ? 'tp.valid' : null;
      add('remediation', row, code, 'remediator', withdrawn ? row.start_head_sha : null, withdrawn);
    }
    for (const row of db.prepare(`SELECT d.* FROM review_finding_disputes d
      JOIN review_findings f USING(finding_id)
      WHERE f.pass_id=? AND resolution='withdrawn-by-hammer' AND comment_id<>''
      ORDER BY d.finding_id,d.head_sha,d.comment_id`).all(passId)) {
      add('dispute', row, 'fp.unclassified', 'hammer', row.head_sha, true);
    }
    // Remediator withdrawals deliberately have no GitHub comment and therefore
    // are absent from the comment-keyed review_finding_disputes projection.
    for (const row of db.prepare(`SELECT f.finding_id,d.* FROM ham_finding_disputes d
      JOIN reviewer_passes p ON p.repo=d.repo AND p.pr_number=d.pr_number
      JOIN review_findings f ON f.pass_id=p.pass_id AND f.hammer_identity=d.identity
        AND f.head_sha=d.finding_reviewed_head AND f.blocking=1
      WHERE f.pass_id=? AND d.resolution='withdrawn-by-remediator' AND d.reply_id IS NOT NULL
      ORDER BY f.finding_id`).all(passId)) {
      add('remediator-dispute', row, 'fp.unclassified', 'remediator', row.head_sha, true, row.resolved_at);
    }
    return inserted;
  });
  // A corpus backfill must not hold the shared writer lock for the whole run.
  let inserted = 0;
  for (const { pass_id } of passes) {
    const added = projectPass.immediate(pass_id);
    inserted += added;
    onPass({ passId: pass_id, inserted: added });
  }
  return { inserted };
}

export function readFindingGrades(db, { findingId = null, repo = null, afterGradeId = 0, limit = 500 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000
    || !Number.isSafeInteger(afterGradeId) || afterGradeId < 0) throw new Error('invalid grade cursor or limit');
  return db.prepare(`SELECT g.*,p.repo,p.pr_number,f.head_sha AS reviewed_head_sha,
    f.reviewer_model,f.reviewer_harness,f.prompt_set AS reviewer_prompt_set,f.prompt_digest AS reviewer_prompt_digest
    FROM review_finding_grades g JOIN review_findings f USING(finding_id)
    JOIN reviewer_passes p USING(pass_id)
    WHERE g.grade_id>? AND (? IS NULL OR g.finding_id=?) AND (? IS NULL OR p.repo=?)
    ORDER BY g.grade_id LIMIT ?`).all(afterGradeId, findingId, findingId, repo, repo, limit);
}
