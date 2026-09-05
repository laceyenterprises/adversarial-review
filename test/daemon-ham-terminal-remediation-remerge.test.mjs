import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  headHasValidatedHamTerminalRemediation,
  runDaemonCleanMergeAttempt,
} from '../src/daemon-clean-merge.mjs';
import { DAEMON_MERGE_DISPOSITION } from '../src/ama/daemon-merge.mjs';

// The daemon HAM terminal-remediation re-merge (this fix): a findings-present PR
// whose CURRENT head an entitled hammer already remediated AND validated under
// the merge lease, but could not land because GitHub required checks had not gone
// green inside the hammer's bounded remote-CI wait window. With no live worker
// left, the daemon lands it on a later tick once CI settles — no fresh hammer, no
// per-head hammer retry cap consumption — while STILL re-verifying green CI +
// mergeable + head-match live.

const REVIEWED_HEAD = 'reviewed-head-x0000000000000000000000000';
const HAM_HEAD = 'ham-remediation-head-y0000000000000000000';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'daemon-ham-remerge-'));
}

// Mirrors the durable attempt the hammer writes via ama-audit while holding the
// merge lease (templates/hammer-prompt.md): validated head-match marker + an
// embedded ama-check eligibility trace whose hamTerminalRemediation.ok is true.
// eligible:false here on purpose — the hammer recorded this attempt when it gave
// up waiting for still-pending required CI (ci-not-green in the trace).
function hamValidatedAuditEntry(head) {
  return {
    status: 'failed-without-merge',
    attempts: [
      {
        attemptNumber: 1,
        preMergeEligible: false,
        attemptPhase: 'hammer-gh-pr-merge',
        headMatchEvidence: 'ham_terminal_remediation_validated',
        validatedHead: head,
        reason: 'github-gate-timeout',
        remoteCiStatus: 'remote-ci-timeout',
        eligibilityTrace: {
          eligible: false,
          reasons: ['ci-not-green'],
          trace: { hamTerminalRemediation: { ok: true } },
        },
      },
    ],
  };
}

const GREEN_CHECK = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' };

function findingsReviewArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    cfg: {
      mergeMethod: 'squash',
      autonomousMergeExecutionEnabled: true,
      strictMode: true,
      lha: { consumeAttestations: false },
      requiredCheckContexts: ['ci/lint', 'ci/test'],
    },
    repoPath: 'acme/repo',
    prNumber: 4987,
    candidate: {
      baseBranch: 'main',
      headSha: HAM_HEAD,
      statusCheckRollup: [GREEN_CHECK],
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      prState: 'open',
      branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
    },
    gateSnapshot: {
      reviewedHeadSha: REVIEWED_HEAD,
      settledReview: { verdict: 'changes-requested' },
    },
    mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    // Blocking finding present → NOT daemon-clean.
    reviewState: {
      headSha: REVIEWED_HEAD,
      riskClass: 'low',
      blockingFindingCount: 1,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      nonBlockingFindingState: 'known',
    },
    reviewStateRow: { reviewer: 'codex' },
    currentPrHeadSha: HAM_HEAD,
    fetchRollupImpl: async () => ({
      state: 'OPEN',
      headSha: HAM_HEAD,
      headRefName: 'ham/branch',
      statusCheckRollup: [GREEN_CHECK],
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }),
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: { launch_request_id: 'lrq_hammer', worker_class: 'hammer', head_sha: HAM_HEAD },
    }),
    acquireMergeLeaseImpl: () => ({
      acquired: true,
      lease: {
        repo: 'acme/repo',
        base: 'main',
        leaseId: 'lease-1',
        holderPr: 4987,
        holderHead: HAM_HEAD,
        acquiredAt: '2026-08-06T00:00:00.000Z',
      },
    }),
    releaseMergeLeaseImpl: () => {},
    logger: { warn() {}, log() {} },
    env: { HQ_ROOT: rootDir },
    ...overrides,
  };
}

test('headHasValidatedHamTerminalRemediation: true when a validated attempt matches the head', () => {
  const ok = headHasValidatedHamTerminalRemediation({
    hqRoot: '/tmp/hq',
    repo: 'acme/repo',
    prNumber: 4987,
    headSha: HAM_HEAD,
    readAmaAuditEntryImpl: () => hamValidatedAuditEntry(HAM_HEAD),
  });
  assert.equal(ok, true);
});

