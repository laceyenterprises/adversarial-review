import './helpers/load-aware-timeout-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { maybeDispatchAmaCloser, updateAmaCloserDispatchRecord, amaCloserDispatchFilePath, _resetHammerRetryCapAlertDebounceForTests } from '../src/ama/dispatch-closer.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, deleteAmaCloserLease, readAmaCloserLease, amaCloserLeaseFilePath } from '../src/ama/closer-lease.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { createAmaHammerBackgroundQueue, DEFAULT_AMA_HAMMER_BACKGROUND_BOUND_MS } from '../src/ama-hammer-background-dispatch.mjs';
import { probeOrphanOwnership } from '../src/ama/orphan-watchdog.mjs';
import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { evaluateHammerStopHold, readHammerStopForHead } from '../src/ama/hammer-stop-hold.mjs';
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
      if (argv[0] === 'dispatch') { launches.push(argv); return { stdout: JSON.stringify({ ticketRef: argv[argv.indexOf('--ticket') + 1], dispatchId: 'lrq_next', launchRequestId: 'lrq_next' }) }; }
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
function finalRound(t, rootDir = mkdtempSync(join(tmpdir(), 'finalclose-round-'))) {
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

async function backgroundFinalRound(t, { dispatchOnly = false, lease = false, timeoutMs } = {}) {
  const rootDir = finalRound(t), pages = [], waits = [], waitInputs = [];
  let clock = Date.parse(started) + 40 * 60_000;
  t.mock.timers.enable({ apis: ['Date'], now: clock });
  const launchAt = clock;
  const queue = createAmaHammerBackgroundQueue({ nowMs: () => clock });
  let finish, calls = 0;
  const pending = new Promise(resolve => { finish = resolve; });
  t.after(async () => { finish({ dispatched: false, reason: 'fixture-cleanup' }); await queue.drain(); });
  const identity = { rootDir, repo, prNumber, headSha };
  await observeClosureWait({ ...identity, waitClass: 'final-round', startedAt: Date.parse(started),
    now: Date.parse(started), env: {}, reason: 'dispatch-pending', pageImpl: async text => pages.push(text) });
  await observeClosureWait({ ...identity, waitClass: 'bounded-wait',
    now: Date.parse(started), env: {}, reason: 'earlier-phase', pageImpl: async text => pages.push(text) });
  const args = { rootDir, repoPath: repo, prNumber, currentRevisionRef: headSha, labelNames: [],
    now: () => clock, env: {}, operationTimeoutMs: dispatchOnly ? 10 : 1000,
    reviewStateRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'claude',
      reviewer_head_sha: reviewed, last_verdict: 'Comment only', posted_at: started },
    candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
      mergeable: dispatchOnly ? 'UNKNOWN' : 'MERGEABLE',
      statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true, dispatchTimeoutMs: timeoutMs }) }),
    resolveAmaHammerDispatchModeImpl: () => 'background', amaHammerBackgroundQueueImpl: () => queue,
    fetchPullRequestMergeabilityImpl: () => new Promise(() => {}),
    fetchLatestHeadReviewBodiesImpl: async () => [body],
    fetchCurrentPrStateImpl: async () => ({ state: 'OPEN', headSha, isDraft: false, mergeable: 'MERGEABLE' }),
    proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
    probeClosureOwnershipImpl: async () => ({ owned: true, uncertain: false }),
    runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible',
      reasons: ['non-blocking-findings-present'] }),
    maybeDispatchAmaCloserImpl: async () => {
      calls++;
      if (lease) acquireAmaCloserLease({ ...identity, watcherPid: process.pid, now: new Date(clock).toISOString() });
      return pending;
    },
    observeClosureWaitImpl: async args => {
      waitInputs.push(args);
      const wait = await observeClosureWait({ ...args, now: clock, env: {}, pageImpl: async text => pages.push(text) });
      waits.push(wait);
      return wait;
    },
    logger: { log() {}, warn() {} },
  };
  return { args, identity, queue, pages, waits, waitInputs, launchAt, finish, calls: () => calls,
    advance: ms => { clock = launchAt + ms; t.mock.timers.setTime(clock); } };
}

