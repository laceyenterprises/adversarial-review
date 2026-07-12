import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT,
  DEFAULT_CLOSER_LEASE_READ_LIMIT,
  DEFAULT_STALE_CLOSER_LEASE_MS,
  DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS,
  reapStaleCloserLeases,
  reapStaleRunningReviewerPasses,
  resolveCloserLeaseEntryScanLimit,
  resolveCloserLeaseReadLimit,
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

function makeOpendirSequence(pages, counters = []) {
  let callIndex = 0;
  return () => {
    const page = pages[Math.min(callIndex, pages.length - 1)] || [];
    callIndex += 1;
    let readIndex = 0;
    const counter = { reads: 0, closed: false };
    counters.push(counter);
    return {
      readSync() {
        counter.reads += 1;
        if (readIndex >= page.length) return null;
        const name = page[readIndex];
        readIndex += 1;
        return { name };
      },
      closeSync() {
        counter.closed = true;
      },
    };
  };
}

function makeOpendirFromListing(getNames, counters = []) {
  return () => {
    const page = [...getNames()];
    let readIndex = 0;
    const counter = { reads: 0, closed: false, page };
    counters.push(counter);
    return {
      readSync() {
        counter.reads += 1;
        if (readIndex >= page.length) return null;
        const name = page[readIndex];
        readIndex += 1;
        return { name };
      },
      closeSync() {
        counter.closed = true;
      },
    };
  };
}

