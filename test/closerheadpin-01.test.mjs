// CLOSERHEADPIN-01: a closer's lease and its pinned inputs name one head.
// A closer that has not booted when the PR head moves is ended with the typed
// `superseded-head-moved` outcome instead of having its lease carried to a head
// its inputs refuse. A closer that stands down mid-run with `head-changed`
// keeps that registered reason end to end: a later generic stop from the same
// launch, keyed to its pinned head, can no longer turn it into a retryable
// `stop-reason-unregistered` deferral (which HQ also read as success).
// Synthetic fixtures only.
import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { readAmaAuditEntry, appendAmaAuditAttempt } from '../src/ama/audit.mjs';
import { readLaunchWorldRefusal, worldRefusalLeaseOutcome, SUPERSEDED_HEAD_MOVED } from '../src/ama/closer-head-pin.mjs';
import { CLOSER_HEAD_MOVED_REASON, supersedeHeadMovedCloser } from '../src/ama/closer-supersede.mjs';
import {
  AMA_CLOSER_RECLAIMABLE_TERMINAL_OUTCOMES, acquireAmaCloserLease, findLiveAmaCloserLease,
  readAmaCloserLease, rekeyAmaCloserLease, updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';
import {
  readAmaCloserDispatchRecord, reconcileAmaCloserLease, updateAmaCloserDispatchRecord,
} from '../src/ama/dispatch-closer.mjs';

const PINNED = '6'.repeat(40);
const MOVED = '8'.repeat(40);
const REPO = 'fixture/project';
const PR = 7101;
const LRQ = 'lrq_fixture_closer';
const AT = '2026-01-01T00:00:00.000Z';
const QUIET = { log() {}, info() {}, warn() {}, error() {} };

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'closerheadpin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hammerEnv(rootDir, runDir) {
  return { HAM_HQ_ROOT: rootDir, HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
    HAM_TARGET_REMEDIATION_SHA: PINNED, HQ_LAUNCH_REQUEST_ID: LRQ, ...(runDir ? { HAM_RUN_DIR: runDir } : {}) };
}

function ownAttempts(rootDir) {
  return [PINNED, MOVED].flatMap(head => (readAmaAuditEntry(rootDir, REPO, PR, head)?.attempts || [])
    .filter(attempt => attempt.launchRequestId === LRQ).map(attempt => ({ head, ...attempt })));
}

function seedDispatchedCloser(rootDir) {
  const identity = { rootDir, repo: REPO, prNumber: PR, headSha: PINNED };
  assert.equal(acquireAmaCloserLease({ ...identity, watcherPid: process.pid, now: AT }).acquired, true);
  updateAmaCloserLease({ ...identity, status: 'dispatched', lrqId: LRQ, now: AT });
  updateAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR, headSha: PINNED }, () => ({
    repo: REPO, prNumber: PR, headSha: PINNED, targetRemediationSha: PINNED, state: 'dispatched',
    launchRequestId: LRQ, dispatchedAt: AT }));
  return identity;
}

const observation = status => ({ state: 'complete', value: {
  terminal: ['canceled', 'succeeded', 'failed'].includes(status), effectiveLaunch: { status } } });

for (const [name, runDir] of [['with', true], ['without', false]]) {
  test(`a head-changed stand-down is never reclassified as unregistered (${name} a run directory)`, t => {
    const rootDir = scratch(t);
    const env = hammerEnv(rootDir, runDir ? scratch(t) : null);
    // The hammer refuses the live head it found, keyed to that head...
    recordHammerEarlyFailure('head-changed', { env, headSha: MOVED });
    // ...then a later non-phase step it named itself fails, keyed (by default)
    // to its pinned target. This is the shape that hid `head-changed`.
    for (const final of [false, true]) {
      const audit = recordHammerEarlyFailure('current-closing-status-failed', { env, final });
      assert.equal(audit.headSha, MOVED, 'the world refusal is returned, not a new deferral');
    }
    const attempts = ownAttempts(rootDir);
    assert.deepEqual(attempts.map(a => [a.head, a.outcome, a.reason]),
      [[MOVED, 'failed-without-merge', 'head-changed']]);
    assert.equal(attempts.some(a => a.reason === 'stop-reason-unregistered'), false);
    // HQ's terminal-audit contract reads deferred/superseded/succeeded as
    // success; this no-push, no-merge closer leaves only its failed refusal.
    assert.equal(attempts.some(a => ['succeeded', 'deferred', 'superseded'].includes(a.outcome)), false);
    assert.equal(readLaunchWorldRefusal(rootDir, { repo: REPO, prNumber: PR }, LRQ).reason, 'head-changed');
  });
}

