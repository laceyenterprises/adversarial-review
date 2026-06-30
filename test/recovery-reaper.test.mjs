import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_STALE_CLOSER_LEASE_MS,
  DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS,
  reapStaleCloserLeases,
  reapStaleRunningReviewerPasses,
  resolveStaleCloserLeaseMs,
  resolveStaleRunningReviewerPassMs,
  runStartupStaleStateReaper,
  selectReleasableCloserLeases,
  selectStaleRunningReviewerPasses,
} from '../src/recovery-reaper.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-closer.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'reaper-'));
}

const NOW = '2026-06-29T12:00:00Z';
function hoursAgo(n) {
  return new Date(Date.parse(NOW) - n * 60 * 60 * 1000).toISOString();
}

function writeLease(rootDir, lease) {
  const dir = join(rootDir, 'data', 'ama-closer-leases');
  mkdirSync(dir, { recursive: true });
  const safeRepo = String(lease.repo).replace(/\//g, '__').replace(/[^A-Za-z0-9._-]/g, '-');
  const path = join(dir, `${safeRepo}-pr-${lease.prNumber}-${lease.headSha}.json`);
  writeFileSync(path, `${JSON.stringify(lease, null, 2)}\n`);
  return path;
}

// ---------------------------------------------------------------------------
// Config resolvers + env aliases
// ---------------------------------------------------------------------------

test('config resolvers honor env aliases and fall back to defaults', () => {
  assert.equal(resolveStaleRunningReviewerPassMs({}), DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS);
  assert.equal(resolveStaleCloserLeaseMs({}), DEFAULT_STALE_CLOSER_LEASE_MS);
  assert.equal(
    resolveStaleRunningReviewerPassMs({ ADVERSARIAL_STALE_RUNNING_REVIEWER_PASS_MS: '900000' }),
    900000,
  );
  assert.equal(
    resolveStaleCloserLeaseMs({ ADVERSARIAL_STALE_CLOSER_LEASE_MS: '123456' }),
    123456,
  );
  // Invalid values fall back, never throw.
  assert.equal(
    resolveStaleRunningReviewerPassMs({ ADVERSARIAL_STALE_RUNNING_REVIEWER_PASS_MS: 'nope' }),
    DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS,
  );
  assert.equal(
    resolveStaleCloserLeaseMs({ ADVERSARIAL_STALE_CLOSER_LEASE_MS: '-5' }),
    DEFAULT_STALE_CLOSER_LEASE_MS,
  );
});

// ---------------------------------------------------------------------------
// Pure: selectStaleRunningReviewerPasses
// ---------------------------------------------------------------------------

test('selectStaleRunningReviewerPasses: only running + un-ended + aged rows', () => {
  const rows = [
    { pass_id: 1, status: 'running', ended_at: null, started_at: hoursAgo(20) }, // stale
    { pass_id: 2, status: 'running', ended_at: null, started_at: hoursAgo(1) }, // fresh
    { pass_id: 3, status: 'completed', ended_at: hoursAgo(20), started_at: hoursAgo(21) }, // done
    { pass_id: 4, status: 'running', ended_at: hoursAgo(19), started_at: hoursAgo(20) }, // has ended_at
    { pass_id: 5, status: 'running', ended_at: null, started_at: 'not-a-date' }, // unparseable -> skip
  ];
  const stale = selectStaleRunningReviewerPasses(rows, { now: NOW, thresholdMs: 6 * 60 * 60 * 1000 });
  assert.deepEqual(stale.map((r) => r.pass_id), [1]);
});

// ---------------------------------------------------------------------------
// DB driver: reapStaleRunningReviewerPasses
// ---------------------------------------------------------------------------

test('reapStaleRunningReviewerPasses marks aged running passes abandoned (re-review unblocked)', (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => db.close());

  // Stale zombie running pass (started 20h ago, never ended).
  beginReviewerPass(rootDir, {
    repo: 'acme/zombie', prNumber: 10, attemptNumber: 1, reviewerClass: 'codex',
    passKind: 'first-pass', startedAt: hoursAgo(20),
  });
  // Fresh running pass (must be left alone).
  beginReviewerPass(rootDir, {
    repo: 'acme/fresh', prNumber: 11, attemptNumber: 1, reviewerClass: 'codex',
    passKind: 'first-pass', startedAt: hoursAgo(1),
  });
  // Already-completed pass (untouched).
  beginReviewerPass(rootDir, {
    repo: 'acme/done', prNumber: 12, attemptNumber: 1, reviewerClass: 'codex',
    passKind: 'first-pass', startedAt: hoursAgo(30),
  });
  completeReviewerPass(rootDir, {
    repo: 'acme/done', prNumber: 12, attemptNumber: 1, passKind: 'first-pass',
    status: 'completed', endedAt: hoursAgo(29),
  });

  const result = reapStaleRunningReviewerPasses({
    db, now: NOW, thresholdMs: 6 * 60 * 60 * 1000, logger: { warn() {} },
  });
  assert.equal(result.reaped, 1);

  const rows = db.prepare('SELECT repo, status, ended_at FROM reviewer_passes ORDER BY repo').all();
  const byRepo = Object.fromEntries(rows.map((r) => [r.repo, r]));
  assert.equal(byRepo['acme/zombie'].status, 'abandoned');
  assert.ok(byRepo['acme/zombie'].ended_at, 'reaped pass gets an ended_at');
  assert.equal(byRepo['acme/fresh'].status, 'running', 'fresh pass untouched');
  assert.equal(byRepo['acme/done'].status, 'completed', 'completed pass untouched');
});