function writeCloserLeaseCursor(rootDir, cursor) {
  const path = join(rootDir, 'data', 'recovery-reaper', 'closer-lease-cursor.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cursor, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Config resolvers + env aliases
// ---------------------------------------------------------------------------

test('config resolvers honor env aliases and fall back to defaults', () => {
  assert.equal(resolveStaleRunningReviewerPassMs({}), DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS);
  assert.equal(resolveStaleCloserLeaseMs({}), DEFAULT_STALE_CLOSER_LEASE_MS);
  assert.equal(resolveCloserLeaseEntryScanLimit({}), DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT);
  assert.equal(resolveCloserLeaseReadLimit({}), DEFAULT_CLOSER_LEASE_READ_LIMIT);
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
  assert.equal(
    resolveCloserLeaseEntryScanLimit({ ADVERSARIAL_STALE_CLOSER_LEASE_ENTRY_SCAN_LIMIT: '7' }),
    7,
  );
  assert.equal(
    resolveCloserLeaseReadLimit({ ADVERSARIAL_STALE_CLOSER_LEASE_READ_LIMIT: '3' }),
    3,
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

test('selectReleasableCloserLeases: below-threshold lease is retained even when local pid lookup fails', () => {
  const lease = { repo: 'a/x', prNumber: 1, headSha: 'h1', status: 'dispatched', terminalOutcome: null, updatedAt: hoursAgo(1), watcherPid: 4242, _path: 'p1' };
  const keepAlive = selectReleasableCloserLeases([lease], {
    now: NOW, thresholdMs: 6 * 60 * 60 * 1000, isProcessAlive: () => true,
  });
  assert.equal(keepAlive.length, 0, 'live owner -> not released below threshold');
  const dead = selectReleasableCloserLeases([lease], {
    now: NOW, thresholdMs: 6 * 60 * 60 * 1000, isProcessAlive: () => false,
  });
  assert.equal(dead.length, 0, 'local dead-pid result is ignored for cross-namespace leases');
});

test('selectReleasableCloserLeases: corrupt lease records are age-gated by file mtime', () => {
  const releasable = selectReleasableCloserLeases([
    { _path: 'fresh.json', _isCorrupt: true, mtimeMs: Date.parse(hoursAgo(1)), status: 'corrupt', terminalOutcome: null },
    { _path: 'stale.json', _isCorrupt: true, mtimeMs: Date.parse(hoursAgo(20)), status: 'corrupt', terminalOutcome: null },
  ], {
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    livePid: process.pid,
    isProcessAlive: () => true,
  });
  assert.deepEqual(releasable.map((l) => l._path), ['stale.json']);
});

// ---------------------------------------------------------------------------
// FS driver: reapStaleCloserLeases + transient-exhausted budget reset
// ---------------------------------------------------------------------------

test('reapStaleCloserLeases releases stale lease AND resets transient-exhausted budget', async (t) => {
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

  const result = await reapStaleCloserLeases({
    rootDir, now: NOW, thresholdMs: 6 * 60 * 60 * 1000, logger: { warn() {}, error() {} },
  });
  assert.equal(result.released, 1);
  assert.equal(result.budgetsReset, 1);
  assert.equal(existsSync(leasePath), false, 'stale lease deleted -> closer can re-dispatch');

  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.retryCount, 0, 'transient-exhausted budget reset to 0 on recovery');
});

test('reapStaleCloserLeases does NOT reset a budget exhausted by a genuine (non-transient) failure', async (t) => {
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

  const result = await reapStaleCloserLeases({
    rootDir, now: NOW, thresholdMs: 6 * 60 * 60 * 1000, logger: { warn() {}, error() {} },
  });
  assert.equal(result.released, 1, 'lease is still released (re-dispatch can re-evaluate)');
  assert.equal(result.budgetsReset, 0, 'genuine-failure budget preserved');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  assert.equal(record.retryCount, 2, 'genuine-failure budget NOT reset');
});

test('reapStaleCloserLeases unlinks corrupt lease files', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const dir = join(rootDir, 'data', 'ama-closer-leases');
  mkdirSync(dir, { recursive: true });
  const corruptPath = join(dir, 'acme__repo-pr-99-deadbeef.json');
  writeFileSync(corruptPath, '');
  const stale = new Date(Date.parse(hoursAgo(20)));
  utimesSync(corruptPath, stale, stale);

  const result = await reapStaleCloserLeases({
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

test('reapStaleCloserLeases keeps fresh corrupt lease files for concurrent writers', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const dir = join(rootDir, 'data', 'ama-closer-leases');
  mkdirSync(dir, { recursive: true });
  const corruptPath = join(dir, 'acme__repo-pr-98-deadbeef.json');
  writeFileSync(corruptPath, '{');
  const fresh = new Date(Date.parse(hoursAgo(1)));
  utimesSync(corruptPath, fresh, fresh);

  const result = await reapStaleCloserLeases({
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    isProcessAlive: () => false,
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.released, 0);
  assert.equal(result.budgetsReset, 0);
  assert.equal(existsSync(corruptPath), true, 'fresh corrupt lease retained for writer to finish');
});

test('reapStaleCloserLeases skips filesystem read errors instead of treating them as corruption', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const dir = join(rootDir, 'data', 'ama-closer-leases');
  mkdirSync(join(dir, 'acme__repo-pr-100-deadbeef.json'), { recursive: true });

  const errors = [];
  const result = await reapStaleCloserLeases({
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    isProcessAlive: () => true,
    logger: { warn() {}, error(message) { errors.push(String(message)); } },
  });

  assert.equal(result.released, 0);
  assert.equal(result.budgetsReset, 0);
  assert.equal(result.leases.length, 0);
  assert.equal(result.cursorPersisted, false, 'read errors must remain retryable on the next pass');
  assert.ok(errors.some((line) => line.includes('failed to read lease')), 'read failure logged for retry');
});

test('reapStaleCloserLeases keeps lease when transient budget reset cannot be persisted', async (t) => {
  const rootDir = tempRoot();
  t.after(() => {
    chmodSync(join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches'), 0o755);
    rmSync(rootDir, { recursive: true, force: true });
  });

  const identity = { repo: 'acme/repo', prNumber: 101, headSha: 'badc0ffeebadc0ffeebadc0ffeebadc0ffeebadc0f' };
  const leasePath = writeLease(rootDir, {
    ...identity, status: 'dispatched', terminalOutcome: null,
    acquiredAt: hoursAgo(20), updatedAt: hoursAgo(20), watcherPid: 31337,
  });

  const recordPath = amaCloserDispatchFilePath(rootDir, identity);
  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify({
    ...identity, retryCount: 2, state: 'dispatch-deferred-transient',
    lastFailureTransient: true,
    lastError: 'gh: API rate limit exceeded (HTTP 403)',
  }, null, 2)}\n`);
  chmodSync(dirname(recordPath), 0o555);

  const errors = [];
  const result = await reapStaleCloserLeases({
    rootDir, now: NOW, thresholdMs: 6 * 60 * 60 * 1000,
    logger: { warn() {}, error(message) { errors.push(String(message)); } },
  });

  assert.equal(result.released, 0, 'lease retained so reset can be retried on the next tick');
  assert.equal(result.budgetsReset, 0);
  assert.equal(existsSync(leasePath), true, 'failed reset does not remove the recovery trigger');
  assert.ok(errors.some((line) => line.includes('failed to reset transient-exhausted closer budget')));
});

test('reapStaleCloserLeases processes more than two opendir pages across watcher restarts', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const leaseNames = [];
  const leasePaths = [];
  for (let i = 1; i <= 7; i += 1) {
    const path = writeLease(rootDir, {
      repo: `acme/lease-00${i}`,
      prNumber: i,
      headSha: `lease${i}`,
      status: 'dispatched',
      terminalOutcome: null,
      acquiredAt: hoursAgo(20),
      updatedAt: hoursAgo(20),
      watcherPid: 31337,
    });
    leaseNames.push(path.split('/').at(-1));
    leasePaths.push(path);
  }

  const sorted = [...leaseNames].sort((a, b) => a.localeCompare(b));
  const counters = [];
  const opendirSyncImpl = makeOpendirFromListing(() => sorted, counters);

  const opts = {
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 3,
    readLimit: 3,
    opendirSyncImpl,
    logger: { warn() {}, error() {} },
  };
  const pass1 = await reapStaleCloserLeases(opts);
  const pass2 = await reapStaleCloserLeases(opts);
  const pass3 = await reapStaleCloserLeases(opts);
  assert.equal(pass1.released, 3);
  assert.equal(pass2.released, 3, 'cursor position resumes enumeration beyond the first opendir page');
  assert.equal(pass3.released, 1, 'third bounded page is reached after restart-style fresh opendir');
  assert.ok(leasePaths.every((path) => !existsSync(path)), 'all leases across three pages are eventually released');
  for (const pass of [pass1, pass2, pass3]) {
    assert.ok(pass.scannedEntries <= 3, 'entry scan stays capped per pass');
    assert.ok(pass.readRecords <= 3, 'lease reads stay capped per pass');
  }
  assert.ok(counters.every((counter) => counter.closed), 'directory iterators are closed after bounded passes');
});

test('reapStaleCloserLeases does not advance cursor past unread JSON when read limit is lower than entry scan', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const leaseNames = [];
  for (let i = 1; i <= 5; i += 1) {
    const path = writeLease(rootDir, {
      repo: `acme/read-boundary-00${i}`,
      prNumber: i,
      headSha: `boundary${i}`,
      status: 'dispatched',
      terminalOutcome: null,
      acquiredAt: hoursAgo(20),
      updatedAt: hoursAgo(20),
      watcherPid: 31337,
    });
    leaseNames.push(path.split('/').at(-1));
  }

  const sorted = [...leaseNames].sort((a, b) => a.localeCompare(b));
  const opts = {
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 4,
    readLimit: 2,
    opendirSyncImpl: makeOpendirFromListing(() => sorted),
    logger: { warn() {}, error() {} },
  };

  const pass1 = await reapStaleCloserLeases(opts);
  const pass2 = await reapStaleCloserLeases(opts);
  const pass3 = await reapStaleCloserLeases(opts);

  assert.equal(pass1.released, 2);
  assert.equal(pass1.cursorEntriesSeen, 2, 'cursor stops at last read JSON, not the scanned page end');
  assert.equal(pass2.released, 2, 'unread JSON leases from pass 1 are processed on the next pass');
  assert.equal(pass2.cursorEntriesSeen, 2);
  assert.equal(pass3.released, 1);
});

test('reapStaleCloserLeases handles insertion and deletion around the saved cursor', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const paths = new Map();
  for (const [name, prNumber] of [['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]) {
    const path = writeLease(rootDir, {
      repo: `acme/mutate-${name}`,
      prNumber,
      headSha: `mutate${name}`,
      status: 'dispatched',
      terminalOutcome: null,
      acquiredAt: hoursAgo(20),
      updatedAt: hoursAgo(20),
      watcherPid: 31337,
    });
    paths.set(name, path);
  }

  let listing = [...paths.values()].map((path) => path.split('/').at(-1)).sort((a, b) => a.localeCompare(b));
  const opendirSyncImpl = makeOpendirFromListing(() => listing);
  const opts = {
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 2,
    readLimit: 2,
    opendirSyncImpl,
    logger: { warn() {}, error() {} },
  };

  const pass1 = await reapStaleCloserLeases(opts);
  assert.equal(pass1.released, 2);

  const insertedPath = writeLease(rootDir, {
    repo: 'acme/mutate-aa',
    prNumber: 6,
    headSha: 'mutateaa',
    status: 'dispatched',
    terminalOutcome: null,
    acquiredAt: hoursAgo(20),
    updatedAt: hoursAgo(20),
    watcherPid: 31337,
  });
  rmSync(paths.get('c'), { force: true });
  listing = [insertedPath, paths.get('d'), paths.get('e')]
    .map((path) => path.split('/').at(-1))
    .sort((a, b) => a.localeCompare(b));

  const pass2 = await reapStaleCloserLeases(opts);
  assert.equal(pass2.released, 2, 'deletion before the lexical cursor does not skip later entries');
  assert.equal(existsSync(paths.get('d')), false, 'later entries remain immediately eligible after deletion');

  listing = [insertedPath]
    .map((path) => path.split('/').at(-1))
    .sort((a, b) => a.localeCompare(b));
  const pass3 = await reapStaleCloserLeases(opts);
  assert.equal(pass3.released, 1, 'cursor wrap gives coverage to names inserted before the cursor');
  assert.equal(existsSync(insertedPath), false);
});

test('reapStaleCloserLeases resumes by saved position when the saved cursor target is missing', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const leasePaths = [];
  for (let i = 1; i <= 4; i += 1) {
    leasePaths.push(writeLease(rootDir, {
      repo: `acme/missing-cursor-00${i}`,
      prNumber: i,
      headSha: `missing${i}`,
      status: 'dispatched',
      terminalOutcome: null,
      acquiredAt: hoursAgo(20),
      updatedAt: hoursAgo(20),
      watcherPid: 31337,
    }));
  }
  const sorted = leasePaths.map((path) => path.split('/').at(-1)).sort((a, b) => a.localeCompare(b));
  writeCloserLeaseCursor(rootDir, {
    schemaVersion: 2,
    lastEntryName: `${sorted[1]}~deleted-cursor-target`,
    entriesSeen: 2,
  });

  const result = await reapStaleCloserLeases({
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 2,
    readLimit: 2,
    opendirSyncImpl: makeOpendirFromListing(() => sorted),
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.released, 2);
  assert.equal(existsSync(leasePaths[0]), true, 'entries before the saved position wait for wrap');
  assert.equal(existsSync(leasePaths[1]), true, 'entries before the saved position wait for wrap');
  assert.equal(existsSync(leasePaths[2]), false);
  assert.equal(existsSync(leasePaths[3]), false);
});

test('reapStaleCloserLeases sorts a complete snapshot but admits at most its entry budget', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  for (let i = 1; i <= 5; i += 1) {
    writeLease(rootDir, {
      repo: `acme/budget-00${i}`,
      prNumber: i,
      headSha: `budget${i}`,
      status: 'dispatched',
      terminalOutcome: null,
      acquiredAt: hoursAgo(20),
      updatedAt: hoursAgo(20),
      watcherPid: 31337,
    });
  }

  const sorted = [
    'acme__budget-001-pr-1-budget1.json',
    'acme__budget-002-pr-2-budget2.json',
    'acme__budget-003-pr-3-budget3.json',
    'acme__budget-004-pr-4-budget4.json',
    'acme__budget-005-pr-5-budget5.json',
  ];
  const counters = [];
  const result = await reapStaleCloserLeases({
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 4,
    readLimit: 2,
    opendirSyncImpl: makeOpendirSequence([sorted], counters),
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.scannedEntries, 4);
  assert.equal(result.readRecords, 2);
  assert.equal(result.released, 2, 'only read leases can be released in this pass');
  assert.equal(counters[0].reads, 6, 'the complete five-entry snapshot plus EOF is consumed');
  assert.equal(counters[0].closed, true);
});

test('reapStaleCloserLeases continues when a discovered lease completes concurrently', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const vanished = writeLease(rootDir, {
    repo: 'acme/concurrent-a', prNumber: 1, headSha: 'gone', status: 'dispatched',
    terminalOutcome: null, acquiredAt: hoursAgo(20), updatedAt: hoursAgo(20), watcherPid: 31337,
  });
  const remaining = writeLease(rootDir, {
    repo: 'acme/concurrent-b', prNumber: 2, headSha: 'present', status: 'dispatched',
    terminalOutcome: null, acquiredAt: hoursAgo(20), updatedAt: hoursAgo(20), watcherPid: 31337,
  });
  const listing = [vanished, remaining].map((path) => path.split('/').at(-1));
  rmSync(vanished);

  const errors = [];
  const result = await reapStaleCloserLeases({
    rootDir, now: NOW, thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 2, readLimit: 2,
    opendirSyncImpl: makeOpendirFromListing(() => listing),
    logger: { warn() {}, error(message) { errors.push(String(message)); } },
  });

  assert.equal(result.released, 1);
  assert.equal(existsSync(remaining), false, 'later leases in the page are still recovered');
  assert.equal(result.cursorPersisted, true);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// Orchestrator never throws
// ---------------------------------------------------------------------------

test('runStartupStaleStateReaper is fail-safe and returns a summary', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const db = openReviewStateDb(rootDir);
  ensureReviewStateSchema(db);
  t.after(() => db.close());
  // No leases dir, no passes -> must not throw.
  const out = await runStartupStaleStateReaper({ rootDir, db, env: {}, now: NOW, logger: { warn() {}, error() {}, log() {} } });
  assert.equal(out.reviewerPasses.reaped, 0);
  assert.equal(out.closerLeases.released, 0);
});
