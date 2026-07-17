import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
  buildDispatchPayload,
  createOsDispatchAgentRuntime,
  mapTerminalStatus,
  resolveCompletionShape,
  resolveTaskKind,
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

test('reviewer derives review + decision-only, remediator derives remediation + branch-push', () => {
  assert.equal(resolveTaskKind({ kind: 'reviewer' }), 'review');
  assert.equal(resolveCompletionShape({ kind: 'reviewer' }), 'decision-only');
  assert.equal(resolveTaskKind({ kind: 'remediator' }), 'remediation');
  assert.equal(resolveCompletionShape({ kind: 'remediator' }), 'branch-push');
  // explicit overrides win
  assert.equal(resolveTaskKind({ kind: 'reviewer', taskKind: 'analysis' }), 'analysis');
  assert.equal(resolveCompletionShape({ kind: 'reviewer', completionShape: 'artifact' }), 'artifact');
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
  assert.equal(payload.task_kind, 'review');
  assert.equal(payload.completion_shape, 'decision-only');
  assert.equal(payload.worker_class, 'claude-code');
  assert.equal(payload.domain_id, 'code-pr');
  assert.equal(payload.subject_external_id, 'pr-14');
  assert.equal(payload.revision_ref, 'abc123');
  assert.equal(payload.ticket_ref, 'ARC-06');
  assert.equal(payload.token_budget, 500_000);
  assert.equal(payload.prompt, 'diff --git a b');
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
  assert.equal(session.dispatched[0].task_kind, 'remediation');
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

test('run retries transient dispatch_status failures but fails fast on client errors', async () => {
  const transient = new Error('connection reset');
  transient.code = 'ECONNRESET';
  const session = fakeSession({
    statusSequence: [
      () => { throw transient; },
      { status: 'succeeded', artifact: reviewArtifact() },
    ],
  });
  const warnings = [];
  const runtime = createOsDispatchAgentRuntime({
    session,
    sleepImpl: async () => {},
    jitterImpl: () => 0,
    logger: { warn: (...args) => warnings.push(args) },
  });
  const result = await (await runtime.run(reviewerRequest())).await();
  assert.equal(result.status, 'completed');
  assert.equal(session.statusCalls.length, 2);
  assert.equal(warnings.length, 1);

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

test('reattach preserves the original wall-clock timeout budget', async () => {
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
    spawnedAt: new Date(8_000).toISOString(),
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
    assert.equal(dispatch.body.task_kind, 'review');
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
