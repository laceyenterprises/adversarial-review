import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readReviewerBurstLease,
  requestReviewerBurstLease,
  revokeReviewerBurstLease,
} from '../src/reviewer-burst-lease.mjs';
import { runBoundedReviewerDispatchQueue } from '../src/watcher-reviewer-pool.mjs';

const safe = { quotaSafe: true, postingSafe: true, reviewerHealthy: true };
const at = (iso) => () => new Date(iso);
const root = () => mkdtempSync(join(tmpdir(), 'reviewer-burst-'));

function request(rootDir, overrides = {}) {
  return requestReviewerBurstLease({
    rootDir,
    ttlMs: 10 * 60_000,
    additionalSlots: 2,
    eligibleRepos: ['acme/widgets'],
    budgetSlotMinutes: 20,
    reason: 'urgent demo',
    requestedBy: 'operator@example.com',
    safety: safe,
    now: at('2026-09-20T10:00:00.000Z'),
    ...overrides,
  });
}

test('safe burst lease activates and is visible', () => {
  const rootDir = root();
  const lease = request(rootDir);
  assert.equal(lease.state, 'active');
  assert.equal(readReviewerBurstLease(rootDir, { now: at('2026-09-20T10:05:00.000Z') }).additionalSlots, 2);
});

test('burst lease expires automatically and emits expiry once', () => {
  const rootDir = root();
  request(rootDir);
  assert.equal(readReviewerBurstLease(rootDir, { now: at('2026-09-20T10:11:00.000Z') }).state, 'expired');
  assert.equal(readReviewerBurstLease(rootDir, { now: at('2026-09-20T10:12:00.000Z') }).state, 'expired');
  const events = readFileSync(join(rootDir, 'data/reviewer-capacity/burst-events.jsonl'), 'utf8');
  assert.equal(events.match(/reviewer_burst_expired/g)?.length, 1);
});

test('active burst lease can be manually revoked', () => {
  const rootDir = root();
  request(rootDir);
  const revoked = revokeReviewerBurstLease(rootDir, { revokedBy: 'ops', reason: 'demo complete', now: at('2026-09-20T10:02:00.000Z') });
  assert.equal(revoked.state, 'revoked');
  assert.equal(readReviewerBurstLease(rootDir).state, 'revoked');
});

test('duplicate lease request atomically supersedes the active lease', () => {
  const rootDir = root();
  const first = request(rootDir);
  const second = request(rootDir, { additionalSlots: 1, budgetSlotMinutes: 10, now: at('2026-09-20T10:01:00.000Z') });
  assert.equal(second.supersedesRequestId, first.requestId);
  assert.equal(readReviewerBurstLease(rootDir).requestId, second.requestId);
});

test('unsafe quota refuses burst activation', () => {
  const denied = request(root(), { safety: { ...safe, quotaSafe: false } });
  assert.equal(denied.state, 'denied');
  assert.match(denied.denialReason, /quota/);
});

test('denied duplicate update leaves an active lease in force', () => {
  const rootDir = root();
  const active = request(rootDir);
  assert.equal(request(rootDir, { safety: { ...safe, postingSafe: false } }).state, 'denied');
  assert.equal(readReviewerBurstLease(rootDir).requestId, active.requestId);
});

test('pack-scoped burst slots admit only matching candidates above steady state', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = [];
  const candidate = (prNumber, packId) => ({
    repoPath: 'acme/widgets', prNumber, packId, subject: { createdAt: `2026-09-20T10:00:0${prNumber}.000Z` },
    run: async () => { started.push(prNumber); await gate; },
  });
  const activeReviewerCounts = new Map([['__total__', 1]]);
  const run = runBoundedReviewerDispatchQueue([candidate(1, 'other'), candidate(2, 'pack-7')], {
    maxConcurrent: 1,
    activeReviewerCounts,
    burstLease: { state: 'active', additionalSlots: 1, eligibleRepos: ['acme/widgets'], activePack: 'pack-7' },
    singleWave: true,
    singleWaveSettleGraceMs: 0,
    logger: { log() {}, warn() {}, error() {} },
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const result = await run;
  assert.deepEqual(started, [2]);
  assert.equal(result.deferredCandidates[0].prNumber, 1);
});

test('no lease preserves the steady-state concurrency default', async () => {
  const started = [];
  const saturated = new Map([['__total__', 1]]);
  const result = await runBoundedReviewerDispatchQueue([{
    repoPath: 'acme/widgets', prNumber: 1, subject: { createdAt: '2026-09-20T10:00:00.000Z' }, run: async () => started.push(1),
  }], { maxConcurrent: 1, activeReviewerCounts: saturated, logger: { log() {}, warn() {}, error() {} } });
  assert.deepEqual(started, []);
  assert.equal(result.deferredReasons[0].reason, 'reviewer-pool-saturated');
});
