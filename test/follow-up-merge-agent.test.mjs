import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  claimNextFollowUpJob,
  createFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  FINAL_PASS_ON_REQUEST_CHANGES_ENV,
  HQ_DISPATCH_TIMEOUT_MS,
  HQ_WORKER_TEAR_DOWN_TIMEOUT_MS,
  NO_MERGE_HOLD_LABEL,
  TERMINAL_WORKER_RUN_STATUSES,
  buildMergeAgentDispatchJob,
  buildMergeAgentPrompt,
  detectAgentOsPresence,
  dispatchMergeAgentForPR,
  fetchMergeAgentCandidate,
  isFinalPassOnRequestChangesEnabled,
  listMergeAgentDispatches,
  listMergeAgentLifecycleCleanups,
  listMergeAgentSkippedDispatches,
  lookupOriginalWorkerRunStatus,
  MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  pickMergeAgentDispatch,
  pickMergeAgentDispatchDetail,
  prepareOriginalWorkerForMergeAgent,
  recordMergeAgentDispatch,
  resolveMergeAgentParentSession,
  resolveMergeAgentProject,
  resolveSessionLedgerDbPath,
  summarizeChecksConclusion,
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
    blockingFindingCount: 0,
    blockingFindingState: 'known',
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

async function dispatchWithTrackedHqCalls(overrides = {}) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob(overrides),
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args: [...args] });
      return {
        stdout: `{"dispatchId":"disp_${hqCalls.length}","lrq":"lrq_${hqCalls.length}"}\n`,
      };
    },
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    now: '2026-05-26T12:00:00.000Z',
  });
  return { rootDir, hqCalls, result };
}

test('pickMergeAgentDispatch returns dispatch for green open PRs after remediation budget is exhausted', () => {
  const decision = pickMergeAgentDispatch(makeJob(), {
    recentDispatches: [],
  });
  assert.equal(decision, 'dispatch');
});

test('pickMergeAgentDispatch normalizes markdown-decorated Request changes verdicts (default ON dispatches with final-pass trigger)', () => {
  // Verdict normalization must still strip markdown decoration. Under
  // the default-ON flag the normalized verdict feeds the final-pass
  // path; the legacy explicit-disable path keeps surfacing
  // `skip-request-changes`.
  const detailWithFlag = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: '**Request changes** - operator review required.',
  }));
  assert.equal(detailWithFlag.decision, 'dispatch');
  assert.equal(detailWithFlag.trigger, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER);

  const detailWithoutFlag = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: '**Request changes** - operator review required.',
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: false,
  });
  assert.equal(detailWithoutFlag.decision, 'skip-request-changes');
});

test('pickMergeAgentDispatchDetail skips Request changes when final-pass flag is explicitly disabled', () => {
  // After 2026-05-16, the default for finalPassOnRequestChangesEnabled is
  // ON — leaving the legacy halt behavior reachable only by explicit
  // opt-out (env=0). This test pins the explicit-disable path.
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: false,
  });
  assert.equal(detail.decision, 'skip-request-changes');
  assert.equal(detail.trigger, null);
});

test('pickMergeAgentDispatchDetail dispatches with final-pass trigger when budget exhausted, verdict is Request changes, and flag is on', () => {
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    // Default job has remediationCurrentRound:1, remediationMaxRounds:1
    // (budget exhausted).
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'dispatch');
  assert.equal(detail.trigger, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER);
});

test('ROOT-CAUSE GATE: final-pass does NOT merge when the final review has standing blocking findings', () => {
  // The #901 regression: budget exhausted + Request changes + the reviewer's
  // `## Blocking issues` section still has items. Auto-merge here shipped two
  // blocking production bugs. The gate hands off instead of dispatching a
  // merge-agent.
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    blockingFindingCount: 2,
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'skip-blockers-present');
  assert.equal(detail.trigger, null);
});

test('ARP-06: current-head Comment only verdict launches exactly one merge-agent dispatch', async () => {
  const { rootDir, hqCalls, result } = await dispatchWithTrackedHqCalls({
    headSha: 'current-comment-only',
    lastVerdict: 'Comment only',
    remediationCurrentRound: 1,
    remediationMaxRounds: 2,
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(hqCalls.filter(call => call.args[0] === 'dispatch').length, 1);
  assert.equal(listMergeAgentDispatches(rootDir).length, 1);
  assert.equal(listMergeAgentDispatches(rootDir)[0].headSha, 'current-comment-only');
});

test('ARP-06: current-head Approved verdict launches exactly one merge-agent dispatch', async () => {
  const { rootDir, hqCalls, result } = await dispatchWithTrackedHqCalls({
    headSha: 'current-approved',
    lastVerdict: 'Approved',
    remediationCurrentRound: 1,
    remediationMaxRounds: 2,
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(hqCalls.filter(call => call.args[0] === 'dispatch').length, 1);
  assert.equal(listMergeAgentDispatches(rootDir).length, 1);
  assert.equal(listMergeAgentDispatches(rootDir)[0].headSha, 'current-approved');
});

test('ARP-06: Request changes before budget exhaustion does not launch merge-agent', async () => {
  const { rootDir, hqCalls, result } = await dispatchWithTrackedHqCalls({
    lastVerdict: 'Request changes',
    remediationCurrentRound: 1,
    remediationMaxRounds: 2,
  });

  assert.equal(result.decision, 'skip-remediation-claimable');
  assert.equal(hqCalls.length, 0);
  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
});

test('ARP-06: stale-head clean review is not used to dispatch merge-agent for the moved branch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: 'old-clean-head',
    reviewBody: '## Summary\nOld head was clean.\n## Verdict\n\nComment only',
    reviewPostedAt: '2026-05-26T11:00:00.000Z',
    critical: false,
  });

  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    branch: 'feature/pr-401',
    baseBranch: 'main',
    headSha: 'new-unreviewed-head',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...dispatchJob,
    execFileImpl: async () => {
      throw new Error('stale review must not dispatch hq');
    },
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
  });

  assert.equal(dispatchJob.lastVerdict, null);
  assert.equal(result.decision, 'skip-no-verdict');
  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
});

test('ARP-06: existing same-head merge-agent dispatch prevents duplicate launch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, makeJob({ headSha: 'already-dispatched-head' }), {
    dispatchedAt: '2026-05-26T11:30:00.000Z',
    prompt: '# prompt\n',
    dispatchId: 'disp_existing',
  });

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({ headSha: 'already-dispatched-head' }),
    execFileImpl: async () => {
      throw new Error('duplicate same-head dispatch must not call hq');
    },
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
  });

  assert.equal(result.decision, 'skip-already-dispatched');
  assert.equal(listMergeAgentDispatches(rootDir).length, 1);
});

test('ARP-06/#157: non-None Blocking issues refuses auto-merge even with a settled-success verdict', () => {
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Approved',
    blockingFindingCount: 1,
    blockingFindingState: 'known',
  }));

  assert.equal(detail.decision, 'skip-blockers-present');
  assert.equal(detail.trigger, null);
});

test('ROOT-CAUSE GATE: final-pass fails closed when Request changes blocker state is unknown', () => {
  // Legacy review bodies may carry `Request changes` without structured issue
  // sections. That is not proof of zero blockers; the gate parks until a fresh
  // structured review or a scoped operator override exists.
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    blockingFindingCount: 0,
    blockingFindingState: 'unknown',
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'skip-blocking-findings-unknown');
  assert.equal(detail.trigger, null);
});

test('final-pass STILL merges a budget-exhausted Request changes with NO blocking findings (deadlock case)', () => {
  // reviewer.last policy: a final round with only NON-blocking nitpicks still
  // reads `Request changes` (Comment only requires BOTH sections to be None).
  // That is exactly what final-pass-on-budget-exhausted exists to land. The
  // gate must not break it.
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    blockingFindingCount: 0,
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'dispatch');
  assert.equal(detail.trigger, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER);
});

test('operator-approved overrides the blocking-findings gate (human accepts the blockers)', () => {
  // operator-approved is resolved BEFORE the final-pass branch, so a human can
  // still force a merge that accepts standing blockers.
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    blockingFindingCount: 2,
    labels: [{ name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval(),
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'dispatch');
  assert.equal(detail.trigger, 'operator-approved');
});

test('pickMergeAgentDispatchDetail still skips Request changes when budget is NOT exhausted, even with final-pass flag on', () => {
  // remediation can still progress → defer to the remediation loop instead
  // of fighting it with merge-agent. This preserves the existing
  // skip-remediation-claimable gate.
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    remediationCurrentRound: 1,
    remediationMaxRounds: 3,
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'skip-remediation-claimable');
  assert.equal(detail.trigger, null);
});

test('pickMergeAgentDispatchDetail does NOT override operator-skip labels with final-pass flag', () => {
  // Hard skip labels must still win, even with the flag on. This guards
  // against the flag accidentally bypassing do-not-merge.
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    labels: [{ name: 'do-not-merge' }],
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'skip-operator-skip');
  assert.equal(detail.trigger, null);
});

test('pickMergeAgentDispatchDetail does NOT override failed checks with final-pass flag', () => {
  // CI is a hard gate independent of the convergence loop.
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    checksConclusion: 'FAILURE',
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'skip-checks-failed');
  assert.equal(detail.trigger, null);
});

test('pickMergeAgentDispatchDetail does NOT override non-mergeable state with final-pass flag', () => {
  const detail = pickMergeAgentDispatchDetail(makeJob({
    lastVerdict: 'Request changes',
    mergeable: 'CONFLICTING',
  }), {
    recentDispatches: [],
    finalPassOnRequestChangesEnabled: true,
  });
  assert.equal(detail.decision, 'skip-not-mergeable');
  assert.equal(detail.trigger, null);
});

test('isFinalPassOnRequestChangesEnabled defaults ON for unset/empty, off for explicit disable, fail-CLOSED on unknown', () => {
  // Silent stub so the warn() call on unknown values doesn't noise up
  // the test output.
  const silentLogger = { warn: () => {} };

  // Default ON: env unset OR empty.
  assert.equal(isFinalPassOnRequestChangesEnabled({ env: {}, logger: silentLogger }), true);
  assert.equal(
    isFinalPassOnRequestChangesEnabled({
      env: { [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: '' },
      logger: silentLogger,
    }),
    true,
  );
  // Explicit off-switch values: 0 / false / no (case-insensitive).
  assert.equal(
    isFinalPassOnRequestChangesEnabled({
      env: { [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: '0' },
      logger: silentLogger,
    }),
    false,
  );
  assert.equal(
    isFinalPassOnRequestChangesEnabled({
      env: { [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: 'false' },
      logger: silentLogger,
    }),
    false,
  );
  assert.equal(
    isFinalPassOnRequestChangesEnabled({
      env: { [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: 'NO' },
      logger: silentLogger,
    }),
    false,
  );
  // Explicit on values (redundant with default but supported).
  assert.equal(
    isFinalPassOnRequestChangesEnabled({
      env: { [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: '1' },
      logger: silentLogger,
    }),
    true,
  );
  assert.equal(
    isFinalPassOnRequestChangesEnabled({
      env: { [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: 'true' },
      logger: silentLogger,
    }),
    true,
  );
  assert.equal(
    isFinalPassOnRequestChangesEnabled({
      env: { [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: 'YES' },
      logger: silentLogger,
    }),
    true,
  );
  // Unknown value: fail-CLOSED and log a warning. A typo'd env must NOT
  // silently broaden merge authority.
  const warnings = [];
  const captureLogger = { warn: (msg) => warnings.push(msg) };
  assert.equal(
    isFinalPassOnRequestChangesEnabled({
      env: { [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: 'maybe' },
      logger: captureLogger,
    }),
    false,
  );
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /maybe/);
  assert.match(warnings[0], /falling back to OFF/);
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

test('pickMergeAgentDispatch honors no-merge-hold label', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    labels: [{ name: NO_MERGE_HOLD_LABEL }, { name: 'operator-approved' }, { name: 'merge-agent-requested' }],
    operatorApproval: makeOperatorApproval(),
    mergeAgentRequest: makeMergeAgentRequest(),
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
  // A pending follow-up job on a request-changes verdict is genuine active
  // remediation — a worker will claim it and remediate. Block convergence.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      latestFollowUpJobStatus: 'pending',
      remediationCurrentRound: 0,
      remediationMaxRounds: 3,
    })),
    'skip-remediation-active'
  );
  // An in-progress follow-up job may be a live remediation worker mid-force-
  // push; block regardless of verdict to avoid racing it.
  assert.equal(
    pickMergeAgentDispatch(makeJob({ latestFollowUpJobStatus: 'in_progress' })),
    'skip-remediation-active'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      latestFollowUpJobStatus: 'in_progress',
    })),
    'skip-remediation-active'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({ latestFollowUpJobStatus: 'in-progress' })),
    'skip-remediation-active'
  );
});

test('pickMergeAgentDispatch refuses dispatch while a clean-verdict follow-up job is still pending or in progress', () => {
  // A pending clean-verdict follow-up job can represent an explicit
  // retrigger-remediation operator override. With only `latestFollowUpJobStatus`
  // on the merge candidate, merge-agent cannot prove the pending job is the
  // auto-settled clean path, so `pending` remains a hard block.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Comment only',
      latestFollowUpJobStatus: 'pending',
    })),
    'skip-remediation-active'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Approved',
      latestFollowUpJobStatus: 'pending',
    })),
    'skip-remediation-active'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Comment only',
      latestFollowUpJobStatus: 'in_progress',
    })),
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
      latestFollowUpJobStatus: 'in_progress',
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

