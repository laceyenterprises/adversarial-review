import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { cancelCloserForTerminalPr } from '../src/ama/closer-terminal-cancel.mjs';
import { amaCloserDispatchFilePath, isActiveAmaCloserDispatchRecord } from '../src/ama/dispatch-closer.mjs';

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
    rootDir, repo: 'o/r', prNumber: 7, transition: 'merged', live: { headRefOid: 'abc' },
    execFileImpl: () => { throw new Error('must not cancel'); },
  });
  assert.equal(result.outcome, 'succeeded');
  assert.equal(result.cancelled, false);
  assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'succeeded');
  assert.equal(JSON.parse(readFileSync(dispatchPath, 'utf8')).lastObservedStatus, 'succeeded');
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