for (const dispatchOnly of [false, true]) {
  test(`HAMCLOSEWAIT-02 200-second background launch dispatches without paging, dispatch-only=${dispatchOnly}`, async t => {
    const f = await backgroundFinalRound(t, { dispatchOnly });
    if (dispatchOnly) {
      await assert.rejects(maybeDispatchAmaClosureFor(f.args), { code: 'AMA_COEXISTENCE_OPERATION_TIMEOUT' });
      assert.equal(f.calls(), 0);
      assert.deepEqual(f.pages, []);
      return;
    }
    const first = await maybeDispatchAmaClosureFor(f.args);
    assert.equal(first.closerProgressAt, new Date(f.launchAt).toISOString());
    f.advance(180_000);
    const running = await maybeDispatchAmaClosureFor(f.args);
    assert.equal(running.closerProgressAt, first.closerProgressAt);
    assert.equal(running.boundedWait.exhausted, false);
    f.advance(200_000);
    f.finish({ dispatched: true, reason: 'dispatched' });
    await f.queue.drain();
    const beforeSettlement = f.waits.length;
    const settled = await maybeDispatchAmaClosureFor(f.args);
    assert.equal(settled.dispatched, true);
    assert.equal(settled.closerProgressAt, first.closerProgressAt);
    assert.equal(f.waits.length, beforeSettlement + 1, 'settlement records a new wait observation');
    assert.equal(f.waits.at(-1).startedAt, f.launchAt, 'settlement keeps the fixed launch clock');
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.pages, []);
    // Reopen the SQLite store without launch evidence to prove settlement
    // persisted progress rather than merely returning provisional launch credit.
    const observePersistedWait = now => observeClosureWait({ ...f.identity,
      waitClass: 'final-round', reason: 'no-further-progress', now, env: {},
      pageImpl: async text => f.pages.push(text) });
    const persisted = await observePersistedWait(f.launchAt + 20 * 60_000);
    assert.equal(persisted.startedAt, f.launchAt);
    assert.equal(persisted.exhausted, false);
    assert.deepEqual(f.pages, []);
    assert.equal((await observePersistedWait(f.launchAt + 30 * 60_000)).exhausted, true);
    assert.equal((await observePersistedWait(f.launchAt + 31 * 60_000)).exhausted, true);
    assert.equal(f.pages.length, 1, 'settlement preserves the fixed deadline and one-page receipt');
  });

  test(`HAMCLOSEWAIT-02 undispatched settlement restores original wait and reasons, dispatch-only=${dispatchOnly}`, async t => {
    const f = await backgroundFinalRound(t, { dispatchOnly, lease: !dispatchOnly });
    if (dispatchOnly) {
      await assert.rejects(maybeDispatchAmaClosureFor(f.args), { code: 'AMA_COEXISTENCE_OPERATION_TIMEOUT' });
      assert.equal(f.calls(), 0);
      assert.deepEqual(f.pages, []);
      return;
    }
    if (!dispatchOnly) f.args.runDaemonCleanMergeAttemptImpl = async () => ({
      disposition: 'not-taken', reason: 'not-eligible', reasons: ['pending-required-checks'], ciMergePathPending: true,
    });
    await maybeDispatchAmaClosureFor(f.args);
    f.advance(200_000);
    f.finish({ dispatched: false, reason: 'not-eligible', reasons: ['ci-not-green'] });
    await f.queue.drain();
    const beforeSettlement = f.waits.length;
    const result = await maybeDispatchAmaClosureFor(f.args);
    assert.ok(f.waits.length > beforeSettlement, 'refusal records a new wait observation');
    assert.equal(result.reason, 'not-eligible');
    assert.equal(result.closerProgressAt, undefined);
    assert.equal(f.waits.at(-1).startedAt, Date.parse(started));
    assert.equal(f.pages.length, 1);
    assert.match(f.pages[0], /ci-not-green/);
    assert.doesNotMatch(f.pages[0], /dispatch-backgrounded|in-flight/);
    assert.equal(f.calls(), 1);
  });
}