test('operator-approved must be scoped to the current head SHA (stale label hard-stops, even under default-ON final-pass)', () => {
  // The `operator-approved` label is an explicit operator signal that
  // this PR needed manual attention. A label scoped to an old head
  // means the operator's approval is stale; the system must not
  // override that with automation just because the budget is
  // exhausted. This invariant is independent of the final-pass flag.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval({ headSha: 'old-sha' }),
    })),
    'skip-operator-approval-stale'
  );
  // Explicit-off also surfaces the same stale-label diagnostic.
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval({ headSha: 'old-sha' }),
    }), {
      recentDispatches: [],
      finalPassOnRequestChangesEnabled: false,
    }),
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

test('operator-approved fails closed when no attributed labeled event was fetched (provenance gap hard-stops under any flag)', () => {
  // Provenance failures (no attribution event, unknown actor) are
  // unsafe states for an operator-approved label. The system must NOT
  // expand merge authority into those degraded states regardless of
  // the final-pass flag. A transient GitHub timeline fetch failure or
  // malformed label event becoming an auto-merge trigger is a real
  // control-plane regression — keep it hard-stop.
  const noAttribution = {
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
  };
  const unknownActor = {
    lastVerdict: 'Request changes',
    labels: [{ name: 'operator-approved' }],
    operatorApproval: makeOperatorApproval({ actor: 'unknown' }),
  };

  // Default ON: still skip-operator-approval-stale (provenance gap is
  // upstream of the final-pass branch).
  assert.equal(pickMergeAgentDispatch(makeJob(noAttribution)), 'skip-operator-approval-stale');
  assert.equal(pickMergeAgentDispatch(makeJob(unknownActor)), 'skip-operator-approval-stale');

  // Explicit opt-out: same behavior.
  const explicitOff = { recentDispatches: [], finalPassOnRequestChangesEnabled: false };
  assert.equal(
    pickMergeAgentDispatch(makeJob(noAttribution), explicitOff),
    'skip-operator-approval-stale'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob(unknownActor), explicitOff),
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

test('pickMergeAgentDispatch fails closed on unknown CI checks in the normal path', () => {
  const decision = pickMergeAgentDispatch(makeJob({
    checksConclusion: null,
  }));
  assert.equal(decision, 'skip-checks-unknown');
});

test('summarizeChecksConclusion distinguishes missing and empty status check rollups', () => {
  assert.equal(summarizeChecksConclusion(undefined), null);
  assert.equal(summarizeChecksConclusion({}), null);
  assert.equal(summarizeChecksConclusion([]), 'SUCCESS');
});

test('summarizeChecksConclusion ignores the adversarial-review pipeline\'s own gate check', () => {
  // Operator directive 2026-05-25: do not wait for adversarial-review's own
  // convergence check, and never treat it as a hard CI gate. The merge-agent
  // already has the verdict via job.lastVerdict; the gate-status is circular.

  // A PR whose ONLY check is the adversarial gate (pending) → no external CI
  // to wait on → SUCCESS (was PENDING before the fix → merge-agent stalled).
  assert.equal(
    summarizeChecksConclusion([
      { __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'PENDING' },
    ]),
    'SUCCESS'
  );

  // The adversarial gate reporting FAILURE/ERROR (e.g. a Request-changes
  // verdict) must NOT hard-fail the merge gate.
  assert.equal(
    summarizeChecksConclusion([
      { __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'FAILURE' },
    ]),
    'SUCCESS'
  );

  // Real external CI still gates: a failing build alongside the (ignored)
  // adversarial gate yields FAILURE.
  assert.equal(
    summarizeChecksConclusion([
      { __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'FAILURE' },
      { __typename: 'CheckRun', name: 'build', conclusion: 'FAILURE' },
    ]),
    'FAILURE'
  );

  // Real external CI pending alongside the (ignored) adversarial gate → PENDING.
  assert.equal(
    summarizeChecksConclusion([
      { __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'unit-tests', status: 'IN_PROGRESS' },
    ]),
    'PENDING'
  );

  // Real external CI succeeding alongside the (ignored) adversarial gate → SUCCESS.
  assert.equal(
    summarizeChecksConclusion([
      { __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'FAILURE' },
      { __typename: 'CheckRun', name: 'unit-tests', conclusion: 'SUCCESS' },
    ]),
    'SUCCESS'
  );

  // Honor a custom gate context via ADV_GATE_STATUS_CONTEXT-resolved env.
  assert.equal(
    summarizeChecksConclusion(
      [{ __typename: 'StatusContext', context: 'galileo/adversarial-gate', state: 'FAILURE' }],
      { env: { ADV_GATE_STATUS_CONTEXT: 'galileo/adversarial-gate' } }
    ),
    'SUCCESS'
  );

  // A non-adversarial check named to merely contain "adversarial" elsewhere is
  // still gated.
  assert.equal(
    summarizeChecksConclusion([
      { __typename: 'CheckRun', name: 'my-adversarial-fuzzer', conclusion: 'FAILURE' },
    ]),
    'FAILURE'
  );

  // Prefix matches are also real external CI unless they are the exact
  // configured status-context alias.
  assert.equal(
    summarizeChecksConclusion([
      { __typename: 'CheckRun', name: 'agent-os/adversarial-fuzzer', conclusion: 'FAILURE' },
    ]),
    'FAILURE'
  );

  // The self-gate exclusion is intentionally limited to StatusContext items.
  // A CheckRun reusing the same string must still gate until the publisher
  // contract changes deliberately.
  assert.equal(
    summarizeChecksConclusion([
      { __typename: 'CheckRun', name: 'agent-os/adversarial-gate', conclusion: 'FAILURE' },
    ]),
    'FAILURE'
  );
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
      latestFollowUpJobStatus: 'in_progress',
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
    'dispatch'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }, { name: 'merge-agent-stuck' }],
      mergeAgentRequest: makeMergeAgentRequest({ headSha: 'old-sha' }),
      mergeable: 'CONFLICTING',
    })),
    'skip-merge-agent-requested-stale'
  );
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
      latestFollowUpJobStatus: 'in_progress',
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
  // Under default-ON final-pass, a stale operator-approved label routes
  // through the final-pass dispatch path rather than surfacing
  // `skip-operator-approval-stale`. The legacy halt code is still
  // reachable via explicit flag-disable (asserted below).
  assert.equal(
    pickMergeAgentDispatch(makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval({ headSha: 'old-sha' }),
    }), {
      recentDispatches: [recorded],
      finalPassOnRequestChangesEnabled: false,
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
    revisionRef: 'abc123',
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
  // No `## Blocking issues` section → zero blocking findings → final-pass
  // auto-merge is permitted (this clean body would not even reach that branch).
  assert.equal(dispatchJob.blockingFindingCount, 0);
  assert.equal(dispatchJob.blockingFindingState, 'known');
  assert.equal(dispatchJob.operatorApproval.actor, 'VirtualPaul');
  assert.equal(dispatchJob.operatorApproval.headSha, 'abc123');
  assert.equal(dispatchJob.operatorApproval.codeScopedAt, '2026-05-02T10:04:00.000Z');
});

test('buildMergeAgentDispatchJob dispatches clean Comment only reviews with explicit no blockers', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 405,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: 'clean123',
    reviewBody: [
      '## Summary',
      'The current head is ready.',
      '## Blocking issues',
      '- None.',
      '## Non-blocking issues',
      '- None.',
      '## Verdict',
      '',
      'Comment only',
    ].join('\n'),
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
  });

  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 405,
    branch: 'feature/pr-405',
    baseBranch: 'main',
    headSha: 'clean123',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });
  const detail = pickMergeAgentDispatchDetail({
    ...dispatchJob,
    latestFollowUpJobStatus: 'completed',
    remediationCurrentRound: 1,
    remediationMaxRounds: 2,
  });

  assert.equal(dispatchJob.lastVerdict, 'Comment only');
  assert.equal(dispatchJob.blockingFindingCount, 0);
  assert.equal(dispatchJob.blockingFindingState, 'known');
  assert.equal(detail.decision, 'dispatch');
  assert.equal(detail.trigger, null);
});

test('buildMergeAgentDispatchJob marks legacy Request changes bodies without issue sections as unknown blocker state', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 404,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: 'legacy123',
    reviewBody: '## Summary\nA legacy review requested changes.\n## Verdict\n\nRequest changes',
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
  });

  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 404,
    branch: 'feature/pr-404',
    baseBranch: 'main',
    headSha: 'legacy123',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });

  assert.equal(dispatchJob.lastVerdict, 'Request changes');
  assert.equal(dispatchJob.blockingFindingCount, 0);
  assert.equal(dispatchJob.blockingFindingState, 'unknown');
  assert.equal(
    pickMergeAgentDispatch({
      ...dispatchJob,
      latestFollowUpJobStatus: 'completed',
      remediationCurrentRound: 2,
      remediationMaxRounds: 2,
    }),
    'skip-blocking-findings-unknown'
  );
});

test('buildMergeAgentDispatchJob counts standing blocking findings from the latest review', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 402,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: 'def456',
    reviewBody: [
      '## Summary',
      'Two blocking problems remain.',
      '## Blocking issues',
      '- **Status pre-probe stall**',
      '  - **File:** drainer.mjs',
      '  - **Lines:** 548-566',
      '  - **Problem:** awaits a live probe on the intercept path',
      '  - **Why it matters:** a hanging probe stalls /status',
      '  - **Recommended fix:** read cached health instead',
      '- **Non-durable reset sequencing**',
      '  - **File:** drainer.mjs',
      '  - **Lines:** 466-491',
      '  - **Problem:** reset runs before the durable write',
      '  - **Why it matters:** a crash repeats the reset',
      '  - **Recommended fix:** write in_progress first',
      '## Non-blocking issues',
      '- None.',
      '## Verdict',
      '',
      'Request changes',
    ].join('\n'),
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
  });

  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 402,
    branch: 'feature/pr-402',
    baseBranch: 'main',
    headSha: 'def456',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });

  assert.equal(dispatchJob.lastVerdict, 'Request changes');
  assert.equal(dispatchJob.blockingFindingCount, 2);
  assert.equal(dispatchJob.blockingFindingState, 'known');
});

test('buildMergeAgentDispatchJob fails safe to >=1 for a non-None blocking section the parser cannot itemize', () => {
  // Defense-in-depth: if the reviewer writes a malformed/incomplete blocking
  // card the structured parser cannot itemize, we must NOT treat the section as
  // empty and auto-merge. Any non-`None` Blocking issues content floors to 1.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 403,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: 'ghi789',
    reviewBody: [
      '## Summary',
      'A blocker exists but the card is malformed.',
      '## Blocking issues',
      '- secret leakage in the new logging path (no structured sub-fields)',
      '## Non-blocking issues',
      '- None.',
      '## Verdict',
      '',
      'Request changes',
    ].join('\n'),
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
  });

  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 403,
    branch: 'feature/pr-403',
    baseBranch: 'main',
    headSha: 'ghi789',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });

  assert.equal(dispatchJob.lastVerdict, 'Request changes');
  assert.ok(dispatchJob.blockingFindingCount >= 1);
  assert.equal(dispatchJob.blockingFindingState, 'known');
});

test('buildMergeAgentDispatchJob normalizes real claimed follow-up job status', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: 'abc123',
    reviewBody: '## Summary\nx\n## Verdict\n\nRequest changes',
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
  });
  claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-05-02T10:01:00.000Z',
    launcherPid: 4242,
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

  assert.equal(dispatchJob.latestFollowUpJobStatus, 'in-progress');
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'skip-remediation-active');
});

test('buildMergeAgentDispatchJob ignores stale active remediation on an older head', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: 'new-head',
    reviewBody: '## Summary\nx\n## Verdict\n\nComment only',
    reviewPostedAt: '2026-05-02T10:00:00.000Z',
    critical: false,
  });
  claimNextFollowUpJob({
    rootDir,
    claimedAt: '2026-05-02T10:01:00.000Z',
    launcherPid: 4242,
    returnStopped: true,
  });
  createFollowUpJob({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    reviewerModel: 'codex',
    linearTicketId: null,
    revisionRef: 'old-head',
    reviewBody: '## Summary\nx\n## Verdict\n\nRequest changes',
    reviewPostedAt: '2026-05-02T10:05:00.000Z',
    critical: false,
  });

  const dispatchJob = buildMergeAgentDispatchJob(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 401,
    branch: 'feature/pr-401',
    baseBranch: 'main',
    headSha: 'new-head',
    mergeable: 'MERGEABLE',
    checksConclusion: 'SUCCESS',
    labels: [],
    operatorNotes: null,
    prState: 'open',
    merged: false,
  });

  assert.equal(dispatchJob.lastVerdict, 'Comment only');
  assert.equal(dispatchJob.latestFollowUpJobStatus, 'stopped');
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'dispatch');
});

test('pickMergeAgentDispatch can dispatch zero-check PRs from an explicit empty rollup', () => {
  const dispatchJob = makeJob({
    checksConclusion: summarizeChecksConclusion([]),
  });

  assert.equal(dispatchJob.checksConclusion, 'SUCCESS');
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'dispatch');
});

