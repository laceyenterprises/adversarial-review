import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import {
  buildMergeAgentDispatchJob,
  detectAgentOsPresence,
  dispatchMergeAgentForPR,
  fetchMergeAgentCandidate,
  listMergeAgentDispatches,
  pickMergeAgentDispatch,
  recordMergeAgentDispatch,
  resolveMergeAgentParentSession,
  resolveMergeAgentProject,
} from '../src/follow-up-merge-agent.mjs';

// Existing dispatchMergeAgentForPR tests assume agent-os (the hq CLI
// + merge-agent adapter) IS present on the host running the tests.
// CI runners and OSS clones do not have hq, so we inject a presence
// stub. New OSS-skip behavior is exercised by its own dedicated tests.
const AGENT_OS_PRESENT_STUB = () => ({ present: true, source: 'test' });

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
    operatorApproval: null,
    ...overrides,
  };
}

function makeOperatorApproval(overrides = {}) {
  return {
    actor: 'VirtualPaul',
    createdAt: '2026-05-06T18:05:00.000Z',
    labelEventId: 'evt-operator-approved',
    labelEventNodeId: 'LE_operator_approved',
    headSha: 'abc123',
    codeScopedAt: '2026-05-06T18:00:00.000Z',
    ...overrides,
  };
}

function makeMergeAgentRequest(overrides = {}) {
  return {
    actor: 'VirtualPaul',
    createdAt: '2026-05-07T12:05:00.000Z',
    labelEventId: 'evt-merge-agent-requested',
    labelEventNodeId: 'LE_merge_agent_requested',
    headSha: 'abc123',
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

test('pickMergeAgentDispatch surfaces closed PRs before missing verdict diagnostics', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      prState: 'closed',
      lastVerdict: null,
    })),
    'skip-pr-not-open'
  );
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

test('pickMergeAgentDispatch honors merge-agent-stuck as an operator skip label', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    labels: [{ name: 'merge-agent-stuck' }],
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

test('pickMergeAgentDispatch refuses dispatch while remediation is still active', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({ latestFollowUpJobStatus: 'pending' })),
    'skip-remediation-active'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({ latestFollowUpJobStatus: 'in-progress' })),
    'skip-remediation-active'
  );
});

test('pickMergeAgentDispatch refuses dispatch when more remediation rounds are claimable AND the verdict is request-changes', () => {
  // Rounds-available is a remediation-loop concern — it only matters when
  // the reviewer found things to address. A request-changes verdict with
  // budget left should wait for the remediation worker; racing it would
  // either fight that worker or merge a state the reviewer asked to
  // change.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      remediationCurrentRound: 0,
      remediationMaxRounds: 3,
    })),
    'skip-remediation-claimable'
  );
});

test('pickMergeAgentDispatch dispatches a clean comment-only verdict even with remediation rounds still claimable', () => {
  // Clean verdict = nothing to remediate = the pipeline reached its
  // natural end. Merge-agent should fire on round 1 instead of forcing
  // unnecessary review passes through to the round cap. This was the
  // gate that left PR #90 stuck waiting for unused remediation budget.
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Comment only',
    remediationCurrentRound: 1,
    remediationMaxRounds: 3,
  }));
  assert.equal(decision, 'dispatch');
});

test('pickMergeAgentDispatch surfaces active remediation before failed checks', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      latestFollowUpJobStatus: 'in-progress',
      checksConclusion: 'FAILURE',
    })),
    'skip-remediation-active'
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
    operatorApproval: makeOperatorApproval(),
  }));
  assert.equal(decision, 'dispatch');
});

test('operator-approved must be scoped to the current head SHA', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval({ headSha: 'old-sha' }),
    })),
    'skip-operator-approval-stale'
  );
});

test('operator-approved is honored even when label actor matches PR author (single-operator scale)', () => {
  // At single-operator scale every PR is authored by the operator's gh CLI
  // identity (workers push under the operator), so the previous
  // "actor must differ from prAuthor" rule made operator-approved a 100%
  // false-positive no-op. The label is now honored when the headSha and
  // commit-timing scope checks pass, regardless of actor identity.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      prAuthor: 'VirtualPaul',
      operatorApproval: makeOperatorApproval(),
    })),
    'dispatch'
  );
});

