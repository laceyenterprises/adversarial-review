import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { cancelCloserForTerminalPr, queueCloserCancelForClosedPr, retryPendingCloserCancels } from '../src/ama/closer-terminal-cancel.mjs';
import { reconcileTerminalPrState } from '../src/pr-terminal-reconcile.mjs';
import { amaCloserDispatchFilePath, isActiveAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';
import { findActiveRemediationJob } from '../src/ama/active-remediation-job.mjs';

function fixture(t, prNumber = 7) {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-terminal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'o/r', prNumber, headSha: 'abc' };
  acquireAmaCloserLease({ rootDir, ...identity });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: `lrq_${prNumber}` });
  const dispatchPath = amaCloserDispatchFilePath(rootDir, identity);
  mkdirSync(dirname(dispatchPath), { recursive: true });
  writeFileSync(dispatchPath, JSON.stringify({ ...identity, launchRequestId: `lrq_${prNumber}` }));
  return { rootDir, identity, dispatchPath };
}

test('merged PR at closer head succeeds without cancelling its HQ worker', async (t) => {
  const { rootDir, identity, dispatchPath } = fixture(t);
  const result = await cancelCloserForTerminalPr({
    rootDir, hqRoot: rootDir, repo: 'o/r', prNumber: 7, transition: 'merged', live: { headRefOid: 'abc' },
    readAuditImpl: () => ({ status: 'succeeded' }),
    execFileImpl: () => { throw new Error('must not cancel'); },
  });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.cancelled, false);
  assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'succeeded');
  assert.equal(JSON.parse(readFileSync(dispatchPath, 'utf8')).lastObservedStatus, null);
});

test('same-head external merge remains owned until authoritative settlement', async (t) => {
  const { rootDir, identity } = fixture(t);
  const result = await cancelCloserForTerminalPr({ rootDir, repo: 'o/r', prNumber: 7,
    transition: 'merged', live: { headRefOid: 'abc' }, readAuditImpl: () => null });
  assert.equal(result.reason, 'merged-await-stale-reaper');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

test('merged PR at another head leaves closer for stale-window reaper', async (t) => {
  const { rootDir, identity } = fixture(t);
  const result = await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 7, transition: 'merged', live: { headRefOid: 'other' },
    execFileImpl: () => { throw new Error('must not cancel'); },
  });
  assert.equal(result.reason, 'merged-await-stale-reaper');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

test('closed PR cancellation records HQ observed status', async (t) => {
  const { rootDir, identity, dispatchPath } = fixture(t);
  const calls = [];
  const result = await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 7, transition: 'closed', hqPath: '/mock/hq', hqRoot: '/mock/root',
    accessImpl: () => {}, execFileImpl: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ ok: false, reason: 'already terminal', currentStatus: 'failed' }) };
    },
    logger: { log() {} },
  });
  assert.equal(result.outcome, 'pr-closed-externally');
  assert.deepEqual(calls[0][1].slice(0, 3), ['dispatch', 'cancel', 'lrq_7']);
  assert.equal(calls[0][2].timeout, 10_000);
  assert.equal(calls[0][2].maxBuffer, 5 * 1024 * 1024);
  assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'pr-closed-externally');
  assert.equal(JSON.parse(readFileSync(dispatchPath, 'utf8')).lastObservedStatus, 'failed');
});

test('missing HQ binary keeps the live lease', async (t) => {
  const { rootDir, identity } = fixture(t);
  const missing = Object.assign(new Error("ENOENT: no such file or directory, access '/missing/hq'"), { code: 'ENOENT' });
  const result = await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 7, transition: 'closed', hqPath: '/missing/hq', hqRoot: '/mock/root',
    accessImpl: () => { throw missing; }, logger: { warn() {} },
  });
  assert.equal(result.reason, 'cancel-unavailable');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

test('HQ command-not-found output is not an already-terminal dispatch', async (t) => {
  const { rootDir, identity } = fixture(t);
  const result = await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 7, transition: 'closed', hqPath: 'hq', hqRoot: '/mock/root',
    execFileImpl: async () => { throw Object.assign(new Error('python3: command not found'), { stdout: 'python3: command not found' }); },
    logger: { warn() {} },
  });
  assert.equal(result.reason, 'cancel-unavailable');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