test('pickMergeAgentDispatch can dispatch when the rollup contains only the adversarial gate status', () => {
  const dispatchJob = makeJob({
    checksConclusion: summarizeChecksConclusion([
      { __typename: 'StatusContext', context: 'agent-os/adversarial-gate', state: 'PENDING' },
    ]),
  });

  assert.equal(dispatchJob.checksConclusion, 'SUCCESS');
  assert.equal(pickMergeAgentDispatch(dispatchJob), 'dispatch');
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
  const env = {
    MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
    MERGE_AGENT_HQ_PROJECT: 'merge-project',
  };
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob(),
    env,
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
  assert.equal(listMergeAgentDispatches(rootDir)[0].priority, 'normal');
  assert.equal(hqCalls[0].cmd, 'hq');
  assert.deepEqual(hqCalls[0].args.slice(0, 17), [
    'dispatch',
    '--worker-class', 'merge-agent',
    '--task-kind', 'merge',
    '--priority', 'normal',
    '--repo', 'agent-os',
    '--pr', '401',
    '--ticket', 'PR-401',
    '--parent-session', 'session:test:merge-watcher',
    '--project', 'merge-project',
  ]);
  assert.ok(
    hqCalls[0].args.includes('--priority') && hqCalls[0].args.includes('normal'),
    'default merge-agent dispatches must stay on the normal lane'
  );
});

test('dispatchMergeAgentForPR uses the critical lane only for merge-agent-requested', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];
  const env = {
    MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
    MERGE_AGENT_HQ_PROJECT: 'merge-project',
  };
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
    }),
    env,
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args });
      return {
        stdout: '{"dispatchId":"disp_critical","lrq":"lrq_critical"}\n',
      };
    },
    now: '2026-05-03T12:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(listMergeAgentDispatches(rootDir)[0].trigger, 'merge-agent-requested');
  assert.equal(listMergeAgentDispatches(rootDir)[0].priority, 'critical');
  assert.ok(
    hqCalls[0].args.includes('--priority') && hqCalls[0].args.includes('critical'),
    'merge-agent-requested dispatches must use the critical lane'
  );
});

test('dispatchMergeAgentForPR retries without --priority when hq rejects the flag', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
    }),
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args });
      if (hqCalls.length === 1) {
        const err = new Error('hq: unrecognized arguments: --priority critical');
        err.code = 2;
        err.stderr = 'usage: hq dispatch\nhq: error: unrecognized arguments: --priority critical\n';
        throw err;
      }
      return {
        stdout: '{"dispatchId":"disp_legacy","lrq":"lrq_legacy"}\n',
      };
    },
    now: '2026-05-19T04:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(hqCalls.length, 2);
  assert.ok(hqCalls[0].args.includes('--priority'));
  assert.ok(!hqCalls[1].args.includes('--priority'));
  assert.equal(listMergeAgentDispatches(rootDir)[0].priority, 'critical');
  assert.equal(listMergeAgentDispatches(rootDir)[0].priorityFlagSupported, false);
});

test('dispatchMergeAgentForPR does not drop priority for unrelated hq parser errors', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];

  await assert.rejects(
    dispatchMergeAgentForPR({
      agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
      rootDir,
      ...makeJob({
        labels: [{ name: 'merge-agent-requested' }],
        mergeAgentRequest: makeMergeAgentRequest(),
        mergeable: 'CONFLICTING',
      }),
      execFileImpl: async (cmd, args) => {
        hqCalls.push({ cmd, args });
        const err = new Error(`Command failed: hq ${args.join(' ')}`);
        err.code = 2;
        err.stderr = 'hq: error: unknown project merge-project\n';
        throw err;
      },
      dispatchRetryDelaysMs: [],
      now: '2026-05-19T04:20:00.000Z',
    }),
    /unknown project merge-project/
  );

  assert.equal(hqCalls.length, 1);
  assert.ok(hqCalls[0].args.includes('--priority'));
  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
});

test('dispatchMergeAgentForPR retries transient hq dispatch failures with the same args', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'CONFLICTING',
    }),
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args: [...args] });
      if (hqCalls.length < 3) {
        const err = new Error('database is locked');
        err.code = 'SQLITE_BUSY';
        err.stderr = 'sqlite3.OperationalError: database is locked\n';
        throw err;
      }
      return {
        stdout: '{"dispatchId":"disp_after_retry","lrq":"lrq_after_retry"}\n',
      };
    },
    dispatchRetryDelaysMs: [0, 0],
    now: '2026-05-19T04:25:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(hqCalls.length, 3);
  assert.deepEqual(hqCalls[0].args, hqCalls[1].args);
  assert.deepEqual(hqCalls[1].args, hqCalls[2].args);
  assert.ok(hqCalls[2].args.includes('--priority'));
  assert.equal(result.launchRequestId, 'lrq_after_retry');
  assert.equal(listMergeAgentDispatches(rootDir)[0].priorityFlagSupported, true);
});

test('dispatchMergeAgentForPR tears down terminal original worker before merge-agent dispatch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-660';
  const branch = `${originalWorkerId}/LAC-660-drain-zombie-lrq-skip`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'airlock' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_original',
  }));
  const hqCalls = [];
  const logs = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({ branch }),
    env: { HQ_ROOT: hqRoot, USER: 'airlock' },
    prepareOriginalWorkerImpl: (opts) => prepareOriginalWorkerForMergeAgent({
      ...opts,
      lookupRunStatusImpl: async () => ({
        found: true,
        status: 'succeeded',
        launchRequestId: 'lrq_original',
        runId: 'run_original',
      }),
    }),
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args: [...args] });
      if (args[0] === 'worker' && args[1] === 'tear-down') {
        rmSync(workerDir, { recursive: true, force: true });
        return { stdout: '', stderr: '' };
      }
      return { stdout: '{"dispatchId":"disp_merge","lrq":"lrq_merge"}\n' };
    },
    now: '2026-05-17T14:30:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.dispatchId, 'disp_merge');
  assert.equal(existsSync(worktreePath), false);
  assert.deepEqual(hqCalls.map(call => call.args.slice(0, 3)), [
    ['worker', 'tear-down', originalWorkerId],
    ['dispatch', '--worker-class', 'merge-agent'],
  ]);
  assert.equal(logs[0].event, 'merge_agent.original_worker_torn_down');
  assert.equal(logs[0].original_worker_id, originalWorkerId);
  assert.equal(logs[0].lrq, 'lrq_original');
});

test('dispatchMergeAgentForPR tears down failed original workers because they are terminal', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-660b';
  const branch = `${originalWorkerId}/LAC-660-terminal-failed`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'airlock' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_failed',
  }));
  const hqCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({ branch }),
    env: { HQ_ROOT: hqRoot, USER: 'airlock' },
    prepareOriginalWorkerImpl: (opts) => prepareOriginalWorkerForMergeAgent({
      ...opts,
      lookupRunStatusImpl: async () => ({
        found: true,
        status: 'failed',
        launchRequestId: 'lrq_failed',
        runId: 'run_failed',
      }),
    }),
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args: [...args] });
      if (args[0] === 'worker' && args[1] === 'tear-down') {
        rmSync(workerDir, { recursive: true, force: true });
        return { stdout: '', stderr: '' };
      }
      return { stdout: '{"dispatchId":"disp_terminal","lrq":"lrq_terminal"}\n' };
    },
    now: '2026-05-17T14:30:30.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.deepEqual(hqCalls.map(call => call.args.slice(0, 3)), [
    ['worker', 'tear-down', originalWorkerId],
    ['dispatch', '--worker-class', 'merge-agent'],
  ]);
});

test('dispatchMergeAgentForPR defers merge-agent dispatch while original worker is running', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-661';
  const branch = `${originalWorkerId}/LAC-661-still-running`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_running',
  }));
  const hqCalls = [];
  const logs = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({ branch }),
    env: { HQ_ROOT: hqRoot },
    prepareOriginalWorkerImpl: (opts) => prepareOriginalWorkerForMergeAgent({
      ...opts,
      lookupRunStatusImpl: async () => ({
        found: true,
        status: 'running',
        launchRequestId: 'lrq_running',
        runId: 'run_running',
      }),
    }),
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args: [...args] });
      throw new Error('hq must not be called when original worker is still running');
    },
    now: '2026-05-17T14:31:00.000Z',
  });

  assert.equal(result.decision, 'dispatch-deferred');
  assert.equal(result.reason, 'worker-run-status-running');
  assert.equal(result.originalWorkerId, originalWorkerId);
  assert.equal(existsSync(worktreePath), true);
  assert.equal(hqCalls.length, 0);
  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
  assert.equal(logs[0].event, 'merge_agent.dispatch_deferred');
  assert.equal(logs[0].reason, 'worker-run-status-running');
});

test('prepareOriginalWorkerForMergeAgent matches canonical terminal semantics for session-ledger worker statuses', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-661a';
  const branch = `${originalWorkerId}/LAC-661a-status-matrix`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'placey' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_status_matrix',
  }));

  const terminalStatuses = ['succeeded', 'failed', 'cancelled'];
  const nonTerminalStatuses = [
    'starting',
    'running',
    'idle',
    'waiting_human',
    'waiting_policy',
    'waiting_tool',
    'blocked',
    'stalled',
    'degraded',
    'warning',
  ];

  for (const status of terminalStatuses) {
    let execCalled = false;
    const result = await prepareOriginalWorkerForMergeAgent({
      job: makeJob({ branch }),
      hqPath: 'hq',
      env: { HQ_ROOT: hqRoot, USER: 'placey' },
      lookupRunStatusImpl: async () => ({
        found: true,
        status,
        launchRequestId: 'lrq_status_matrix',
        runId: `run_${status}`,
      }),
      execFileImpl: async () => {
        execCalled = true;
        return { stdout: '', stderr: '' };
      },
      now: '2026-05-17T14:31:30.000Z',
    });
    assert.equal(result.decision, 'torn-down');
    assert.equal(execCalled, true);
  }

  for (const status of nonTerminalStatuses) {
    let execCalled = false;
    const result = await prepareOriginalWorkerForMergeAgent({
      job: makeJob({ branch }),
      hqPath: 'hq',
      env: { HQ_ROOT: hqRoot, USER: 'placey' },
      lookupRunStatusImpl: async () => ({
        found: true,
        status,
        launchRequestId: 'lrq_status_matrix',
        runId: `run_${status}`,
      }),
      execFileImpl: async () => {
        execCalled = true;
        throw new Error('execFileImpl must not run for non-terminal statuses');
      },
      now: '2026-05-17T14:31:30.000Z',
    });
    assert.equal(result.decision, 'deferred');
    assert.equal(result.reason, `worker-run-status-${status}`);
    assert.equal(execCalled, false);
  }
});

test('merge-agent terminal status set matches parent session-ledger model when available', (t) => {
  const modelsPath = path.resolve(
    '..',
    '..',
    'platform',
    'session-ledger',
    'src',
    'session_ledger',
    'models.py'
  );
  if (!existsSync(modelsPath)) {
    t.skip('parent agent-os session-ledger model is not present in standalone checkout');
    return;
  }

  const models = readFileSync(modelsPath, 'utf8');
  const match = models.match(/WORKER_RUN_TERMINAL_STATUSES\s*=\s*frozenset\(\{([^}]+)\}\)/s);
  assert.ok(match, 'could not parse WORKER_RUN_TERMINAL_STATUSES from session-ledger models.py');
  const pythonStatuses = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
  assert.deepEqual(
    [...TERMINAL_WORKER_RUN_STATUSES].sort(),
    pythonStatuses
  );
});

test('dispatchMergeAgentForPR is idempotent when original worker is already torn down', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-662';
  const hqCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({ branch: `${originalWorkerId}/LAC-662-already-torn-down` }),
    env: { HQ_ROOT: hqRoot },
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args: [...args] });
      return { stdout: '{"dispatchId":"disp_idempotent","lrq":"lrq_idempotent"}\n' };
    },
    now: '2026-05-17T14:32:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.dispatchId, 'disp_idempotent');
  assert.equal(hqCalls.length, 1);
  assert.deepEqual(hqCalls[0].args.slice(0, 3), ['dispatch', '--worker-class', 'merge-agent']);
});

test('prepareOriginalWorkerForMergeAgent defers when workerDir exists but workspace.json is missing', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-662a';
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'placey' }));
  const logs = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch: `${originalWorkerId}/LAC-662a-workspace-missing` }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    lookupRunStatusImpl: async () => ({
      found: true,
      status: 'cancelled',
      launchRequestId: 'lrq_workspace_missing',
      runId: 'run_workspace_missing',
    }),
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run without workspace validation');
    },
    now: '2026-05-17T14:32:15.000Z',
  });

  assert.equal(result.decision, 'deferred');
  assert.equal(result.reason, 'workspace-json-missing-but-worker-dir-present');
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.workspace_missing');
});

test('dispatchMergeAgentForPR skips original-worker teardown when HQ_ROOT is unset', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const logs = [];
  const hqCalls = [];

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({ branch: 'codex-lac-663/LAC-663-no-hq-root' }),
    env: { HQ_ROOT: '' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args: [...args] });
      return { stdout: '{"dispatchId":"disp_no_root","lrq":"lrq_no_root"}\n' };
    },
    now: '2026-05-17T14:32:30.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].reason, 'hq-root-unset');
  assert.deepEqual(hqCalls[0].args.slice(0, 3), ['dispatch', '--worker-class', 'merge-agent']);
});

