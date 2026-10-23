// Child of smv-smoke: only synthetic records and file-protocol Git are permitted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os, { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
// Smoke scenarios pin nominal deadlines on a synthetic idle host.
os.loadavg = () => [0, 0, 0];
net.Socket.prototype.connect = () => { throw new Error('SMV network boundary refused'); };
globalThis.fetch = () => { throw new Error('SMV fetch boundary refused'); };
syncBuiltinESMExports();
const { createFixtureStubReviewerRuntimeAdapter } = await import('../../src/adapters/reviewer-runtime/fixture-stub/index.mjs');
const { readReviewerRunRecord, writeReviewerRunRecord } = await import('../../src/adapters/reviewer-runtime/run-state.mjs');
const { createNoProgressLaneGate } = await import('../../src/posted-review-row.mjs');
const { readNoProgressLane } = await import('../../src/watcher-no-progress-lane.mjs');
const { observeClosureWait } = await import('../../src/ama/closure-wait.mjs');
const { watcherTick, cleanBody } = await import('./smv-watcher.mjs');
const { buildFollowUpJob, createFollowUpJob, claimNextFollowUpJob, readFollowUpJob, requeueFollowUpJobForNextRound, writeFollowUpJob } = await import('../../src/follow-up-jobs.mjs');
const { consumeFollowUpJobsUntilCapacity, consumeNextFollowUpJob } = await import('../../src/follow-up-remediation.mjs');
const { AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS, acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease, isHeldAmaCloserLease } = await import('../../src/ama/closer-lease.mjs');
const { maybeDispatchAmaCloser, isHammerRemediableEligibilityMiss, readAmaCloserDispatchRecord, reconcileAmaCloserLeaseAsync, findActiveAmaCloserLaunches, settleRefusedHammerWake,
  updateAmaCloserDispatchRecord, __testables__ } = await import('../../src/ama/dispatch-closer.mjs');
const { reconcilePreReceiptIntent } = await import('../../src/ama/pre-receipt-intent.mjs');
const { hammerWakeEligibility, requestEligibleHammerWake } = await import('../../src/hammer-wake.mjs');
const { deriveNextActionSnapshot, nextAction } = await import('../../src/pr-next-action.mjs');
const { shadowNextAction } = await import('../../src/pr-next-action-shadow.mjs');
const { routeCappedReviewToClosure } = await import('../../src/hamclose-review-admission.mjs');
const { handoffHammerReview } = await import('../../bin/hammer-review-handoff.mjs');
const { guardRereviewCiBeforeReviewer } = await import('../../src/reviewer-ci-admission.mjs');
const { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } = await import('../../src/review-state.mjs');
const { prepareMarkRereviewCiBlocked, prepareMarkAttemptStarted, prepareMarkPosted,
  prepareReleaseUnsettledPostedReview } = await import('../../src/review-state-statements.mjs');