test('stale operator-approved label does not block a green normal dispatch', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Comment only',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval({ headSha: 'old-sha' }),
      mergeable: 'MERGEABLE',
      checksConclusion: 'SUCCESS',
      remediationCurrentRound: 1,
      remediationMaxRounds: 1,
    })),
    'dispatch'
  );
});

test('operator-approved fails closed when no attributed labeled event was fetched', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
    })),
    'skip-operator-approval-stale'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval({ actor: 'unknown' }),
    })),
    'skip-operator-approval-stale'
  );
});

test('operator-approved bypasses missing or unknown review verdicts for the current head', () => {
  // The operator override is the manual escape valve when review is
  // pending, missing, or otherwise not parseable yet. Git/CI safety
  // gates still run separately.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: null,
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval(),
    })),
    'dispatch'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Needs follow-up from author',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval(),
    })),
    'dispatch'
  );
});

test('operator-approved does NOT bypass not-mergeable', () => {
  // Force-merging a conflicting tree is ~always wrong. The override
  // says "I'm fine with the verdict", not "ignore git state."
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval(),
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
    operatorApproval: makeOperatorApproval(),
    checksConclusion: 'FAILURE',
  }));
  assert.equal(decision, 'skip-checks-failed');
});

test('operator-approved does NOT bypass pending CI checks', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval(),
    checksConclusion: 'PENDING',
  }));
  assert.equal(decision, 'skip-checks-pending');
});

test('operator-approved does NOT bypass unknown CI checks', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval(),
    checksConclusion: null,
  }));
  assert.equal(decision, 'skip-checks-unknown');
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

test('operator-approved is overridden by explicit skip labels (skip wins)', () => {
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
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }, { name: 'merge-agent-stuck' }],
    })),
    'skip-operator-skip'
  );
});

test('operator-approved bypasses claimable remediation rounds', () => {
  // The operator can explicitly decide to merge now rather than wait
  // for the bounded remediation loop to consume more rounds.
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval(),
    remediationCurrentRound: 0,
    remediationMaxRounds: 2,
  }));
  assert.equal(decision, 'dispatch');
});

test('operator-approved bypasses unknown remediation ledger state', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval(),
    remediationCurrentRound: 0,
    remediationMaxRounds: 0,
  }));
  assert.equal(decision, 'dispatch');
});

test('operator-approved bypasses active in-flight remediation', () => {
  // This is the explicit operator override for "merge this current
  // head now"; merge-agent/D5 still guard against head drift before
  // actually landing the PR.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval(),
      latestFollowUpJobStatus: 'in-progress',
    })),
    'dispatch'
  );
});

// ── merge-agent-requested operator dispatch (post-2026-05-07) ────────────

test('merge-agent-requested dispatches even when the branch is currently conflicting', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    labels: [{ name: 'merge-agent-requested' }],
    mergeAgentRequest: makeMergeAgentRequest(),
    mergeable: 'CONFLICTING',
  }));
  assert.equal(decision, 'dispatch');
});

test('merge-agent-requested bypasses current verdict and check gates so merge-agent can clean the branch', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      lastVerdict: 'Request changes',
      checksConclusion: 'FAILURE',
    })),
    'dispatch'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      lastVerdict: null,
      checksConclusion: 'PENDING',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    })),
    'dispatch'
  );
});

test('merge-agent-requested dispatches even when operator-approved is stale', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }, { name: 'merge-agent-requested' }],
      operatorApproval: makeOperatorApproval({ headSha: 'old-sha' }),
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'MERGEABLE',
      checksConclusion: 'SUCCESS',
    })),
    'dispatch'
  );
});

test('merge-agent-requested still respects hard stops and active remediation', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }, { name: 'do-not-merge' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
    })),
    'skip-operator-skip'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }, { name: 'merge-agent-stuck' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
    })),
    'skip-operator-skip'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
      latestFollowUpJobStatus: 'in-progress',
    })),
    'skip-remediation-active'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      prState: 'closed',
    })),
    'skip-pr-not-open'
  );
});

test('merge-agent-requested must be scoped to the current head SHA', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest({ headSha: 'old-sha' }),
      mergeable: 'CONFLICTING',
    })),
    'skip-merge-agent-requested-stale'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeable: 'CONFLICTING',
    })),
    'skip-merge-agent-requested-stale'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest({ actor: 'unknown' }),
      mergeable: 'CONFLICTING',
    })),
    'skip-merge-agent-requested-stale'
  );
});

