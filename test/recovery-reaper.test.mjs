import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, promises as fsPromises, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createStaleStateReaperTicker,
  DEFAULT_CLOSER_LEASE_ENTRY_SCAN_LIMIT,
  DEFAULT_CLOSER_LEASE_READ_LIMIT,
  DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
  DEFAULT_STALE_CLOSER_LEASE_MS,
  DEFAULT_STALE_RUNNING_REVIEWER_PASS_MS,
  DEFAULT_STALE_STATE_REAPER_INTERVAL_MS,
  DEFAULT_TERMINAL_CLOSER_LEASE_PRUNE_MS,
  reapStaleCloserLeases,
  reapStaleRunningReviewerPasses,
  resolveCloserLeaseEntryScanLimit,
  resolveCloserLeaseReadLimit,
  resolveDeadHolderCloserLeaseMs,
  resolveStaleCloserLeaseMs,
  resolveStaleRunningReviewerPassMs,
  resolveStaleStateReaperIntervalMs,
  resolveTerminalCloserLeasePruneMs,
  runStartupStaleStateReaper,
  selectPrunableCloserLeases,
  selectReleasableCloserLeases,
  selectStaleRunningReviewerPasses,
} from '../src/recovery-reaper.mjs';
import { beginReviewerPass, completeReviewerPass } from '../src/reviewer-pass-tokens.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from '../src/review-state.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-closer.mjs';
import { startWatcherStaleStateReaper } from '../src/watcher-stale-state-reaper.mjs';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'reaper-'));
}

const NOW = '2026-06-29T12:00:00Z';
function hoursAgo(n) {
  return new Date(Date.parse(NOW) - n * 60 * 60 * 1000).toISOString();
}
function minutesAgo(n) {
  return new Date(Date.parse(NOW) - n * 60 * 1000).toISOString();
}
function daysAgo(n) {
  return new Date(Date.parse(NOW) - n * 24 * 60 * 60 * 1000).toISOString();
}
const THIS_HOST = hostname();
const DEAD_PID = 999_001;
const pidIsDead = () => false;
const pidIsAlive = () => true;
function leaseDirFileCount(rootDir) {
  try {
    return readdirSync(join(rootDir, 'data', 'ama-closer-leases')).length;
  } catch {
    return 0;
  }
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

test('reapStaleRunningReviewerPasses marks aged running passes abandoned (re-review unblocked)', async (t) => {
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
  assert.equal(result.cursorPersisted, true, 'read errors cannot pin the current page forever');
  assert.ok(errors.some((line) => line.includes('failed to read lease')), 'read failure logged for retry after wrap');
});

test('reapStaleCloserLeases does not starve stale leases behind many active leases', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  for (let index = 0; index < 500; index += 1) {
    writeLease(rootDir, {
      repo: `aaa/active-${String(index).padStart(3, '0')}`,
      prNumber: index + 1,
      headSha: `active-${index}`,
      status: 'dispatched',
      terminalOutcome: null,
      updatedAt: hoursAgo(1),
    });
  }
  const stalePath = writeLease(rootDir, {
    repo: 'zzz/stale', prNumber: 999, headSha: 'stale', status: 'dispatched',
    terminalOutcome: null, updatedAt: hoursAgo(20),
  });

  let released = 0;
  for (let pass = 0; pass < 12 && released === 0; pass += 1) {
    const result = await reapStaleCloserLeases({
      rootDir,
      now: NOW,
      thresholdMs: 6 * 60 * 60 * 1000,
      entryScanLimit: 50,
      readLimit: 50,
      logger: { warn() {}, error() {} },
    });
    assert.ok(result.scannedEntries <= 50);
    assert.ok(result.readRecords <= 50);
    released += result.released;
  }

  assert.equal(released, 1);
  assert.equal(existsSync(stalePath), false);
});

