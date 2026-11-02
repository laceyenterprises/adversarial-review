import './helpers/rate-limit-state-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { HAMMER_RETRYABLE_READ_OUTCOMES, hammerPhaseAttempt } from '../src/ama/hammer-phase-outcome.mjs';
import { recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { readAmaAuditEntry, writeAmaAuditEntry } from '../src/ama/audit.mjs';
import { releaseControllerLease } from '../src/ama/hammer-controller.mjs';
import { acquireAmaCloserLease, updateAmaCloserLease, readAmaCloserLease,
  releaseRetryableAmaCloserLease, retryableAmaCloserDeferralOutcome } from '../src/ama/closer-lease.mjs';
import { deriveNextActionSnapshot, nextAction } from '../src/pr-next-action.mjs';
import { renderHammerProcedure } from '../src/hammer-procedure.mjs';
import { recordHammerRetryDispatch, readHammerRetryCapLedger } from '../src/ama/hammer-retry-cap.mjs';

const head = 'a'.repeat(40);
const at = '2026-01-01T00:00:00.000Z';
const identity = { repo: 'fixture/repo', prNumber: 42, headSha: head };
const launchRequestId = 'lrq_fixture';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'verifyheadtransient-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function decision(retryable) {
  return nextAction(deriveNextActionSnapshot({ subjectKey: 'fixture/repo#42', head, observedAt: at,
    anchors: { firstActionableAt: at }, observations: {
      pr: { headSha: head, state: 'OPEN', mergeable: 'MERGEABLE', labels: [] },
      reviews: { verdict: 'approved', headSha: head, blockingFindingState: 'known', blockingFindingCount: 0,
        nonBlockingFindingState: 'known', nonBlockingFindingCount: 0 },
      checks: { conclusion: 'SUCCESS' }, remediation: { roundsLeft: false },
      leases: { closer: null }, launches: { closer: { headSha: head, status: 'failed',
        outcome: 'no-merge', retryable, launchRequestId } },
      policy: { autonomousMergeExecutionEnabled: true, strictMode: true },
    } }));
}

for (const reason of HAMMER_RETRYABLE_READ_OUTCOMES) {
  test(`VERIFYHEADTRANSIENT-01: ${reason} retains a retry owner and deadline`, t => {
    const rootDir = fixture(t);
    const env = { HAM_HQ_ROOT: rootDir, HAM_REPO: identity.repo, HAM_PR_NUMBER: '42',
      HAM_TARGET_REMEDIATION_SHA: head, HQ_LAUNCH_REQUEST_ID: launchRequestId };
    acquireAmaCloserLease({ rootDir, ...identity, now: at });
    updateAmaCloserLease({ rootDir, ...identity, status: 'dispatched', lrqId: launchRequestId, now: at });
    recordHammerEarlyFailure(reason, { env });
    const audit = readAmaAuditEntry(rootDir, identity.repo, 42, head);
    assert.equal(audit.status, 'deferred');
    const attempt = audit.attempts.at(-1);
    assert.equal(attempt.reason, reason);
    assert.equal(releaseRetryableAmaCloserLease({ rootDir, ...identity, launchRequestId, attempt }), true);
    assert.equal(readAmaCloserLease(rootDir, identity).terminalOutcome, `retryable-${reason}`);
    const selected = decision(Boolean(retryableAmaCloserDeferralOutcome(attempt)));
    assert.equal(selected.row, 'R08-retry', JSON.stringify(selected));
    assert.equal(selected.actor, 'hammer');
    assert.ok(selected.deadline);
    assert.equal(selected.queue.intent, 'dispatch');
    assert.notEqual(selected.reason, 'hammer-final-no-merge');
  });
}

for (const reason of ['github-gate-red', 'predicate-not-eligible', 'rebase-conflict',
  'head-changed', 'controller-cancelled', 'controller-owner-lost',
  'protective-predecessor-open', 'protective-predecessor-state-unreadable']) {
  test(`VERIFYHEADTRANSIENT-01: adjudicated ${reason} remains final`, t => {
    const rootDir = fixture(t);
    recordHammerEarlyFailure(reason, { env: { HAM_HQ_ROOT: rootDir, HAM_REPO: identity.repo,
      HAM_PR_NUMBER: '42', HAM_TARGET_REMEDIATION_SHA: head } });
    assert.equal(readAmaAuditEntry(rootDir, identity.repo, 42, head).status, 'failed-without-merge');
    assert.equal(decision(false).reason, 'hammer-final-no-merge');
    assert.equal(hammerPhaseAttempt({ outcome: 'succeeded', reason }).outcome, 'succeeded');
    assert.equal(hammerPhaseAttempt({ outcome: 'failed-without-merge',
      reason: `${reason}:connection-timeout` }).outcome, 'failed-without-merge');
  });
}

