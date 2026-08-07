// FUS-REAP — per-tick reaper for follow-up work whose target PR is
// already merged/closed:
//   (A)  pending + failed follow-up jobs,
//   (B1) orphaned in-progress follow-up claims (dead worker),
//   (B2) orphaned AMA closer dispatch reservations.
//
// Root cause these tests pin (observed live): the follow-up remediation
// daemon's consume loop logged deferredSamePR=7 spawned=0 with full idle
// capacity and activeAtStart=0. On current main buildFollowUpClaimReservations
// feeds blockedRepoPrKeys from in-progress jobs PLUS active AMA closer
// dispatch records; with no in-progress jobs, the 7 blocked keys were
// orphaned closer dispatches for already-MERGED PRs. The reaper drains all
// three classes before consume, and only ARCHIVES moot jobs / RELEASES dead
// claims / terminalizes moot closer reservations — never an open PR, never a
// live follow-up worker, never a git merge.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildFollowUpJob,
  getFollowUpJobDir,
  writeFollowUpJob,
} from '../src/follow-up-jobs.mjs';
import {
  DEFAULT_REAP_MAX_PR_LOOKUPS,
  REAP_MAX_PR_LOOKUPS_ENV,
  REAP_AMA_CLOSER_MIN_STALE_MS_ENV,
  reapFinishedPrFollowUpJobs,
  resolveReapMaxPrLookups,
  resolveReapAmaCloserMinStaleMs,
} from '../src/follow-up-stuck-claim-sweep.mjs';

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'adversarial-review-reaper-'));
}

function seedJob(rootDir, dirKey, {
  jobId,
  repo = 'laceyenterprises/agent-os',
  prNumber = 1226,
  status,
  remediationWorker,
} = {}) {
  const dir = getFollowUpJobDir(rootDir, dirKey);
  mkdirSync(dir, { recursive: true });
  const base = buildFollowUpJob({
    repo,
    prNumber,
    reviewerModel: 'codex',
    reviewBody: '## Summary\nFUS-REAP fixture',
    reviewPostedAt: '2026-08-06T05:01:00.000Z',
    critical: false,
  });
  const finalJobId = jobId || base.jobId;
  const job = { ...base, jobId: finalJobId };
  if (status) job.status = status;
  if (remediationWorker) job.remediationWorker = remediationWorker;
  const jobPath = path.join(dir, `${finalJobId}.json`);
  writeFollowUpJob(jobPath, job);
  return { job, jobPath };
}

function readJobAtPath(jobPath) {
  return JSON.parse(readFileSync(jobPath, 'utf8'));
}

function stoppedPathFor(rootDir, jobPath) {
  return path.join(getFollowUpJobDir(rootDir, 'stopped'), path.basename(jobPath));
}

function countInDir(rootDir, dirKey) {
  const dir = getFollowUpJobDir(rootDir, dirKey);
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((n) => n.endsWith('.json')).length;
}

const liveMerged = {
  source: 'live',
  prState: 'merged',
  mergedAt: '2026-08-06T05:01:49.000Z',
  closedAt: null,
};
const liveClosed = {
  source: 'live',
  prState: 'closed',
  mergedAt: null,
  closedAt: '2026-08-06T05:01:49.000Z',
};
const liveOpen = { source: 'live', prState: 'open', mergedAt: null, closedAt: null };

// ---- (A) pending / failed jobs ----

test('reaper: pending job whose PR is MERGED is reaped to stopped/ with reason', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'pending', { prNumber: 4971 });
  const logs = [];
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    now: () => '2026-08-06T06:00:00.000Z',
    resolvePRLifecycleImpl: async () => liveMerged,
    log: { log: (m) => logs.push(m), warn: () => {} },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.reaped, 1);
  assert.equal(result.released, 0);
  assert.equal(result.amaScanned, 0);
  assert.equal(result.skippedOpen, 0);
  assert.equal(result.skippedUnreadable, 0);
  assert.equal(result.prLookups, 1);
  assert.deepEqual(result.reapedPrs, [
    { repo: 'laceyenterprises/agent-os', prNumber: 4971, prState: 'merged', fromStatus: 'pending' },
  ]);

  assert.equal(existsSync(jobPath), false, 'pending file removed');
  const stopped = readJobAtPath(stoppedPathFor(rootDir, jobPath));
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.remediationPlan?.stop?.code, 'operator-merged-pr');
  assert.match(stopped.remediationPlan?.stop?.reason, /reaped: pr 4971 is MERGED/);
  assert.equal(stopped.remediationWorker?.reapReason, 'operator-merged-pr');
  assert.equal(stopped.remediationWorker?.reapedFromStatus, 'pending');
  assert.equal(stopped.remediationWorker?.prMergedAt, '2026-08-06T05:01:49.000Z');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /reaped-finished-pr/);
  assert.match(logs[0], /state=MERGED/);
});

