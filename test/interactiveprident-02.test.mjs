// INTERACTIVEPRIDENTITY-02 (SEV2): a clean exact head whose PR has no build
// identity at all (an interactive session that has not signed it) parks with
// one named operator action. A closer cannot create that identity, so no closer
// is dispatched; a transient identity read keeps its bounded retry and a
// malformed, denied or unknown identity keeps its existing fail-closed route.
// Synthetic fixtures only.
import './helpers/registry-session-fixture.mjs';
import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DAEMON_MERGE_DISPOSITION } from '../src/ama/daemon-merge.mjs';
import { isDurableIdentityAbsence } from '../src/ama/daemon-decline.mjs';
import { DAEMON_IDENTITY_ABSENT_PARKED, IDENTITY_ABSENT_OPERATOR_ACTION } from '../src/ama-closure-orchestration.mjs';
import { resolveDaemonWorkerIdentityForPr } from '../src/daemon-worker-identity.mjs';
import { maybeDispatchAmaClosureFor } from '../src/watcher.mjs';
import { readDaemonMergeParks } from '../src/daemon-merge-park-log.mjs';

const failure = (...reasons) => Object.freeze({ disposition: DAEMON_MERGE_DISPOSITION.FAILED_CLOSED,
  reason: 'worker-identity-unresolved', reasons, merged: false, attempts: 0 });
const ABSENT = failure('worker-observation-inconclusive');
const CLEAN_BODY = ['## Blocking Issues', '', '- None.', '', '## Non-blocking Issues', '', '- None.', '',
  '## Verdict', '', 'Comment only'].join('\n');

const loadAmaEnabledConfig = () => ({
  getMergeAuthorityConfig: () => ({ enabled: true, mergeMethod: 'squash', autonomousMergeExecutionEnabled: true,
    strictMode: true, lha: { consumeAttestations: false } }),
  getOrchestrationMode: () => 'native',
});

