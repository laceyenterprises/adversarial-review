import { createHash } from 'node:crypto';
import { openReviewStateDb } from './review-state.mjs';
import { findingBacklogMaxAgeMs } from './finding-backlog-window.mjs';
import { persistReviewFindings } from './review-finding-records.mjs';

// Called at the merge command boundary. Missing/stale capture defers the merge,
// rather than spending a hammer or silently losing the findings.
export function captureReadyFindings({ rootDir, repo, prNumber, headSha, version, count, deferredFinding }) {
  const db = openReviewStateDb(rootDir);
  try {
    return db.transaction(() => {
      const pass = db.prepare(`SELECT * FROM reviewer_passes WHERE repo=? AND pr_number=?
        AND pass_kind IN ('first-pass','rereview') AND gh_comment_id IS NOT NULL AND trim(cast(gh_comment_id AS TEXT))<>''
        AND body_captured_at IS NOT NULL AND trim(body_captured_at)<>'' AND trim(body_md)<>''
        ORDER BY body_captured_at DESC, ended_at DESC, started_at DESC, pass_id DESC LIMIT 1`).get(repo, prNumber);
      if (!pass || pass.head_sha !== headSha || !version
        || createHash('sha256').update(pass.body_md || '').digest('hex') !== version) {
        throw Error('findings-capture-not-current');
      }
      persistReviewFindings(db, pass.pass_id);
      const actual = db.prepare('SELECT count(*) n FROM review_findings WHERE pass_id=? AND current_body=1 AND blocking=0')
        .get(pass.pass_id).n;
      if (actual !== count) throw Error('findings-capture-count-mismatch');
      if (deferredFinding) {
        const { findingNumber, reason } = deferredFinding;
        if (!Number.isSafeInteger(findingNumber) || findingNumber < 1
          || typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason)) {
          throw Error('findings-deferral-invalid');
        }
        const finding = db.prepare(`SELECT finding_id,content_sha256 FROM review_findings
          WHERE pass_id=? AND current_body=1 AND blocking=0 ORDER BY ordinal LIMIT 1 OFFSET ?`)
          .get(pass.pass_id, findingNumber - 1);
        if (!finding) throw Error('findings-deferral-not-found');
        const inserted = db.prepare(`INSERT OR IGNORE INTO finding_backlog
          (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area)
          SELECT * FROM finding_backlog_candidates WHERE finding_id=?`).run(finding.finding_id).changes;
        // `reason` is mutable queue state, not deferral history: settlement,
        // supersession and batch retries replace it. The hammer's head-bound
        // PR audit comment is the durable deferral record; it lists each
        // deferred finding/reason separately from remediated findings.
        const recorded = db.prepare(`UPDATE finding_backlog SET reason=?
          WHERE repo=? AND pr_number=? AND head_sha=? AND content_sha256=? AND outcome IS NULL`)
          .run(reason, repo, prNumber, headSha, finding.content_sha256).changes;
        if (!recorded) throw Error('findings-deferral-not-pending');
        return inserted;
      }
      return db.prepare(`INSERT OR IGNORE INTO finding_backlog
        (finding_id,repo,pr_number,head_sha,content_sha256,reviewer_family,area)
        SELECT * FROM finding_backlog_candidates WHERE repo=? AND pr_number=? AND head_sha=?`).run(repo, prNumber, headSha).changes;
    }).immediate();
  } finally { db.close(); }
}

