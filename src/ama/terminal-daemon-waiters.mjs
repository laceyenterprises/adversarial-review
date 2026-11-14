import { classifyTerminalTransition } from '../pr-terminal-reconcile.mjs';
import { readDaemonMergeLeaseWaiters, removeMergeLeaseWaiter } from './merge-lease.mjs';

// This is local queue maintenance, not merge authority. In particular, neither
// service PID liveness nor absence from open-PR discovery proves termination.
export async function reconcileTerminalDaemonWaiters({ rootDir, fetchLiveState, logger = console }) {
  const snapshots = readDaemonMergeLeaseWaiters({ rootDir });
  const liveByPr = new Map();
  let removed = 0;
  for (const waiter of snapshots) {
    try {
      const key = `${waiter.repo}#${waiter.pr}`;
      if (!liveByPr.has(key)) {
        liveByPr.set(key, await fetchLiveState(waiter.repo, waiter.pr));
      }
      const live = liveByPr.get(key);
      if (!classifyTerminalTransition(live) || live.headRefOid !== waiter.head
        || live.baseRefName !== waiter.base) continue;
      const result = removeMergeLeaseWaiter({
        rootDir, repo: waiter.repo, base: waiter.base, waiterId: waiter.waiterId,
        expectedWaiter: waiter,
      });
      if (result.removed) removed += 1;
    } catch (error) {
      // Preserve unreadable or contended requests and retry independently of
      // the lifecycle mirror, including after it has become terminal.
      logger.warn?.(`[watcher] terminal daemon waiter unverified ${waiter.repo}#${waiter.pr}: ${error.message}`);
    }
  }
  return { checked: snapshots.length, removed };
}