test('reaper: pending job whose PR is CLOSED is reaped', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'pending', { prNumber: 4988 });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveClosed,
  });
  assert.equal(result.reaped, 1);
  const stopped = readJobAtPath(stoppedPathFor(rootDir, jobPath));
  assert.equal(stopped.remediationPlan?.stop?.code, 'operator-closed-pr');
  assert.match(stopped.remediationPlan?.stop?.reason, /reaped: pr 4988 is CLOSED/);
  assert.equal(stopped.remediationWorker?.prClosedAt, '2026-08-06T05:01:49.000Z');
});

test('reaper: pending job whose PR is OPEN is left untouched', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'pending', { prNumber: 5000 });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveOpen,
  });
  assert.equal(result.reaped, 0);
  assert.equal(result.skippedOpen, 1);
  assert.equal(existsSync(jobPath), true, 'open-PR pending job untouched');
  assert.equal(countInDir(rootDir, 'stopped'), 0);
});

test('reaper: unreadable PR state (null lookup) leaves the job untouched (fail-closed)', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'pending', { prNumber: 5001 });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => null,
  });
  assert.equal(result.reaped, 0);
  assert.equal(result.skippedUnreadable, 1);
  assert.equal(existsSync(jobPath), true, 'job untouched when state unreadable');
});

test('reaper: a mirror-only merged state is NOT definitive and is left untouched', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'pending', { prNumber: 5002 });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => ({ source: 'mirror', prState: 'merged', mergedAt: 'x', closedAt: null }),
  });
  assert.equal(result.reaped, 0);
  assert.equal(result.skippedUnreadable, 1);
  assert.equal(existsSync(jobPath), true, 'mirror-only merged left untouched');
});

test('reaper: a resolver that throws is caught and leaves the job untouched', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'pending', { prNumber: 5003 });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => { throw new Error('gh boom'); },
    log: { log: () => {}, warn: () => {}, error: () => {} },
  });
  assert.equal(result.reaped, 0);
  assert.equal(result.skippedUnreadable, 1);
  assert.equal(existsSync(jobPath), true);
});

test('reaper: failed job whose PR is MERGED is reaped', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'failed', { prNumber: 4981, status: 'failed' });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveMerged,
  });
  assert.equal(result.reaped, 1);
  assert.equal(existsSync(jobPath), false, 'failed file removed');
  const stopped = readJobAtPath(stoppedPathFor(rootDir, jobPath));
  assert.equal(stopped.remediationPlan?.stop?.code, 'operator-merged-pr');
  assert.equal(stopped.remediationWorker?.reapedFromStatus, 'failed');
});

// ---- (B1) in-progress orphans ----

test('reaper: orphaned in-progress claim (dead worker, merged PR) is released', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'inProgress', {
    prNumber: 4985,
    status: 'in_progress',
    remediationWorker: { model: 'codex', state: 'spawned', processId: 99999 },
  });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveMerged,
    isWorkerAlive: () => false,
  });
  assert.equal(result.released, 1);
  assert.equal(result.reaped, 0);
  assert.equal(result.skippedAliveWorker, 0);
  assert.deepEqual(result.releasedPrs, [
    { repo: 'laceyenterprises/agent-os', prNumber: 4985, prState: 'merged', fromStatus: 'in_progress' },
  ]);
  assert.equal(existsSync(jobPath), false, 'in-progress file released');
  const stopped = readJobAtPath(stoppedPathFor(rootDir, jobPath));
  assert.equal(stopped.remediationPlan?.stop?.code, 'operator-merged-pr');
});

