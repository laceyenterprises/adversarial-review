import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordAmaRetain,
  AMA_RETAIN_LOOP_CAP,
} from '../src/ama-retain-loop-cap.mjs';
import { resolveMergeAgentCoexistenceForWatcher } from '../src/watcher.mjs';

// Fix C (#5053): the `not-eligible` no-dispatch retain is bounded. After
// AMA_RETAIN_LOOP_CAP consecutive retains on the SAME head, the watcher stops
// returning `ama-pending` (which it would re-poll forever) and routes to
// AWAIT_OPERATOR_ACTION. A NEW head resets the counter.

const HEAD_A = 'head-a-000000000000000000000000000000000';
const HEAD_B = 'head-b-111111111111111111111111111111111';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'ama-retain-cap-'));
}

test('recordAmaRetain: caps after K on the same head; a new head resets', () => {
  const rootDir = tempRoot();
  try {
    const id = { repo: 'acme/repo', prNumber: 5053 };
    const cap = AMA_RETAIN_LOOP_CAP; // 3
    const seen = [];
    for (let i = 0; i < cap + 1; i += 1) {
      seen.push(recordAmaRetain(rootDir, id, { headSha: HEAD_A }));
    }
    // Retains 1..K: not capped. Retain K+1: capped.
    for (let i = 0; i < cap; i += 1) {
      assert.equal(seen[i].retainCount, i + 1);
      assert.equal(seen[i].capExceeded, false, `retain ${i + 1} must not be capped`);
    }
    assert.equal(seen[cap].retainCount, cap + 1);
    assert.equal(seen[cap].capExceeded, true, 'the (K+1)th retain on the same head escalates');

    // A NEW head resets the series.
    const fresh = recordAmaRetain(rootDir, id, { headSha: HEAD_B });
    assert.equal(fresh.retainCount, 1);
    assert.equal(fresh.capExceeded, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('recordAmaRetain: explicit cap option overrides the default retain threshold', () => {
  const rootDir = tempRoot();
  try {
    const id = { repo: 'acme/repo', prNumber: 5054 };
    const first = recordAmaRetain(rootDir, id, { headSha: HEAD_A, cap: 1 });
    const second = recordAmaRetain(rootDir, id, { headSha: HEAD_A, cap: 1 });

    assert.equal(first.cap, 1);
    assert.equal(first.retainCount, 1);
    assert.equal(first.capExceeded, false);
    assert.equal(second.cap, 1);
    assert.equal(second.retainCount, 2);
    assert.equal(second.capExceeded, true, 'the explicit cap controls escalation');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function coexistenceArgs(rootDir, headSha, amaResult) {
  return {
    rootDir,
    reviewStateRow: { repo: 'acme/repo', pr_number: 5053, pr_state: 'open' },
    dispatchJob: { headSha },
    candidate: { headSha, prState: 'open', merged: false },
    labelNames: [],
    operatorApprovalEvent: null,
    mergeAgentRequestEvent: null,
    adversarialMergeRequestedEvent: null,
    repoPath: 'acme/repo',
    prNumber: 5053,
    currentRevisionRef: headSha,
    logger: { warn() {}, log() {}, info() {} },
    maybeDispatchAmaClosureForImpl: async () => amaResult,
  };
}

const NOT_ELIGIBLE_RETAIN = {
  dispatched: false,
  skipMergeAgent: true,
  reason: 'not-eligible',
  reasons: ['stale-review-head'],
  amaEnabled: true,
};

test('coexistence: bounded not-eligible retains escalate to await-operator; a new head resets', async () => {
  const rootDir = tempRoot();
  try {
    // Retains 1..K on HEAD_A stay ama-pending.
    for (let i = 0; i < AMA_RETAIN_LOOP_CAP; i += 1) {
      const res = await resolveMergeAgentCoexistenceForWatcher(
        coexistenceArgs(rootDir, HEAD_A, NOT_ELIGIBLE_RETAIN),
      );
      assert.equal(res.outcome, 'ama-pending', `retain ${i + 1} should still be ama-pending`);
    }
    // The (K+1)th retain on HEAD_A escalates.
    const escalated = await resolveMergeAgentCoexistenceForWatcher(
      coexistenceArgs(rootDir, HEAD_A, NOT_ELIGIBLE_RETAIN),
    );
    assert.equal(escalated.outcome, 'await-operator');
    assert.equal(escalated.coexistence.action, 'await-operator-action');
    assert.equal(escalated.retainLoopCap.retainCount, AMA_RETAIN_LOOP_CAP + 1);

    // A NEW head resets → back to ama-pending.
    const reset = await resolveMergeAgentCoexistenceForWatcher(
      coexistenceArgs(rootDir, HEAD_B, NOT_ELIGIBLE_RETAIN),
    );
    assert.equal(reset.outcome, 'ama-pending');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('coexistence: a NON-not-eligible skipMergeAgent reason never escalates (only the spin shape is capped)', async () => {
  const rootDir = tempRoot();
  try {
    const daemonMerged = {
      dispatched: false,
      skipMergeAgent: true,
      reason: 'daemon-merged',
      amaEnabled: true,
    };
    for (let i = 0; i < AMA_RETAIN_LOOP_CAP + 3; i += 1) {
      const res = await resolveMergeAgentCoexistenceForWatcher(
        coexistenceArgs(rootDir, HEAD_A, daemonMerged),
      );
      assert.equal(res.outcome, 'ama-pending', 'daemon-merged is terminal-ish and never counts toward the cap');
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
