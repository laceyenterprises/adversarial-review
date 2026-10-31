// FAILCLOSEDHAMMER-01 (SEV1): a daemon clean-merge that fails closed on its own
// accountability gate (`worker-identity-unresolved`) hands a clean, green exact
// head to the hammer. Before this, next-action parked it as a closure-recovery
// safety refusal that nothing executed, and a closer resolving the pair afresh
// declined the head as the daemon's (`clean-exact-head`): a green, approved PR
// with no actor. Synthetic fixtures only.
import './helpers/registry-session-fixture.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

import { maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { observeDaemonResult, resolveClosureNextAction } from '../src/ama/closure-next-action.mjs';
import { DAEMON_MERGE_DISPOSITION } from '../src/ama/daemon-merge.mjs';
import { DAEMON_FAILED_CLOSED_HAMMER_REFUSED } from '../src/ama-closure-orchestration.mjs';
import { maybeDispatchAmaClosureFor } from '../src/watcher.mjs';
import { readDaemonMergeParks } from '../src/daemon-merge-park-log.mjs';

const CURRENT_USER = userInfo().username || process.env.USER || 'unknown';
const HEAD = 'a'.repeat(40);
const REQUIRED_GATE = 'agent-os/adversarial-gate';
const IDENTITY_FAILURE = Object.freeze({ disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
  reason: 'worker-identity-unresolved', reasons: ['missing-build-completion-signal'],
  merged: false, attempts: 0 });

function closerDeps() {
  const calls = [];
  return {
    calls,
    deliverAlertImpl: async () => {},
    readPullRequestStateImpl: () => null,
    processExecFileImpl: async () => ({ stdout: 'Thu Oct 22 10:18:18 2026\n' }),
    execFileImpl: async (cmd, args, options = {}) => {
      calls.push({ cmd, args, options });
      return { stdout: JSON.stringify({ ticketRef: 'AMA-PR-404', dispatchId: 'lrq_hammer_1',
        launchRequestId: 'lrq_hammer_1' }), stderr: '' };
    },
    readTemplateImpl: () => 'hammer prompt <<PR_URL>> <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>',
    writeFileImpl: () => {},
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    logger: { log() {}, info() {}, warn() {}, error() {} },
  };
}

// A clean exact-head review on a green, MERGEABLE PR: the daemon's lane until
// the daemon itself fails closed.
function closerArgs(rootDir, reviewState = {}) {
  return {
    reviewState: { verdict: 'comment-only', headSha: HEAD, riskClass: 'low', remediationPending: false,
      blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 0, operatorApprovedEvidence: null, prAuthor: 'builder', ...reviewState },
    prMetadata: { prNumber: 404, headSha: HEAD, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: [], author: 'builder',
      statusCheckRollup: [{ __typename: 'CheckRun', name: REQUIRED_GATE, conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', name: 'ci/test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: [REQUIRED_GATE, 'ci/test'] } },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash', strictMode: true,
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: true } },
    options: { env: { ADV_GATE_STATUS_CONTEXT: REQUIRED_GATE } },
    dispatchContext: { rootDir, repo: 'acme/repo', prUrl: 'https://github.com/acme/repo/pull/404',
      reviewedSha: HEAD, riskClass: 'low', requiredGateContext: REQUIRED_GATE, reviewedBy: 'codex-reviewer',
      reviewer: 'codex', parentSession: 'session:test:watcher', hqPath: '/bin/hq-test',
      hqRoot: join(rootDir, 'hq-root'), hqOwnerUser: CURRENT_USER, currentUser: CURRENT_USER,
      closerTokenRollupPollDelaysMs: [], dispatchedAt: '2026-10-31T12:00:00Z',
      livePrProbeImpl: async () => ({ state: 'OPEN', headBranchExists: true, headRefName: 'builder/live' }) },
  };
}

async function cleanPair(args) {
  return resolveClosureNextAction({
    subjectKey: `${args.dispatchContext.repo}#404`, observedAt: '2026-10-31T12:00:00.000Z',
    input: { reviewState: args.reviewState, currentHead: HEAD, strictMode: true, roundsLeft: false,
      lease: null, checks: 'SUCCESS' },
    candidate: { headSha: HEAD, prState: 'OPEN', mergeable: 'MERGEABLE' },
    autonomousMergeExecutionEnabled: true,
  });
}