test('reaper: in-progress claim with a LIVE worker is never released, even on a merged PR', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'inProgress', {
    prNumber: 4986,
    status: 'in_progress',
    remediationWorker: { model: 'codex', state: 'spawned', processId: 4242 },
  });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveMerged,
    isWorkerAlive: (pid) => pid === 4242,
  });
  assert.equal(result.released, 0);
  assert.equal(result.skippedAliveWorker, 1);
  assert.equal(existsSync(jobPath), true, 'live-worker claim untouched');
});

test('reaper: without an isWorkerAlive probe, in-progress claims are not considered', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'inProgress', {
    prNumber: 4987,
    status: 'in_progress',
    remediationWorker: { model: 'codex', state: 'spawned', processId: 1234 },
  });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveMerged,
  });
  assert.equal(result.scanned, 0, 'in-progress not scanned without a liveness probe');
  assert.equal(result.released, 0);
  assert.equal(existsSync(jobPath), true);
});

test('reaper: liveness-probe error is treated as alive (never reaps an unproven-dead worker)', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'inProgress', {
    prNumber: 4990,
    status: 'in_progress',
    remediationWorker: { model: 'codex', state: 'spawned', processId: 777 },
  });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveMerged,
    isWorkerAlive: () => { throw new Error('kill probe failed'); },
    log: { log: () => {}, warn: () => {} },
  });
  assert.equal(result.released, 0);
  assert.equal(result.skippedAliveWorker, 1);
  assert.equal(existsSync(jobPath), true);
});

test('reaper: HQ-dispatched in-progress jobs are exempt', async () => {
  const rootDir = makeRoot();
  const { jobPath } = seedJob(rootDir, 'inProgress', {
    prNumber: 4991,
    status: 'in_progress',
    remediationWorker: { model: 'codex', state: 'spawned', dispatchMode: 'hq' },
  });
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveMerged,
    isWorkerAlive: () => false,
  });
  assert.equal(result.released, 0);
  assert.equal(result.skippedAliveWorker, 1);
  assert.equal(existsSync(jobPath), true);
});

// ---- (B2) AMA closer dispatch reservations (the current-main wedge) ----

function makeAmaImpls(records) {
  const updates = [];
  const listActiveAmaCloserDispatchesImpl = () => records.map((r) => ({ ...r }));
  const updateAmaCloserDispatchRecordImpl = (rootDir, identity, mutate) => {
    const match = records.find(
      (r) => r.repo === identity.repo && r.prNumber === identity.prNumber && (r.headSha || null) === (identity.headSha || null)
    );
    const next = mutate(match ? { ...match } : null);
    updates.push({ identity, next });
    return next;
  };
  return { listActiveAmaCloserDispatchesImpl, updateAmaCloserDispatchRecordImpl, updates };
}

test('reaper: orphaned AMA closer dispatch for a MERGED PR is terminalized to succeeded', async () => {
  const rootDir = makeRoot();
  const ama = makeAmaImpls([
    { repo: 'laceyenterprises/agent-os', prNumber: 4999, headSha: 'abc123', state: 'dispatched', lastObservedStatus: 'running', lastObservedAt: '2026-08-06T05:00:00.000Z' },
  ]);
  const logs = [];
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    now: () => '2026-08-06T06:00:00.000Z', // 60m after lastObservedAt => stale
    resolvePRLifecycleImpl: async () => liveMerged,
    listActiveAmaCloserDispatchesImpl: ama.listActiveAmaCloserDispatchesImpl,
    updateAmaCloserDispatchRecordImpl: ama.updateAmaCloserDispatchRecordImpl,
    log: { log: (m) => logs.push(m), warn: () => {} },
  });

  assert.equal(result.amaScanned, 1);
  assert.equal(result.amaReleased, 1);
  assert.equal(result.skippedFreshAmaDispatch, 0);
  assert.deepEqual(result.amaReleasedPrs, [
    { repo: 'laceyenterprises/agent-os', prNumber: 4999, prState: 'merged', terminalStatus: 'succeeded' },
  ]);
  assert.equal(ama.updates.length, 1);
  assert.equal(ama.updates[0].next.lastObservedStatus, 'succeeded');
  assert.equal(ama.updates[0].next.reapedByFollowUpReaper, true);
  assert.equal(ama.updates[0].next.reapReason, 'operator-merged-pr');
  assert.deepEqual(ama.updates[0].identity, { repo: 'laceyenterprises/agent-os', prNumber: 4999, headSha: 'abc123' });
  assert.ok(logs.some((m) => /reaped-ama-closer-dispatch/.test(m)));
});

