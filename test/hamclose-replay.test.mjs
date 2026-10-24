import { watcherTick } from './helpers/smv-watcher.mjs';
import { collect } from './helpers/hamclose-history.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { createFollowUpJob } from '../src/follow-up-jobs.mjs';
import { consumeFollowUpJobsUntilCapacity } from '../src/follow-up-remediation.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, rekeyAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { amaCloserDispatchFilePath, maybeDispatchAmaCloser } from '../src/ama/dispatch-closer.mjs';
import { closeEmptyPullRequest, EMPTY_PR_COMMENT } from '../src/empty-pr-close.mjs';
import { openReviewStateDb, ensureReviewStateSchema, requestReviewRereview } from '../src/review-state.mjs';
import { routeCappedReviewToClosure, hammerHandoffReviewBypass, postedReviewCeilingReached } from '../src/hamclose-review-admission.mjs';
import { classifyClosureOwnership } from '../src/merge-agent-rescue-classifier.mjs';

const repo = 'fixture/repo';
const cleanBody = '## Blocking issues\n- None.\n## Non-blocking issues\n- None.\n## Verdict\nApproved';
const findingsBody = '## Blocking issues\n- None.\n## Non-blocking issues\n- **Cleanup**\n  - **File:** `src/fixture.mjs`\n  - **Lines:** `1`\n  - **Problem:** redundant branch\n  - **Recommended fix:** remove it\n## Verdict\nComment only';
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


test('HAMCLOSE-03 replay A: synthetic reversal merges in one posted-review/closure tick', async t => {
  const rootDir = root(t), evidence = await history(), store = { merged: false };
  assert.equal(evidence.reversalAuthorizations[0].originalAuthorization.rebased, true);
  assert.equal(checkPrimaryChange({ ...evidence, reversalAuthorizations: [] }, evidence.headSha, { strictNonBlockingRemediation: true }).ok, false);
  assert.equal(checkPrimaryChange(evidence, evidence.headSha, { strictNonBlockingRemediation: true }).ok, true);
  await watcherTick({ rootDir, prNumber: 8132, headSha: evidence.headSha, evidence, store,
    row: { review_status: 'posted', reviewer_head_sha: evidence.headSha, reviewer: 'gemini', review_body: cleanBody } });
  assert.equal(store.merged, true);
});

test('HAMCLOSE-03 replay B: head-bound exact-head review precedes the delivered ceiling hammer fallback', async t => {
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
  const closureStore = { merged: false };
  const cappedRow = { ...db.prepare('SELECT * FROM reviewed_prs').get(), review_body: cleanBody };
  await watcherTick({ ...identity, row: cappedRow, evidence: { headSha, hasHammerCommits: false },
    store: closureStore, closureOnly: true,
    closerImpl: async () => assert.fail('an explicit exact-head review must not dispatch a ceiling hammer') });
  assert.equal(closureStore.merged, false);
  const closure = closureStore.lastClosure;
  assert.equal(closure.ownerProofFacts.reviewCycleExhausted, true);
  assert.equal(closure.dispatched, false);
  assert.equal(closure.nextAction.action, 'review');
  assert.equal(closure.nextAction.reason, 'exact-head-review');
  assert.equal(closure.closureOwner.owner, 'review');
  assert.equal(closure.closerAuthoredStale.decision, 'rereview-exact-head');
  assert.equal(closure.closerAuthoredStale.reviewedHead, old);
  assert.equal(closure.closerAuthoredStale.currentHead, headSha);
});

