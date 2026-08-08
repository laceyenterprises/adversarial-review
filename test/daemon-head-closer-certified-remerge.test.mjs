import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDaemonCleanMergeAttempt } from '../src/daemon-clean-merge.mjs';
import {
  attemptDaemonCleanMerge,
  DAEMON_MERGE_DISPOSITION,
} from '../src/ama/daemon-merge.mjs';

// Fix B (#5053): the daemon re-merge lane accepts the terminal closer's OWN commit
// (proven via getHeadCloserCommitSuppression) as head-match certification for a
// settled-success review whose ONLY standing findings are non-blocking. It lands
// the certified head inline (no fresh hammer, no retry-cap burn) instead of the
// closer spinning `not-eligible`. Blocking findings remain a HARD STOP.

const REVIEWED_HEAD = 'reviewed-head-x0000000000000000000000000';
const CLOSER_HEAD = 'closer-remediation-head-y00000000000000000';
const GREEN_CHECK = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' };

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'daemon-head-closer-cert-'));
}

// A settled comment-only review (settled-success) with ONE non-blocking finding
// (blocking count 0, both classifications known) whose current head is the
// closer's own commit. NOT daemon-clean under strict mode → the head-closer
// self-cert lane is the only way it lands.
function nonBlockingReviewArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    cfg: {
      mergeMethod: 'squash',
      autonomousMergeExecutionEnabled: true,
      strictMode: true,
      lha: { consumeAttestations: false },
    },
    repoPath: 'acme/repo',
    prNumber: 5053,
    candidate: {
      baseBranch: 'main',
      headSha: CLOSER_HEAD,
      statusCheckRollup: [GREEN_CHECK],
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      prState: 'open',
      branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] },
    },
    gateSnapshot: {
      reviewedHeadSha: REVIEWED_HEAD,
      settledReview: { verdict: 'comment-only' },
    },
    mergeabilityForGate: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    reviewState: {
      headSha: REVIEWED_HEAD,
      riskClass: 'low',
      blockingFindingCount: 0,
      blockingFindingState: 'known',
      nonBlockingFindingCount: 1,
      nonBlockingFindingState: 'known',
    },
    reviewStateRow: { reviewer: 'codex' },
    currentPrHeadSha: CLOSER_HEAD,
    fetchRollupImpl: async () => ({
      state: 'OPEN',
      headSha: CLOSER_HEAD,
      headRefName: 'closer/branch',
      statusCheckRollup: [GREEN_CHECK],
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
    }),
    readBuildCompletionSignalForPrImpl: () => ({
      ok: true,
      row: { launch_request_id: 'lrq_hammer', worker_class: 'hammer', head_sha: CLOSER_HEAD },
    }),
    acquireMergeLeaseImpl: () => ({
      acquired: true,
      lease: {
        repo: 'acme/repo',
        base: 'main',
        leaseId: 'lease-1',
        holderPr: 5053,
        holderHead: CLOSER_HEAD,
        acquiredAt: '2026-08-08T00:00:00.000Z',
      },
    }),
    releaseMergeLeaseImpl: () => {},
    // No HAM audit marker here — this lane certifies via the closer commit identity.
    readAmaAuditEntryImpl: () => ({ attempts: [] }),
    logger: { warn() {}, log() {} },
    env: { HQ_ROOT: rootDir },
    ...overrides,
  };
}

