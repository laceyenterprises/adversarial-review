import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaCloser, updateAmaCloserDispatchRecord, amaCloserDispatchFilePath, _resetHammerRetryCapAlertDebounceForTests } from '../src/ama/dispatch-closer.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, deleteAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { handoffHammerReview } from '../bin/hammer-review-handoff.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { evaluateHammerStopHold } from '../src/ama/hammer-stop-hold.mjs';
import { fetchHammerHeadRange } from '../src/ama/hammer-head-validation.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
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

for (const path of ['daemon', 'closer']) {
  test(`FINALCLOSE-01 ${path} primary-change page leaves the final-round stall receipt available`, async t => {
    const rootDir = finalRound(t), pages = [];
    let clock = Date.parse(started) + 60000;
    const observe = args => observeClosureWait({ ...args, now: clock,
      pageImpl: async (_text, options) => pages.push(options.dedupKey) });
    const refusal = { dispatched: false, skipMergeAgent: true, needsOperator: true,
      reason: path === 'daemon' ? 'primary-change-needs-operator' : 'primary-change-repair-required',
      reasons: ['primary-change-reverted'],
      missingEvidence: { path: 'src/fixture.mjs', summary: 'missing authorization' } };
    const result = await maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber,
      currentRevisionRef: headSha, labelNames: [], now: () => clock,
      reviewStateRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'claude',
        reviewer_head_sha: reviewed, last_verdict: 'Comment only', posted_at: started },
      candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
        mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
      resolveAmaHammerDispatchModeImpl: () => 'inline',
      fetchLatestHeadReviewBodiesImpl: async () => [body],
      proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
      runDaemonCleanMergeAttemptImpl: async () => path === 'daemon' ? refusal : { reason: 'not-eligible' },
      maybeDispatchAmaCloserImpl: async () => refusal,
      recoverStrandedCloserHeadImpl: async () => null,
      observeClosureWaitImpl: observe,
      logger: { log() {}, warn() {} },
    });
    assert.equal(result.reason, refusal.reason);
    assert.deepEqual(pages, [`hamclose:${repo}:${prNumber}:${headSha}:primary-change`]);
    clock = Date.parse(started) + 1800000;
    const wait = await observe({ rootDir, repo, prNumber, headSha,
      waitClass: 'final-round', reason: 'hammer-stalled' });
    assert.equal(wait.notify, true);
    assert.deepEqual(pages, [
      `hamclose:${repo}:${prNumber}:${headSha}:primary-change`,
      `hamclose:${repo}:${prNumber}:${headSha}:final-round`,
    ]);
    assert.equal((await observe({ rootDir, repo, prNumber, headSha,
      waitClass: 'final-round', reason: 'hammer-still-stalled' })).notify, false);
  });
}