test('HAMCLOSE-03 legacy hammer handoff authorizes only one exact-head review attempt', t => {
  const rootDir = root(t), headSha = 'c'.repeat(40);
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db); t.after(() => db.close());
  const identity = { rootDir, repo, prNumber: 8143, headSha };
  assert.equal(acquireAmaCloserLease(identity).acquired, true);
  updateAmaCloserLease({ ...identity, status: 'handed-to-review' }); // Legacy receipt fixture.
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
  createFollowUpJob({ branch: 'fixture/remediation', rootDir, repo, prNumber: 8149, revisionRef: headSha, reviewerModel: 'gemini',
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

test('HAMCLOSE-03 unproven reversal retains shared repair ownership without permitting merge', async t => {
  const rootDir = root(t), evidence = await history(), pages = [], store = { merged: false };
  const bad = { ...evidence, reversalAuthorizations: [] };
  for (let tick = 0; tick < 2; tick++) await watcherTick({ rootDir, prNumber: 8132, headSha: bad.headSha,
    evidence: bad, store, closerImpl: async () => ({ dispatched: false, skipMergeAgent: true }), pageImpl: async text => pages.push(text),
    row: { review_status: 'posted', reviewer_head_sha: bad.headSha, reviewer: 'gemini', review_body: cleanBody } });
  assert.equal(store.merged, false); assert.equal(pages.length, 0);
  assert.equal(checkPrimaryChange(bad, bad.headSha).ok, false);
  assert.equal(store.lastClosure.nextAction.actor, 'hammer');
  assert.equal(classifyClosureOwnership(store.lastClosure.nextAction, bad.headSha).decision, 'hammer-eligible');
});

for (const status of ['succeeded', 'failed', 'cancelled', 'completed', 'terminal']) {
  test(`HAMCLOSE-03 terminal hammer ${status} releases the real clean drain without lease expiry`, async t => {
    const rootDir = root(t), headSha = 'd'.repeat(40), identity = { rootDir, repo, prNumber: 8149, headSha };
    const path = amaCloserDispatchFilePath(rootDir, identity);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...identity, state: 'dispatched', launchRequestId: 'terminal-hammer',
      lastObservedStatus: status, lastObservedAt: '2026-10-12T09:54:36Z' }));
    acquireAmaCloserLease(identity); updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'terminal-hammer' });
    createFollowUpJob({ branch: 'fixture/remediation', rootDir, repo, prNumber: 8149, revisionRef: headSha, reviewerModel: 'gemini',
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
  test(`altered parent proof retains repair ownership without merge: ${JSON.stringify(options)}`, async t => {
    const rootDir = root(t), evidence = await history(options), pages = [], store = { merged: false };
    for (let tick = 0; tick < 2; tick++) await watcherTick({ rootDir, prNumber: 1, headSha: evidence.headSha,
      evidence, store, closerImpl: async () => ({ dispatched: false, skipMergeAgent: true }), pageImpl: async text => pages.push(text),
      row: { review_status: 'posted', reviewer_head_sha: evidence.headSha, reviewer: 'gemini', review_body: cleanBody } });
    assert.equal(store.merged, false); assert.equal(pages.length, 0);
    assert.equal(store.lastClosure.nextAction.actor, 'hammer');
  });
}

test('unknown primary evidence retains shared ownership and refuses merge', async t => {
  const rootDir = root(t), headSha = 'a'.repeat(40), store = { merged: false }, pages = [];
  await watcherTick({ rootDir, prNumber: 2, headSha, evidence: { headSha, hasHammerCommits: null }, store, closerImpl: async () => ({ dispatched: false, skipMergeAgent: true }),
    pageImpl: async text => pages.push(text),
    row: { review_status: 'posted', reviewer_head_sha: headSha, reviewer: 'gemini', review_body: cleanBody } });
  assert.equal(store.merged, false); assert.equal(pages.length, 0);
  assert.equal(checkPrimaryChange({ headSha, hasHammerCommits: null }, headSha).ok, false);
  assert.equal(store.lastClosure.nextAction.actor, 'hammer');
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

for (const findings of [false, true]) test(`HAMCLOSE-04 handed-off review closes with findings=${findings}`, async t => {
  const rootDir = root(t), headSha = 'b'.repeat(40), prNumber = 30;
  const identity = { rootDir, repo, prNumber, headSha };
  acquireAmaCloserLease(identity);
  updateAmaCloserLease({ ...identity, status: 'handed-to-review' }); // Legacy receipt fixture.
  const store = { merged: false };
  let hammers = 0;
  const args = { ...identity, evidence: { headSha, hasHammerCommits: false }, store, findings,
    row: { review_status: 'posted', reviewer_head_sha: headSha, reviewer: 'gemini', review_body: findings ? findingsBody : cleanBody },
    closerImpl: async () => {
      if (!acquireAmaCloserLease({ ...identity, fromReviewHandoff: true }).acquired)
        return { dispatched: false, reason: 'lease-held' };
      hammers++;
      updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: 'synthetic-hammer' });
      return { dispatched: true, workerClass: 'hammer' };
    } };
  await watcherTick(args);
  assert.equal(store.merged, !findings, JSON.stringify(store));
  assert.equal(hammers, findings ? 1 : 0, JSON.stringify(store));
  await watcherTick(args);
  assert.equal(hammers, findings ? 1 : 0);
});

for (const guard of ['settled', 'unproven']) test(`HAMCLOSE-04 ${guard} comment-only guard admits only the lease-owned attempt`, t => {
  const rootDir = root(t), headSha = 'c'.repeat(40), prNumber = 31;
  const identity = { rootDir, repo, prNumber, headSha };
  const db = openReviewStateDb(rootDir); ensureReviewStateSchema(db); t.after(() => db.close());
  db.prepare(`INSERT INTO reviewed_prs(repo,pr_number,reviewed_at,reviewer,pr_state,review_status)
    VALUES (?,?,'2026-01-01','gemini','open','posted')`).run(repo, prNumber);
  const dir = join(rootDir, 'data/follow-up-jobs/completed'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fixture__repo-pr-31-final.json'), JSON.stringify({ repo, prNumber,
    status: 'completed', revisionRef: guard === 'settled' ? headSha : 'a'.repeat(40),
    reviewBody: '## Verdict\nComment only', finalRound: 'comment-only',
    reReview: { suppressed: 'comment-only-final-round' }, completion: { withheldPushHeadSha: headSha } }));
  const request = () => requestReviewRereview({ ...identity, db, targetRevisionRef: headSha,
    reason: `system-orphan-head-review:${headSha}`, logger: quiet });
  assert.equal(request().triggered, false, 'a request marker alone grants no authority');
  acquireAmaCloserLease(identity);
  updateAmaCloserLease({ ...identity, status: 'handed-to-review' });
  assert.equal(request().triggered, true);
  db.prepare(`INSERT INTO reviewer_passes(repo,pr_number,attempt_number,reviewer_class,pass_kind,
    started_at,status,head_sha) VALUES (?,?,1,'gemini','rereview',?,'failed',?)`)
    .run(repo, prNumber, new Date(Date.now() + 1000).toISOString().replace('T', ' ').replace('Z', ''), headSha);
  assert.equal(request().triggered, false, 'a failed attempt also spends the transfer');
  db.prepare("UPDATE reviewer_passes SET status='completed', body_md='Synthetic completed review' WHERE pr_number=?").run(prNumber);
  updateAmaCloserLease({ ...identity, status: 'handed-to-review', now: new Date(Date.now() + 2000).toISOString() });
  assert.equal(request().triggered, false, 'renewing the lease cannot authorize a second same-head review');
});
