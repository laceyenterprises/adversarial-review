// Child of smv-smoke: only synthetic records and file-protocol Git are permitted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
net.Socket.prototype.connect = () => { throw new Error('SMV network boundary refused'); };
globalThis.fetch = () => { throw new Error('SMV fetch boundary refused'); };
syncBuiltinESMExports();
const { createFixtureStubReviewerRuntimeAdapter } = await import('../../src/adapters/reviewer-runtime/fixture-stub/index.mjs');
const { readReviewerRunRecord } = await import('../../src/adapters/reviewer-runtime/run-state.mjs');
const { createNoProgressLaneGate } = await import('../../src/posted-review-row.mjs');
const { readNoProgressLane } = await import('../../src/watcher-no-progress-lane.mjs');
const { observeClosureWait } = await import('../../src/ama/closure-wait.mjs');
const { watcherTick, cleanBody } = await import('./smv-watcher.mjs');
const { createFollowUpJob, writeFollowUpJob } = await import('../../src/follow-up-jobs.mjs');
const { consumeFollowUpJobsUntilCapacity, consumeNextFollowUpJob } = await import('../../src/follow-up-remediation.mjs');
const { AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS, acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease, isHeldAmaCloserLease } = await import('../../src/ama/closer-lease.mjs');
const { maybeDispatchAmaCloser, readAmaCloserDispatchRecord, reconcileAmaCloserLeaseAsync, findActiveAmaCloserLaunches, settleRefusedHammerWake,
  updateAmaCloserDispatchRecord } = await import('../../src/ama/dispatch-closer.mjs');
const { hammerWakeEligibility, requestEligibleHammerWake } = await import('../../src/hammer-wake.mjs');
const { routeCappedReviewToClosure } = await import('../../src/hamclose-review-admission.mjs');
const { handoffHammerReview } = await import('../../bin/hammer-review-handoff.mjs');
const { guardRereviewCiBeforeReviewer } = await import('../../src/reviewer-ci-admission.mjs');
const { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } = await import('../../src/review-state.mjs');
const { prepareMarkRereviewCiBlocked, prepareMarkAttemptStarted, prepareMarkPosted,
  prepareReleaseUnsettledPostedReview } = await import('../../src/review-state-statements.mjs');
const { requeuePostedReviewWithoutHead } = await import('../../src/posted-review-head-repair.mjs');
const { decideClosureOwner } = await import('../../src/ama/closure-owner.mjs');
const { fleetCommitIdentityMatches } = await import('../../src/ama/hammer-head-validation.mjs');
const rootDir = process.cwd(), repo = 'fixture/repo', prNumber = 7;
const quiet = { log() {}, warn() {}, error() {} };
const refuse = () => { throw new Error('unexpected worker/GitHub/notification boundary'); };
const drain = { rootDir, promptTemplate: 'synthetic', maxConcurrent: 1, log: quiet, logger: quiet,
  guardStackedBaseImpl: async () => null,
  quotaHoldRevalidator: () => ({ available: true }), requestWatcherWakeImpl: () => ({ requested: true }),
  execFileImpl: refuse, spawnImpl: refuse, deliverAlertImpl: refuse, postCommentImpl: refuse };
const gitDir = join(rootDir, 'git'); mkdirSync(gitDir);
const git = (...args) => execFileSync('git', ['-C', gitDir, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic Author', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic Committer', GIT_COMMITTER_EMAIL: 'committer@example.invalid' } }).trim();
git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'Synthetic base');
const base = git('rev-parse', 'HEAD');
git('init', '--bare', '-q', join(rootDir, 'remote.git')); git('remote', 'add', 'origin', join(rootDir, 'remote.git')); git('push', '-q', 'origin', 'main');
git('checkout', '-q', '-b', 'synthetic'); writeFileSync(join(gitDir, 'fixture.txt'), 'synthetic change\n'); git('add', 'fixture.txt'); git('commit', '-q', '-m', 'Synthetic unsigned change');
let headSha = git('rev-parse', 'HEAD');
assert.equal(git('show', '-s', '--format=%G?', headSha), 'N');
const identity = () => ({ rootDir, repo, prNumber, headSha });
const store = { merged: false };
const tick = (overrides = {}) => watcherTick({ ...identity(), evidence: { headSha, hasHammerCommits: false }, store,
  row: { review_status: 'posted', reviewer_head_sha: headSha, reviewer: 'gemini', review_body: cleanBody },
  runMerge: async expected => { assert.equal(expected, headSha); git('checkout', '-q', 'main'); git('merge', '--ff-only', expected); git('push', '-q', 'origin', 'main'); }, ...overrides });
