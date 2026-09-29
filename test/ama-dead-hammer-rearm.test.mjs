// CLOSERREUSE-01: which hammer deaths re-arm the closer. The closer-level
// replays (agent-os#7347, #7349) are in closerreuse-01-replay.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyDeadHammerCause,
  hasProviderApi429,
  maybeRearmInfraDeadHammer,
  readDeadHammerWorkerOutput,
} from '../src/ama/dead-hammer-rearm.mjs';
import {
  readHammerRetryCapLedger,
  recordHammerRetryDispatch,
  refundHammerRetryDispatch,
} from '../src/ama/hammer-retry-cap.mjs';

const REPO = 'laceyenterprises/agent-os';
const PR_NUMBER = 7349;
const HEAD = '69ce8fd93651126428ec5b3ec9a6e543e41d7550';
const LRQ = 'lrq_9152ec06-ed3c-4865-a0ab-483d81d703b5';
const CLAUDE_429 = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
const RESULT_429 = JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: CLAUDE_429 });

test('the three infrastructure causes the SEV names are classified as such', () => {
  assert.deepEqual(classifyDeadHammerCause({ failureClass: 'oauth_access_token_revoked' }),
    { infra: true, cause: 'oauth_access_token_revoked' });
  assert.deepEqual(classifyDeadHammerCause({ failureClass: 'adapter_boot_crash' }),
    { infra: true, cause: 'adapter_boot_crash' });
  assert.deepEqual(classifyDeadHammerCause({ failureClass: 'process_exited_after_progress', stdout: `${RESULT_429}\n` }),
    { infra: true, cause: 'process_exited_after_progress:api-429' });
});

test('an exit after progress is an infrastructure death only with the provider 429', () => {
  assert.deepEqual(classifyDeadHammerCause({ failureClass: 'process_exited_after_progress' }),
    { infra: false, cause: 'process_exited_after_progress' });
  assert.equal(
    classifyDeadHammerCause({
      failureClass: 'process_exited_after_progress',
      stdout: `${JSON.stringify({ type: 'result', is_error: true, result: 'Error: tests failed' })}\n`,
    }).infra,
    false,
  );
  // Other failure classes stay charged whatever the output says.
  for (const failureClass of ['worker_crashed', 'failure_attribution_missing', null]) {
    assert.equal(classifyDeadHammerCause({ failureClass, stdout: `${RESULT_429}\n` }).infra, false, failureClass);
  }
});

test('agent-os QUOTA429-01 reclassifies the same 429 stop to worker_killed', () => {
  assert.equal(
    classifyDeadHammerCause({
      failureClass: 'worker_killed',
      failureDetail: 'Claude account rate limit rejected the request (429)',
    }).infra,
    true,
  );
  assert.equal(classifyDeadHammerCause({ failureClass: 'worker_killed', failureDetail: 'SIGKILL' }).infra, false);
});

test('only the harness\'s own 429 counts, not a 429 the hammer read or quoted', () => {
  // The final result event decides, whatever the earlier events carried.
  const toolResultQuote = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: `const CLAUDE_PROVIDER_429 = /^${CLAUDE_429}/;` }] },
  });
  assert.equal(hasProviderApi429({
    stdout: [toolResultQuote, JSON.stringify({ type: 'result', is_error: true, result: 'crashed' }), ''].join('\n'),
  }), false);
  // With no result event, only a line the harness wrote counts.
  assert.equal(hasProviderApi429({ stdout: `${toolResultQuote}\n` }), false);
  assert.equal(hasProviderApi429({ stderr: `${CLAUDE_429}\n` }), true);
  assert.equal(hasProviderApi429({ stderr: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}\n' }), true);
  assert.equal(hasProviderApi429({ stderr: `worker said: ${CLAUDE_429}\n` }), false);
  // The result event, by status or by its message.
  assert.equal(hasProviderApi429({ stdout: `${RESULT_429}\n` }), true);
  assert.equal(hasProviderApi429({
    stdout: `${JSON.stringify({ type: 'result', is_error: true, result: CLAUDE_429 })}\n`,
  }), true);
});

test('the worker output is read from the launch\'s dispatch dir, and only a safe launch id is joined', (t) => {
  const hqRoot = mkdtempSync(join(tmpdir(), 'closerreuse-worker-output-'));
  t.after(() => rmSync(hqRoot, { recursive: true, force: true }));
  mkdirSync(join(hqRoot, 'dispatch', LRQ), { recursive: true });
  writeFileSync(join(hqRoot, 'dispatch', LRQ, 'stdout.log'), `${'x'.repeat(100_000)}\n${RESULT_429}\n`);
  const output = readDeadHammerWorkerOutput({ hqRoot, launchRequestId: LRQ });
  assert.equal(output.stderr, '');
  assert.ok(output.stdout.length <= 64 * 1024);
  assert.equal(hasProviderApi429(output), true, 'the tail keeps the final result event');
  assert.deepEqual(readDeadHammerWorkerOutput({ hqRoot, launchRequestId: '../etc' }), { stdout: '', stderr: '' });
  assert.deepEqual(readDeadHammerWorkerOutput({ hqRoot: null, launchRequestId: LRQ }), { stdout: '', stderr: '' });
});