for (const timeoutMs of [240_000, undefined]) {
  test(`HAMCLOSEWAIT-02 background dispatch pages at its own bound ${timeoutMs ?? 'fallback'}`, async t => {
    const f = await backgroundFinalRound(t, { timeoutMs });
    const bound = timeoutMs ?? DEFAULT_AMA_HAMMER_BACKGROUND_BOUND_MS;
    await maybeDispatchAmaClosureFor(f.args);
    f.advance(bound - 1);
    assert.equal((await maybeDispatchAmaClosureFor(f.args)).boundedWait.exhausted, false);
    assert.deepEqual(f.pages, []);
    f.advance(bound + 1);
    const result = await maybeDispatchAmaClosureFor(f.args);
    assert.equal(result.boundedWait.exhausted, true);
    assert.match(result.reason, /ama-closer-dispatch-overrun/);
    assert.equal(f.pages.length, 1);
    assert.match(f.pages[0], new RegExp(`elapsed_ms=${bound + 1} bound_ms=${bound}`));
    f.advance(bound + 30_000);
    await maybeDispatchAmaClosureFor(f.args);
    assert.equal(f.pages.length, 1, 'overruns retain the existing page receipt');
  });
}

test('HAMCLOSEWAIT-02 pending lease held by the running background dispatch gets launch credit', async t => {
  const f = await backgroundFinalRound(t, { lease: true });
  await maybeDispatchAmaClosureFor(f.args);
  f.advance(180_000);
  const before = f.waits.length;
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.match(result.reason, /^in-flight:/);
  assert.equal(result.closerProgressAt, new Date(f.launchAt).toISOString());
  assert.equal(f.waits.length, before + 2, 'inner and outer lease observations both apply launch credit');
  assert.equal(result.boundedWait.exhausted, false);
  for (const input of f.waitInputs.slice(before)) assert.equal(input.waitClass, 'final-round');
  for (const wait of f.waits.slice(before)) assert.equal(wait.boundedMs, 900_000);
  assert.deepEqual(f.pages, []);
  f.advance(DEFAULT_AMA_HAMMER_BACKGROUND_BOUND_MS + 1);
  assert.match((await maybeDispatchAmaClosureFor(f.args)).reason, /ama-closer-dispatch-overrun/);
  assert.equal(f.pages.length, 1);
});

test('HAMCLOSEWAIT-02 queued work that never starts keeps the original exhaustion page', async t => {
  const f = await backgroundFinalRound(t);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  for (let index = 0; index < 3; index++) f.queue.submit({ key: `example/repo#${index}@queued`, run: () => pending });
  try {
    const result = await maybeDispatchAmaClosureFor(f.args);
    assert.equal(result.backgroundDispatch.state, 'queued');
    assert.equal(result.closerProgressAt, undefined);
    assert.equal(f.calls(), 0);
    assert.equal(f.pages.length, 1);
    assert.match(f.pages[0], /ama-closer-dispatch-backgrounded/);
    assert.equal(f.waits.at(-1).startedAt, Date.parse(started));
  } finally {
    release({ dispatched: false });
    f.finish({ dispatched: false });
    await f.queue.drain();
  }
});

test('HAMCLOSEWAIT-02 a foreign-host pending lease with the same PID gets no background launch credit', async t => {
  const f = await backgroundFinalRound(t, { lease: true });
  await maybeDispatchAmaClosureFor(f.args);
  deleteAmaCloserLease(f.identity.rootDir, { repo, prNumber, headSha });
  acquireAmaCloserLease({ ...f.identity, watcherPid: process.pid, host: 'synthetic-remote',
    now: new Date(f.launchAt).toISOString() });
  f.advance(180_000);
  const result = await maybeDispatchAmaClosureFor(f.args);
  assert.match(result.reason, /^in-flight:/);
  assert.equal(result.closerProgressAt, undefined);
  assert.equal(f.pages.length, 1);
  assert.match(f.pages[0], /in-flight:/);
});

for (const reason of ['operator-label-classification-pending', 'background-pr-state-unavailable', 'deferred-by-drain']) {
test(`HAMCLOSEWAIT-02 immediate background retries still page with the settled blocker ${reason}`, async t => {
  const f = await backgroundFinalRound(t);
  await maybeDispatchAmaClosureFor(f.args);
  f.advance(200_000);
  f.finish({ dispatched: false, reason });
  await f.queue.drain();
  const before = f.waitInputs.length;
  await maybeDispatchAmaClosureFor(f.args);
  assert.equal(f.waitInputs[before].reason, reason);
  assert.equal(f.waitInputs[before].waitClass, 'final-round');
  assert.equal(f.waits[before].startedAt, Date.parse(started));
  assert.equal(f.waits[before].exhausted, true);
  assert.equal(f.pages.length, 1);
  assert.ok(f.pages[0].includes(reason));
  assert.doesNotMatch(f.pages[0], /dispatch-backgrounded/);
});
}

