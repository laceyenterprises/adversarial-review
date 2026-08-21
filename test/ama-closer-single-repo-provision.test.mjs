import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';

// The AMA closer dispatch is single-repo for EVERY repo.
//
// `--pr <n>` makes `hq dispatch` infer `--branch` from `pr.headRefName`, because
// the closer must check out the PR head. Provisioning treats any branch as a
// rescue/reattach and refuses a multi-repo workspace outright:
//
//   [hq] error: --additional-repo is only supported for fresh multi-repo
//   workspaces; rescue/reattach via --branch stays single-repo
//
// That refusal is correct on its own terms -- the multi-repo model creates one
// FRESH branch across all declared repos, which cannot coexist with reattaching
// to a branch that already exists on the PR's repo. So `--additional-repo` on a
// closer dispatch is not a tuning knob; it is a guaranteed ProvisionError.
//
// The regression this pins: the flag was originally applied to every repo except
// agent-os, and adversarial-review was appended to the exclusion list on
// 2026-07-04 after its self-PRs hit this exact failure. Excluding repos one at a
// time left the closer silently unusable for every repo not yet on the list.
// laceyenterprises/finch#2 was reviewed clean, failed closer dispatch twice with
// ProvisionError, and had to be merged by hand. Re-introducing the flag -- or
// re-introducing a per-repo exclusion list -- breaks every app repo again.
//
// Nothing consumed the companion checkout: the closer prompt reaches agent-os
// tooling (merge-lease.mjs, ama-check.mjs) by absolute deploy path.

function currentUser() {
  try {
    return userInfo().username || process.env.USER || process.env.LOGNAME || 'unknown';
  } catch {
    return process.env.USER || process.env.LOGNAME || 'unknown';
  }
}

const CURRENT_USER = currentUser();
const HEAD = 'b'.repeat(40);
const REQUIRED_GATE = 'agent-os/adversarial-gate';

function testDeps() {
  const calls = [];
  return {
    calls,
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: JSON.stringify({ dispatchId: 'lrq_hammer_1', launchRequestId: 'lrq_hammer_1' }), stderr: '' };
    },
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info() {}, warn() {}, error() {} },
  };
}

function closerArgs(rootDir, repo) {
  return {
    reviewState: {
      verdict: 'comment-only',
      headSha: HEAD,
      riskClass: 'low',
      remediationPending: false,
      blockingFindingState: 'known',
      blockingFindingCount: 0,
      nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0,
      operatorApprovedEvidence: null,
      prAuthor: 'builder',
    },
    prMetadata: {
      prNumber: 2,
      headSha: HEAD,
      isOpen: true,
      isDraft: false,
      mergeableState: 'MERGEABLE',
      labels: [],
      statusCheckRollup: [
        { __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'integration', conclusion: 'FAILURE' },
      ],
      branchProtection: { requiredContexts: [REQUIRED_GATE] },
      author: 'builder',
    },
    cfg: {
      enabled: true,
      workerClass: 'hammer',
      mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false },
      branchProtection: { required: true },
    },
    options: { env: { ADV_GATE_STATUS_CONTEXT: REQUIRED_GATE } },
    dispatchContext: {
      rootDir,
      repo,
      prUrl: `https://github.com/${repo}/pull/2`,
      reviewedSha: HEAD,
      riskClass: 'low',
      requiredGateContext: REQUIRED_GATE,
      reviewedBy: 'codex-reviewer-lacey',
      reviewer: 'codex',
      parentSession: 'session:test:watcher',
      hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'),
      hqOwnerUser: CURRENT_USER,
      currentUser: CURRENT_USER,
      dispatchedAt: '2026-08-16T21:00:00Z',
      livePrProbeImpl: async () => ({
        state: 'OPEN',
        headBranchExists: true,
        headRefName: 'codex-fsa-05/FSA-05',
      }),
    },
  };
}

// Every repo class the closer serves: the tooling repo itself, the repo that was
// hand-added to the exclusion list, and an app repo that was never on it. All
// three must dispatch single-repo.
for (const repo of [
  'laceyenterprises/finch',
  'laceyenterprises/agent-os',
  'laceyenterprises/adversarial-review',
  'laceyenterprises/some-future-app',
]) {
  test(`AMA closer dispatch carries no --additional-repo for ${repo}`, async (t) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ama-closer-single-repo-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const deps = testDeps();

    const result = await maybeDispatchAmaCloser({ ...closerArgs(rootDir, repo), ...deps });

    assert.equal(result.dispatched, true, `closer must dispatch for ${repo}`);
    assert.equal(deps.calls.length, 1);
    const args = deps.calls[0].args;

    assert.equal(
      args.includes('--additional-repo'),
      false,
      `--additional-repo guarantees ProvisionError once --pr infers --branch; it must never be sent (${repo})`,
    );
    // Pin the flag that forces the branch inference, so a future change that
    // drops --pr does not quietly make the assertion above vacuous.
    assert.equal(args.includes('--pr'), true, '--pr drives the head-branch inference this test is about');
  });
}