test('HQ terminal response without a named status releases dispatch reservation', async (t) => {
  const { rootDir, dispatchPath } = fixture(t);
  writeFileSync(dispatchPath, JSON.stringify({ repo: 'o/r', prNumber: 7, headSha: 'abc', state: 'dispatched' }));
  await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 7, transition: 'closed', hqPath: 'hq', hqRoot: '/mock/root',
    execFileImpl: async () => ({ stdout: JSON.stringify({ ok: false, reason: 'already terminal' }) }),
    logger: { log() {} },
  });
  const record = JSON.parse(readFileSync(dispatchPath, 'utf8'));
  assert.equal(record.lastObservedStatus, 'terminal');
  assert.equal(isActiveAmaCloserDispatchRecord(record), false);
});

test('transient HQ failure retries then succeeds', async (t) => {
  const { rootDir, identity } = fixture(t);
  let attempts = 0;
  const result = await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 7, transition: 'closed', hqPath: 'hq', hqRoot: '/mock/root',
    retryDelaysMs: [0], execFileImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' });
      return { stdout: JSON.stringify({ ok: true, currentStatus: 'cancelled' }) };
    }, logger: { log() {} },
  });
  assert.equal(attempts, 2);
  assert.equal(result.cancelled, true);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'terminal');
});

test('timed-out HQ cancellation remains retryable on next lifecycle tick', async (t) => {
  const { rootDir, identity } = fixture(t);
  let attempts = 0;
  const result = await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 7, transition: 'closed', hqPath: 'hq', hqRoot: '/mock/root',
    retryDelaysMs: [0], execFileImpl: async (_bin, _args, options) => {
      assert.equal(options.timeout, 10_000);
      attempts += 1;
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    }, logger: { warn() {} },
  });
  assert.equal(attempts, 2);
  assert.equal(result.reason, 'cancel-unavailable');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

