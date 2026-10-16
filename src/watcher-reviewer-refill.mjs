import { isOperatorHeld, operatorHeldSql } from './operator-hold-labels.mjs';

const identity = row => `${row.repo}#${row.pr_number}`;
// Claim bookkeeping must not itself rearm a refused row. A new head, request,
// status, label observation or failure disposition is a meaningful state edge.
const state = row => JSON.stringify([
  row?.pr_state, row?.review_status, row?.revision_ref, row?.reviewer_head_sha,
  row?.reviewer, row?.labels_json, row?.rereview_requested_at,
  row?.rereview_reason, row?.failure_message,
]);

export function createDurableReviewerRefill({ db, createCandidate, limit = 50 }) {
  const refused = new Map();
  let cursor = 0;
  const readRow = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?');
  const readRows = db.prepare(`SELECT * FROM reviewed_prs
    WHERE pr_state = 'open' AND review_status IN ('pending', 'pending-upstream')
      AND (rereview_requested_at IS NOT NULL OR posted_at IS NULL)
      AND NOT ${operatorHeldSql()} AND id > ?
    ORDER BY id LIMIT ?`);
  return {
    onRefused(candidate) {
      const row = readRow.get(candidate.repoPath, candidate.prNumber);
      if (row && (!candidate.subject?.headSha || row.revision_ref === candidate.subject.headSha)) {
        refused.set(identity(row), state(row));
      }
    },
    refill(queued) {
      let rows = readRows.all(cursor, limit);
      if (!rows.length && cursor) rows = readRows.all(0, limit);
      cursor = rows.at(-1)?.id || 0;
      const present = new Set(queued.map(candidate => `${candidate.repoPath}#${candidate.prNumber}`));
      return rows.flatMap(row => {
        const key = identity(row);
        if (present.has(key) || refused.get(key) === state(row)) return [];
        refused.delete(key);
        const candidate = createCandidate(row);
        return candidate ? [candidate] : [];
      });
    },
  };
}

// Reuse discovery's full policy and spawn-boundary guards, but only after the
// bounded queue has reserved the durable row's route. No API work in refill.
export function createDurableReviewerCandidate(row, { subjectAdapter, context, processSubject, enqueue }) {
  if (!row.revision_ref || !row.reviewer) return null;
  return {
    repoPath: row.repo, prNumber: row.pr_number, reviewerModel: row.reviewer,
    reviewerRuntimeAdapter: context.domainReviewerRuntimeAdapter,
    pipelineGeminiSeats: context.pipelineGeminiSeats,
    supportsAdmissionSplit: context.supportsAdmissionSplit,
    subject: { headSha: row.revision_ref },
    hasPriorPostedReview: context.hasPriorPostedReview(row),
    pendingSince: row.head_wait_started_at || row.rereview_requested_at || row.reviewed_at,
    async run() {
      const subject = await subjectAdapter.fetchState({
        domainId: row.domain_id || context.domainId,
        subjectExternalId: row.subject_external_id || `${row.repo}#${row.pr_number}`,
        revisionRef: row.revision_ref,
      });
      if (subject.terminal || subject.headSha !== row.revision_ref || subject.labelsKnown === false || isOperatorHeld(subject.labels)) {
        return { dispatched: false, reason: 'durable-refill-subject-changed' };
      }
      let prepared;
      await processSubject({ subject, prNumber: row.pr_number }, {
        ...context, enqueueReviewerDispatchCandidate: candidate => { prepared = candidate; },
      });
      if (!prepared) return { dispatched: false, reason: 'durable-refill-ineligible' };
      if (prepared.reviewerModel !== this.reviewerModel) {
        // Discovery changed the route. Let the pool reserve that route before
        // running it; the old reservation cannot authorize another credential.
        enqueue(prepared);
        return { dispatched: false, reason: 'durable-refill-route-changed' };
      }
      prepared.markAdmissionStarted = () => this.markAdmissionStarted?.();
      prepared.admissionReleaseCapacity = this.admissionReleaseCapacity;
      return prepared.run();
    },
  };
}
