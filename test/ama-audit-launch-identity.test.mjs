import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import {
  acquireAmaCloserLease,
  readAmaCloserLease,
  updateAmaCloserLease,
} from '../src/ama/closer-lease.mjs';

const cli = fileURLToPath(new URL('../bin/ama-audit.mjs', import.meta.url));
const identity = { repo: 'fixture/repo', prNumber: 21, headSha: 'a'.repeat(40) };
const now = '2026-10-27T00:00:00Z';
const owner = 'lrq_synthetic_closer';
const cases = [
  ['canonical identity', { HQ_LAUNCH_REQUEST_ID: owner }, owner, true],
  ['identical aliases', { HQ_LAUNCH_REQUEST_ID: owner, AGENT_OS_WORKER_LRQ_ID: owner, LAUNCH_REQUEST_ID: owner }, owner, true],
  ['conflicting canonical and legacy IDs', { HQ_LAUNCH_REQUEST_ID: owner, LAUNCH_REQUEST_ID: 'lrq_other' }, owner, false],
  ['conflicting IDs with terminal remediation', { HQ_LAUNCH_REQUEST_ID: owner, AGENT_OS_WORKER_LRQ_ID: 'lrq_other' }, owner, false, { reason: 'github-gate-read-failed' }, true],
  ['conflicting canonical and fallback IDs', { HQ_LAUNCH_REQUEST_ID: owner, AGENT_OS_WORKER_LRQ_ID: 'lrq_other', LAUNCH_REQUEST_ID: 'lrq_third' }, owner, false],
  ['conflicting worker and legacy IDs', { AGENT_OS_WORKER_LRQ_ID: owner, LAUNCH_REQUEST_ID: 'lrq_other' }, owner, false],
  ['legacy fallback', { LAUNCH_REQUEST_ID: owner }, owner, true],
  ['missing identity', {}, null, false],
  ['different owner', { AGENT_OS_WORKER_LRQ_ID: 'lrq_successor' }, 'lrq_successor', false],
  ['worker fallback overrides JSON', { AGENT_OS_WORKER_LRQ_ID: owner }, owner, true, { launchRequestId: 'lrq_input_launch' }],
  ['legacy fallback overrides JSON', { LAUNCH_REQUEST_ID: owner }, owner, true, { launchRequestId: 'lrq_input_launch' }],
  ['JSON identity retained without environment identity', {}, 'lrq_input_launch', false, { launchRequestId: 'lrq_input_launch' }],
  ['JSON matching owner cannot authorize release', {}, owner, false, { launchRequestId: owner }],
  ['worker fallback with mapped terminal remediation', { AGENT_OS_WORKER_LRQ_ID: owner }, owner, true, { reason: 'github-gate-read-failed' }, true],
  ['legacy fallback with mapped terminal remediation', { LAUNCH_REQUEST_ID: owner }, owner, true, { reason: 'github-gate-read-failed' }, true],
];

for (const command of ['init', 'append']) {
  for (const [name, environment, expectedId, expectRelease, context = {}, terminalRemediation = false] of cases) {
    test(`ama-audit ${command}: ${name} binds metadata and retryable release`, t => {
      const rootDir = mkdtempSync(join(tmpdir(), 'ama-audit-launch-'));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      acquireAmaCloserLease({ rootDir, ...identity, now });
      updateAmaCloserLease({ rootDir, ...identity, now, status: 'dispatched', lrqId: owner });
      const before = readAmaCloserLease(rootDir, identity);
      const attemptPath = join(rootDir, 'attempt.json');
      const reason = context.reason || 'required-checks-pending';
      writeFileSync(attemptPath, JSON.stringify({ reason, ...context }));
      const result = spawnSync(process.execPath, [cli, command,
        '--hq-root', rootDir, '--root-dir', rootDir,
        '--repo', identity.repo, '--pr', String(identity.prNumber), '--head', identity.headSha,
        '--outcome', terminalRemediation ? 'failed-without-merge' : 'deferred',
        '--attempt-json', attemptPath, '--now', now,
        ...(terminalRemediation ? ['--closure-authority', 'ham-terminal-remediation'] : []),
      ], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, HQ_LAUNCH_REQUEST_ID: '', AGENT_OS_WORKER_LRQ_ID: '', LAUNCH_REQUEST_ID: '', ...environment },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const audit = readAmaAuditEntry(rootDir, identity.repo, identity.prNumber, identity.headSha);
      assert.equal(audit.attempts.at(-1).launchRequestId, expectedId ?? undefined);
      assert.equal(audit.attempts.at(-1).outcome, 'deferred');
      assert.equal(audit.status, 'deferred');
      const receipt = readAmaCloserLease(rootDir, identity);
      if (expectRelease) {
        assert.equal(receipt.status, 'terminal');
        assert.equal(receipt.terminalOutcome, `retryable-${reason}`);
        assert.equal(receipt.lrqId, owner);
      } else {
        assert.deepEqual(receipt, before, 'unidentified, ambiguous, or different launches preserve ownership');
      }
    });
  }
}