const minute = 60_000;
for (const [reason, age, expectedPages] of [
  ['existing-dispatch-running', 20, 0],
  ['existing-dispatch-running', 35, 1],
  ['existing-dispatch-stalled', null, 1],
  ['dispatch-held', null, 1],
  ['all-fallbacks-grounded', null, 1],
  ['daemon-closure-failed', null, 1],
  ['handed-to-review', null, 1],
]) test(`HAMCLOSEWAIT-01 ${reason} with closer age ${age} minutes`, async t => {
  const rootDir = finalRound(t), pages = [];
  const clock = Date.parse(started) + 40 * minute;
  const closerProgressAt = age === null ? undefined : new Date(clock - age * minute).toISOString();
  // Seed a previous poll before launch: updating only INSERT cannot repair it.
  const observe = args => observeClosureWait({ ...args, env: {}, now: clock,
    pageImpl: async text => pages.push(text) });
  await observeClosureWait({ rootDir, repo, prNumber, headSha, waitClass: 'final-round',
    startedAt: Date.parse(started), now: Date.parse(started), env: {},
    reason: 'dispatch-pending', pageImpl: async text => pages.push(text) });
  for (let tick = 0; tick < 2; tick++) {
    const result = await maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber,
      currentRevisionRef: headSha, labelNames: [], now: () => clock, env: {}, operationTimeoutMs: 1000,
      reviewStateRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'claude',
        reviewer_head_sha: reviewed, last_verdict: 'Comment only', posted_at: started },
      candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
        mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
      resolveAmaHammerDispatchModeImpl: () => 'inline',
      fetchLatestHeadReviewBodiesImpl: async () => [body],
      proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
      runDaemonCleanMergeAttemptImpl: async () => assert.fail('wait never grants merge authority'),
      maybeDispatchAmaCloserImpl: async () => ({ dispatched: false, reason, closerProgressAt,
        closerLaunchAlive: reason === 'existing-dispatch-running' }),
      observeClosureWaitImpl: observe,
      logger: { log() {}, warn() {} },
    });
    assert.equal(result.reason, reason);
  }
  assert.equal(pages.length, expectedPages);
  if (reason === 'existing-dispatch-running' && expectedPages) {
    assert.match(pages[0], /still running after 35 minutes/);
    assert.doesNotMatch(pages[0], /exhausted/);
  }
});

// Exercise the review's absent/terminal lease trigger through the real closer,
// then carry its retained result through orchestration to the notice observer.
for (const status of ['running', 'starting']) {
  for (const leaseStatus of ['absent', 'terminal']) {
    test(`LOADAR-01 retained ${status} closer with ${leaseStatus} lease keeps live notice`, async t => {
      const f = fixture(t, { ledgerStatus: 'running', reportedStatus: status });
      finalRound(t, f.rootDir);
      if (leaseStatus === 'absent') deleteAmaCloserLease(f.rootDir, { repo, prNumber, headSha });
      else updateAmaCloserLease({ rootDir: f.rootDir, repo, prNumber, headSha, status: leaseStatus, terminalOutcome: 'failed-without-merge' });
      const clock = Date.parse(started) + 40 * minute;
      const pages = [];
      let calls = 0;
      const args = { rootDir: f.rootDir, repoPath: repo, prNumber, currentRevisionRef: headSha,
        labelNames: [], env: {}, now: () => clock,
        reviewStateRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'claude',
          reviewer_head_sha: reviewed, last_verdict: 'Comment only', posted_at: started },
        candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
          mergeable: 'MERGEABLE', statusCheckRollup: f.args.prMetadata.statusCheckRollup },
        loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
        resolveAmaHammerDispatchModeImpl: () => 'inline',
        fetchLatestHeadReviewBodiesImpl: async () => [body],
        proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
        probeClosureOwnershipImpl: async () => assert.fail('absent/terminal handoff lease cannot enter ownership wait'),
        runDaemonCleanMergeAttemptImpl: async () => ({ disposition: 'not-taken', reason: 'not-eligible',
          reasons: ['non-blocking-findings-present'] }),
        maybeDispatchAmaCloserImpl: async () => { calls++; return maybeDispatchAmaCloser(f.args); },
        observeClosureWaitImpl: options => observeClosureWait({ ...options, now: clock,
          pageImpl: async text => pages.push(text) }),
        logger: { log() {}, warn() {} },
      };
      for (let poll = 0; poll < 2; poll++) {
        const result = await maybeDispatchAmaClosureFor(args);
        assert.equal(result.reason, `existing-dispatch-${status}`);
        assert.equal(result.closerLaunchAlive, true);
      }
      assert.equal(calls, 2);
      assert.equal(f.launches.length, 0);
      assert.equal(pages.length, 1, 'live notice still consumes the once-only receipt');
      assert.match(pages[0], /closure still running after 40 minutes/);
      assert.doesNotMatch(pages[0], /exhausted/);
    });
  }
}