function tempRoot(t, prefix) {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('FAILCLOSEDHAMMER-01: the closer launches the hammer for a daemon fail-closed clean exact head', async t => {
  const rootDir = tempRoot(t, 'fch-closer-');
  const args = closerArgs(rootDir);
  const clean = await cleanPair(args);
  assert.deepEqual([clean.decision.action, clean.decision.reason], ['daemon-merge', 'clean-exact-head']);

  // The reproduction: without the daemon's refusal the closer declines the head.
  const declinedDeps = closerDeps();
  const declined = await maybeDispatchAmaCloser({ ...args, ...declinedDeps, sharedNextAction: clean });
  assert.equal(declined.dispatched, false);
  assert.equal(declined.reason, 'clean-exact-head');
  assert.equal(declinedDeps.calls.length, 0);

  // The daemon's same-pass refusal routes the head to the hammer, which merges
  // under its own lease through the terminal-audit (head attestation) contract.
  const handoff = observeDaemonResult(clean, IDENTITY_FAILURE);
  assert.deepEqual([handoff.decision.action, handoff.decision.actor, handoff.decision.reason],
    ['hammer', 'hammer', 'daemon-failed-closed']);
  const deps = closerDeps();
  const result = await maybeDispatchAmaCloser({ ...args, ...deps, sharedNextAction: handoff });
  assert.equal(result.dispatched, true, JSON.stringify(result));
  const dispatches = deps.calls.filter(call => call.args[0] === 'dispatch');
  assert.equal(dispatches.length, 1);
  const flag = name => dispatches[0].args[dispatches[0].args.indexOf(name) + 1];
  assert.equal(flag('--task-kind'), 'merge');
  assert.equal(flag('--required-outcome'), 'terminal-audit');
  assert.ok(!dispatches[0].args.includes('--admin'));
});

test('FAILCLOSEDHAMMER-01: a blocking finding never becomes a daemon hand-off or a merge', async t => {
  const rootDir = tempRoot(t, 'fch-blocking-');
  const args = closerArgs(rootDir, { verdict: 'request changes', blockingFindingCount: 1 });
  const pair = await cleanPair({ ...args, reviewState: { ...args.reviewState, reviewCycleExhausted: false } });
  const refused = observeDaemonResult(pair, IDENTITY_FAILURE);
  assert.notEqual(refused.decision.reason, 'daemon-failed-closed');
  assert.notEqual(refused.decision.action, 'daemon-merge');
});

const loadAmaEnabledConfig = () => ({
  getMergeAuthorityConfig: () => ({ enabled: true, mergeMethod: 'squash', autonomousMergeExecutionEnabled: true,
    strictMode: true, lha: { consumeAttestations: false } }),
  getOrchestrationMode: () => 'native',
});

function closureArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    reviewStateRow: { review_status: 'posted', review_body: CLEAN_BODY, reviewer_head_sha: 'head-live', reviewer: 'codex' },
    dispatchJob: { blockingFindingCount: 0, blockingFindingState: 'known',
      nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' },
    candidate: { headSha: 'head-live', title: 'Synthetic change', baseBranch: 'main', prState: 'open',
      isDraft: false, riskClass: 'low', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
      statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      branchProtection: { requiredContexts: ['agent-os/adversarial-gate'] }, prAuthor: 'builder' },
    labelNames: [], repoPath: 'acme/repo', prNumber: 300, currentRevisionRef: 'head-live',
    loadConfigImpl: loadAmaEnabledConfig,
    fetchLatestHeadReviewBodiesImpl: async () => [CLEAN_BODY],
    liveReviewRetryDelaysMs: [0, 0],
    logger: { warn() {}, log() {} },
    runDaemonCleanMergeAttemptImpl: async () => ({ ...IDENTITY_FAILURE }),
    ...overrides,
  };
}

const CLEAN_BODY = [
  '## Blocking Issues', '', '- None.', '',
  '## Non-blocking Issues', '', '- None.', '',
  '## Verdict', '', 'Comment only',
].join('\n');