test('reapStaleCloserLeases bounds concurrent lease reads', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  for (let index = 0; index < 6; index += 1) {
    writeLease(rootDir, {
      repo: `acme/concurrency-${index}`,
      prNumber: index + 1,
      headSha: `head-${index}`,
      status: 'dispatched',
      terminalOutcome: null,
      updatedAt: hoursAgo(1),
    });
  }

  let activeReads = 0;
  let maxActiveReads = 0;
  const result = await reapStaleCloserLeases({
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 6,
    readLimit: 6,
    readConcurrency: 2,
    readFileImpl: async (...args) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      try {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        return await fsPromises.readFile(...args);
      } finally {
        activeReads -= 1;
      }
    },
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.readRecords, 6);
  assert.equal(maxActiveReads, 2);
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
  assert.equal(result.cursorPersisted, true, 'a failed lease cannot pin healthy leases behind its page');
  assert.equal(existsSync(leasePath), true, 'failed reset does not remove the recovery trigger');
  assert.ok(errors.some((line) => line.includes('failed to reset transient-exhausted closer budget')));

  chmodSync(dirname(recordPath), 0o755);
  const retry = await reapStaleCloserLeases({
    rootDir, now: NOW, thresholdMs: 6 * 60 * 60 * 1000,
    logger: { warn() {}, error() {} },
  });
  assert.equal(retry.released, 1, 'retained lease is retried on the next sweep');
  assert.equal(retry.cursorPersisted, true, 'the single retained lease is retried after cursor wrap');
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

test('reapStaleCloserLeases retains only a bounded lexical page while scanning directory entries', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const leasePaths = [];
  for (let i = 1; i <= 5; i += 1) {
    leasePaths.push(writeLease(rootDir, {
      repo: `acme/budget-00${i}`,
      prNumber: i,
      headSha: `budget${i}`,
      status: 'dispatched',
      terminalOutcome: null,
      acquiredAt: hoursAgo(20),
      updatedAt: hoursAgo(20),
      watcherPid: 31337,
    }));
  }

  const listing = [
    'acme__budget-004-pr-4-budget4.json',
    'acme__budget-002-pr-2-budget2.json',
    'acme__budget-005-pr-5-budget5.json',
    'acme__budget-001-pr-1-budget1.json',
    'acme__budget-003-pr-3-budget3.json',
  ];
  const counters = [];
  const result = await reapStaleCloserLeases({
    rootDir,
    now: NOW,
    thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 4,
    readLimit: 2,
    opendirSyncImpl: makeOpendirSequence([listing], counters),
    logger: { warn() {}, error() {} },
  });

  assert.equal(result.scannedEntries, 4);
  assert.equal(result.readRecords, 2);
  assert.equal(result.released, 2, 'only read leases can be released in this pass');
  assert.equal(existsSync(leasePaths[0]), false, 'the smallest name is retained from unordered discovery');
  assert.equal(existsSync(leasePaths[1]), false, 'the next-smallest name is retained from unordered discovery');
  assert.ok(leasePaths.slice(2).every((path) => existsSync(path)), 'later names wait for the next page');
  assert.equal(counters[0].reads, 6, 'the complete five-entry snapshot plus EOF is consumed');
  assert.equal(counters[0].closed, true);
});

