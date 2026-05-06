import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import {
  buildMergeAgentDispatchJob,
  dispatchMergeAgentForPR,
  listMergeAgentDispatches,
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
    prState: 'open',
    merged: false,
    latestFollowUpJobStatus: 'completed',
    remediationCurrentRound: 1,
    remediationMaxRounds: 1,
    ...overrides,
  };
}

test('pickMergeAgentDispatch returns dispatch for green open PRs after remediation budget is exhausted', () => {
  const decision = pickMergeAgentDispatch(makeJob(), {
    recentDispatches: [],
  });
  assert.equal(decision, 'dispatch');
});

test('pickMergeAgentDispatch blocks markdown-decorated Request changes verdicts', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: '**Request changes** - operator review required.',
  }));
  assert.equal(decision, 'skip-request-changes');
});

test('pickMergeAgentDispatch fails closed on missing verdicts', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: null,
  }));
  assert.equal(decision, 'skip-no-verdict');
});

test('pickMergeAgentDispatch fails closed on unrecognized verdicts', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Needs follow-up from author',
  }));
  assert.equal(decision, 'skip-unknown-verdict');
});

test('pickMergeAgentDispatch honors do-not-merge label', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    labels: [{ name: 'do-not-merge' }],
  }));
  assert.equal(decision, 'skip-operator-skip');
});

test('pickMergeAgentDispatch blocks failed checks distinctly from pending checks', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({ checksConclusion: 'FAILURE' })),
    'skip-checks-failed'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({ checksConclusion: 'PENDING' })),
    'skip-checks-pending'
  );
});

test('pickMergeAgentDispatch skips closed or merged PRs', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({ prState: 'closed' })),
    'skip-pr-not-open'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({ merged: true })),
    'skip-pr-not-open'
  );
});

test('pickMergeAgentDispatch refuses dispatch while remediation is still active or claimable', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({ latestFollowUpJobStatus: 'pending' })),
    'skip-remediation-active'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({ latestFollowUpJobStatus: 'in-progress' })),
    'skip-remediation-active'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({ remediationCurrentRound: 0, remediationMaxRounds: 1 })),
    'skip-remediation-claimable'
  );
});

// ── operator-approved override (post-2026-05-06) ────────────────────────

test('pickMergeAgentDispatch dispatches a Request-changes PR when the operator-approved label is present', () => {
  // Mobile-friendly operator override: the operator reviewed the
  // request-changes findings on their phone, decided the substance is
  // fine, and added the `operator-approved` label. The merge-agent
  // should now fire even though the verdict is unchanged.
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
  }));
  assert.equal(decision, 'dispatch');
});

test('operator-approved does NOT bypass missing or unknown verdicts', () => {
  // The override only applies to a parseable Request changes verdict.
  // Missing or unrecognized verdicts mean the merge gate cannot tell
  // what the reviewer said, so the system fails closed.
  assert.equal(
    pickMergeAgentDispatch(makeJob({ lastVerdict: null, labels: [{ name: 'operator-approved' }] })),
    'skip-no-verdict'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({ lastVerdict: 'Needs follow-up from author', labels: [{ name: 'operator-approved' }] })),
    'skip-unknown-verdict'
  );
});

test('operator-approved does NOT bypass not-mergeable', () => {
  // Force-merging a conflicting tree is ~always wrong. The override
  // says "I'm fine with the verdict", not "ignore git state."
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    mergeable: 'CONFLICTING',
  }));
  assert.equal(decision, 'skip-not-mergeable');
});

test('operator-approved does NOT bypass failed CI checks', () => {
  // CI is a hard gate. An operator override of the reviewer verdict
  // does not authorize merging on top of failing tests.
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    checksConclusion: 'FAILURE',
  }));
  assert.equal(decision, 'skip-checks-failed');
});

test('operator-approved does NOT bypass pending CI checks', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    checksConclusion: 'PENDING',
  }));
  assert.equal(decision, 'skip-checks-pending');
});

test('operator-approved does NOT bypass closed/merged PRs', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      prState: 'closed',
    })),
    'skip-pr-not-open'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      merged: true,
    })),
    'skip-pr-not-open'
  );
});

test('operator-approved is overridden by an explicit do-not-merge / merge-agent-skip label (skip wins)', () => {
  // If both signals are present, the more conservative one wins.
  // Could happen if operator approved, then changed their mind and
  // added a stop signal but forgot to remove the approval.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }, { name: 'do-not-merge' }],
    })),
    'skip-operator-skip'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }, { name: 'merge-agent-skip' }],
    })),
    'skip-operator-skip'
  );
});

