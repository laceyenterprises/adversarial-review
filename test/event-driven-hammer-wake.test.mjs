import './helpers/rate-limit-state-isolation.mjs';
import { openReviewStateDb, ensureReviewStateSchema } from '../src/review-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hammerWakeAuditDir,
  hammerWakeAuditPath,
  requestEligibleHammerWake,
  scheduleHammerWakeAuditSweep,
  sweepHammerWakeAudits,
} from '../src/hammer-wake.mjs';
import { matrixPair, HEAD } from './helpers/next-action-matrix.mjs';
import { collectReviewPipelineHealth } from '../src/review-pipeline-health.mjs';

const identity = {
  repo: 'subject-07',
  prNumber: 7,
  headSha: HEAD,
  eligibilityReason: 'shared-next-action',
  wakeAttemptKey: 'initial',
};

function root() {
  return mkdtempSync(join(tmpdir(), 'hammer-wake-'));
}

function wakeImpl(calls) {
  return (args) => {
    calls.push(args);
    return { requested: true, payload: { request_id: 'wake-1', requested_at: args.requestedAt } };
  };
}

test('clean current-head eligible verdict wakes the existing AMA watcher route', () => {
  const rootDir = root();
  const calls = [];
  const result = requestEligibleHammerWake({
    rootDir,
    ...identity,
    shared: matrixPair(),
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });
  assert.equal(result.outcome, 'requested');
  assert.equal(result.route, 'watcher-ama-merge-authority');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headSha, identity.headSha);
  const audit = JSON.parse(readFileSync(hammerWakeAuditPath(rootDir, identity), 'utf8'));
  assert.equal(audit.outcome, 'requested');
  const health = collectReviewPipelineHealth({ rootDir, config: { hostChecksEnabled: false } });
  assert.equal(health.hammerWakes.recent[0].headSha, identity.headSha);
});

test('not-yet-eligible snapshot skips without creating a wake reservation', () => {
  const calls = [];
  const result = requestEligibleHammerWake({
    rootDir: root(),
    ...identity,
    shared: matrixPair({ checks: { conclusion: 'PENDING' } }),
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.reason, 'checks-pending');
  assert.equal(calls.length, 0);
});

test('duplicate wake key does not start a second close-lane race', () => {
  const rootDir = root();
  const calls = [];
  const args = {
    rootDir,
    ...identity,
    shared: matrixPair(),
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  };
  assert.equal(requestEligibleHammerWake(args).outcome, 'requested');
  assert.equal(requestEligibleHammerWake(args).outcome, 'duplicate');
  assert.equal(calls.length, 1);
});

test('latency telemetry failure does not demote a delivered wake', () => {
  const rootDir = root();
  mkdirSync(join(rootDir, 'data', 'reviews.db'), { recursive: true });
  const calls = [];
  const args = {
    rootDir,
    ...identity,
    shared: matrixPair(),
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {}, warn() {} },
  };

  const requested = requestEligibleHammerWake(args);
  const duplicate = requestEligibleHammerWake(args);
  const audit = JSON.parse(readFileSync(hammerWakeAuditPath(rootDir, identity), 'utf8'));

  assert.equal(requested.outcome, 'requested');
  assert.equal(requested.latencyEvent.recorded, false);
  assert.equal(requested.latencyEvent.reason, 'latency-event-failed');
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(calls.length, 1);
  assert.equal(audit.outcome, 'requested');
  assert.equal(audit.latencyEvent.recorded, false);
});

test('audit directory failure returns a failed event instead of throwing', () => {
  const rootDir = root();
  writeFileSync(join(rootDir, 'data'), 'not a directory\n');
  const calls = [];

  const result = requestEligibleHammerWake({
    rootDir,
    ...identity,
    shared: matrixPair(),
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });

  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'wake-audit-dir-unavailable');
  assert.equal(calls.length, 0);
});

test('merge-rule refusal does not wake Hammer', () => {
  const calls = [];
  const result = requestEligibleHammerWake({
    rootDir: root(),
    ...identity,
    shared: matrixPair({ controls: { safetyRefusal: { deterministic: true, reason: 'protection-07' } } }),
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });
  assert.equal(result.outcome, 'skipped');
  assert.equal(result.reason, 'safety-refusal');
  assert.equal(calls.length, 0);
});

test('wake-path failure is retryable without allowing duplicate successful wakes', () => {
  const rootDir = root();
  const calls = [];
  const args = {
    rootDir,
    ...identity,
    shared: matrixPair(),
    log: { log() {} },
  };
  const failed = requestEligibleHammerWake({
    ...args,
    requestWatcherWakeImpl: () => {
      throw new Error('wake transport unavailable');
    },
  });
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.retryable, true);

  const retried = requestEligibleHammerWake({ ...args, requestWatcherWakeImpl: wakeImpl(calls) });
  const duplicate = requestEligibleHammerWake({ ...args, requestWatcherWakeImpl: wakeImpl(calls) });
  assert.equal(retried.outcome, 'requested');
  assert.equal(duplicate.outcome, 'duplicate');
  assert.equal(calls.length, 1);
});