test('closed PR marks terminal after persisting cancel even when HQ is down', async (t) => {
  const { rootDir, identity } = fixture(t);
  let marked = false;
  const summary = await reconcileTerminalPrState({
    rows: [{ repo: 'o/r', pr_number: 7 }],
    fetchLiveState: async () => ({ state: 'CLOSED' }),
    onBeforeMark: ({ repo, prNumber }) => queueCloserCancelForClosedPr({ rootDir, repo, prNumber }),
    markClosed: () => { marked = true; }, markMerged: () => {},
  });
  assert.equal(marked, true);
  assert.equal(summary.closed, 1);
  const result = await retryPendingCloserCancels({ rootDir, retryMs: 0, maxAttempts: 2,
    liveStateImpl: async () => ({ state: 'CLOSED' }),
    cancelImpl: () => ({ reason: 'cancel-unavailable', error: new Error('HQ down') }),
    alertImpl: async () => {}, logger: { error() {} },
  });
  assert.equal(result.attempted, 1);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

test('rekeyed lease settles the dispatch record at its original head', async (t) => {
  const { rootDir, identity, dispatchPath } = fixture(t);
  const lease = readAmaCloserLease(rootDir, identity);
  const rekeyed = { ...lease, headSha: 'new', rekeyedFromHeadSha: 'abc', supersededHeads: ['abc'] };
  const oldPath = join(rootDir, 'data', 'ama-closer-leases', 'o__r-pr-7-abc.json');
  const newPath = join(rootDir, 'data', 'ama-closer-leases', 'o__r-pr-7-new.json');
  rmSync(oldPath);
  writeFileSync(newPath, JSON.stringify(rekeyed));
  await cancelCloserForTerminalPr({ rootDir, repo: 'o/r', prNumber: 7, transition: 'closed',
    hqPath: 'hq', hqRoot: '/mock/root', execFileImpl: async () => ({ stdout: '{"ok":true,"currentStatus":"cancelled"}' }),
    logger: { log() {} },
  });
  assert.equal(JSON.parse(readFileSync(dispatchPath, 'utf8')).outcome, 'no-merge:pr-closed-externally');
});

test('unknown HQ id and expired pending launch settle without an HQ call', async (t) => {
  const unknown = fixture(t, 8);
  const unknownLeasePath = join(unknown.rootDir, 'data', 'ama-closer-leases', 'o__r-pr-8-abc.json');
  writeFileSync(unknownLeasePath, JSON.stringify({ ...readAmaCloserLease(unknown.rootDir, unknown.identity), lrqId: 'unknown' }));
  writeFileSync(unknown.dispatchPath, JSON.stringify({ ...unknown.identity, launchRequestId: 'unknown' }));
  await cancelCloserForTerminalPr({ rootDir: unknown.rootDir, repo: 'o/r', prNumber: 8, transition: 'closed',
    execFileImpl: () => { throw new Error('must not call HQ'); }, logger: { log() {} },
  });
  assert.equal(readAmaCloserLease(unknown.rootDir, unknown.identity).status, 'terminal');

  const rootDir = mkdtempSync(join(tmpdir(), 'pending-terminal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'o/r', prNumber: 9, headSha: 'abc' };
  acquireAmaCloserLease({ rootDir, ...identity, now: '2026-01-01T00:00:00Z' });
  const result = await cancelCloserForTerminalPr({ rootDir, repo: 'o/r', prNumber: 9, transition: 'closed',
    now: '2026-01-02T00:00:00Z', execFileImpl: () => { throw new Error('must not call HQ'); }, logger: { log() {} },
  });
  assert.equal(result.outcome, 'pr-closed-externally');
  assert.equal(readAmaCloserLease(rootDir, identity), null);
});

test('HQ unknown dispatch refusal settles the lease and reservation', async (t) => {
  const { rootDir, identity, dispatchPath } = fixture(t, 10);
  const result = await cancelCloserForTerminalPr({ rootDir, repo: 'o/r', prNumber: 10,
    transition: 'closed', hqPath: 'hq', hqRoot: '/mock/root',
    execFileImpl: async () => ({ stdout: JSON.stringify({ ok: false, reason: 'unknown dispatch_id lrq_10 (or owned by another account)' }) }),
    logger: { log() {} },
  });
  assert.equal(result.outcome, 'pr-closed-externally');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'terminal');
  assert.equal(JSON.parse(readFileSync(dispatchPath, 'utf8')).lastObservedStatus, 'not-found');
});

test('pending lease uses dispatch record launch id when lease id was not stamped', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pending-lrq-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'o/r', prNumber: 11, headSha: 'abc' };
  acquireAmaCloserLease({ rootDir, ...identity });
  const dispatchPath = amaCloserDispatchFilePath(rootDir, identity);
  mkdirSync(dirname(dispatchPath), { recursive: true });
  writeFileSync(dispatchPath, JSON.stringify({ ...identity, launchRequestId: 'lrq_from_record' }));
  let cancelledId;
  await cancelCloserForTerminalPr({ rootDir, repo: 'o/r', prNumber: 11, transition: 'closed',
    hqPath: 'hq', hqRoot: '/mock/root', execFileImpl: async (_bin, args) => {
      cancelledId = args[2];
      return { stdout: '{"ok":true,"currentStatus":"cancelled"}' };
    }, logger: { log() {} },
  });
  assert.equal(cancelledId, 'lrq_from_record');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'terminal');
});

test('cancel queue spaces attempts and alerts once at its retry bound', async (t) => {
  const { rootDir } = fixture(t, 12);
  queueCloserCancelForClosedPr({ rootDir, repo: 'o/r', prNumber: 12, now: '2026-01-01T00:00:00Z' });
  let calls = 0;
  let alerts = 0;
  const options = { rootDir, retryMs: 60_000, maxAttempts: 2,
    liveStateImpl: async () => ({ state: 'CLOSED' }),
    cancelImpl: () => { calls += 1; return { reason: 'cancel-unavailable', error: new Error('HQ down') }; },
    alertImpl: async () => { alerts += 1; }, logger: { error() {} },
  };
  await retryPendingCloserCancels({ ...options, now: '2026-01-01T00:00:00Z' });
  await retryPendingCloserCancels({ ...options, now: '2026-01-01T00:00:30Z' });
  assert.equal(calls, 1);
  await retryPendingCloserCancels({ ...options, now: '2026-01-01T00:01:00Z' });
  await retryPendingCloserCancels({ ...options, now: '2026-01-01T00:02:00Z' });
  assert.equal(calls, 2);
  assert.equal(alerts, 1);
});