test('reapStaleCloserLeases advances beyond a persistently unreadable page', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const dir = join(rootDir, 'data', 'ama-closer-leases');
  mkdirSync(join(dir, 'acme__aaa-broken-pr-1-bad.json'), { recursive: true });
  const freshPath = writeLease(rootDir, {
    repo: 'acme/fresh-bbb', prNumber: 2, headSha: 'fresh', status: 'dispatched',
    terminalOutcome: null, acquiredAt: hoursAgo(1), updatedAt: hoursAgo(1), watcherPid: 31337,
  });
  const stalePath = writeLease(rootDir, {
    repo: 'acme/stale-ccc', prNumber: 3, headSha: 'stale', status: 'dispatched',
    terminalOutcome: null, acquiredAt: hoursAgo(20), updatedAt: hoursAgo(20), watcherPid: 31337,
  });
  const listing = [
    join(dir, 'acme__aaa-broken-pr-1-bad.json'), freshPath, stalePath,
  ].map((path) => path.split('/').at(-1));
  const errors = [];
  const opts = {
    rootDir, now: NOW, thresholdMs: 6 * 60 * 60 * 1000,
    entryScanLimit: 2, readLimit: 2,
    opendirSyncImpl: makeOpendirFromListing(() => listing),
    logger: { warn() {}, error(message) { errors.push(String(message)); } },
  };

  const first = await reapStaleCloserLeases(opts);
  const second = await reapStaleCloserLeases(opts);

  assert.equal(first.released, 0);
  assert.equal(first.cursorPersisted, true, 'the unreadable lease does not pin its page');
  assert.equal(second.released, 1, 'a stale lease on the next page remains reachable');
  assert.equal(existsSync(stalePath), false);
  assert.equal(existsSync(freshPath), true);
  assert.ok(errors.some((line) => line.includes('failed to read lease')));
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

// ---------------------------------------------------------------------------
// CLR-02 — dead-holder tier, terminal-lease pruning, periodic reclamation
//
// SEV `closer-lease-reaper-runs-only-at-watcher-startup` (2026-08-26): 11 of 11
// non-terminal closer leases stale, every holder pid dead, 0 reclaimed, because
// the sweep only ever ran at watcher startup and the bounded scan was being
// spent on 563 finished records.
// ---------------------------------------------------------------------------

test('CLR-02 thresholds: dead-holder tier matches the 30m health surface; prune age is days', () => {
  assert.equal(DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_STALE_CLOSER_LEASE_MS, 6 * 60 * 60 * 1000, '6h floor is NOT lowered');
  assert.ok(
    DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS < DEFAULT_STALE_CLOSER_LEASE_MS,
    'the dead-holder tier is a shortcut past the floor, never a replacement for it',
  );
  assert.equal(DEFAULT_TERMINAL_CLOSER_LEASE_PRUNE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.ok(
    DEFAULT_TERMINAL_CLOSER_LEASE_PRUNE_MS > DEFAULT_STALE_CLOSER_LEASE_MS * 10,
    'prune age is an order of magnitude beyond any reclaim threshold',
  );
  assert.equal(resolveDeadHolderCloserLeaseMs({}), DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS);
  assert.equal(resolveTerminalCloserLeasePruneMs({}), DEFAULT_TERMINAL_CLOSER_LEASE_PRUNE_MS);
  assert.equal(resolveStaleStateReaperIntervalMs({}), DEFAULT_STALE_STATE_REAPER_INTERVAL_MS);
  assert.equal(
    resolveDeadHolderCloserLeaseMs({ ADVERSARIAL_DEAD_HOLDER_CLOSER_LEASE_MS: '60000' }),
    60_000,
  );
  assert.equal(
    resolveTerminalCloserLeasePruneMs({ ADVERSARIAL_TERMINAL_CLOSER_LEASE_PRUNE_MS: 'off' }),
    0,
    'pruning deletes live-host state, so operators get an explicit kill switch',
  );
  assert.equal(
    resolveTerminalCloserLeasePruneMs({ ADVERSARIAL_TERMINAL_CLOSER_LEASE_PRUNE_MS: '0' }),
    0,
  );
});

test('selectReleasableCloserLeases: a provably-dead same-host holder releases at the short tier', () => {
  const lease = {
    repo: 'a/x', prNumber: 1, headSha: 'h1', status: 'dispatched', terminalOutcome: null,
    updatedAt: minutesAgo(45), watcherPid: DEAD_PID, holderHost: THIS_HOST, _path: 'p1',
  };
  const releasable = selectReleasableCloserLeases([lease], {
    now: NOW,
    thresholdMs: DEFAULT_STALE_CLOSER_LEASE_MS,
    deadHolderThresholdMs: DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
    isProcessAlive: pidIsDead,
  });
  assert.deepEqual(releasable.map((l) => l._path), ['p1'], '45m old + dead holder -> reclaimed');
});

test('selectReleasableCloserLeases: a LIVE same-host holder is never released at the short tier', () => {
  const lease = {
    repo: 'a/x', prNumber: 1, headSha: 'h1', status: 'dispatched', terminalOutcome: null,
    updatedAt: minutesAgo(45), watcherPid: DEAD_PID, holderHost: THIS_HOST, _path: 'p1',
  };
  const releasable = selectReleasableCloserLeases([lease], {
    now: NOW,
    thresholdMs: DEFAULT_STALE_CLOSER_LEASE_MS,
    deadHolderThresholdMs: DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
    isProcessAlive: pidIsAlive,
  });
  assert.deepEqual(releasable, [], 'live holder -> the 6h floor is the only gate');

  // A liveness probe that throws must read as "alive", never as "dead".
  const throwing = selectReleasableCloserLeases([lease], {
    now: NOW,
    thresholdMs: DEFAULT_STALE_CLOSER_LEASE_MS,
    deadHolderThresholdMs: DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
    isProcessAlive: () => { throw new Error('EPERM'); },
  });
  assert.deepEqual(throwing, [], 'an unanswerable liveness probe fails closed');
});

test('selectReleasableCloserLeases: a lease younger than the dead-holder tier is never released', () => {
  const lease = {
    repo: 'a/x', prNumber: 1, headSha: 'h1', status: 'dispatched', terminalOutcome: null,
    updatedAt: minutesAgo(5), watcherPid: DEAD_PID, holderHost: THIS_HOST, _path: 'p1',
  };
  const releasable = selectReleasableCloserLeases([lease], {
    now: NOW,
    thresholdMs: DEFAULT_STALE_CLOSER_LEASE_MS,
    deadHolderThresholdMs: DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
    isProcessAlive: pidIsDead,
  });
  assert.deepEqual(releasable, [], '5m old -> below both tiers even with a dead holder');
});

test('selectReleasableCloserLeases: a dead pid on another host still waits the full floor', () => {
  const base = {
    repo: 'a/x', prNumber: 1, headSha: 'h1', status: 'dispatched', terminalOutcome: null,
    watcherPid: DEAD_PID, _path: 'p1',
  };
  const opts = {
    now: NOW,
    thresholdMs: DEFAULT_STALE_CLOSER_LEASE_MS,
    deadHolderThresholdMs: DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
    isProcessAlive: pidIsDead,
  };
  assert.deepEqual(
    selectReleasableCloserLeases([{ ...base, updatedAt: minutesAgo(45), holderHost: 'some-other-host' }], opts),
    [],
    'a pid read here says nothing about a process there',
  );
  assert.deepEqual(
    selectReleasableCloserLeases([{ ...base, updatedAt: minutesAgo(45) }], opts),
    [],
    'a pre-CLR-02 lease with no holderHost gets the floor, not the short tier',
  );
  assert.equal(
    selectReleasableCloserLeases([{ ...base, updatedAt: hoursAgo(20), holderHost: 'some-other-host' }], opts).length,
    1,
    'the 6h floor still reclaims it, exactly as before',
  );
});

test('selectReleasableCloserLeases: livePid guard is scoped to local or legacy leases', () => {
  const base = {
    repo: 'a/x', prNumber: 1, headSha: 'h1', status: 'dispatched', terminalOutcome: null,
    updatedAt: hoursAgo(20), watcherPid: process.pid,
  };
  const opts = {
    now: NOW,
    thresholdMs: DEFAULT_STALE_CLOSER_LEASE_MS,
    deadHolderThresholdMs: DEFAULT_DEAD_HOLDER_CLOSER_LEASE_MS,
    livePid: process.pid,
    host: THIS_HOST,
  };
  assert.deepEqual(
    selectReleasableCloserLeases([{ ...base, holderHost: THIS_HOST, _path: 'local-live' }], opts),
    [],
    'same-host livePid still protects the current watcher lease',
  );
  assert.deepEqual(
    selectReleasableCloserLeases([{ ...base, _path: 'legacy-live' }], opts),
    [],
    'hostless pre-CLR-02 livePid leases stay protected because their host is ambiguous',
  );
  assert.deepEqual(
    selectReleasableCloserLeases([{ ...base, holderHost: 'some-other-host', _path: 'remote-collision' }], opts)
      .map((l) => l._path),
    ['remote-collision'],
    'a same-PID lease from another host is reclaimed after the 6h floor',
  );
});

test('selectPrunableCloserLeases: retires resolved-terminal leases past the prune age and nothing else', () => {
  const leases = [
    { status: 'terminal', terminalOutcome: 'succeeded', updatedAt: daysAgo(30), _path: 'old-succeeded' },
    { status: 'terminal', terminalOutcome: 'failed-without-merge', completedAt: daysAgo(9), updatedAt: daysAgo(2), _path: 'old-failed' },
    { status: 'terminal', terminalOutcome: 'succeeded', updatedAt: daysAgo(2), _path: 'recent-terminal' },
    { status: 'terminal', terminalOutcome: null, updatedAt: daysAgo(30), _path: 'terminal-no-outcome' },
    { status: 'dispatched', terminalOutcome: null, updatedAt: daysAgo(30), _path: 'dispatched' },
    { status: 'pending', terminalOutcome: null, updatedAt: daysAgo(30), _path: 'pending' },
    { status: 'corrupt', terminalOutcome: null, _isCorrupt: true, mtimeMs: Date.parse(daysAgo(30)), _path: 'corrupt' },
    { status: 'terminal', terminalOutcome: 'succeeded', updatedAt: 'not-a-date', _path: 'unageable' },
  ];
  const prunable = selectPrunableCloserLeases(leases, {
    now: NOW, pruneAfterMs: DEFAULT_TERMINAL_CLOSER_LEASE_PRUNE_MS,
  });
  assert.deepEqual(prunable.map((l) => l._path), ['old-succeeded', 'old-failed']);
  assert.deepEqual(
    selectPrunableCloserLeases(leases, { now: NOW, pruneAfterMs: 0 }),
    [],
    'pruneAfterMs=0 disables pruning entirely',
  );
});

test('reapStaleCloserLeases prunes finished leases and never a non-terminal one', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const prunable = [];
  for (let index = 0; index < 8; index += 1) {
    prunable.push(writeLease(rootDir, {
      repo: `acme/finished-${index}`, prNumber: 100 + index, headSha: `fin${index}`,
      status: 'terminal', terminalOutcome: 'succeeded',
      acquiredAt: daysAgo(30), updatedAt: daysAgo(30), watcherPid: DEAD_PID, holderHost: THIS_HOST,
    }));
  }
  // Everything below must survive: still live, too recent, or terminal without a
  // resolved outcome (an unfinished reconciliation, not finished work).
  const keepDispatched = writeLease(rootDir, {
    repo: 'acme/keep-dispatched', prNumber: 200, headSha: 'keepd',
    status: 'dispatched', terminalOutcome: null,
    acquiredAt: daysAgo(30), updatedAt: minutesAgo(2), watcherPid: process.pid, holderHost: THIS_HOST,
  });
  const keepPending = writeLease(rootDir, {
    repo: 'acme/keep-pending', prNumber: 201, headSha: 'keepp',
    status: 'pending', terminalOutcome: null,
    acquiredAt: minutesAgo(2), updatedAt: minutesAgo(2), watcherPid: process.pid, holderHost: THIS_HOST,
  });
  const keepRecentTerminal = writeLease(rootDir, {
    repo: 'acme/keep-recent', prNumber: 202, headSha: 'keepr',
    status: 'terminal', terminalOutcome: 'succeeded',
    acquiredAt: daysAgo(2), updatedAt: daysAgo(2), watcherPid: DEAD_PID, holderHost: THIS_HOST,
  });
  const keepOutcomeless = writeLease(rootDir, {
    repo: 'acme/keep-outcomeless', prNumber: 203, headSha: 'keepo',
    status: 'terminal', terminalOutcome: null,
    acquiredAt: daysAgo(30), updatedAt: daysAgo(30), watcherPid: DEAD_PID, holderHost: THIS_HOST,
  });

  const before = leaseDirFileCount(rootDir);
  assert.equal(before, 12);

  const result = await reapStaleCloserLeases({
    rootDir, now: NOW, isProcessAlive: pidIsDead, logger: { warn() {}, error() {}, log() {} },
  });

  const after = leaseDirFileCount(rootDir);
  assert.equal(result.pruned, 8, 'every resolved-terminal lease past the prune age is retired');
  assert.equal(result.released, 0);
  assert.equal(after, 4, `lease dir bounded: ${before} -> ${after}`);
  assert.ok(prunable.every((path) => !existsSync(path)));
  for (const path of [keepDispatched, keepPending, keepRecentTerminal, keepOutcomeless]) {
    assert.equal(existsSync(path), true, `retained: ${path}`);
  }
});

test('reapStaleCloserLeases: dead same-host holder is reclaimed at 45m, live holder is not', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const deadHolder = writeLease(rootDir, {
    repo: 'acme/dead-holder', prNumber: 5910, headSha: 'aaa',
    status: 'dispatched', terminalOutcome: null,
    acquiredAt: minutesAgo(45), updatedAt: minutesAgo(45),
    watcherPid: DEAD_PID, holderHost: THIS_HOST,
  });
  const liveHolder = writeLease(rootDir, {
    repo: 'acme/live-holder', prNumber: 5911, headSha: 'bbb',
    status: 'dispatched', terminalOutcome: null,
    acquiredAt: minutesAgo(45), updatedAt: minutesAgo(45),
    watcherPid: DEAD_PID + 1, holderHost: THIS_HOST,
  });

  const result = await reapStaleCloserLeases({
    rootDir,
    now: NOW,
    isProcessAlive: (pid) => pid !== DEAD_PID,
    logger: { warn() {}, error() {}, log() {} },
  });

  assert.equal(result.released, 1);
  assert.equal(existsSync(deadHolder), false, 'dead holder -> closer re-dispatch unblocked at 45m');
  assert.equal(existsSync(liveHolder), true, 'live holder -> lease is load-bearing, keep it');

  // Without a liveness probe the short tier cannot fire at all: same lease, no
  // isProcessAlive, and the 6h floor is the only gate.
  const noProbeRoot = tempRoot();
  t.after(() => rmSync(noProbeRoot, { recursive: true, force: true }));
  const unproven = writeLease(noProbeRoot, {
    repo: 'acme/unproven', prNumber: 5912, headSha: 'ccc',
    status: 'dispatched', terminalOutcome: null,
    acquiredAt: minutesAgo(45), updatedAt: minutesAgo(45),
    watcherPid: DEAD_PID, holderHost: THIS_HOST,
  });
  const unprovenResult = await reapStaleCloserLeases({
    rootDir: noProbeRoot, now: NOW, logger: { warn() {}, error() {}, log() {} },
  });
  assert.equal(unprovenResult.released, 0);
  assert.equal(existsSync(unproven), true);
});

