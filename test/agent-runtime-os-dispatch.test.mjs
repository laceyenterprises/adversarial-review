import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_APP_CONTRACT_APP_ID,
  DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS,
  buildDispatchPayload,
  createOsDispatchAgentRuntime,
  mapTerminalStatus,
  resolveCompletionShape,
  resolveTaskKind,
  toHqTaskKind,
  toAppContractRequestId,
} from '../src/adapters/agent-runtime/os-dispatch/index.mjs';
import {
  REVIEW_ARTIFACT_KIND,
  ReviewArtifactSchemaError,
  validateReviewArtifact,
} from '../src/adapters/agent-runtime/os-dispatch/review-artifact.mjs';

function reviewArtifact(overrides = {}) {
  return {
    kind: REVIEW_ARTIFACT_KIND,
    schemaVersion: 2,
    domainId: 'code-pr',
    subjectExternalId: 'pr-14',
    revisionRef: 'abc123',
    stageId: 'code-review',
    reviewerRole: 'code-quality-reviewer',
    reviewerRunRef: 'lrq_1',
    verdict: {
      kind: 'request-changes',
      summary: 'One blocker.',
      blockingFindings: [{ title: 'null deref', file: 'a.js', lines: '10', problem: 'crashes' }],
      nonBlockingFindings: [],
    },
    body: '## Summary\nOne blocker.\n\n## Verdict\nRequest changes',
    ...overrides,
  };
}

function reviewerRequest(overrides = {}) {
  return {
    role: { id: 'reviewer:claude-code', kind: 'reviewer', model: 'claude-code' },
    promptSet: 'code-pr',
    promptStage: 'first',
    subjectContent: {
      ref: { domainId: 'code-pr', subjectExternalId: 'pr-14', revisionRef: 'abc123', linearTicketId: 'ARC-06' },
      representation: 'diff --git a b',
      observedAt: '2026-07-17T20:00:00.000Z',
    },
    idempotencyKey: 'code-pr:pr-14:abc123:code-review:code-quality-reviewer:1',
    budget: { maxTokens: 500_000, maxWallMs: 600_000 },
    timeoutMs: 600_000,
    ...overrides,
  };
}

// A fake app-contract session: records dispatch payloads and returns a scripted
// sequence of dispatch_status payloads, so polling / terminal mapping /
// idempotency can be asserted without an HTTP endpoint.
function fakeSession({ statusSequence = [], onDispatch = () => {} } = {}) {
  const dispatched = [];
  const statusCalls = [];
  const cancelCalls = [];
  let statusIndex = 0;
  return {
    dispatched,
    statusCalls,
    cancelCalls,
    async dispatch(payload) {
      dispatched.push(payload);
      onDispatch(payload);
      return {
        app_id: 'adversarial-review',
        request_id: payload.request_id,
        launch_request_id: `lrq_${payload.request_id}`,
      };
    },
    async dispatchStatus(requestId) {
      statusCalls.push(requestId);
      const next = statusSequence[Math.min(statusIndex, statusSequence.length - 1)];
      statusIndex += 1;
      return typeof next === 'function' ? next(requestId) : next;
    },
    async dispatchCancel(requestId) {
      cancelCalls.push(requestId);
    },
  };
}

// -- artifact schema validation (valid / missing-field / wrong-kind) ---------

test('validateReviewArtifact accepts a well-formed v2 artifact and normalizes the verdict', () => {
  const normalized = validateReviewArtifact(reviewArtifact());
  assert.equal(normalized.kind, REVIEW_ARTIFACT_KIND);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.verdict.kind, 'request-changes');
  assert.equal(normalized.verdict.blockingFindings.length, 1);
  assert.deepEqual(normalized.verdict.nonBlockingFindings, []);
  assert.equal(normalized.stageId, 'code-review');
});

test('validateReviewArtifact normalizes a stated verdict phrase to the canonical kind', () => {
  const normalized = validateReviewArtifact(reviewArtifact({
    verdict: { kind: 'Approved', summary: 'lgtm' },
  }));
  assert.equal(normalized.verdict.kind, 'approved');
  assert.deepEqual(normalized.verdict.blockingFindings, []);
});

test('validateReviewArtifact rejects a wrong-kind artifact', () => {
  assert.throws(
    () => validateReviewArtifact(reviewArtifact({ kind: 'remediation-reply' })),
    (err) => err instanceof ReviewArtifactSchemaError && /kind must be/.test(err.message),
  );
});

test('validateReviewArtifact rejects a wrong schemaVersion', () => {
  assert.throws(
    () => validateReviewArtifact(reviewArtifact({ schemaVersion: 1 })),
    (err) => err instanceof ReviewArtifactSchemaError && /schemaVersion must be 2/.test(err.message),
  );
});