// ---------------------------------------------------------------------------
// Pure: selectReleasableCloserLeases
// ---------------------------------------------------------------------------

test('selectReleasableCloserLeases: aged non-terminal leases, never live or terminal', () => {
  const leases = [
    { repo: 'a/x', prNumber: 1, headSha: 'h1', status: 'dispatched', terminalOutcome: null, updatedAt: hoursAgo(20), watcherPid: 111, _path: 'p1' }, // release
    { repo: 'a/y', prNumber: 2, headSha: 'h2', status: 'pending', terminalOutcome: null, updatedAt: hoursAgo(1), watcherPid: 222, _path: 'p2' }, // fresh -> keep
    { repo: 'a/z', prNumber: 3, headSha: 'h3', status: 'terminal', terminalOutcome: 'succeeded', updatedAt: hoursAgo(40), watcherPid: 333, _path: 'p3' }, // terminal -> keep
    { repo: 'a/w', prNumber: 4, headSha: 'h4', status: 'dispatched', terminalOutcome: null, updatedAt: hoursAgo(40), watcherPid: 999, _path: 'p4' }, // owned by live pid -> keep
  ];
  const releasable = selectReleasableCloserLeases(leases, {
    now: NOW, thresholdMs: 6 * 60 * 60 * 1000, livePid: 999,
  });
  assert.deepEqual(releasable.map((l) => l._path), ['p1']);
});

test('selectReleasableCloserLeases: below-threshold lease released only when owning process is dead', () => {
  const lease = { repo: 'a/x', prNumber: 1, headSha: 'h1', status: 'dispatched', terminalOutcome: null, updatedAt: hoursAgo(1), watcherPid: 4242, _path: 'p1' };
  const keepAlive = selectReleasableCloserLeases([lease], {
    now: NOW, thresholdMs: 6 * 60 * 60 * 1000, isProcessAlive: () => true,
  });
  assert.equal(keepAlive.length, 0, 'live owner -> not released below threshold');
  const dead = selectReleasableCloserLeases([lease], {
    now: NOW, thresholdMs: 6 * 60 * 60 * 1000, isProcessAlive: () => false,
  });
  assert.equal(dead.length, 1, 'dead owner -> released even below threshold');
});