test('merge-agent-requested must not predate the latest PR update', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest({ createdAt: '2026-05-07T12:04:00.000Z' }),
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
      mergeable: 'CONFLICTING',
    })),
    'skip-merge-agent-requested-stale'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest({
        createdAt: '2026-05-07T12:04:00.000Z',
        prUpdatedAt: '2026-05-07T12:05:00.000Z',
      }),
      mergeable: 'CONFLICTING',
    })),
    'skip-merge-agent-requested-stale'
  );
});

test('merge-agent-requested scoping compares parsed ISO timestamps', () => {
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest({ createdAt: '2026-05-07T12:05:00+00:00' }),
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
      mergeable: 'CONFLICTING',
    })),
    'dispatch'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest({ createdAt: 'not-a-date' }),
      prUpdatedAt: '2026-05-07T12:05:00.000Z',
      mergeable: 'CONFLICTING',
    })),
    'skip-merge-agent-requested-stale'
  );
});

test('merge-agent-requested uses durable repo/pr/sha idempotency', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, makeJob({ labels: [{ name: 'merge-agent-requested' }] }), {
    dispatchedAt: '2026-05-07T12:00:00.000Z',
    prompt: '# prompt\n',
    dispatchId: 'disp_requested',
  });
  const [recorded] = listMergeAgentDispatches(rootDir);
  const decision = pickMergeAgentDispatch(makeJob({
    labels: [{ name: 'merge-agent-requested' }],
    mergeAgentRequest: makeMergeAgentRequest(),
    mergeable: 'CONFLICTING',
  }), {
    recentDispatches: [recorded],
  });
  assert.equal(decision, 'skip-already-dispatched');
});

test('pickMergeAgentDispatch keeps state diagnostics ahead of idempotency skips', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, makeJob(), {
    dispatchedAt: '2026-05-07T12:00:00.000Z',
    prompt: '# prompt\n',
    dispatchId: 'disp_previous',
  });
  const [recorded] = listMergeAgentDispatches(rootDir);
  assert.equal(
    pickMergeAgentDispatch(makeJob({ checksConclusion: 'FAILURE' }), {
      recentDispatches: [recorded],
    }),
    'skip-checks-failed'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval({ headSha: 'old-sha' }),
    }), {
      recentDispatches: [recorded],
    }),
    'skip-operator-approval-stale'
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
    reviewBody: '## Summary\nx\n## Verdict\n\nComment only',
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
    prUpdatedAt: '2026-05-02T10:05:00.000Z',
    operatorApprovalEvent: {
      id: 'evt-build-approval',
      nodeId: 'LE_build_approval',
      actor: 'VirtualPaul',
      createdAt: '2026-05-02T10:05:00.000Z',
      headSha: 'abc123',
      codeScopedAt: '2026-05-02T10:04:00.000Z',
    },
  });

  assert.equal(dispatchJob.lastVerdict, 'Comment only');
  assert.equal(dispatchJob.latestFollowUpJobStatus, 'pending');
  assert.equal(dispatchJob.remediationCurrentRound, 0);
  // Spec-less jobs fall back to medium risk, which has a 2-round cap.
  assert.equal(dispatchJob.remediationMaxRounds, 2);
  assert.equal(dispatchJob.operatorApproval.actor, 'VirtualPaul');
  assert.equal(dispatchJob.operatorApproval.headSha, 'abc123');
  assert.equal(dispatchJob.operatorApproval.codeScopedAt, '2026-05-02T10:04:00.000Z');
});

test('operator-approved remains scoped when review posts update the PR after labeling', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    reviewerModel: 'codex',
    linearTicketId: null,
    reviewBody: '## Summary\nStill blocked.\n## Verdict\nRequest changes',
    reviewPostedAt: '2026-05-02T10:10:00.000Z',
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
    labels: [{ name: 'operator-approved' }],
    operatorNotes: null,
    prState: 'open',
    merged: false,
    prUpdatedAt: '2026-05-02T10:15:00.000Z',
    operatorApprovalEvent: {
      id: 'evt-pre-review-approval',
      nodeId: 'LE_pre_review_approval',
      actor: 'VirtualPaul',
      createdAt: '2026-05-02T10:05:00.000Z',
      headSha: 'abc123',
      codeScopedAt: '2026-05-02T10:04:00.000Z',
    },
  });

  assert.equal(dispatchJob.operatorApproval.actor, 'VirtualPaul');
  assert.equal(dispatchJob.operatorApproval.headSha, 'abc123');
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'dispatch');
});

