import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readAmaAuditEntry } from '../../src/ama/audit.mjs';
import {
  acquireAmaCloserLease,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../../src/ama/closer-lease.mjs';

// Kept under bin to respect this findings batch's bin-only edit scope.
// Run offline with: node --test bin/test/ama-audit.test.mjs
const cli = fileURLToPath(new URL('../ama-audit.mjs', import.meta.url));
const identity = { repo: 'fixture/repo', prNumber: 21, headSha: 'a'.repeat(40) };
const now = '2026-10-27T00:00:00Z';
const owner = 'synthetic-closer';
const cases = [
  ['canonical wins', { HQ_LAUNCH_REQUEST_ID: owner, AGENT_OS_WORKER_LRQ_ID: 'other', LAUNCH_REQUEST_ID: 'third' }, owner],
  ['worker fallback wins', { AGENT_OS_WORKER_LRQ_ID: owner, LAUNCH_REQUEST_ID: 'other' }, owner],
  ['legacy fallback', { LAUNCH_REQUEST_ID: owner }, owner],
  ['missing identity', {}, null],
  ['different owner', { AGENT_OS_WORKER_LRQ_ID: 'successor' }, 'successor'],
];

for (const command of ['init', 'append']) {
  for (const [name, environment, expectedId] of cases) {
    test(`ama-audit ${command}: ${name} binds metadata and retryable release`, t => {
      const rootDir = mkdtempSync(join(tmpdir(), 'ama-audit-launch-'));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      acquireAmaCloserLease({ rootDir, ...identity, now });
      updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: owner });
      const before = readAmaCloserLease(rootDir, identity);
      const attemptPath = join(rootDir, 'attempt.json');
      writeFileSync(attemptPath, JSON.stringify({ reason: 'required-checks-pending' }));
      const result = spawnSync(process.execPath, [cli, command,
        '--hq-root', rootDir, '--root-dir', rootDir,
        '--repo', identity.repo, '--pr', String(identity.prNumber), '--head', identity.headSha,
        '--outcome', 'deferred', '--attempt-json', attemptPath, '--now', now,
      ], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HQ_LAUNCH_REQUEST_ID: '', AGENT_OS_WORKER_LRQ_ID: '', LAUNCH_REQUEST_ID: '', ...environment },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const audit = readAmaAuditEntry(rootDir, identity.repo, identity.prNumber, identity.headSha);
      assert.equal(audit.attempts.at(-1).launchRequestId, expectedId ?? undefined);
      const receipt = readAmaCloserLease(rootDir, identity);
      if (expectedId === owner) {
        assert.equal(receipt.status, 'terminal');
        assert.equal(receipt.terminalOutcome, 'retryable-required-checks-pending');
        assert.equal(receipt.lrqId, owner);
      } else {
        assert.deepEqual(receipt, before, 'unidentified or different launches preserve ownership');
      }
    });
  }
}