test('validateReviewArtifact reports each missing required field', () => {
  const missingBody = reviewArtifact();
  delete missingBody.body;
  assert.throws(
    () => validateReviewArtifact(missingBody),
    (err) => err instanceof ReviewArtifactSchemaError && /missing required field\(s\): body/.test(err.message),
  );

  const missingVerdict = reviewArtifact();
  delete missingVerdict.verdict;
  assert.throws(
    () => validateReviewArtifact(missingVerdict),
    (err) => err instanceof ReviewArtifactSchemaError && /verdict/.test(err.message),
  );

  assert.throws(
    () => validateReviewArtifact(reviewArtifact({ verdict: { kind: '   ' } })),
    (err) => err instanceof ReviewArtifactSchemaError && /verdict\.kind/.test(err.message),
  );
});

test('validateReviewArtifact rejects a non-array findings list', () => {
  assert.throws(
    () => validateReviewArtifact(reviewArtifact({
      verdict: { kind: 'comment-only', blockingFindings: 'nope' },
    })),
    (err) => err instanceof ReviewArtifactSchemaError && /blockingFindings must be an array/.test(err.message),
  );
});

// -- task_kind / completion_shape derivation ---------------------------------

test('reviewer derives analysis + decision-only, remediator derives coding + branch-push', () => {
  assert.equal(resolveTaskKind({ kind: 'reviewer' }), 'analysis');
  assert.equal(resolveCompletionShape({ kind: 'reviewer' }), 'decision-only');
  assert.equal(resolveTaskKind({ kind: 'remediator' }), 'coding');
  assert.equal(resolveCompletionShape({ kind: 'remediator' }), 'branch-push');
  // explicit overrides win
  assert.equal(resolveTaskKind({ kind: 'reviewer', taskKind: 'analysis' }), 'analysis');
  assert.equal(resolveCompletionShape({ kind: 'reviewer', completionShape: 'artifact' }), 'artifact');
});

test('legacy app role task kinds map to HQ task kinds before dispatch', () => {
  assert.equal(toHqTaskKind('review'), 'analysis');
  assert.equal(toHqTaskKind('remediation'), 'coding');
  assert.equal(resolveTaskKind({ kind: 'reviewer', taskKind: 'review' }), 'analysis');
  assert.equal(resolveTaskKind({ kind: 'remediator', taskKind: 'remediation' }), 'coding');
});

test('mapTerminalStatus maps each terminal family and leaves in-progress states pending', () => {
  assert.equal(mapTerminalStatus('succeeded'), 'completed');
  assert.equal(mapTerminalStatus('failed'), 'failed');
  assert.equal(mapTerminalStatus('canceled'), 'cancelled');
  assert.equal(mapTerminalStatus('superseded'), 'cancelled');
  assert.equal(mapTerminalStatus('timed_out'), 'timeout');
  assert.equal(mapTerminalStatus('running'), null);
  assert.equal(mapTerminalStatus('queued'), null);
  assert.equal(mapTerminalStatus(''), null);
});

// -- idempotency-key propagation ---------------------------------------------

test('buildDispatchPayload propagates the idempotency key as request_id and maps the review contract', () => {
  const payload = buildDispatchPayload(reviewerRequest(), (r) => r.subjectContent.representation);
  assert.equal(payload.request_id, 'code-pr:pr-14:abc123:code-review:code-quality-reviewer:1');
  assert.equal(payload.task_kind, 'analysis');
  assert.equal(payload.completion_shape, 'decision-only');
  assert.equal(payload.worker_class, 'claude-code');
  assert.equal(payload.domain_id, 'code-pr');
  assert.equal(payload.subject_external_id, 'pr-14');
  assert.equal(payload.revision_ref, 'abc123');
  assert.equal(payload.ticket_ref, 'ARC-06');
  assert.equal(payload.token_budget, 500_000);
  assert.equal(payload.prompt, 'diff --git a b');
});

test('toAppContractRequestId preserves valid keys and normalizes PR refs with a hash suffix', () => {
  assert.equal(toAppContractRequestId('req-valid:/._-09'), 'req-valid:/._-09');

  const raw = 'code-pr:laceyenterprises/agent-os#4284:abc123:review:reviewer:gemini:1';
  const safe = toAppContractRequestId(raw);
  assert.notEqual(safe, raw);
  assert.match(safe, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/);
  assert.match(safe, /^code-pr:laceyenterprises\/agent-os-4284:abc123:review:reviewer:gemini:1-[a-f0-9]{16}$/);
  assert.equal(toAppContractRequestId(raw), safe, 'normalization must be stable for retries');
});

test('run propagates the idempotency key to dispatch and every dispatch_status poll', async () => {
  const session = fakeSession({
    statusSequence: [
      { status: 'queued' },
      { status: 'running' },
      { status: 'succeeded', artifact: reviewArtifact(), usage: { total: 4242 } },
    ],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {}, jitterImpl: () => 0 });
  const req = reviewerRequest();
  const handle = await runtime.run(req);

  assert.equal(handle.mode, 'os');
  assert.equal(handle.runRef, req.idempotencyKey);
  assert.equal(session.dispatched.length, 1);
  assert.equal(session.dispatched[0].request_id, req.idempotencyKey);

  const result = await handle.await();
  assert.equal(result.status, 'completed');
  assert.deepEqual(session.statusCalls, [req.idempotencyKey, req.idempotencyKey, req.idempotencyKey]);
  assert.equal(result.usage.total, 4242);
});