test('operator-approved can dispatch when no follow-up job ledger exists', () => {
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
    operatorApprovalEvent: {
      id: 'evt-build-approval',
      nodeId: 'LE_build_approval',
      actor: 'VirtualPaul',
      createdAt: '2026-05-02T10:05:00.000Z',
      headSha: 'abc123',
      codeScopedAt: '2026-05-02T10:04:00.000Z',
    },
    operatorNotes: null,
    prState: 'open',
    merged: false,
    prUpdatedAt: '2026-05-02T10:04:00.000Z',
  });

  assert.equal(dispatchJob.lastVerdict, null);
  assert.equal(dispatchJob.remediationMaxRounds, 0);
  assert.equal(dispatchJob.operatorApproval.actor, 'VirtualPaul');
  assert.equal(dispatchJob.operatorApproval.headSha, 'abc123');
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'dispatch');
});

test('operator-approved without a valid label event stays fail-closed without a follow-up ledger', () => {
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
  assert.equal(dispatchJob.operatorApproval, null);
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'skip-operator-approval-stale');
});

test('merge-agent-requested can dispatch when no follow-up job ledger exists', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    branch: 'feature/pr-401',
    baseBranch: 'main',
    headSha: 'abc123',
    mergeable: 'CONFLICTING',
    checksConclusion: 'PENDING',
    labels: [{ name: 'merge-agent-requested' }],
    mergeAgentRequestEvent: {
      id: 'evt-build-request',
      nodeId: 'LE_build_request',
      actor: 'VirtualPaul',
      createdAt: '2026-05-02T10:05:00.000Z',
    },
    operatorNotes: null,
    prState: 'open',
    merged: false,
    prUpdatedAt: '2026-05-02T10:04:00.000Z',
  });

  assert.equal(dispatchJob.lastVerdict, null);
  assert.equal(dispatchJob.remediationMaxRounds, 0);
  assert.equal(dispatchJob.mergeAgentRequest.actor, 'VirtualPaul');
  assert.equal(dispatchJob.mergeAgentRequest.headSha, 'abc123');
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'dispatch');
});

test('buildMergeAgentDispatchJob drops stale merge-agent-requested events before dispatch selection', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    branch: 'feature/pr-401',
    baseBranch: 'main',
    headSha: 'abc123',
    mergeable: 'CONFLICTING',
    checksConclusion: 'PENDING',
    labels: [{ name: 'merge-agent-requested' }],
    mergeAgentRequestEvent: {
      id: 'evt-build-request',
      nodeId: 'LE_build_request',
      actor: 'VirtualPaul',
      createdAt: '2026-05-02T10:03:59.000Z',
    },
    operatorNotes: null,
    prState: 'open',
    merged: false,
    prUpdatedAt: '2026-05-02T10:04:00.000Z',
  });

  assert.equal(dispatchJob.mergeAgentRequest, null);
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'skip-merge-agent-requested-stale');
});

test('dispatchMergeAgentForPR records only successful launches and parses trailing JSON output', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob(),
    parentSession: 'session:test:merge-watcher',
    hqProject: 'merge-project',
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args });
      return {
        stdout: 'warning: dispatch queued\n{"dispatchId":"disp_123","lrq":"lrq_456"}\n',
      };
    },
    now: '2026-05-03T12:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.dispatchId, 'disp_123');
  assert.equal(result.launchRequestId, 'lrq_456');
  assert.equal(listMergeAgentDispatches(rootDir).length, 1);
  assert.equal(hqCalls[0].cmd, 'hq');
  assert.deepEqual(hqCalls[0].args.slice(0, 15), [
    'dispatch',
    '--worker-class', 'merge-agent',
    '--task-kind', 'merge',
    '--repo', 'agent-os',
    '--pr', '401',
    '--ticket', 'PR-401',
    '--parent-session', 'session:test:merge-watcher',
    '--project', 'merge-project',
  ]);
});

