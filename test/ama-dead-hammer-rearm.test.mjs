import { noWorkVerdict } from './fixtures/execution-verdict.mjs';
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

test('worker output uses bounded public logical tails without an HQ root', () => {
  const calls = [];
  const readDispatchFilesImpl = selector => {
    calls.push(selector);
    return {ok: true, log: {status: 'found', text: selector.stream === 'stdout' ? RESULT_429 : '', redacted: true, truncated: true}};
  };
  const output = readDeadHammerWorkerOutput({launchRequestId: LRQ, readDispatchFilesImpl});
  assert.equal(output.stderr, '');
  assert.equal(hasProviderApi429(output), true);
  assert.deepEqual(calls.map(row => [row.launch_request_id, row.stream, row.tail]), [[LRQ, 'stdout', true], [LRQ, 'stderr', true]]);
  assert.deepEqual(readDeadHammerWorkerOutput({launchRequestId: LRQ, readDispatchFilesImpl: () => ({ok: false})}), {stdout: '', stderr: ''});
});

// The next dispatch would run on a different harness (a fallback took over).
const FALLS_BACK = async () => true;

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
    readExecutionVerdictsImpl: async () => ({ ok: true, verdicts: [noWorkVerdict(LRQ)] }),
    readLaunchRequestStatusImpl: async () => ({ ok: true, row: { status: 'failed', failure_class: 'oauth_access_token_revoked' } }),
    now: '2026-09-29T10:01:00Z',
    ...overrides,
  };
}

test('a revoked-grant death refunds the charged dispatch once', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-rearm-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  recordHammerRetryDispatch(rootDir, { repo: REPO, prNumber: PR_NUMBER }, { jobKey: HEAD, headSha: HEAD, launchRequestId: LRQ });

  const rearm = await maybeRearmInfraDeadHammer(rearmArgs(rootDir, { nextDispatchDiffersImpl: FALLS_BACK }));
  assert.deepEqual(rearm, {
    rearmed: true,
    reason: 'refunded',
    cause: 'credential_before_work',
    failureClass: 'oauth_access_token_revoked',
    retryable: undefined,
  });
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 0);
  const again = await maybeRearmInfraDeadHammer(rearmArgs(rootDir, { nextDispatchDiffersImpl: FALLS_BACK }));
  assert.equal(again.rearmed, false);
  assert.equal(again.reason, 'already-refunded');
});

test('a hammer that pushed, a non-hammer launch, or an unreadable LRQ is never refunded', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-rearm-refused-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  recordHammerRetryDispatch(rootDir, { repo: REPO, prNumber: PR_NUMBER }, { jobKey: HEAD, headSha: HEAD, launchRequestId: LRQ });
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
  })).reason, /^rearm-failed$/);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 1);
});

test('an LRQ row the closer already read is reused, not read again', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-rearm-probe-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  recordHammerRetryDispatch(rootDir, { repo: REPO, prNumber: PR_NUMBER }, { jobKey: HEAD, headSha: HEAD, launchRequestId: LRQ });
  let reads = 0;
  const rearm = await maybeRearmInfraDeadHammer(rearmArgs(rootDir, {
    launchRequestProbe: { ok: true, row: { status: 'failed', failure_class: 'adapter_boot_crash' } },
    nextDispatchDiffersImpl: FALLS_BACK,
    readLaunchRequestStatusImpl: async () => {
      reads += 1;
      return { ok: false, reason: 'unexpected-read' };
    },
  }));
  assert.equal(reads, 0);
  assert.equal(rearm.rearmed, true);
  assert.equal(rearm.cause, 'credential_before_work');
});

test('RCV-08 an unavailable or unknown verdict leaves infrastructure failures charged', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'rcv-08-unknown-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD, launchRequestId: LRQ });
  for (const packet of [{ ok: false }, { ok: true, verdicts: [] },
    { ok: true, verdicts: [noWorkVerdict(LRQ, { verdict: 'unknown' })] },
    { ok: true, verdicts: [noWorkVerdict(LRQ, { verdict: 'work_started' })] }]) {
    const result = await maybeRearmInfraDeadHammer(rearmArgs(rootDir, {
      readExecutionVerdictsImpl: async () => packet,
    }));
    assert.equal(result.rearmed, false);
    assert.equal(result.reason, 'execution-not-proven-no-work');
  }
  assert.equal(readHammerRetryCapLedger(rootDir, identity).lifetimeAttemptCount, 1);
});

test('RCV-08 no-work refunds are independent of the bounded exit-without-close retry', async t => {
  const rootDir = mkdtempSync(join(tmpdir(), 'rcv-08-independent-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  const identity = { repo: REPO, prNumber: PR_NUMBER };
  recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD, launchRequestId: 'lrq_prior' });
  assert.equal(refundHammerRetryDispatch(rootDir, identity, {
    jobKey: HEAD, headSha: HEAD, launchRequestId: 'lrq_prior',
  }).refunded, true);
  recordHammerRetryDispatch(rootDir, identity, { jobKey: HEAD, headSha: HEAD, launchRequestId: LRQ });
  assert.equal((await maybeRearmInfraDeadHammer(rearmArgs(rootDir))).rearmed, true);
  const ledger = readHammerRetryCapLedger(rootDir, identity);
  assert.equal(ledger.retryable, 1);
  assert.equal(ledger.attemptCount, 0);
  assert.equal(ledger.lifetimeAttemptCount, 1);
});

test('RCV-08 a producer-certified pre-work quota failure refunds without interpreting the 429 text', async (t) => {
  const rootDir = mkdtempSync(join(tmpdir(), 'closerreuse-rearm-429-'));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  recordHammerRetryDispatch(rootDir, { repo: REPO, prNumber: PR_NUMBER }, { jobKey: HEAD, headSha: HEAD, launchRequestId: LRQ });
  let probes = 0;
  const rearm = await maybeRearmInfraDeadHammer(rearmArgs(rootDir, {
    readLaunchRequestStatusImpl: async () => ({
      ok: true,
      row: { status: 'failed', failure_class: 'worker_killed', failure_detail: 'Claude account rate limit rejected the request (429)' },
    }),
    nextDispatchDiffersImpl: async () => {
      probes += 1;
      return false;
    },
  }));
  assert.equal(rearm.rearmed, true, JSON.stringify(rearm));
  assert.equal(probes, 0);
  assert.equal(readHammerRetryCapLedger(rootDir, { repo: REPO, prNumber: PR_NUMBER }).attemptCount, 0);
});