// ---------------------------------------------------------------------------
// The defect itself: reclamation must happen on a poll tick, not only at startup
// ---------------------------------------------------------------------------

test('createStaleStateReaperTicker reclaims a lease orphaned AFTER startup, on a poll tick', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const startupMs = Date.parse(NOW);
  const env = {};
  const logger = { warn() {}, error() {}, log() {} };

  // 1. Startup sweep: the directory is empty, so it reclaims nothing. This is
  //    the ONLY sweep the pre-CLR-02 watcher ever ran.
  const startup = await runStartupStaleStateReaper({
    rootDir, db: null, env, now: new Date(startupMs).toISOString(), logger, isProcessAlive: pidIsDead,
  });
  assert.equal(startup.closerLeases.released, 0);

  const ticker = createStaleStateReaperTicker({
    rootDir, db: null, env, logger, isProcessAlive: pidIsDead, lastRunAtMs: startupMs,
  });
  assert.equal(ticker.intervalMs, DEFAULT_STALE_STATE_REAPER_INTERVAL_MS);

  // 2. A closer is dispatched after startup and its holder dies.
  const orphanedMs = startupMs + 60_000;
  const orphaned = writeLease(rootDir, {
    repo: 'acme/orphaned-after-startup', prNumber: 5931, headSha: 'ddd',
    status: 'dispatched', terminalOutcome: null,
    acquiredAt: new Date(orphanedMs).toISOString(),
    updatedAt: new Date(orphanedMs).toISOString(),
    watcherPid: DEAD_PID, holderHost: THIS_HOST,
  });

  // 3. Polls before the tick interval elapses must not sweep.
  const early = await ticker.tick({ nowMs: startupMs + (ticker.intervalMs / 2) });
  assert.equal(early.ran, false);
  assert.equal(early.reason, 'interval-not-elapsed');
  assert.equal(existsSync(orphaned), true);

  // 4. A later poll — still hours short of the 6h floor, and with no restart in
  //    between — reclaims it.
  const sweepMs = orphanedMs + (45 * 60 * 1000);
  assert.ok(
    sweepMs - orphanedMs < DEFAULT_STALE_CLOSER_LEASE_MS,
    'the reclaim happens well inside the 6h floor, on dead-holder evidence',
  );
  const swept = await ticker.tick({ nowMs: sweepMs });
  assert.equal(swept.ran, true, 'reclamation runs from the poll loop, not just at startup');
  assert.equal(swept.result.closerLeases.released, 1);
  assert.equal(existsSync(orphaned), false, 'closer re-dispatch unblocked without a watcher restart');
});