test('merge-agent dispatch attribution defaults are stable for launchd', () => {
  assert.equal(resolveMergeAgentParentSession({}), 'session:adversarial-review:watcher');
  assert.equal(
    resolveMergeAgentParentSession({ AGENT_SESSION_REF: 'session:test:agent' }),
    'session:test:agent'
  );
  assert.equal(
    resolveMergeAgentParentSession({ HQ_PARENT_SESSION: 'session:test:hq' }),
    'session:test:hq'
  );
  assert.equal(
    resolveMergeAgentParentSession({ MERGE_AGENT_PARENT_SESSION: 'session:test:merge' }),
    'session:test:merge'
  );
  assert.equal(resolveMergeAgentProject({}), 'pr-merge-orchestration');
  assert.equal(resolveMergeAgentProject({ HQ_PROJECT: 'from-env' }), 'from-env');
  assert.equal(
    resolveMergeAgentProject({ MERGE_AGENT_HQ_PROJECT: 'from-merge-env' }),
    'from-merge-env'
  );
});

test('dispatchMergeAgentForPR removes operator-approved after successful dispatch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const ghCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval(),
    }),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_approved","lrq":"lrq_approved"}\n',
    }),
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-03T12:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.trigger, 'operator-approved');
  assert.equal(result.operatorApprovalLabelRemoved, true);
  assert.deepEqual(ghCalls[0], {
    cmd: 'gh',
    args: [
      'pr',
      'edit',
      '401',
      '--repo',
      'laceyenterprises/agent-os',
      '--remove-label',
      'operator-approved',
    ],
  });
  assert.equal(listMergeAgentDispatches(rootDir)[0].operatorApproval.actor, 'VirtualPaul');
  assert.equal(listMergeAgentDispatches(rootDir)[0].trigger, 'operator-approved');
});

test('dispatchMergeAgentForPR removes merge-agent-requested after successful dispatch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const ghCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: null,
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
      checksConclusion: 'PENDING',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    }),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_requested","lrq":"lrq_requested"}\n',
    }),
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-07T12:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.trigger, 'merge-agent-requested');
  assert.equal(result.mergeAgentRequestedLabelRemoved, true);
  assert.deepEqual(ghCalls[0], {
    cmd: 'gh',
    args: [
      'pr',
      'edit',
      '401',
      '--repo',
      'laceyenterprises/agent-os',
      '--remove-label',
      'merge-agent-requested',
    ],
  });
});

test('dispatchMergeAgentForPR treats scoped merge-agent-requested as the trigger for an already-green PR', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const ghCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
    }),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_green_requested","lrq":"lrq_green_requested"}\n',
    }),
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-07T12:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.trigger, 'merge-agent-requested');
  assert.equal(result.mergeAgentRequestedLabelRemoved, true);
  assert.equal(ghCalls.length, 1);
  assert.equal(ghCalls[0].args.at(-1), 'merge-agent-requested');
});

test('dispatchMergeAgentForPR removes only the label that authorized dispatch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const ghCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }, { name: 'merge-agent-requested' }],
      operatorApproval: makeOperatorApproval(),
      mergeAgentRequest: makeMergeAgentRequest(),
    }),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_approved","lrq":"lrq_approved"}\n',
    }),
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-07T12:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.trigger, 'operator-approved');
  assert.equal(result.operatorApprovalLabelRemoved, true);
  assert.equal(result.mergeAgentRequestedLabelRemoved, false);
  assert.equal(ghCalls.length, 1);
  assert.equal(ghCalls[0].args.at(-1), 'operator-approved');
});

