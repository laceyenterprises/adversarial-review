import './helpers/rate-limit-state-isolation.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferOverload, isLoadTimeout, MAX_OVERLOAD_DEFERRALS } from '../src/overload-deferral.mjs';
import { evaluateHammerDeferralQueue, recordHammerRetryDispatch, deferHammerRetryDispatch,
  readHammerRetryCapLedger, releaseHammerOverloadDeferral } from '../src/ama/hammer-retry-cap.mjs';
import { observeClosureWait } from '../src/ama/closure-wait.mjs';
import { runHelperStep } from '../bin/hammer-helper-step.mjs';
import { recordHammerEarlyFailure } from '../src/ama/hammer-terminal-audit.mjs';
import { readAmaAuditEntry } from '../src/ama/audit.mjs';
import { acquireMergeLease, releaseMergeLeaseForRetryableAbort } from '../src/ama/merge-lease.mjs';

test('v1 wire vectors match the platform contract without a Python runtime', () => {
  const vector = JSON.parse(readFileSync(new URL('./fixtures/overload-deferral-v1.json', import.meta.url)));
  let previous;
  vector.nextRetryAt.forEach((nextRetryAt, index) => {
    previous = deferOverload(vector.owner, vector.evidence, previous, vector.now);
    const expected = Object.fromEntries(['schemaVersion', 'owner', 'evidence', 'maxDeferrals',
      'outcome', 'alertKey'].map(key => [key, vector[key]]));
    assert.deepEqual(previous, { ...expected, deferralCount: index + 1, nextRetryAt,
      overloadAlert: index + 1 === vector.maxDeferrals });
  });
});

test('shared v1 load classification excludes policy failures and idle deadlines', () => {
  for (const [timedOut, loadMultiplier, deadlineSeconds, scaledBudgetSeconds, expected] of [
    [true, 6, 60, 60, true], [true, 1, 30, 60, true],
    [true, 1, 60, 60, false], [false, 6, 30, 60, false], [true, NaN, 30, 60, false],
  ]) assert.equal(isLoadTimeout({ timedOut, loadMultiplier, deadlineSeconds, scaledBudgetSeconds }), expected);
});

test('closer retains one owner, backs off and stops automatic retries at the overload cap', () => {
  let receipt, now = 1000;
  const evidence = { phase: 'synthetic-read', deadline_seconds: 30,
    scaled_budget_seconds: 180, load_multiplier: 6, load_per_core: 4 };
  for (let count = 1; count <= MAX_OVERLOAD_DEFERRALS; count++) {
    receipt = deferOverload('synthetic-owner', evidence, receipt, now);
    assert.equal(receipt.deferralCount, count);
    assert.equal(receipt.outcome, 'overload-deferred');
    assert.equal(evaluateHammerDeferralQueue({ overloadDeferral: receipt }, new Date(now * 1000).toISOString()).backoff, true);
    if (count < MAX_OVERLOAD_DEFERRALS) {
      now = receipt.nextRetryAt;
      assert.deepEqual(evaluateHammerDeferralQueue({ overloadDeferral: receipt }, new Date(now * 1000).toISOString()),
        { expired: false, backoff: false });
    }
  }
  assert.equal(receipt.overloadAlert, true);
  assert.equal(receipt.nextRetryAt, null);
  assert.equal(evaluateHammerDeferralQueue({ overloadDeferral: receipt }, new Date(1e12).toISOString()).expired, true);
});

test('retry debt survives replacement launches and re-reading the durable ledger', t => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-overload-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = { repo: 'example/project', prNumber: 7 };
  const head = 'a'.repeat(40);
  const evidence = { phase: 'synthetic-read', deadline_seconds: 30,
    scaled_budget_seconds: 180, load_multiplier: 6, load_per_core: 4 };
  for (let count = 1; count <= MAX_OVERLOAD_DEFERRALS; count++) {
    const launchRequestId = `synthetic-${count}`;
    const now = new Date((1000 + count * 600) * 1000).toISOString();
    recordHammerRetryDispatch(root, identity, { jobKey: head, headSha: head, launchRequestId, now });
    const ledger = deferHammerRetryDispatch(root, identity, { jobKey: head, headSha: head,
      launchRequestId, now, leaseWaitExhausted: true, laneBusy: count === 1, overloadEvidence: evidence });
    assert.equal(ledger.overloadDeferral.deferralCount, count);
    assert.equal(readHammerRetryCapLedger(root, identity).overloadDeferral.deferralCount, count);
  }
  const receipt = readHammerRetryCapLedger(root, identity);
  assert.equal(evaluateHammerDeferralQueue(receipt, new Date(1e12).toISOString()).expired, true);
  releaseHammerOverloadDeferral(root, identity);
  const released = readHammerRetryCapLedger(root, identity);
  assert.equal(released.overloadDeferral, null);
  assert.equal(released.lastOverloadDeferral.deferralCount, MAX_OVERLOAD_DEFERRALS);
  assert.deepEqual(evaluateHammerDeferralQueue(released, new Date(1e12).toISOString()),
    { expired: false, backoff: false });
  // An ordinary closer attempt remains charged after release.
  recordHammerRetryDispatch(root, identity, { jobKey: head, headSha: head,
    launchRequestId: 'normal-lane', now: new Date(1e12).toISOString() });
  const before = readHammerRetryCapLedger(root, identity).attemptCount;
  const after = deferHammerRetryDispatch(root, identity, { jobKey: head, headSha: head,
    launchRequestId: 'normal-lane', now: new Date(1e12).toISOString(),
    leaseWaitExhausted: true, overloadEvidence: evidence });
  assert.equal(after.attemptCount, before);
});