for (const status of ['running', 'starting', 'stalled', 'blocked', 'unknown', 'succeeded']) {
  test(`HAMCLOSEWAIT-01 retained ${status} dispatch only reports active-running progress`, async t => {
    const f = fixture(t, { ledgerStatus: 'running', reportedStatus: status });
    if (status === 'succeeded') {
      f.args.readBuildCompletionSignalForPrImpl = () => ({ ok: false, reason: 'ledger-read-failed' });
    }
    if (status === 'unknown') {
      const exec = f.args.execFileImpl;
      f.args.execFileImpl = async (cmd, argv) => {
        if (argv[0] === 'dispatch' && argv[1] === 'status') throw new Error('status probe unavailable');
        return exec(cmd, argv);
      };
    }
    const result = await maybeDispatchAmaCloser(f.args);
    assert.equal(result.reason, status === 'succeeded' ? 'live-owner' : status === 'unknown' ? 'dispatch-status-unknown' : `existing-dispatch-${status}`);
    assert.equal(result.namedReason, result.reason, 'retained returns share the named no-dispatch reason');
    assert.equal(result.closerLaunchAlive === true, status === 'running' || status === 'starting');
    if (status === 'running' || status === 'starting') assert.equal(result.closerProgressAt, started);
    else assert.equal(Object.hasOwn(result, 'closerProgressAt'), false);
    assert.equal(f.launches.length, 0, 'retained ownership never launches a duplicate');
  });
}

test('HAMCLOSEWAIT-01 real exhausted-fallback dispatch does not report closer progress', async t => {
  const f = fixture(t);
  let resolverCalls = 0;
  f.args.resolveCloserDispatchHarnessImpl = async () => {
    resolverCalls++;
    return { hold: true, reason: 'all-fallbacks-grounded' };
  };
  const result = await maybeDispatchAmaCloser(f.args);
  assert.equal(result.reason, 'all-fallbacks-grounded');
  assert.equal(Object.hasOwn(result, 'closerProgressAt'), false);
  assert.equal(resolverCalls, 1);
  assert.equal(f.launches.length, 0);
});

test('HAMCLOSEWAIT-01 future timestamps cannot refresh the deadline on every poll', async t => {
  const rootDir = finalRound(t), pages = [];
  const args = { rootDir, repo, prNumber, headSha, waitClass: 'final-round', env: {},
    startedAt: 24 * 60 * minute, reason: 'future-dated-progress',
    pageImpl: async text => pages.push(text) };
  // A new row clamps to its first observation; subsequent polls keep that clock.
  for (const now of [0, 10, 20, 30, 31]) {
    const wait = await observeClosureWait({ ...args, now: now * minute });
    assert.equal(wait.startedAt, 0);
    assert.equal(wait.exhausted, now >= 30);
  }
  assert.equal(pages.length, 1);
});