test('prepareOriginalWorkerForMergeAgent defers on HQ owner mismatch instead of mutating another user root', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-664';
  const branch = `${originalWorkerId}/LAC-664-owner-mismatch`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'airlock' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_owner',
  }));
  const logs = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    lookupRunStatusImpl: async () => ({
      found: true,
      status: 'failed',
      launchRequestId: 'lrq_owner',
      runId: 'run_owner',
    }),
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run on owner mismatch');
    },
    now: '2026-05-17T14:33:00.000Z',
  });

  assert.equal(result.decision, 'deferred');
  assert.equal(result.reason, 'hq-owner-mismatch');
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].hq_owner_user, 'airlock');
  assert.equal(logs[0].runtime_user, 'placey');
});

test('prepareOriginalWorkerForMergeAgent fails closed when HQ owner cannot be resolved', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-664a';
  const branch = `${originalWorkerId}/LAC-664a-owner-unknown`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_owner_unknown',
  }));
  const logs = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    lookupRunStatusImpl: async () => ({
      found: true,
      status: 'failed',
      launchRequestId: 'lrq_owner_unknown',
      runId: 'run_owner_unknown',
    }),
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run when HQ owner is unknown');
    },
    now: '2026-05-17T14:33:30.000Z',
  });

  assert.equal(result.decision, 'deferred');
  assert.equal(result.reason, 'hq-owner-unknown');
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].reason, 'hq-owner-unknown');
});

test('prepareOriginalWorkerForMergeAgent fails closed when runtime user cannot be resolved', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-664runtime';
  const branch = `${originalWorkerId}/LAC-664runtime-user-unknown`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'placey' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_runtime_unknown',
  }));
  const logs = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    runtimeUserImpl: () => null,
    lookupRunStatusImpl: async () => ({
      found: true,
      status: 'failed',
      launchRequestId: 'lrq_runtime_unknown',
      runId: 'run_runtime_unknown',
    }),
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run when runtime user is unknown');
    },
    now: '2026-05-17T14:33:40.000Z',
  });

  assert.equal(result.decision, 'deferred');
  assert.equal(result.reason, 'hq-runtime-user-unknown');
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].reason, 'hq-runtime-user-unknown');
});

test('prepareOriginalWorkerForMergeAgent passes parsed workspace and run metadata to worker-run lookup', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-664meta';
  const branch = `${originalWorkerId}/LAC-664meta-pass-records`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_metadata',
  }));
  writeFileSync(path.join(workerDir, 'run.json'), JSON.stringify({
    runId: 'run_metadata',
    launchProvenance: { source: 'unit-test' },
  }));

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    lookupRunStatusImpl: async ({ workspace, runRecord }) => {
      assert.equal(workspace.workerId, originalWorkerId);
      assert.equal(workspace.branch, branch);
      assert.equal(runRecord.runId, 'run_metadata');
      assert.deepEqual(runRecord.launchProvenance, { source: 'unit-test' });
      return {
        found: true,
        status: 'running',
        launchRequestId: 'lrq_metadata',
        runId: 'run_metadata',
      };
    },
    execFileImpl: async () => {
      throw new Error('execFileImpl must not run while worker is running');
    },
  });

  assert.equal(result.decision, 'deferred');
  assert.equal(result.reason, 'worker-run-status-running');
});

test('prepareOriginalWorkerForMergeAgent skips teardown when branch prefix does not own the worker workspace', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-664b';
  const branch = `${originalWorkerId}/LAC-664b-wrong-worker`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'placey' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'codex-lac-other',
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_wrong_worker',
  }));
  const logs = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    lookupRunStatusImpl: async () => ({
      found: true,
      status: 'failed',
      launchRequestId: 'lrq_wrong_worker',
      runId: 'run_wrong_worker',
    }),
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run when worker ids differ');
    },
    now: '2026-05-17T14:33:45.000Z',
  });

  assert.equal(result.decision, 'ready');
  assert.equal(result.reason, 'workspace-worker-id-mismatch');
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].workspace_worker_id, 'codex-lac-other');
});

test('prepareOriginalWorkerForMergeAgent skips teardown when workspace branch does not match the PR branch', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-664branch';
  const branch = `${originalWorkerId}/LAC-664branch-current`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'placey' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch: `${originalWorkerId}/LAC-664branch-stale`,
    launchRequestId: 'lrq_branch_mismatch',
  }));
  const logs = [];
  let lookupCalled = false;
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    lookupRunStatusImpl: async () => {
      lookupCalled = true;
      throw new Error('lookup must not run after branch mismatch');
    },
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run after branch mismatch');
    },
    now: '2026-05-17T14:33:48.000Z',
  });

  assert.equal(result.decision, 'ready');
  assert.equal(result.reason, 'workspace-branch-mismatch');
  assert.equal(lookupCalled, false);
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].workspace_branch, `${originalWorkerId}/LAC-664branch-stale`);
});

test('prepareOriginalWorkerForMergeAgent ignores unrecognized worker-id branch prefixes before filesystem or hq access', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const logs = [];
  let execCalled = false;
  let lookupCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch: '--root=/tmp/other/LAC-664c-bad-worker-id' }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    lookupRunStatusImpl: async () => {
      lookupCalled = true;
      throw new Error('lookup must not run for invalid worker ids');
    },
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run for invalid worker ids');
    },
    now: '2026-05-17T14:33:50.000Z',
  });

  assert.equal(result.decision, 'ready');
  assert.equal(result.reason, 'unrecognized-worker-id-shape');
  assert.equal(lookupCalled, false);
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].reason, 'unrecognized-worker-id-shape');
});

test('prepareOriginalWorkerForMergeAgent surfaces tear-down stderr/stdout and logs failure details', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-665';
  const branch = `${originalWorkerId}/LAC-665-teardown-fails`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'placey' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_failure',
  }));
  const logs = [];

  await assert.rejects(
    prepareOriginalWorkerForMergeAgent({
      job: makeJob({ branch }),
      hqPath: 'hq',
      env: { HQ_ROOT: hqRoot, USER: 'placey' },
      logger: { info: (line) => logs.push(JSON.parse(line)) },
      lookupRunStatusImpl: async () => ({
        found: true,
        status: 'succeeded',
        launchRequestId: 'lrq_failure',
        runId: 'run_failure',
      }),
      execFileImpl: async () => {
        const error = new Error('Command failed');
        error.code = 2;
        error.stderr = 'owner mismatch';
        error.stdout = 'suggested command';
        throw error;
      },
      now: '2026-05-17T14:34:00.000Z',
    }),
    /hq worker tear-down failed \(exit code 2\)/
  );

  assert.equal(logs[0].event, 'merge_agent.tear_down_failed');
  assert.equal(logs[0].stderr, 'owner mismatch');
  assert.equal(logs[0].stdout, 'suggested command');
});

test('prepareOriginalWorkerForMergeAgent bounds tear-down and logs timeout distinctly', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-665timeout';
  const branch = `${originalWorkerId}/LAC-665-timeout`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'placey' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_timeout',
  }));
  const logs = [];
  let execOptions = null;

  await assert.rejects(
    prepareOriginalWorkerForMergeAgent({
      job: makeJob({ branch }),
      hqPath: 'hq',
      env: { HQ_ROOT: hqRoot, USER: 'placey' },
      logger: { info: (line) => logs.push(JSON.parse(line)) },
      lookupRunStatusImpl: async () => ({
        found: true,
        status: 'succeeded',
        launchRequestId: 'lrq_timeout',
        runId: 'run_timeout',
      }),
      execFileImpl: async (_cmd, _args, options) => {
        execOptions = options;
        const error = new Error('Command timed out');
        error.code = 'ETIMEDOUT';
        error.killed = true;
        error.signal = 'SIGTERM';
        throw error;
      },
      now: '2026-05-17T14:34:10.000Z',
    }),
    /hq worker tear-down failed/
  );

  assert.equal(execOptions.timeout, HQ_WORKER_TEAR_DOWN_TIMEOUT_MS);
  assert.equal(execOptions.killSignal, 'SIGTERM');
  assert.equal(logs[0].event, 'merge_agent.tear_down_timeout');
  assert.equal(logs[0].reason, 'tear-down-timeout');
  assert.equal(logs[0].timeout_ms, HQ_WORKER_TEAR_DOWN_TIMEOUT_MS);
});

test('lookupOriginalWorkerRunStatus reads worker_runs rows from the configured ledger db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const workerDir = path.join(hqRoot, 'workers', 'codex-lac-666');
  const ledgerDbPath = path.join(hqRoot, 'session-ledger.sqlite');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({
    ownerUser: 'placey',
    ledgerDbPath,
  }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'codex-lac-666',
    launchRequestId: 'lrq_lookup',
  }));
  writeFileSync(path.join(workerDir, 'run.json'), JSON.stringify({
    runId: 'run_lookup',
  }));

  const db = new Database(ledgerDbPath);
  db.exec('CREATE TABLE worker_runs (run_id TEXT, launch_request_id TEXT, status TEXT)');
  db.prepare('INSERT INTO worker_runs (run_id, launch_request_id, status) VALUES (?, ?, ?)')
    .run('run_lookup', 'lrq_lookup', 'cancelled');
  db.close();

  const result = await lookupOriginalWorkerRunStatus({
    workerDir,
    hqRoot,
    env: {},
  });

  assert.equal(result.found, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.launchRequestId, 'lrq_lookup');
  assert.equal(result.runId, 'run_lookup');
});

test('lookupOriginalWorkerRunStatus falls back to the canonical HOME session-ledger db', async () => {
  const { default: Database } = await import('better-sqlite3');
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const homeDir = mkdtempSync(path.join(tmpdir(), 'agent-os-home-'));
  const workerDir = path.join(hqRoot, 'workers', 'codex-lac-666home');
  const ledgerDir = path.join(homeDir, '.agent-os', 'session-ledger');
  const ledgerDbPath = path.join(ledgerDir, 'ledger.db');
  mkdirSync(workerDir, { recursive: true });
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'codex-lac-666home',
    launchRequestId: 'lrq_home_lookup',
  }));

  const db = new Database(ledgerDbPath);
  db.exec('CREATE TABLE worker_runs (run_id TEXT, launch_request_id TEXT, status TEXT)');
  db.prepare('INSERT INTO worker_runs (run_id, launch_request_id, status) VALUES (?, ?, ?)')
    .run('run_home_lookup', 'lrq_home_lookup', 'succeeded');
  db.close();

  const result = await lookupOriginalWorkerRunStatus({
    workerDir,
    hqRoot,
    env: { HOME: homeDir },
  });

  assert.equal(result.found, true);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.launchRequestId, 'lrq_home_lookup');
});

test('lookupOriginalWorkerRunStatus requires launchRequestId and ignores unrelated newer rows for the same worker run id', async () => {
  const { default: Database } = await import('better-sqlite3');
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const workerDir = path.join(hqRoot, 'workers', 'codex-lac-666a');
  const ledgerDbPath = path.join(hqRoot, 'session-ledger.sqlite');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({
    ownerUser: 'placey',
    ledgerDbPath,
  }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'codex-lac-666a',
    launchRequestId: 'lrq_lookup_target',
  }));
  writeFileSync(path.join(workerDir, 'run.json'), JSON.stringify({
    runId: 'run_lookup_shared',
  }));

  const db = new Database(ledgerDbPath);
  db.exec('CREATE TABLE worker_runs (run_id TEXT, launch_request_id TEXT, status TEXT)');
  db.prepare('INSERT INTO worker_runs (run_id, launch_request_id, status) VALUES (?, ?, ?)')
    .run('run_lookup_shared', 'lrq_lookup_target', 'running');
  db.prepare('INSERT INTO worker_runs (run_id, launch_request_id, status) VALUES (?, ?, ?)')
    .run('run_lookup_shared', 'lrq_lookup_newer', 'cancelled');
  db.close();

  const result = await lookupOriginalWorkerRunStatus({
    workerDir,
    hqRoot,
    env: {},
  });

  assert.equal(result.found, true);
  assert.equal(result.status, 'running');
  assert.equal(result.launchRequestId, 'lrq_lookup_target');
  assert.equal(result.runId, 'run_lookup_shared');
});

test('lookupOriginalWorkerRunStatus accepts lrq aliases from worker metadata', async () => {
  const { default: Database } = await import('better-sqlite3');
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const workerDir = path.join(hqRoot, 'workers', 'codex-lac-666alias');
  const ledgerDbPath = path.join(hqRoot, 'session-ledger.sqlite');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({
    ownerUser: 'placey',
    ledgerDbPath,
  }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'codex-lac-666alias',
    lrq: 'lrq_alias',
  }));
  writeFileSync(path.join(workerDir, 'run.json'), JSON.stringify({
    runId: 'run_alias',
  }));

  const db = new Database(ledgerDbPath);
  db.exec('CREATE TABLE worker_runs (run_id TEXT, launch_request_id TEXT, status TEXT)');
  db.prepare('INSERT INTO worker_runs (run_id, launch_request_id, status) VALUES (?, ?, ?)')
    .run('run_alias', 'lrq_alias', 'failed');
  db.close();

  const result = await lookupOriginalWorkerRunStatus({
    workerDir,
    hqRoot,
    env: {},
  });

  assert.equal(result.found, true);
  assert.equal(result.status, 'failed');
  assert.equal(result.launchRequestId, 'lrq_alias');
  assert.equal(result.runId, 'run_alias');
});

