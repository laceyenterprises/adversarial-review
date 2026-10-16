import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readReviewerEvidenceInWorker } from '../src/reviewer-token-ledger-lookup.mjs';
import { readBestReviewerEvidenceTokenUsage } from '../src/reviewer-pass-tokens.mjs';
import { runBoundedReviewerDispatchQueue } from '../src/watcher-reviewer-pool.mjs';
import { createSessionLedgerDb } from './helpers/session-ledger-fixtures.mjs';

const workerUrl = new URL('./fixtures/reviewer-token-ledger/worker.mjs', import.meta.url);

test('SEATIDLE-03: synchronous ledger work cannot block the next reviewer admission', { timeout: 5000 }, async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'seatidle-blocked-reader-'));
  const releasePath = path.join(rootDir, 'release');
  let notifyReady;
  const ready = new Promise(resolve => { notifyReady = resolve; });
  let finished = false;
  const lookup = readReviewerEvidenceInWorker({ releasePath }, { workerUrl, onReady: notifyReady })
    .then(usage => { finished = true; return usage; });
  try {
    await ready;
    let started = false;
    await runBoundedReviewerDispatchQueue([{ repoPath: 'example/review-fixture', prNumber: 202,
      reviewerModel: 'codex', async run() { started = true; } }], { maxConcurrent: 1 });
    assert.equal(started, true);
    assert.equal(finished, false, 'the synchronous lookup remains blocked while admission runs');
  } finally {
    writeFileSync(releasePath, 'release');
    assert.deepEqual(await lookup, { input: 7 });
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('worker preserves the existing evidence reader result on an offline ledger', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'seatidle-ledger-worker-'));
  try {
    const ledgerDbPath = path.join(rootDir, 'synthetic-ledger.db');
    createSessionLedgerDb(ledgerDbPath);
    const args = { rootDir, ledgerDbPath, launchRequestId: 'lrq_1', transcriptFallback: false };
    assert.deepEqual(await readReviewerEvidenceInWorker(args), readBestReviewerEvidenceTokenUsage(args));
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

for (const [action, expected, timeoutMs] of [
  ['error', /synthetic reader failure/, 5000],
  ['exit', /exited without evidence/, 5000],
  ['timeout', /timed out/, 100],
]) test(`worker ${action} settles accounting without an orphan`, async () => {
  await assert.rejects(readReviewerEvidenceInWorker({ action }, { workerUrl, timeoutMs }), expected);
});


test('successful evidence exits naturally without racing a process-group signal', async () => {
  let groupSignals = 0;
  const result = await readReviewerEvidenceInWorker({ action: 'reply' }, { workerUrl,
    killProcessGroup() { groupSignals++; throw Object.assign(new Error('synthetic refused signal'), { code: 'EPERM' }); } });
  assert.deepEqual(result, { input: 7 });
  assert.equal(groupSignals, 0);
});

test('a refused group signal still reaps a timed-out reader and reports the timeout', async () => {
  await assert.rejects(readReviewerEvidenceInWorker({ action: 'timeout' }, { workerUrl, timeoutMs: 100,
    killProcessGroup() { throw Object.assign(new Error('synthetic refused signal'), { code: 'EPERM' }); } }), /timed out/);
});