test('dispatchMergeAgentForPR logs consumed-label removal failures', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
      rootDir,
      ...makeJob({
        lastVerdict: null,
        labels: [{ name: 'merge-agent-requested' }],
        mergeAgentRequest: makeMergeAgentRequest(),
        mergeable: 'CONFLICTING',
        checksConclusion: 'PENDING',
        remediationCurrentRound: 0,
        remediationMaxRounds: 0,
      }),
      execFileImpl: async () => ({
        stdout: '{"dispatchId":"disp_requested","lrq":"lrq_requested"}\n',
      }),
      ghExecFileImpl: async () => {
        throw new Error('rate limited');
      },
      now: '2026-05-07T12:00:00.000Z',
    });

    assert.equal(result.decision, 'dispatch');
    assert.deepEqual(result.labelRemovalErrors, [
      { label: 'merge-agent-requested', error: 'rate limited' },
    ]);
    const [recorded] = listMergeAgentDispatches(rootDir);
    assert.equal(recorded.labelRemoval.label, 'merge-agent-requested');
    assert.equal(recorded.labelRemoval.removed, false);
    assert.equal(recorded.labelRemoval.lastError, 'rate limited');
    assert.match(warnings[0], /failed to remove consumed label 'merge-agent-requested'/);
  } finally {
    console.warn = originalWarn;
  }
});

test('dispatchMergeAgentForPR retries consumed-label removal for an already-dispatched SHA', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const first = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: null,
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
      checksConclusion: 'PENDING',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    }),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_requested","lrq":"lrq_requested"}\n',
    }),
    ghExecFileImpl: async () => {
      throw new Error('rate limited');
    },
    now: '2026-05-07T12:00:00.000Z',
  });
  assert.equal(first.decision, 'dispatch');

  const ghCalls = [];
  const second = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: null,
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
      checksConclusion: 'PENDING',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    }),
    execFileImpl: async () => {
      throw new Error('hq should not be called after idempotency hit');
    },
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-07T12:02:00.000Z',
  });

  assert.equal(second.decision, 'skip-already-dispatched');
  assert.equal(second.labelRemovalRetried, true);
  assert.equal(second.mergeAgentRequestedLabelRemoved, true);
  assert.equal(ghCalls.length, 1);
  assert.equal(ghCalls[0].args.at(-1), 'merge-agent-requested');
  const [recorded] = listMergeAgentDispatches(rootDir);
  assert.equal(recorded.labelRemoval.removed, true);
  assert.equal(recorded.labelRemoval.attempts.length, 2);
});

test('dispatchMergeAgentForPR reconciles externally removed consumed labels on idempotency retry', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: null,
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
      checksConclusion: 'PENDING',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    }),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_requested","lrq":"lrq_requested"}\n',
    }),
    ghExecFileImpl: async () => {
      throw new Error('rate limited');
    },
    now: '2026-05-07T12:00:00.000Z',
  });

  const second = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      labels: [],
    }),
    execFileImpl: async () => {
      throw new Error('hq should not be called after idempotency hit');
    },
    ghExecFileImpl: async () => {
      throw new Error('gh should not be called after external label removal');
    },
    now: '2026-05-07T12:02:00.000Z',
  });

  assert.equal(second.decision, 'skip-already-dispatched');
  assert.equal(second.labelRemovalRetried, false);
  const [recorded] = listMergeAgentDispatches(rootDir);
  assert.equal(recorded.labelRemoval.removed, true);
  assert.equal(recorded.labelRemoval.observedExternally, true);
  assert.equal(recorded.labelRemoval.attempts.length, 2);
  assert.equal(recorded.labelRemoval.attempts[1].observedExternally, true);
});

test('dispatchMergeAgentForPR uses HQ_BIN as the dispatch executable when PATH lacks hq', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];
  const env = { HQ_BIN: '/opt/agent-os/bin/hq', PATH: '/does-not-contain-hq' };
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: (options) => detectAgentOsPresence({
      ...options,
      fsImpl: {
        accessSync: (candidate) => {
          if (candidate !== '/opt/agent-os/bin/hq') {
            throw new Error(`unexpected executable probe: ${candidate}`);
          }
        },
      },
    }),
    env,
    rootDir,
    ...makeJob(),
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args });
      return { stdout: '{"dispatchId":"disp_hq_bin","lrq":"lrq_hq_bin"}\n' };
    },
    now: '2026-05-07T12:05:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.dispatchId, 'disp_hq_bin');
  assert.equal(hqCalls.length, 1);
  assert.equal(hqCalls[0].cmd, '/opt/agent-os/bin/hq');
});