test('createStaleStateReaperTicker prunes finished leases on a poll tick', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const startupMs = Date.parse(NOW);
  for (let index = 0; index < 5; index += 1) {
    writeLease(rootDir, {
      repo: `acme/finished-${index}`, prNumber: 300 + index, headSha: `tick${index}`,
      status: 'terminal', terminalOutcome: 'succeeded',
      acquiredAt: daysAgo(30), updatedAt: daysAgo(30), watcherPid: DEAD_PID, holderHost: THIS_HOST,
    });
  }
  const before = leaseDirFileCount(rootDir);

  const ticker = createStaleStateReaperTicker({
    rootDir, db: null, env: {}, logger: { warn() {}, error() {}, log() {} },
    isProcessAlive: pidIsDead, lastRunAtMs: startupMs,
  });
  const swept = await ticker.tick({ nowMs: startupMs + ticker.intervalMs });

  assert.equal(swept.ran, true);
  assert.equal(swept.result.closerLeases.pruned, 5);
  assert.equal(before, 5);
  assert.equal(leaseDirFileCount(rootDir), 0, 'lease dir bounded from the poll loop');
});

test('createStaleStateReaperTicker never throws and never blocks a poll', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  const startupMs = Date.parse(NOW);
  const errors = [];
  const exploding = {
    prepare() { throw new Error('sqlite exploded'); },
  };
  // A real lease so the exploding liveness probe is actually reached.
  const lease = writeLease(rootDir, {
    repo: 'acme/probe-explodes', prNumber: 400, headSha: 'boom',
    status: 'dispatched', terminalOutcome: null,
    acquiredAt: minutesAgo(45), updatedAt: minutesAgo(45),
    watcherPid: DEAD_PID, holderHost: THIS_HOST,
  });
  const ticker = createStaleStateReaperTicker({
    rootDir,
    db: exploding,
    env: {},
    logger: { warn() {}, error(message) { errors.push(String(message)); }, log() {} },
    isProcessAlive: () => { throw new Error('kill(2) exploded'); },
    lastRunAtMs: startupMs,
  });

  const swept = await ticker.tick({ nowMs: startupMs + ticker.intervalMs });
  assert.equal(swept.ran, true, 'a failing sub-sweep is contained, not propagated');
  assert.equal(swept.result.reviewerPasses.reaped, 0);
  assert.ok(errors.some((line) => line.includes('reviewer-pass sweep failed')));
  assert.equal(swept.result.closerLeases.released, 0);
  assert.equal(existsSync(lease), true, 'an unanswerable liveness probe keeps the lease');

  // And the failure advances the clock, so a broken filesystem cannot turn into
  // a per-poll retry storm.
  const immediate = await ticker.tick({ nowMs: startupMs + ticker.intervalMs + 1 });
  assert.equal(immediate.ran, false);
  assert.equal(immediate.reason, 'interval-not-elapsed');
});