test('reopened PR drops queued cancel without touching its live closer', async (t) => {
  const { rootDir, identity } = fixture(t, 14);
  queueCloserCancelForClosedPr({ rootDir, repo: 'o/r', prNumber: 14 });
  const result = await retryPendingCloserCancels({ rootDir,
    liveStateImpl: async () => ({ state: 'OPEN' }),
    cancelImpl: () => { throw new Error('must not cancel'); },
  });
  assert.equal(result.attempted, 0);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
});

test('an exhausted cancel obligation requeues for a different closer head', (t) => {
  const { rootDir, identity } = fixture(t, 15);
  const queuePath = join(rootDir, 'data', 'ama-closer-cancels', 'o__r-pr-15.json');
  queueCloserCancelForClosedPr({ rootDir, repo: 'o/r', prNumber: 15 });
  writeFileSync(queuePath, JSON.stringify({ ...JSON.parse(readFileSync(queuePath, 'utf8')), state: 'exhausted' }));
  updateAmaCloserLease({ rootDir, ...identity, status: 'terminal', terminalOutcome: 'failed-without-merge' });
  acquireAmaCloserLease({ rootDir, repo: 'o/r', prNumber: 15, headSha: 'next' });
  const queued = queueCloserCancelForClosedPr({ rootDir, repo: 'o/r', prNumber: 15 });
  assert.equal(queued.state, 'pending');
  assert.equal(queued.targetHeadSha, 'next');
  assert.equal(queued.attempts, 0);
});

test('active remediation scan skips corrupt and quota-held pending jobs', (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'active-job-scan-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const dir = join(rootDir, 'data', 'follow-up-jobs', 'pending');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a.json'), '{');
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ repo: 'o/r', prNumber: 1,
    remediationPlan: { retryAfter: '2026-10-01T00:00:00Z' } }));
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ repo: 'o/r', prNumber: 2 }));
  const logger = { warn() {} };
  assert.equal(findActiveRemediationJob(rootDir, { repo: 'o/r', prNumber: 1 },
    { logger, now: '2026-09-27T00:00:00Z' }), null);
  assert.equal(findActiveRemediationJob(rootDir, { repo: 'o/r', prNumber: 2 },
    { logger, now: '2026-09-27T00:00:00Z' })?.prNumber, 2);
});

test('pending launch without an id does not exhaust before its lease expiry', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'pending-cancel-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'o/r', prNumber: 13, headSha: 'abc' };
  acquireAmaCloserLease({ rootDir, ...identity, now: '2026-01-01T00:00:00Z' });
  queueCloserCancelForClosedPr({ rootDir, repo: 'o/r', prNumber: 13, now: '2026-01-01T00:00:00Z' });
  const queuePath = join(rootDir, 'data', 'ama-closer-cancels', 'o__r-pr-13.json');
  for (let minute = 1; minute <= 6; minute += 1) {
    await retryPendingCloserCancels({ rootDir, now: `2026-01-01T00:0${minute}:00Z`,
      liveStateImpl: async () => ({ state: 'CLOSED' }),
      maxAttempts: 2, alertImpl: () => { throw new Error('must not alert'); },
    });
  }
  assert.equal(JSON.parse(readFileSync(queuePath, 'utf8')).attempts, 0);
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'pending');
  await retryPendingCloserCancels({ rootDir, now: '2026-01-01T01:00:00Z',
    liveStateImpl: async () => ({ state: 'CLOSED' }),
    maxAttempts: 2, alertImpl: () => { throw new Error('must not alert'); },
  });
  assert.equal(readAmaCloserLease(rootDir, identity), null);
});