test('dispatchMergeAgentForPR retries consumed-label cleanup even when agent-os is later disabled', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: null,
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
      checksConclusion: 'PENDING',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    }),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_requested","lrq":"lrq_requested"}\n',
    }),
    ghExecFileImpl: async () => {
      throw new Error('rate limited');
    },
    now: '2026-05-07T12:00:00.000Z',
  });

  const ghCalls = [];
  const second = await dispatchMergeAgentForPR({
    env: { ADV_REVIEW_MERGE_AGENT_DISABLED: '1' },
    rootDir,
    ...makeJob({
      lastVerdict: null,
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
      checksConclusion: 'PENDING',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    }),
    execFileImpl: async () => {
      throw new Error('hq should not be called after idempotency hit');
    },
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-07T12:02:00.000Z',
  });

  assert.equal(second.decision, 'skip-already-dispatched');
  assert.equal(second.labelRemovalRetried, true);
  assert.equal(second.mergeAgentRequestedLabelRemoved, true);
  assert.equal(ghCalls.length, 1);
  assert.equal(ghCalls[0].args.at(-1), 'merge-agent-requested');
});

test('fetchMergeAgentCandidate fetches operator label events in parallel', async () => {
  const eventResolvers = [];
  let eventFetchesStarted = 0;
  const candidatePromise = fetchMergeAgentCandidate('laceyenterprises/agent-os', 401, {
    execFileImpl: async (_cmd, args) => {
      if (args[0] === 'pr') {
        return {
          stdout: JSON.stringify({
            mergeable: 'MERGEABLE',
            headRefName: 'feature/pr-401',
            baseRefName: 'main',
            headRefOid: 'abc123',
            body: '',
            labels: [{ name: 'operator-approved' }, { name: 'merge-agent-requested' }],
            statusCheckRollup: [],
            state: 'OPEN',
            updatedAt: '2026-05-07T12:00:00.000Z',
            author: { login: 'builder-bot' },
          }),
        };
      }
      eventFetchesStarted += 1;
      return new Promise((resolve) => {
        eventResolvers.push(resolve);
      });
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventFetchesStarted, 2);
  for (const resolve of eventResolvers) {
    resolve({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefOid: 'abc123',
              timelineItems: {
                nodes: [
                  {
                    __typename: 'PullRequestCommit',
                    id: 'commit-event',
                    commit: {
                      oid: 'abc123',
                      committedDate: '2026-05-07T12:00:30.000Z',
                    },
                  },
                  {
                    __typename: 'LabeledEvent',
                    id: 'LE_operator_approved',
                    label: { name: 'operator-approved' },
                    actor: { login: 'VirtualPaul' },
                    createdAt: '2026-05-07T12:01:00.000Z',
                  },
                  {
                    __typename: 'LabeledEvent',
                    id: 'LE_merge_agent_requested',
                    label: { name: 'merge-agent-requested' },
                    actor: { login: 'VirtualPaul' },
                    createdAt: '2026-05-07T12:02:00.000Z',
                  },
                ],
              },
            },
          },
        },
      }),
    });
  }

  const candidate = await candidatePromise;
  assert.equal(candidate.operatorApprovalEvent.label, 'operator-approved');
  assert.equal(candidate.mergeAgentRequestEvent.label, 'merge-agent-requested');
});

test('dispatchMergeAgentForPR does not mutate the caller job fields while recording trigger', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const input = makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval(),
  });
  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...input,
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_approved","lrq":"lrq_approved"}\n',
    }),
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    now: '2026-05-07T12:00:00.000Z',
  });

  assert.equal(input.mergeAgentTrigger, undefined);
  assert.equal(listMergeAgentDispatches(rootDir)[0].trigger, 'operator-approved');
});

test('dispatchMergeAgentForPR leaves no durable dispatch record when hq launch fails', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  await assert.rejects(
    dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
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
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
      rootDir,
      ...makeJob(),
      execFileImpl: async () => ({ stdout: 'queued successfully' }),
      now: '2026-05-03T12:00:00.000Z',
    }),
    /machine-readable JSON/
  );

  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
});

// ── OSS guard: skip merge-agent dispatch when agent-os is not present ─────
// adversarial-review is being open-sourced. Watcher, reviewer, remediation,
// and verdict pipeline work standalone — only the auto-merge step depends
// on the agent-os worker-pool. When agent-os is absent (OSS install, fresh
// clone, CI sandbox), the dispatch path must SKIP rather than crash on
// ENOENT from `hq`. Auto-merge becomes a manual operator step in OSS
// mode.

