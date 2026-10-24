import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  underMaxLoad, assertTimerCeiling, assertScaledOnce, FakeClock, runConcurrently, MAX_TIMER_DELAY_MS,
} from './helpers/load-time-kit.mjs';
import { loadAwareTimeoutMs, timerDelayMs } from '../src/load-aware-timeout.mjs';
import { reconcilePreReceiptIntent } from '../src/ama/pre-receipt-intent.mjs';
import { amaCloserDispatchFilePath, readAmaCloserDispatchRecord } from '../src/ama/dispatch-record-read.mjs';
import { acquireMergeLease, acquireDaemonMergeLease, releaseMergeLease, readMergeLeaseWaiters } from '../src/ama/merge-lease.mjs';
import {
  DEFAULT_REVIEWER_TIMEOUT_MS, AGY_CHUNK_TIMEOUT_SLACK_MS, AGY_CHUNK_TIMEOUT_CAP_MS, REVIEWER_PROCESS_SLACK_MS,
  resolveAgyChunkTimeoutPlan, resolveAgyChunkTimeoutCapMs, resolveGeminiReviewerProcessTimeoutMs,
} from '../src/reviewer-timeout.mjs';

function freshRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'load-time-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const maxMultiplier of [6, 20]) {
  test(`CLOSERINTENT-01: a receipt taking over one second recovers at maximum load x${maxMultiplier}`, async t => {
    const multiplier = underMaxLoad(t, { maxMultiplier });
    const rootDir = freshRoot(t);
    const clock = new FakeClock(t);
    const identity = { repo: 'example/project', prNumber: 7, headSha: 'a'.repeat(40) };
    const key = 'synthetic-closer-key';
    const path = amaCloserDispatchFilePath(rootDir, identity);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1, ...identity, state: 'dispatching', workerClass: 'hammer',
      dispatchPhase: 'submitting', dispatchIdempotencyKey: key, retryCount: 1,
      lastAttemptedAt: new Date(clock.time() - 600_001).toISOString(), dispatchTimeoutMs: 600_000,
    }));
    const budgets = [];
    const pending = reconcilePreReceiptIntent(rootDir, identity, {
      prMetadata: { state: 'OPEN' }, env: {},
      deliverAlertImpl: async () => assert.fail('receipt recovery must not page'),
      readIntentReceiptImpl: ({ timeoutMs }) => {
        budgets.push(timeoutMs);
        let deadline, response;
        return new Promise(resolve => {
          deadline = setTimeout(() => resolve({ ok: false, reason: 'synthetic-timeout' }), timeoutMs);
          response = setTimeout(() => resolve({ ok: true, rows: [{
            launch_request_id: 'lrq_synthetic', idempotency_key: key, ticket_ref: 'AMA-PR-7',
            target_repo: identity.repo, head_sha: identity.headSha,
          }] }), 1500);
        }).finally(() => { clearTimeout(deadline); clearTimeout(response); });
      },
    });
    await clock.advance(1001);
    assert.equal(readAmaCloserDispatchRecord(rootDir, identity).state, 'dispatching');
    await clock.advance(499);
    const result = await pending;
    assert.equal(result.status, 'receipt-recovered');
    assert.equal(budgets.length, 1);
    assertScaledOnce(budgets[0], { baseMs: 30_000, multiplier });
    const record = readAmaCloserDispatchRecord(rootDir, identity);
    assert.equal(record.launchRequestId, 'lrq_synthetic');
    assert.equal(record.preReceiptReconciliation.query.timeoutMs, budgets[0]);
  });

  test(`GEMTIMEOUT-01: compose one scaled Gemini call and preserve the hard cap at load x${maxMultiplier}`, t => {
    const multiplier = underMaxLoad(t, { maxMultiplier });
    const capMs = resolveAgyChunkTimeoutCapMs({});
    assert.equal(capMs, AGY_CHUNK_TIMEOUT_CAP_MS, 'refusal cap is independent of load');
    assert.equal(resolveGeminiReviewerProcessTimeoutMs({}), Math.min(DEFAULT_REVIEWER_TIMEOUT_MS * multiplier + REVIEWER_PROCESS_SLACK_MS, capMs));
    // Small explicit calls distinguish single scaling from a cap-masked
    // second scaling even at the policy's largest supported multiplier.
    const env = { ADVERSARIAL_REVIEWER_TIMEOUT_MS: '1000', ADVERSARIAL_REVIEW_GEMINI_ANTIGRAVITY_PRINT_TIMEOUT_MS: '1000' };
    const plan = resolveAgyChunkTimeoutPlan({ chunkCount: 2, env });
    const callMs = plan.perChunkTimeoutMs;
    // The print subprocess receives a fixed 30s slack after its scaled budget.
    assertScaledOnce(callMs - 30_000, { baseMs: 1000, multiplier, ceilingMs: capMs });
    assert.equal(plan.timeoutMs, 2 * callMs + AGY_CHUNK_TIMEOUT_SLACK_MS);
    assert.equal(resolveGeminiReviewerProcessTimeoutMs(env, { plan }), plan.timeoutMs + REVIEWER_PROCESS_SLACK_MS);
    assertTimerCeiling(plan.timeoutMs, { ceilingMs: capMs });
    assert.equal(resolveGeminiReviewerProcessTimeoutMs({}, { plan: { timeoutMs: capMs } }), capMs);
    assert.throws(() => resolveAgyChunkTimeoutPlan({ chunkCount: 1000, env }), /chunk-budget-exceeded/);
    const huge = { ADVERSARIAL_REVIEW_AGY_CHUNK_TIMEOUT_CAP_MS: String(MAX_TIMER_DELAY_MS + 1000) };
    assert.equal(resolveAgyChunkTimeoutCapMs(huge), MAX_TIMER_DELAY_MS);
    assert.equal(resolveGeminiReviewerProcessTimeoutMs(huge, { plan: { timeoutMs: MAX_TIMER_DELAY_MS } }), MAX_TIMER_DELAY_MS);
  });

  test(`LEASEFAIR-04: daemon reservation survives the effective poll at maximum load x${maxMultiplier}`, async t => {
    const multiplier = underMaxLoad(t, { maxMultiplier });
    const rootDir = freshRoot(t);
    const clock = new FakeClock(t);
    const pollIntervalMs = 300_000;
    const effectivePollMs = loadAwareTimeoutMs(pollIntervalMs, { maxMs: Infinity });
    const request = { rootDir, repo: 'example/project', base: 'main', holderPid: process.pid,
      holderHost: 'synthetic-host', holderHead: 'a'.repeat(40), holderPr: 1,
      pidAliveFn: () => true };
    const holder = acquireMergeLease(request);
    assert.equal(holder.acquired, true);
    const daemon = acquireDaemonMergeLease({ ...request, holderPr: 2, pollIntervalMs });
    assert.equal(daemon.acquired, false);
    await clock.advance(effectivePollMs);
    assert.equal(releaseMergeLease({ rootDir, ...holder.lease, requestWatcherWakeImpl: () => {} }).released, true);
    let competitor, resumed;
    await runConcurrently([
      async at => {
        await at('closer');
        competitor = acquireMergeLease({ ...request, holderPr: 3, registerWaiter: true });
        await at('closer-done');
      },
      async at => {
        await at('daemon');
        resumed = acquireDaemonMergeLease({ ...request, holderPr: 2, pollIntervalMs });
      },
    ], { schedule: ['closer', 'closer-done', 'daemon'] });
    assert.equal(competitor.acquired, false, 'the closer cannot steal the daemon reservation between polls');
    assert.equal(resumed.acquired, true);
    assert.equal(resumed.waiter.arrivedAt, daemon.waiter.arrivedAt, 'the original reservation survives pruning');
    assertScaledOnce(daemon.waiter.deadlineSeconds * 1000, { baseMs: 2 * pollIntervalMs, multiplier, ceilingMs: MAX_TIMER_DELAY_MS });
    assertTimerCeiling(daemon.waiter.deadlineSeconds * 1000, { ceilingMs: MAX_TIMER_DELAY_MS });
    assert.equal(readMergeLeaseWaiters(rootDir, request).some(w => w.priority === 'daemon'), false);
  });
}

test('timerDelayMs clamps above 2^31 - 1 instead of expiring in one millisecond', async t => {
  const clock = new FakeClock(t);
  const delay = timerDelayMs(MAX_TIMER_DELAY_MS + 1);
  assert.equal(delay, MAX_TIMER_DELAY_MS);
  assertTimerCeiling(delay, { ceilingMs: MAX_TIMER_DELAY_MS });
  let expired = false;
  setTimeout(() => { expired = true; }, delay);
  await clock.advance(1);
  assert.equal(expired, false);
  await clock.advance(MAX_TIMER_DELAY_MS - 1);
  assert.equal(expired, true);
});
