import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  evaluateHammerStopHold,
  HISTORY_READ_FAILURE_PAGE_GRACE_MS,
  _resetHammerStopHoldPageDebounceForTests,
} from '../src/ama/hammer-stop-hold.mjs';
import { maybeDispatchAmaCloser, readAmaCloserDispatchRecord, updateAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';
import { runPostedReviewHandlersFairly } from '../src/watcher-poll-fairness.mjs';
import { writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { createNoProgressLaneGate } from '../src/posted-review-row.mjs';
import { noProgressLaneFilePath, readNoProgressLane, recordNoProgressLaneRun, recordNoProgressLaneSkip } from '../src/watcher-no-progress-lane.mjs';

const repo = 'fixture/repo';
const head = 'a'.repeat(40);
const start = Date.parse('2026-10-01T00:00:00Z');
const at = ms => new Date(start + ms).toISOString();
const logger = { log() {}, info() {}, warn() {}, error() {} };

function fixture(t, predicate = 'history-read-failed') {
  _resetHammerStopHoldPageDebounceForTests();
  const rootDir = mkdtempSync(join(tmpdir(), 'transientstop-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const pages = [];
  const args = {
    rootDir, hqRoot: rootDir, repo, prNumber: 1, headSha: head,
    prMetadata: { headSha: head, mergeableState: 'MERGEABLE', statusCheckRollup: [] },
    // An old audit must not turn the first failed probe into an immediate page.
    readAuditImpl: () => ({ attempts: [{ head, outcome: 'failed-without-merge',
      reason: predicate, startedAt: at(-45 * 60_000), path: 'hammer' }] }),
    fetchPrimaryChangeImpl: async () => ({ headSha: head, historyReadFailed: true }),
    deliverAlertImpl: async (text, options) => pages.push({ text, options }), logger,
  };
  return { args, pages };
}

test('TRANSIENTSTOP-01: persistent failed probes page once at ten minutes, including after restart', async t => {
  const { args, pages } = fixture(t);
  for (const ms of [0, 5 * 60_000, HISTORY_READ_FAILURE_PAGE_GRACE_MS - 1]) {
    const result = await evaluateHammerStopHold({ ...args, now: at(ms) });
    assert.equal(result.action, 'hold');
    assert.equal(result.hammerStop.paged, false);
    assert.equal(pages.length, 0);
  }
  _resetHammerStopHoldPageDebounceForTests();
  for (const ms of [HISTORY_READ_FAILURE_PAGE_GRACE_MS, 15 * 60_000]) {
    const result = await evaluateHammerStopHold({ ...args, now: at(ms) });
    assert.equal(result.hammerStop.paged, true);
    assert.equal(pages.length, 1);
    _resetHammerStopHoldPageDebounceForTests();
  }
});

test('TRANSIENTSTOP-01: successful evidence at the page deadline releases without sending a page', async t => {
  const { args, pages } = fixture(t);
  await evaluateHammerStopHold({ ...args, now: at(0) });
  const result = await evaluateHammerStopHold({ ...args, now: at(HISTORY_READ_FAILURE_PAGE_GRACE_MS),
    fetchPrimaryChangeImpl: async () => ({ headSha: head, hasHammerCommits: false }) });
  assert.equal(result.action, 'release');
  assert.deepEqual(result.changed, ['primary-change-evidence']);
  assert.equal(pages.length, 0);
});

test('TRANSIENTSTOP-01: thrown probes get the same grace; other stop predicates still page immediately', async t => {
  const { args, pages } = fixture(t);
  const failed = { ...args, fetchPrimaryChangeImpl: async () => { throw new Error('synthetic connection failure'); } };
  await evaluateHammerStopHold({ ...failed, now: at(0) });
  assert.equal(pages.length, 0);
  await evaluateHammerStopHold({ ...failed, now: at(HISTORY_READ_FAILURE_PAGE_GRACE_MS) });
  assert.equal(pages.length, 1);
  for (const predicate of ['ci-not-green', 'primary-change-unknown', 'primary-change-read-failed']) {
    const other = fixture(t, predicate);
    assert.equal((await evaluateHammerStopHold({ ...other.args, now: at(0) })).action, 'hold');
    assert.equal(other.pages.length, 1, predicate);
    await evaluateHammerStopHold({ ...other.args, now: at(5 * 60_000) });
    assert.equal(other.pages.length, 1, predicate);
  }
});

function stopAudit(rootDir, predicate) {
  writeAmaAuditEntry({ hqRoot: rootDir, repo, prNumber: 1, headSha: head, now: at(0),
    attempt: { outcome: 'failed-without-merge', reason: predicate, head, path: 'hammer' } });
}

test('TRANSIENTSTOP-01: evidence stops become due at five minutes despite a slow lane and no review event', async t => {
  for (const predicate of ['history-read-failed', 'primary-change-unknown', 'primary-change-read-failed', 'ci-not-green']) {
    const { args } = fixture(t, predicate);
    stopAudit(args.rootDir, predicate);
    const identity = { repo, prNumber: 1 };
    for (let i = 0; i < 20; i++) recordNoProgressLaneRun(args.rootDir, identity, {
      headSha: head, fingerprint: 'unchanged-review', now: at(0), logger,
    });
    const gate = createNoProgressLaneGate({ rootDir: args.rootDir, hqRoot: args.rootDir,
      readReviewRow: () => ({ reviewer_head_sha: head }), now: () => at(5 * 60_000), logger });
    const handler = { repoPath: repo, prNumber: 1, headSha: head };
    assert.equal(gate.evaluate(handler).run, predicate !== 'ci-not-green', predicate);
  }
});

test('TRANSIENTSTOP-01: rapid ticks, wake priority and the idle floor respect evidence cadence across restart', async t => {
  const { args } = fixture(t);
  stopAudit(args.rootDir, 'history-read-failed');
  let clock = at(0), runs = 0;
  const makeGate = () => createNoProgressLaneGate({ rootDir: args.rootDir, hqRoot: args.rootDir,
    readReviewRow: () => ({ reviewer_head_sha: head }), now: () => clock, logger });
  let gate = makeGate();
  const handler = { repoPath: repo, prNumber: 1, headSha: head, run: async () => { runs++; } };
  const poll = () => runPostedReviewHandlersFairly({ handlers: [handler], laneGate: gate,
    priorityTargets: [{ repo, prNumber: 1 }], budgetMs: 30_000, handlerTimeoutMs: 20_000, logger });
  await poll();
  assert.equal(runs, 1, 'missing ledger gets one initial walk');
  for (const ms of [1, 60_000, 240_000, 299_999]) {
    clock = at(ms);
    gate = makeGate();
    await poll();
    assert.equal(runs, 1, 'neither scheduler override can bypass the interval');
    assert.equal(readNoProgressLane(args.rootDir, { repo, prNumber: 1 }).lastRunAt, at(0));
  }
  clock = at(300_000);
  await poll();
  assert.equal(runs, 2);
  clock = at(300_001);
  await poll();
  assert.equal(runs, 2, 'the second walk starts a new interval');
  assert.equal(gate.evaluate({ ...handler, headSha: 'b'.repeat(40) }).run, true);
});

test('TRANSIENTSTOP-01: paged and released historical stops use ordinary backoff', async t => {
  for (const release of [false, true]) {
    const { args, pages } = fixture(t);
    stopAudit(args.rootDir, 'history-read-failed');
    await evaluateHammerStopHold({ ...args, readAuditImpl: undefined, now: at(0) });
    await evaluateHammerStopHold({ ...args, readAuditImpl: undefined, now: at(600_000),
      ...(release ? { fetchPrimaryChangeImpl: async () => ({ headSha: head, hasHammerCommits: false }) } : {}) });
    assert.equal(pages.length, release ? 0 : 1);
    const identity = { repo, prNumber: 1 };
    for (let i = 0; i < 20; i++) recordNoProgressLaneRun(args.rootDir, identity, {
      headSha: head, fingerprint: 'unchanged-review', now: at(600_000), logger });
    const gate = createNoProgressLaneGate({ rootDir: args.rootDir, hqRoot: args.rootDir,
      readReviewRow: () => ({ reviewer_head_sha: head }), now: () => at(900_000), logger });
    const handler = { repoPath: repo, prNumber: 1, headSha: head };
    assert.equal(gate.evaluate(handler).run, false, release ? 'released but waiting for checks/capacity' : 'paged');
    for (let i = 0; i < 12; i++) recordNoProgressLaneSkip(args.rootDir, identity, { headSha: head, now: at(900_000) });
    assert.equal(gate.evaluate(handler).run, true, 'normal backoff still eventually admits');
  }
});

test('TRANSIENTSTOP-01: legacy last-run fallback survives repeated skipped polls', t => {
  const { args } = fixture(t);
  stopAudit(args.rootDir, 'history-read-failed');
  const identity = { repo, prNumber: 1 };
  recordNoProgressLaneRun(args.rootDir, identity, { headSha: head, fingerprint: 'unchanged', now: at(0) });
  const legacy = readNoProgressLane(args.rootDir, identity);
  delete legacy.lastRunAt;
  writeFileSync(noProgressLaneFilePath(args.rootDir, identity), JSON.stringify(legacy));
  let clock = at(60_000);
  const gate = createNoProgressLaneGate({ rootDir: args.rootDir, hqRoot: args.rootDir,
    readReviewRow: () => ({ reviewer_head_sha: head }), now: () => clock, logger });
  const handler = { repoPath: repo, prNumber: 1, headSha: head };
  assert.equal(gate.evaluate(handler).run, false);
  clock = at(299_999);
  assert.equal(gate.evaluate(handler).run, false);
  clock = at(300_000);
  assert.equal(gate.evaluate(handler).run, true);
});

for (const omitTimestamp of [false, true]) test(`TRANSIENTSTOP-01: next pass releases and dispatches without a review event (omit timestamp=${omitTimestamp})`, async t => {
  const { args, pages } = fixture(t);
  stopAudit(args.rootDir, 'history-read-failed');
  const identity = { repo, prNumber: 1, headSha: head };
  const user = userInfo().username;
  let now = at(0), failing = true, launches = 0, probes = 0;
  let observedRecord;
  const closer = () => maybeDispatchAmaCloser({
    reviewState: { verdict: 'approved', headSha: head, riskClass: 'low', remediationPending: false,
      blockingFindingState: 'known', blockingFindingCount: 0,
      nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
    prMetadata: { prNumber: 1, headSha: head, isOpen: true, isDraft: false, labels: [],
      mergeableState: 'MERGEABLE', branchProtection: { requiredContexts: [] },
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    cfg: { enabled: true, workerClass: 'hammer', mergeMethod: 'squash',
      eligibility: { riskClasses: ['low'], highRiskRequiresTwoKey: false }, branchProtection: { required: false } },
    dispatchContext: { rootDir: args.rootDir, hqRoot: args.rootDir, repo, reviewedSha: head,
      targetRemediationSha: head, dispatchRecordHeadSha: head,
      dispatchedAt: omitTimestamp && !failing ? undefined : now, forceHammerAfterDaemonFailure: true,
      hqOwnerUser: user, currentUser: user, hqPath: 'fixture-hq',
      closerTokenRollupPollDelaysMs: [], livePrProbeImpl: async () => ({ state: 'OPEN', headRefOid: head, headBranchExists: true }) },
    fetchPrimaryChangeImpl: async () => { probes++; return failing
      ? { headSha: head, historyReadFailed: true } : primaryChangeFixture(head); },
    execFileImpl: async (_cmd, argv) => {
      if (argv[0] === 'dispatch' && argv[1] === 'status') return { stdout: JSON.stringify({ status: 'failed' }) };
      if (argv[0] === 'dispatch') {
        launches++;
        return { stdout: JSON.stringify({ dispatchId: 'fixture-dispatch', launchRequestId: 'fixture-next' }) };
      }
      return { stdout: '{}' };
    },
    readLaunchRequestStatusImpl: () => ({ ok: false, reason: 'query-failed' }),
    readPullRequestStateImpl: () => null,
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false, reason: 'missing-build-completion-producer-evidence' }),
    fetchPullRequestRollupImpl: async () => ({ state: 'OPEN', comments: [] }),
    resolveCloserDispatchHarnessImpl: async () => ({ workerClass: 'hammer', fellBack: false }),
    observeCloserBacklogImpl: async () => {
      observedRecord = readAmaCloserDispatchRecord(args.rootDir, identity);
      return 0;
    },
    readTemplateImpl: () => 'synthetic hammer prompt', writeFileImpl: () => {},
    deliverAlertImpl: args.deliverAlertImpl, logger,
  });
  // A prior failed launch has a fresh record; its lease is already gone and the ledger read fails.
  updateAmaCloserDispatchRecord(args.rootDir, identity, () => ({ ...identity,
    workerClass: 'hammer', state: 'dispatched', launchRequestId: 'fixture-prior',
    reviewedSha: head, lastObservedStatus: 'running', dispatchedAt: at(0), lastAttemptedAt: at(0) }));
  assert.equal((await closer()).reason, 'hammer-stop-awaiting-input-change');
  assert.equal(pages.length, 0);
  for (let i = 0; i < 20; i++) recordNoProgressLaneRun(args.rootDir, identity, {
    headSha: head, fingerprint: 'unchanged-review', now: at(0), logger,
  });
  const gate = createNoProgressLaneGate({ rootDir: args.rootDir, hqRoot: args.rootDir,
    readReviewRow: () => ({ reviewer_head_sha: head }), now: () => now, logger });
  now = at(5 * 60_000);
  failing = false;
  let result;
  await runPostedReviewHandlersFairly({ handlers: [{ repoPath: repo, prNumber: 1, headSha: head,
    run: async () => { result = await closer(); return result; } }], laneGate: gate,
    budgetMs: 30_000, handlerTimeoutMs: 20_000, logger });
  assert.equal(result?.dispatched, true, JSON.stringify(result));
  assert.equal(launches, 1);
  assert.equal(observedRecord.lastObservedStatus, 'failed');
  assert.ok(Number.isFinite(Date.parse(observedRecord.lastObservedAt)), 'terminal observation has a usable timestamp');
  if (!omitTimestamp) assert.equal(observedRecord.lastObservedAt, now);
  assert.ok(probes >= 2);
  assert.equal(pages.length, 0);
});