test('run uses an app-contract-safe request id for dispatch and status polling', async () => {
  const session = fakeSession({
    statusSequence: [
      { status: 'running' },
      { status: 'succeeded', artifact: reviewArtifact(), usage: { total: 99 } },
    ],
  });
  const rawKey = 'code-pr:laceyenterprises/agent-os#4284:abc123:review:reviewer:gemini:1';
  const expectedRequestId = toAppContractRequestId(rawKey);
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {}, jitterImpl: () => 0 });
  const handle = await runtime.run(reviewerRequest({ idempotencyKey: rawKey }));

  assert.equal(handle.runRef, expectedRequestId);
  assert.equal(session.dispatched.length, 1);
  assert.equal(session.dispatched[0].request_id, expectedRequestId);

  const result = await handle.await();
  assert.equal(result.status, 'completed');
  assert.deepEqual(session.statusCalls, [expectedRequestId, expectedRequestId]);
});

// -- dispatch_status polling with terminal-state mapping ----------------------

test('run polls until a succeeded terminal state and returns a validated ReviewArtifact', async () => {
  const session = fakeSession({
    statusSequence: [
      { status: 'accepted' },
      { status: 'running' },
      { status: 'succeeded', artifact: reviewArtifact() },
    ],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {}, jitterImpl: () => 0 });
  const result = await (await runtime.run(reviewerRequest())).await();
  assert.equal(result.status, 'completed');
  assert.equal(result.runtimeMode, 'os');
  assert.equal(result.artifact.kind, REVIEW_ARTIFACT_KIND);
  assert.equal(result.artifact.verdict.kind, 'request-changes');
  assert.equal(session.statusCalls.length, 3);
});

