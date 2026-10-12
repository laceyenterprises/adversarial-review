import { collect } from './helpers/hamclose-history.mjs';
import { mapDaemonPrimaryChangeResult } from '../src/daemon-clean-merge.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { handlePostedReviewRow } from '../src/posted-review-row.mjs';
import { maybeDispatchAmaClosureFor } from '../src/ama-closure-orchestration.mjs';
import { attemptDaemonCleanMerge } from '../src/ama/daemon-merge.mjs';
import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import { consumeFollowUpJobsUntilCapacity } from '../src/follow-up-remediation.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, rekeyAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath, maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { closeEmptyPullRequest, EMPTY_PR_COMMENT } from '../src/empty-pr-close.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import { routeCappedReviewToClosure, hammerHandoffReviewBypass, postedReviewCeilingReached } from '../src/hamclose-review-admission.mjs';
import { handoffHammerReview } from '../bin/hammer-review-handoff.mjs';
import { classifyClosureOwnership } from '../src/merge-agent-rescue-classifier.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';

const repo = 'fixture/repo';
const cleanBody = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved';
const quiet = { log() {}, warn() {}, error() {} };
function root(t) { const dir = mkdtempSync(join(tmpdir(), 'hamclose-replay-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
async function history(options = {}) {
  const later = { node_id: 'PRR_later', commit_id: 'f'.repeat(40), state: 'APPROVED',
    user: { login: 'lacey-claude-reviewer[bot]' }, submitted_at: '2026-01-01T20:00:00Z', body: cleanBody };
  const initial = { node_id: 'PRR_cited', commit_id: '1'.repeat(40), state: 'CHANGES_REQUESTED',
    user: { login: 'lacey-claude-reviewer[bot]' }, submitted_at: '2026-01-01T17:00:00Z',
    body: '## Blocking issues\n- **Undo**\n  - **File:** `src/a.mjs`\n  - **Lines:** `10-11`\n  - **Problem:** unsafe\n  - **Recommended fix:** undo\n## Non-blocking issues\n- None.\n## Verdict\nRequest changes' };
  return (await collect({ reviews: [initial, later], originalRecorded: true,
    originalParent: '2'.repeat(40), originalLine: 15, snapshotStatus: 'diverged', ...options })).evidence;
}

// Both production watcher phases run. Only external GitHub/dispatch/merge
// boundaries are injected; the actual primary-change and merge predicates run.
async function watcherTick({ rootDir, prNumber, headSha, evidence, store, row, closerImpl, closureOnly = false, pageImpl = async () => {} }) {
  const candidate = { repo, prNumber, headSha, prState: store.merged ? 'merged' : 'open',
    title: '[codex] HAMCLOSE replay', body: '', baseBranch: 'main', isDraft: false, riskClass: 'low',
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', conclusion: 'SUCCESS' }],
    labels: [], branchProtection: { requiredContexts: [] } };
  const reviewState = { blockingFindingCount: 0, blockingFindingState: 'known', nonBlockingFindingCount: 0,
    nonBlockingFindingState: 'known', headSha, verdict: 'approved' };
  return handlePostedReviewRow({ rootDir, repoPath: repo, prNumber, existing: row,
    currentRevisionRef: headSha, logger: quiet,
    currentReviewRowReader: () => row, latestFollowUpJobFinder: () => null,
    latestPostedReviewBodyFinder: () => cleanBody,
    projectGateStatusSafe: async () => ({ decision: { state: 'success', reason: 'review-settled' } }),
    fetchMergeAgentCandidateImpl: async () => candidate,
    buildMergeAgentDispatchJobImpl: () => ({ ...reviewState }),
    resolveMergeAgentCoexistenceForWatcherImpl: async () => ({ outcome: 'ama-pending',
      amaClosureResult: store.lastClosure = await maybeDispatchAmaClosureFor({ rootDir, repoPath: repo, prNumber,
        candidate, reviewStateRow: row, currentRevisionRef: headSha, dispatchJob: reviewState, labelNames: [], logger: { ...quiet, warn: message => { (store.warnings ||= []).push(message); } },
        loadConfigImpl: () => ({ getMergeAuthorityConfig: () => ({ enabled: true, strictMode: true,
          autonomousMergeExecutionEnabled: true, branchProtection: { required: false }, lha: { consumeAttestations: false } }) }),
        observeClosureWaitImpl: args => observeClosureWait({ ...args, pageImpl }),
        resolveHeadCloserCommitSuppressionImpl: async () => ({ suppressed: false }),
        fetchHeadCloserVerifiedCommitImpl: async () => null,
        fetchPullRequestMergeabilityImpl: async () => ({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
        fetchMergedProtectiveDependentsImpl: async () => [],
        fetchProtectivePredecessorStateImpl: async () => null,
        fetchLatestHeadReviewBodiesImpl: async () => closureOnly ? [] : [cleanBody], liveReviewRetryDelaysMs: [0],
        maybeDispatchAmaCloserImpl: closerImpl || (async () => { throw new Error('clean review must not launch a hammer'); }),
        runDaemonCleanMergeAttemptImpl: async () => {
          if (closureOnly) return { disposition: 'not-taken', reason: 'stale-head' };
          const gate = { candidateHead: headSha, validatedHead: headSha, requiredChecks: candidate.statusCheckRollup,
            mergeable: 'MERGEABLE', prState: 'OPEN', labels: [], primaryChange: evidence,
            requirePrimaryChange: true, strictNonBlockingRemediation: true };
          const result = await attemptDaemonCleanMerge({ repo, prNumber, base: 'main', validatedHead: headSha,
            verdict: 'settled-success', reviewState, liveGate: gate, branchProtectionRequired: false,
            prTitle: candidate.title, hqRoot: rootDir, logger: quiet,
            fetchLiveGateImpl: async () => store.merged ? { ...gate, prState: 'MERGED' } : gate,
            acquireLeaseImpl: () => ({ acquired: true, lease: { leaseId: 'fixture' } }), releaseLeaseImpl() {},
            runMergeImpl: async () => { store.merged = true; return { code: 0, stdout: '', stderr: '' }; },
            writeAuditImpl: () => ({ written: true }), appendAuditImpl: () => ({ written: true }), readAuditImpl: () => null });
          return mapDaemonPrimaryChangeResult(result);
        },
      }) }),
    dispatchMergeAgentForPRImpl: async () => { throw new Error('merge-agent fallback must not run'); },
  });
}

test('HAMCLOSE-03 replay A: synthetic reversal merges in one posted-review/closure tick', async t => {
  const rootDir = root(t), evidence = await history(), store = { merged: false };
  assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.rebased, true);
  assert.equal(checkPrimaryChange({ ...evidence, reversalAuthorizations: [] }, evidence.headSha, { strictNonBlockingRemediation: true }).ok, false);
  assert.equal(checkPrimaryChange(evidence, evidence.headSha, { strictNonBlockingRemediation: true }).ok, true);
  await watcherTick({ rootDir, prNumber: 8132, headSha: evidence.headSha, evidence, store,
    row: { review_status: 'posted', reviewer_head_sha: evidence.headSha, reviewer: 'gemini', review_body: cleanBody } });
  assert.equal(store.merged, true);
});

test('HAMCLOSE-03 replay B: delivered ceiling transfers a newer nonempty head to one hammer and one review', async t => {
  const rootDir = root(t), headSha = 'c'.repeat(40), old = 'a'.repeat(40);
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db); t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status,reviewer_head_sha,review_attempts)
    VALUES (?,8143,'2026-01-01T04:45:00Z','gemini','pending',?,3)`).run(repo, old);
  const insert = (n, posted, kind = 'rereview', passHead = old) => db.prepare(`INSERT INTO reviewer_passes(pass_id,repo,pr_number,attempt_number,reviewer_class,pass_kind,
    started_at,ended_at,status,head_sha,gh_comment_id) VALUES (?,?,8143,?,'gemini',?,
    '2026-01-01T04:44:00Z','2026-01-01T04:45:00Z','completed',?,?)`).run(n, repo, n, kind, passHead, posted ? `PRR-${n}` : null);
  insert(1, true, 'first-pass');
  insert(2, true, 'remediation', null);
  for (const n of [3,4,5]) insert(n, false, 'rereview', headSha);
  assert.equal(postedReviewCeilingReached({ db, repo, prNumber: 8143, ceiling: 3 }), false);
  // The later remediation comment must never become the restored review.
  const ledgerRow = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(routeCappedReviewToClosure({ db, repo, prNumber: 8143, headSha, row: ledgerRow, ceiling: 1 }), true);
  const restored = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(restored.reviewer_head_sha, old);
  assert.equal(restored.posted_at, '2026-01-01T04:45:00Z');
  insert(6, true); insert(8, true);
  const row = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(routeCappedReviewToClosure({ db, repo, prNumber: 8143, headSha, row, ceiling: 3 }), true);
  const identity = { rootDir, repo, prNumber: 8143, headSha };
  let hammers = 0; const closureStore = { merged: false };
  const cappedRow = { ...db.prepare('SELECT * FROM reviewed_prs').get(), review_body: cleanBody };
  await watcherTick({ ...identity, row: cappedRow, evidence: { headSha, hasHammerCommits: false },
    store: closureStore, closureOnly: true,
    closerImpl: async args => {
      assert.equal(args.reviewState.reviewCycleExhausted, true);
      assert.equal(args.dispatchContext.reviewCycleCapReached, true);
      assert.equal(acquireAmaCloserLease(identity).acquired, true); hammers++;
      updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'hammer-8143' });
      return { dispatched: true, workerClass: 'hammer', dispatchId: 'hammer-8143' };
    } });
  assert.equal(hammers, 1, JSON.stringify(closureStore));
  assert.equal(acquireAmaCloserLease(identity).acquired, false);
  await handoffHammerReview({ ...identity, requestBoundedReviewImpl: async () => ({ triggered: true }), logger: quiet });
  const reviewRow = { rereview_requested_at: '2026-10-12T06:15:00Z', revision_ref: headSha, rereview_reason: `system-orphan-head-review:${headSha}` };
  assert.equal(hammerHandoffReviewBypass({ ...identity, db, row: reviewRow }), true);
  db.prepare(`INSERT INTO reviewer_passes(pass_id,repo,pr_number,attempt_number,reviewer_class,pass_kind,
    started_at,status,head_sha) VALUES (7,?,8143,7,'gemini','rereview',?,'running',?)`)
    .run(repo, new Date(Date.now() + 1000).toISOString(), headSha);
  assert.equal(hammerHandoffReviewBypass({ ...identity, db, row: reviewRow }), false);
});

test('HAMCLOSE-03 replay C: a clean handoff drains in one follow-up tick and merges in one watcher tick; a live hammer holds', async t => {
  const rootDir = root(t), headSha = 'd'.repeat(40), identity = { rootDir, repo, prNumber: 8149, headSha };
  const launchIdentity = { ...identity, headSha: 'a'.repeat(40) };
  const dispatch = amaCloserDispatchFilePath(rootDir, launchIdentity);
  mkdirSync(dirname(dispatch), { recursive: true });
  writeFileSync(dispatch, JSON.stringify({ ...launchIdentity, state: 'dispatched', launchRequestId: 'hammer-8149',
    lastObservedStatus: 'running', lastObservedAt: '2026-10-12T09:54:36Z' }));
  acquireAmaCloserLease({ ...launchIdentity, acquiredAt: '2026-10-12T09:46:23Z' });
  updateAmaCloserLease({ ...launchIdentity, status: 'dispatched', lrqId: 'hammer-8149' });
  createFollowUpJob({ rootDir, repo, prNumber: 8149, revisionRef: headSha, reviewerModel: 'gemini',
    reviewBody: cleanBody, reviewPostedAt: '2026-10-12T09:54:36Z', changedFiles: ['src/a.mjs'] });
  const drainArgs = { rootDir, maxConcurrent: 8, now: () => '2026-10-12T09:55:00Z', promptTemplate: 'fixture',
    quotaHoldRevalidator: () => ({ available: true }), logger: quiet, log: quiet,
    requestWatcherWakeImpl: () => ({ requested: true }),
    execFileImpl: async () => { throw new Error('clean drain must make no external calls'); },
    spawnImpl: () => { throw new Error('clean drain must not spawn'); } };
  const held = await consumeFollowUpJobsUntilCapacity(drainArgs);
  assert.equal(held.stopped, 0); assert.equal(held.deferredSamePR, 1);
  assert.equal(rekeyAmaCloserLease({ rootDir, repo, prNumber: 8149, fromHeadSha: launchIdentity.headSha, toHeadSha: headSha }).rekeyed, true);
  updateAmaCloserLease({ ...identity, status: 'handed-to-review', updatedAt: '2026-10-12T09:52:48Z' });
  const drained = await consumeFollowUpJobsUntilCapacity(drainArgs);
  assert.equal(drained.stopped, 1);
  const store = { merged: false };
  await watcherTick({ ...identity, evidence: { headSha, hasHammerCommits: false }, store,
    row: { review_status: 'posted', reviewer_head_sha: headSha, reviewer: 'gemini', review_body: cleanBody } });
  assert.equal(store.merged, true);
});

test('HAMCLOSE-03 unproven reversal pages once, keeps the hammer stopped and makes rescue refuse merge', async t => {
  const rootDir = root(t), evidence = await history(), pages = [], store = { merged: false };
  const bad = { ...evidence, reversalAuthorizations: [] };
  for (let tick = 0; tick < 2; tick++) await watcherTick({ rootDir, prNumber: 8132, headSha: bad.headSha,
    evidence: bad, store, pageImpl: async text => pages.push(text),
    row: { review_status: 'posted', reviewer_head_sha: bad.headSha, reviewer: 'gemini', review_body: cleanBody } });
  assert.equal(store.merged, false); assert.equal(pages.length, 1);
  assert.match(pages[0], /PR 8132.*src\/a\.mjs.*no verified/);
  assert.equal(store.lastClosure.closureOwner.owner, 'page');
  assert.equal(classifyClosureOwnership({ primaryChange: bad, currentHead: bad.headSha }).decision, 'page-required');
});

for (const status of ['succeeded', 'failed', 'cancelled', 'completed', 'terminal']) {
  test(`HAMCLOSE-03 terminal hammer ${status} releases the real clean drain without lease expiry`, async t => {
    const rootDir = root(t), headSha = 'd'.repeat(40), identity = { rootDir, repo, prNumber: 8149, headSha };
    const path = amaCloserDispatchFilePath(rootDir, identity);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...identity, state: 'dispatched', launchRequestId: 'terminal-hammer',
      lastObservedStatus: status, lastObservedAt: '2026-10-12T09:54:36Z' }));
    acquireAmaCloserLease(identity); updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'terminal-hammer' });
    createFollowUpJob({ rootDir, repo, prNumber: 8149, revisionRef: headSha, reviewerModel: 'gemini',
      reviewBody: cleanBody, reviewPostedAt: '2026-10-12T09:54:36Z', changedFiles: ['src/a.mjs'] });
    const drained = await consumeFollowUpJobsUntilCapacity({ rootDir, maxConcurrent: 8,
      now: () => '2026-10-12T09:55:00Z', promptTemplate: 'fixture', log: quiet,
      quotaHoldRevalidator: () => ({ available: true }), requestWatcherWakeImpl: () => ({ requested: true }),
      execFileImpl: async () => { throw new Error('offline terminal drain'); }, spawnImpl: () => { throw new Error('clean drain spawn'); } });
    assert.equal(drained.stopped, 1);
  });
}

test('capped routing refuses posted passes without any usable reviewed head', t => {
  const db = openReviewStateDb(root(t)); ensureReviewStateSchema(db); t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status)
    VALUES (?,8143,'2026-10-12T04:45:00Z','gemini','pending')`).run(repo);
  db.prepare(`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,
    started_at,ended_at,status,head_sha,gh_comment_id) VALUES (?,8143,1,'gemini','first-pass',
    '2026-10-12T04:44:00Z','2026-10-12T04:45:00Z','completed',NULL,'posted-null-head')`).run(repo);
  const row = db.prepare('SELECT * FROM reviewed_prs').get();
  assert.equal(routeCappedReviewToClosure({ db, repo, prNumber: 8143, headSha: 'a'.repeat(40), row, ceiling: 1 }), false);
  assert.deepEqual(db.prepare('SELECT * FROM reviewed_prs').get(), row);
});

for (const options of [{ rebasedAdded: '+different()' }, { parentExtraHunk: true }]) {
  test(`altered parent proof pages once without merge: ${JSON.stringify(options)}`, async t => {
    const rootDir = root(t), evidence = await history(options), pages = [], store = { merged: false };
    for (let tick = 0; tick < 2; tick++) await watcherTick({ rootDir, prNumber: 1, headSha: evidence.headSha,
      evidence, store, pageImpl: async text => pages.push(text),
      row: { review_status: 'posted', reviewer_head_sha: evidence.headSha, reviewer: 'gemini', review_body: cleanBody } });
    assert.equal(store.merged, false); assert.equal(pages.length, 1);
    assert.equal(store.lastClosure.closureOwner.owner, 'page');
  });
}

test('unknown primary evidence uses the production reason mapping and pages', async t => {
  const rootDir = root(t), headSha = 'a'.repeat(40), store = { merged: false }, pages = [];
  await watcherTick({ rootDir, prNumber: 2, headSha, evidence: { headSha, hasHammerCommits: null }, store,
    pageImpl: async text => pages.push(text),
    row: { review_status: 'posted', reviewer_head_sha: headSha, reviewer: 'gemini', review_body: cleanBody } });
  assert.equal(store.merged, false); assert.equal(pages.length, 1);
  assert.ok(store.lastClosure.daemonCleanMerge.reasons.includes('primary-change-unknown'));
});

test('empty sibling closes once and a closed candidate cannot dispatch a hammer', async t => {
  const rootDir = root(t), headSha = 'a'.repeat(40), base = 'b'.repeat(40);
  let closed = false, comments = 0;
  const execFileImpl = async (_cmd, args) => {
    if (args[0] === 'api') return { stdout: JSON.stringify(args[1].includes('/compare/') ? { files: [] }
      : { state: closed ? 'closed' : 'open', draft: false, labels: [], changed_files: 0, head: { sha: headSha }, base: { sha: base } }) };
    if (args[1] === 'close') closed = true;
    else { assert.equal(args.at(-1), EMPTY_PR_COMMENT); comments++; }
    return { stdout: '' };
  };
  for (let tick = 0; tick < 2; tick++) await closeEmptyPullRequest({ repo, prNumber: 20, headSha, execFileImpl });
  assert.equal(closed, true); assert.equal(comments, 1);
  const result = await maybeDispatchAmaCloser({ cfg: { enabled: true },
    reviewState: { verdict: 'approved', headSha }, prMetadata: { prNumber: 20, headSha, isOpen: false, isDraft: false, labels: [] },
    dispatchContext: { rootDir }, logger: quiet,
    execFileImpl: async () => { throw new Error('closed PR must make no external calls'); } });
  assert.equal(result.dispatched, false);
});

test('ceiling routing preserves generic failures and logs every admitted transition', t => {
  const db = openReviewStateDb(root(t)); ensureReviewStateSchema(db); t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,review_status)
    VALUES (?,1,'2026-01-01','gemini','failed')`).run(repo);
  db.prepare(`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,started_at,ended_at,status,head_sha,body_md)
    VALUES (?,1,1,'gemini','first-pass','2026-01-01','2026-01-01','completed',?,'Stored review')`).run(repo, 'a'.repeat(40));
  const logs = [], args = { db, repo, prNumber: 1, headSha: 'b'.repeat(40), ceiling: 1, logger: { log: line => logs.push(JSON.parse(line)) } };
  assert.equal(routeCappedReviewToClosure({ ...args, row: db.prepare('SELECT * FROM reviewed_prs').get() }), false);
  assert.equal(db.prepare('SELECT review_status FROM reviewed_prs').get().review_status, 'failed');
  db.prepare("UPDATE reviewed_prs SET rereview_reason='system-review-ceiling-closure'").run();
  assert.equal(routeCappedReviewToClosure({ ...args, row: db.prepare('SELECT * FROM reviewed_prs').get() }), true);
  assert.equal(logs.length, 1); assert.equal(logs[0].priorStatus, 'failed');
});
