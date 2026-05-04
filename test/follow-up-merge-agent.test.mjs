import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  pickMergeAgentDispatch,
  recordMergeAgentDispatch,
} from '../src/follow-up-merge-agent.mjs';

function makeJob(overrides = {}) {
  return {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    branch: 'feature/pr-401',
    baseBranch: 'main',
    headSha: 'abc123',
    lastVerdict: 'Comment only',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    ...overrides,
  };
}

test('pickMergeAgentDispatch returns dispatch for mergeable green comment-only PRs', () => {
  const decision = pickMergeAgentDispatch(makeJob(), {
    now: '2026-05-03T12:00:00.000Z',
    recentDispatches: [],
  });
  assert.equal(decision, 'dispatch');
});

test('pickMergeAgentDispatch blocks Request changes verdicts', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
  }));
  assert.equal(decision, 'skip-request-changes');
});

test('pickMergeAgentDispatch honors merge-agent-skip label', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    labels: [{ name: 'merge-agent-skip' }],
  }));
  assert.equal(decision, 'skip-operator-skip');
});

test('pickMergeAgentDispatch honors merge-agent-stuck label', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    labels: [{ name: 'merge-agent-stuck' }],
  }));
  assert.equal(decision, 'skip-operator-skip');
});

test('pickMergeAgentDispatch enforces the recent-dispatch idempotency window', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, makeJob(), {
    dispatchedAt: '2026-05-03T12:00:00.000Z',
    prompt: '# prompt\n',
    dispatchId: 'disp_123',
  });
  const decision = pickMergeAgentDispatch(makeJob(), {
    now: '2026-05-03T12:05:00.000Z',
    recentDispatches: [
      {
        repo: 'laceyenterprises/agent-os',
        prNumber: 401,
        headSha: 'abc123',
        dispatchedAt: '2026-05-03T12:00:00.000Z',
      },
    ],
    windowMinutes: 10,
  });
  assert.equal(decision, 'skip-already-dispatched');
});