test('run maps a failed terminal state to a failed RunResult with the reported failure class', async () => {
  const session = fakeSession({
    statusSequence: [{ status: 'failed', failure_class: 'rate-limit', failure_detail: 'HTTP 429' }],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const result = await (await runtime.run(reviewerRequest())).await();
  assert.equal(result.status, 'failed');
  assert.equal(result.failureClass, 'rate-limit');
  assert.equal(result.detail, 'HTTP 429');
});

test('run maps timeout and cancelled terminal states', async () => {
  const timeoutSession = fakeSession({ statusSequence: [{ status: 'timed_out' }] });
  const timeoutResult = await (await createOsDispatchAgentRuntime({
    session: timeoutSession, sleepImpl: async () => {},
  }).run(reviewerRequest())).await();
  assert.equal(timeoutResult.status, 'timeout');
  assert.equal(timeoutResult.failureClass, 'timeout');

  const cancelledSession = fakeSession({ statusSequence: [{ status: 'superseded' }] });
  const cancelledResult = await (await createOsDispatchAgentRuntime({
    session: cancelledSession, sleepImpl: async () => {},
  }).run(reviewerRequest())).await();
  assert.equal(cancelledResult.status, 'cancelled');
});

test('run downgrades a completed run with a malformed artifact to reviewer-output failure', async () => {
  const session = fakeSession({
    statusSequence: [{ status: 'succeeded', artifact: { kind: 'not-a-verdict', schemaVersion: 2 } }],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const result = await (await runtime.run(reviewerRequest())).await();
  assert.equal(result.status, 'failed');
  assert.equal(result.failureClass, 'reviewer-output');
  assert.match(result.detail, /kind must be/);
});

test('run synthesizes a review artifact from healthy terminal markdown summary', async () => {
  const body = [
    '## Summary',
    'The registry contract needs documentation.',
    '',
    '## Blocking issues',
    '- **Missing registry documentation**',
    '  - **File:** `projects/worker-pool/SPEC.md`',
    '  - **Lines:** 12-18',
    '  - **Problem:** New public contract is not documented.',
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Verdict',
    'Request changes',
    '',
  ].join('\n');
  const requestId = 'code-pr:laceyenterprises/agent-os-4304:b5c866:review:reviewer:gemini:1-0e570173e3a5b97a';
  const session = fakeSession({
    statusSequence: [{
      status: 'succeeded',
      health: 'healthy',
      request_id: requestId,
      launch_request_id: 'lrq_summary_body',
      lastProgressSummary: body,
      artifact: null,
      result: null,
    }],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const result = await (await runtime.run(reviewerRequest({
    idempotencyKey: requestId,
    role: { id: 'reviewer:gemini', kind: 'reviewer', model: 'gemini' },
    subjectContent: {
      ...reviewerRequest().subjectContent,
      ref: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/agent-os#4304',
        revisionRef: 'b5c8668631dac2d4e274536bfaa3fc4551919f57',
      },
    },
  }))).await();
  assert.equal(result.status, 'completed');
  assert.equal(result.failureClass, null);
  assert.equal(result.artifact.body, body.trim());
  assert.equal(result.artifact.verdict.kind, 'request-changes');
  assert.equal(result.artifact.domainId, 'code-pr');
  assert.equal(result.artifact.subjectExternalId, 'laceyenterprises/agent-os#4304');
  assert.equal(result.artifact.revisionRef, 'b5c8668631dac2d4e274536bfaa3fc4551919f57');
  assert.equal(result.artifact.reviewerRole, 'reviewer:gemini');
  assert.equal(result.artifact.reviewerRunRef, 'lrq_summary_body');
  assert.deepEqual(result.artifact.verdict.blockingFindings, [{
    title: 'Missing registry documentation',
    file: '`projects/worker-pool/SPEC.md`',
    lines: '12-18',
    problem: 'New public contract is not documented.',
  }]);
  assert.deepEqual(result.artifact.verdict.nonBlockingFindings, []);
});

test('run rejects a dispatchId-only status payload from reviewerRunRef (no launch-request contamination)', async () => {
  // Regression: an os-dispatch status payload that carries only a dispatchId (the
  // app-contract request/idempotency handle) and NO launch_request_id must not
  // seed reviewerRunRef. Otherwise the request handle is promoted into durable
  // metadata_json.launchRequestId and the attribution backfill resolves the wrong
  // worker run. With reviewerRunRef null, downstream workerRunAttribution.state
  // resolves to 'not-applicable' (reviewer-spawn-settle: launchRequestId ? pending
  // : not-applicable). Mirrors the launch_request_id summary test above, but the
  // payload carries only a dispatchId.
  const body = [
    '## Summary',
    'The registry contract needs documentation.',
    '',
    '## Blocking issues',
    '- **Missing registry documentation**',
    '  - **File:** `projects/worker-pool/SPEC.md`',
    '  - **Lines:** 12-18',
    '  - **Problem:** New public contract is not documented.',
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Verdict',
    'Request changes',
    '',
  ].join('\n');
  const requestId = 'code-pr:laceyenterprises/agent-os-4304:b5c866:review:reviewer:gemini:1-dispatchid-only';
  const session = fakeSession({
    statusSequence: [{
      status: 'succeeded',
      health: 'healthy',
      request_id: requestId,
      dispatchId: 'appcontract_req_7f3a2b',
      lastProgressSummary: body,
      artifact: null,
      result: null,
    }],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const result = await (await runtime.run(reviewerRequest({
    idempotencyKey: requestId,
    role: { id: 'reviewer:gemini', kind: 'reviewer', model: 'gemini' },
    subjectContent: {
      ...reviewerRequest().subjectContent,
      ref: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/agent-os#4304',
        revisionRef: 'b5c8668631dac2d4e274536bfaa3fc4551919f57',
      },
    },
  }))).await();
  assert.equal(result.status, 'completed');
  assert.equal(result.artifact.body, body.trim());
  assert.equal(result.artifact.verdict.kind, 'request-changes');
  // The app-contract dispatch handle must NOT become reviewerRunRef. The schema
  // validator drops a null field, so the value is falsy (null/undefined) — the
  // point is it is not the dispatchId. Downstream this yields
  // launchRequestId = (reviewerRunRef || null) = null → attribution not-applicable.
  assert.ok(!result.artifact.reviewerRunRef, 'reviewerRunRef must be falsy for a dispatchId-only payload');
  assert.notEqual(result.artifact.reviewerRunRef, 'appcontract_req_7f3a2b');
});

test('run synthesizes a review artifact from durable HQ stdout when terminal summary is telemetry', async () => {
  const hqRoot = mkdtempSync(join(tmpdir(), 'os-dispatch-hq-'));
  const body = [
    '## Summary',
    'Documentation-only change.',
    '',
    '## Blocking issues',
    '- None.',
    '',
    '## Non-blocking issues',
    '- None.',
    '',
    '## Verdict',
    'Comment only',
    '',
  ].join('\n');
  try {
    mkdirSync(join(hqRoot, 'dispatch', 'lrq_stdout_body'), { recursive: true });
    writeFileSync(join(hqRoot, 'dispatch', 'lrq_stdout_body', 'stdout.log'), body);
    const requestId = 'code-pr:laceyenterprises/agent-os-4311:e62047:review:reviewer:gemini:1-35e83a86f9eb844e';
    const session = fakeSession({
      statusSequence: [{
        status: 'succeeded',
        health: 'healthy',
        request_id: requestId,
        launch_request_id: 'lrq_stdout_body',
        lastProgressSummary: 'budget enforcement degraded: missing live token usage events',
        artifact: null,
        result: null,
      }],
    });
    const runtime = createOsDispatchAgentRuntime({
      session,
      sleepImpl: async () => {},
      env: { HQ_ROOT: hqRoot },
    });
    const result = await (await runtime.run(reviewerRequest({
      idempotencyKey: requestId,
      role: { id: 'reviewer:gemini', kind: 'reviewer', model: 'gemini' },
      subjectContent: {
        ...reviewerRequest().subjectContent,
        ref: {
          domainId: 'code-pr',
          subjectExternalId: 'laceyenterprises/agent-os#4311',
          revisionRef: 'e620478a0d75f4afd6d2f052b00e22d8c950906c',
        },
      },
    }))).await();
    assert.equal(result.status, 'completed');
    assert.equal(result.failureClass, null);
    assert.equal(result.artifact.body, body.trim());
    assert.equal(result.artifact.verdict.kind, 'comment-only');
    assert.equal(result.artifact.reviewerRunRef, 'lrq_stdout_body');
  } finally {
    rmSync(hqRoot, { recursive: true, force: true });
  }
});

test('run keeps terminal summary request-changes fail-closed when findings are unparseable', async () => {
  const body = [
    '## Summary',
    'The model reported a blocking verdict but omitted the canonical blocking section.',
    '',
    '## Verdict',
    'Request changes',
    '',
  ].join('\n');
  const requestId = 'code-pr:laceyenterprises/agent-os-4304:b5c866:review:reviewer:gemini:1-0e570173e3a5b97a';
  const session = fakeSession({
    statusSequence: [{
      status: 'succeeded',
      health: 'healthy',
      request_id: requestId,
      launch_request_id: 'lrq_summary_unparseable',
      lastProgressSummary: body,
      artifact: null,
      result: null,
    }],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const result = await (await runtime.run(reviewerRequest({
    idempotencyKey: requestId,
    role: { id: 'reviewer:gemini', kind: 'reviewer', model: 'gemini' },
    subjectContent: {
      ...reviewerRequest().subjectContent,
      ref: {
        domainId: 'code-pr',
        subjectExternalId: 'laceyenterprises/agent-os#4304',
        revisionRef: 'b5c8668631dac2d4e274536bfaa3fc4551919f57',
      },
    },
  }))).await();
  assert.equal(result.status, 'completed');
  assert.equal(result.artifact.verdict.kind, 'request-changes');
  assert.equal(result.artifact.verdict.blockingFindings.length, 1);
  assert.match(result.artifact.verdict.blockingFindings[0].problem, /did not expose parseable blocking findings/);
});

test('run treats succeeded dead-health dispatch without an artifact as infrastructure failure', async () => {
  const session = fakeSession({
    statusSequence: [{
      status: 'succeeded',
      health: 'dead',
      lastProgressSummary: 'dispatch-daemon: adapter spawn failed',
      live_status: {
        health: 'dead',
        diagnostics: [{
          severity: 'error',
          violationType: 'adapter_spawn_timeout',
          reason: 'adapter spawn failed before the worker wrote a review artifact',
        }],
      },
    }],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const result = await (await runtime.run(reviewerRequest())).await();
  assert.equal(result.status, 'failed');
  assert.equal(result.failureClass, 'adapter_spawn_timeout');
  assert.match(result.detail, /adapter spawn failed/);
});

test('remediator run returns the branch-push artifact opaquely without verdict validation', async () => {
  const branchPushArtifact = { kind: 'adversarial-review-remediation-reply', schemaVersion: 1, outcome: 'completed' };
  const session = fakeSession({ statusSequence: [{ status: 'succeeded', artifact: branchPushArtifact }] });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const req = reviewerRequest({
    role: { id: 'remediator:codex', kind: 'remediator', model: 'codex' },
    idempotencyKey: 'code-pr:pr-14:abc123:code-review:remediator:1',
    workspaceRef: { workspacePath: '/tmp/ws' },
  });
  const handle = await runtime.run(req);
  assert.equal(session.dispatched[0].task_kind, 'coding');
  assert.equal(session.dispatched[0].completion_shape, 'branch-push');
  assert.equal(session.dispatched[0].workspace_ref, '/tmp/ws');
  const result = await handle.await();
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.artifact, branchPushArtifact);
});

test('cancel flips the run to cancelled and issues a best-effort server-side cancel', async () => {
  // Never terminal on its own — only cancel ends the loop.
  const session = fakeSession({ statusSequence: [{ status: 'running' }] });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const handle = await runtime.run(reviewerRequest());
  await handle.cancel();
  const result = await handle.await();
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(session.cancelCalls, [reviewerRequest().idempotencyKey]);
});

test('run honors the deadline and reports a timeout when dispatch_status never terminates', async () => {
  const session = fakeSession({ statusSequence: [{ status: 'running' }] });
  let clock = 1_000;
  const runtime = createOsDispatchAgentRuntime({
    session,
    sleepImpl: async () => { clock += 10_000; },
    jitterImpl: () => 0,
    nowMs: () => clock,
  });
  const result = await (await runtime.run(reviewerRequest({ timeoutMs: 5_000 }))).await();
  assert.equal(result.status, 'timeout');
  assert.equal(result.failureClass, 'timeout');
  assert.deepEqual(session.cancelCalls, [reviewerRequest().idempotencyKey]);
});

test('run does not spend execution timeout while dispatch is only queued', async () => {
  const session = fakeSession({
    statusSequence: [
      { status: 'queued' },
      { status: 'running' },
      { status: 'succeeded', artifact: reviewArtifact() },
    ],
  });
  const sleeps = [6_000, 1_000];
  let clock = 1_000;
  const runtime = createOsDispatchAgentRuntime({
    session,
    sleepImpl: async () => { clock += sleeps.shift() ?? 1_000; },
    jitterImpl: () => 0,
    nowMs: () => clock,
  });
  const result = await (await runtime.run(reviewerRequest({ timeoutMs: 5_000 }))).await();
  assert.equal(result.status, 'completed');
  assert.deepEqual(session.cancelCalls, []);
  assert.deepEqual(session.statusCalls, [
    reviewerRequest().idempotencyKey,
    reviewerRequest().idempotencyKey,
    reviewerRequest().idempotencyKey,
  ]);
});

test('run retries transient dispatch_status failures but fails fast on client errors', async () => {
  const transient = new Error('connection reset');
  transient.code = 'ECONNRESET';
  const session = fakeSession({
    statusSequence: [
      () => { throw transient; },
      { status: 'succeeded', artifact: reviewArtifact() },
    ],
  });
  const runtime = createOsDispatchAgentRuntime({
    session,
    sleepImpl: async () => {},
    jitterImpl: () => 0,
  });
  const result = await (await runtime.run(reviewerRequest())).await();
  assert.equal(result.status, 'completed');
  assert.equal(session.statusCalls.length, 2);

  const unauthorized = new Error('unauthorized');
  unauthorized.status = 401;
  const fatalSession = fakeSession({ statusSequence: [() => { throw unauthorized; }] });
  const fatalResult = await (await createOsDispatchAgentRuntime({
    session: fatalSession,
    sleepImpl: async () => {},
  }).run(reviewerRequest())).await();
  assert.equal(fatalResult.status, 'failed');
  assert.equal(fatalSession.statusCalls.length, 1);
});

test('run keeps polling after transient dispatch_status retries are exhausted', async () => {
  const transient = () => {
    const error = new Error('connection reset');
    error.code = 'ECONNRESET';
    throw error;
  };
  const session = fakeSession({
    statusSequence: [
      transient,
      transient,
      transient,
      { status: 'succeeded', artifact: reviewArtifact() },
    ],
  });
  const sleeps = [];
  const warnings = [];
  const runtime = createOsDispatchAgentRuntime({
    session,
    pollBaseMs: 5_000,
    pollJitterMs: 1_000,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    jitterImpl: () => 250,
    logger: { warn: (...args) => warnings.push(args) },
  });

  const result = await (await runtime.run(reviewerRequest())).await();

  assert.equal(result.status, 'completed');
  assert.equal(session.statusCalls.length, 4);
  assert.deepEqual(sleeps, [50, 100, 5_250]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /polling will continue/);
});

test('run retries transient connect and dispatch failures', async () => {
  const session = fakeSession({
    statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }],
  });
  let connectCalls = 0;
  let dispatchCalls = 0;
  const originalDispatch = session.dispatch;
  session.dispatch = async function dispatch(payload) {
    dispatchCalls += 1;
    if (dispatchCalls === 1) {
      const error = new Error('app-contract 503 service unavailable');
      error.status = 503;
      throw error;
    }
    return originalDispatch.call(this, payload);
  };
  const runtime = createOsDispatchAgentRuntime({
    connectImpl: async () => {
      connectCalls += 1;
      if (connectCalls === 1) {
        const error = new Error('connection reset');
        error.code = 'ECONNRESET';
        throw error;
      }
      return session;
    },
    sleepImpl: async () => {},
  });

  const result = await (await runtime.run(reviewerRequest())).await();
  assert.equal(result.status, 'completed');
  assert.equal(connectCalls, 2);
  assert.equal(dispatchCalls, 2);
  assert.equal(session.dispatched.length, 1);
});

test('run refreshes the app-contract session when dispatch sees an expired bearer', async () => {
  const staleSession = fakeSession();
  let staleDispatchCalls = 0;
  staleSession.dispatch = async function dispatch() {
    staleDispatchCalls += 1;
    throw new Error('app-contract expired_session_token: session token has expired');
  };
  const freshSession = fakeSession({
    statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }],
  });
  const sessions = [staleSession, freshSession];
  let connectCalls = 0;
  const runtime = createOsDispatchAgentRuntime({
    connectImpl: async () => {
      const next = sessions[connectCalls];
      connectCalls += 1;
      return next;
    },
    sleepImpl: async () => {},
  });

  const result = await (await runtime.run(reviewerRequest())).await();

  assert.equal(result.status, 'completed');
  assert.equal(connectCalls, 2);
  assert.equal(staleDispatchCalls, 1);
  assert.equal(freshSession.dispatched.length, 1);
});

test('run refreshes the app-contract session when dispatch_status sees an expired bearer', async () => {
  const staleSession = fakeSession();
  staleSession.dispatchStatus = async function dispatchStatus(requestId) {
    this.statusCalls.push(requestId);
    throw new Error('app-contract expired_session_token: session token has expired');
  };
  const freshSession = fakeSession({
    statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }],
  });
  const sessions = [staleSession, freshSession];
  let connectCalls = 0;
  const runtime = createOsDispatchAgentRuntime({
    connectImpl: async () => {
      const next = sessions[connectCalls];
      connectCalls += 1;
      return next;
    },
    sleepImpl: async () => {},
  });
  const request = reviewerRequest();
  const handle = await runtime.run(request);

  const result = await handle.await();

  assert.equal(result.status, 'completed');
  assert.equal(connectCalls, 2);
  assert.equal(staleSession.dispatched.length, 1);
  assert.equal(freshSession.dispatched.length, 0);
  assert.deepEqual(staleSession.statusCalls, [request.idempotencyKey]);
  assert.deepEqual(freshSession.statusCalls, [request.idempotencyKey]);
});

test('run supplies the adversarial-review app id when connecting to the App SDK', async () => {
  const session = fakeSession({
    statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }],
  });
  const connectCalls = [];
  const runtime = createOsDispatchAgentRuntime({
    connectImpl: async (options) => {
      connectCalls.push(options);
      return session;
    },
    sleepImpl: async () => {},
  });

  const result = await (await runtime.run(reviewerRequest())).await();

  assert.equal(result.status, 'completed');
  assert.equal(connectCalls.length, 1);
  assert.equal(connectCalls[0].app_id, DEFAULT_APP_CONTRACT_APP_ID);
  assert.equal(connectCalls[0].request_timeout_ms, DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS);
});

test('run resolves the registered app from the apps registry', async () => {
  const session = fakeSession({
    statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }],
  });
  const connectCalls = [];
  const runtime = createOsDispatchAgentRuntime({
    loadConfigImpl: () => ({
      get(key, defaultValue = null) {
        const values = {
          'apps.adversarial-review': {
            mode: 'agent-os',
            subscribes: ['health.worker.*', 'token.*', 'system.*'],
            contract_version: '1.0',
          },
        };
        return key in values ? values[key] : defaultValue;
      },
      sources: {
        'apps.adversarial-review.mode': 'top',
      },
    }),
    connectImpl: async (options) => {
      connectCalls.push(options);
      return session;
    },
    sleepImpl: async () => {},
  });

  const result = await (await runtime.run(reviewerRequest())).await();

  assert.equal(result.status, 'completed');
  assert.equal(connectCalls[0].app_id, 'adversarial-review');
});