for (const [status, uncertain, expectedPages] of [
  ['dispatched', false, 0], ['pending', false, 1], ['dispatched', true, 1],
]) test(`HAMCLOSEWAIT-01 in-flight ${status}, uncertain=${uncertain}`, async t => {
  const rootDir = finalRound(t), pages = [], waits = [];
  const clock = Date.parse(started) + 40 * minute;
  t.mock.timers.enable({ apis: ['Date'], now: clock });
  const identity = { rootDir, repo, prNumber, headSha };
  acquireAmaCloserLease({ ...identity, watcherPid: process.pid,
    now: new Date(clock - 25 * minute).toISOString() });
  const closerProgressAt = new Date(clock - 20 * minute).toISOString();
  updateAmaCloserLease({ ...identity, status, lrqId: 'synthetic-closer', now: closerProgressAt });
  const observe = args => observeClosureWait({ ...args, now: clock, env: {},
    pageImpl: async text => pages.push(text) }).then(wait => { waits.push(wait); return wait; });
  await observeClosureWait({ ...identity, waitClass: 'final-round', startedAt: Date.parse(started),
    now: Date.parse(started), env: {}, reason: 'dispatch-pending', pageImpl: async text => pages.push(text) });
  const result = await maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber,
    currentRevisionRef: headSha, labelNames: [], now: () => clock, env: {},
    reviewStateRow: { repo, pr_number: prNumber, review_status: 'posted', reviewer: 'claude',
      reviewer_head_sha: reviewed, last_verdict: 'Comment only', posted_at: started },
    candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
      mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => [body],
    proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
    probeClosureOwnershipImpl: async () => ({ owned: !uncertain, uncertain }),
    runDaemonCleanMergeAttemptImpl: async () => assert.fail('in-flight wait never merges'),
    maybeDispatchAmaCloserImpl: async () => assert.fail('in-flight wait never dispatches'),
    observeClosureWaitImpl: observe,
    logger: { log() {}, warn() {} },
  });
  assert.equal(result.reason, `in-flight:${status === 'pending' ? process.pid : 'synthetic-closer'}`);
  assert.equal(result.closerProgressAt, status === 'dispatched' && !uncertain ? closerProgressAt : undefined);
  assert.equal(pages.length, expectedPages);
  assert.equal(waits.length, 2, 'both inner and outer observations must honor the launch clock');
  assert.equal(waits[0].exhausted, expectedPages === 1);
});

test('HAMCLOSEWAIT-01 real ownership of an old dispatched lease cannot extend its stall clock', async t => {
  const rootDir = finalRound(t), pages = [];
  const clock = Date.parse(started) + 40 * minute;
  const closerProgressAt = new Date(clock - 35 * minute).toISOString();
  const identity = { rootDir, repo, prNumber, headSha };
  acquireAmaCloserLease({ ...identity, watcherPid: process.pid, now: started });
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'synthetic-closer', now: closerProgressAt });
  updateAmaCloserDispatchRecord(rootDir, identity, () => ({ repo, prNumber, headSha,
    state: 'dispatched', launchRequestId: 'synthetic-closer', dispatchedAt: closerProgressAt }));
  let probes = 0;
  const ownership = await probeOrphanOwnership({ ...identity,
    readStatusImpl: async ({ launchRequestId }) => {
      assert.equal(launchRequestId, 'synthetic-closer');
      probes++;
      return { ok: true, row: { status: 'running' } };
    } });
  assert.equal(probes, 1);
  assert.equal(ownership.owned, true);
  assert.equal(ownership.uncertain, false);
  // Ownership is independent of lease age. Even if a caller retains the
  // launch, its fixed progress timestamp must not suppress the stall page.
  const wait = await observeClosureWait({ ...identity, waitClass: 'final-round',
    startedAt: Date.parse(closerProgressAt), now: clock, env: {}, reason: 'in-flight:synthetic-closer',
    pageImpl: async text => pages.push(text) });
  assert.equal(wait.exhausted, true);
  assert.equal(wait.startedAt, Date.parse(closerProgressAt));
  assert.equal(pages.length, 1);
});

