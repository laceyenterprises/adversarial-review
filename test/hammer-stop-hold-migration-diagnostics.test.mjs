import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateHammerStopHold, readHammerStopForHead } from '../src/ama/hammer-stop-hold.mjs';
import { checkPrimaryChange } from '../src/ama/primary-change.mjs';
import { primaryChangeFixture } from './helpers/primary-change.mjs';

for (const legacy of [false, true]) test(`transient migration diagnostics preserve stop identity and hold (legacy=${legacy})`, async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'migration-stop-hold-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const headSha = 'c'.repeat(40);
  const evidence = primaryChangeFixture(headSha);
  evidence.finalFiles = [];
  const missing = checkPrimaryChange(evidence, headSha).missingEvidence;
  const diagnostic = reason => [{ proven: false, reason, headSha, detail: `transient ${reason}` }];
  const identity = { rootDir, hqRoot: rootDir, repo: 'fixture/repo', prNumber: 1, headSha };
  let reason = 'deadline-exceeded';
  const args = { ...identity, now: '2026-01-01T00:00:00.000Z',
    reviewServiceRevision: 'fixture-stable-revision',
    readAuditImpl: () => ({ attempts: [{ outcome: 'failed-without-merge', reason: 'primary-change-reverted',
      head: headSha, path: 'hammer', startedAt: '2026-01-01T00:00:00.000Z',
      migrationRenumberDiagnostics: diagnostic(reason),
      missingEvidence: { ...missing, ...(legacy ? { migrationRenumberDiagnostics: diagnostic(reason),
        summary: `${missing.summary}; migration renumber proof: ${reason} (transient ${reason})` } : {}) } }] }),
    prMetadata: { headSha, baseSha: 'd'.repeat(40), isOpen: true, mergeableState: 'MERGEABLE',
      statusCheckRollup: [{ name: 'synthetic-unit', conclusion: 'SUCCESS' }] },
    fetchPrimaryChangeImpl: async () => ({ ...evidence, migrationRenumberDiagnostics: diagnostic(reason) }),
    deliverAlertImpl: async () => {}, logger: { log() {}, warn() {}, error() {} },
  };
  const key = readHammerStopForHead(args).refusal.key;
  assert.equal((await evaluateHammerStopHold(args)).action, 'hold');
  reason = 'snapshot-read-failed';
  assert.equal(readHammerStopForHead(args).refusal.key, key);
  assert.deepEqual(readHammerStopForHead(args).refusal.missingEvidence, missing);
  assert.equal((await evaluateHammerStopHold({ ...args, now: '2026-01-01T00:01:00.000Z' })).action, 'hold');
  evidence.finalFiles = evidence.primaryFiles;
  const released = await evaluateHammerStopHold({ ...args, now: '2026-01-01T00:02:00.000Z' });
  assert.equal(released.action, 'release');
  assert.ok(released.changed.includes('primary-change-evidence'));
});