test('explicit App SDK identity still wins over the os-dispatch default', async () => {
  const session = fakeSession({
    statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }],
  });
  const connectCalls = [];
  const runtime = createOsDispatchAgentRuntime({
    connectOptions: { app_id: 'fixture-app', mode: 'standalone' },
    connectImpl: async (options) => {
      connectCalls.push(options);
      return session;
    },
    sleepImpl: async () => {},
  });

  const result = await (await runtime.run(reviewerRequest())).await();

  assert.equal(result.status, 'completed');
  assert.equal(connectCalls[0].app_id, 'fixture-app');
  assert.equal(connectCalls[0].mode, 'standalone');
  assert.equal(connectCalls[0].request_timeout_ms, DEFAULT_APP_CONTRACT_REQUEST_TIMEOUT_MS);
});

test('explicit App SDK request timeout wins over the os-dispatch default', async () => {
  const session = fakeSession({
    statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }],
  });
  const connectCalls = [];
  const runtime = createOsDispatchAgentRuntime({
    connectOptions: {
      app_id: 'fixture-app',
      requestTimeoutMs: 12_345,
    },
    connectImpl: async (options) => {
      connectCalls.push(options);
      return session;
    },
    sleepImpl: async () => {},
  });

  const result = await (await runtime.run(reviewerRequest())).await();

  assert.equal(result.status, 'completed');
  assert.equal(connectCalls[0].requestTimeoutMs, 12_345);
  assert.equal(connectCalls[0].request_timeout_ms, undefined);
});