test('an unrelated launch and a closer fault without a world refusal keep their existing audits', t => {
  const rootDir = scratch(t);
  recordHammerEarlyFailure('head-changed', { env: { ...hammerEnv(rootDir), HQ_LAUNCH_REQUEST_ID: 'lrq_other' },
    headSha: MOVED });
  recordHammerEarlyFailure('current-closing-status-failed', { env: hammerEnv(rootDir) });
  const attempts = ownAttempts(rootDir);
  assert.deepEqual(attempts.map(a => [a.head, a.outcome, a.reason]),
    [[PINNED, 'deferred', 'stop-reason-unregistered']]);
  assert.equal(readLaunchWorldRefusal(rootDir, { repo: REPO, prNumber: PR }, LRQ), null);
});

test('mid-run head move: the reconciler records superseded-head-moved, never retryable-stop-reason-unregistered', t => {
  const rootDir = scratch(t);
  seedDispatchedCloser(rootDir);
  // The watcher carried the booted closer's lease to the moved head (CLR-01).
  assert.equal(rekeyAmaCloserLease({ rootDir, repo: REPO, prNumber: PR, fromHeadSha: PINNED, toHeadSha: MOVED,
    now: AT }).rekeyed, true);
  // The incident's on-disk shape: the world refusal at the live head, and an
  // older-code generic stop at the pinned head as a closer deferral.
  recordHammerEarlyFailure('head-changed', { env: hammerEnv(rootDir), headSha: MOVED });
  appendAmaAuditAttempt({ hqRoot: rootDir, repo: REPO, prNumber: PR, headSha: PINNED, now: AT,
    attempt: { outcome: 'deferred', reason: 'stop-reason-unregistered', stopOrigin: 'closer',
      reasonDetail: 'current-closing-status-failed', attemptPhase: 'hammer-early-exit', launchRequestId: LRQ },
    metadata: { closureAuthority: 'ham-terminal-remediation', stopOrigin: 'closer' } });
  const events = [];
  const settled = reconcileAmaCloserLease({ rootDir, repo: REPO, prNumber: PR, hqRoot: rootDir, now: AT,
    readLaunchRequestStatusImpl: () => ({ ok: true, row: { status: 'succeeded', ticket_ref: `AMA-PR-${PR}` } }),
    readBuildCompletionSignalForPrImpl: () => ({ ok: false, reason: 'missing-build-completion-signal' }),
    readBuildCompletionProducerEvidenceImpl: () => ({ ok: false }),
    readPullRequestStateImpl: () => ({ state: 'OPEN', headRefOid: MOVED }),
    cleanupScratchImpl: () => {},
    logger: { ...QUIET, info: line => events.push(JSON.parse(line)) } });
  assert.equal(settled, true);
  const lease = readAmaCloserLease(rootDir, { repo: REPO, prNumber: PR, headSha: MOVED });
  assert.equal(lease.terminalOutcome, SUPERSEDED_HEAD_MOVED);
  assert.equal(events.at(-1).terminalOutcome, SUPERSEDED_HEAD_MOVED);
  assert.equal(readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR, headSha: PINNED }).terminalOutcome,
    SUPERSEDED_HEAD_MOVED);
  // The closure path re-arms at the new head: nothing holds the PR any more.
  assert.equal(AMA_CLOSER_RECLAIMABLE_TERMINAL_OUTCOMES.has(SUPERSEDED_HEAD_MOVED), true);
  assert.equal(findLiveAmaCloserLease(rootDir, { repo: REPO, prNumber: PR }), null);
});

test('a non-head world refusal maps to failed-without-merge; no refusal maps to nothing', () => {
  assert.equal(worldRefusalLeaseOutcome({ reason: 'head-changed' }), SUPERSEDED_HEAD_MOVED);
  assert.equal(worldRefusalLeaseOutcome({ reason: 'ci-not-green' }), 'failed-without-merge');
  assert.equal(worldRefusalLeaseOutcome(null), null);
});