// Regression for the 2026-05-18 outage where merge-agent emitted false
// `original-worker-run-row-missing-but-worktree-present` deferrals for
// every newly-provisioned worker (PRs #661 #664 #665 stuck >6h).
//
// Root cause: resolveSessionLedgerDbPath picked the managed-service-root
// DB (/Users/<owner>/.agent-os/session-ledger/ledger.db, updated only by
// the session-ledger service-refresh loop) ahead of the deploy-checkout
// DB (<deploy>/.agent-os/session-ledger/ledger.db, where the dispatch
// daemon actually writes worker_runs). When service-refresh lagged or
// wedged, the merge-agent read a stale snapshot and never saw the rows
// the daemon had just written.

test('resolveSessionLedgerDbPath prefers AGENT_OS_DEPLOY_CHECKOUT/.agent-os/session-ledger/ledger.db over managed-service-root fallback', () => {
  const deployCheckout = mkdtempSync(path.join(tmpdir(), 'agent-os-deploy-'));
  const homeDir = mkdtempSync(path.join(tmpdir(), 'agent-os-home-'));
  const deployLedgerDir = path.join(deployCheckout, '.agent-os', 'session-ledger');
  const homeLedgerDir = path.join(homeDir, '.agent-os', 'session-ledger');
  const deployLedgerDbPath = path.join(deployLedgerDir, 'ledger.db');
  const homeLedgerDbPath = path.join(homeLedgerDir, 'ledger.db');
  mkdirSync(deployLedgerDir, { recursive: true });
  mkdirSync(homeLedgerDir, { recursive: true });
  writeFileSync(deployLedgerDbPath, '');
  writeFileSync(homeLedgerDbPath, '');

  const result = resolveSessionLedgerDbPath({
    hqRoot: '/Users/airlock/agent-os-hq',
    env: { AGENT_OS_DEPLOY_CHECKOUT: deployCheckout, HOME: homeDir },
  });

  assert.equal(result, deployLedgerDbPath,
    'When both deploy-checkout DB and managed-service-root DB exist, the '
    + 'deploy-checkout DB must win — the dispatch daemon writes worker_runs '
    + 'there, and reading the managed-service-root DB returns a stale snapshot.');
});

test('resolveSessionLedgerDbPath falls back to HOME-based ledger.db when no deploy-checkout DB exists', () => {
  // Pre-fix behavior must still work when there is no repo-rooted DB
  // (e.g., fresh install, or repo-rooted DB legitimately absent).
  // hqRoot uses a tmpdir path (outside /Users/) so the hqRootOwnerHome
  // regex returns undefined and no /Users/-derived candidates leak in
  // from the test host's actual filesystem.
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-fallback-'));
  const homeDir = mkdtempSync(path.join(tmpdir(), 'agent-os-home-fallback-'));
  const homeLedgerDir = path.join(homeDir, '.agent-os', 'session-ledger');
  const homeLedgerDbPath = path.join(homeLedgerDir, 'ledger.db');
  mkdirSync(homeLedgerDir, { recursive: true });
  writeFileSync(homeLedgerDbPath, '');

  const result = resolveSessionLedgerDbPath({
    hqRoot,
    env: { HOME: homeDir },
  });

  assert.equal(result, homeLedgerDbPath,
    'When no deploy-checkout DB exists, the lookup must still find the '
    + 'HOME-based fallback DB so the merge-agent can operate on hosts '
    + 'where only the service-refresh DB is provisioned.');
});

test('lookupOriginalWorkerRunStatus finds a worker_run row in the deploy-checkout DB even when a stale managed-service-root DB exists alongside (regression: 2026-05-18 false original-worker-run-row-missing-but-worktree-present)', async () => {
  const { default: Database } = await import('better-sqlite3');
  const deployCheckout = mkdtempSync(path.join(tmpdir(), 'agent-os-deploy-'));
  const homeDir = mkdtempSync(path.join(tmpdir(), 'agent-os-home-stale-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const workerDir = path.join(hqRoot, 'workers', 'codex-lac-451-f');
  const deployLedgerDir = path.join(deployCheckout, '.agent-os', 'session-ledger');
  const deployLedgerDbPath = path.join(deployLedgerDir, 'ledger.db');
  const staleLedgerDir = path.join(homeDir, '.agent-os', 'session-ledger');
  const staleLedgerDbPath = path.join(staleLedgerDir, 'ledger.db');
  mkdirSync(workerDir, { recursive: true });
  mkdirSync(deployLedgerDir, { recursive: true });
  mkdirSync(staleLedgerDir, { recursive: true });

  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: 'codex-lac-451-f',
    launchRequestId: 'lrq_f80d593f-44b5-4cf2-9bbf-fd7cfdf002be',
  }));
  writeFileSync(path.join(workerDir, 'run.json'), JSON.stringify({
    runId: 'wrun_2e08dd49-ce66-43cf-9c5f-6acac8bbc227',
  }));

  // Deploy-checkout DB has the row (this is where the dispatch daemon
  // writes). Mirrors the live SQL we verified on 2026-05-18 from
  // /Users/airlock/agent-os/.agent-os/session-ledger/ledger.db.
  const deployDb = new Database(deployLedgerDbPath);
  deployDb.exec('CREATE TABLE worker_runs (run_id TEXT, launch_request_id TEXT, status TEXT)');
  deployDb.prepare('INSERT INTO worker_runs (run_id, launch_request_id, status) VALUES (?, ?, ?)')
    .run('wrun_2e08dd49-ce66-43cf-9c5f-6acac8bbc227', 'lrq_f80d593f-44b5-4cf2-9bbf-fd7cfdf002be', 'succeeded');
  deployDb.close();

  // Managed-service-root DB is empty for this LRQ (simulates a stale
  // service-refresh DB that lags hours behind the daemon's writes).
  // Pre-fix the merge-agent would read this DB and emit
  // `missing-worker-run-row` → false deferral.
  const staleDb = new Database(staleLedgerDbPath);
  staleDb.exec('CREATE TABLE worker_runs (run_id TEXT, launch_request_id TEXT, status TEXT)');
  staleDb.close();

  const result = await lookupOriginalWorkerRunStatus({
    workerDir,
    hqRoot,
    env: { AGENT_OS_DEPLOY_CHECKOUT: deployCheckout, HOME: homeDir },
  });

  assert.equal(result.found, true,
    'Pre-fix: lookup hit the stale managed-service-root DB and returned '
    + '`missing-worker-run-row`, causing merge-agent to defer dispatch on '
    + 'every newly-provisioned worker. Post-fix: the deploy-checkout DB '
    + 'is read first and the row IS found.');
  assert.equal(result.status, 'succeeded');
  assert.equal(result.launchRequestId, 'lrq_f80d593f-44b5-4cf2-9bbf-fd7cfdf002be');
  assert.equal(result.runId, 'wrun_2e08dd49-ce66-43cf-9c5f-6acac8bbc227');
});

test('lookupOriginalWorkerRunStatus defers when launchRequestId is missing even if run.json has a runId', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const workerDir = path.join(hqRoot, 'workers', 'codex-lac-666b');
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(path.join(workerDir, 'run.json'), JSON.stringify({
    runId: 'run_without_lrq',
  }));

  const result = await lookupOriginalWorkerRunStatus({
    workerDir,
    hqRoot,
    env: {},
  });

  assert.equal(result.found, false);
  assert.equal(result.reason, 'missing-launch-request-id');
});

test('prepareOriginalWorkerForMergeAgent records missing launchRequestId as a structured skip', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-666b2';
  const branch = `${originalWorkerId}/LAC-666b2-missing-lrq`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
  }));
  writeFileSync(path.join(workerDir, 'run.json'), JSON.stringify({
    runId: 'run_without_lrq',
  }));
  const logs = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run after missing launchRequestId');
    },
  });

  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, 'missing-launch-request-id');
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].reason, 'missing-launch-request-id');
});

test('dispatchMergeAgentForPR records a skip when worker-run lookup fails operationally', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({ branch: 'codex-lac-666c/LAC-666c-lookup-failure' }),
    prepareOriginalWorkerImpl: async () => ({
      decision: 'skip',
      reason: 'better-sqlite3-unavailable',
      originalWorkerId: 'codex-lac-666c',
      launchRequestId: 'lrq_lookup_failure',
    }),
    execFileImpl: async () => {
      throw new Error('merge-agent dispatch must not run when preflight skips');
    },
    now: '2026-05-17T14:34:30.000Z',
  });

  assert.equal(result.decision, 'dispatch-skipped');
  assert.equal(result.reason, 'better-sqlite3-unavailable');
  const [skipRecord] = listMergeAgentSkippedDispatches(rootDir);
  assert.equal(skipRecord.decision, 'skip-better-sqlite3-unavailable');
});

test('prepareOriginalWorkerForMergeAgent logs a loud error when worker-run lookup dependency is unavailable', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-666c2';
  const branch = `${originalWorkerId}/LAC-666c2-better-sqlite`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_better_sqlite_missing',
  }));
  const infos = [];
  const errors = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: {
      info: (line) => infos.push(JSON.parse(line)),
      error: (line) => errors.push(line),
    },
    lookupRunStatusImpl: async () => ({
      found: false,
      reason: 'better-sqlite3-unavailable',
      detail: 'Cannot find package better-sqlite3',
      launchRequestId: 'lrq_better_sqlite_missing',
      runId: 'run_better_sqlite_missing',
    }),
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run after dependency skip');
    },
  });

  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, 'better-sqlite3-unavailable');
  assert.equal(execCalled, false);
  assert.equal(infos[0].reason, 'better-sqlite3-unavailable');
  assert.match(errors[0], /worker-run lookup dependency unavailable/);
});

test('prepareOriginalWorkerForMergeAgent defers loudly when worker_runs row is missing but worktree is present AND PR is not merge-ready', async () => {
  // Missing worker_runs row + live worktree is an ambiguous ownership
  // state. It must fail closed regardless of PR readiness signals.
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-666c3';
  const branch = `${originalWorkerId}/LAC-666c3-missing-row`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_missing_row',
  }));
  const logs = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch, mergeable: 'CONFLICTING' }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    lookupRunStatusImpl: async () => ({
      found: false,
      reason: 'missing-worker-run-row',
      launchRequestId: 'lrq_missing_row',
      runId: 'run_missing_row',
    }),
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run while worker run row is missing');
    },
    now: '2026-05-17T14:34:45.000Z',
  });

  assert.equal(result.decision, 'deferred');
  assert.equal(result.reason, 'original-worker-run-row-missing-but-worktree-present');
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.dispatch_deferred');
  assert.equal(logs[0].reason, 'original-worker-run-row-missing-but-worktree-present');
});

test('prepareOriginalWorkerForMergeAgent: orphan worktree + missing worker_run row defers even when the PR looks green', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-orphan-rc-'));
  const originalWorkerId = 'codex-test-rc';
  const branch = `${originalWorkerId}/TEST-RC`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const workspaceDir = path.join(hqRoot, 'workspaces', originalWorkerId);
  mkdirSync(workerDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    path.join(workerDir, 'workspace.json'),
    JSON.stringify({ workerId: originalWorkerId, branch, workspacePath: workspaceDir }),
  );
  const logs = [];
  const captureLog = (msg) => {
    try {
      logs.push(JSON.parse(String(msg).replace(/^\[merge-agent\] /, '')));
    } catch {
      logs.push({ raw: String(msg) });
    }
  };
  const logger = { log: captureLog, info: captureLog, error: () => {}, warn: () => {} };
  const result = await prepareOriginalWorkerForMergeAgent({
    job: {
      prNumber: 999,
      branch,
      mergeable: 'MERGEABLE',
      checksConclusion: 'SUCCESS',
      lastVerdict: 'Comment only',
      prState: 'open',
    },
    env: { AGENT_OS_DEPLOY_CHECKOUT: hqRoot, HOME: hqRoot, HQ_ROOT: hqRoot },
    logger,
    lookupRunStatusImpl: async () => ({ found: false, reason: 'missing-worker-run-row', launchRequestId: 'lrq_test-rc' }),
  });
  assert.equal(result.decision, 'deferred');
  assert.equal(result.reason, 'original-worker-run-row-missing-but-worktree-present');
  const deferEvent = logs.find((l) => l.event === 'merge_agent.dispatch_deferred');
  assert.ok(deferEvent, 'expected dispatch_deferred lifecycle event');
  rmSync(hqRoot, { recursive: true, force: true });
});

test('prepareOriginalWorkerForMergeAgent: orphan worktree + operator-approved trigger still defers', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-orphan-oa-'));
  const originalWorkerId = 'codex-test-oa';
  const branch = `${originalWorkerId}/TEST-OA`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const workspaceDir = path.join(hqRoot, 'workspaces', originalWorkerId);
  mkdirSync(workerDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    path.join(workerDir, 'workspace.json'),
    JSON.stringify({ workerId: originalWorkerId, branch, workspacePath: workspaceDir }),
  );
  const result = await prepareOriginalWorkerForMergeAgent({
    job: {
      prNumber: 1001,
      branch,
      mergeable: 'MERGEABLE',
      checksConclusion: 'SUCCESS',
      lastVerdict: 'Comment only',
      prState: 'open',
    },
    trigger: 'operator-approved',
    env: { AGENT_OS_DEPLOY_CHECKOUT: hqRoot, HOME: hqRoot, HQ_ROOT: hqRoot },
    logger: { log: () => {}, info: () => {}, error: () => {}, warn: () => {} },
    lookupRunStatusImpl: async () => ({ found: false, reason: 'missing-worker-run-row', launchRequestId: 'lrq_test-oa' }),
  });
  assert.equal(result.decision, 'deferred');
  assert.equal(result.reason, 'original-worker-run-row-missing-but-worktree-present');
  rmSync(hqRoot, { recursive: true, force: true });
});