// Missing schema is unavailable evidence, never an empty/healthy backlog.
export function summarizeFindingBacklog(db, now = Date.now(), { maxAgeMs } = {}) {
  if (!db) return { available: false, error: 'review-store-unavailable', areas: null };
  try {
    maxAgeMs ??= findingBacklogMaxAgeMs();
    if (!Number.isFinite(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) throw Error('invalid backlog window');
    const cutoff = new Date(now - maxAgeMs).toISOString();
    const selectionScope = Boolean(db.prepare("SELECT 1 FROM pragma_table_info('finding_backlog') WHERE name='manifest_sha256'").get());
    const batchSelection = Boolean(db.prepare("SELECT 1 FROM pragma_table_info('finding_batches') WHERE name='manifest_sha256'").get());
    const backlogScope = selectionScope ? 'manifest_sha256 IS NULL AND ' : '';
    const batchScope = batchSelection ? 'manifest_sha256 IS NULL AND ' : '';
    const areas = db.prepare(`WITH unresolved AS (
      SELECT b.repo,b.area,b.captured_at,b.batch_id,r.pr_state FROM finding_backlog b
      JOIN reviewed_prs r ON r.repo=b.repo AND r.pr_number=b.pr_number WHERE ${selectionScope ? 'b.manifest_sha256 IS NULL AND ' : ''}b.outcome IS NULL
      UNION ALL
      SELECT n.repo,coalesce(a.area,c.area,'_simplicity'),p.body_captured_at,n.batch_id,r.pr_state
      FROM finding_batch_notes n JOIN reviewer_passes p USING(pass_id)
      JOIN reviewed_prs r ON r.repo=n.repo AND r.pr_number=n.pr_number
      LEFT JOIN finding_batches a USING(batch_id)
      LEFT JOIN finding_batch_note_candidates c USING(note_id)
      WHERE n.dropped_reason IS NULL AND (n.batch_id IS NULL OR a.completed_at IS NULL)
        AND (n.batch_id IS NOT NULL OR (n.historical_projection=0
          AND (r.pr_state<>'merged' OR julianday(r.merged_at) >= julianday(?))))
    ) SELECT b.repo,b.area,count(*) AS size,min(b.captured_at) AS oldestAt,
      sum(b.batch_id IS NOT NULL) AS inBatch,sum(b.pr_state<>'merged') AS waitingForMerge,
      max(a.error) AS error FROM unresolved b LEFT JOIN finding_batches a USING(batch_id)
      GROUP BY b.repo,b.area ORDER BY b.repo,b.area`).all(cutoff)
      .map(row => ({ ...row, oldestAgeMs: Math.max(0, now - Date.parse(row.oldestAt)) }));
    const open = db.prepare(`SELECT count(*) AS openCount,min(captured_at) AS oldestOpenAt,
      sum(batch_id IS NULL) AS unbatchedCount FROM finding_backlog WHERE ${backlogScope}outcome IS NULL`).get();
    // A store not yet migrated by the watcher retains its summary while
    // retry progress remains unavailable.
    const requeue = Boolean(db.prepare("SELECT 1 FROM pragma_table_info('finding_batches') WHERE name='released_at'").get());
    const batchable = db.prepare(`SELECT count(*) AS batchableCount,min(b.captured_at) AS oldestBatchableAt
      FROM finding_backlog b JOIN reviewed_prs r USING(repo,pr_number)
      WHERE ${selectionScope ? 'b.manifest_sha256 IS NULL AND ' : ''}b.outcome IS NULL AND r.pr_state='merged'
        AND (b.batch_id IS NOT NULL OR ${requeue ? 'b.batch_attempts > 0 OR ' : ''}julianday(r.merged_at) >= julianday(?))`).get(cutoff);
    const excluded = db.prepare(`SELECT (SELECT count(*)
      FROM finding_backlog b JOIN reviewed_prs r USING(repo,pr_number)
      WHERE ${selectionScope ? 'b.manifest_sha256 IS NULL AND ' : ''}b.outcome IS NULL
        AND b.batch_id IS NULL AND ${requeue ? 'b.batch_attempts=0 AND ' : ''}r.pr_state='merged'
        AND (julianday(r.merged_at) IS NULL OR julianday(r.merged_at) < julianday(@cutoff))) AS outOfWindow,
      (SELECT count(*) FROM finding_batch_notes n JOIN reviewed_prs r USING(repo,pr_number)
        WHERE n.batch_id IS NULL AND n.dropped_reason IS NULL AND n.historical_projection=0
          AND r.pr_state='merged'
          AND (julianday(r.merged_at) IS NULL OR julianday(r.merged_at) < julianday(@cutoff))) AS notesOutOfWindow,
      (SELECT count(*) FROM finding_batch_notes
        WHERE batch_id IS NULL AND dropped_reason IS NULL AND historical_projection=1) AS notesHistorical`)
      .get({ cutoff });
    const perDay = db.prepare(`SELECT substr(resolved_at,1,10) AS day,
      sum(outcome='applied') AS applied,sum(outcome='dropped') AS dropped
      FROM finding_backlog WHERE ${backlogScope}outcome IS NOT NULL AND resolved_at IS NOT NULL
      GROUP BY day ORDER BY day DESC`).all();
    const batchErrors = db.prepare(`SELECT error,count(*) AS count FROM finding_batches
      WHERE ${batchScope}completed_at IS NULL ${requeue ? 'AND released_at IS NULL' : ''} AND error IS NOT NULL GROUP BY error ORDER BY error`).all();
    // Drain progress: open = unbatched + batched + stranded. Stranded findings
    // sit in an unsettled batch with an error; release returns them to the
    // queue (retrying) or drops them as exhausted. Drained means open is 0.
    const counts = requeue && db.prepare(`SELECT sum(b.outcome IS NULL) AS open,
      sum(b.outcome IS NULL AND b.batch_id IS NULL) AS unbatched,
      sum(b.outcome IS NULL AND b.batch_id IS NOT NULL AND a.error IS NULL) AS batched,
      sum(b.outcome IS NULL AND b.batch_id IS NOT NULL AND a.error IS NOT NULL) AS stranded,
      sum(b.outcome IS NULL AND b.batch_attempts > 0) AS retrying,
      sum(b.outcome='dropped' AND b.reason LIKE 'batch-retry-exhausted:%') AS exhausted
      FROM finding_backlog b LEFT JOIN finding_batches a ON a.batch_id=b.batch_id ${selectionScope ? 'WHERE b.manifest_sha256 IS NULL' : ''}`).get();
    const progress = counts ? { ...Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value || 0])),
      releasedBatches: db.prepare(`SELECT count(*) AS n FROM finding_batches WHERE ${batchScope}released_at IS NOT NULL`).get().n } : null;
    // Selected work requires an explicit manifest rerun after dispatch failure
    // or release. Keep it visible separately from automatic-drain health.
    const selectedBacklog = selectionScope && batchSelection ? db.prepare(`
      SELECT b.manifest_sha256 AS manifestSha256,
        sum(b.outcome IS NULL) AS openCount,
        sum(b.outcome IS NULL AND b.batch_id IS NULL) AS unbatchedCount,
        sum(b.outcome IS NULL AND a.error IS NOT NULL) AS erroredCount,
        sum(b.outcome IS NULL AND b.batch_id IS NOT NULL AND a.launch_id IS NULL) AS undispatchedCount
      FROM finding_backlog b LEFT JOIN finding_batches a USING(batch_id)
      WHERE b.manifest_sha256 IS NOT NULL GROUP BY b.manifest_sha256
      ORDER BY b.manifest_sha256`).all() : null;
    return { available: true, areas, ...open, ...batchable, ...excluded, unbatchedCount: open.unbatchedCount || 0,
      oldestOpenAgeMs: open.oldestOpenAt ? Math.max(0, now - Date.parse(open.oldestOpenAt)) : 0,
      oldestBatchableAgeMs: batchable.oldestBatchableAt ? Math.max(0, now - Date.parse(batchable.oldestBatchableAt)) : 0,
      perDay, batchErrors, progress, selectedBacklog };
  } catch (error) { return { available: false, error: error.message, areas: null }; }
}