for (const handoffHead of [headSha, 'c'.repeat(40)]) {
  test(`FINALCLOSE-01 interrupted handoff admits only its exact final-round head: ${handoffHead === headSha}`, async t => {
    const rootDir = finalRound(t);
    const db = openReviewStateDb(rootDir);
    ensureReviewStateSchema(db);
    db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,review_status,
      reviewer_head_sha,revision_ref) VALUES (?,?,'2026-01-01T00:00:00Z','claude','open','posted',?,?)`)
      .run(repo, prNumber, reviewed, reviewed);
    const identity = { rootDir, repo, prNumber, headSha: handoffHead };
    acquireAmaCloserLease(identity);
    await handoffHammerReview({ ...identity, requestBoundedReviewImpl: async () => null });
    const result = requestReviewRereview({ rootDir, repo, prNumber, db,
      targetRevisionRef: headSha, reason: 'auto-refresh: PR head moved' });
    assert.equal(result.triggered, handoffHead === headSha);
    if (handoffHead !== headSha) assert.equal(result.reason, 'comment-only-final-round-completed');
  });
}

test('FINALCLOSE-01 a history-read-failed final hammer retries under the existing series cap', async t => {
  const f = fixture(t, { ledgerStatus: 'failed', reportedStatus: 'failed' });
  writeAmaAuditEntry({ hqRoot: f.args.dispatchContext.hqRoot, repo, prNumber, headSha,
    now: observed, attempt: { outcome: 'failed-without-merge', head: headSha,
      reason: 'history-read-failed', path: 'hammer', noExecution: true, launchRequestId: 'lrq_finished', historyReadError: 'synthetic API timeout' } });
  f.args.fetchPrimaryChangeImpl = async () => ({ headSha, historyReadFailed: true });
  const result = await maybeDispatchAmaCloser(f.args);
  assert.equal(result.dispatched, true, JSON.stringify(result));
  assert.equal(f.launches.length, 1);
  assert.equal(readHammerRetryCapLedger(f.rootDir, { repo, prNumber }).attemptCount, 2);
});

test('FINALCLOSE-01 transient history failure releases without an evidence read or a stop-hold page', async t => {
  const rootDir = finalRound(t);
  const result = await evaluateHammerStopHold({ rootDir, hqRoot: rootDir, repo, prNumber, headSha,
    prMetadata: { headSha }, now: observed,
    readAuditImpl: () => ({ attempts: [{ head: headSha, path: 'hammer', outcome: 'failed-without-merge',
      reason: 'history-read-failed', startedAt: started }] }),
    fetchPrimaryChangeImpl: async () => assert.fail('a transient read must be retried by the capped hammer'),
    deliverAlertImpl: async () => assert.fail('the shared final-round/cap page owns escalation') });
  assert.equal(result.action, 'release');
});


test('FINALCLOSE-01 starting-head chain transport failure is distinguishable from a negative provenance proof', async () => {
  const args = { repo, reviewedHead: reviewed, currentHead: headSha, hammerBaseHead: headSha,
    remediationRounds: [{ state: 'completed', startHeadSha: reviewed, resultingHeadSha: headSha }],
    get: async () => { throw new Error('synthetic API timeout'); } };
  await assert.rejects(fetchHammerHeadRange(args), error => error.hammerHistoryReadFailed === true
    && /synthetic API timeout/.test(error.message));
  assert.equal(await fetchHammerHeadRange({ ...args, get: async () => ({ status: 'behind' }) }), null);
});

test('FINALCLOSE-01 provenance read abort writes its terminal audit and releases the lease without attempting merge', t => {
  const rootDir = finalRound(t), bin = join(rootDir, 'bin'), runDir = join(rootDir, 'run');
  mkdirSync(bin); mkdirSync(runDir);
  const captured = join(rootDir, 'captured.json');
  writeFileSync(join(bin, 'ama-audit.mjs'), `import {readFileSync,writeFileSync} from 'node:fs';
    const args=process.argv.slice(2); writeFileSync(${JSON.stringify(captured)},readFileSync(args[args.indexOf('--attempt-json')+1]));`);
  writeFileSync(join(bin, 'merge-action-receipt.mjs'), '');
  const procedure = join(rootDir, 'merge.sh');
  writeFileSync(procedure, renderHammerProcedure('hammer-merge', { ROOT_DIR: rootDir, HQ_ROOT: rootDir,
    RUN_DIR: runDir, REPO: repo, PR_NUMBER: String(prNumber), REVIEWED_SHA: reviewed,
    TARGET_REMEDIATION_SHA: headSha, PR_URL: `https://github.com/${repo}/pull/${prNumber}`,
    REVIEWER: 'synthetic-reviewer', RISK_CLASS: 'low', MERGE_METHOD: 'squash' }));
  const result = spawnSync('bash', ['-c', `
    HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=fixture HAM_NODE_BIN="$1"
    HAM_VERDICT_FILE="$2/absent.json" POST_REMEDIATION_SHA="$3"
    HAM_HISTORY_READ_ERROR='synthetic compare API timeout'
    ham_release_merge_lease() { echo released; }
    ham_mark_merge_lease_retryable_abort() { echo "retryable:$1"; }
    source "$4" --history-read-abort
  `, 'fixture', process.execPath, runDir, headSha, procedure], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /retryable:history-read-failed\nreleased/);
  const attempt = JSON.parse(readFileSync(captured));
  assert.equal(attempt.reason, 'history-read-failed');
  assert.equal(attempt.historyReadError, 'synthetic compare API timeout');
  assert.deepEqual(readdirSync(runDir), [], 'history-read abort removes all merge scratch files');
});

test('FINALCLOSE-01 dispatch-only closer admits a stale final head and does not resolve merge evidence', async t => {
  const f = fixture(t), rootDir = finalRound(t);
  f.args.dispatchContext = { ...f.args.dispatchContext, rootDir, reviewedSha: reviewed,
    dispatchRecordHeadSha: reviewed, finalRoundDispatchOnly: true, allowStaleReviewHeadHammerResume: true };
  f.args.reviewState.headSha = reviewed;
  f.args.prMetadata.mergeableState = 'UNKNOWN';
  f.args.resolveHamTerminalRemediationEvidenceImpl = async () => assert.fail('dispatch-only cannot use a merge certificate');
  assert.equal((await maybeDispatchAmaCloser(f.args)).dispatched, true);
  assert.equal(f.launches.length, 1);
});

test('FINALCLOSE-01 first observation thirty minutes after the final push pages immediately', async t => {
  const rootDir = finalRound(t), pages = [];
  await observeClosureWait({ rootDir, repo, prNumber, headSha, now: 1800000,
    startedAt: 0, waitClass: 'final-round', reason: 'coexistence-timeout', pageImpl: async text => pages.push(text) });
  assert.equal(pages.length, 1);
});