const scenario = process.argv[2];
let evidence = {};
if (scenario === 'clean') {
  const review = await createFixtureStubReviewerRuntimeAdapter({ rootDir, reviewerBodies: [cleanBody] }).spawnReviewer({ sessionUuid: 'synthetic-review' });
  assert.equal(review.reviewBody, cleanBody); assert.equal(readReviewerRunRecord(rootDir, 'synthetic-review').state, 'completed');
  await tick(); assert.equal(store.merged, true);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], headSha);
  evidence = { merged: true, unsignedSyntheticHead: true, remoteHeadMatches: true };
} else if (scenario === 'handoff') {
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status,revision_ref)
    VALUES (?,?,'2026-01-01','gemini','pending',?)`).run(repo, prNumber, headSha);
  const claim = () => prepareMarkAttemptStarted(db).run('2026-01-01', 'synthetic-claim', headSha,
    headSha, 600000, '2026-01-01T00:10:00Z', headSha, repo, prNumber);
  assert.equal(claim().changes, 1);
  assert.equal(requestReviewRereview({ db, rootDir, repo, prNumber, targetRevisionRef: headSha,
    reason: `system-orphan-head-review:${headSha}`, ownerlessRecovery: true }).reason, 'review-in-flight');
  const read = () => db.prepare('SELECT * FROM reviewed_prs WHERE repo=? AND pr_number=?').get(repo, prNumber);
  assert.equal(read().reviewer_session_uuid, 'synthetic-claim');
  assert.equal(read().reviewer_head_sha, headSha);
  assert.equal(prepareMarkPosted(db).run('2026-01-01', null, repo, prNumber, 'synthetic-claim', null).changes, 0);
  assert.equal(prepareReleaseUnsettledPostedReview(db).run(headSha, repo, prNumber, 'synthetic-claim').changes, 1);
  assert.equal(read().review_status, 'pending'); assert.equal(read().review_attempts, 0);
  assert.equal(claim().changes, 1);
  assert.equal(prepareMarkPosted(db).run('2026-01-01', headSha, repo, prNumber, 'synthetic-claim', headSha).changes, 1);
  assert.equal(read().review_status, 'posted'); assert.equal(read().reviewer_head_sha, headSha);
  db.prepare('UPDATE reviewed_prs SET reviewer_head_sha=NULL WHERE repo=? AND pr_number=?').run(repo, prNumber);
  const repair = () => requeuePostedReviewWithoutHead({ db, repo, prNumber, headSha, logger: quiet });
  assert.equal(repair(), true); assert.equal(repair(), false);
  assert.equal(read().review_attempts, 1); assert.equal(read().infra_auto_recover_attempts, 0);
  assert.equal(claim().changes, 1);
  assert.equal(prepareMarkPosted(db).run('2026-01-01', headSha, repo, prNumber, 'synthetic-claim', headSha).changes, 1);
  db.close();
  // A finding routes through the watcher/closure hub to the fake hammer boundary.
  let hammers = 0;
  await tick({ findings: true, closerImpl: async () => {
    assert.equal(acquireAmaCloserLease(identity()).acquired, true); hammers++;
    let isDraining = true;
    const closerArgs = {
      cfg: { enabled: true, workerClass: 'hammer', branchProtection: { required: false }, eligibility: { riskClasses: ['low'] } },
      reviewState: { verdict: 'comment-only', headSha, riskClass: 'low', reviewCycleExhausted: true, remediationPending: false,
        blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known', nonBlockingFindingCount: 1 },
      prMetadata: { prNumber, headSha, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
        statusCheckRollup: [{ name: 'synthetic-ci', conclusion: 'SUCCESS' }], branchProtection: { requiredContexts: [] } },
      dispatchContext: { rootDir, repo, reviewedSha: headSha, riskClass: 'low', reviewedBy: 'synthetic-reviewer', reviewer: 'gemini',
        parentSession: 'synthetic-parent', hqPath: 'hq', hqRoot: join(rootDir, 'hq'), currentUser: userInfo().username, hqOwnerUser: userInfo().username,
        livePrProbeImpl: async () => ({ state: 'OPEN', headRefOid: headSha, headBranchExists: true, headRefName: 'synthetic' }) },
      readDispatchDrainStatusImpl: async () => ({ isDraining, epoch: 7 }),
      execFileImpl: async (_command, args) => { assert.ok(args.includes('dispatch'));
        if (isDraining) throw Object.assign(new Error('synthetic deploy'), { code: 6, stderr: '[hq] dispatch refused: drain in effect (epoch=7)' });
        return { stdout: JSON.stringify({ ticketRef: 'HAM', dispatchId: 'synthetic-hammer', launchRequestId: 'synthetic-hammer' }) }; },
      readTemplateImpl: () => 'Synthetic hammer <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>', writeFileImpl() {},
      resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
      readBuildCompletionSignalForPrImpl: () => ({ ok: false }), readBuildCompletionProducerEvidenceImpl: () => ({ ok: false }), logger: quiet,
    };
    const deferred = await maybeDispatchAmaCloser(closerArgs);
    assert.equal(deferred.reason, 'deferred-by-drain');
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).drainEpoch, '7');
    const laneGate = createNoProgressLaneGate({ rootDir, hqRoot: join(rootDir, 'hq'), logger: quiet, readReviewRow: () => null });
    const handler = { repoPath: repo, prNumber, headSha };
    await laneGate.record(handler, { value: { amaClosureResult: deferred } });
    assert.equal(readNoProgressLane(rootDir, identity()), null);
    assert.equal((await maybeDispatchAmaCloser(closerArgs)).reason, 'deferred-by-drain');
    const drainRecord = readAmaCloserDispatchRecord(rootDir, identity());
    updateAmaCloserDispatchRecord(rootDir, identity(), () => ({ ...drainRecord,
      updatedAt: new Date(Date.now() - 300_001).toISOString() }));
    for (let i = 0; i < 6; i++) await laneGate.record(handler);
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).state, 'no-dispatch');
    assert.equal(laneGate.evaluate(handler).run, false);
    updateAmaCloserDispatchRecord(rootDir, identity(), () => ({ ...drainRecord,
      state: 'dispatch-deferred-transient', updatedAt: new Date(Date.now() - 300_001).toISOString() }));
    assert.equal(laneGate.evaluate(handler).run, false);
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).state, 'no-dispatch');
    updateAmaCloserDispatchRecord(rootDir, identity(), () => ({ ...drainRecord, updatedAt: new Date().toISOString() }));
    isDraining = false;
    assert.equal(laneGate.evaluate(handler).run, true);
    const result = await maybeDispatchAmaCloser(closerArgs);
    assert.equal(result.dispatched, true, JSON.stringify(result));
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).state, 'dispatched');
    updateAmaCloserLease({ ...identity(), status: 'dispatched', lrqId: 'synthetic-hammer' });
    return result;
  } });
  assert.equal(hammers, 1); assert.equal(store.merged, false);
  const oldHead = headSha;
  writeFileSync(join(gitDir, 'fixture.txt'), 'synthetic remediated change\n'); git('add', 'fixture.txt'); git('commit', '-q', '-m', 'Synthetic hammer repair'); headSha = git('rev-parse', 'HEAD');
  assert.equal(decideClosureOwner({ reviewState: { verdict: 'approved', headSha: oldHead }, currentHead: headSha }).owner, 'review');
  await handoffHammerReview({ ...identity(), requestBoundedReviewImpl: async () => ({ triggered: true }), logger: quiet });
  createFollowUpJob({ ...identity(), revisionRef: headSha, reviewerModel: 'gemini', reviewBody: cleanBody, changedFiles: ['fixture.txt'] });
  const drained = await consumeFollowUpJobsUntilCapacity(drain); assert.equal(drained.stopped, 1);
  await tick(); assert.equal(store.merged, true); assert.notEqual(headSha, oldHead);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], headSha);
  // A finished same-head hammer releases retry ownership and fleet capacity.
  const retrySubject = { ...identity(), prNumber: prNumber + 10 };
  const { requestEligibleHammerWake } = await import('../../src/hammer-wake.mjs');
  let wakes = 0;
  const wake = () => requestEligibleHammerWake({ ...retrySubject,
    eligibility: { eligible: true, reasons: [] },
    requestWatcherWakeImpl: () => { wakes++; return { requested: true }; }, log: quiet });
  assert.equal(wake().outcome, 'requested');
  acquireAmaCloserLease(retrySubject);
  updateAmaCloserLease({ ...retrySubject, status: 'dispatched', lrqId: 'synthetic-ended' });
  updateAmaCloserDispatchRecord(rootDir, retrySubject, () => ({ ...retrySubject,
    state: 'dispatched', launchRequestId: 'synthetic-ended', lastObservedStatus: 'starting' }));
  assert.equal(wake().outcome, 'duplicate');
  assert.equal(await reconcileAmaCloserLeaseAsync({ ...retrySubject,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readMergedSignalImpl: () => ({ ok: false }),
    readPullRequestStateImpl: () => ({ state: 'OPEN', headRefOid: headSha,
      autoMergeRequest: { enabledAt: new Date().toISOString() } }), logger: quiet,
  }), false);
  assert.equal(readAmaCloserLease(rootDir, retrySubject).status, 'dispatched');
  assert.equal(await reconcileAmaCloserLeaseAsync({ ...retrySubject,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
    readMergedSignalImpl: () => ({ ok: false }),
    now: new Date(Date.now() + 30 * 60_000).toISOString(),
    readPullRequestStateImpl: () => ({ state: 'OPEN', headRefOid: headSha,
      autoMergeRequest: { enabledAt: new Date().toISOString() } }), logger: quiet,
  }), true);
  assert.equal(readAmaCloserLease(rootDir, retrySubject).terminalOutcome, 'failed-without-merge');
  const active = await findActiveAmaCloserLaunches(rootDir, {
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }), log: quiet,
  });
  assert.equal(active.some(row => row.launchRequestId === 'synthetic-ended'), false);
  assert.equal(wake().outcome, 'requested'); assert.equal(wake().outcome, 'duplicate');
  assert.equal(wakes, 2);
  const unreadableSubject = { ...retrySubject, prNumber: prNumber + 11 };
  updateAmaCloserDispatchRecord(rootDir, unreadableSubject, () => ({ ...unreadableSubject,
    state: 'dispatched', launchRequestId: 'synthetic-unreadable', lastObservedStatus: 'starting',
    lastAttemptedAt: new Date().toISOString() }));
  const unreadableActive = await findActiveAmaCloserLaunches(rootDir, {
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'query-failed' }), log: quiet,
  });
  assert.equal(unreadableActive.find(row => row.launchRequestId === 'synthetic-unreadable').holdsCapacity, true);
  const { createHammerScratchDir, cleanupHammerScratchDir, hammerScratchEnvironment,
    amaCloserDispatchFilePath } = await import('../../src/ama/dispatch-closer.mjs');
  const { sweepHammerScratchDirs, HAMMER_SCRATCH_MAX_AGE_MS,
    HAMMER_SCRATCH_PROBE_GRACE_MS } = await import('../../src/ama/hammer-scratch-sweep.mjs');
  const promptDir = join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts');
  const scratchDir = createHammerScratchDir(promptDir);
  const tempEnv = hammerScratchEnvironment(scratchDir, {});
  assert.equal(tempEnv.TMPDIR, scratchDir);
  assert.equal(tempEnv.PYTEST_ADDOPTS,
    `--basetemp=${JSON.stringify(join(scratchDir, 'tmp-tests'))} -o tmp_path_retention_count=1`);
  mkdirSync(join(scratchDir, 'tmp-tests'));
  const scratchRecord = { scratchDir, promptDir, pid: 12345 };
  assert.equal(cleanupHammerScratchDir(scratchRecord, quiet, { processKillImpl: () => {} }), false);
  assert.equal(existsSync(scratchDir), true);
  assert.equal(cleanupHammerScratchDir(scratchRecord, quiet, { processKillImpl: () => {
    throw Object.assign(new Error('synthetic absent process'), { code: 'ESRCH' });
  } }), true);
  assert.equal(existsSync(join(scratchDir, 'tmp-tests')), false);
  const staleScratch = createHammerScratchDir(promptDir);
  const scratchNow = Date.now();
  const scratchOld = new Date(scratchNow - HAMMER_SCRATCH_MAX_AGE_MS - HAMMER_SCRATCH_PROBE_GRACE_MS - 60_000);
  utimesSync(staleScratch, scratchOld, scratchOld);
  const scratchOwner = amaCloserDispatchFilePath(rootDir, { repo, prNumber: 987, headSha: 'synthetic-scratch-head' });
  mkdirSync(dirname(scratchOwner), { recursive: true });
  writeFileSync(scratchOwner, JSON.stringify({ repo, prNumber: 987, headSha: 'synthetic-scratch-head',
    scratchDir: staleScratch, promptDir, state: 'launch-terminal', lastObservedStatus: 'succeeded' }));
  const scratchOptions = { logger: quiet,
    readProcessSnapshotImpl: () => ({ ps: '123 synthetic-idle-process', lsof: '', cwdTimedOut: true }),
    readWorkerStatusImpl: refuse, readLaunchRequestStatusImpl: refuse, readPullRequestStateImpl: refuse };
  assert.equal((await sweepHammerScratchDirs(rootDir, { ...scratchOptions,
    nowMs: scratchNow - HAMMER_SCRATCH_PROBE_GRACE_MS })).length, 0);
  assert.equal(existsSync(staleScratch), true);
  assert.equal((await sweepHammerScratchDirs(rootDir, { ...scratchOptions, nowMs: scratchNow })).length, 1);
  assert.equal(existsSync(staleScratch), false);
  const cursorRoot = join(rootDir, 'synthetic-cursor-sweep');
  const cursorPromptDir = join(cursorRoot, 'data', 'follow-up-jobs', 'ama-closer-prompts');
  const cursorTrees = [];
  for (let index = 0; index < 3; index += 1) {
    const path = createHammerScratchDir(cursorPromptDir);
    const at = new Date(scratchOld.getTime() + index * 1000);
    utimesSync(path, at, at);
    const owner = amaCloserDispatchFilePath(cursorRoot, { repo, prNumber: index + 1, headSha: 'synthetic-cursor-head' });
    mkdirSync(dirname(owner), { recursive: true });
    writeFileSync(owner, JSON.stringify({ scratchDir: path, state: 'dispatched',
      launchRequestId: `synthetic-cursor-${index}`, lastObservedStatus: 'succeeded' }));
    cursorTrees.push(path);
  }
  const visits = [];
  const cursorOptions = { logger: quiet, nowMs: scratchNow, scanBudgetMs: 1000, maxRemovals: 1,
    readProcessSnapshotImpl: () => ({ ps: '123 synthetic-idle-process', lsof: 'p123\nn/fixture/unrelated' }),
    readLaunchRequestStatusImpl: ({ launchRequestId, timeoutMs }) => {
      assert.ok(timeoutMs > 1000 && timeoutMs <= 10_000);
      visits.push(launchRequestId);
      return { ok: true, row: { status: 'succeeded' } };
    },
    readWorkerStatusImpl: ({ launchRequestId }) => ({ ok: true,
      row: { status: launchRequestId === 'synthetic-cursor-0' ? 'running' : 'succeeded' } }),
  };
  assert.equal((await sweepHammerScratchDirs(cursorRoot, cursorOptions)).length, 1);
  assert.equal(existsSync(cursorTrees[0]), true);
  assert.equal(existsSync(cursorTrees[1]), false);
  const { sweepHammerScratchDirs: restartedScratchSweep } = await import('../../src/ama/hammer-scratch-sweep.mjs?synthetic-smoke-restart');
  assert.equal((await restartedScratchSweep(cursorRoot, cursorOptions)).length, 1);
  assert.equal(existsSync(cursorTrees[0]), true);
  assert.equal(existsSync(cursorTrees[2]), false);
  assert.deepEqual(visits.slice(0, 3), ['synthetic-cursor-0', 'synthetic-cursor-1', 'synthetic-cursor-2']);
  evidence = { hammers, terminalScratchRemoved: true, drainingScratchRetained: true, privatePytestTemp: true, agedCwdTimeoutReclaimed: true, scratchCursorResumed: true, scratchLedgerClockIndependent: true, drainResumedNextPass: true, drainCountersUnchanged: true, drainHintExpiredWithoutCloser: true, legacyDrainHintRetired: true, handoff: true, claimPreserved: true, reviewedHeadRecorded: true,
    headlessPostRequeuedOnce: true, terminalRetryable: true, terminalCapacityFreed: true,
    autoMergeHeld: true, autoMergeBoundReleased: true, unreadableCapacityReserved: true,
    wakeRearmed: true, followUpStopped: drained.stopped, merged: true, remoteHeadMatches: true };
} else if (scenario === 'ci-blocked') {
  const ceilingDb = openReviewStateDb(rootDir); ensureReviewStateSchema(ceilingDb);
  const ceilingPr = 8, ceilingLogs = [];
  ceilingDb.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status,reviewer_head_sha)
    VALUES (?,?,'2026-01-01','gemini','posted',?)`).run(repo, ceilingPr, base);
  ceilingDb.prepare(`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,
    started_at,ended_at,status,head_sha,body_md) VALUES (?,?,1,'gemini','first-pass',
    '2026-01-01','2026-01-01','completed',?,?)`).run(repo, ceilingPr, base, cleanBody);
  for (let tick = 0; tick < 2; tick++) {
    assert.equal(routeCappedReviewToClosure({ db: ceilingDb, repo, prNumber: ceilingPr, headSha, ceiling: 1,
      row: ceilingDb.prepare('SELECT * FROM reviewed_prs WHERE pr_number=?').get(ceilingPr),
      logger: { log: line => ceilingLogs.push(line) } }), true);
  }
  assert.equal(ceilingLogs.length, 1);
  assert.equal(ceilingDb.prepare('SELECT reviewer_head_sha FROM reviewed_prs WHERE pr_number=?').get(ceilingPr).reviewer_head_sha, base);
  ceilingDb.close();
  for (const dispatchReason of ['exhausted-final-hammer', 'review-ceiling-terminal-remediation', null]) {
    for (const reviewCycleExhausted of [true, false]) {
      const ceilingEligibility = hammerWakeEligibility({ eligible: false,
        reasons: ['verdict-not-eligible', 'stale-head'] }, { dispatchReason,
        reviewCeilingReached: true, reviewState: { headSha: base, reviewCycleExhausted }, headSha });
      assert.equal(ceilingEligibility.eligible, true);
    }
  }
  const ceilingEligibility = hammerWakeEligibility({ eligible: false,
    reasons: ['verdict-not-eligible', 'stale-head'] }, { dispatchReason: null,
    reviewCeilingReached: true, reviewState: { headSha: base, reviewCycleExhausted: false }, headSha });
  assert.equal(requestEligibleHammerWake({ ...identity(), prNumber: ceilingPr,
    eligibility: ceilingEligibility, eligibilityReason: 'review-ceiling-terminal-remediation',
    log: quiet, requestWatcherWakeImpl: () => ({ requested: true }) }).outcome, 'requested');
  const pendingIdentity = { ...identity(), headSha: base };
  const pendingLease = acquireAmaCloserLease({ ...pendingIdentity, watcherPid: 4242 }).lease;
  const closureInput = { currentHead: base, lease: pendingLease, roundsLeft: false,
    reviewState: { verdict: 'comment-only', headSha: base, blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 1, remediationPending: false } };
  assert.equal(decideClosureOwner({ ...closureInput, processKillImpl() {} }).reason, 'in-flight:4242');
  assert.equal(decideClosureOwner({ ...closureInput, waitExhausted: true, processKillImpl() {
    throw Object.assign(new Error('synthetic dead watcher'), { code: 'ESRCH' });
  } }).owner, 'hammer');
  assert.deepEqual(readAmaCloserLease(rootDir, pendingIdentity), pendingLease);
  const leaseNowMs = Date.now();
  const foreignPendingLease = { ...pendingLease, holderHost: `${pendingLease.holderHost}.foreign`,
    acquiredAt: new Date(leaseNowMs).toISOString() };
  let foreignPidProbes = 0;
  const foreignInput = { ...closureInput, lease: foreignPendingLease, now: leaseNowMs,
    processKillImpl() { foreignPidProbes++; throw Object.assign(new Error('synthetic ESRCH'), { code: 'ESRCH' }); } };
  assert.equal(decideClosureOwner(foreignInput).owner, 'wait');
  assert.equal(decideClosureOwner({ ...foreignInput,
    now: leaseNowMs + AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS }).owner, 'hammer');
  assert.equal(foreignPidProbes, 0);
  const ciGate = { state: 'failed', headSha, failedChecks: [{ name: 'synthetic-ci', conclusion: 'FAILURE' }], pendingChecks: [] };
  for (const exhausted of [false, true]) {
    const admission = await guardRereviewCiBeforeReviewer({ ...identity(), passKind: 'rereview', reviewerHeadSha: headSha,
      inspectCiImpl: async () => ciGate, latestJobFinder: () => exhausted ? { jobPath: 'synthetic', job: { status: 'stopped', remediationPlan: { stop: { code: 'no-progress' } } } } : null,
      execFileImpl: refuse, deliverAlertImpl: refuse, log: quiet });
    assert.equal(admission.proceed, false); assert.equal(admission.parkReviewStatus, 'ci-blocked'); assert.equal(admission.hammerOwner, true);
  }
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db);
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status,reviewer_session_uuid)
    VALUES (?,?,'2026-01-01','gemini','reviewing','synthetic-session')`).run(repo, prNumber);
  assert.equal(prepareMarkRereviewCiBlocked(db).run('2026-01-01','red CI','2026-01-01',headSha,headSha,'synthetic-session',repo,prNumber).changes, 1);
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs WHERE pr_number=?').get(prNumber).review_status, 'ci-blocked'); db.close();
  assert.equal(decideClosureOwner({ reviewState: { verdict: 'approved', headSha, blockingFindingCount: 0, blockingFindingState: 'known', nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' }, currentHead: headSha, checks: 'FAILURE' }).owner, 'hammer');
  const exhausted = { verdict: 'comment-only', headSha: base, reviewCycleExhausted: true };
  const eligibility = hammerWakeEligibility({ eligible: false,
    reasons: ['verdict-not-eligible', 'ci-not-green', 'stale-head'] }, {
    dispatchReason: 'exhausted-final-hammer', ciBlockedHammerOwner: true,
    reviewState: exhausted, headSha, checksConclusion: 'FAILURE' });
  assert.equal(eligibility.eligible, true);
  const wake = requestEligibleHammerWake({ ...identity(), eligibility,
    eligibilityReason: 'exhausted-final-hammer-ci-repair', log: quiet,
    requestWatcherWakeImpl: () => ({ requested: true }) });
  assert.equal(wake.outcome, 'requested');
  assert.equal(decideClosureOwner({ reviewState: exhausted, currentHead: headSha,
    ciBlockedHammerOwner: true, roundsLeft: false, checks: 'FAILURE' }).owner, 'hammer');
  assert.deepEqual(decideClosureOwner({ reviewState: { headSha, verdict: '' }, currentHead: headSha,
    ciBlockedHammerOwner: true, roundsLeft: false, checks: 'FAILURE' }),
  { owner: 'page', reason: 'review-rounds-exhausted' });
  const repairConclusions = ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'ERROR'];
  for (const checks of repairConclusions) {
    assert.equal(hammerWakeEligibility({ eligible: false,
      reasons: ['verdict-not-eligible', 'ci-not-green', 'stale-head'] }, {
      dispatchReason: 'exhausted-final-hammer', ciBlockedHammerOwner: true,
      reviewState: exhausted, headSha, checksConclusion: checks }).eligible, true);
    assert.equal(decideClosureOwner({ reviewState: exhausted, currentHead: headSha,
      ciBlockedHammerOwner: true, roundsLeft: false, checks }).owner, 'hammer');
  }
  const promptDir = join(rootDir, 'prompts');
  mkdirSync(promptDir, { recursive: true });
  const promptPath = join(promptDir, `${repo.replace('/', '-')}-pr-${prNumber}-${base}-hammer-scratch-smoke.md`);
  writeFileSync(promptPath, 'synthetic unlaunched prompt');
  const intent = { ...identity(), targetRemediationSha: headSha, state: 'dispatching',
    promptDir, lastAttemptedAt: '2026-01-01T00:00:00Z' };
  updateAmaCloserDispatchRecord(rootDir, identity(), () => intent);
  const leaseBefore = acquireAmaCloserLease({ ...identity(), now: intent.lastAttemptedAt,
    watcherPid: process.pid }).lease;
  const liveNow = '2026-01-01T00:01:00Z';
  settleRefusedHammerWake({ rootDir, identity: identity(), intent, now: liveNow,
    wake: { outcome: 'requested' }, result: { dispatched: false } });
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).state, 'dispatching');
  assert.equal(existsSync(promptPath), true);
  assert.deepEqual(readAmaCloserLease(rootDir, identity()), leaseBefore);
  updateAmaCloserDispatchRecord(rootDir, identity(), record => ({ ...record, promptPath }));
  settleRefusedHammerWake({ rootDir, identity: identity(), intent,
    wake: { outcome: 'duplicate' }, result: { dispatched: false, reason: 'synthetic-refusal' } });
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).reason, 'wake-refused:synthetic-refusal');
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).state, 'dispatch-failed');
  assert.equal(readAmaCloserLease(rootDir, identity()), null);
  assert.equal(existsSync(promptPath), false);
  await tick({ gateOverrides: { requiredChecks: [{ name: 'synthetic-ci', conclusion: 'FAILURE' }] } });
  assert.equal(store.merged, false);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], base);
  evidence = { sameHeadParked: true, noFollowUpJob: true, exhaustedRounds: true,
    greenCeilingMovedHeadWake: true, ceilingTransitionOnce: true, originalReviewIdentityRetained: true,
    deadPendingOwnerReleased: true, livePendingOwnerWaits: true, ownershipLeavesLeaseIntact: true,
    foreignPendingOwnerUsesAgeOnly: true, numericLeaseClockAccepted: true,
    nativeFinalHammerWake: true, repairConclusions, generatedPromptSettled: true,
    refusedWakeTerminal: true, livePendingLeasePreserved: true,
    emptySameHeadVerdictRefused: true, unlaunchedPromptRemoved: true, merges: 0 };
} else if (scenario === 'refusals') {
  const { amaAuditFilePath, writeAmaAuditEntry } = await import('../../src/ama/audit.mjs');
  const { evaluateHammerStopHold, readHammerStopForHead } = await import('../../src/ama/hammer-stop-hold.mjs');
  const holdIdentity = { rootDir, hqRoot: join(rootDir, 'hq'), repo, prNumber: prNumber + 2, headSha };
  const holdArgs = { ...holdIdentity, logger: quiet,
    prMetadata: { prNumber: holdIdentity.prNumber, headSha, isOpen: true, isDraft: false,
      labels: [], mergeableState: 'MERGEABLE', statusCheckRollup: [{ name: 'synthetic-ci', conclusion: 'SUCCESS' }] },
    reviewState: { headSha, verdict: 'approved', riskClass: 'low', remediationPending: false } };
  writeAmaAuditEntry({ ...holdIdentity, now: '2026-01-01T00:00:00Z', attempt: {
    outcome: 'failed-without-merge', reason: 'verdict-not-eligible', head: headSha, attemptPhase: 'hammer-close' } });
  let refusalPages = 0;
  assert.equal((await evaluateHammerStopHold({ ...holdArgs,
    deliverAlertImpl: async () => { refusalPages++; } })).action, 'hold');
  writeAmaAuditEntry({ ...holdIdentity, now: '2026-01-01T00:01:00Z', attempt: {
    outcome: 'failed-without-merge', reason: 'missing-dispatch-phase-scripts', head: headSha, attemptPhase: 'hammer-close' } });
  assert.deepEqual(readHammerStopForHead(holdIdentity).refusal.reasons, ['verdict-not-eligible']);
  // Even truncated audit history must retain the persisted refusal before recovery.
  const auditPath = amaAuditFilePath(holdIdentity.hqRoot, repo, holdIdentity.prNumber, headSha);
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  audit.attempts = audit.attempts.slice(-1);
  writeFileSync(auditPath, JSON.stringify(audit));
  const packagingHold = await maybeDispatchAmaCloser({ ...holdArgs,
    cfg: { enabled: true, workerClass: 'hammer' }, options: {},
    dispatchContext: { ...holdIdentity, reviewedSha: headSha, orphanRecovery: { ownerProof: true, headSha } },
    execFileImpl: refuse, deliverAlertImpl: refuse, readLaunchRequestStatusImpl: refuse });
  assert.equal(packagingHold.reason, 'hammer-stop-awaiting-input-change');
  assert.equal(packagingHold.skipMergeAgent, true);
  assert.equal(packagingHold.hammerStop.paged, true);
  assert.equal(refusalPages, 1);
  const { runDaemonCleanMergeAttempt } = await import('../../src/daemon-clean-merge.mjs');
  const haltDirectory = join(rootDir, 'hq', 'control', 'halt');
  mkdirSync(haltDirectory, { recursive: true });
  const recoveryArgs = { env: { HQ_ROOT: join(rootDir, 'hq') }, execFileImpl: refuse };
  for (const [name, reason] of [['active.json', 'fleet-stop-active'], ['merge-kill.json', 'fleet-stop-merge-kill']]) {
    const latch = join(haltDirectory, name);
    writeFileSync(latch, '', { mode: 0o600 });
    assert.equal((await runDaemonCleanMergeAttempt(recoveryArgs)).reason, reason);
    rmSync(latch);
    assert.equal((await runDaemonCleanMergeAttempt(recoveryArgs)).reason, 'daemon-inputs-missing');
  }
  acquireAmaCloserLease({ ...identity(), now: '2000-01-01T00:00:00Z' });
  updateAmaCloserLease({ ...identity(), status: 'dispatched', lrqId: 'stale-synthetic', now: '2000-01-01T00:00:00Z' });
  assert.equal(isHeldAmaCloserLease(rootDir, identity()), false);
  assert.equal(acquireAmaCloserLease(identity()).acquired, false, 'expiry alone cannot authorize lease theft');
  assert.equal(decideClosureOwner({ reviewState: { verdict: 'approved', headSha }, currentHead: headSha, lease: { status: 'dispatched' }, waitExhausted: true }).owner, 'page');
  let pages = 0;
  for (const now of [0, 1800001, 1800002]) await observeClosureWait({ ...identity(), now, reason: 'synthetic-stale-lease', pageImpl: async () => { pages++; } });
  assert.equal(pages, 1);
  const signed = { author: 'synthetic-app', committer: 'web-flow', commit: { verification: { verified: true, reason: 'valid' } } };
  assert.equal(fleetCommitIdentityMatches(signed, ['synthetic-app']), true);
  assert.equal(fleetCommitIdentityMatches({ ...signed, commit: { verification: { verified: false, reason: 'unsigned' } } }, ['synthetic-app']), false);
  const created = createFollowUpJob({ ...identity(), revisionRef: headSha, reviewerModel: 'gemini', reviewBody: cleanBody.replace('Approved', 'Request changes'), changedFiles: ['fixture.txt'] });
  created.job.singleReview = { applied: true }; created.job.remediationPlan.currentRound = created.job.remediationPlan.maxRounds;
  writeFollowUpJob(created.jobPath, created.job);
  const result = await consumeNextFollowUpJob(drain);
  assert.equal(result.reason, 'max-rounds-reached'); assert.equal(result.job.status, 'stopped');
  createFollowUpJob({ ...identity(), prNumber: prNumber + 1, revisionRef: headSha, reviewerModel: 'gemini',
    reviewBody: '## Blocking issues\n- **[live_pack_cross_edit] Live pack** — operator waiver needed.\n## Verdict\nRequest changes' });
  let holdPages = 0, holdComments = 0;
  const held = await consumeNextFollowUpJob({ ...drain,
    resolvePRLifecycleImpl: async () => ({ prState: 'open', headSha, source: 'live' }),
    deliverAlertImpl: async () => { holdPages++; },
    postCommentImpl: async () => { holdComments++; return { posted: true }; } });
  assert.equal(held.reason, 'operator-label-required:live-pack-edit-approved');
  assert.equal(held.job.status, 'stopped'); assert.equal(held.job.remediationWorker.state, 'never-spawned');
  assert.equal(holdPages, 1); assert.equal(holdComments, 1);
  await tick({ runMerge: async () => { throw new Error('GH013: Repository rule violations: commits must have verified signatures'); } });
  assert.equal(store.merged, false, 'required signed commits are enforced by fake GitHub');
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], base);
  await tick({ gateOverrides: { candidateHead: 'a'.repeat(40) } }); assert.equal(store.merged, false);
  evidence = { packagingPreservesRefusal: true, ownerlessRefusalFenced: true, refusalPages,
    fleetStopRefused: true, fleetStopReasons: ['fleet-stop-active', 'fleet-stop-merge-kill'], fileResumeObserved: true, staleLeaseRefused: true, pages, signedIdentityRequired: true, signedCommitPolicyRefused: true,
    exhaustedStop: result.reason, operatorLabelStop: held.reason, holdPages, holdComments, staleHeadRefused: true };
} else throw new Error('unknown scenario');
console.log(JSON.stringify({ ok: true, ...evidence }));
