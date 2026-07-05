import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { maybeDaemonMergeCleanReview } from '../src/ama/daemon-merge.mjs';
import { inspectMergeLease } from '../src/ama/merge-lease.mjs';

const HEAD = 'abc12345abc12345abc12345abc12345abc12345';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'ama-daemon-merge-'));
}

function greenCheck() {
  return { __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' };
}

function baseArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    repo: 'owner/name',
    prNumber: 42,
    cfg: { enabled: true },
    reviewState: {
      verdict: 'settled-success',
      headSha: HEAD,
      blockingFindingCount: 0,
      nonBlockingFindingCount: 0,
    },
    prMetadata: {
      prNumber: 42,
      headSha: HEAD,
      baseBranch: 'main',
      isOpen: true,
      mergeableState: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [greenCheck()],
    },
    fetchHeadAndStateImpl: async () => ({ state: 'OPEN', headRefOid: HEAD }),
    retryDelaysMs: [1, 1],
    random: () => 0,
    logger: { log() {}, warn() {} },
    ...overrides,
  };
}

test('fully clean eligible review merges inline, writes daemon audit, and does not run local CI', async () => {
  const rootDir = freshRoot();
  const execCalls = [];
  try {
    const result = await maybeDaemonMergeCleanReview(baseArgs(rootDir, {
      execFileImpl: async (file, args) => {
        execCalls.push([file, args]);
        return { stdout: '' };
      },
    }));

    assert.equal(result.handled, true);
    assert.equal(result.merged, true);
    assert.equal(result.attempts, 1);
    assert.deepEqual(execCalls, [[
      'gh',
      ['pr', 'merge', '42', '--repo', 'owner/name', '--squash', '--match-head-commit', HEAD],
    ]]);
    const audit = readAmaAuditEntry(rootDir, 'owner/name', 42, HEAD);
    assert.equal(audit.authority, 'daemon-merge');
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.attempts.length, 1);
    assert.equal(audit.attempts[0].authority, 'daemon-merge');
    assert.equal(inspectMergeLease({ rootDir, repo: 'owner/name', base: 'main' }).exists, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('transient gh pr merge failure retries under the lease and writes one daemon audit', async () => {
  const rootDir = freshRoot();
  let mergeCalls = 0;
  let headReads = 0;
  try {
    const result = await maybeDaemonMergeCleanReview(baseArgs(rootDir, {
      execFileImpl: async () => {
        mergeCalls += 1;
        if (mergeCalls === 1) {
          const err = new Error('HTTP 502 gateway');
          err.stderr = 'HTTP 502 gateway';
          throw err;
        }
        return { stdout: '' };
      },
      fetchHeadAndStateImpl: async () => {
        headReads += 1;
        return { state: 'OPEN', headRefOid: HEAD };
      },
    }));

    assert.equal(result.merged, true);
    assert.equal(result.attempts, 2);
    assert.equal(mergeCalls, 2);
    assert.equal(headReads, 2);
    const audit = readAmaAuditEntry(rootDir, 'owner/name', 42, HEAD);
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.attempts.length, 1);
    assert.equal(audit.attempts[0].mergeAttempts, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('permanent merge failure fails closed without retry and releases lease', async () => {
  const rootDir = freshRoot();
  let mergeCalls = 0;
  try {
    const result = await maybeDaemonMergeCleanReview(baseArgs(rootDir, {
      execFileImpl: async () => {
        mergeCalls += 1;
        const err = new Error('branch protection rule failed');
        err.stderr = 'branch protection rule failed: required status check failed';
        throw err;
      },
    }));

    assert.equal(result.merged, false);
    assert.equal(result.reason, 'permanent-merge-failure');
    assert.equal(mergeCalls, 1);
    assert.equal(inspectMergeLease({ rootDir, repo: 'owner/name', base: 'main' }).exists, false);
    const audit = readAmaAuditEntry(rootDir, 'owner/name', 42, HEAD);
    assert.equal(audit.status, 'failed-without-merge');
    assert.equal(audit.attempts[0].reason, 'permanent-merge-failure');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('strict mode refuses any blocking or non-blocking finding so watcher can route to hammer', async () => {
  const rootDir = freshRoot();
  try {
    const blocking = await maybeDaemonMergeCleanReview(baseArgs(rootDir, {
      reviewState: {
        verdict: 'settled-success',
        headSha: HEAD,
        blockingFindingCount: 1,
        nonBlockingFindingCount: 0,
      },
    }));
    const nonBlocking = await maybeDaemonMergeCleanReview(baseArgs(rootDir, {
      reviewState: {
        verdict: 'settled-success',
        headSha: HEAD,
        blockingFindingCount: 0,
        nonBlockingFindingCount: 1,
      },
    }));

    assert.equal(blocking.handled, false);
    assert.equal(blocking.reason, 'findings-present');
    assert.equal(nonBlocking.handled, false);
    assert.equal(nonBlocking.reason, 'findings-present');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('lease contention defers cleanly without merging', async () => {
  const rootDir = freshRoot();
  let mergeCalls = 0;
  try {
    const result = await maybeDaemonMergeCleanReview(baseArgs(rootDir, {
      acquireMergeLeaseImpl: () => ({ acquired: false, existingLease: { leaseId: 'held' } }),
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '' };
      },
    }));

    assert.equal(result.handled, true);
    assert.equal(result.merged, false);
    assert.equal(result.reason, 'merge-lease-contended');
    assert.equal(mergeCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('ineligible clean review surfaces reasons and does not merge', async () => {
  const rootDir = freshRoot();
  let mergeCalls = 0;
  try {
    const result = await maybeDaemonMergeCleanReview(baseArgs(rootDir, {
      prMetadata: {
        prNumber: 42,
        headSha: HEAD,
        baseBranch: 'main',
        isOpen: true,
        mergeableState: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }],
      },
      execFileImpl: async () => {
        mergeCalls += 1;
        return { stdout: '' };
      },
    }));

    assert.equal(result.handled, true);
    assert.equal(result.merged, false);
    assert.equal(result.reason, 'not-eligible');
    assert.deepEqual(result.reasons, ['ci-not-green']);
    assert.equal(mergeCalls, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