test('FINALCLOSE-01 head progress restarts the wait and carries the once-only page across later heads', async t => {
  const rootDir = finalRound(t), pages = [];
  const observe = (head, now, immediate = false) => observeClosureWait({ rootDir, repo, prNumber,
    headSha: head, now, startedAt: 0, waitClass: 'final-round', immediate,
    reason: 'synthetic closure blocker', pageImpl: async text => pages.push(text) });
  await observe(headSha, 0);
  assert.equal((await observe(reviewed, 1799999)).exhausted, false);
  assert.equal((await observe(reviewed, 1800000)).exhausted, false);
  assert.equal((await observe(reviewed, 3599999)).exhausted, true);
  assert.equal(pages.length, 1);
  await observe('d'.repeat(40), 3600000, true);
  assert.equal(pages.length, 1, 'cap exhaustion on another head cannot page twice');
});


test('FINALCLOSE-01 launch progress at the stall deadline restarts the wait without paging', async t => {
  const rootDir = finalRound(t), pages = [];
  const args = { rootDir, repo, prNumber, headSha, startedAt: 0, waitClass: 'final-round',
    reason: 'synthetic blocker', pageImpl: async text => pages.push(text) };
  await observeClosureWait({ ...args, now: 0 });
  assert.equal((await observeClosureWait({ ...args, now: 1800000, progress: true })).exhausted, false);
  assert.equal(pages.length, 0);
  assert.equal((await observeClosureWait({ ...args, now: 1800001 })).exhausted, false);
  assert.equal((await observeClosureWait({ ...args, now: 3600000 })).exhausted, true);
  assert.equal(pages.length, 1);
});


test('FINALCLOSE-01 an exhausted ledger without a dispatch record still pages once', async t => {
  _resetHammerRetryCapAlertDebounceForTests();
  const f = fixture(t, { charged: 2 });
  rmSync(amaCloserDispatchFilePath(f.rootDir, { repo, prNumber, headSha }));
  deleteAmaCloserLease(f.rootDir, { repo, prNumber, headSha });
  for (let tick = 0; tick < 2; tick++) assert.equal((await maybeDispatchAmaCloser(f.args)).reason, 'hammer-retry-cap-exhausted');
  assert.equal(f.launches.length, 0);
  assert.equal(f.pages.length, 1);
});


test('FINALCLOSE-01 a failed page retries even when the head advances during delivery', async t => {
  const rootDir = finalRound(t), pages = [];
  const args = { rootDir, repo, prNumber, now: 0, waitClass: 'final-round', immediate: true, reason: 'synthetic blocker' };
  await assert.rejects(observeClosureWait({ ...args, headSha, pageImpl: async () => {
    await observeClosureWait({ ...args, headSha: reviewed, pageImpl: async () => assert.fail('one page in flight') });
    throw new Error('synthetic transport failure');
  } }), /synthetic transport failure/);
  await observeClosureWait({ ...args, headSha: reviewed, pageImpl: async text => pages.push(text) });
  assert.equal(pages.length, 1);
});

for (const [label, rowHead, settledHead] of [
  ['matching current head', headSha, headSha],
  ['matching stale head', reviewed, reviewed],
  ['mismatched settled head', reviewed, headSha],
]) {
  test(`STOPHOLDREVIEW-01 orchestration posting receipt: ${label}`, async t => {
    const rootDir = mkdtempSync(join(tmpdir(), 'stopholdreview-caller-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const mismatched = rowHead !== settledHead;
    if (mismatched) {
      // A completed current-head job supplies the settled review while the
      // posted row still carries the previous head's receipt.
      const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'fixture__repo-pr-41-current.json'), JSON.stringify({ repo, prNumber,
        status: 'completed', revisionRef: settledHead, completedAt: observed,
        reviewBody: '## Blocking issues\n- **Current-head defect**\n  - **Problem:** synthetic regression\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes' }));
    }
    let dispatches = 0, dispatchedReviewState;
    const result = await maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber,
      currentRevisionRef: headSha, labelNames: [],
      reviewStateRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'claude',
        reviewer_head_sha: rowHead, last_verdict: 'Comment only', posted_at: observed, review_body: body,
        ...(mismatched ? { rereview_reason: `auto-refresh: posted review on stale head ${rowHead}; current head is ${headSha}` } : {}) },
      candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
        mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
      resolveAmaHammerDispatchModeImpl: () => 'inline',
      fetchLatestHeadReviewBodiesImpl: async () => [body],
      proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
      runDaemonCleanMergeAttemptImpl: async () => ({ reason: 'not-eligible' }),
      maybeDispatchAmaCloserImpl: async args => {
        dispatches++;
        dispatchedReviewState = args.reviewState;
        return { dispatched: true };
      },
      logger: { log() {}, warn() {} },
    });
    assert.equal(result.dispatched, true, JSON.stringify(result));
    assert.equal(dispatches, 1);
    assert.equal(dispatchedReviewState.headSha, settledHead, 'settled head comes from the review evidence');
    assert.equal(dispatchedReviewState.postedAt, mismatched ? null : observed,
      'a receipt cannot be borrowed from another reviewed head');
  });
}
