import { isOperatorHeld, operatorHeldSql } from './operator-hold-labels.mjs';

const identity = row => `${row.repo}#${row.pr_number}`;
// Claim bookkeeping must not itself rearm a refused row. A new head, request,
// status, label observation or failure disposition is a meaningful state edge.
const stateColumns = [
  'pr_state', 'review_status', 'revision_ref', 'reviewer_head_sha',
  'reviewer', 'labels_json', 'rereview_requested_at', 'rereview_reason', 'failure_message',
];
const state = row => JSON.stringify(stateColumns.map(column => row?.[column] ?? null));
const isPending = row => row?.pr_state === 'open' && ['pending', 'pending-upstream'].includes(row.review_status);

export function createDurableReviewerRefill({ db, createCandidate, scope = () => null, readPrimaryDomainId = () => 'code-pr', limit = 50 }) {
  // Include admitted attempts that rearm pending after an obsolete-head result.
  // Reusing their discovery cache cannot discover a new head; the poll remains
  // the backstop for that state edge rather than spinning another review.
  const settled = new Map();
  let cursor = 0;
  const readRow = db.prepare('SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?');
  const readRows = db.prepare(`WITH settled AS (SELECT key, value FROM json_each(?))
    SELECT * FROM reviewed_prs
    WHERE pr_state = 'open' AND review_status IN ('pending', 'pending-upstream')
      AND (rereview_requested_at IS NOT NULL OR posted_at IS NULL)
      AND NOT ${operatorHeldSql()} AND id > ?
      AND revision_ref IS NOT NULL AND revision_ref <> ''
      AND reviewer IS NOT NULL AND reviewer <> ''
      AND (? IS NULL OR COALESCE(domain_id, ?) || ':' || repo IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM settled
        WHERE settled.key = repo || '#' || pr_number
          AND settled.value = json_array(${stateColumns.join(', ')}))
    ORDER BY id LIMIT ?`);
  return {
    onSettled(candidate) {
      const row = readRow.get(candidate.repoPath, candidate.prNumber);
      const key = `${candidate.repoPath}#${candidate.prNumber}`;
      if (!isPending(row)) {
        settled.delete(key);
      } else if (!candidate.subject?.headSha || row.revision_ref === candidate.subject.headSha) {
        settled.set(key, state(row));
      }
    },
    refill(queued) {
      // Closed/deleted/completed rows no longer reach candidate settlement.
      // Drop their snapshots before serializing the exclusion list for SQLite.
      for (const key of settled.keys()) {
        const separator = key.lastIndexOf('#');
        if (!isPending(readRow.get(key.slice(0, separator), Number(key.slice(separator + 1))))) {
          settled.delete(key);
        }
      }
      const snapshots = JSON.stringify(Object.fromEntries(settled));
      const keys = scope();
      const allowed = keys === null ? null : JSON.stringify(keys);
      const primaryDomainId = readPrimaryDomainId();
      let rows = readRows.all(snapshots, cursor, allowed, primaryDomainId, allowed, limit);
      if (!rows.length && cursor) rows = readRows.all(snapshots, 0, allowed, primaryDomainId, allowed, limit);
      cursor = rows.at(-1)?.id || 0;
      const present = new Set(queued.map(candidate => `${candidate.repoPath}#${candidate.prNumber}`));
      return rows.flatMap(row => {
        const key = identity(row);
        if (present.has(key) || settled.get(key) === state(row)) return [];
        settled.delete(key);
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
    current: row,
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
      prepared.markReviewerSpawned = () => this.markReviewerSpawned?.();
      const release = this.admissionReleaseCapacity;
      if (release) prepared.admissionReleaseCapacity = (...args) => {
        // The tracker observes the outer refill candidate at capacity release.
        this.durablePostedAt = prepared.durablePostedAt;
        return release(...args);
      };
      try {
        return await prepared.run();
      } finally {
        this.durablePostedAt = prepared.durablePostedAt;
      }
    },
  };
}


export function attachDurableReviewerRefill({ db, contexts, admission, processSubject, readScope }) {
  const refill = createDurableReviewerRefill({
    db,
    // Watcher scope is initialized after attachment; read it only on refill.
    readPrimaryDomainId: () => readScope().primaryDomainId,
    scope: () => {
      const { repos, domains } = readScope();
      return [...contexts.keys()].filter(key => {
        const separator = key.indexOf(':');
        return repos.includes(key.slice(separator + 1)) && domains.includes(key.slice(0, separator));
      });
    },
    createCandidate(row) {
      const registration = contexts.get(`${row.domain_id || readScope().primaryDomainId}:${row.repo}`);
      return registration ? createDurableReviewerCandidate(row, {
        ...registration, processSubject, enqueue: admission.enqueue,
      }) : null;
    },
  });
  admission.setRefill(refill.refill, refill.onSettled);
}