test('daemon lands the closer own-commit head over a non-blocking-only settled-success review (self-cert)', async () => {
  const rootDir = tempRoot();
  try {
    let captured = null;
    const result = await runDaemonCleanMergeAttempt(
      nonBlockingReviewArgs(rootDir, {
        resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: true }),
        attemptDaemonCleanMergeImpl: async (args) => {
          captured = args;
          return { disposition: DAEMON_MERGE_DISPOSITION.MERGED, merged: true, attempts: 1 };
        },
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.MERGED);
    assert.ok(captured, 'attemptDaemonCleanMerge must be invoked for the self-certified head');
    assert.equal(captured.allowHeadCloserCertifiedNonBlocking, true);
    // NOT the HAM lane — it carries the NORMALIZED settled-success verdict token
    // (the shared MSM-02 verdict gate), never the ham_terminal_remediation token.
    assert.equal(captured.allowHamTerminalRemediation, false);
    assert.equal(captured.verdict, 'settled-success');
    // Pins the CURRENT (closer) head, never the stale reviewed head.
    assert.equal(captured.validatedHead, CLOSER_HEAD);
    assert.equal(captured.auditMetadata.closureAuthority, 'daemon-head-closer-certified-non-blocking');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon DECLINES a non-blocking review whose head is an EXTERNAL push (not the closer) — safety invariant', async () => {
  const rootDir = tempRoot();
  try {
    let attemptCalled = false;
    const result = await runDaemonCleanMergeAttempt(
      nonBlockingReviewArgs(rootDir, {
        resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
        attemptDaemonCleanMergeImpl: async () => {
          attemptCalled = true;
          return { disposition: DAEMON_MERGE_DISPOSITION.MERGED };
        },
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'non-blocking-findings-present');
    assert.equal(attemptCalled, false, 'must not merge an external push over standing findings');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon NEVER self-certifies over a BLOCKING finding, even with a closer own-commit head (hard stop)', async () => {
  const rootDir = tempRoot();
  try {
    let suppressionProbed = false;
    let attemptCalled = false;
    const result = await runDaemonCleanMergeAttempt(
      nonBlockingReviewArgs(rootDir, {
        // A blocking finding is present.
        reviewState: {
          headSha: REVIEWED_HEAD,
          riskClass: 'low',
          blockingFindingCount: 1,
          blockingFindingState: 'known',
          nonBlockingFindingCount: 0,
          nonBlockingFindingState: 'known',
        },
        resolveHeadCloserCommitSuppressionImpl: async () => {
          suppressionProbed = true;
          return { suppressed: true };
        },
        attemptDaemonCleanMergeImpl: async () => {
          attemptCalled = true;
          return { disposition: DAEMON_MERGE_DISPOSITION.MERGED };
        },
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'blocking-findings-present');
    assert.equal(attemptCalled, false, 'a blocking finding must never be merged over');
    assert.equal(suppressionProbed, false, 'self-cert probe must not even run for a blocking review');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('daemon requires a SETTLED-SUCCESS verdict for the self-cert lane (changes-requested declines)', async () => {
  const rootDir = tempRoot();
  try {
    let suppressionProbed = false;
    const result = await runDaemonCleanMergeAttempt(
      nonBlockingReviewArgs(rootDir, {
        gateSnapshot: {
          reviewedHeadSha: REVIEWED_HEAD,
          settledReview: { verdict: 'changes-requested' },
        },
        resolveHeadCloserCommitSuppressionImpl: async () => {
          suppressionProbed = true;
          return { suppressed: true };
        },
        attemptDaemonCleanMergeImpl: async () => ({ disposition: DAEMON_MERGE_DISPOSITION.MERGED }),
      }),
    );

    assert.equal(result.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
    assert.equal(result.reason, 'non-blocking-findings-present');
    assert.equal(suppressionProbed, false, 'self-cert probe must not run for a non-settled-success verdict');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

// ── Direct Gate-1 unit proof in attemptDaemonCleanMerge ─────────────────────────
// evaluateEligibilityImpl is stubbed to fail at Gate 2, so a `not-eligible` return
// proves Gate 1 (the review-clean gate) was PASSED, while a findings reason proves
// Gate 1 declined.

function gate1Args(reviewState, overrides = {}) {
  return {
    repo: 'acme/repo',
    prNumber: 5053,
    base: 'main',
    validatedHead: CLOSER_HEAD,
    verdict: 'settled-success',
    reviewState,
    liveGate: { candidateHead: CLOSER_HEAD, requiredChecks: [GREEN_CHECK], mergeable: 'MERGEABLE', prState: 'OPEN' },
    flags: { autonomousMergeExecutionEnabled: true, strictMode: true },
    evaluateEligibilityImpl: () => ({ eligible: false, reasons: ['stopped-past-gate-1'] }),
    logger: { warn() {}, log() {} },
    ...overrides,
  };
}

test('attemptDaemonCleanMerge Gate 1: the flag lets a KNOWN non-blocking review past the clean gate', async () => {
  const res = await attemptDaemonCleanMerge(gate1Args(
    { blockingFindingCount: 0, blockingFindingState: 'known', nonBlockingFindingCount: 2, nonBlockingFindingState: 'known' },
    { allowHeadCloserCertifiedNonBlocking: true },
  ));
  // Passed Gate 1 (else reason would be 'non-blocking-findings-present'); stopped at Gate 2 stub.
  assert.equal(res.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(res.reason, 'not-eligible');
});

test('attemptDaemonCleanMerge Gate 1: the flag NEVER passes a blocking finding', async () => {
  const res = await attemptDaemonCleanMerge(gate1Args(
    { blockingFindingCount: 1, blockingFindingState: 'known', nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' },
    { allowHeadCloserCertifiedNonBlocking: true },
  ));
  assert.equal(res.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(res.reason, 'blocking-findings-present');
});

test('attemptDaemonCleanMerge Gate 1: the flag NEVER passes an UNKNOWN classification', async () => {
  const res = await attemptDaemonCleanMerge(gate1Args(
    { blockingFindingCount: 0, blockingFindingState: 'unknown', nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' },
    { allowHeadCloserCertifiedNonBlocking: true },
  ));
  assert.equal(res.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(res.reason, 'findings-unknown');
});

test('attemptDaemonCleanMerge Gate 1: WITHOUT the flag, a non-blocking review still declines (flag is required)', async () => {
  const res = await attemptDaemonCleanMerge(gate1Args(
    { blockingFindingCount: 0, blockingFindingState: 'known', nonBlockingFindingCount: 2, nonBlockingFindingState: 'known' },
    { allowHeadCloserCertifiedNonBlocking: false },
  ));
  assert.equal(res.disposition, DAEMON_MERGE_DISPOSITION.NOT_TAKEN);
  assert.equal(res.reason, 'non-blocking-findings-present');
});