test('reaper: orphaned AMA closer dispatch for a CLOSED PR is terminalized to failed-without-merge', async () => {
  const rootDir = makeRoot();
  const ama = makeAmaImpls([
    { repo: 'laceyenterprises/agent-os', prNumber: 4994, headSha: 'def456', state: 'dispatched', lastObservedStatus: 'stalled', lastObservedAt: '2026-08-06T05:00:00.000Z' },
  ]);
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    now: () => '2026-08-06T06:00:00.000Z',
    resolvePRLifecycleImpl: async () => liveClosed,
    listActiveAmaCloserDispatchesImpl: ama.listActiveAmaCloserDispatchesImpl,
    updateAmaCloserDispatchRecordImpl: ama.updateAmaCloserDispatchRecordImpl,
  });
  assert.equal(result.amaReleased, 1);
  assert.equal(ama.updates[0].next.lastObservedStatus, 'failed-without-merge');
  assert.equal(ama.updates[0].next.reapReason, 'operator-closed-pr');
});

test('reaper: a FRESH AMA closer dispatch on a merged PR is NOT terminalized (safety window)', async () => {
  const rootDir = makeRoot();
  const ama = makeAmaImpls([
    { repo: 'laceyenterprises/agent-os', prNumber: 4998, headSha: 'fff000', state: 'dispatched', lastObservedStatus: 'running', lastObservedAt: '2026-08-06T05:59:00.000Z' }, // 1m old => fresh
  ]);
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    now: () => '2026-08-06T06:00:00.000Z',
    resolvePRLifecycleImpl: async () => liveMerged,
    listActiveAmaCloserDispatchesImpl: ama.listActiveAmaCloserDispatchesImpl,
    updateAmaCloserDispatchRecordImpl: ama.updateAmaCloserDispatchRecordImpl,
  });
  assert.equal(result.amaScanned, 1);
  assert.equal(result.amaReleased, 0);
  assert.equal(result.skippedFreshAmaDispatch, 1);
  assert.equal(ama.updates.length, 0, 'no mutation on a fresh dispatch');
});

test('reaper: an AMA closer dispatch on an OPEN PR is left untouched', async () => {
  const rootDir = makeRoot();
  const ama = makeAmaImpls([
    { repo: 'laceyenterprises/agent-os', prNumber: 4997, headSha: 'aaa111', state: 'dispatched', lastObservedStatus: 'running', lastObservedAt: '2026-08-06T05:00:00.000Z' },
  ]);
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    now: () => '2026-08-06T06:00:00.000Z',
    resolvePRLifecycleImpl: async () => liveOpen,
    listActiveAmaCloserDispatchesImpl: ama.listActiveAmaCloserDispatchesImpl,
    updateAmaCloserDispatchRecordImpl: ama.updateAmaCloserDispatchRecordImpl,
  });
  assert.equal(result.amaReleased, 0);
  assert.equal(result.skippedOpen, 1);
  assert.equal(ama.updates.length, 0);
});

test('reaper: AMA reconciliation is skipped when the AMA impls are not injected', async () => {
  const rootDir = makeRoot();
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async () => liveMerged,
  });
  assert.equal(result.amaScanned, 0);
  assert.equal(result.amaReleased, 0);
});

test('reaper: in-progress orphan AND its AMA closer dispatch share one PR lookup', async () => {
  const rootDir = makeRoot();
  seedJob(rootDir, 'inProgress', {
    prNumber: 4971,
    status: 'in_progress',
    remediationWorker: { model: 'codex', state: 'spawned', processId: 5 },
  });
  const ama = makeAmaImpls([
    { repo: 'laceyenterprises/agent-os', prNumber: 4971, headSha: 'sha4971', state: 'dispatched', lastObservedStatus: 'running', lastObservedAt: '2026-08-06T05:00:00.000Z' },
  ]);
  let lookups = 0;
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    now: () => '2026-08-06T06:00:00.000Z',
    resolvePRLifecycleImpl: async () => { lookups += 1; return liveMerged; },
    isWorkerAlive: () => false,
    listActiveAmaCloserDispatchesImpl: ama.listActiveAmaCloserDispatchesImpl,
    updateAmaCloserDispatchRecordImpl: ama.updateAmaCloserDispatchRecordImpl,
  });
  assert.equal(lookups, 1, 'one shared live lookup for repo#4971');
  assert.equal(result.released, 1);
  assert.equal(result.amaReleased, 1);
});