// ---------------------------------------------------------------------------
// The wiring itself. Every test above proves the ticker works; this one proves
// the watcher actually uses it. The pre-CLR-02 defect was not a broken
// reclaimer — the reclaimer worked and logged
// `[reaper] startup stale-state sweep: ... released 18 closer lease(s)`. It was
// a working reclaimer with exactly one call site, above the poll loop. A guard
// on the call site is therefore the regression test for the actual bug.
// ---------------------------------------------------------------------------

function sourceWithoutComments(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function extractFunctionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `watcher.mjs no longer contains ${signature}`);
  let index = source.indexOf('{', start);
  let depth = 0;
  const bodyStart = index;
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${signature}`);
}

test('watcher drives the stale-state reaper from the poll path, not only from startup', () => {
  const watcher = sourceWithoutComments('../src/watcher.mjs');

  const pollBody = extractFunctionBody(watcher, 'async function runHeartbeatPoll(');
  assert.match(
    pollBody,
    /staleStateReaperTicker\.tick\(/,
    'the reclaim step must run from the poll loop. With a startup-only call site '
      + 'a watcher that stays up for a day reclaims nothing for a day — the exact '
      + 'defect in SEV closer-lease-reaper-runs-only-at-watcher-startup (2026-08-26).',
  );
  assert.match(
    watcher,
    /const staleStateReaperTicker = await startWatcherStaleStateReaper\(/,
    'the ticker the poll loop calls must be the one the startup path returns',
  );
});

test('startWatcherStaleStateReaper runs the startup sweep AND returns a poll-loop ticker', async (t) => {
  const rootDir = tempRoot();
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));

  // Both triggers are load-bearing and not interchangeable: startup cannot wait
  // a tick interval after an outage, and a long-lived watcher must not stop
  // reclaiming once it is past startup.
  const scheduling = sourceWithoutComments('../src/watcher-stale-state-reaper.mjs');
  assert.match(scheduling, /await runStartupStaleStateReaper\(/);
  assert.match(
    scheduling,
    /createStaleStateReaperTicker\([\s\S]{0,200}?isProcessAlive[\s,}]/,
    'the ticker must be built with the liveness probe; without it the '
      + 'dead-holder tier silently degrades to the 6h floor',
  );

  const startupOrphan = writeLease(rootDir, {
    repo: 'acme/startup-orphan', prNumber: 5910, headSha: 'eee',
    status: 'dispatched', terminalOutcome: null,
    acquiredAt: minutesAgo(45), updatedAt: minutesAgo(45),
    watcherPid: DEAD_PID, holderHost: THIS_HOST,
  });
  const ticker = await startWatcherStaleStateReaper({
    rootDir, db: null, env: {}, logger: { warn() {}, error() {}, log() {} },
    isProcessAlive: pidIsDead,
  });
  assert.equal(existsSync(startupOrphan), false, 'startup still sweeps');
  assert.equal(typeof ticker.tick, 'function', 'and hands back the poll-loop trigger');
  assert.equal(ticker.intervalMs, DEFAULT_STALE_STATE_REAPER_INTERVAL_MS);
});