test('stale reserved wake reservation is recovered by a later caller', () => {
  const rootDir = root();
  const calls = [];
  const dir = hammerWakeAuditDir(rootDir);
  const nowMs = Date.now();
  mkdirSync(dir, { recursive: true });
  writeFileSync(hammerWakeAuditPath(rootDir, identity), `${JSON.stringify({
    schemaVersion: 1,
    event: 'hammer_wake',
    ...identity,
    observedAt: new Date(nowMs - 11 * 60 * 1000).toISOString(),
    outcome: 'reserved',
    route: 'watcher-ama-merge-authority',
  }, null, 2)}\n`);

  const recovered = requestEligibleHammerWake({
    rootDir,
    ...identity,
    shared: matrixPair(),
    observedAt: new Date(nowMs).toISOString(),
    nowMs,
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });
  const audit = JSON.parse(readFileSync(hammerWakeAuditPath(rootDir, identity), 'utf8'));

  assert.equal(recovered.outcome, 'requested');
  assert.equal(audit.outcome, 'requested');
  assert.equal(calls.length, 1);
  assert.ok(readdirSync(dir).some((name) => name.includes('.retry-')));
});

test('malformed reservation time recovers from the audit file mtime', () => {
  const rootDir = root();
  const dir = hammerWakeAuditDir(rootDir);
  const nowMs = Date.now();
  mkdirSync(dir, { recursive: true });
  const path = hammerWakeAuditPath(rootDir, identity);
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    event: 'hammer_wake',
    ...identity,
    observedAt: 'invalid-time',
    outcome: 'reserved',
  })}\n`);
  const staleTime = new Date(nowMs - 11 * 60 * 1000);
  utimesSync(path, staleTime, staleTime);

  const calls = [];
  const recovered = requestEligibleHammerWake({
    rootDir,
    ...identity,
    shared: matrixPair(),
    nowMs,
    requestWatcherWakeImpl: wakeImpl(calls),
    log: { log() {} },
  });
  assert.equal(recovered.outcome, 'requested');
  assert.equal(calls.length, 1);
  assert.ok(readdirSync(dir).some((name) => name.includes('.retry-')));
});

test('retry archives remain inside the age and file-count retention bounds', async () => {
  const rootDir = root();
  const args = {
    rootDir,
    ...identity,
    shared: matrixPair(),
    requestWatcherWakeImpl: () => { throw new Error('watcher unavailable'); },
    log: { log() {} },
  };
  assert.equal(requestEligibleHammerWake(args).outcome, 'failed');
  assert.equal(requestEligibleHammerWake(args).outcome, 'failed');
  await scheduleHammerWakeAuditSweep(rootDir);
  const dir = hammerWakeAuditDir(rootDir);
  const archives = readdirSync(dir).filter((name) => name.includes('.retry-'));
  assert.ok(archives.length > 0);
  assert.ok(archives.every((name) => name.endsWith('.json')));
  const health = collectReviewPipelineHealth({ rootDir, config: { hostChecksEnabled: false } });
  assert.equal(health.hammerWakes.recent.length, 1);

  const oldTime = new Date('2026-01-01T00:00:00.000Z');
  for (const name of archives) utimesSync(join(dir, name), oldTime, oldTime);
  const swept = await sweepHammerWakeAudits(rootDir, {
    nowMs: Date.parse('2026-02-02T00:00:00.000Z'),
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
    maxFiles: 1,
  });
  assert.ok(swept.removed >= archives.length);
  assert.equal(readdirSync(dir).length, 1);

  for (let index = 0; index < 3; index += 1) {
    writeFileSync(join(dir, `manual.retry-${index}.json`), '{}\n');
  }
  const countBound = await sweepHammerWakeAudits(rootDir, { maxAgeMs: Infinity, maxFiles: 1 });
  assert.equal(countBound.removed, 3);
  assert.equal(countBound.retained, 1);
});

test('wake dispatch defers retention I/O and coalesces sweeps through the cooldown', async (t) => {
  const rootDir = root();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = hammerWakeAuditDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const expired = join(dir, 'expired.json');
  writeFileSync(expired, '{}\n');
  const oldTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(expired, oldTime, oldTime);
  const calls = [];
  const args = { rootDir, ...identity, shared: matrixPair(),
    requestWatcherWakeImpl: wakeImpl(calls), log: { log() {} } };

  assert.equal(requestEligibleHammerWake(args).outcome, 'requested');
  assert.ok(readdirSync(dir).includes('expired.json'), 'retention must not run inline');
  const sweep = scheduleHammerWakeAuditSweep(rootDir);
  assert.equal(requestEligibleHammerWake(args).outcome, 'duplicate');
  assert.equal(scheduleHammerWakeAuditSweep(rootDir), sweep, 'one sweep per root during a burst');
  await sweep;
  assert.ok(!readdirSync(dir).includes('expired.json'), 'deferred sweep removes expired audits');
  assert.equal(JSON.parse(readFileSync(hammerWakeAuditPath(rootDir, identity), 'utf8')).outcome, 'requested');
  assert.equal(scheduleHammerWakeAuditSweep(rootDir), sweep, 'completed sweep is throttled');
  assert.equal(calls.length, 1, 'maintenance preserves wake deduplication');
});

test('unreadable retention directory remains best effort', async () => {
  const rootDir = root();
  rmSync(rootDir, { recursive: true, force: true });
  assert.deepEqual(await scheduleHammerWakeAuditSweep(rootDir), { removed: 0, retained: null });
});

test('health surface parses only the newest hammer wake audit files', () => {
  const rootDir = root();
  const dir = hammerWakeAuditDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const oldTime = new Date('2026-01-01T00:00:00.000Z');
  const newTime = new Date('2026-01-02T00:00:00.000Z');

  for (let i = 0; i < 5; i += 1) {
    const path = join(dir, `old-${i}.json`);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      event: 'hammer_wake',
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: `old-${i}`,
      eligibilityReason: identity.eligibilityReason,
      observedAt: '2099-01-01T00:00:00.000Z',
      outcome: 'requested',
    })}\n`);
    utimesSync(path, oldTime, oldTime);
  }
  for (let i = 0; i < 20; i += 1) {
    const path = join(dir, `new-${i}.json`);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      event: 'hammer_wake',
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: `new-${i}`,
      eligibilityReason: identity.eligibilityReason,
      observedAt: `2026-01-02T00:00:${String(i).padStart(2, '0')}.000Z`,
      outcome: 'requested',
    })}\n`);
    utimesSync(path, newTime, newTime);
  }

  const health = collectReviewPipelineHealth({ rootDir, config: { hostChecksEnabled: false } });
  assert.equal(health.hammerWakes.recent.length, 20);
  assert.deepEqual(
    health.hammerWakes.recent.map((entry) => entry.headSha).filter((headSha) => headSha.startsWith('old-')),
    [],
  );
});

// Regression: the same trusted ancestry must cover ALL delta commits.
import { proveCloserOnlyHeadDelta } from '../src/head-closer-commit-suppression.mjs';

for (const scenario of ['own', 'worker', 'unrelated', 'budget']) {
  test(`HAMCIWAKE-01 ancestry: ${scenario}`, async () => {
    const parents = { H2: 'H1', H1: scenario === 'unrelated' ? 'other' : 'H0' };
    const proven = await proveCloserOnlyHeadDelta({ reviewedHead: 'H0', currentHead: 'H2',
      maxCommits: scenario === 'budget' ? 1 : 2,
      suppressionImpl: async ({ headSha }) => ({ suppressed: !(scenario === 'worker' && headSha === 'H1'), reason: 'closer-commit-trailer' }),
      fetchCommitImpl: async ({ headSha }) => ({ sha: headSha, parentSha: parents[headSha] }),
    });
    assert.equal(proven, scenario === 'own');
  });
}


test('wake telemetry borrows the initialized watcher connection without closing it or losing its receipt', t => {
  const rootDir = root();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const reviewStateDb = openReviewStateDb(rootDir);
  ensureReviewStateSchema(reviewStateDb);
  t.after(() => reviewStateDb.close());
  const args = { rootDir, reviewStateDb, repo: 'fixture/project', prNumber: 1,
    headSha: 'a'.repeat(40), eligibilityReason: 'shared-next-action', wakeAttemptKey: 'initial', shared: matrixPair(),
    requestWatcherWakeImpl: wakeImpl([]), log: { log() {} } };
  const result = requestEligibleHammerWake(args);
  assert.equal(result.outcome, 'requested');
  assert.equal(result.latencyEvent.recorded, true);
  assert.equal(requestEligibleHammerWake(args).outcome, 'duplicate');
  assert.equal(reviewStateDb.prepare(
    "SELECT COUNT(*) AS count FROM review_latency_events WHERE event_type = 'hammer_wake'"
  ).get().count, 1);
  assert.equal(JSON.parse(readFileSync(hammerWakeAuditPath(rootDir, args), 'utf8')).outcome, 'requested');
});
