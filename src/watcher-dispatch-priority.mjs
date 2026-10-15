import { createRetainedWatcherWakes } from './watcher-retained-wakes.mjs';
import { reviewerDispatchEnqueuedAt, reviewerDispatchWaitPriority } from './watcher-reviewer-pool.mjs';

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

export function createWatcherDispatchPriority({ rootDir, db, nowMs = Date.now() }) {
  const retainedWatcherWakes = createRetainedWatcherWakes({ rootDir });
  const priorityDiscoveryPending = createWatcherPriorityDiscoveryPending({
    db, retainedSubjects: retainedWatcherWakes.subjects(), nowMs,
  });
  return { retainedWatcherWakes, priorityDiscoveryPending };
}
