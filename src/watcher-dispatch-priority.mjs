import { createRetainedWatcherWakes } from './watcher-retained-wakes.mjs';
import { reviewerDispatchEnqueuedAt, reviewerDispatchIsFirstPass, reviewerDispatchWaitPriority } from './watcher-reviewer-pool.mjs';

// Own the one-wave discovery admission guard here so the scheduler only wires
// its candidate queue and drain; priority and lane guards stay together.
export function createWatcherDiscoveryBatchDrain({
  priorityDiscoveryPending, reviewerDispatchCandidates, batchSize,
  countOpenPrsAwaitingFirstPassReview, drain,
}) {
  let used = false;
  return async (reason) => {
    if (used || priorityDiscoveryPending.size > 0 || reviewerDispatchCandidates.length < batchSize
        // A timeout retry cannot consume a partial discovery wave before later
        // first-pass/re-review subjects enter the existing priority ordering.
        || reviewerDispatchCandidates.some(candidate => candidate.sameHeadTimeoutRetry === true)) {
      return { dispatched: 0, maxObservedConcurrency: 0, deferred: 0 };
    }
    if (reviewerDispatchCandidates.every((candidate) => !reviewerDispatchIsFirstPass(candidate))
        && countOpenPrsAwaitingFirstPassReview() > 0) {
      return { dispatched: 0, maxObservedConcurrency: 0, deferred: 0 };
    }
    used = true;
    return drain(reason);
  };
}

// A partial discovery batch must not spend the only seat before priority work
// from a later subject or repository has had a chance to enter the queue.
export function createWatcherPriorityDiscoveryPending({ db, retainedSubjects, nowMs = Date.now() }) {
  const pending = new Set(retainedSubjects.map(({ repoPath, prNumber }) => `${repoPath}#${prNumber}`));
  for (const row of db.prepare(`SELECT repo, pr_number, head_wait_started_at,
    rereview_requested_at, reviewed_at FROM reviewed_prs
    WHERE review_status IN ('pending', 'pending-upstream', 'failed')
      AND COALESCE(pr_state, 'open') NOT IN ('merged', 'closed')`).all()) {
    if (reviewerDispatchWaitPriority({ enqueuedAt: reviewerDispatchEnqueuedAt(row) }, { nowMs }) !== null) {
      pending.add(`${row.repo}#${row.pr_number}`);
    }
  }
  return pending;
}

// This barrier protects only work that can still enter this tick's queue.
// Missing discovery is not evidence for deleting a durable retained wake.
export function reconcileWatcherPriorityDiscoveryPending(pending, { repoPath, discoveredPrNumbers }) {
  const prefix = `${repoPath}#`;
  for (const identity of pending) {
    if (identity.startsWith(prefix) && !discoveredPrNumbers.has(Number(identity.slice(prefix.length)))) {
      pending.delete(identity);
    }
  }
}

export function createWatcherDispatchPriority({ rootDir, db, nowMs = Date.now() }) {
  const retainedWatcherWakes = createRetainedWatcherWakes({ rootDir });
  const priorityDiscoveryPending = createWatcherPriorityDiscoveryPending({
    db, retainedSubjects: retainedWatcherWakes.subjects(), nowMs,
  });
  return { retainedWatcherWakes, priorityDiscoveryPending };
}