test('multiple await calls share one dispatch_status polling loop', async () => {
  const session = fakeSession({
    statusSequence: [{ status: 'running' }, { status: 'succeeded', artifact: reviewArtifact() }],
  });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {}, jitterImpl: () => 0 });
  const handle = await runtime.run(reviewerRequest());
  const [first, second] = await Promise.all([handle.await(), handle.await()]);
  assert.equal(first.status, 'completed');
  assert.strictEqual(first, second);
  assert.equal(session.statusCalls.length, 2);
});

test('run reports a failed RunResult when the dispatch call throws instead of throwing', async () => {
  const session = {
    async dispatch() { const err = new Error('endpoint unreachable'); throw err; },
    async dispatchStatus() { throw new Error('should not be polled'); },
  };
  const runtime = createOsDispatchAgentRuntime({ session });
  const handle = await runtime.run(reviewerRequest());
  const result = await handle.await();
  assert.equal(result.status, 'failed');
  assert.equal(result.failureClass, 'unknown');
  assert.equal(result.detail, 'endpoint unreachable');
});

test('run throws on a structurally invalid request (missing idempotencyKey)', async () => {
  const runtime = createOsDispatchAgentRuntime({ session: fakeSession() });
  await assert.rejects(
    runtime.run(reviewerRequest({ idempotencyKey: '' })),
    /idempotencyKey is required/,
  );
});