test('selectReleasableCloserLeases: corrupt lease records are always releasable', () => {
  const releasable = selectReleasableCloserLeases([
    { _path: 'bad.json', _isCorrupt: true, status: 'corrupt', terminalOutcome: null },
  ], {
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    livePid: process.pid,
    isProcessAlive: () => true,
  });
  assert.deepEqual(releasable.map((l) => l._path), ['bad.json']);
});

// ---------------------------------------------------------------------------
// FS driver: reapStaleCloserLeases + transient-exhausted budget reset
// ---------------------------------------------------------------------------

test('reapStaleCloserLeases releases stale lease AND resets transient-exhausted budget', (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const identity = { repo: 'acme/repo', prNumber: 77, headSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' };
  const leasePath = writeLease(rootDir, {
    ...identity, status: 'dispatched', terminalOutcome: null,
    acquiredAt: hoursAgo(20), updatedAt: hoursAgo(20), watcherPid: 31337,
  });

  // A dispatch record whose budget was exhausted by a TRANSIENT (rate-limit) failure.
  const recordPath = amaCloserDispatchFilePath(rootDir, identity);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify({
    ...identity, retryCount: 2, state: 'dispatch-deferred-transient',
    lastFailureTransient: true,
    lastError: 'gh: API rate limit exceeded (HTTP 403)',
  }, null, 2)}\n`);

  const result = reapStaleCloserLeases({
    rootDir, now: NOW, thresholdMs: 6 * 60 * 60 * 1000, logger: { warn() {}, error() {} },
  });
  assert.equal(result.released, 1);
  assert.equal(result.budgetsReset, 1);
  assert.equal(existsSync(leasePath), false, 'stale lease deleted -> closer can re-dispatch');

  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.retryCount, 0, 'transient-exhausted budget reset to 0 on recovery');
});

test('reapStaleCloserLeases does NOT reset a budget exhausted by a genuine (non-transient) failure', (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const identity = { repo: 'acme/repo', prNumber: 88, headSha: 'feedfacefeedfacefeedfacefeedfacefeedface' };
  writeLease(rootDir, {
    ...identity, status: 'dispatched', terminalOutcome: null,
    acquiredAt: hoursAgo(20), updatedAt: hoursAgo(20), watcherPid: 31337,
  });
  const recordPath = amaCloserDispatchFilePath(rootDir, identity);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify({
    ...identity, retryCount: 2, state: 'dispatch-failed',
    lastFailureTransient: false,
    lastError: 'fatal: worker provision failed: merge conflict in closer',
  }, null, 2)}\n`);

  const result = reapStaleCloserLeases({
    rootDir, now: NOW, thresholdMs: 6 * 60 * 60 * 1000, logger: { warn() {}, error() {} },
  });
  assert.equal(result.released, 1, 'lease is still released (re-dispatch can re-evaluate)');
  assert.equal(result.budgetsReset, 0, 'genuine-failure budget preserved');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.retryCount, 2, 'genuine-failure budget NOT reset');
});

test('reapStaleCloserLeases unlinks corrupt lease files', (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const dir = join(rootDir, 'data', 'ama-closer-leases');
  mkdirSync(dir, { recursive: true });
  const corruptPath = join(dir, 'acme__repo-pr-99-deadbeef.json');
  writeFileSync(corruptPath, '');

  const result = reapStaleCloserLeases({
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    isProcessAlive: () => true,
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.released, 1);
  assert.equal(result.budgetsReset, 0);
  assert.equal(result.leases[0]._isCorrupt, true);
  assert.equal(existsSync(corruptPath), false, 'corrupt lease deleted -> closer can re-dispatch');
});

// ---------------------------------------------------------------------------
// Orchestrator never throws
// ---------------------------------------------------------------------------

test('runStartupStaleStateReaper is fail-safe and returns a summary', (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  // No leases dir, no passes -> must not throw.
  const out = runStartupStaleStateReaper({ rootDir, db, env: {}, now: NOW, logger: { warn() {}, error() {}, log() {} } });
  assert.equal(out.reviewerPasses.reaped, 0);
  assert.equal(out.closerLeases.released, 0);
});
