import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireAmaCloserLease, readAmaCloserLease, updateAmaCloserLease } from '../src/ama/closer-lease.mjs';
import { cancelCloserForTerminalPr } from '../src/ama/closer-terminal-cancel.mjs';
import { amaCloserDispatchFilePath } from '../src/ama/dispatch-closer.mjs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

test('merged PR cancels in-flight closer and terminalizes lease', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-terminal-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'o/r', prNumber: 7, headSha: 'abc' };
  acquireAmaCloserLease({ rootDir, ...identity });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_7' });
  const dispatchPath = amaCloserDispatchFilePath(rootDir, identity);
  mkdirSync(dirname(dispatchPath), { recursive: true });
  writeFileSync(dispatchPath, JSON.stringify({ ...identity, launchRequestId: 'lrq_7' }));
  const calls = [];
  const result = await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 7, transition: 'merged', hqPath: '/mock/hq',
    accessImpl: () => {}, execFileImpl: async (...args) => { calls.push(args); },
    logger: { log() {} },
  });
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls[0][1].slice(0, 3), ['dispatch', 'cancel', 'lrq_7']);
  assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, 'pr-merged-externally');
  assert.equal(JSON.parse(readFileSync(dispatchPath, 'utf8')).outcome, 'no-merge:pr-merged-externally');
});

test('standalone installation skips unavailable HQ cancellation without releasing live ownership', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'hammer-standalone-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: 'o/r', prNumber: 8, headSha: 'def' };
  acquireAmaCloserLease({ rootDir, ...identity });
  updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_8' });
  const warnings = [];
  const result = await cancelCloserForTerminalPr({
    rootDir, repo: 'o/r', prNumber: 8, transition: 'closed',
    accessImpl: () => { throw new Error('HQ unavailable'); },
    logger: { warn: (value) => warnings.push(value) },
  });
  assert.equal(result.reason, 'cancel-unavailable');
  assert.equal(readAmaCloserLease(rootDir, identity).status, 'dispatched');
  assert.match(warnings[0], /HQ unavailable/);
});

test('terminal or missing HQ dispatch response still releases the closer lease', async (t) => {
  for (const reason of ['already terminal (status=failed)', 'not found']) {
    const rootDir = mkdtempSync(join(tmpdir(), 'hammer-hq-terminal-'));
    t.after(() => rmSync(rootDir, { recursive: true, force: true }));
    const identity = { repo: 'o/r', prNumber: 9, headSha: 'ghi' };
    acquireAmaCloserLease({ rootDir, ...identity });
    updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: 'lrq_9' });
    const result = await cancelCloserForTerminalPr({
      rootDir, repo: 'o/r', prNumber: 9, transition: 'closed',
      accessImpl: () => {},
      execFileImpl: async () => ({ stdout: JSON.stringify({ ok: false, reason }) }),
      logger: { log() {} },
    });
    assert.equal(result.outcome, 'pr-closed-externally');
    assert.equal(readAmaCloserLease(rootDir, identity).status, 'terminal');
  }
});