function rearmArgs(rootDir, overrides = {}) {
  return {
    rootDir,
    hqRoot: join(rootDir, 'hq-root'),
    repo: REPO,
    prNumber: PR_NUMBER,
    jobKey: HEAD,
    record: {
      headSha: HEAD,
      reviewedSha: HEAD,
      targetRemediationSha: HEAD,
      workerClass: 'hammer-claude',
      launchRequestId: LRQ,
    },
    currentHeadSha: HEAD,
    readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'failed', failure_class: 'oauth_access_token_revoked' } }),
    now: '2026-09-29T10:01:00Z',
    ...overrides,
  };
}

test('a revoked-grant death refunds the charged dispatch once', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-rearm-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  recordHammerRetryDispatch(rootDir, { repo: REPO, prNumber: PR_NUMBER }, { jobKey: HEAD, headSha: HEAD });

  const rearm = await maybeRearmInfraDeadHammer(rearmArgs(rootDir));
  assert.deepEqual(rearm, {
    rearmed: true,
    reason: 'refunded',
    cause: 'oauth_access_token_revoked',
    failureClass: 'oauth_access_token_revoked',
    retryable: 1,
  });
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 0);
  const again = await maybeRearmInfraDeadHammer(rearmArgs(rootDir));
  assert.equal(again.rearmed, false);
  assert.equal(again.reason, 'already-refunded');
});

test('a hammer that pushed, a non-hammer launch, or an unreadable LRQ is never refunded', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-rearm-refused-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  recordHammerRetryDispatch(rootDir, { repo: REPO, prNumber: PR_NUMBER }, { jobKey: HEAD, headSha: HEAD });
  const base = rearmArgs(rootDir);

  assert.equal((await maybeRearmInfraDeadHammer({ ...base, currentHeadSha: 'f'.repeat(40) })).reason,
    'hammer-pushed-or-head-unknown');
  assert.equal((await maybeRearmInfraDeadHammer({ ...base, currentHeadSha: null })).reason,
    'hammer-pushed-or-head-unknown');
  assert.equal((await maybeRearmInfraDeadHammer({ ...base, record: { ...base.record, workerClass: 'codex' } })).reason,
    'not-a-hammer');
  assert.equal((await maybeRearmInfraDeadHammer({
    ...base,
    readLaunchRequestStatusImpl: async () => ({ ok: false, reason: 'ledger-read-failed' }),
  })).reason, 'launch-request-unreadable:ledger-read-failed');
  assert.match((await maybeRearmInfraDeadHammer({
    ...base,
    readLaunchRequestStatusImpl: async () => {
      throw new Error('psql: connection refused');
    },
  })).reason, /^rearm-failed:psql: connection refused/);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 1);
});

test('an LRQ row the closer already read is reused, not read again', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-rearm-probe-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  recordHammerRetryDispatch(rootDir, { repo: REPO, prNumber: PR_NUMBER }, { jobKey: HEAD, headSha: HEAD });
  let reads = 0;
  const rearm = await maybeRearmInfraDeadHammer(rearmArgs(rootDir, {
    launchRequestProbe: { ok: true, row: { status: 'failed', failure_class: 'adapter_boot_crash' } },
    readLaunchRequestStatusImpl: async () => {
      reads += 1;
      return { ok: false, reason: 'unexpected-read' };
    },
  }));
  assert.equal(reads, 0);
  assert.equal(rearm.rearmed, true);
  assert.equal(rearm.cause, 'adapter_boot_crash');
});

test('an exit-without-close refund (HAMBG-02) and an infrastructure death share one budget per series', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-rearm-shared-budget-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD });
  // The series' first hammer exited `succeeded` without closing: HAMBG-02 refunded it.
  assert.equal(refundHammerRetryDispatch(rootDir, identity, {
    jobKey: HEAD, headSha: HEAD, launchRequestId: 'lrq_exited-without-close',
  }).refunded, true);
  recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD });

  // Its re-dispatch then dies of a revoked grant: no second refund.
  const rearm = await maybeRearmInfraDeadHammer(rearmArgs(rootDir));
  assert.equal(rearm.rearmed, false);
  assert.equal(rearm.reason, 'retry-budget-exhausted');
  assert.equal(rearm.cause, 'oauth_access_token_revoked');
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.retryable, 1);
  assert.equal(ledger.attemptCount, 1, 'the death stays charged');
  assert.deepEqual(ledger.retryableLaunchRequestIds, ['lrq_exited-without-close']);
});