test('closed and merged-pending PR state do not bypass active-worker safety', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-666d';
  const branch = `${originalWorkerId}/LAC-666d-pr-state-override`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(path.join(hqRoot, '.hq'), { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(hqRoot, '.hq', 'config.json'), JSON.stringify({ ownerUser: 'placey' }));
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_pr_state_override',
  }));

  let execCalled = false;
  const mergedPending = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch, prState: 'merged-pending' }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    lookupRunStatusImpl: async () => ({
      found: true,
      status: 'running',
      launchRequestId: 'lrq_pr_state_override',
      runId: 'run_pr_state_override',
    }),
    execFileImpl: async () => {
      execCalled = true;
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-17T14:35:00.000Z',
  });
  assert.equal(mergedPending.decision, 'deferred');
  assert.equal(mergedPending.reason, 'worker-run-status-running');
  assert.equal(execCalled, false);

  const closed = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch, prState: 'closed' }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    lookupRunStatusImpl: async () => ({
      found: true,
      status: 'running',
      launchRequestId: 'lrq_pr_state_override',
      runId: 'run_pr_state_override',
    }),
    execFileImpl: async () => {
      execCalled = true;
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-17T14:35:15.000Z',
  });
  assert.equal(closed.decision, 'deferred');
  assert.equal(closed.reason, 'worker-run-status-running');
  assert.equal(execCalled, false);
});

test('prepareOriginalWorkerForMergeAgent converts thrown worker-run lookups into structured skips', async () => {
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-666e';
  const branch = `${originalWorkerId}/LAC-666e-lookup-throw`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_lookup_throw',
  }));
  const logs = [];
  let execCalled = false;

  const result = await prepareOriginalWorkerForMergeAgent({
    job: makeJob({ branch }),
    hqPath: 'hq',
    env: { HQ_ROOT: hqRoot, USER: 'placey' },
    logger: { info: (line) => logs.push(JSON.parse(line)) },
    lookupRunStatusImpl: async () => {
      throw new Error('native sqlite panic');
    },
    execFileImpl: async () => {
      execCalled = true;
      throw new Error('execFileImpl must not run after lookup throw');
    },
  });

  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, 'worker-run-lookup-threw');
  assert.equal(execCalled, false);
  assert.equal(logs[0].event, 'merge_agent.tear_down_skipped');
  assert.equal(logs[0].reason, 'worker-run-lookup-threw');
  assert.match(logs[0].detail, /native sqlite panic/);
});

test('buildMergeAgentPrompt emits the converge-and-merge contract (merge-by-default, major-refactor-only re-review) when no trigger is passed', () => {
  const prompt = buildMergeAgentPrompt(makeJob());
  // No final-pass framing on the clean-verdict path...
  assert.ok(!prompt.includes('Dispatch trigger:'));
  assert.ok(!prompt.includes('final-pass-on-budget-exhausted'));
  assert.ok(!prompt.includes('## Mode: final-pass-on-budget-exhausted'));
  // ...but it MUST carry the converge-and-merge contract so the worker does
  // not default to requesting another review (the PR #898 regression).
  assert.ok(prompt.includes('## Mode: converge-and-merge'));
  assert.ok(prompt.includes('Default action: MERGE'));
  assert.ok(prompt.includes('When in doubt, MERGE'));
  assert.ok(prompt.includes('comment_only_followups.py'));
  assert.ok(prompt.includes('including non-blocking and suggested-fix'));
  assert.ok(prompt.includes('only for major in-PR refactors'));
  assert.ok(prompt.includes('NEVER major in-PR refactors and MUST merge without'));
  assert.ok(prompt.includes('any test or test-fixture'));
  assert.ok(prompt.includes('is "major enough" to re-review, it probably is not'));
  assert.ok(prompt.includes('file the Linear tickets described above and MERGE this PR'));
  // Don't wait on / gate the merge on the adversarial-review's own check.
  assert.ok(prompt.includes('wait only for real external CI'));
  assert.ok(prompt.includes('agent-os/adversarial-gate'));
  // The clean-verdict path never carries the final-pass-only step 3 framing.
  assert.ok(!prompt.includes('the operator did not personally vouch for this head'));
});

test('buildMergeAgentPrompt surfaces final-pass mode + triage contract when trigger is final-pass-on-budget-exhausted', () => {
  const prompt = buildMergeAgentPrompt(makeJob(), {
    trigger: FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  });
  assert.ok(prompt.includes(`Dispatch trigger: ${FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER}`));
  assert.ok(prompt.includes('## Mode: final-pass-on-budget-exhausted'));
  assert.ok(prompt.includes('comment_only_followups.py'));
  assert.ok(prompt.includes('blocker-class'));
  assert.ok(prompt.includes('Apply every actionable in-scope finding inline'));
  assert.ok(prompt.includes('suggestions_unable_to_apply'));
  assert.ok(prompt.includes('blockers_observed'));
  assert.ok(prompt.includes('Default action: MERGE'));
  assert.ok(prompt.includes('Default to MERGE'));
  assert.ok(prompt.includes('wait only for real external CI'));
  assert.ok(prompt.includes('agent-os/adversarial-gate'));
  assert.ok(prompt.includes('Do NOT request another'
    + ' review for light, medium, or even substantial-but-bounded fixes'));
  assert.ok(prompt.includes('only for major in-PR refactors'));
  assert.ok(prompt.includes('NEVER major in-PR refactors and MUST merge without'));
  assert.ok(prompt.includes('is "major enough" to re-review, it probably is not'));
  assert.ok(!prompt.includes('only when the in-PR fix is a major'));
  assert.ok(prompt.includes('file a Linear ticket before'));
  assert.ok(prompt.includes('do not leave the work only as prose in a PR comment'));
  assert.ok(prompt.includes('file the Linear tickets described above and MERGE this PR'));
  assert.ok(prompt.includes('refusal receipt/log summary must include'));
  assert.ok(prompt.includes('only the blocker count plus normalized blocker kinds'));
  assert.ok(prompt.includes('workspace-local'));
  assert.ok(prompt.includes('.adversarial-follow-up/followups-reply.json'));
  assert.ok(prompt.includes('never copy'));
  assert.ok(prompt.includes('quoted secrets'));
  assert.ok(!prompt.includes('deferred-non-trivial'));
  assert.ok(!prompt.includes('defer non-trivial suggestions'));
  assert.ok(!prompt.includes('If triage returns `addressed`, force-push the updated head and exit `awaiting-rereview`'));
  assert.ok(!prompt.includes('`suggestions_unable_to_apply` result must also exit `awaiting-rereview`'));
  assert.ok(!prompt.includes('the next review pass can evaluate the punt'));
  assert.ok(!prompt.includes('operator handoff instead of requesting a same-head rereview'));
  // The stricter-safety-floor framing (step 3) is final-pass-only.
  assert.ok(prompt.includes('the operator did not personally vouch for this head'));
  // Final pass uses its own mode heading, not the clean-verdict one.
  assert.ok(!prompt.includes('## Mode: converge-and-merge'));
});

test('buildMergeAgentPrompt records non-final-pass triggers without injecting either convergence contract block', () => {
  // operator-approved / merge-agent-requested triggers are surfaced for
  // audit but must not get the triage/merge contract — they are operator-
  // driven and keep their own label-scoped semantics.
  const prompt = buildMergeAgentPrompt(makeJob(), { trigger: 'operator-approved' });
  assert.ok(prompt.includes('Dispatch trigger: operator-approved'));
  assert.ok(!prompt.includes('## Mode: final-pass-on-budget-exhausted'));
  assert.ok(!prompt.includes('## Mode: converge-and-merge'));
  assert.ok(!prompt.includes('comment_only_followups.py'));
  assert.ok(!prompt.includes('Default action: MERGE'));
});

test('dispatchMergeAgentForPR honors MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES from the per-call env', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  // process.env does NOT have the flag, but the per-call env does. This is
  // the codex-reviewer-flagged regression: previously the helper read
  // process.env directly and ignored the merged runtime env. With the fix,
  // the per-call env enables the path and we dispatch.
  const hqCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: 'Request changes',
      // Default makeJob() has remediationCurrentRound:1, remediationMaxRounds:1
      // (budget exhausted) so the new path is eligible if the flag is on.
    }),
    env: {
      MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
      MERGE_AGENT_HQ_PROJECT: 'merge-project',
      [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: '1',
    },
    execFileImpl: async (cmd, args, opts) => {
      hqCalls.push({ cmd, args, env: opts?.env });
      return {
        stdout: '{"dispatchId":"disp_final","lrq":"lrq_final"}\n',
      };
    },
    now: '2026-05-14T05:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.trigger, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER);
  // Machine-readable signal in the subprocess env
  assert.equal(
    hqCalls[0].env?.MERGE_AGENT_DISPATCH_TRIGGER,
    FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  );
});

test('dispatchMergeAgentForPR defaults final-pass ON when env unset (no halt at budget-exhausted)', async () => {
  // After 2026-05-16: the env default is ON. With env unset, a
  // budget-exhausted Request-changes PR should still dispatch with the
  // final-pass trigger rather than halting at the operator's desk.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: 'Request changes',
    }),
    env: {
      MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
      MERGE_AGENT_HQ_PROJECT: 'merge-project',
      // flag intentionally absent — defaults to ON
    },
    execFileImpl: async (cmd, args, opts) => {
      hqCalls.push({ cmd, args, env: opts?.env });
      return { stdout: '{"dispatchId":"disp_default_on","lrq":"lrq_default_on"}\n' };
    },
    now: '2026-05-14T05:01:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.trigger, FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER);
  assert.equal(
    hqCalls[0].env?.MERGE_AGENT_DISPATCH_TRIGGER,
    FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  );
});

test('dispatchMergeAgentForPR explicit opt-out preserves the legacy halt path', async () => {
  // Operators who want the legacy halt-at-max-rounds-reached behavior can
  // set MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=0 explicitly.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: 'Request changes',
    }),
    env: {
      MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
      MERGE_AGENT_HQ_PROJECT: 'merge-project',
      [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: '0',
    },
    execFileImpl: async () => {
      throw new Error('execFileImpl should not be reached when explicit opt-out halts');
    },
    now: '2026-05-14T05:02:00.000Z',
  });

  assert.equal(result.decision, 'skip-request-changes');
});

test('dispatchMergeAgentForPR records a durable skip when blocking findings remain', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: 'Request changes',
      blockingFindingCount: 2,
      blockingFindingState: 'known',
    }),
    env: {
      MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
      MERGE_AGENT_HQ_PROJECT: 'merge-project',
      [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: '1',
    },
    execFileImpl: async () => {
      throw new Error('execFileImpl should not be reached when blockers park dispatch');
    },
    now: '2026-05-14T05:03:00.000Z',
  });

  assert.equal(result.decision, 'skip-blockers-present');
  assert.equal(result.blockingFindingCount, 2);
  assert.equal(result.blockingFindingState, 'known');
  assert.ok(result.skippedRecordPath);
  const [skipRecord] = listMergeAgentSkippedDispatches(rootDir);
  assert.equal(skipRecord.decision, 'skip-blockers-present');
  assert.equal(skipRecord.blockingFindingCount, 2);
  assert.equal(skipRecord.blockingFindingState, 'known');
});

test('dispatchMergeAgentForPR records a durable skip when blocking finding state is unknown', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: 'Request changes',
      blockingFindingCount: 0,
      blockingFindingState: 'unknown',
    }),
    env: {
      MERGE_AGENT_PARENT_SESSION: 'session:test:merge-watcher',
      MERGE_AGENT_HQ_PROJECT: 'merge-project',
      [FINAL_PASS_ON_REQUEST_CHANGES_ENV]: '1',
    },
    execFileImpl: async () => {
      throw new Error('execFileImpl should not be reached when unknown blocker state parks dispatch');
    },
    now: '2026-05-14T05:04:00.000Z',
  });

  assert.equal(result.decision, 'skip-blocking-findings-unknown');
  assert.equal(result.blockingFindingState, 'unknown');
  assert.ok(result.skippedRecordPath);
  const [skipRecord] = listMergeAgentSkippedDispatches(rootDir);
  assert.equal(skipRecord.decision, 'skip-blocking-findings-unknown');
  assert.equal(skipRecord.blockingFindingCount, 0);
  assert.equal(skipRecord.blockingFindingState, 'unknown');
});