for (const reason of ['github-gate-red', 'predicate-not-eligible']) {
  test(`VERIFYHEADTRANSIENT-01: ${reason} retains its adjudication charge`, t => {
    const rootDir = fixture(t);
    recordHammerRetryDispatch(rootDir, identity, {
      jobKey: head, headSha: head, launchRequestId, now: at,
    });
    recordHammerEarlyFailure(reason, { env: { HAM_HQ_ROOT: rootDir, HAM_REPO: identity.repo,
      HAM_PR_NUMBER: '42', HAM_TARGET_REMEDIATION_SHA: head } });
    const attempt = readAmaAuditEntry(rootDir, identity.repo, 42, head).attempts.at(-1);
    assert.equal(retryableAmaCloserDeferralOutcome(attempt), null);
    const ledger = readHammerRetryCapLedger(rootDir, identity);
    assert.equal(ledger.attemptCount, 1);
    assert.equal(ledger.targetAttemptCount, 1);
    assert.equal(ledger.lifetimeAttemptCount, 1);
    assert.equal(decision(false).reason, 'hammer-final-no-merge');
  });
}

for (const reason of ['controller-cancelled', 'controller-owner-lost', 'head-changed',
  'rebase-conflict', 'github-gate-red', 'predicate-not-eligible']) {
  test(`VERIFYHEADTRANSIENT-01: later ${reason} supersedes a read abort`, t => {
    const rootDir = fixture(t);
    const env = { HAM_HQ_ROOT: rootDir, HAM_REPO: identity.repo,
      HAM_PR_NUMBER: '42', HAM_TARGET_REMEDIATION_SHA: head, HQ_LAUNCH_REQUEST_ID: launchRequestId };
    recordHammerEarlyFailure('merge-lease-base-read-failed', { env });
    recordHammerEarlyFailure('procedure-step-failed', { env, final: true });
    assert.equal(readAmaAuditEntry(rootDir, identity.repo, 42, head).status, 'deferred');
    recordHammerEarlyFailure(reason, { env, final: true });
    const audit = readAmaAuditEntry(rootDir, identity.repo, 42, head);
    assert.equal(audit.status, 'failed-without-merge');
    assert.equal(audit.attempts.at(-1).reason, reason);
    assert.equal(retryableAmaCloserDeferralOutcome(audit.attempts.at(-1)), null);
  });
}