test('headHasValidatedHamTerminalRemediation: false when the validated head does not match', () => {
  const ok = headHasValidatedHamTerminalRemediation({
    hqRoot: '/tmp/hq',
    repo: 'acme/repo',
    prNumber: 4987,
    headSha: 'some-other-head',
    readAmaAuditEntryImpl: () => hamValidatedAuditEntry(HAM_HEAD),
  });
  assert.equal(ok, false);
});

test('headHasValidatedHamTerminalRemediation: false without the validated head-match marker', () => {
  const ok = headHasValidatedHamTerminalRemediation({
    hqRoot: '/tmp/hq',
    repo: 'acme/repo',
    prNumber: 4987,
    headSha: HAM_HEAD,
    readAmaAuditEntryImpl: () => ({
      attempts: [
        {
          headMatchEvidence: 'rebase-review-coverage',
          validatedHead: HAM_HEAD,
          eligibilityTrace: { trace: { hamTerminalRemediation: { ok: true } } },
        },
      ],
    }),
  });
  assert.equal(ok, false);
});

test('headHasValidatedHamTerminalRemediation: false when the trace hamTerminalRemediation.ok is not true', () => {
  const ok = headHasValidatedHamTerminalRemediation({
    hqRoot: '/tmp/hq',
    repo: 'acme/repo',
    prNumber: 4987,
    headSha: HAM_HEAD,
    readAmaAuditEntryImpl: () => ({
      attempts: [
        {
          headMatchEvidence: 'ham_terminal_remediation_validated',
          validatedHead: HAM_HEAD,
          eligibilityTrace: { trace: { hamTerminalRemediation: { ok: false } } },
        },
      ],
    }),
  });
  assert.equal(ok, false);
});

test('headHasValidatedHamTerminalRemediation: fails closed on read error and missing inputs', () => {
  assert.equal(
    headHasValidatedHamTerminalRemediation({
      hqRoot: '/tmp/hq',
      repo: 'acme/repo',
      prNumber: 4987,
      headSha: HAM_HEAD,
      readAmaAuditEntryImpl: () => {
        throw new Error('audit read failed');
      },
    }),
    false,
  );
  assert.equal(
    headHasValidatedHamTerminalRemediation({
      hqRoot: '',
      repo: 'acme/repo',
      prNumber: 4987,
      headSha: HAM_HEAD,
      readAmaAuditEntryImpl: () => hamValidatedAuditEntry(HAM_HEAD),
    }),
    false,
  );
});