// ---- idempotency / cap / log summary / env ----

test('reaper: is idempotent — a second pass reaps nothing', async () => {
  const rootDir = makeRoot();
  seedJob(rootDir, 'pending', { prNumber: 4994 });
  const opts = { rootDir, resolvePRLifecycleImpl: async () => liveMerged };
  const first = await reapFinishedPrFollowUpJobs(opts);
  assert.equal(first.reaped, 1);
  const second = await reapFinishedPrFollowUpJobs(opts);
  assert.equal(second.scanned, 0, 'nothing left in pending/failed');
  assert.equal(second.reaped, 0);
  assert.equal(countInDir(rootDir, 'stopped'), 1);
});

test('reaper: dedups by PR and caps distinct GitHub lookups per tick', async () => {
  const rootDir = makeRoot();
  seedJob(rootDir, 'pending', { jobId: 'j-100a', prNumber: 100 });
  seedJob(rootDir, 'pending', { jobId: 'j-100b', prNumber: 100 });
  seedJob(rootDir, 'pending', { jobId: 'j-200', prNumber: 200 });
  seedJob(rootDir, 'pending', { jobId: 'j-300', prNumber: 300 });

  let lookups = 0;
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    maxPrLookups: 2,
    resolvePRLifecycleImpl: async () => { lookups += 1; return liveMerged; },
    log: { log: () => {}, warn: () => {} },
  });

  assert.equal(lookups, 2, 'only 2 distinct PR lookups performed');
  assert.equal(result.prLookups, 2);
  assert.equal(result.lookupCapHit, true);
  assert.equal(result.reaped, 3); // PR100 (x2) + PR200
  assert.equal(result.skippedCapped, 1); // PR300 deferred
});

test('reaper: log summary reports the per-tick counts', async () => {
  const rootDir = makeRoot();
  seedJob(rootDir, 'pending', { jobId: 'm1', prNumber: 700 }); // merged
  seedJob(rootDir, 'pending', { jobId: 'o1', prNumber: 800 }); // open
  const byPr = { 700: liveMerged, 800: liveOpen };
  const result = await reapFinishedPrFollowUpJobs({
    rootDir,
    resolvePRLifecycleImpl: async (_root, { prNumber }) => byPr[prNumber],
  });
  assert.equal(result.scanned, 2);
  assert.equal(result.reaped, 1);
  assert.equal(result.skippedOpen, 1);
  assert.equal(result.prLookups, 2);
  assert.equal(result.reapedPrs.length, 1);
  assert.equal(result.reapedPrs[0].prNumber, 700);
});

test('resolveReapMaxPrLookups honors the env override and rejects junk', () => {
  assert.equal(resolveReapMaxPrLookups({}), DEFAULT_REAP_MAX_PR_LOOKUPS);
  assert.equal(resolveReapMaxPrLookups({ [REAP_MAX_PR_LOOKUPS_ENV]: '5' }), 5);
  assert.equal(resolveReapMaxPrLookups({ [REAP_MAX_PR_LOOKUPS_ENV]: 'nope' }), DEFAULT_REAP_MAX_PR_LOOKUPS);
  assert.equal(resolveReapMaxPrLookups({ [REAP_MAX_PR_LOOKUPS_ENV]: '-1' }), DEFAULT_REAP_MAX_PR_LOOKUPS);
});

test('resolveReapAmaCloserMinStaleMs honors the env override and rejects junk', () => {
  assert.equal(resolveReapAmaCloserMinStaleMs({}), 30 * 60 * 1000);
  assert.equal(resolveReapAmaCloserMinStaleMs({ [REAP_AMA_CLOSER_MIN_STALE_MS_ENV]: '0' }), 0);
  assert.equal(resolveReapAmaCloserMinStaleMs({ [REAP_AMA_CLOSER_MIN_STALE_MS_ENV]: '120000' }), 120000);
  assert.equal(resolveReapAmaCloserMinStaleMs({ [REAP_AMA_CLOSER_MIN_STALE_MS_ENV]: 'nope' }), 30 * 60 * 1000);
});