test('HAMCLOSEWAIT-01 a fixed progress timestamp eventually pages and immediate pages still win', async t => {
  const rootDir = finalRound(t), pages = [];
  const args = { rootDir, repo, prNumber, headSha, waitClass: 'final-round', env: {},
    reason: 'in-flight:synthetic-closer', pageImpl: async text => pages.push(text) };
  await observeClosureWait({ ...args, startedAt: 0, now: 0 });
  for (const now of [40, 45, 49, 50, 51]) {
    const wait = await observeClosureWait({ ...args, startedAt: 20 * minute, now: now * minute });
    assert.equal(wait.startedAt, 20 * minute);
    assert.equal(wait.exhausted, now >= 50);
  }
  assert.equal(pages.length, 1);
  await observeClosureWait({ ...args, prNumber: prNumber + 1,
    startedAt: 40 * minute, now: 40 * minute, progress: true, immediate: true });
  assert.equal(pages.length, 2);
});
for (const operation of ['mergeability', 'live-review', 'stale-proof']) {
  test(`FINALCLOSE-01 final-round ${operation} timeout refuses dispatch and merge`, async t => {
    const rootDir = finalRound(t);
    const stall = () => new Promise(() => {});
    let launches = 0, merges = 0;
    await assert.rejects(maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber,
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
    }), { code: 'AMA_COEXISTENCE_OPERATION_TIMEOUT' });
    assert.equal(launches, 0);
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
    if (path === 'daemon') {
      const finalJob = join(rootDir, 'data', 'follow-up-jobs', 'completed', 'fixture__repo-pr-41-final.json');
      const cleanBody = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nComment only';
      const job = JSON.parse(readFileSync(finalJob, 'utf8'));
      writeFileSync(finalJob, JSON.stringify({ ...job, revisionRef: headSha, reviewBody: cleanBody, completion: {} }));
    }
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
        reviewer_head_sha: path === 'daemon' ? headSha : reviewed, last_verdict: 'Comment only', posted_at: started },
      candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
        mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
      loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
      resolveAmaHammerDispatchModeImpl: () => 'inline',
      fetchLatestHeadReviewBodiesImpl: async () => [path === 'daemon'
        ? '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved' : body],
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
    updateAmaCloserLease({ ...identity, status: 'handed-to-review' }); // Legacy receipt fixture.
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
    let dispatches = 0, observedReviewState;
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
      requestEligibleHammerWakeImpl: ({ shared }) => { observedReviewState = shared.snapshot.observations.reviews.value; },
      maybeDispatchAmaCloserImpl: async args => {
        dispatches++;
        return { dispatched: true };
      },
      logger: { log() {}, warn() {} },
    });
    assert.equal(result.dispatched, false, JSON.stringify(result));
    assert.equal(dispatches, 0);
    assert.ok(['review', 'remediate'].includes(result.nextAction.action));
    assert.equal(observedReviewState.headSha, settledHead, 'settled head comes from the review evidence');
    assert.equal(observedReviewState.postedAt, mismatched ? null : observed,
      'a receipt cannot be borrowed from another reviewed head');
  });
}

