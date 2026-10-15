// Child of smv-smoke: only synthetic records and file-protocol Git are permitted.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
net.Socket.prototype.connect = () => { throw new Error('SMV network boundary refused'); };
globalThis.fetch = () => { throw new Error('SMV fetch boundary refused'); };
syncBuiltinESMExports();
const { createFixtureStubReviewerRuntimeAdapter } = await import('../../src/adapters/reviewer-runtime/fixture-stub/index.mjs');
const { readReviewerRunRecord } = await import('../../src/adapters/reviewer-runtime/run-state.mjs');
const { observeClosureWait } = await import('../../src/ama/closure-wait.mjs');
const { watcherTick, cleanBody } = await import('./smv-watcher.mjs');
const { createFollowUpJob, writeFollowUpJob } = await import('../../src/follow-up-jobs.mjs');
const { consumeFollowUpJobsUntilCapacity, consumeNextFollowUpJob } = await import('../../src/follow-up-remediation.mjs');
const { acquireAmaCloserLease, updateAmaCloserLease, isHeldAmaCloserLease } = await import('../../src/ama/closer-lease.mjs');
const { maybeDispatchAmaCloser, readAmaCloserDispatchRecord } = await import('../../src/ama/dispatch-closer.mjs');
const { handoffHammerReview } = await import('../../bin/hammer-review-handoff.mjs');
const { guardRereviewCiBeforeReviewer } = await import('../../src/reviewer-ci-admission.mjs');
const { openReviewStateDb, ensureReviewStateSchema } = await import('../../src/review-state.mjs');
const { prepareMarkRereviewCiBlocked } = await import('../../src/review-state-statements.mjs');
const { decideClosureOwner } = await import('../../src/ama/closure-owner.mjs');
const { fleetCommitIdentityMatches } = await import('../../src/ama/hammer-head-validation.mjs');
const rootDir = process.cwd(), repo = 'fixture/repo', prNumber = 7;
const quiet = { log() {}, warn() {}, error() {} };
const refuse = () => { throw new Error('unexpected worker/GitHub/notification boundary'); };
const drain = { rootDir, promptTemplate: 'synthetic', maxConcurrent: 1, log: quiet, logger: quiet,
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
  // A finding routes through the watcher/closure hub to the fake hammer boundary.
  let hammers = 0;
  await tick({ findings: true, closerImpl: async () => {
    assert.equal(acquireAmaCloserLease(identity()).acquired, true); hammers++;
    const result = await maybeDispatchAmaCloser({
      cfg: { enabled: true, workerClass: 'hammer', branchProtection: { required: false }, eligibility: { riskClasses: ['low'] } },
      reviewState: { verdict: 'comment-only', headSha, riskClass: 'low', reviewCycleExhausted: true, remediationPending: false,
        blockingFindingState: 'known', blockingFindingCount: 0, nonBlockingFindingState: 'known', nonBlockingFindingCount: 1 },
      prMetadata: { prNumber, headSha, isOpen: true, isDraft: false, mergeableState: 'MERGEABLE', labels: [],
        statusCheckRollup: [{ name: 'synthetic-ci', conclusion: 'SUCCESS' }], branchProtection: { requiredContexts: [] } },
      dispatchContext: { rootDir, repo, reviewedSha: headSha, riskClass: 'low', reviewedBy: 'synthetic-reviewer', reviewer: 'gemini',
        parentSession: 'synthetic-parent', hqPath: 'hq', hqRoot: join(rootDir, 'hq'), currentUser: userInfo().username, hqOwnerUser: userInfo().username,
        livePrProbeImpl: async () => ({ state: 'OPEN', headRefOid: headSha, headBranchExists: true, headRefName: 'synthetic' }) },
      execFileImpl: async (_command, args) => { assert.ok(args.includes('dispatch')); return { stdout: JSON.stringify({ dispatchId: 'synthetic-hammer', launchRequestId: 'synthetic-hammer' }) }; },
      readTemplateImpl: () => 'Synthetic hammer <<REVIEWED_SHA>> <<TARGET_REMEDIATION_SHA>> <<AMA_TRAILERS>>', writeFileImpl() {},
      resolveCloserDispatchHarnessImpl: async ({ workerClass }) => ({ workerClass, fellBack: false }),
      readBuildCompletionSignalForPrImpl: () => ({ ok: false }), readBuildCompletionProducerEvidenceImpl: () => ({ ok: false }), logger: quiet,
    });
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
  evidence = { hammers, handoff: true, followUpStopped: drained.stopped, merged: true, remoteHeadMatches: true };
} else if (scenario === 'ci-blocked') {
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
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'ci-blocked'); db.close();
  assert.equal(decideClosureOwner({ reviewState: { verdict: 'approved', headSha, blockingFindingCount: 0, blockingFindingState: 'known', nonBlockingFindingCount: 0, nonBlockingFindingState: 'known' }, currentHead: headSha, checks: 'FAILURE' }).owner, 'hammer');
  await tick({ gateOverrides: { requiredChecks: [{ name: 'synthetic-ci', conclusion: 'FAILURE' }] } });
  assert.equal(store.merged, false);
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], base);
  evidence = { sameHeadParked: true, noFollowUpJob: true, exhaustedRounds: true, merges: 0 };
} else if (scenario === 'refusals') {
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
  await tick({ runMerge: async () => { throw new Error('GH013: Repository rule violations: commits must have verified signatures'); } });
  assert.equal(store.merged, false, 'required signed commits are enforced by fake GitHub');
  assert.equal(git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], base);
  await tick({ gateOverrides: { candidateHead: 'a'.repeat(40) } }); assert.equal(store.merged, false);
  evidence = { staleLeaseRefused: true, pages, signedIdentityRequired: true, signedCommitPolicyRefused: true, exhaustedStop: result.reason, staleHeadRefused: true };
} else throw new Error('unknown scenario');
console.log(JSON.stringify({ ok: true, ...evidence }));