test('operator-approved does NOT bypass claimable remediation rounds', () => {
  // currentRound < maxRounds normally means "more remediation
  // possible — do not merge yet". The override only applies after
  // the durable ledger says no remediation rounds remain.
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    remediationCurrentRound: 0,
    remediationMaxRounds: 2,
  }));
  assert.equal(decision, 'skip-remediation-claimable');
});

test('operator-approved does NOT bypass unknown remediation ledger state', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    remediationCurrentRound: 0,
    remediationMaxRounds: 0,
  }));
  assert.equal(decision, 'skip-remediation-state-unknown');
});

test('operator-approved does NOT bypass active in-flight remediation (let the worker finish first)', () => {
  // Dispatching merge-agent while a remediation worker is actively
  // pushing would race. Make the operator wait one tick — the next
  // watcher pass after remediation completes will fire merge-agent.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      latestFollowUpJobStatus: 'in-progress',
    })),
    'skip-remediation-active'
  );
});

test('pickMergeAgentDispatch uses durable repo/pr/sha idempotency instead of a time window', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, makeJob(), {
    dispatchedAt: '2026-05-03T12:00:00.000Z',
    prompt: '# prompt\n',
    dispatchId: 'disp_123',
  });
  const [recorded] = listMergeAgentDispatches(rootDir);
  const decision = pickMergeAgentDispatch(makeJob(), {
    recentDispatches: [recorded],
  });
  assert.equal(decision, 'skip-already-dispatched');
});

test('buildMergeAgentDispatchJob carries verdict and remediation state from the latest follow-up job', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    reviewerModel: 'codex',
    linearTicketId: null,
    reviewBody: '## Summary\nx\n## Verdict\nComment only',
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
  });

  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    branch: 'feature/pr-401',
    baseBranch: 'main',
    headSha: 'abc123',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });

  assert.equal(dispatchJob.lastVerdict, 'Comment only');
  assert.equal(dispatchJob.latestFollowUpJobStatus, 'pending');
  assert.equal(dispatchJob.remediationCurrentRound, 0);
  // Spec-less jobs fall back to medium risk, which has a 2-round cap.
  assert.equal(dispatchJob.remediationMaxRounds, 2);
});

test('operator-approved cannot dispatch when no follow-up job ledger exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    branch: 'feature/pr-401',
    baseBranch: 'main',
    headSha: 'abc123',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [{ name: 'operator-approved' }],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });

  assert.equal(dispatchJob.lastVerdict, null);
  assert.equal(dispatchJob.remediationMaxRounds, 0);
  assert.equal(
    pickMergeAgentDispatch(dispatchJob),
    'skip-no-verdict',
    'operator-approved must not widen the gate when there is no parseable verdict ledger'
  );
});

test('dispatchMergeAgentForPR records only successful launches and parses trailing JSON output', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const result = await dispatchMergeAgentForPR({
    rootDir,
    ...makeJob(),
    execFileImpl: async () => ({
      stdout: 'warning: dispatch queued\n{"dispatchId":"disp_123","lrq":"lrq_456"}\n',
    }),
    now: '2026-05-03T12:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.dispatchId, 'disp_123');
  assert.equal(result.launchRequestId, 'lrq_456');
  assert.equal(listMergeAgentDispatches(rootDir).length, 1);
});

test('dispatchMergeAgentForPR leaves no durable dispatch record when hq launch fails', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  await assert.rejects(
    dispatchMergeAgentForPR({
      rootDir,
      ...makeJob(),
      execFileImpl: async () => {
        throw new Error('hq unavailable');
      },
      now: '2026-05-03T12:00:00.000Z',
    }),
    /hq unavailable/
  );

  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
  const promptDir = path.join(rootDir, 'data', 'follow-up-jobs', 'merge-agent-prompts');
  assert.equal(existsSync(promptDir), true, 'prompt artifact should still be written for debugging');
});

test('dispatchMergeAgentForPR treats non-JSON hq stdout as a hard failure', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  await assert.rejects(
    dispatchMergeAgentForPR({
      rootDir,
      ...makeJob(),
      execFileImpl: async () => ({ stdout: 'queued successfully' }),
      now: '2026-05-03T12:00:00.000Z',
    }),
    /machine-readable JSON/
  );

  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
});