function tempRoot(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'ipi-02-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

// One watcher pass over a clean, green, MERGEABLE exact head. `daemon` is what
// the daemon clean-merge attempt returns; `closerCalls` counts hammer admissions.
function harness(t, daemon) {
  const rootDir = tempRoot(t);
  const state = { closerCalls: 0, waits: [], paged: new Set(), daemon };
  const pass = () => maybeDispatchAmaClosureFor({
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
    runDaemonCleanMergeAttemptImpl: async () => ({ ...state.daemon }),
    observeClosureWaitImpl: async args => {
      state.waits.push(args);
      const key = `${args.headSha}:${args.waitClass}`;
      const notify = !state.paged.has(key);
      state.paged.add(key);
      return { exhausted: true, notify, retryAfterMs: 30_000, reason: args.reason };
    },
    maybeDispatchAmaCloserImpl: async () => { state.closerCalls += 1; return { dispatched: true, launchRequestId: 'lrq-synthetic' }; },
  });
  return { rootDir, state, pass };
}

test('INTERACTIVEPRIDENTITY-02: only a read that found no identity is a durable absence', () => {
  for (const reasons of [['worker-observation-inconclusive'], ['missing-produced-head-attestation']]) {
    assert.equal(isDurableIdentityAbsence(failure(...reasons)), true, reasons.join());
  }
  for (const reasons of [
    ['identity-read-transient'], ['head-attestation-chain-read-failed'], ['build-completion-read-failed'],
    ['worker-observation-unavailable'], ['worker-observation-scope-denied'],
    ['missing-launch-request-id'], ['missing-worker-class'], ['unconfirmed-pr-opener-provenance'],
    ['missing-build-completion-signal'], ['synthetic-unknown-reason'],
    ['worker-observation-inconclusive', 'identity-read-transient'], [],
  ]) assert.equal(isDurableIdentityAbsence(failure(...reasons)), false, reasons.join());
  // A worker launch on the branch that does not prove the opener: the opener may be hidden.
  assert.equal(isDurableIdentityAbsence({ ...ABSENT,
    workerIdentity: { launchProvenanceReason: 'branch-provenance-does-not-prove-pr-opener' } }), false);
  assert.equal(isDurableIdentityAbsence({ ...ABSENT, reason: 'not-eligible' }), false);
  assert.equal(isDurableIdentityAbsence(null), false);
});

test('INTERACTIVEPRIDENTITY-02: a durable identity absence parks once with the named action and dispatches no closer', async t => {
  const { rootDir, state, pass } = harness(t, ABSENT);
  const first = await pass();
  const second = await pass();
  assert.equal(state.closerCalls, 0, 'no hammer is admitted');
  for (const result of [first, second]) {
    assert.equal(result.dispatched, false);
    assert.equal(result.skipMergeAgent, true);
    assert.equal(result.needsOperator, true);
    assert.equal(result.reason, DAEMON_IDENTITY_ABSENT_PARKED);
    assert.equal(result.namedReason, DAEMON_IDENTITY_ABSENT_PARKED);
    assert.ok(result.closureBlocker.includes(IDENTITY_ABSENT_OPERATOR_ACTION));
    assert.match(result.closureBlocker, /hq pr sign.*hand-merge/);
  }
  const pages = state.waits.filter(wait => wait.waitClass === DAEMON_IDENTITY_ABSENT_PARKED);
  assert.equal(pages.length, 2);
  assert.ok(pages.every(wait => wait.immediate === true && wait.headSha === 'head-live'));
  assert.deepEqual([first.boundedWait.notify, second.boundedWait.notify], [true, false], 'one page per head');
  const [park] = readDaemonMergeParks({ rootDir });
  assert.equal(park.reason, DAEMON_IDENTITY_ABSENT_PARKED);
  assert.match(park.remedy, /hq pr sign/);
});

test('INTERACTIVEPRIDENTITY-02: the park re-evaluates, and a new attestation lets the clean merge proceed', async t => {
  const { rootDir, state, pass } = harness(t, ABSENT);
  assert.equal((await pass()).namedReason, DAEMON_IDENTITY_ABSENT_PARKED);
  assert.equal(readDaemonMergeParks({ rootDir }).length, 1);
  state.daemon = { disposition: DAEMON_MERGE_DISPOSITION.MERGED, reason: 'daemon-merged', merged: true,
    attempts: 1, mergedAt: '2026-11-17T12:00:00Z' };
  const merged = await pass();
  assert.notEqual(merged.namedReason, DAEMON_IDENTITY_ABSENT_PARKED);
  assert.equal(merged.needsOperator, undefined);
  assert.equal(state.closerCalls, 0);
  assert.deepEqual(readDaemonMergeParks({ rootDir }), [], 'the merge clears the park');
});

test('INTERACTIVEPRIDENTITY-02: a transient identity read is never parked and never reaches a closer', async t => {
  const { state, pass } = harness(t, failure('identity-read-transient'));
  const result = await pass();
  assert.equal(state.closerCalls, 0);
  assert.notEqual(result.namedReason, DAEMON_IDENTITY_ABSENT_PARKED);
  assert.notEqual(result.needsOperator, true);
  assert.equal(state.waits.filter(wait => wait.waitClass === DAEMON_IDENTITY_ABSENT_PARKED).length, 0);
});

test('INTERACTIVEPRIDENTITY-02: a malformed or denied identity keeps its existing hammer route', async t => {
  for (const reason of ['missing-launch-request-id', 'worker-observation-scope-denied']) {
    const { state, pass } = harness(t, failure(reason));
    const result = await pass();
    assert.equal(state.closerCalls, 1, reason);
    assert.notEqual(result.namedReason, DAEMON_IDENTITY_ABSENT_PARKED, reason);
  }
});

test('INTERACTIVEPRIDENTITY-02: the real resolver separates absence, transient failure and a forged attestation', async () => {
  const base = { repo: 'acme/repo', prNumber: 300, currentHeadSha: 'head-live', currentBranch: 'feature/synthetic',
    logger: null };
  const absent = await resolveDaemonWorkerIdentityForPr({ ...base,
    readBuildCompletionSignalForPrImpl: async () => ({ ok: false, reason: 'worker-observation-inconclusive' }) });
  assert.equal(absent.ok, false);
  assert.equal(isDurableIdentityAbsence(failure(absent.reason)), true);

  const transient = await resolveDaemonWorkerIdentityForPr({ ...base,
    readBuildCompletionSignalForPrImpl: async () => ({ ok: false, reason: 'identity-read-transient', transient: true }) });
  assert.equal(transient.ok, false);
  assert.equal(isDurableIdentityAbsence(failure(transient.reason)), false);

  const row = { kind: 'produced', head_sha: 'head-live', ts: '2026-11-17T12:00:00Z',
    payload: { launch_request_id: 'lrq-synthetic', worker_class: 'claude-code' } };
  const attest = rows => resolveDaemonWorkerIdentityForPr({ ...base, consumeHeadAttestations: true,
    readHeadAttestationChainForPrImpl: async () => rows,
    readBuildCompletionSignalForPrImpl: async () => { throw new Error('pr_opened is not consulted'); } });
  const forged = await attest([{ ...row, valid: false }]);
  assert.equal(forged.ok, false, 'an unverifiable attestation never resolves an identity');
  const wrongHead = await attest([{ ...row, valid: true, head_sha: 'other-head' }]);
  assert.equal(wrongHead.ok, false, 'an attestation for another head never resolves an identity');
  assert.equal((await attest([{ ...row, valid: true }])).ok, true, 'a valid exact-head attestation resolves');
});