test('daemon re-merges a HAM-validated remediated head under the ham terminal-remediation verdict', async () => {
  const rootDir = tempRoot();
  try {
    let captured = null;
    const result = await runDaemonCleanMergeAttempt(
      findingsReviewArgs(rootDir, {
        readAmaAuditEntryImpl: () => hamValidatedAuditEntry(HAM_HEAD),
        attemptDaemonCleanMergeImpl: async (args) => {
          captured = args;
          return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true, attempts: 1 };
        },
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
    assert.ok(captured, 'attemptDaemonCleanMerge must be invoked for the HAM-validated head');
    assert.equal(captured.allowHamTerminalRemediation, true);
    assert.equal(captured.verdict, 'ham_terminal_remediation_validated');
    assert.deepEqual(captured.requiredCheckContexts, ['ci/lint', 'ci/test']);
    // Validated head is the CURRENT (remediation) head, not the stale reviewed head.
    assert.equal(captured.validatedHead, HAM_HEAD);
    assert.equal(captured.auditMetadata.closureAuthority, 'daemon-ham-terminal-remediation');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon resolves required check contexts from AgentOSConfig merge-authority subtree', async () => {
  const rootDir = tempRoot();
  try {
    let captured = null;
    const result = await runDaemonCleanMergeAttempt(
      findingsReviewArgs(rootDir, {
        cfg: {
          mergeMethod: 'squash',
          autonomousMergeExecutionEnabled: true,
          strictMode: true,
          lha: { consumeAttestations: false },
          getMergeAuthorityConfig() {
            return { requiredCheckContexts: ['ci/lint', 'ci/test'] };
          },
        },
        readAmaAuditEntryImpl: () => hamValidatedAuditEntry(HAM_HEAD),
        attemptDaemonCleanMergeImpl: async (args) => {
          captured = args;
          return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true, attempts: 1 };
        },
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
    assert.deepEqual(captured.requiredCheckContexts, ['ci/lint', 'ci/test']);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon still declines a findings PR whose current head is NOT HAM-validated', async () => {
  const rootDir = tempRoot();
  try {
    let attemptCalled = false;
    const result = await runDaemonCleanMergeAttempt(
      findingsReviewArgs(rootDir, {
        readAmaAuditEntryImpl: () => ({ attempts: [] }),
        attemptDaemonCleanMergeImpl: async () => {
          attemptCalled = true;
          return { disposition: DAEMON_MERGE_DISPOSITION.MERGED };
        },
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'blocking-findings-present');
    assert.equal(attemptCalled, false, 'must not attempt a daemon merge without HAM validation');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a HAM-validated head with still-pending required CI declines and falls through (real predicate)', async () => {
  const rootDir = tempRoot();
  try {
    // Real attemptDaemonCleanMerge (no injected impl). Pending/undispatched CI =
    // empty rollup, which evaluateMergeEligibility fails closed as ci-not-green.
    const result = await runDaemonCleanMergeAttempt(
      findingsReviewArgs(rootDir, {
        readAmaAuditEntryImpl: () => hamValidatedAuditEntry(HAM_HEAD),
        candidate: {
          baseBranch: 'main',
          headSha: HAM_HEAD,
          statusCheckRollup: [],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          prState: 'open',
          branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
        },
        fetchRollupImpl: async () => ({
          state: 'OPEN',
          headSha: HAM_HEAD,
          headRefName: 'ham/branch',
          statusCheckRollup: [],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
        }),
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'not-eligible');
    assert.ok(Array.isArray(result.reasons) && result.reasons.includes('ci-not-green'));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('a HAM daemon re-merge that fails closed falls through to the hammer (never parks)', async () => {
  const rootDir = tempRoot();
  try {
    const result = await runDaemonCleanMergeAttempt(
      findingsReviewArgs(rootDir, {
        readAmaAuditEntryImpl: () => hamValidatedAuditEntry(HAM_HEAD),
        attemptDaemonCleanMergeImpl: async () => ({
          disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
          reason: 'permanent-merge-rejection',
          merged: false,
        }),
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'ham-terminal-remediation-daemon-permanent-merge-rejection');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('the HAM re-merge validates the AUDIT-CHECKED head, never a live head that moved past it', async () => {
  const rootDir = tempRoot();
  const MOVED_HEAD = 'pushed-after-audit-z000000000000000000000';
  try {
    let attemptCalled = false;
    const result = await runDaemonCleanMergeAttempt(
      findingsReviewArgs(rootDir, {
        readAmaAuditEntryImpl: () => hamValidatedAuditEntry(HAM_HEAD),
        // A commit landed between the audit check (HAM_HEAD) and this fetch.
        fetchRollupImpl: async () => ({
          state: 'OPEN',
          headSha: MOVED_HEAD,
          headRefName: 'ham/branch',
          statusCheckRollup: [GREEN_CHECK],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
        }),
        attemptDaemonCleanMergeImpl: async () => {
          attemptCalled = true;
          return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true, attempts: 1 };
        },
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.DEFERRED);
    assert.equal(result.reason, 'pr-head-moved');
    assert.equal(attemptCalled, false, 'must never merge a head that advanced past the audit check');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('the HAM re-merge declines when the audit marker resolves without a concrete head to pin it to', async () => {
  const rootDir = tempRoot();
  const LIVE_HEAD = 'unvalidated-live-head-q00000000000000000';
  try {
    let attemptCalled = false;
    const result = await runDaemonCleanMergeAttempt(
      findingsReviewArgs(rootDir, {
        // No snapshot head at all: neither `currentPrHeadSha` nor `candidate.headSha`.
        currentPrHeadSha: null,
        candidate: {
          baseBranch: 'main',
          statusCheckRollup: [GREEN_CHECK],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
          prState: 'open',
          branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
        },
        // A reader that is not head-scoped would still report "validated" here.
        headHasValidatedHamTerminalRemediationImpl: () => true,
        fetchRollupImpl: async () => ({
          state: 'OPEN',
          headSha: LIVE_HEAD,
          headRefName: 'ham/branch',
          statusCheckRollup: [GREEN_CHECK],
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'CLEAN',
        }),
        attemptDaemonCleanMergeImpl: async () => {
          attemptCalled = true;
          return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true, attempts: 1 };
        },
      }),
    );

    // Without a pinned audit head the head-moved guard cannot fire, so the lane
    // itself must fail closed rather than merge whatever the live head happens
    // to be. Falls through to the capped hammer, never a park.
    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'blocking-findings-present');
    assert.equal(attemptCalled, false, 'must not merge an unvalidated live head');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