test('dispatchMergeAgentForPR omits MERGE_AGENT_DISPATCH_TRIGGER from worker env when trigger is null', async () => {
  // Sanity: comment-only verdict dispatches with no trigger; the worker env
  // should NOT carry an empty/null trigger value that downstream code might
  // misread.
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const calls = [];
  await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob(),
    env: { MERGE_AGENT_PARENT_SESSION: 's', MERGE_AGENT_HQ_PROJECT: 'p' },
    execFileImpl: async (cmd, args, opts) => {
      calls.push(opts?.env);
      return { stdout: '{"dispatchId":"d","lrq":"l"}\n' };
    },
    now: '2026-05-14T05:02:00.000Z',
  });
  assert.ok(!('MERGE_AGENT_DISPATCH_TRIGGER' in (calls[0] || {})));
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
  // Filter to remove-label calls only — the add of `merge-agent-dispatched`
  // (new in PR D) ALSO routes through ghExecFileImpl, but is asserted
  // separately below; the invariant here is "exactly one trigger-label
  // removal happens".
  const removes = ghCalls.filter((c) => c.args.includes('--remove-label'));
  assert.equal(removes.length, 1);
  assert.equal(removes[0].args.at(-1), 'merge-agent-requested');
  // And the merge-agent-dispatched marker MUST be applied (PR D).
  const adds = ghCalls.filter((c) => c.args.includes('--add-label'));
  assert.equal(adds.length, 1);
  assert.equal(adds[0].args.at(-1), 'merge-agent-dispatched');
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
  // Filter to remove-label calls only — the add of `merge-agent-dispatched`
  // (new in PR D) ALSO routes through ghExecFileImpl. The invariant
  // pinned here is "only operator-approved is removed, NOT merge-agent-
  // requested" — even though both labels are present, only the trigger
  // gets cleared.
  const removes = ghCalls.filter((c) => c.args.includes('--remove-label'));
  assert.equal(removes.length, 1);
  assert.equal(removes[0].args.at(-1), 'operator-approved');
  // And the merge-agent-dispatched marker MUST be applied (PR D).
  const adds = ghCalls.filter((c) => c.args.includes('--add-label'));
  assert.equal(adds.length, 1);
  assert.equal(adds[0].args.at(-1), 'merge-agent-dispatched');
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

test('dispatchMergeAgentForPR retries a failed same-head dispatch when merge-agent-requested is applied again', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const failedLrq = 'lrq_11111111-1111-1111-1111-111111111111';
  const retryLrq = 'lrq_22222222-2222-2222-2222-222222222222';
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
      stdout: `{"dispatchId":"disp_failed","lrq":"${failedLrq}"}\n`,
    }),
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    now: '2026-05-20T12:00:00.000Z',
  });

  const hqCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      lastVerdict: null,
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest({ createdAt: '2026-05-20T12:05:00.000Z' }),
      mergeable: 'CONFLICTING',
      checksConclusion: 'PENDING',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    }),
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args });
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"failed"}\n', stderr: '' };
      }
      return { stdout: `{"dispatchId":"disp_retry","lrq":"${retryLrq}"}\n`, stderr: '' };
    },
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    now: '2026-05-20T12:06:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.trigger, 'merge-agent-requested');
  assert.equal(result.dispatchId, 'disp_retry');
  assert.equal(hqCalls.length, 2);
  assert.deepEqual(hqCalls[0].args.slice(0, 3), ['dispatch', 'status', failedLrq]);
  assert.equal(hqCalls[1].args[0], 'dispatch');
  const [recorded] = listMergeAgentDispatches(rootDir);
  assert.equal(recorded.launchRequestId, retryLrq);
});

test('dispatchMergeAgentForPR recovers a bound-exhausted stuck PR when merge-agent-requested is applied on the current head', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const failedLrq = 'lrq_11111111-1111-1111-1111-111111111111';
  const retryLrq = 'lrq_33333333-3333-3333-3333-333333333333';

  recordMergeAgentDispatch(rootDir, makeJob({
    labels: [{ name: 'merge-agent-stuck' }, { name: 'merge-agent-requested' }],
    lastVerdict: 'Request changes',
    mergeable: 'CONFLICTING',
    checksConclusion: 'PENDING',
    remediationCurrentRound: 2,
    remediationMaxRounds: 2,
  }), {
    dispatchedAt: '2026-05-24T12:00:00.000Z',
    prompt: 'seed',
    dispatchId: failedLrq,
    launchRequestId: failedLrq,
    trigger: null,
    watcherReDispatchCount: 2,
  });

  const hqCalls = [];
  const ghCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      labels: [{ name: 'merge-agent-stuck' }, { name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest({ createdAt: '2026-05-24T12:05:00.000Z' }),
      lastVerdict: 'Request changes',
      mergeable: 'CONFLICTING',
      checksConclusion: 'PENDING',
      remediationCurrentRound: 2,
      remediationMaxRounds: 2,
    }),
    execFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args });
      if (args[0] === 'dispatch' && args[1] === 'status') {
        return { stdout: '{"status":"failed"}\n', stderr: '' };
      }
      return { stdout: `{"dispatchId":"disp_retry","lrq":"${retryLrq}"}\n`, stderr: '' };
    },
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-24T12:06:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.trigger, 'merge-agent-requested');
  assert.equal(result.dispatchId, 'disp_retry');
  assert.equal(hqCalls.length, 2);
  assert.deepEqual(hqCalls[0].args.slice(0, 3), ['dispatch', 'status', failedLrq]);
  assert.ok(
    ghCalls.some(({ args }) => args.includes('--remove-label') && args.at(-1) === 'merge-agent-requested'),
    'the consumed recovery label should be removed after dispatch'
  );
  const [recorded] = listMergeAgentDispatches(rootDir);
  assert.equal(recorded.launchRequestId, retryLrq);
  assert.equal(recorded.trigger, 'merge-agent-requested');
  assert.equal(recorded.watcherReDispatchCount, 2);
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

test('dispatchMergeAgentForPR merges env overrides for detection, args, and launch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];
  const env = {
    PATH: '/custom/bin:/usr/bin',
    MERGE_AGENT_PARENT_SESSION: 'session:test:custom-parent',
    MERGE_AGENT_HQ_PROJECT: 'custom-project',
  };
  const originalInherited = process.env.ADV_REVIEW_ENV_MERGE_TEST;
  process.env.ADV_REVIEW_ENV_MERGE_TEST = 'from-process-env';
  try {
    const result = await dispatchMergeAgentForPR({
      agentOsDetectImpl: (options) => detectAgentOsPresence({
        ...options,
        fsImpl: {
          statSync: (candidate) => ({
            isFile: () => candidate === '/custom/bin/hq',
          }),
          accessSync: (candidate) => {
            if (candidate !== '/custom/bin/hq') {
              throw new Error(`unexpected executable probe: ${candidate}`);
            }
          },
        },
      }),
      env,
      rootDir,
      ...makeJob(),
      execFileImpl: async (cmd, args, options) => {
        hqCalls.push({ cmd, args, options });
        return { stdout: '{"dispatchId":"disp_path_env","lrq":"lrq_path_env"}\n' };
      },
      now: '2026-05-07T12:06:00.000Z',
    });

    assert.equal(result.decision, 'dispatch');
    assert.equal(result.dispatchId, 'disp_path_env');
    assert.equal(hqCalls.length, 1);
    assert.equal(hqCalls[0].cmd, '/custom/bin/hq');
    assert.equal(hqCalls[0].options.env.PATH, env.PATH);
    assert.equal(hqCalls[0].options.env.MERGE_AGENT_PARENT_SESSION, env.MERGE_AGENT_PARENT_SESSION);
    assert.equal(hqCalls[0].options.env.MERGE_AGENT_HQ_PROJECT, env.MERGE_AGENT_HQ_PROJECT);
    assert.equal(hqCalls[0].options.env.ADV_REVIEW_ENV_MERGE_TEST, 'from-process-env');
    assert.equal(hqCalls[0].options.timeout, HQ_DISPATCH_TIMEOUT_MS);
    assert.equal(hqCalls[0].options.killSignal, 'SIGTERM');
    assert.match(hqCalls[0].args.join(' '), /--parent-session session:test:custom-parent/);
    assert.match(hqCalls[0].args.join(' '), /--project custom-project/);
  } finally {
    if (originalInherited === undefined) {
      delete process.env.ADV_REVIEW_ENV_MERGE_TEST;
    } else {
      process.env.ADV_REVIEW_ENV_MERGE_TEST = originalInherited;
    }
  }
});

test('dispatchMergeAgentForPR gives explicit hqPath precedence over HQ_BIN', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: (options) => detectAgentOsPresence({
      ...options,
      fsImpl: {
        statSync: (candidate) => ({
          isFile: () => candidate === '/custom/agent-os/hq',
        }),
        accessSync: (candidate) => {
          if (candidate !== '/custom/agent-os/hq') {
            throw new Error(`unexpected executable probe: ${candidate}`);
          }
        },
      },
    }),
    env: { HQ_BIN: '/wrong/agent-os/hq', PATH: '/does-not-matter' },
    hqPath: '/custom/agent-os/hq',
    rootDir,
    ...makeJob(),
    execFileImpl: async (cmd, args, options) => {
      hqCalls.push({ cmd, args, options });
      return { stdout: '{"dispatchId":"disp_hq_path","lrq":"lrq_hq_path"}\n' };
    },
    now: '2026-05-07T12:07:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(hqCalls.length, 1);
  assert.equal(hqCalls[0].cmd, '/custom/agent-os/hq');
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
  assert.equal(candidate.checksConclusion, 'SUCCESS');
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

test('dispatchMergeAgentForPR defers override-triggered dispatch when orphan-worktree liveness is ambiguous', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const hqRoot = mkdtempSync(path.join(tmpdir(), 'agent-os-hq-'));
  const originalWorkerId = 'codex-lac-661b';
  const branch = `${originalWorkerId}/LAC-661b-orphan`;
  const workerDir = path.join(hqRoot, 'workers', originalWorkerId);
  const worktreePath = path.join(workerDir, 'agent-os');
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(path.join(workerDir, 'workspace.json'), JSON.stringify({
    workerId: originalWorkerId,
    workspacePath: worktreePath,
    worktreePath,
    branch,
    launchRequestId: 'lrq_orphan',
  }));

  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({
      branch,
      lastVerdict: null,
      labels: [{ name: 'merge-agent-requested' }],
      mergeAgentRequest: makeMergeAgentRequest(),
      mergeable: 'MERGEABLE',
      checksConclusion: 'SUCCESS',
      remediationCurrentRound: 0,
      remediationMaxRounds: 0,
    }),
    env: { HQ_ROOT: hqRoot },
    prepareOriginalWorkerImpl: (opts) => prepareOriginalWorkerForMergeAgent({
      ...opts,
      lookupRunStatusImpl: async () => ({
        found: false,
        reason: 'missing-worker-run-row',
        launchRequestId: 'lrq_orphan',
      }),
    }),
    execFileImpl: async () => {
      throw new Error('hq must not dispatch while original-worker liveness is ambiguous');
    },
    now: '2026-05-18T13:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch-deferred');
  assert.equal(result.reason, 'original-worker-run-row-missing-but-worktree-present');
  assert.equal(listMergeAgentDispatches(rootDir).length, 0);
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

test('dispatchMergeAgentForPR records skip-no-agent-os and clears consumed trigger labels', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const ghCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: () => ({ present: false, source: 'not-found' }),
    rootDir,
    ...makeJob({
      lastVerdict: 'Request changes',
      labels: [{ name: 'operator-approved' }],
      operatorApproval: makeOperatorApproval(),
    }),
    execFileImpl: async () => {
      throw new Error('hq must not be invoked when agent-os is absent');
    },
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(result.decision, 'skip-no-agent-os');
  assert.equal(result.trigger, 'operator-approved');
  assert.equal(result.operatorApprovalLabelRemoved, true);
  assert.equal(ghCalls.length, 1);
  assert.equal(ghCalls[0].args.at(-1), 'operator-approved');
  assert.equal(listMergeAgentDispatches(rootDir).length, 0);

  const [skipRecord] = listMergeAgentSkippedDispatches(rootDir);
  assert.equal(skipRecord.decision, 'skip-no-agent-os');
  assert.equal(skipRecord.trigger, 'operator-approved');
  assert.equal(skipRecord.agentOsDetectionSource, 'not-found');
  assert.equal(skipRecord.labelRemoval.removed, true);
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
      statSync: (candidate) => ({
        isFile: () => candidate === '/usr/local/bin/hq',
      }),
      accessSync: (p) => {
        if (p !== '/usr/local/bin/hq') throw new Error('not found');
      },
    },
  });
  assert.deepEqual(state, { present: true, source: 'env:HQ_BIN', path: '/usr/local/bin/hq' });
});

test('detectAgentOsPresence: explicit hqPath wins over ambient HQ_BIN', () => {
  const state = detectAgentOsPresence({
    hqPath: '/custom/agent-os/hq',
    env: { HQ_BIN: '/usr/local/bin/hq', PATH: '/usr/local/bin' },
    fsImpl: {
      statSync: (candidate) => ({
        isFile: () => candidate === '/custom/agent-os/hq',
      }),
      accessSync: (p) => {
        if (p !== '/custom/agent-os/hq') throw new Error('not found');
      },
    },
  });
  assert.deepEqual(state, { present: true, source: 'arg:hqPath', path: '/custom/agent-os/hq' });
});

test('detectAgentOsPresence: PATH-resolved hq path is detected as present without external which', () => {
  const state = detectAgentOsPresence({
    env: { PATH: '/bin:/Users/airlock/.local/bin' },
    fsImpl: {
      statSync: (candidate) => ({
        isFile: () => candidate === '/Users/airlock/.local/bin/hq',
      }),
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
      statSync: () => ({ isFile: () => true }),
      accessSync: () => {
        throw new Error('not executable');
      },
    },
  });
  assert.deepEqual(state, { present: false, source: 'not-found' });
});

test('detectAgentOsPresence: HQ_BIN pointing to a directory returns not-found', () => {
  const state = detectAgentOsPresence({
    env: { HQ_BIN: '/usr/local/bin/hq' },
    fsImpl: {
      statSync: () => ({ isFile: () => false }),
      accessSync: () => {
        throw new Error('directories must not be treated as executables');
      },
    },
  });
  assert.deepEqual(state, { present: false, source: 'not-found' });
});

