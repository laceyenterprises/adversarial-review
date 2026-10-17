import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaCloser, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';

const repo = 'fixture/repo', prNumber = 41, headSha = 'a'.repeat(40);
const started = '2026-01-01T00:00:00Z', observed = '2026-01-01T00:10:00Z';
function fixture(t, { charged = 1, ledgerStatus = 'succeeded', reportedStatus = 'starting' } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'finalclose-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo, prNumber, headSha };
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ ...identity, reviewedSha: headSha,
    targetRemediationSha: headSha, dispatchReason: 'exhausted-final-hammer', workerClass: 'hammer',
    dispatchId: 'lrq_finished', launchRequestId: 'lrq_finished', retryCount: 1,
    state: 'dispatched', lastObservedStatus: 'starting', lastAttemptedAt: started, dispatchedAt: started }));
  acquireAmaCloserLease({ rootDir, ...identity, now: started });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_finished', now: started });
  for (let i = 0; i < charged; i++) recordHammerRetryDispatch(rootDir, identity, { jobKey: headSha, headSha, now: started });
  const launches = [], pages = [];
  const args = {
    reviewState: { verdict: 'comment-only', headSha, riskClass: 'low', remediationPending: false,
      blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known',
      nonBlockingFindingCount: 1, reviewCycleExhausted: true },
    prMetadata: { prNumber, headSha, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE',
      labels: [], statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }],
      branchProtection: { requiredContexts: [] }, author: 'synthetic-builder' },
    cfg: { enabled: true, workerClass: 'hammer', branchProtection: { required: false },
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false } },
    dispatchContext: { rootDir, repo, reviewedSha: headSha, targetRemediationSha: headSha,
      reviewer: 'claude', riskClass: 'low', requiredGateContext: 'fixture/adversarial-gate',
      dispatchRecordHeadSha: headSha, dispatchReason: 'exhausted-final-hammer', dispatchedAt: observed,
      prUrl: `https://github.com/${repo}/pull/${prNumber}`, hqRoot: join(rootDir, 'hq'),
      hqOwnerUser: userInfo().username, currentUser: userInfo().username,
      ledgerTarget: { backend: 'sqlite', path: join(rootDir, 'absent.sqlite') }, closerTokenRollupPollDelaysMs: [],
      livePrProbeImpl: async () => ({ state: 'OPEN', headRefOid: headSha, headBranchExists: true }) },
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'dispatch' && argv[1] === 'status') return { stdout: JSON.stringify({ status: reportedStatus }) };
      if (argv[0] === 'dispatch') { launches.push(argv); return { stdout: JSON.stringify({ ticketRef: 'HAM', dispatchId: 'lrq_next', launchRequestId: 'lrq_next' }) }; }
      return { stdout: '{}' };
    },
    readLaunchRequestStatusImpl: async ({ launchRequestId }) => launchRequestId === 'lrq_finished'
      ? { ok: true, row: { status: ledgerStatus } } : { ok: true, row: { status: 'running' } },
    readPullRequestStateImpl: () => null,
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
    readTemplateImpl: () => 'fixture hammer <<PR_URL>> <<AMA_TRAILERS>>', writeFileImpl() {},
    deliverAlertImpl: async text => { pages.push(text); return { ok: true }; },
    logger: { log() {}, info() {}, warn() {}, error() {} },
  };
  return { rootDir, args, launches, pages };
}

test('FINALCLOSE-01 terminal launch overrides a stale starting worker and retries once, charged to the cap', async t => {
  const f = fixture(t);
  assert.equal((await maybeDispatchAmaCloser(f.args)).dispatched, true);
  assert.equal(f.launches.length, 1);
  assert.equal(readHammerRetryCapLedger(f.rootDir, { repo, prNumber }).attemptCount, 2);
  assert.equal((await maybeDispatchAmaCloser(f.args)).dispatched, false);
  assert.equal(f.launches.length, 1, 'the new running launch keeps single-flight ownership');
});

test('FINALCLOSE-01 terminal launches exhaust the cap and page once with the last blocker', async t => {
  const f = fixture(t, { charged: 2 });
  for (let tick = 0; tick < 3; tick++) {
    const result = await maybeDispatchAmaCloser(f.args);
    assert.equal(result.reason, 'hammer-retry-cap-exhausted');
  }
  assert.equal(f.launches.length, 0);
  assert.equal(f.pages.length, 1);
  assert.match(f.pages[0], /terminal-launch-without-merge|hammer-exited-without-close/);
});