// Operator disposition only: preserve the source observation, queue identity
// and terminal timestamp. Never release an owner or consume retry/selected work.
export function retireExpiredFindings(db, { repo, reason, limit = 100, apply = false,
  now = Date.now(), maxAgeMs = findingBacklogMaxAgeMs() } = {}) {
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)
    || typeof reason !== 'string' || !reason.trim() || /[\r\n]/.test(reason) || reason.length > 1200
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || typeof apply !== 'boolean'
    || !Number.isFinite(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) {
    throw Error('invalid expired finding disposition');
  }
  const cutoff = new Date(now - maxAgeMs).toISOString();
  const disposition = `out-of-window: ${reason.trim()}`;
  const retire = db.transaction(() => {
    const findings = db.prepare(`SELECT b.finding_id FROM finding_backlog b
      JOIN reviewed_prs r USING(repo,pr_number)
      WHERE b.repo=? AND b.outcome IS NULL AND b.batch_id IS NULL
        AND b.batch_attempts=0 AND b.manifest_sha256 IS NULL AND r.pr_state='merged'
        AND (julianday(r.merged_at) IS NULL OR julianday(r.merged_at) < julianday(?))
      ORDER BY b.captured_at,b.finding_id LIMIT ?`).all(repo, cutoff, limit).map(row => row.finding_id);
    if (apply) db.prepare(`UPDATE finding_backlog SET outcome='dropped',reason=?
      WHERE finding_id IN (SELECT value FROM json_each(?))`).run(disposition, JSON.stringify(findings));
    return { applied: apply, findings, retired: apply ? findings.length : 0, reason: disposition, cutoff };
  });
  return apply ? retire.immediate() : retire();
}

export function findingBacklogAlert(backlog, maxAgeMs = 48 * 3600000) {
  if (!backlog?.available || !(backlog.oldestBatchableAgeMs > maxAgeMs || backlog.outOfWindow > 0)) return null;
  return {
    code: 'review:findings_backlog_overdue',
    tier: 'ticket',
    subject: 'Non-blocking findings backlog is overdue',
    message: `${backlog.batchableCount} batchable findings; ${backlog.outOfWindow || 0} unclaimed findings outside the merge-age window; oldest open finding is ${Math.floor(backlog.oldestOpenAgeMs / 3600000)} hours old`,
    evidence: [`oldestBatchableAt=${backlog.oldestBatchableAt}`, `outOfWindow=${backlog.outOfWindow || 0}`, `maxAgeMs=${maxAgeMs}`],
    recommendedAction: 'Inspect runner health, progress and batch errors; ended batches release automatically. The operator findings batch backfill can re-batch released findings regardless of source age. For never-claimed expired findings, preview review-findings retire-expired with an explicit DB, repo, limit and reason; operator-authorized --apply retains an out-of-window disposition. An explicit consensus-validated manifest can instead select verified real findings.',
    details: { ...backlog, maxAgeMs },
  };
}