test('VERIFYHEADTRANSIENT-01: merge audit CLI uses the same retryable classification', t => {
  const rootDir = fixture(t), path = join(rootDir, 'attempt.json');
  writeFileSync(path, JSON.stringify({ reason: 'github-gate-read-failed' }));
  const result = spawnSync(process.execPath, ['bin/ama-audit.mjs', 'append', '--hq-root', rootDir,
    '--repo', identity.repo, '--pr', '42', '--head', head, '--outcome', 'failed-without-merge',
    '--closure-authority', 'ham-terminal-remediation', '--attempt-json', path], {
    cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readAmaAuditEntry(rootDir, identity.repo, 42, head).status, 'deferred');
});

test('VERIFYHEADTRANSIENT-01: phase release uses retryable abort and preserves final releases', t => {
  const rootDir = fixture(t);
  const raw = readFileSync(new URL('../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
  const release = raw.slice(raw.indexOf('ham_mark_merge_lease_retryable_abort()'),
    raw.indexOf('\n# Read the full stderr'));
  assert.ok(release.includes('ham_release_merge_lease()'));
  const rendered = renderHammerProcedure('hammer-verify-head', Object.fromEntries(
    ['REPO', 'PR_NUMBER', 'HQ_ROOT', 'TARGET_REMEDIATION_SHA', 'ROOT_DIR', 'RUN_DIR',
      'REVIEWED_SHA', 'REVIEWER', 'RISK_CLASS', 'PR_URL'].map(key => [key, 'fixture'])));
  const classifier = rendered.slice(rendered.indexOf('ham_phase_read_retryable()'),
    rendered.indexOf('\nham_record_phase_failure()'));
  const runtime = join(rootDir, 'runtime');
  writeFileSync(runtime, '#!/bin/bash\nprintf "%s\\n" "$@" > "$RELEASE_ARGS"\n', { mode: 0o755 });
  for (const reason of [...HAMMER_RETRYABLE_READ_OUTCOMES, 'github-gate-red', 'head-changed']) {
    const file = join(rootDir, 'phase.sh'), argsPath = join(rootDir, 'args');
    writeFileSync(file, `${classifier}\n${release.replaceAll('<<RUN_DIR>>', rootDir)
  .replaceAll('<<ROOT_DIR>>', rootDir).replaceAll('<<REPO>>', identity.repo).replaceAll('<<PR_NUMBER>>', '42')}
HAM_NODE_BIN='${runtime}'
HAM_PHASE_OUTCOME='${reason}'
HAM_MERGE_LEASE_HELD=1 HAM_MERGE_LEASE_ID=fixture HAM_MERGE_LEASE_RELEASE_RETRY_CAP=1
BASE_BRANCH=main
ham_release_merge_lease
`);
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', file], {
      encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH, RELEASE_ARGS: argsPath },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(argsPath, 'utf8');
    if (HAMMER_RETRYABLE_READ_OUTCOMES.has(reason)) assert.ok(args.includes(`--retryable-abort\n${reason}`), args);
    else assert.ok(args.includes(`--reason\n${reason}`), args);
  }
});

test('VERIFYHEADTRANSIENT-01: controller fallback refunds only the drained matching read abort', t => {
  const rootDir = fixture(t), startedAt = at, acquiredAt = '2026-01-01T00:00:01Z';
  const env = { HAM_HQ_ROOT: rootDir, HAM_RUN_DIR: rootDir, HAM_ROOT_DIR: rootDir,
    HAM_REPO: identity.repo, HAM_PR_NUMBER: '42', HQ_LAUNCH_REQUEST_ID: launchRequestId };
  const holder = { holderPr: 42, holderPid: 12345, holderHead: head,
    holderHost: hostname(), leaseId: 'fixture-lease', acquiredAt };
  writeFileSync(join(rootDir, 'merge-lease-acquire.json'), JSON.stringify({
    acquired: true, key: 'fixture/repo::main', holder: 42, ...holder,
  }));
  for (const reason of ['controller-observation-unavailable', 'controller-cancelled', 'controller-owner-lost']) {
    writeAmaAuditEntry({ hqRoot: rootDir, ...identity,
      attempt: hammerPhaseAttempt({ outcome: 'failed-without-merge', reason, launchRequestId }) });
    for (const terminationReason of ['shell-exited', 'launch-ended']) {
      const result = releaseControllerLease({ env, shellPid: 12345, startedAt, drained: true,
        terminationReason, inspectImpl: () => ({ holder }),
        releaseImpl: () => 'final', releaseRetryableImpl: args => args.retryableAbortReason });
      assert.equal(result, reason === 'controller-observation-unavailable' && terminationReason === 'shell-exited'
        ? reason : 'final');
    }
  }
});

test('VERIFYHEADTRANSIENT-01: admission and merge distinguish observation failure from lost ownership', t => {
  const rootDir = fixture(t);
  const raw = readFileSync(new URL('../bin/hammer-verify-head.sh', import.meta.url), 'utf8');
  const admission = raw.slice(raw.indexOf('ham_acquire_merge_lease()'),
    raw.indexOf('  local ham_lease_wait_retry='));
  const merge = readFileSync(new URL('../bin/hammer-merge.sh', import.meta.url), 'utf8');
  const click = merge.slice(merge.indexOf('  # A canceled or parked launch never merges.'),
    merge.indexOf('  # CLEAN and non-strict heads skip'));
  for (const body of [admission, `ham_acquire_merge_lease() {\n${click}`]) {
    for (const status of [75, 125]) {
      const file = join(rootDir, 'admission.sh');
      writeFileSync(file, `${body}\n}
runtime() { return ${status}; }
ham_append_terminal_audit() { :; }
ham_release_merge_lease() { :; }
HAM_NODE_BIN=runtime
HQ_LAUNCH_REQUEST_ID=lrq_fixture
ham_acquire_merge_lease
printf '%s' "$HAM_PHASE_OUTCOME"
`);
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', file], {
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, status === 75 ? 'controller-observation-unavailable' : 'controller-owner-lost');
    }
  }
});
