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

import { mkdirSync, writeFileSync } from 'node:fs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';

const reviewed = 'b'.repeat(40);
const body = '## Blocking issues\n- None.\n## Non-blocking issues\n- **Cleanup**\n  - **Problem:** redundant branch\n## Verdict\nComment only';
function finalRound(t) {
  const rootDir = mkdtempSync(join(tmpdir(), 'finalclose-round-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture__repo-pr-41-final.json'), JSON.stringify({ repo, prNumber,
    status: 'completed', revisionRef: reviewed, reviewBody: body, riskClass: 'low',
    finalRound: 'comment-only', reReview: { suppressed: 'comment-only-final-round' },
    completedAt: started, completion: { workerPushedHeadSha: headSha },
    remediationPlan: { currentRound: 1, maxRounds: 2 }, remediationWorker: { state: 'completed' } }));
  return rootDir;
}
for (const operation of ['mergeability', 'live-review', 'stale-proof']) {
  test(`FINALCLOSE-01 final-round ${operation} timeout reaches dispatch on the same tick without merging`, async t => {
    const rootDir = finalRound(t);
    const stall = () => new Promise(() => {});
    let launches = 0, merges = 0;
    const result = await maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber,
      currentRevisionRef: headSha, labelNames: [], operationTimeoutMs: 10,
      reviewStateRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'claude',
        reviewer_head_sha: reviewed, last_verdict: 'Comment only', posted_at: started },
      candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
        mergeable: operation === 'mergeability' ? 'UNKNOWN' : 'MERGEABLE',
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
      resolveAmaHammerDispatchModeImpl: () => 'inline',
      fetchPullRequestMergeabilityImpl: stall,
      fetchLatestHeadReviewBodiesImpl: operation === 'live-review' ? stall : async () => [body],
      proveCloserAuthoredStaleHeadImpl: operation === 'stale-proof' ? stall : async () => ({ proven: false }),
      runDaemonCleanMergeAttemptImpl: async () => { merges++; assert.fail('timeout must never authorize a watcher merge'); },
      maybeDispatchAmaCloserImpl: async args => {
        launches++;
        assert.equal(args.dispatchContext.finalRoundDispatchOnly, true);
        assert.equal(args.dispatchContext.targetRemediationSha, headSha);
        assert.equal(args.prMetadata.mergeableState, 'UNKNOWN');
        return { dispatched: true };
      },
      observeClosureWaitImpl: async () => ({}),
      logger: { log() {}, warn() {} },
    });
    assert.equal(result.dispatched, true);
    assert.equal(launches, 1);
    assert.equal(merges, 0);
  });
}

test('FINALCLOSE-01 final-round wait pages once at thirty minutes despite changing blockers and keeps observing', async t => {
  const rootDir = finalRound(t), pages = [];
  for (const [now, reason] of [[0, 'coexistence-timeout'], [1800000, 'history-read-failed'],
    [1800001, 'launch-ended-without-merge'], [3600000, 'retry-cap-exhausted']]) {
    const wait = await observeClosureWait({ rootDir, repo, prNumber, headSha, now,
      startedAt: 0, waitClass: 'final-round', reason, pageImpl: async text => pages.push(text) });
    assert.equal(wait.exhausted, now >= 1800000);
  }
  assert.equal(pages.length, 1);
  assert.match(pages[0], new RegExp(headSha));
  assert.match(pages[0], /history-read-failed/);
});

import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { handoffHammerReview } from '../bin/hammer-review-handoff.mjs';
for (const requestedHead of [headSha, 'c'.repeat(40)]) {
  test(`FINALCLOSE-01 interrupted handoff admits only its exact head: ${requestedHead === headSha}`, async t => {
    const rootDir = finalRound(t);
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,review_status,
      reviewer_head_sha,revision_ref) VALUES (?,?,'2026-01-01T00:00:00Z','claude','open','posted',?,?)`)
      .run(repo, prNumber, reviewed, reviewed);
    const identity = { rootDir, repo, prNumber, headSha };
    acquireAmaCloserLease(identity);
    await handoffHammerReview({ ...identity, requestBoundedReviewImpl: async () => null });
    if (requestedHead !== headSha) {
      // The same completed final round has a different push: an older handoff
      // cannot authorize that head merely because the PR number matches.
      const file = join(rootDir, 'data', 'follow-up-jobs', 'completed', 'fixture__repo-pr-41-final.json');
      const job = JSON.parse((await import('node:fs')).readFileSync(file));
      job.completion.workerPushedHeadSha = requestedHead;
      writeFileSync(file, JSON.stringify(job));
    }
    const result = requestReviewRereview({ rootDir, repo, prNumber, db,
      targetRevisionRef: requestedHead, reason: 'auto-refresh: PR head moved' });
    assert.equal(result.triggered, requestedHead === headSha);
    if (requestedHead !== headSha) assert.equal(result.reason, 'comment-only-final-round-completed');
  });
}