test('legacy host-overload callers share one durable host alert', async t => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-overload-alert-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let pages = 0;
  for (const prNumber of [1, 2, 3, 1]) {
    await observeClosureWait({ rootDir: root, repo: 'example/project', prNumber,
      headSha: String(prNumber).repeat(40), reason: 'synthetic load retry exhausted',
      waitClass: 'host-overload', immediate: true, now: 1000000,
      pageImpl: async () => { pages++; return { ok: true }; } });
  }
  assert.equal(pages, 1);
});

test('production overload exhaustion pages once per PR/head across observations', async t => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-overload-pages-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let pages = 0;
  for (const [prNumber, headSha] of [[1, 'a'], [2, 'a'], [1, 'a'], [1, 'b']]) {
    await observeClosureWait({ rootDir: root, repo: 'example/project', prNumber,
      headSha, reason: 'synthetic load retry exhausted',
      waitClass: 'overload-exhausted', immediate: true, now: 1000000,
      pageImpl: async () => { pages++; return { ok: true }; } });
  }
  assert.equal(pages, 3);
});

test('load timeout defers audit, releases the exact lease and recovers without a terminal stop', async t => {
  const root = mkdtempSync(join(tmpdir(), 'synthetic-overload-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const head = 'a'.repeat(40);
  const env = { ...process.env, HAM_HQ_ROOT: root, HAM_RUN_DIR: root,
    HAM_REPO: 'example/project', HAM_PR_NUMBER: '7', HAM_REVIEWED_SHA: head,
    HQ_LAUNCH_REQUEST_ID: 'lrq_synthetic', AGENT_OS_WORKER_LRQ_ID: 'lrq_synthetic',
    LAUNCH_REQUEST_ID: 'lrq_synthetic', HQ_WORKER_RUN_ID: 'wrun_synthetic' };
  const lease = acquireMergeLease({ rootDir: root, repo: env.HAM_REPO, base: 'main',
    holderPr: 7, holderHead: head, holderPid: process.pid, holderHost: 'synthetic-host' });
  assert.equal(lease.acquired, true);
  const options = { budget: () => 6, delay: async () => {},
    stdout: () => {}, stderr: () => {},
    report: (reason, data) => recordHammerEarlyFailure(reason, data) };
  const code = await runHelperStep({ mode: 'read:report', step: 'synthetic-read',
    nominal: 1, ceiling: 6, command: process.execPath, args: ['-e', 'process.exit(124)'], env }, options);
  assert.equal(code, 75);
  const audit = readAmaAuditEntry(root, env.HAM_REPO, 7, head);
  assert.equal(audit.status, 'deferred');
  assert.equal(audit.attempts.at(-1).overloadEvidence.load_multiplier, 6);
  recordHammerEarlyFailure('procedure-step-failed', { env, final: true });
  assert.equal(readAmaAuditEntry(root, env.HAM_REPO, 7, head).status, 'deferred');
  assert.equal(existsSync(join(root, 'dispatch/lrq_synthetic/hammer-progress/wrun_synthetic/terminal-stop.json')), false);
  assert.equal(releaseMergeLeaseForRetryableAbort({ rootDir: root, ...lease.lease,
    retryableAbortReason: 'overload-deferred', requestWatcherWakeImpl: () => ({ ok: true }) }).released, true);
  assert.equal(await runHelperStep({ mode: 'read:report', step: 'synthetic-read',
    nominal: 1, ceiling: 6, command: process.execPath, args: ['-e', 'process.exit(0)'], env }, options), 0);
  assert.equal(existsSync(join(root, 'helper-overload.json')), false);
  // An authoritative refusal remains a real failure even after an observation
  // deferral; the generic wrapper above was not such a refusal.
  recordHammerEarlyFailure('predicate-not-eligible', { env, final: true });
  assert.equal(readAmaAuditEntry(root, env.HAM_REPO, 7, head).status, 'failed-without-merge');
  assert.equal(existsSync(join(root, 'dispatch/lrq_synthetic/hammer-progress/wrun_synthetic/terminal-stop.json')), true);
});