test('head moved before boot: the not-booted closer ends superseded-head-moved and its lease is not carried', async t => {
  const rootDir = scratch(t);
  const identity = seedDispatchedCloser(rootDir);
  const state = { status: 'admitted' };
  const cancels = [];
  const result = await supersedeHeadMovedCloser({ rootDir, repo: REPO, prNumber: PR,
    pinnedHeadSha: PINNED, liveHeadSha: MOVED, launchRequestId: LRQ, hqPath: 'hq', retryDelaysMs: [],
    readLaunchImpl: async () => observation(state.status), logger: QUIET,
    execFileImpl: async (bin, argv) => { cancels.push(argv); state.status = 'canceled'; return { stdout: '{}' }; } });
  assert.equal(result.superseded, true);
  assert.deepEqual(cancels, [['dispatch', 'cancel', LRQ, '--reason', CLOSER_HEAD_MOVED_REASON]]);
  const lease = readAmaCloserLease(rootDir, identity);
  assert.deepEqual([lease.headSha, lease.status, lease.terminalOutcome], [PINNED, 'terminal', SUPERSEDED_HEAD_MOVED]);
  assert.equal(readAmaCloserLease(rootDir, { ...identity, headSha: MOVED }), null, 'no lease names the moved head');
  const record = readAmaCloserDispatchRecord(rootDir, { repo: REPO, prNumber: PR, headSha: PINNED });
  assert.deepEqual([record.supersededByHeadMove.liveHeadSha, record.supersededByHeadMove.reason,
    record.supersededByReview], [MOVED, CLOSER_HEAD_MOVED_REASON, undefined]);
  assert.equal(findLiveAmaCloserLease(rootDir, { repo: REPO, prNumber: PR }), null);
  assert.equal(acquireAmaCloserLease({ rootDir, repo: REPO, prNumber: PR, headSha: MOVED, now: AT }).acquired, true,
    'the closure path can own the new head');
});

test('a booted closer is never cancelled for a head move, and identity mismatches are refused', async t => {
  for (const status of ['leased', 'starting', 'running']) {
    const rootDir = scratch(t);
    const identity = seedDispatchedCloser(rootDir);
    const cancels = [];
    const result = await supersedeHeadMovedCloser({ rootDir, repo: REPO, prNumber: PR,
      pinnedHeadSha: PINNED, liveHeadSha: MOVED, launchRequestId: LRQ, hqPath: 'hq', retryDelaysMs: [],
      readLaunchImpl: async () => observation(status), logger: QUIET,
      execFileImpl: async (bin, argv) => { cancels.push(argv); return { stdout: '{}' }; } });
    assert.deepEqual([result.superseded, result.reason], [false, 'closer-booted'], status);
    assert.deepEqual(cancels, [], status);
    assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched', status);
  }
  for (const args of [{ liveHeadSha: PINNED }, { launchRequestId: null }, { pinnedHeadSha: null }]) {
    const result = await supersedeHeadMovedCloser({ pinnedHeadSha: PINNED, liveHeadSha: MOVED,
      launchRequestId: LRQ, ...args, readLaunchImpl: async () => assert.fail('no read on a mismatch') });
    assert.equal(result.reason, 'supersede-identity-mismatch');
  }
});

test('head moved again before boot: supersede settles the rekeyed lease and retains the original dispatch record', async t => {
  const rootDir = scratch(t);
  const identity = seedDispatchedCloser(rootDir);
  const nextHead = 'a'.repeat(40);
  assert.equal(rekeyAmaCloserLease({ ...identity, fromHeadSha: PINNED, toHeadSha: MOVED, now: AT }).rekeyed, true);
  const state = { status: 'admitted' };
  const result = await supersedeHeadMovedCloser({ rootDir, repo: REPO, prNumber: PR,
    pinnedHeadSha: MOVED, recordHeadSha: PINNED, liveHeadSha: nextHead, launchRequestId: LRQ,
    hqPath: 'hq', retryDelaysMs: [], logger: QUIET,
    readLaunchImpl: async () => observation(state.status),
    execFileImpl: async () => { state.status = 'canceled'; return { stdout: '{}' }; } });
  assert.equal(result.superseded, true);
  const lease = readAmaCloserLease(rootDir, { ...identity, headSha: MOVED });
  assert.deepEqual([lease.headSha, lease.rekeyedFromHeadSha, lease.status, lease.terminalOutcome],
    [MOVED, PINNED, 'terminal', SUPERSEDED_HEAD_MOVED]);
  assert.equal(readAmaCloserLease(rootDir, identity), null, 'the historical dispatch head has no lease');
  const record = readAmaCloserDispatchRecord(rootDir, identity);
  assert.deepEqual([record.supersededByHeadMove.headSha, record.supersededByHeadMove.liveHeadSha,
    record.supersededByHeadMove.observedStatus], [MOVED, nextHead, 'canceled']);
  assert.equal(readAmaCloserDispatchRecord(rootDir, { ...identity, headSha: MOVED }), null);
  assert.equal(findLiveAmaCloserLease(rootDir, { repo: REPO, prNumber: PR }), null);
  assert.equal(acquireAmaCloserLease({ ...identity, headSha: nextHead, now: AT }).acquired, true,
    'the retired rekeyed lease permits closure at the next head');
});