const { requeuePostedReviewWithoutHead } = await import('../../src/posted-review-head-repair.mjs');
const { decideClosureOwner } = await import('../../src/ama/closure-owner.mjs');
const { isEligibleForAmaClosure } = await import('../../src/ama/eligibility.mjs');
const { fetchHammerHeadRange, fleetCommitIdentityMatches, readCompletedRemediationRounds } = await import('../../src/ama/hammer-head-validation.mjs');
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
  // LRQSTATUS-01: scheduling terminality does not release a parked PR owner.
  const { launchRequestInFlight, launchRequestOwned, launchRequestMeaning } = await import('../../src/ama/launch-request-status.mjs');
  assert.equal(launchRequestMeaning({ status: 'succeeded', terminal: false, succeeded: false }).terminal, false);
  assert.equal(launchRequestMeaning({ status: 'succeeded', succeeded: false }).succeeded, false);
  assert.equal(launchRequestMeaning({ status: null, terminal: true, succeeded: false }).terminal, true);
  assert.equal(launchRequestMeaning({ status: null, terminal: true, succeeded: false }).succeeded, false);
  const { normalizeWorkerTerminalEvent, workerTerminalEventToDispatchStatus, parseHqDispatchStatus } = await import('../../src/remediation-hq-dispatch.mjs');
  for (const payload of [{ terminal: true, succeeded: true }, { terminal: true, succeeded: false },
    { status: 'succeeded', terminal: true, succeeded: false }]) {
    const event = normalizeWorkerTerminalEvent('health.worker.terminal.synthetic', payload);
    assert.equal(event.terminal, true);
    assert.equal(event.succeeded, payload.succeeded);
    const projected = workerTerminalEventToDispatchStatus(event);
    assert.equal(projected.succeeded, payload.succeeded);
    const probed = parseHqDispatchStatus(JSON.stringify(payload));
    assert.equal(launchRequestMeaning(probed).terminal, true);
    assert.equal(launchRequestMeaning(probed).succeeded, payload.succeeded);
  }
  assert.equal(launchRequestMeaning('completed').status, null);
  assert.equal(launchRequestMeaning('blocked_needs_decision').succeeded, false);
  const { launchHoldsCloserCapacity } = await import('../../src/ama/closure-capacity.mjs');
  for (const status of ['blocked_needs_decision', 'waiting_approval', 'waiting_input']) {
    const probe = { ok: true, row: { status } };
    assert.equal(launchRequestInFlight(probe), false);
    assert.equal(launchRequestOwned(probe), true);
    assert.equal(launchHoldsCloserCapacity(probe.row), false);
    const parkedRoot = join(rootDir, status);
    const receipt = { repo, prNumber, headSha };
    acquireAmaCloserLease({ rootDir: parkedRoot, ...receipt });
    updateAmaCloserLease({ rootDir: parkedRoot, ...receipt, status: 'dispatched', lrqId: 'resumed' });
    updateAmaCloserLease({ rootDir: parkedRoot, ...receipt, status: 'terminal', terminalOutcome: 'deferred' });
    updateAmaCloserDispatchRecord(parkedRoot, receipt, () => ({ ...receipt,
      state: 'dispatched', launchRequestId: 'resumed', lastObservedStatus: status }));
    const ownerInput = { rootDir: parkedRoot, lease: readAmaCloserLease(parkedRoot, receipt),
      currentHead: headSha, reviewState: { verdict: 'approved', headSha,
        blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 } };
    let resumedProbe = { ok: true, row: { status: 'running' } };
    for (let poll = 0; poll < 2; poll++) {
      assert.equal(decideClosureOwner({ ...ownerInput,
        readLaunchRequestStatusImpl: () => resumedProbe }).owner, 'wait');
      const dispatch = await maybeDispatchAmaCloser({ cfg: { enabled: true }, prMetadata: receipt,
        dispatchContext: { rootDir: parkedRoot, repo }, readLaunchRequestStatusImpl: async () => resumedProbe,
        execFileImpl: refuse, cleanupScratchImpl: refuse });
      assert.equal(dispatch.skipMergeAgent, true);
      assert.equal(dispatch.reason, 'dispatch-status-running');
      assert.equal(readAmaCloserDispatchRecord(parkedRoot, receipt).lastObservedStatus, 'running');
    }
    const resumedActive = await findActiveAmaCloserLaunches(parkedRoot, {
      readLaunchRequestStatusImpl: async () => resumedProbe, cleanupScratchImpl: refuse });
    assert.equal(resumedActive.length, 1);
    assert.equal(resumedActive[0].holdsCapacity, true);
    resumedProbe = { ok: true, row: { status: 'canceled' } };
    assert.equal(decideClosureOwner({ ...ownerInput,
      readLaunchRequestStatusImpl: () => resumedProbe }).owner, 'daemon-merge');
  }

  // HAMATTEST-02: the shared, head-bound decision selects ownership only.
  const reviewState = { verdict: 'approved', headSha: base, blockingFindingCount: 0,
    blockingFindingState: 'known', nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' };
  const closureInput = { reviewState, currentHead: headSha, roundsLeft: false, reviewCeilingReached: true };
  const closerAuthoredStale = { currentHead: headSha, reviewedHead: base,
    decision: 'rereview-exact-head', carryForward: false };
  assert.equal(decideClosureOwner({ ...closureInput, attested: true, closerAuthoredStale }).owner, 'review');
  assert.equal(decideClosureOwner({ ...closureInput,
    closerAuthoredStale: { ...closerAuthoredStale, decision: 'eligible', carryForward: true } }).owner, 'daemon-merge');
  assert.equal(decideClosureOwner({ ...closureInput,
    closerAuthoredStale: { ...closerAuthoredStale, currentHead: base } }).owner, 'hammer');
  const { acquireMergeLease, acquireDaemonMergeLease, releaseMergeLease, readMergeLeaseHistory } = await import('../../src/ama/merge-lease.mjs');
  const atLeaseSecond = seconds => new Date(Date.now() + seconds * 1000).toISOString();
  const leaseArgs = { rootDir: join(rootDir, 'leasefair'), repo, base: 'main', now: atLeaseSecond(0),
    holderPid: process.pid, holderHost: 'synthetic-host', pidAliveFn: () => true };
  const holder = acquireMergeLease({ ...leaseArgs, holderPr: 1, holderHead: 'closer' });
  assert.equal(holder.acquired, true);
  const closerRequest = { ...leaseArgs, holderPr: 2, holderHead: 'next-closer', registerWaiter: true, waiterId: 'next-closer' };
  assert.equal(acquireMergeLease(closerRequest).acquired, false);
  const daemonRequest = { ...leaseArgs, holderPr: 3, holderHead: 'daemon' };
  const deferred = acquireDaemonMergeLease(daemonRequest);
  assert.equal(deferred.acquired, false);
  assert.equal(deferred.queuePosition, 1);
  assert.equal(deferred.existingLease.leaseId, holder.lease.leaseId);
  // LEASEFAIR-04: the reservation survives a full watcher interval and release
  // requests exactly the reserved PR/head through the existing wake path.
  const leaseWakes = [];
  assert.equal(releaseMergeLease({ rootDir: leaseArgs.rootDir, ...holder.lease,
    now: atLeaseSecond(200), requestWatcherWakeImpl: wake => leaseWakes.push(wake) }).released, true);
  assert.equal(leaseWakes.length, 1);
  assert.equal(leaseWakes[0].prNumber, daemonRequest.holderPr);
  assert.equal(leaseWakes[0].headSha, daemonRequest.holderHead);
  closerRequest.now = atLeaseSecond(299);
  assert.equal(acquireMergeLease(closerRequest).acquired, false);
  daemonRequest.now = atLeaseSecond(300);
  const served = acquireDaemonMergeLease(daemonRequest);
  assert.equal(served.acquired, true);
  assert.equal(releaseMergeLease({ rootDir: leaseArgs.rootDir, ...served.lease }).released, true);
  // LEASEFAIR-02: after priority service, the closer retry owns the lane
  // throughout its one synthetic CI wait; a new daemon cannot overtake it.
  const retry = acquireMergeLease(closerRequest);
  assert.equal(retry.acquired, true);
  await Promise.resolve();
  const duringRetry = acquireDaemonMergeLease(daemonRequest);
  assert.equal(duringRetry.acquired, false);
  assert.equal(duringRetry.existingLease.leaseId, retry.lease.leaseId);
  assert.equal(releaseMergeLease({ rootDir: leaseArgs.rootDir, ...retry.lease }).released, true);
  const afterRetry = acquireDaemonMergeLease(daemonRequest);
  assert.equal(afterRetry.acquired, true);
  assert.equal(releaseMergeLease({ rootDir: leaseArgs.rootDir, ...afterRetry.lease }).released, true);
  const leaseHistory = readMergeLeaseHistory(leaseArgs.rootDir, leaseArgs);
  assert.deepEqual(leaseHistory.map(row => row.event), ['grant', 'release', 'grant', 'release', 'grant', 'release', 'grant', 'release']);
  assert.equal(leaseHistory.find(row => row.leaseId === retry.lease.leaseId).holderRole, 'closer');
  assert.equal(leaseHistory.find(row => row.leaseId === served.lease.leaseId).holderRole, 'daemon');
  const { exerciseDaemonWaiterLifecycle } = await import('./daemon-waiter-lifecycle.mjs');
  await exerciseDaemonWaiterLifecycle(join(rootDir, 'abandoned-daemon'), 'hold', { sibling: true });
  for (const exit of ['terminal', 'closed', 'stacked', 'error', 'contended']) {
    await exerciseDaemonWaiterLifecycle(join(rootDir, `detached-daemon-${exit}`), `deadline-${exit}`);
  }
  const review = await createFixtureStubReviewerRuntimeAdapter({ rootDir, reviewerBodies: [cleanBody] }).spawnReviewer({ sessionUuid: 'synthetic-review' });
  assert.equal(review.reviewBody, cleanBody); assert.equal(readReviewerRunRecord(rootDir, 'synthetic-review').state, 'completed');
  await tick(); assert.equal(store.merged, true);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], headSha);
  const { journalReviewerTokenLease, readReviewerTokenLeases, reconcileReviewerTokenLeases } = await import('../../src/reviewer-token-leases.mjs');
  journalReviewerTokenLease(rootDir, 'lease-smoke', 'codex-reviewer');
  let alive = true, failRelease = true;
  const leaseOps = [];
  const leaseSweep = () => reconcileReviewerTokenLeases({ rootDir, rows: [], readRecord: () => null,
    now: new Date(Date.now() + 120_000), log: quiet,
    probeAlive: () => alive, findProcess: () => alive ? { found: true, pgid: 9001 } : { found: false },
    ownerImpl: async value => { assert.equal(value.operation, 'recover'); return { ok: true,
      lease: { account_id: 'synthetic', lease_id: 'synthetic', generation: 1 } }; },
    updateLease: async (_, operation) => {
      leaseOps.push(operation);
      if (operation === 'release' && failRelease) throw new Error('synthetic fence failure');
    },
  });
  await leaseSweep(); // Recovers a receipt lost before stdout, renews a live run.
  alive = false;
  await leaseSweep();
  assert.equal(readReviewerTokenLeases(rootDir).length, 1, 'failed release stays retryable');
  failRelease = false;
  await leaseSweep();
  assert.equal(readReviewerTokenLeases(rootDir).length, 0);
  assert.deepEqual(leaseOps, ['renew', 'release', 'release']);
  const { createAgyReviewerIdentityPool } = await import('../../src/agy-reviewer-identities.mjs');
  let cleanupBlocked = false, survivorRunning = false;
  let cleanupGate = null;
  let probeGate = null, recoveryProbeCalls = 0;
  const cleanupEntered = Promise.withResolvers();
  const makeHolderPool = () => createAgyReviewerIdentityPool({
    env: {}, runStateRootDir: rootDir, log: quiet, leaseWaitMs: 0, hqOwner: 'fixture-owner',
    resolveRuntime: () => 'antigravity', resolveModel: () => 'synthetic-model',
    loadTokenPools: () => ({}), loadIdentities: () => ['fixture-login-a', 'fixture-login-b'],
    referenceSettings: () => [], readBootstrapRecordImpl: () => null,
    readQuotaCooldownImpl: () => null,
    listUserProcessesImpl: async () => ({ ok: true, processes: survivorRunning
      ? [{ pid: 4242, pgid: 4242, comm: 'agy' }] : [] }),
    deliverAlertImpl: async () => { throw new Error('unexpected holder alert'); },
    runPinnedImpl: async ({ args }) => {
      if (args[0] === 'cleanup' && cleanupGate) { cleanupEntered.resolve(); await cleanupGate.promise; }
      if (args[0] === 'probe') { recoveryProbeCalls++; if (probeGate) await probeGate.promise; }
      return { code: cleanupBlocked && args[0] === 'cleanup' ? 75 : 0, stdout: args[0] === 'status'
        ? 'keychain.exists=yes\nkeychain.item=readable\nsettings.valid=yes\n' : args[0] === 'probe' ? 'probe.ok=yes\n' : '' };
    },
  });
  const holders = makeHolderPool(), independent = makeHolderPool();
  const first = await holders.acquire(), second = await holders.acquire();
  assert.equal(first.identity, 'gemini-reviewer'); assert.equal(second.identity, first.identity);
  assert.notEqual(first.user, second.user);
  assert.equal(await independent.acquire(), null);
  cleanupBlocked = true;
  await holders.release(first);
  const holderRecord = () => JSON.parse(readFileSync(join(rootDir, 'data', 'agy-holder-leases', `${first.user}.json`)));
  assert.equal(holderRecord().lease.generation, first.generation);
  assert.equal(await independent.acquire(), null);
  cleanupBlocked = false; survivorRunning = true;
  await holders.refreshReadiness();
  assert.equal(holderRecord().lease.generation, first.generation);
  assert.equal(await independent.acquire(), null);
  survivorRunning = false;
  await holders.refreshReadiness();
  assert.equal(holderRecord().lease, null);
  cleanupGate = Promise.withResolvers();
  const releasing = holders.release(second);
  await cleanupEntered.promise;
  try {
    assert.equal(holders.snapshot().find(row => row.user === second.user).leased, true);
    await holders.refreshReadiness();
    assert.deepEqual(holders.snapshot().find(row => row.user === second.user).reasons, []);
    assert.equal(holders.projection().tokens.find(row => row.holderRef === second.user).free, 0);
  } finally { cleanupGate.resolve(); await releasing; cleanupGate = null; }
  writeReviewerRunRecord(rootDir, { sessionUuid: 'pre-spawn-failure', state: 'failed', pgid: null,
    subjectContext: { agyHolderLease: { user: first.user, reviewId: 'never-spawned' } } });
  assert.equal(await independent.refreshReadiness(), 2);
  const failedLease = await holders.acquire();
  probeGate = Promise.withResolvers();
  try {
    await holders.release(failedLease, { failed: true });
    assert.equal(holders.projection().tokens.find(row => row.holderRef === failedLease.user).free, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(recoveryProbeCalls, 1, 'failed release starts recovery without another readiness pass');
  } finally { probeGate.resolve(); await holders.settleProbes(); probeGate = null; }
  assert.equal(holders.readyCount(), 2);
  evidence = { merged: true, unsignedSyntheticHead: true, remoteHeadMatches: true,
    sharedRereviewOwnership: true, carriedCleanOwnership: true, staleDecisionRefused: true,
    leaseRecoveryRetried: true, canonicalGeminiIdentity: first.identity, distinctHolders: 2, thirdHolderLeaseRefused: true,
    durableCleanupAndDrainFence: true, releaseReceiptRetained: true, terminalWithoutPgidReadmitted: true,
    immediateFailedReviewRecovery: true };
} else if (scenario === 'handoff') {
  // REMEDBRANCH-01: unresolved creation cannot hand a branchless job to a worker.
  const branchRoot = join(rootDir, 'branch-contract');
  const blocked = createFollowUpJob({ rootDir: branchRoot, repo, prNumber,
    reviewerModel: 'gemini', builderTag: 'codex', reviewBody: '## Verdict\nRequest changes',
    readPRHeadImpl: () => ({ branch: null }) });
  assert.equal(blocked.job.branchResolution.reason, 'branch-unresolved');
  assert.equal(claimNextFollowUpJob({ rootDir: branchRoot,
    claimedAt: blocked.job.branchResolution.retryAfter, readPRHeadImpl: () => ({ branch: null }) }), null);
  const branchHeld = readFollowUpJob(blocked.jobPath);
  assert.equal(branchHeld.remediationPlan.currentRound, 0);
  const branchReady = claimNextFollowUpJob({ rootDir: branchRoot,
    claimedAt: branchHeld.branchResolution.retryAfter, readPRHeadImpl: () => ({ branch: 'fixture/head' }) });
  assert.equal(branchReady.job.branch, 'fixture/head');

  const exhaustedRoot = join(rootDir, 'exhausted-branch-contract');
  const unresolved = createFollowUpJob({ rootDir: exhaustedRoot, repo, prNumber,
    reviewerModel: 'gemini', reviewBody: '## Verdict\nRequest changes',
    readPRHeadImpl: () => ({ branch: null }) });
  claimNextFollowUpJob({ rootDir: exhaustedRoot,
    claimedAt: unresolved.job.branchResolution.retryAfter, readPRHeadImpl: () => ({ branch: null }) });
  const retried = readFollowUpJob(unresolved.jobPath);
  const exhausted = claimNextFollowUpJob({ rootDir: exhaustedRoot, returnStopped: true,
    claimedAt: retried.branchResolution.retryAfter, readPRHeadImpl: () => ({ branch: null }) });
  assert.equal(exhausted.job.remediationPlan.stop.code, 'branch-unresolved');
  assert.equal(exhausted.job.branchResolution.attempts, 3);
  assert.equal(exhausted.job.remediationPlan.currentRound, 0);
  assert.equal(claimNextFollowUpJob({ rootDir: exhaustedRoot, claimedAt: '2099-01-01T00:00:00Z',
    readPRHeadImpl: refuse }), null);

  const cleanRoot = join(rootDir, 'clean-branch-contract');
  const clean = createFollowUpJob({ rootDir: cleanRoot, repo, prNumber,
    reviewerModel: 'gemini', reviewBody: cleanBody, readPRHeadImpl: refuse });
  assert.equal(clean.job.branchResolution?.state, undefined);
  // Previously persisted clean jobs may still carry a future branch hold.
  const cleanHeld = { ...clean.job, branchResolution: { state: 'blocked', reason: 'branch-unresolved',
    retryAfter: '2099-01-01T00:00:00Z' } };
  writeFollowUpJob(clean.jobPath, cleanHeld);
  const { pickAdversarialGateStatus } = await import('../../src/adversarial-gate-status.mjs');
  const publishedGate = pickAdversarialGateStatus({ headSha,
    reviewRow: { review_status: 'posted', pr_state: 'open' },
    latestJob: { jobId: 'published-smoke', status: 'stopped',
      remediationPlan: { stop: { code: 'committed-unpublished' } }, unpublishedWork: { commitSha: headSha } } });
  assert.equal(publishedGate.reason, 'remediation-published-awaiting-review');
  assert.equal(publishedGate.state, 'pending');
  assert.equal(pickAdversarialGateStatus({ repo, prNumber,
    reviewRow: { review_status: 'posted', pr_state: 'open' }, latestJob: cleanHeld }).reason, 'review-settled');
  const settled = claimNextFollowUpJob({ rootDir: cleanRoot, returnStopped: true, readPRHeadImpl: refuse });
  assert.equal(settled.job.remediationPlan.stop.code, 'no-remediation-required');
  assert.equal(settled.job.remediationPlan.currentRound, 0);
  const { findCommittedUnpublishedWork } = await import('../../src/remediation-unpublished.mjs');
  assert.equal(await findCommittedUnpublishedWork({ job: { jobId: 'unchanged-smoke', revisionRef: headSha },
    workspaceDir: gitDir, reply: { summary: `Publisher failed while inspecting upstream commit ${base}.` },
    execFileImpl: async (command, args, options) => ({ stdout: execFileSync(command, args, options) }) }), null);

  const { isReclaimableDispatchedAmaCloserLease: reclaimLease,
    AMA_CLOSER_UNKNOWN_LAUNCH_RECLAIM_AGE_MS: fallbackMs } = await import('../../src/ama/closer-lease.mjs');
  const leaseClock = Date.parse('2026-10-01T12:00:00Z');
  const agedLease = { status: 'dispatched', lrqId: 'synthetic-live',
    updatedAt: new Date(leaseClock - 45 * 60_000).toISOString() };
  assert.equal(reclaimLease(agedLease, { now: leaseClock,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'running' } }) }), false);
  assert.equal(reclaimLease(agedLease, { now: leaseClock,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'failed' } }) }), true);
  assert.equal(reclaimLease({ ...agedLease, lrqId: null }, { now: leaseClock }), false);
  assert.equal(reclaimLease({ ...agedLease, lrqId: null,
    updatedAt: new Date(leaseClock - fallbackMs).toISOString() }, { now: leaseClock }), true);

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
        return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${prNumber}`, dispatchId: 'synthetic-hammer', launchRequestId: 'synthetic-hammer' }) }; },
      readTemplateImpl: () => 'Synthetic hammer <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>', writeFileImpl() {},
      resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
      readBuildCompletionSignalForPrImpl: () => ({ ok: false }), readBuildCompletionProducerEvidenceImpl: () => ({ ok: false }), logger: quiet,
    };
    // CLOSERINTENT-01: explicit foreign output ends this attempt immediately.
    const foreignRoot = join(rootDir, 'foreign-receipt');
    let foreign = true;
    const foreignArgs = { ...closerArgs,
      dispatchContext: { ...closerArgs.dispatchContext, rootDir: foreignRoot,
        hqRoot: join(foreignRoot, 'hq'), closerTokenRollupPollDelaysMs: [] },
      readLaunchRequestStatusImpl: () => ({ ok: false }),
      execFileImpl: async () => ({ stdout: JSON.stringify({
        ticketRef: foreign ? `CONFLICT-REBASE-${prNumber}` : `AMA-PR-${prNumber}`,
        launchRequestId: foreign ? 'synthetic-foreign' : 'synthetic-own',
      }) }),
    };
    assert.equal((await maybeDispatchAmaCloser(foreignArgs)).reason, 'non-hammer-launch-not-adopted');
    const refused = readAmaCloserDispatchRecord(foreignRoot, identity());
    assert.equal(refused.state, 'no-dispatch');
    assert.equal(refused.retryCount, 0);
    assert.equal(refused.launchRequestId, null);
    assert.equal(readAmaCloserLease(foreignRoot, identity()).terminalOutcome, 'superseded');
    assert.equal(existsSync(refused.scratchDir), false);
    foreign = false;
    assert.equal((await maybeDispatchAmaCloser(foreignArgs)).dispatched, true);
    // TERMLEASE-01: terminal no-merge ownership ends without an ownerless delay.
    for (const outcome of ['superseded', 'failed-without-merge', 'deferred']) {
      const terminalRoot = join(rootDir, `terminal-lease-${outcome}`);
      const terminalIdentity = { rootDir: terminalRoot, repo, prNumber, headSha };
      acquireAmaCloserLease(terminalIdentity);
      updateAmaCloserLease({ ...terminalIdentity, status: 'dispatched', lrqId: 'synthetic-ended' });
      updateAmaCloserLease({ ...terminalIdentity, status: 'terminal', terminalOutcome: outcome });
      let launches = 0;
      const result = await maybeDispatchAmaCloser({ ...closerArgs,
        dispatchContext: { ...closerArgs.dispatchContext, rootDir: terminalRoot,
          hqRoot: join(terminalRoot, 'hq'), closerTokenRollupPollDelaysMs: [] },
        readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded' } }),
        execFileImpl: async (_cmd, args) => {
          assert.ok(args.includes('dispatch')); launches++;
          return { stdout: JSON.stringify({ ticketRef: `AMA-PR-${prNumber}`, launchRequestId: 'synthetic-fresh' }) };
        },
      });
      assert.equal(result.dispatched, true, JSON.stringify(result));
      assert.equal(launches, 1);
      assert.equal(readAmaCloserLease(terminalRoot, terminalIdentity).lrqId, 'synthetic-fresh');
    }
    const normalLiveProbe = closerArgs.dispatchContext.livePrProbeImpl;
    let branchReadable = false;
    closerArgs.dispatchContext.livePrProbeImpl = () => __testables__.defaultAmaLivePrProbe({
      repo, prNumber, retryDelaysMs: [],
      execFileImpl: async (command, args) => {
        if (command === 'gh') return { stdout: JSON.stringify({ state: 'OPEN',
          headRefName: 'synthetic', headRefOid: headSha, headRepository: null, isCrossRepository: false }) };
        assert.equal(command, 'git');
        assert.deepEqual(args, ['ls-remote', '--exit-code', '--heads',
          'https://github.com/fixture/repo.git', 'refs/heads/synthetic']);
        if (!branchReadable) throw Object.assign(new Error('synthetic transport failure'), { code: 128 });
        return { stdout: `${headSha}\trefs/heads/synthetic\n` };
      },
    });
    const unknown = await maybeDispatchAmaCloser(closerArgs);
    assert.equal(unknown.reason, 'live-head-branch-unknown');
    assert.equal(unknown.recoveryWait, true);
    assert.equal(unknown.retryAfterMs, 30_000);
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).state, 'dispatch-deferred-transient');
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).retryCount, 0);
    assert.equal(readAmaCloserLease(identity()), null);
    const forkIdentity = { ...identity(), prNumber: prNumber + 90 };
    let forkProbes = 0;
    const forkArgs = { ...closerArgs,
      prMetadata: { ...closerArgs.prMetadata, prNumber: forkIdentity.prNumber },
      dispatchContext: { ...closerArgs.dispatchContext, dispatchedAt: '2026-01-01T00:00:00Z',
        livePrProbeImpl: () => __testables__.defaultAmaLivePrProbe({ repo, prNumber: forkIdentity.prNumber,
          execFileImpl: async command => {
            assert.equal(command, 'gh', 'an unidentified fork must not probe the base repository');
            forkProbes++;
            return { stdout: JSON.stringify({ state: 'OPEN', headRefOid: headSha,
              headRefName: 'synthetic', headRepository: null, isCrossRepository: true }) };
          } }),
      },
    };
    assert.equal((await maybeDispatchAmaCloser(forkArgs)).reason, 'live-head-branch-unknown');
    forkArgs.dispatchContext.dispatchedAt = '2026-01-01T06:00:00Z';
    const forkExpired = await maybeDispatchAmaCloser(forkArgs);
    assert.equal(forkExpired.reason, 'live-head-fork-unresolved');
    assert.equal(forkExpired.needsOperator, true);
    assert.equal(readAmaCloserDispatchRecord(rootDir, forkIdentity).state, 'no-dispatch');
    assert.equal(readAmaCloserDispatchRecord(rootDir, forkIdentity).retryCount, 0);
    assert.equal(readAmaCloserLease(forkIdentity), null);
    assert.equal((await maybeDispatchAmaCloser(forkArgs)).needsOperator, true);
    assert.equal(forkProbes, 2, 'operator inspection stops further same-head probes');
    branchReadable = true;
    const deferred = await maybeDispatchAmaCloser(closerArgs);
    closerArgs.dispatchContext.livePrProbeImpl = normalLiveProbe;
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
  const retry = await handoffHammerReview({ ...identity(),
    requestBoundedReviewImpl: () => assert.fail('hammer heads never request review'), logger: quiet });
  assert.equal(retry.outcome, 'hammer-retry-required');
  assert.equal(readAmaCloserLease(rootDir, identity()).terminalOutcome, 'failed-without-merge');
  // A fresh hammer assumes responsibility from the reviewed head. Exercise the
  // same range and predicate used by publication, then merge disposable Git.
  const range = await fetchHammerHeadRange({ reviewedHead: oldHead, currentHead: headSha,
    hammerBaseHead: oldHead, get: refuse });
  const body = `HAM-Base-Head: ${oldHead}\nHAM-Validated-Head: ${headSha}`;
  const primaryChange = { headSha, hasHammerCommits: false };
  const verdict = isEligibleForAmaClosure({ headSha: oldHead, verdict: 'comment-only', riskClass: 'low',
    remediationPending: false, blockingFindingState: 'known', blockingFindingCount: 0,
    nonBlockingFindingState: 'known', nonBlockingFindingCount: 1, nonBlockingFindingIdentities: ['cleanup'] },
  { headSha, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
    statusCheckRollup: [{ name: 'synthetic-ci', conclusion: 'SUCCESS' }] },
  { enabled: true, eligibility: { riskClasses: ['low'] }, branchProtection: { required: false } },
  { primaryChange, hamTerminalRemediation: { active: true, commit: { sha: headSha },
    auditComment: { body, findings: [{ title: 'Cleanup', blocking: false, addressed: true }] } },
    hamTerminalRemediationGroundTruth: { range, commit: { sha: headSha, changedFiles: ['fixture.txt'], primaryChange },
      auditComment: { body, author: 'hammer-worker' } } });
  assert.equal(verdict.eligible, true, JSON.stringify(verdict));
  git('checkout', '-q', 'main'); git('merge', '--ff-only', headSha); git('push', '-q', 'origin', 'main');
  store.merged = true;
  assert.notEqual(headSha, oldHead);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], headSha);
  // A finished same-head hammer releases retry ownership and fleet capacity.
  const retrySubject = { ...identity(), prNumber: prNumber + 10 };
  const { requestEligibleHammerWake } = await import('../../src/hammer-wake.mjs');
  let wakes = 0, wakeShared;
  const wake = () => {
    const lease = readAmaCloserLease(rootDir, retrySubject);
    const record = readAmaCloserDispatchRecord(rootDir, retrySubject);
    const snapshot = deriveNextActionSnapshot({ subjectKey: 'subject-handoff', head: retrySubject.headSha,
      observedAt: new Date().toISOString(), observations: {
        pr: { headSha: retrySubject.headSha, state: 'OPEN', mergeable: 'MERGEABLE' },
        checks: { conclusion: 'SUCCESS' },
        reviews: { headSha: retrySubject.headSha, verdict: 'approved', blockingFindingState: 'known',
          blockingFindingCount: 0, nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
        remediation: { roundsLeft: false }, leases: { closer: lease },
        launches: { closer: record ? { headSha: retrySubject.headSha, launchRequestId: record.launchRequestId,
          row: { status: record.terminalLaunchStatus || 'running' }, retryChain: [],
          outcome: record.terminalOutcome === 'failed-without-merge' ? 'no-merge' : null, retryable: true } : null },
        policy: { autonomousMergeExecutionEnabled: true },
      } });
    wakeShared = { snapshot, decision: nextAction(snapshot) };
    return requestEligibleHammerWake({ ...retrySubject, shared: wakeShared,
      requestWatcherWakeImpl: () => { wakes++; return { requested: true }; }, log: quiet });
  };
  assert.equal(wake().outcome, 'requested');
  acquireAmaCloserLease(retrySubject);
  updateAmaCloserLease({ ...retrySubject, status: 'dispatched', lrqId: 'synthetic-ended' });
  updateAmaCloserDispatchRecord(rootDir, retrySubject, () => ({ ...retrySubject,
    state: 'dispatched', launchRequestId: 'synthetic-ended', lastObservedStatus: 'starting' }));
  assert.equal(wake().outcome, 'skipped');
  assert.equal(wakeShared.decision.reason, 'live-owner');
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
  const shadow = await shadowNextAction({ shared: wakeShared, env: {}, sink() {} });
  assert.equal(shadow.decision, wakeShared.decision);
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
  evidence = { hammers, cleanBranchHoldSettled: true, unchangedHeadHasNoPublicationDebt: true, nullHeadConfirmed: true, unknownBranchRetryRecovered: true, terminalScratchRemoved: true, drainingScratchRetained: true, privatePytestTemp: true, agedCwdTimeoutReclaimed: true, scratchCursorResumed: true, scratchLedgerClockIndependent: true, drainResumedNextPass: true, drainCountersUnchanged: true, drainHintExpiredWithoutCloser: true, legacyDrainHintRetired: true, hammerRangeValidated: true, noHammerReviewRequest: true, claimPreserved: true, reviewedHeadRecorded: true,
    headlessPostRequeuedOnce: true, terminalRetryable: true, terminalCapacityFreed: true, terminalNoMergeReclaimedSamePass: true,
    autoMergeHeld: true, autoMergeBoundReleased: true, unreadableCapacityReserved: true,
    wakeRearmed: true, merged: true, remoteHeadMatches: true };
} else if (scenario === 'ci-blocked') {
  for (const reviewCycleExhausted of [false, true]) {
    for (const findings of [[], ['verdict-not-settled-success'], ['non-blocking-findings-present']]) {
      const reasons = ['stale-review-head', 'ci-not-green', ...findings];
      const options = { reviewCycleExhausted, commentOnlyFinalRoundResume: true };
      assert.equal(isHammerRemediableEligibilityMiss(reasons, { reviewCycleExhausted }), false);
      assert.equal(isHammerRemediableEligibilityMiss(reasons, options), true);
      for (const hold of ['blocking-findings-present', 'blocking-findings-unknown', 'ama-disabled']) {
        assert.equal(isHammerRemediableEligibilityMiss([...reasons, hold], options), false);
      }
    }
  }
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
  const finalJob = buildFollowUpJob({ repo, prNumber, reviewerModel: 'codex', revisionRef: base,
    reviewBody: '## Verdict\nComment only' });
  finalJob.status = 'completed';
  finalJob.finalRound = 'comment-only';
  finalJob.reReview = { requested: false, status: 'suppressed', suppressed: 'comment-only-final-round' };
  finalJob.remediationPlan.currentRound = 1;
  finalJob.remediationPlan.maxRounds = 1;
  finalJob.remediationPlan.rounds = [{ round: 1, state: 'completed', startHeadSha: base, resultingHeadSha: headSha }];
  const completedDir = join(rootDir, 'data/follow-up-jobs/completed'); mkdirSync(completedDir, { recursive: true });
  const finalPath = join(completedDir, `${finalJob.jobId}.json`);
  writeFollowUpJob(finalPath, finalJob);
  const finalBytes = readFileSync(finalPath, 'utf8');
  const finalAdmission = await guardRereviewCiBeforeReviewer({ ...identity(), passKind: 'rereview', reviewerHeadSha: headSha,
    inspectCiImpl: async () => ciGate, requeueImpl: refuse, execFileImpl: refuse, deliverAlertImpl: refuse, log: quiet });
  assert.equal(finalAdmission.reason, 'ci-regression-hammer-owned');
  assert.equal(finalAdmission.hammerOwner, true);
  assert.throws(() => requeueFollowUpJobForNextRound({ rootDir, jobPath: finalPath }), /completed:comment-only-final-round/);
  assert.equal(readFileSync(finalPath, 'utf8'), finalBytes);
  const incompleteAdmission = await guardRereviewCiBeforeReviewer({ ...identity(), passKind: 'rereview',
    reviewerHeadSha: headSha, inspectCiImpl: async () => ciGate,
    latestJobFinder: () => ({ jobPath: finalPath, job: { ...finalJob, finalRound: undefined } }),
    requeueImpl: () => ({ job: { status: 'pending' } }),
    execFileImpl: refuse, deliverAlertImpl: refuse, log: quiet });
  assert.equal(incompleteAdmission.reason, 'ci-regression-requeued');
  const finalProof = await fetchHammerHeadRange({ repo, reviewedHead: base, currentHead: headSha, hammerBaseHead: headSha,
    remediationRounds: await readCompletedRemediationRounds(rootDir, repo, prNumber), env: {}, get: async path => {
      assert.equal(path, `repos/${repo}/compare/${base}...${headSha}`);
      return { status: 'ahead' };
    } });
  assert.equal(finalProof.proof, 'completed-remediation-round-chain');
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
  const promptDir = join(rootDir, 'data', 'smoke-intent-prompts');
  mkdirSync(promptDir, { recursive: true });
  const promptPath = join(promptDir, `${repo.replace('/', '-')}-pr-${prNumber}-${base}-hammer-scratch-smoke.md`);
  writeFileSync(promptPath, 'synthetic unlaunched prompt');
  const intent = { ...identity(), targetRemediationSha: headSha, state: 'dispatching',
    promptDir, dispatchTimeoutMs: 600_000, lastAttemptedAt: '2026-01-01T00:00:00Z' };
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
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).reason, undefined);
  assert.equal(readAmaCloserDispatchRecord(rootDir, identity()).state, 'dispatching');
  assert.deepEqual(readAmaCloserLease(rootDir, identity()), leaseBefore);
  assert.equal(existsSync(promptPath), true);
  const recoveryNow = '2026-01-02T00:00:00Z';
  const inspectionPages = [];
  const unknownIntent = await reconcilePreReceiptIntent(rootDir, identity(), {
    readPullRequestStateImpl: async () => ({ state: 'OPEN' }),
    deliverAlertImpl: async (text, options) => { inspectionPages.push({ text, ...options }); },
    now: recoveryNow, readIntentReceiptImpl: () => assert.fail('legacy intent has no keyed lookup'),
  });
  assert.equal(unknownIntent.status, 'unknown');
  assert.equal(unknownIntent.record.preReceiptReconciliation.status, 'inspection-required');
  assert.equal(inspectionPages.length, 1);
  assert.equal(inspectionPages[0].payload.headSha, headSha);
  assert.deepEqual(await findActiveAmaCloserLaunches(rootDir, { now: recoveryNow }), []);
  await reconcilePreReceiptIntent(rootDir, identity(), {
    readPullRequestStateImpl: async () => ({ state: 'OPEN' }), now: recoveryNow, deliverAlertImpl: refuse });
  updateAmaCloserDispatchRecord(rootDir, identity(), current => ({ ...current,
    dispatchPhase: 'submitting', dispatchIdempotencyKey: 'ama-closer-smoke-expired', dispatchTimeoutMs: 600_000 }));
  const noLaunch = await reconcilePreReceiptIntent(rootDir, identity(), {
    readPullRequestStateImpl: async () => ({ state: 'OPEN' }),
    now: recoveryNow, readIntentReceiptImpl: () => ({ ok: true, rows: [] }),
    processKillImpl: () => { throw Object.assign(new Error('synthetic dead owner'), { code: 'ESRCH' }); },
  });
  assert.equal(noLaunch.status, 'no-launch');
  assert.equal(noLaunch.record.reason, 'keyed-no-launch-proven');
  assert.equal(noLaunch.evidence.ok, true);
  assert.equal(noLaunch.evidence.rowCount, 0);
  assert.equal(readAmaCloserLease(rootDir, identity()).terminalOutcome, 'deferred');
  const legacyIdentity = { ...identity(), prNumber: prNumber + 2 };
  updateAmaCloserDispatchRecord(rootDir, legacyIdentity, () => ({ ...legacyIdentity,
    targetRemediationSha: legacyIdentity.headSha, workerClass: 'hammer', state: 'dispatching',
    lastAttemptedAt: recoveryNow, retryCount: 1 }));
  acquireAmaCloserLease({ rootDir, ...legacyIdentity, now: recoveryNow, watcherPid: 12345 });
  const legacyOptions = { now: recoveryNow,
    readPullRequestStateImpl: async () => ({ state: 'OPEN' }),
    processKillImpl: () => { throw Object.assign(new Error('synthetic dead owner'), { code: 'ESRCH' }); } };
  const legacyHeld = await reconcilePreReceiptIntent(rootDir, legacyIdentity, {
    ...legacyOptions, readLegacyIntentLaunchesImpl: () => ({ ok: false, reason: 'synthetic unreadable' }),
  });
  assert.equal(legacyHeld.status, 'unknown');
  const legacySettled = await reconcilePreReceiptIntent(rootDir, legacyIdentity, {
    ...legacyOptions, readLegacyIntentLaunchesImpl: () => ({ ok: true, rows: [] }),
  });
  assert.equal(legacySettled.status, 'no-launch');
  assert.equal(legacySettled.record.reason, 'legacy-no-launch-proven');
  assert.equal(legacySettled.record.preReceiptReconciliation.query.requestedAtOrAfter, recoveryNow);
  assert.equal(readAmaCloserLease(rootDir, legacyIdentity).terminalOutcome, 'deferred');
  const receiptIdentity = { ...identity(), prNumber: prNumber + 1 };
  updateAmaCloserDispatchRecord(rootDir, receiptIdentity, () => ({ ...receiptIdentity,
    reviewedSha: base, workerClass: 'hammer', state: 'dispatching',
    dispatchPhase: 'submitting', dispatchIdempotencyKey: 'ama-closer-smoke-receipt',
    lastAttemptedAt: recoveryNow, retryCount: 1 }));
  const recovered = await reconcilePreReceiptIntent(rootDir, receiptIdentity, {
    readPullRequestStateImpl: async () => ({ state: 'OPEN' }),
    now: recoveryNow, readIntentReceiptImpl: () => ({ ok: true, rows: [{
      idempotency_key: 'ama-closer-smoke-receipt', launch_request_id: 'lrq_smoke_recovered',
      ticket_ref: `AMA-PR-${receiptIdentity.prNumber}`, target_repo: repo,
    }] }),
  });
  assert.equal(recovered.status, 'receipt-recovered');
  assert.equal(recovered.record.launchRequestId, 'lrq_smoke_recovered');
  const terminalIdentity = { ...identity(), prNumber: prNumber + 2 };
  updateAmaCloserDispatchRecord(rootDir, terminalIdentity, () => ({ ...intent, ...terminalIdentity }));
  const { reconcileAmaCloserDispatches } = await import('../../src/ama/dispatch-closer.mjs');
  await reconcileAmaCloserDispatches(rootDir, {
    now: recoveryNow, readPullRequestStateImpl: async () => ({ state: 'CLOSED' }),
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'running' } }),
    readIntentReceiptImpl: refuse, deliverAlertImpl: refuse,
  });
  assert.equal(readAmaCloserDispatchRecord(rootDir, terminalIdentity).state, 'completed');
  await tick({ gateOverrides: { requiredChecks: [{ name: 'synthetic-ci', conclusion: 'FAILURE' }] } });
  assert.equal(store.merged, false);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], base);
  evidence = { incompleteFinalRoundRequeued: true, finalRoundRedCiWithoutFindings: true, finalRoundBlockingHoldsPreserved: true, completedFinalRoundPreserved: true, finalRoundStartingBaseProven: true, sameHeadParked: true, noFollowUpJob: true, exhaustedRounds: true,
    greenCeilingMovedHeadWake: true, ceilingTransitionOnce: true, originalReviewIdentityRetained: true,
    deadPendingOwnerReleased: true, livePendingOwnerWaits: true, ownershipLeavesLeaseIntact: true,
    foreignPendingOwnerUsesAgeOnly: true, numericLeaseClockAccepted: true,
    nativeFinalHammerWake: true, terminalIntentRetiredWithoutPage: true, inspectionPagedOnce: true, expiredKeyedIntentSettled: true, unresolvedIntentHoldsNoFleetCapacity: true,
    repairConclusions, generatedPromptSettled: true,
    refusedWakeTerminal: true, livePendingLeasePreserved: true, legacyLedgerSettlement: true,
    emptySameHeadVerdictRefused: true, unlaunchedPromptRemoved: true, merges: 0 };
} else if (scenario === 'refusals') {
  const { loadAwareTimeoutMs, loadAwareTimeoutSeconds, MAX_TIMER_DELAY_MS } = await import('../../src/load-aware-timeout.mjs');
  const { buildSafePollOnce, computeWorkloadAwarePollDeadlineMs, MAX_POLL_DEADLINE_MS } = await import('../../src/watcher-poll-guard.mjs');
  const loaded = { enabled: true, maxMultiplier: 5, loadAvg1m: 3, cpuCount: 1, cpuBusyPercent: 100 };
  const reviewerTimeoutMs = loadAwareTimeoutMs(20 * 60_000, { ...loaded, maxMs: Infinity });
  assert.equal(reviewerTimeoutMs, 20 * 60_000 * 5);
  assert.equal(computeWorkloadAwarePollDeadlineMs({ activeRepoCount: 20, reviewerTimeoutMs }), MAX_POLL_DEADLINE_MS);
  assert.equal((await buildSafePollOnce({ pollOnceImpl: async () => {},
    deadlineMs: () => computeWorkloadAwarePollDeadlineMs({ activeRepoCount: 20, reviewerTimeoutMs }), log: quiet })()).ok, true);
  assert.equal(loadAwareTimeoutMs(1e12, { ...loaded, maxMs: Infinity }), MAX_TIMER_DELAY_MS);
  assert.ok(loadAwareTimeoutSeconds(1e12, { ...loaded, maxSeconds: Infinity }) * 1000 <= MAX_TIMER_DELAY_MS);
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
  const finalWait = { ...identity(), waitClass: 'final-round', env: {},
    reason: 'in-flight:synthetic-closer', launchAlive: true, pageImpl: async text => {
      assert.match(text, /still running after \d+ minutes/);
      assert.doesNotMatch(text, /exhausted/);
      pages++;
    } };
  await observeClosureWait({ ...finalWait, now: 0, startedAt: 0 });
  assert.equal((await observeClosureWait({ ...finalWait, now: 40 * 60_000, startedAt: 20 * 60_000 })).exhausted, false);
  assert.equal(pages, 1, 'a closer launched twenty minutes ago must not page');
  assert.equal((await observeClosureWait({ ...finalWait, now: 55 * 60_000, startedAt: 20 * 60_000 })).exhausted, true);
  assert.equal(pages, 2, 'unchanged launch progress must still expire');
  const skewedWait = { ...finalWait, prNumber: prNumber + 100, startedAt: 24 * 60 * 60_000 };
  for (const now of [0, 10, 20, 30, 31]) {
    const wait = await observeClosureWait({ ...skewedWait, now: now * 60_000 });
    assert.equal(wait.startedAt, 0, 'future timestamps cannot turn polling into progress');
    assert.equal(wait.exhausted, now >= 30);
  }
  assert.equal(pages, 3, 'future-dated progress still pages once at the original deadline');
  const { createAmaHammerBackgroundQueue, amaHammerBackgroundProgress } = await import('../../src/ama-hammer-background-dispatch.mjs');
  for (const dispatched of [true, false]) {
    let clock = 0, finish, launchPages = 0;
    const wait = { ...finalWait, prNumber: prNumber + (dispatched ? 101 : 102),
      pageImpl: async () => { launchPages++; } };
    await observeClosureWait({ ...wait, now: clock });
    clock = 40 * 60_000;
    const queue = createAmaHammerBackgroundQueue({ nowMs: () => clock });
    const entry = queue.submit({ key: `${repo}#${wait.prNumber}@${headSha}`,
      run: () => new Promise(resolve => { finish = resolve; }) });
    const progress = amaHammerBackgroundProgress(entry, clock);
    const launchAt = Date.parse(progress.closerProgressAt);
    assert.equal((await observeClosureWait({ ...wait, now: clock,
      launchWait: { startedAt: launchAt, boundMs: progress.closerLaunchBoundMs } })).exhausted, false);
    clock += 200_000;
    finish({ dispatched, reason: dispatched ? 'dispatched' : 'ci-not-green' });
    await queue.drain();
    const settled = queue.takeSettled(entry.key).result;
    await observeClosureWait({ ...wait, now: clock, reason: settled.reason,
      ...(dispatched ? { startedAt: Date.parse(settled.closerProgressAt) } : {}) });
    // Reopen without launch evidence: only successful settlement persists credit.
    const persisted = await observeClosureWait({ ...wait, now: clock });
    assert.equal(persisted.startedAt, dispatched ? launchAt : 0);
    assert.equal(persisted.exhausted, !dispatched);
    assert.equal(launchPages, dispatched ? 0 : 1);
    assert.equal((await observeClosureWait({ ...wait, now: launchAt + 30 * 60_000 })).exhausted, true);
    assert.equal(launchPages, 1, 'fixed launch progress preserves one exhaustion receipt');
  }
  const signed = { author: 'synthetic-app', committer: 'web-flow', commit: { verification: { verified: true, reason: 'valid' } } };
  assert.equal(fleetCommitIdentityMatches(signed, ['synthetic-app']), true);
  assert.equal(fleetCommitIdentityMatches({ ...signed, commit: { verification: { verified: false, reason: 'unsigned' } } }, ['synthetic-app']), false);
  const created = createFollowUpJob({ branch: 'fixture/remediation', ...identity(), revisionRef: headSha, reviewerModel: 'gemini', reviewBody: cleanBody.replace('Approved', 'Request changes'), changedFiles: ['fixture.txt'] });
  created.job.singleReview = { applied: true }; created.job.remediationPlan.currentRound = created.job.remediationPlan.maxRounds;
  writeFollowUpJob(created.jobPath, created.job);
  const result = await consumeNextFollowUpJob(drain);
  assert.equal(result.reason, 'max-rounds-reached'); assert.equal(result.job.status, 'stopped');
  createFollowUpJob({ branch: 'fixture/remediation', ...identity(), prNumber: prNumber + 1, revisionRef: headSha, reviewerModel: 'gemini',
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
