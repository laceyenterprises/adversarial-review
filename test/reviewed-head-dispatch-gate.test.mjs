/* REVIEW-DEDUP — reviewed-head dispatch dedup gate.
 *
 * Covers the authoritative commit_id predicate, the (pr, head) idempotency
 * lease, and the duplicate-skip audit line. The GitHub reviews reader is stubbed
 * so these stay pure/offline; the live `commit_id` filter itself is covered by
 * test/github-api.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDuplicateReviewSkipAudit,
  createHeadDispatchLease,
  headDispatchLeaseKey,
  resolveAlreadyReviewedHeadDedup,
  selectExistingReviewIdForHead,
} from '../src/reviewed-head-dispatch-gate.mjs';

const HEAD = '316e2513d0000000000000000000000000000000';

test('headDispatchLeaseKey composes (repo, pr, head)', () => {
  assert.equal(
    headDispatchLeaseKey({ repoPath: 'org/agent-os', prNumber: 3655, headSha: HEAD }),
    `org/agent-os#3655@${HEAD}`,
  );
});

test('lease admits one holder per (pr, head) and re-admits after release', () => {
  const lease = createHeadDispatchLease();
  const key = headDispatchLeaseKey({ repoPath: 'org/agent-os', prNumber: 3655, headSha: HEAD });

  assert.equal(lease.tryAcquire(key), true, 'first worker acquires');
  assert.equal(lease.tryAcquire(key), false, 'second concurrent worker is turned away');
  assert.equal(lease.has(key), true);
  assert.equal(lease.size, 1);

  lease.release(key);
  assert.equal(lease.has(key), false);
  assert.equal(lease.tryAcquire(key), true, 'a later window can re-acquire');
});

test('lease isolates distinct heads of the same PR', () => {
  const lease = createHeadDispatchLease();
  const keyA = headDispatchLeaseKey({ repoPath: 'org/agent-os', prNumber: 10, headSha: 'aaaa1111' });
  const keyB = headDispatchLeaseKey({ repoPath: 'org/agent-os', prNumber: 10, headSha: 'bbbb2222' });
  assert.equal(lease.tryAcquire(keyA), true);
  assert.equal(lease.tryAcquire(keyB), true, 'a different head is not blocked by the first');
});

test('lease never blocks a key with no head SHA (cannot dedup)', () => {
  const lease = createHeadDispatchLease();
  const key = headDispatchLeaseKey({ repoPath: 'org/agent-os', prNumber: 10, headSha: '' });
  assert.equal(lease.tryAcquire(key), true);
  assert.equal(lease.tryAcquire(key), true, 'headless keys fall through to existing behavior');
  assert.equal(lease.has(key), false);
});

test('selectExistingReviewIdForHead returns newest review id or null', () => {
  assert.equal(selectExistingReviewIdForHead([]), null);
  assert.equal(selectExistingReviewIdForHead([{ id: '99', commitId: HEAD }]), '99');
  // Non-empty but id-less still counts as reviewed upstream; we just can't name it.
  assert.equal(selectExistingReviewIdForHead([{ commitId: HEAD }]), null);
});

test('dedup: an existing completed review on the head is already-reviewed', async () => {
  const result = await resolveAlreadyReviewedHeadDedup({
    repoPath: 'org/agent-os',
    prNumber: 3655,
    headSha: HEAD,
    reviewerLogins: ['lacey-gemini-reviewer'],
    fetchReviewsForHeadImpl: async () => [
      { id: '4242', commitId: HEAD, state: 'CHANGES_REQUESTED', submittedAt: '2026-07-13T00:24:00Z' },
    ],
  });
  assert.deepEqual(result, { alreadyReviewed: true, reviewId: '4242', reason: 'commit-id-match' });
});

test('dedup: no review on the head permits dispatch', async () => {
  const result = await resolveAlreadyReviewedHeadDedup({
    repoPath: 'org/agent-os',
    prNumber: 3655,
    headSha: HEAD,
    reviewerLogins: ['lacey-gemini-reviewer'],
    fetchReviewsForHeadImpl: async () => [],
  });
  assert.deepEqual(result, { alreadyReviewed: false, reviewId: null, reason: null });
});

test('dedup: missing head SHA fails open (no probe)', async () => {
  let called = false;
  const result = await resolveAlreadyReviewedHeadDedup({
    repoPath: 'org/agent-os',
    prNumber: 3655,
    headSha: null,
    fetchReviewsForHeadImpl: async () => { called = true; return []; },
  });
  assert.equal(result.alreadyReviewed, false);
  assert.equal(result.reason, 'missing-head-sha');
  assert.equal(called, false, 'no GitHub call when there is no head to dedup');
});

test('dedup: a GitHub probe error fails open so dispatch is never wedged', async () => {
  const logs = [];
  const result = await resolveAlreadyReviewedHeadDedup({
    repoPath: 'org/agent-os',
    prNumber: 3655,
    headSha: HEAD,
    reviewerLogins: ['lacey-gemini-reviewer'],
    fetchReviewsForHeadImpl: async () => { throw new Error('gh 502'); },
    logger: { warn: (m) => logs.push(m) },
  });
  assert.equal(result.alreadyReviewed, false);
  assert.equal(result.reason, 'probe-error');
  assert.match(logs.join('\n'), /fail-open/);
});

test('two pool workers racing the same (pr, head) produce exactly one dispatch', async () => {
  // Models the guard at the top of the watcher's dispatchCandidate.run(): a
  // shared lease + the reviewed-head gate. Two workers, one head, one review.
  const lease = createHeadDispatchLease();
  const key = headDispatchLeaseKey({ repoPath: 'org/agent-os', prNumber: 3655, headSha: HEAD });
  let dispatches = 0;

  async function worker() {
    if (!lease.tryAcquire(key)) return; // turned away — no dispatch
    try {
      const dedup = await resolveAlreadyReviewedHeadDedup({
        repoPath: 'org/agent-os',
        prNumber: 3655,
        headSha: HEAD,
        reviewerLogins: ['lacey-gemini-reviewer'],
        fetchReviewsForHeadImpl: async () => [], // no prior review yet
      });
      if (dedup.alreadyReviewed) return;
      dispatches += 1; // would claim + spawn the reviewer here
    } finally {
      lease.release(key);
    }
  }

  // Both workers start synchronously; the first acquires the lease before its
  // first await, so the second is turned away the moment it runs tryAcquire.
  const first = worker();
  const second = worker();
  await Promise.all([first, second]);
  assert.equal(dispatches, 1, 'the second concurrent worker on the same head does not dispatch');
});

test('duplicate-skip audit carries pr, sha, and existing review id', () => {
  const line = buildDuplicateReviewSkipAudit({
    repoPath: 'org/agent-os',
    prNumber: 3655,
    headSha: HEAD,
    reviewId: '4242',
  });
  assert.match(line, /org\/agent-os#3655/);
  assert.match(line, /316e2513d000/);
  assert.match(line, /review id=4242/);
  assert.match(line, /not consuming the re-review ceiling/);
});