// ───────────────────────────────────────────────────────────────────────────
// PR D: merge-agent-dispatched label + cancel-on-merge + prompt preamble.
// ───────────────────────────────────────────────────────────────────────────

test('buildMergeAgentPrompt includes an abort-if-closed preamble naming the PR + repo', () => {
  const job = {
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    branch: 'codex-adag-13-r7/ADAG-13',
    baseBranch: 'main',
    headSha: 'eb7277e8e6f651e1627c1dd6af1ec1ad57362fe1',
  };
  const prompt = buildMergeAgentPrompt(job);
  assert.match(prompt, /## Preamble: abort if PR is no longer open/);
  assert.match(prompt, /gh pr view 661 --repo laceyenterprises\/agent-os --json state,mergedAt,closedAt/);
  assert.match(prompt, /MERGED/);
  assert.match(prompt, /CLOSED/);
  assert.match(prompt, /abort this session immediately/);
});

test('addMergeAgentDispatchedLabel applies the label via gh pr edit', async () => {
  const { addMergeAgentDispatchedLabel } = await import('../src/follow-up-merge-agent.mjs');
  const calls = [];
  const result = await addMergeAgentDispatchedLabel({
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    ghExecFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-18T13:00:00.000Z',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, [
    'pr', 'edit', '661',
    '--repo', 'laceyenterprises/agent-os',
    '--add-label', 'merge-agent-dispatched',
  ]);
  assert.equal(result.added, true);
  assert.equal(result.label, 'merge-agent-dispatched');
  assert.equal(result.error, null);
});

test('addMergeAgentDispatchedLabel logs but does not throw on gh failure', async () => {
  const { addMergeAgentDispatchedLabel } = await import('../src/follow-up-merge-agent.mjs');
  const result = await addMergeAgentDispatchedLabel({
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    ghExecFileImpl: async () => {
      throw new Error('gh: HTTP 422 label not found');
    },
    now: '2026-05-18T13:00:00.000Z',
  });
  // Critical: failure MUST NOT throw or roll back the dispatch.
  assert.equal(result.added, false);
  assert.match(result.error, /HTTP 422/);
});

test('dispatchMergeAgentForPR adds merge-agent-dispatched label after successful hq dispatch', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const ghCalls = [];
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob(),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_label","lrq":"lrq_label"}\n',
    }),
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    now: '2026-05-18T13:00:00.000Z',
  });
  assert.equal(result.decision, 'dispatch');
  assert.equal(result.dispatchedLabelAdded, true);
  // Default makeJob has no trigger label → no remove call. The single
  // gh call MUST be the merge-agent-dispatched add.
  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0].args.slice(-2), ['--add-label', 'merge-agent-dispatched']);
});

test('dispatchMergeAgentForPR records retryable lifecycle cleanup when dispatched label add fails', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  const result = await dispatchMergeAgentForPR({
    agentOsDetectImpl: AGENT_OS_PRESENT_STUB,
    rootDir,
    ...makeJob({ prNumber: 661, headSha: 'sha-label-fail' }),
    execFileImpl: async () => ({
      stdout: '{"dispatchId":"disp_label_fail","lrq":"lrq_label_fail"}\n',
    }),
    ghExecFileImpl: async () => {
      throw new Error('gh: transient label write failure');
    },
    now: '2026-05-18T13:00:00.000Z',
  });

  assert.equal(result.decision, 'dispatch');
  assert.equal(result.dispatchedLabelAdded, false);
  assert.match(result.dispatchedLabelError, /transient label write failure/);
  const [cleanup] = listMergeAgentLifecycleCleanups(rootDir);
  assert.equal(cleanup.repo, 'laceyenterprises/agent-os');
  assert.equal(cleanup.prNumber, 661);
  assert.equal(cleanup.transition, MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION);
  assert.equal(cleanup.headSha, 'sha-label-fail');
  assert.equal(cleanup.lastResult.retryable, true);
});

test('cancelMergeAgentDispatchOnMerge cancels the latest dispatch + removes the label', async () => {
  const { cancelMergeAgentDispatchOnMerge, recordMergeAgentDispatch } = await import('../src/follow-up-merge-agent.mjs');
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  // Seed two dispatch records — cancel-on-merge should pick the latest.
  recordMergeAgentDispatch(rootDir, makeJob({ prNumber: 661 }), {
    dispatchedAt: '2026-05-18T03:00:00.000Z',
    prompt: 'old',
    dispatchId: 'disp_old',
    launchRequestId: 'lrq_old',
    trigger: null,
  });
  recordMergeAgentDispatch(rootDir, makeJob({ prNumber: 661 }), {
    dispatchedAt: '2026-05-18T12:00:00.000Z',
    prompt: 'new',
    dispatchId: 'disp_new',
    launchRequestId: 'lrq_new',
    trigger: null,
  });

  const ghCalls = [];
  const hqCalls = [];
  const result = await cancelMergeAgentDispatchOnMerge({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    hqPath: '/usr/local/bin/hq',
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    hqExecFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args });
      return { stdout: 'cancelled\n', stderr: '' };
    },
    now: '2026-05-18T13:00:00.000Z',
  });

  // Cancel hits the LATEST LRQ.
  assert.equal(result.launchRequestId, 'lrq_new');
  assert.equal(result.cancelled, true);
  assert.equal(hqCalls.length, 1);
  assert.deepEqual(hqCalls[0].args, ['dispatch', 'cancel', 'lrq_new']);

  assert.equal(result.labelRemoved, true);
  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0].args, [
    'pr', 'edit', '661',
    '--repo', 'laceyenterprises/agent-os',
    '--remove-label', 'merge-agent-dispatched',
  ]);
});

test('cancelMergeAgentDispatchOnMerge filters dispatch records by repo and PR before selecting LRQ', async () => {
  const { cancelMergeAgentDispatchOnMerge, recordMergeAgentDispatch } = await import('../src/follow-up-merge-agent.mjs');
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, makeJob({ repo: 'laceyenterprises/agent-os', prNumber: 661 }), {
    dispatchedAt: '2026-05-18T12:00:00.000Z',
    prompt: 'matching',
    dispatchId: 'disp_matching',
    launchRequestId: 'lrq_matching',
    trigger: null,
  });
  recordMergeAgentDispatch(rootDir, makeJob({ repo: 'laceyenterprises/adversarial-review', prNumber: 133 }), {
    dispatchedAt: '2026-05-18T12:30:00.000Z',
    prompt: 'newer but unrelated',
    dispatchId: 'disp_unrelated',
    launchRequestId: 'lrq_unrelated',
    trigger: null,
  });

  const hqCalls = [];
  const result = await cancelMergeAgentDispatchOnMerge({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    hqPath: '/usr/local/bin/hq',
    ghExecFileImpl: async () => ({ stdout: '', stderr: '' }),
    hqExecFileImpl: async (cmd, args) => {
      hqCalls.push({ cmd, args });
      return { stdout: 'cancelled\n', stderr: '' };
    },
    now: '2026-05-18T13:00:00.000Z',
  });

  assert.equal(result.launchRequestId, 'lrq_matching');
  assert.deepEqual(hqCalls[0].args, ['dispatch', 'cancel', 'lrq_matching']);
});

test('cancelMergeAgentDispatchOnMerge removes the label after a terminal cancel failure', async () => {
  const { cancelMergeAgentDispatchOnMerge, recordMergeAgentDispatch } = await import('../src/follow-up-merge-agent.mjs');
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, makeJob({ prNumber: 661 }), {
    dispatchedAt: '2026-05-18T12:00:00.000Z',
    prompt: 'p',
    dispatchId: 'disp_x',
    launchRequestId: 'lrq_x',
    trigger: null,
  });

  let labelRemoved = false;
  const result = await cancelMergeAgentDispatchOnMerge({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    hqPath: '/usr/local/bin/hq',
    ghExecFileImpl: async () => {
      labelRemoved = true;
      return { stdout: '', stderr: '' };
    },
    hqExecFileImpl: async () => {
      throw new Error('hq: dispatch cancel failed — already terminated');
    },
    now: '2026-05-18T13:00:00.000Z',
  });

  assert.equal(result.cancelled, false);
  assert.match(result.cancelError, /already terminated/);
  assert.equal(labelRemoved, true);
  assert.equal(result.labelRemoved, true);
  assert.equal(result.cleanupComplete, true);
  assert.equal(result.retryable, false);
});

test('cancelMergeAgentDispatchOnMerge treats "already terminal" stdout JSON as terminal (2026-05-19 fix)', async () => {
  // 2026-05-19 incident: `hq dispatch cancel` for an already-terminal LRQ
  // exits non-zero with the explanation
  //   {"ok":false,"reason":"already terminal (status=failed)","currentStatus":"failed"}
  // on STDOUT (not stderr). The watcher's err.message was the bare
  // "Command failed: hq dispatch cancel <lrq>" — the old regex didn't
  // match "already terminal", so every retry tick logged retryable=true
  // and the cancel loop never converged. Fix: parse the structured
  // stdout via isTerminalMergeAgentCancelDetail.
  const { cancelMergeAgentDispatchOnMerge, recordMergeAgentDispatch } = await import('../src/follow-up-merge-agent.mjs');
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, {
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    headSha: 'c055d93d02abfb41fbab56c46ac631982f84fd66',
  }, {
    dispatchedAt: '2026-05-19T02:47:02.429Z',
    prompt: '',
    dispatchId: 'lrq_069112b8-68a3-48d8-acac-46c026c2349c',
    launchRequestId: 'lrq_069112b8-68a3-48d8-acac-46c026c2349c',
    trigger: null,
  });

  let labelRemoved = false;
  const result = await cancelMergeAgentDispatchOnMerge({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 719,
    hqPath: '/usr/local/bin/hq',
    ghExecFileImpl: async () => {
      labelRemoved = true;
      return { stdout: '', stderr: '' };
    },
    hqExecFileImpl: async () => {
      // Simulate the actual `hq dispatch cancel` behavior: exit non-zero
      // with structured JSON on stdout (not stderr) explaining the LRQ
      // is already terminal.
      const err = new Error('Command failed: hq dispatch cancel lrq_069112b8-...');
      err.code = 1;
      err.stdout = JSON.stringify({
        ok: false,
        reason: 'already terminal (status=failed)',
        currentStatus: 'failed',
      });
      err.stderr = '';
      throw err;
    },
    now: '2026-05-19T03:30:00.000Z',
  });

  assert.equal(result.cancelled, false);
  // err.message ("Command failed: …") doesn't contain "already terminal",
  // but the structured stdout does. The classifier must read stdout.
  assert.equal(result.cleanupComplete, true, 'cleanup must converge on terminal LRQ');
  assert.equal(result.retryable, false, 'must NOT retry — LRQ is already terminal');
  assert.equal(labelRemoved, true);
  assert.equal(result.labelRemoved, true);
  // Result fields the proactive-stuck-scan + log surfacing depend on.
  assert.ok(result.cancelStdout && result.cancelStdout.includes('already terminal'),
    'cancelStdout must surface structured cancel response');
});

test('cancelMergeAgentDispatchOnMerge keeps the label when cancel fails transiently', async () => {
  const { cancelMergeAgentDispatchOnMerge, recordMergeAgentDispatch } = await import('../src/follow-up-merge-agent.mjs');
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));
  recordMergeAgentDispatch(rootDir, makeJob({ prNumber: 661 }), {
    dispatchedAt: '2026-05-18T12:00:00.000Z',
    prompt: 'p',
    dispatchId: 'disp_x',
    launchRequestId: 'lrq_x',
    trigger: null,
  });

  let ghCalled = false;
  const result = await cancelMergeAgentDispatchOnMerge({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    hqPath: '/usr/local/bin/hq',
    ghExecFileImpl: async () => {
      ghCalled = true;
      return { stdout: '', stderr: '' };
    },
    hqExecFileImpl: async () => {
      throw new Error('hq: dispatch cancel failed — daemon unavailable');
    },
    now: '2026-05-18T13:00:00.000Z',
  });

  assert.equal(result.cancelled, false);
  assert.match(result.cancelError, /daemon unavailable/);
  assert.equal(ghCalled, false);
  assert.equal(result.labelRemoved, false);
  assert.equal(result.cleanupComplete, false);
  assert.equal(result.retryable, true);
});

test('cancelMergeAgentDispatchOnMerge removes label even when no dispatch record exists', async () => {
  // Edge case: dispatch record dir wiped, OR label applied by some
  // other tool. We still clean up the label so the watcher stops
  // retrying on this PR.
  const { cancelMergeAgentDispatchOnMerge } = await import('../src/follow-up-merge-agent.mjs');
  const rootDir = mkdtempSync(path.join(tmpdir(), 'adversarial-review-'));

  const ghCalls = [];
  const result = await cancelMergeAgentDispatchOnMerge({
    rootDir,
    repo: 'laceyenterprises/agent-os',
    prNumber: 661,
    hqPath: '/usr/local/bin/hq',
    ghExecFileImpl: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    },
    hqExecFileImpl: async () => {
      throw new Error('should not be called when no LRQ found');
    },
    now: '2026-05-18T13:00:00.000Z',
  });

  assert.equal(result.launchRequestId, null);
  assert.equal(result.cancelled, false);
  assert.equal(result.labelRemoved, true);
  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0].args.slice(-2), ['--remove-label', 'merge-agent-dispatched']);
});
