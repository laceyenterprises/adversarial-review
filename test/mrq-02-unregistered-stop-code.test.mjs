// MRQ-02: an unregistered closer stop code is an infrastructure stop. It is
// retried through the existing owned retry (no extra credit), alerted once per
// code per day, and never recorded as stop-reason-unregistered. Retryable
// hammer deferrals name their continuation: a re-drive on the same head.
// Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HAMMER_STOP_ORIGINS, STOP_CODE_UNREGISTERED_EVENT, UNREGISTERED_STOP_CODE, hammerStopOrigin,
  registeredHammerStopOrigin, setUnregisteredStopCodeSink } from '../src/ama/hammer-stop-origin.mjs';
import { HAMMER_RETRYABLE_READ_OUTCOMES, hammerPhaseAttempt, hammerRedriveContinuation,
} from '../src/ama/hammer-phase-outcome.mjs';
import { CloserCorrectionRequired, recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { retryableAmaCloserDeferralOutcome } from '../src/ama/closer-lease.mjs';
import { classifyCloserOutcome } from '../src/ama/closer-inconclusive-retry.mjs';

const REPO = 'synthetic/repo';
const PR = 7;
const HEAD = 'd'.repeat(40);
const LRQ = 'lrq_synthetic-mrq-02';

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'mrq-02-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function captureAlerts(t) {
  const alerts = [];
  t.after(setUnregisteredStopCodeSink(alert => alerts.push(alert)));
  return alerts;
}
const auditEnv = (root, extra = {}) => ({ HAM_HQ_ROOT: root, HAM_REPO: REPO, HAM_PR_NUMBER: String(PR),
  HAM_TARGET_REMEDIATION_SHA: HEAD, HQ_LAUNCH_REQUEST_ID: LRQ, ...extra });

test('an unregistered code classifies as infrastructure instead of throwing', t => {
  captureAlerts(t);
  assert.equal(registeredHammerStopOrigin('synthetic-new-stop'), null);
  assert.equal(hammerStopOrigin('synthetic-new-stop'), 'infrastructure');
  assert.equal(hammerStopOrigin('synthetic-new-stop:detail'), 'infrastructure');
  assert.throws(() => hammerStopOrigin('Not A Code'), /Malformed/);
});

test('an unregistered code alerts once per code per UTC day', t => {
  const alerts = captureAlerts(t);
  const day1 = new Date('2026-10-12T01:00:00Z');
  hammerStopOrigin('synthetic-alpha', { now: day1 });
  hammerStopOrigin('synthetic-alpha:other-detail', { now: new Date('2026-10-12T23:00:00Z') });
  hammerStopOrigin('synthetic-beta', { now: day1 });
  hammerStopOrigin('synthetic-alpha', { now: new Date('2026-10-13T00:01:00Z') });
  assert.deepEqual(alerts, [
    { event: STOP_CODE_UNREGISTERED_EVENT, code: 'synthetic-alpha', day: '2026-10-12' },
    { event: STOP_CODE_UNREGISTERED_EVENT, code: 'synthetic-beta', day: '2026-10-12' },
    { event: STOP_CODE_UNREGISTERED_EVENT, code: 'synthetic-alpha', day: '2026-10-13' },
  ]);
  // Registered codes and side-effect-free reads never alert.
  hammerStopOrigin('legacy-writer-timeout');
  registeredHammerStopOrigin('synthetic-gamma');
  assert.equal(alerts.length, 3);
});

test('a failing alert sink never breaks classification', t => {
  t.after(setUnregisteredStopCodeSink(() => { throw new Error('synthetic sink failure'); }));
  assert.equal(hammerStopOrigin('synthetic-sink-failure'), 'infrastructure');
});

