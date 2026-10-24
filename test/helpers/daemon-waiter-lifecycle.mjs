import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { handlePostedReviewRow } from '../../src/posted-review-row.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../../src/ama-closure-orchestration.mjs';
import {
  acquireDaemonMergeLease, acquireMergeLease, inspectMergeLease,
  mergeLeaseFilePath, readMergeLeaseWaiters, releaseMergeLease,
  withDaemonMergeReservation,
} from '../../src/ama/merge-lease.mjs';

// All state and collaborators are disposable/offline. The same live PID owns
// both passes; only the first pass actually attempts a daemon acquire.
export async function exerciseDaemonWaiterLifecycle(rootDir, change, { keepHolder = false, sibling = false } = {}) {
  const lane = { rootDir, repo: 'fixture/repo', base: 'main' };
  const leaseArgs = { ...lane, holderPid: process.pid, holderHost: hostname(),
    pidAliveFn: () => true, now: '2026-10-23T19:16:08Z' };
  const holder = acquireMergeLease({ ...leaseArgs, holderPr: 1, holderHead: 'holder' });
  assert.equal(holder.acquired, true);
  const heldBytes = readFileSync(mergeLeaseFilePath(rootDir, lane), 'utf8');
  const candidate = { prState: 'open', merged: false, baseBranch: 'main', headSha: 'old-head' };
  const row = { review_status: 'posted', reviewer_head_sha: 'old-head' };
  let acquires = 0;
  let held = false;
  const errors = [];
  const args = {
    rootDir, repoPath: lane.repo, prNumber: 2, existing: row, currentRevisionRef: 'old-head',
    projectGateStatusSafe: async () => ({ decision: held
      ? { state: 'pending', reason: 'operator-skip-label' } : { state: 'success' } }),
    fetchMergeAgentCandidateImpl: async () => candidate,
    currentReviewRowReader: () => row,
    latestFollowUpJobFinder: () => null, latestPostedReviewBodyFinder: () => null,
    reviewBodyHasScopeViolationFindingImpl: () => false,
    buildMergeAgentDispatchJobImpl: () => ({}),
    resolveMergeAgentCoexistenceForWatcherImpl: async () => {
      acquires++;
      const result = acquireDaemonMergeLease({ ...leaseArgs, holderPr: 2, holderHead: 'old-head' });
      assert.equal(result.acquired, false);
      return { outcome: 'ama-pending', amaClosureResult: { reason: 'daemon-deferred',
        daemonCleanMerge: { reason: 'lease-contended', waitMessage: 'waiting for the merge lease, position 1' } } };
    },
    logger: { log() {}, warn() {}, error(message) { errors.push(message); } },
  };
  const firstPass = handlePostedReviewRow(args);
  assert.equal((await handlePostedReviewRow(args)).outcome, 'posted-review-in-flight',
    'the PR guard is acquired before the first yielding read');
  assert.equal((await firstPass).outcome, 'ama-pending');
  const reservation = readMergeLeaseWaiters(rootDir, lane)[0];
  assert.equal(reservation.waiterId, 'daemon_2_old-head');
  // A repeated eligible pass keeps exactly the same FIFO reservation.
  await handlePostedReviewRow(args);
  assert.deepEqual(readMergeLeaseWaiters(rootDir, lane), [reservation]);
  const closer = { ...leaseArgs, holderPr: 3, holderHead: 'next-closer',
    registerWaiter: true, waiterId: 'next-closer' };
  assert.equal(acquireMergeLease(closer).acquired, false);
  // Include an ordinary waiter for the held PR too: cleanup owns only daemon
  // reservations, never another acquire just because its PR happens to match.
  acquireMergeLease({ ...closer, holderPr: 2, waiterId: 'same-pr-closer' });
  if (sibling) acquireDaemonMergeLease({ ...leaseArgs, holderPr: 4, holderHead: 'other-daemon' });
  const survivors = readMergeLeaseWaiters(rootDir, lane).filter(w => w.waiterId !== reservation.waiterId);
  if (!keepHolder) {
    assert.equal(releaseMergeLease({ ...lane, ...holder.lease, now: leaseArgs.now,
      requestWatcherWakeImpl: () => {} }).released, true);
    assert.equal(inspectMergeLease({ ...leaseArgs }).lease, null);
    assert.equal(acquireMergeLease(closer).acquired, false, 'abandoned front waiter blocks an empty lane');
  }
  // No service exit, timeout or PID death authorizes this cleanup.
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  const deadline = change.startsWith('deadline');
  held = change !== 'head' && change !== 'terminal' && !deadline;
  if (change === 'hold-base-ref' || change === 'hold-base-branch') {
    row[change === 'hold-base-ref' ? 'base_ref' : 'baseBranch'] = 'main';
    delete candidate.baseBranch;
  }
  const resolveWithoutClosure = options => resolveMergeAgentCoexistenceForWatcher({
    ...options,
    maybeDispatchAmaClosureForImpl: () => assert.fail('early coexistence exit must not dispatch closure'),
  });
  if (change === 'head') {
    candidate.headSha = 'new-head';
    args.resolveMergeAgentCoexistenceForWatcherImpl = async () => {
      assert.deepEqual(readMergeLeaseWaiters(rootDir, lane), survivors, 'old head removed before closure gates');
      return { outcome: 'ama-pending', amaClosureResult: { reason: 'head-moved' } };
    };
  }
  if (change === 'terminal' || change === 'deadline-terminal') {
    candidate.prState = 'merged'; candidate.merged = true;
  }
  if (change === 'deadline-closed') candidate.prState = 'closed';
  if (change === 'deadline-stacked') candidate.stackedBaseHold = { reason: 'stacked-base-not-ready' };
  if (change === 'terminal') args.resolveMergeAgentCoexistenceForWatcherImpl = resolveWithoutClosure;
  let result;
  if (deadline) {
    const previous = process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
    process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = '10';
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    let settled;
    const settlement = new Promise(resolve => { settled = resolve; });
    args.resolveMergeAgentCoexistenceForWatcherImpl = options => {
      const attempt = async () => {
        try {
          await pending;
          if (change === 'deadline-error') throw new Error('coexistence failed before closure');
          if (['deadline-terminal', 'deadline-closed', 'deadline-stacked'].includes(change)) {
            return await resolveWithoutClosure(options);
          }
          if (change === 'deadline-contended') return { outcome: 'ama-pending',
            amaClosureResult: { reason: 'daemon-deferred', daemonCleanMerge: { reason: 'lease-contended' } } };
          return { outcome: 'ama-pending', amaClosureResult: { reason: 'not-eligible' } };
        } finally { settled(); }
      };
      // Only the original fixture enters closure's inner reservation scope.
      // The other cases must be owned by the concrete coexistence operation.
      return change === 'deadline'
        ? withDaemonMergeReservation({ ...lane, pr: 2, head: 'old-head' }, attempt)
        : attempt();
    };
    try {
      result = await handlePostedReviewRow(args);
      assert.equal(result?.outcome, 'coexistence-deadline');
      assert.deepEqual(readMergeLeaseWaiters(rootDir, lane).filter(w => w.priority === 'daemon'), [reservation],
        'concrete in-flight closure keeps its reservation across the soft deadline');
      for (const head of ['old-head', 'new-head']) {
        const next = await handlePostedReviewRow({ ...args, currentRevisionRef: head,
          projectGateStatusSafe: () => assert.fail('a competing poll must not enter the handler'),
          fetchMergeAgentCandidateImpl: () => assert.fail('a competing poll must not fetch a candidate'),
        });
        assert.equal(next.outcome, 'posted-review-in-flight');
        assert.deepEqual(readMergeLeaseWaiters(rootDir, lane), [reservation, ...survivors],
          'same-PR polls at either head cannot prune the active reservation');
      }
      // A different PR still progresses while this one is detached.
      const unrelated = await handlePostedReviewRow({ ...args, prNumber: 99,
        currentReviewRowReader: () => null,
      });
      assert.equal(unrelated.outcome, 'stale-posted-review-snapshot');
    } finally {
      finish();
      // No test-owned catch or await on the inner promise: production owns
      // rejection handling. Let cleanup and any unhandled rejection run.
      await settlement;
      await new Promise(resolve => setImmediate(resolve));
      if (previous === undefined) delete process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS;
      else process.env.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS = previous;
    }
    if (change === 'deadline-error') {
      assert.ok(errors.some(message => message.includes('failed in background after deadline')
        && message.includes('coexistence failed before closure')));
    }
  } else result = await handlePostedReviewRow(args);
  if (change === 'terminal') assert.equal(result.prTerminal, true, 'unheld candidate reaches terminal coexistence guard');
  if (change === 'deadline-contended') {
    assert.deepEqual(readMergeLeaseWaiters(rootDir, lane), [reservation, ...survivors],
      'eventual eligible contention retains the exact FIFO reservation');
    candidate.prState = 'closed';
    args.resolveMergeAgentCoexistenceForWatcherImpl = resolveWithoutClosure;
    assert.equal((await handlePostedReviewRow(args)).prTerminal, true);
  }
  if (deadline) {
    held = true;
    candidate.prState = 'open'; candidate.merged = false;
    assert.equal((await handlePostedReviewRow(args)).outcome, 'operator-skip-label',
      'settlement releases the per-PR guard for the next poll');
  }
  assert.equal(acquires, 2, 'hold bypasses the next daemon attempt entirely');
  assert.ok(['operator-skip-label', 'ama-pending', 'coexistence-deadline'].includes(result?.outcome) || result?.prTerminal === true);
  assert.deepEqual(readMergeLeaseWaiters(rootDir, lane), survivors, 'all other FIFO waiters preserved exactly');
  if (keepHolder) {
    assert.equal(readFileSync(mergeLeaseFilePath(rootDir, lane), 'utf8'), heldBytes, 'holder fence unchanged');
    assert.equal(releaseMergeLease({ ...lane, ...holder.lease, leaseId: 'wrong-fence' }).released, false);
    assert.equal(releaseMergeLease({ ...lane, ...holder.lease, now: leaseArgs.now,
      requestWatcherWakeImpl: () => {} }).released, true);
  }
  if (sibling) {
    assert.equal(acquireMergeLease(closer).acquired, false, 'surviving daemon retains priority');
    const other = acquireDaemonMergeLease({ ...leaseArgs, holderPr: 4, holderHead: 'other-daemon' });
    assert.equal(other.acquired, true);
    assert.equal(releaseMergeLease({ ...lane, ...other.lease, now: leaseArgs.now }).released, true);
  }
  const next = acquireMergeLease(closer);
  assert.equal(next.acquired, true, 'following closer acquires without expiry or bypass');
  assert.equal(next.lease.holderPr, 3);
  assert.equal(releaseMergeLease({ ...lane, ...next.lease, now: leaseArgs.now }).released, true);
}
