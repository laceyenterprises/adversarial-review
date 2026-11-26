import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateHammerStopHold, readHammerStopForHead } from '../src/ama/hammer-stop-hold.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';

for (const history of [false, true]) test(`protected-head display spans preserve legacy refusal identity (history=${history})`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'insertion-stop-hold-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const headSha = 'c'.repeat(40);
  const evidence = primaryChangeFixture(headSha);
  const path = 'src/example.mjs';
  evidence.primaryFiles = [{ filename: path, status: 'modified', additions: 1, deletions: 0,
    patch: '@@ -1,0 +2 @@\n+protected();' }];
  evidence.finalFiles = [];
  if (history) evidence.revertedRegionDiagnostics = [{ path, start: 2, end: 2, commits: [] }];
  const current = checkPrimaryChange(evidence, headSha).missingEvidence;
  assert.ok(current.primaryHeadInsertions);
  assert.ok(current.summary.includes('. Protected insertion on '));
  const legacy = { ...current };
  delete legacy.primaryHeadInsertions;
  legacy.summary = `no verified Reversal-Authorized-By covers the reverted ${path} region (0 verified)`
    + (history ? '; region history: 2-2: unavailable' : '');
  let missingEvidence = legacy;
  const args = { rootDir, hqRoot: rootDir, repo: 'fixture/repo', prNumber: 1, headSha,
    now: '2026-01-01T00:00:00.000Z', reviewServiceRevision: 'fixture-stable-revision',
    readAuditImpl: () => ({ attempts: [{ outcome: 'failed-without-merge', reason: 'primary-change-reverted',
      head: headSha, path: 'hammer', startedAt: '2026-01-01T00:00:00.000Z', missingEvidence }] }),
    prMetadata: { headSha, baseSha: 'd'.repeat(40), isOpen: true, mergeableState: 'MERGEABLE',
      statusCheckRollup: [{ name: 'synthetic-unit', conclusion: 'SUCCESS' }] },
    fetchPrimaryChangeImpl: async () => evidence,
    deliverAlertImpl: async () => {}, logger: { log() {}, warn() {}, error() {} },
  };
  const key = readHammerStopForHead(args).refusal.key;
  // A legacy audit and the new live probe differ only in display diagnostics.
  assert.equal((await evaluateHammerStopHold(args)).action, 'hold');
  missingEvidence = current;
  assert.equal(readHammerStopForHead(args).refusal.key, key);
  assert.deepEqual(readHammerStopForHead(args).refusal.missingEvidence, legacy);
  assert.equal((await evaluateHammerStopHold({ ...args, now: '2026-01-01T00:01:00.000Z' })).action, 'hold');
  // Original merge-base coordinates still participate in refusal identity.
  evidence.primaryFiles[0].patch = '@@ -2,0 +3 @@\n+protected();';
  const changed = checkPrimaryChange(evidence, headSha).missingEvidence;
  missingEvidence = changed;
  assert.notEqual(readHammerStopForHead(args).refusal.key, key);
  missingEvidence = current;
  const released = await evaluateHammerStopHold({ ...args, now: '2026-01-01T00:02:00.000Z' });
  assert.equal(released.action, 'release');
  assert.ok(released.changed.includes('primary-change-evidence'));
});