test('FAILCLOSEDHAMMER-01: the watcher hands the daemon refusal to the hammer instead of parking it', async t => {
  const rootDir = tempRoot(t, 'fch-watcher-');
  const logs = [];
  const seen = [];
  const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    logger: { log: line => logs.push(String(line)), warn() {} },
    maybeDispatchAmaCloserImpl: async ({ sharedNextAction }) => {
      seen.push(sharedNextAction.decision);
      return { dispatched: true, launchRequestId: 'lrq-synthetic' };
    },
  }));
  assert.equal(seen.length, 1, 'the daemon refusal reaches exactly one hammer admission');
  assert.deepEqual([seen[0].action, seen[0].actor, seen[0].reason], ['hammer', 'hammer', 'daemon-failed-closed']);
  assert.equal(result.dispatched, true);
  const fallback = logs.map(line => { try { return JSON.parse(line); } catch { return null; } })
    .find(event => event?.event === 'ama.daemon_clean_fail_closed.hammer_fallback');
  assert.equal(fallback?.reason, 'worker-identity-unresolved');
  assert.deepEqual(readDaemonMergeParks({ rootDir }), []);
});

for (const [name, refusal] of [
  ['merge-eligibility refusal', { dispatched: false, skipMergeAgent: true, reason: 'not-eligible',
    reasons: ['synthetic-non-identity-gate'], eligibilityRejected: true, safetyRefusal: true }],
  ['hand-back to the daemon', { dispatched: false, skipMergeAgent: true, recoveryWait: true,
    reason: 'closure-decision-mismatch', decisionMismatch: { resolvedAction: 'daemon-merge',
      resolvedReason: 'clean-exact-head' } }],
]) test(`FAILCLOSEDHAMMER-01: a ${name} escalates once under a terminal named reason`, async t => {
  const rootDir = tempRoot(t, 'fch-refusal-');
  const waits = [];
  const paged = new Set();
  let closerCalls = 0;
  const pass = () => maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    observeClosureWaitImpl: async args => {
      waits.push(args);
      const key = `${args.headSha}:${args.waitClass}`;
      const notify = !paged.has(key);
      paged.add(key);
      return { exhausted: true, notify, retryAfterMs: 30_000, reason: args.reason };
    },
    maybeDispatchAmaCloserImpl: async () => { closerCalls += 1; return { ...refusal }; },
  }));
  const first = await pass();
  const second = await pass();
  assert.equal(closerCalls, 2, 'each pass re-validates through the closer; neither selects the daemon again');
  for (const result of [first, second]) {
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.needsOperator, true);
    assert.equal(result.reason, DAEMON_FAILED_CLOSED_HAMMER_REFUSED);
    assert.equal(result.namedReason, DAEMON_FAILED_CLOSED_HAMMER_REFUSED);
    assert.equal(result.closerReason, refusal.reason);
    assert.match(result.closureBlocker, /daemon=worker-identity-unresolved hammer=/);
  }
  const escalations = waits.filter(wait => wait.waitClass === DAEMON_FAILED_CLOSED_HAMMER_REFUSED);
  assert.equal(escalations.length, 2);
  assert.ok(escalations.every(wait => wait.immediate === true && wait.headSha === 'head-live'));
  assert.deepEqual([first.boundedWait.notify, second.boundedWait.notify], [true, false], 'one page per head');
  assert.equal(readDaemonMergeParks({ rootDir })[0]?.reason, DAEMON_FAILED_CLOSED_HAMMER_REFUSED);
});

for (const [name, outcome] of [
  ['launch', { dispatched: true, launchRequestId: 'lrq-synthetic' }],
  ['already-escalated cap', { dispatched: false, skipMergeAgent: true, needsOperator: true,
    reason: 'hammer-lifetime-ceiling-reached' }],
  ['drain deferral', { dispatched: false, skipMergeAgent: true, reason: 'deferred-by-drain' }],
]) test(`FAILCLOSEDHAMMER-01: a hammer ${name} keeps its own owner`, async t => {
  const rootDir = tempRoot(t, 'fch-owner-');
  const result = await maybeDispatchAmaClosureFor(closureArgs(rootDir, {
    observeClosureWaitImpl: async args => {
      assert.notEqual(args.waitClass, DAEMON_FAILED_CLOSED_HAMMER_REFUSED);
      return { exhausted: false, notify: false, retryAfterMs: 30_000, reason: args.reason };
    },
    maybeDispatchAmaCloserImpl: async () => ({ ...outcome }),
  }));
  assert.equal(result.reason, outcome.reason);
  assert.equal(result.closerReason, undefined);
  assert.notEqual(result.namedReason, DAEMON_FAILED_CLOSED_HAMMER_REFUSED);
});