// -- record-scoped reattach ---------------------------------------------------

test('reattach re-polls dispatch_status using the record request_id (no re-dispatch)', async () => {
  const session = fakeSession({ statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }] });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const result = await runtime.reattach(
    { request_id: 'code-pr:pr-14:abc123:code-review:code-quality-reviewer:1', subjectContext: { agentRoleKind: 'reviewer' } },
  );
  assert.equal(session.dispatched.length, 0, 'reattach must not re-dispatch');
  assert.equal(session.statusCalls[0], 'code-pr:pr-14:abc123:code-review:code-quality-reviewer:1');
  assert.equal(result.status, 'completed');
});

test('reattach normalizes a legacy raw idempotency key before polling dispatch_status', async () => {
  const session = fakeSession({ statusSequence: [{ status: 'succeeded', artifact: reviewArtifact() }] });
  const runtime = createOsDispatchAgentRuntime({ session, sleepImpl: async () => {} });
  const rawKey = 'code-pr:laceyenterprises/agent-os#4284:abc123:review:reviewer:gemini:1';
  const expectedRequestId = toAppContractRequestId(rawKey);
  const result = await runtime.reattach(
    { request_id: rawKey, subjectContext: { agentRoleKind: 'reviewer' } },
  );
  assert.equal(session.dispatched.length, 0, 'reattach must not re-dispatch');
  assert.deepEqual(session.statusCalls, [expectedRequestId]);
  assert.equal(result.status, 'completed');
});