test('dispatchMergeAgentForPR returns skip-no-agent-os when the detector reports agent-os absent', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  let dispatchCalls = 0;
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: () => ({ present: false, source: 'not-found' }),
    rootDir,
    ...makeJob(),
    execFileImpl: async () => {
      dispatchCalls += 1;
      return { stdout: '{"dispatchId":"never","lrq":"never"}\n' };
    },
    now: '2026-05-03T12:00:00.000Z',
  });

  assert.equal(result.decision, 'skip-no-agent-os');
  assert.equal(result.agentOsDetectionSource, 'not-found');
  assert.equal(dispatchCalls, 0, 'hq must not be invoked when agent-os is absent');
  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
});

test('dispatchMergeAgentForPR honors ADV_REVIEW_MERGE_AGENT_DISABLED=1 even when hq is on PATH', async () => {
  // Operator-driven force-skip. Lets a maintainer turn auto-merge off on
  // a machine that DOES have agent-os installed (e.g., during a release
  // freeze) without touching the source.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  let dispatchCalls = 0;
  const result = await dispatchMergeAgentForPR({
    env: { ADV_REVIEW_MERGE_AGENT_DISABLED: '1' },
    rootDir,
    ...makeJob(),
    execFileImpl: async () => {
      dispatchCalls += 1;
      return { stdout: '{}\n' };
    },
    now: '2026-05-03T12:00:00.000Z',
  });

  assert.equal(result.decision, 'skip-no-agent-os');
  assert.equal(result.agentOsDetectionSource, 'operator-disabled');
  assert.equal(dispatchCalls, 0);
});

test('detectAgentOsPresence: operator-disabled env var wins over everything else', () => {
  const state = detectAgentOsPresence({
    env: { ADV_REVIEW_MERGE_AGENT_DISABLED: '1', HQ_BIN: '/usr/local/bin/hq' },
    fsImpl: { existsSync: () => true },
  });
  assert.deepEqual(state, { present: false, source: 'operator-disabled' });
});

test('detectAgentOsPresence: operator-enabled env var bypasses PATH/HQ_BIN detection', () => {
  const state = detectAgentOsPresence({
    env: { ADV_REVIEW_MERGE_AGENT_AGENT_OS: '1' },
    fsImpl: {
      accessSync: () => { throw new Error('PATH should not be probed'); },
    },
  });
  assert.deepEqual(state, { present: true, source: 'operator-enabled' });
});

test('detectAgentOsPresence: HQ_BIN pointing to an existing file is detected as present', () => {
  const state = detectAgentOsPresence({
    env: { HQ_BIN: '/usr/local/bin/hq' },
    fsImpl: {
      accessSync: (p) => {
        if (p !== '/usr/local/bin/hq') throw new Error('not found');
      },
    },
  });
  assert.deepEqual(state, { present: true, source: 'env:HQ_BIN', path: '/usr/local/bin/hq' });
});

test('detectAgentOsPresence: PATH-resolved hq path is detected as present without external which', () => {
  const state = detectAgentOsPresence({
    env: { PATH: '/bin:/Users/airlock/.local/bin' },
    fsImpl: {
      accessSync: (p) => {
        if (p !== '/Users/airlock/.local/bin/hq') throw new Error('not found');
      },
    },
  });
  assert.deepEqual(state, { present: true, source: 'path', path: '/Users/airlock/.local/bin/hq' });
});

test('detectAgentOsPresence: PATH miss returns not-found', () => {
  // OSS install: hq is not on PATH. The detector must not bubble that
  // up as an exception — it is the canonical signal for "agent-os absent."
  const state = detectAgentOsPresence({
    env: { PATH: '/bin:/usr/bin' },
    fsImpl: {
      accessSync: () => {
        throw new Error('not found');
      },
    },
  });
  assert.deepEqual(state, { present: false, source: 'not-found' });
});

test('detectAgentOsPresence: non-executable resolved path returns not-found', () => {
  // Defensive: PATH can point at a directory whose hq binary is missing
  // or not executable. accessSync is the authoritative check.
  const state = detectAgentOsPresence({
    env: { PATH: '/usr/local/bin' },
    fsImpl: {
      accessSync: () => {
        throw new Error('not executable');
      },
    },
  });
  assert.deepEqual(state, { present: false, source: 'not-found' });
});