test('the terminal audit records an unknown code as a retried infrastructure deferral, never stop-reason-unregistered', t => {
  const root = scratch(t);
  const alerts = captureAlerts(t);
  // A run directory makes closer faults demand an in-run correction; an
  // infrastructure stop must not.
  const env = auditEnv(root, { HAM_RUN_DIR: root });
  recordHammerEarlyFailure('synthetic-unknown-stop', { env, final: true });
  const entry = readAmaAuditEntry(root, REPO, PR, HEAD);
  const attempt = entry.attempts.at(-1);
  assert.equal(attempt.reason, UNREGISTERED_STOP_CODE);
  assert.equal(attempt.originalReason, 'synthetic-unknown-stop');
  assert.equal(attempt.stopOrigin, 'infrastructure');
  assert.equal(attempt.outcome, 'deferred');
  assert.equal(entry.attempts.some(item => item.reason === 'stop-reason-unregistered'), false);
  assert.deepEqual(attempt.continuation && { ...attempt.continuation, notBefore: typeof attempt.continuation.notBefore },
    { kind: 'redrive', owner: 'watcher', headSha: HEAD, notBefore: 'string', lease: 'fresh' });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].code, 'synthetic-unknown-stop');
  // Retried through the existing owned retry: the same paths as every other
  // registered infrastructure deferral.
  assert.equal(HAMMER_STOP_ORIGINS[UNREGISTERED_STOP_CODE], 'infrastructure');
  assert.equal(HAMMER_RETRYABLE_READ_OUTCOMES.has(UNREGISTERED_STOP_CODE), true);
  assert.equal(retryableAmaCloserDeferralOutcome(attempt), `retryable-${UNREGISTERED_STOP_CODE}`);
  assert.equal(classifyCloserOutcome({ reason: UNREGISTERED_STOP_CODE }).kind, 'inconclusive');
});

test('an unregistered code seen only at launch end keeps the bounded counted path (no extra credit)', t => {
  const alerts = captureAlerts(t);
  assert.deepEqual(classifyCloserOutcome({ reason: 'synthetic-launch-end-code' }),
    { kind: 'real', reason: 'synthetic-launch-end-code', origin: 'unknown' });
  assert.equal(alerts.length, 0);
});

test('world and closer codes keep their origins and terminal audits', t => {
  const root = scratch(t);
  captureAlerts(t);
  assert.equal(hammerStopOrigin('head-changed'), 'world');
  assert.equal(hammerStopOrigin('merge-target-unparseable'), 'closer');
  recordHammerEarlyFailure('head-changed', { env: auditEnv(root), final: true });
  const world = readAmaAuditEntry(root, REPO, PR, HEAD).attempts.at(-1);
  assert.equal(world.outcome, 'failed-without-merge');
  assert.equal(world.stopOrigin, 'world');
  assert.equal(world.continuation, undefined, 'a world refusal names no re-drive');

  const closerRoot = scratch(t);
  const env = auditEnv(closerRoot, { HAM_RUN_DIR: closerRoot });
  assert.throws(() => recordHammerEarlyFailure('merge-target-unparseable', { env, final: true }), CloserCorrectionRequired);
  recordHammerEarlyFailure('merge-target-unparseable', { env, final: true });
  const closer = readAmaAuditEntry(closerRoot, REPO, PR, HEAD).attempts.at(-1);
  assert.equal(closer.reason, 'merge-target-unparseable');
  assert.equal(closer.stopOrigin, 'closer');
  assert.equal(closer.outcome, 'deferred');
  assert.equal(closer.continuation.kind, 'redrive');
});

test('the re-drive continuation is bound to the head and omitted for in-run retries', () => {
  const now = '2026-10-12T01:00:00.000Z';
  assert.deepEqual(hammerPhaseAttempt({ outcome: 'failed-without-merge', reason: 'legacy-writer-timeout' },
    { headSha: HEAD.toUpperCase(), now }).continuation,
  { kind: 'redrive', owner: 'watcher', headSha: HEAD, notBefore: now, lease: 'fresh' });
  assert.equal(hammerPhaseAttempt({ outcome: 'deferred', reason: 'legacy-writer-timeout', inRunRetry: true },
    { headSha: HEAD, now }).continuation, undefined);
  assert.equal(hammerPhaseAttempt({ outcome: 'deferred', reason: 'legacy-writer-timeout' }).continuation, undefined,
    'no head, no continuation');
  const kept = { kind: 'park', owner: 'operator', operatorAction: 'synthetic action' };
  assert.equal(hammerPhaseAttempt({ outcome: 'deferred', reason: 'legacy-writer-timeout', continuation: kept },
    { headSha: HEAD, now }).continuation, kept);
  assert.equal(hammerPhaseAttempt({ outcome: 'failed-without-merge', reason: 'head-changed' },
    { headSha: HEAD, now }).continuation, undefined);
  assert.equal(hammerRedriveContinuation({ headSha: 'not-a-sha' }), null);
});