test('HAMNOREREVIEW-01 a legacy handoff stop releases before SQLite review reconciliation', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'stopholdreview-reconcile-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'completed');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture__repo-pr-41-current.json'), JSON.stringify({ repo, prNumber,
    status: 'completed', revisionRef: headSha, completedAt: observed, reviewBody: body }));
  const hqRoot = join(rootDir, 'hq');
  writeAmaAuditEntry({ hqRoot, repo, prNumber, headSha, now: started,
    attempt: { outcome: 'failed-without-merge', head: headSha, path: 'hammer',
      reason: 'exact-head-review-required' } });
  const reviewStateRow = { repo, pr_number: prNumber, review_status: 'pending', reviewer: 'claude',
    reviewer_head_sha: headSha, last_verdict: 'Comment only', posted_at: observed, review_body: body,
    rereview_reason: `auto-refresh: posted review on stale head ${reviewed}; current head is ${headSha}` };
  let liveReads = 0;
  const holds = [];
  const args = { rootDir, repoPath: repo, prNumber, currentRevisionRef: headSha, labelNames: [],
    readHammerStopForHeadImpl: options => readHammerStopForHead({ ...options, hqRoot }),
    reviewStateRow,
    candidate: { headSha, prState: 'open', riskClass: 'low', prAuthor: 'synthetic-builder',
      mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true }) }),
    resolveAmaHammerDispatchModeImpl: () => 'inline',
    fetchLatestHeadReviewBodiesImpl: async () => { liveReads++; return [body]; },
    proveCloserAuthoredStaleHeadImpl: async () => ({ proven: false }),
    runDaemonCleanMergeAttemptImpl: async () => ({ reason: 'not-eligible' }),
    maybeDispatchAmaCloserImpl: async ({ reviewState, prMetadata }) => {
      holds.push(await evaluateHammerStopHold({ rootDir, hqRoot, repo, prNumber, headSha,
        reviewedSha: headSha, reviewState, prMetadata, now: observed,
        deliverAlertImpl: async () => ({ ok: true }), logger: { warn() {} } }));
      assert.equal(reviewState.postedAt, reviewStateRow.review_status === 'posted' ? observed : null);
      return { dispatched: false, reason: 'fixture' };
    },
    logger: { log() {}, warn() {} },
  };
  const result = await maybeDispatchAmaClosureFor(args);
  assert.equal(holds.length, 1, JSON.stringify(result));
  assert.equal(liveReads, 1, 'the pending-row pass resolved the live review body');
  assert.equal(holds[0].action, 'release', 'hammer responsibility needs no later review receipt');
  reviewStateRow.review_status = 'posted';
  await maybeDispatchAmaClosureFor(args);
  assert.equal(liveReads, 2);
  assert.equal(holds[1].action, 'release', 'a later pass observes the reconciled receipt');
  assert.deepEqual(holds[1].changed, ['hammer-responsibility']);
});


for (const scenario of ['dead', 'hostless-dead', 'timeout', 'live', 'hostless-live', 'current', 'hostless-current', 'launch', 'hold', 'probe-timeout']) {
  test(`CLOSERLEASEDEAD-01 closure routing ${scenario}`, async t => {
    const f = await backgroundFinalRound(t);
    f.finish({ dispatched: false, reason: 'fixture-unused' });
    const now = f.launchAt;
    const lease = acquireAmaCloserLease({ ...f.identity, host: hostname(),
      watcherPid: ['current', 'hostless-current'].includes(scenario) ? process.pid : 4242,
      now: new Date(now - 60_000).toISOString(), dispatchTimeoutMs: scenario === 'timeout' ? 30_000 : 120_000 }).lease;
    if (scenario.startsWith('hostless-')) {
      delete lease.holderHost;
      writeFileSync(amaCloserLeaseFilePath(f.identity.rootDir, f.identity), JSON.stringify(lease));
    }
    if (scenario === 'launch') updateAmaCloserLease({ ...f.identity, status: 'dispatched', lrqId: 'lrq_live' });
    let dispatches = 0;
    const result = await maybeDispatchAmaClosureFor({ ...f.args,
      labelNames: scenario === 'hold' ? ['no-merge-hold'] : [],
      resolveAmaHammerDispatchModeImpl: () => 'inline',
      closerLeaseLivenessOptions: { isProcessAlive: () => ['live', 'hostless-live', 'probe-timeout'].includes(scenario),
        captureProcessImpl: () => ({ startedAt: new Date(now - 120_000).toISOString() }) },
      probeClosureOwnershipImpl: async () => {
        if (scenario === 'probe-timeout') f.advance(60_001);
        return { owned: scenario === 'launch', uncertain: scenario !== 'launch',
          launchIds: scenario === 'launch' ? ['lrq_live'] : [] };
      },
      maybeDispatchAmaCloserImpl: async () => {
        dispatches++;
        const after = readAmaCloserLease(f.identity.rootDir, f.identity);
        assert.equal(after.status, 'terminal');
        assert.equal(after.terminalOutcome, ['dead', 'hostless-dead'].includes(scenario) ? 'abandoned-holder-dead' : 'abandoned-timeout');
        return { dispatched: true, reason: 'fixture-dispatched' };
      },
    });
    const released = ['dead', 'hostless-dead', 'timeout', 'probe-timeout'].includes(scenario);
    assert.equal(dispatches, released ? 1 : 0);
    if (released) assert.equal(result.dispatched, true);
    else if (scenario !== 'hold') assert.match(result.reason, /^in-flight:/);
    else assert.deepEqual(readAmaCloserLease(f.identity.rootDir, f.identity), lease);
  });
}