test('reattach preserves the original execution timeout budget', async () => {
  const session = fakeSession({ statusSequence: [{ status: 'running' }] });
  let clock = 10_000;
  const runtime = createOsDispatchAgentRuntime({
    session,
    nowMs: () => clock,
    sleepImpl: async () => { clock += 1_000; },
    jitterImpl: () => 0,
  });
  const result = await runtime.reattach({
    request_id: 'reattach-timeout',
    runningAt: new Date(8_000).toISOString(),
    timeoutMs: 3_000,
    subjectContext: { agentRoleKind: 'reviewer' },
  });
  assert.equal(result.status, 'timeout');
  assert.equal(session.statusCalls.length, 1);
  assert.deepEqual(session.cancelCalls, ['reattach-timeout']);
});

test('reattach fails cleanly when the record carries no request_id', async () => {
  const runtime = createOsDispatchAgentRuntime({ session: fakeSession() });
  const result = await runtime.reattach({ subjectContext: {} });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureClass, 'daemon-bounce');
});

// -- stub-endpoint round-trip -------------------------------------------------

async function withStubEndpoint(run, { statusResponders } = {}) {
  const requests = [];
  let statusIndex = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    requests.push({ url: req.url, body });

    const json = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.url === '/v1/register') return json({ session_token: 'sess_arc06' });
    if (req.url === '/v1/dispatch') {
      return json({ request_id: body.request_id, launch_request_id: `lrq_${body.request_id}` });
    }
    if (req.url === '/v1/dispatch_status') {
      const responder = statusResponders[Math.min(statusIndex, statusResponders.length - 1)];
      statusIndex += 1;
      return json(responder(body.request_id));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: req.url } }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    return await run({ requests, port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('stub-endpoint round-trip: dispatch → poll → validated verdict artifact', async () => {
  await withStubEndpoint(async ({ requests, port }) => {
    const runtime = createOsDispatchAgentRuntime({
      connectOptions: {
        app_id: 'adversarial-review',
        mode: 'agent-os',
        endpoint_url: `http://127.0.0.1:${port}`,
        bootstrap_token: 'bootstrap-arc06',
      },
      sleepImpl: async () => {},
      jitterImpl: () => 0,
    });

    const req = reviewerRequest();
    const handle = await runtime.run(req);
    const result = await handle.await();

    assert.equal(result.status, 'completed');
    assert.equal(result.runtimeMode, 'os');
    assert.equal(result.artifact.kind, REVIEW_ARTIFACT_KIND);
    assert.equal(result.artifact.verdict.kind, 'request-changes');
    assert.equal(result.usage.total, 99);

    const dispatch = requests.find((entry) => entry.url === '/v1/dispatch');
    assert.equal(dispatch.body.request_id, req.idempotencyKey);
    assert.equal(dispatch.body.task_kind, 'analysis');
    assert.equal(dispatch.body.completion_shape, 'decision-only');
    const statusReqs = requests.filter((entry) => entry.url === '/v1/dispatch_status');
    assert.ok(statusReqs.length >= 2, 'should have polled dispatch_status at least twice');
    assert.equal(statusReqs.at(-1).body.request_id, req.idempotencyKey);
  }, {
    statusResponders: [
      () => ({ status: 'running' }),
      (requestId) => ({
        status: 'succeeded',
        artifact: reviewArtifact({ reviewerRunRef: `lrq_${requestId}` }),
        usage: { total: 99 },
      }),
    ],
  });
});
