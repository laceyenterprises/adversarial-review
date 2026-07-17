import test from 'node:test';
import assert from 'node:assert/strict';

import { createHealthRouter } from '../src/adapters/agent-runtime/router/index.mjs';
import { classifyDispatchError } from '../src/adapters/agent-runtime/router/dispatch-error.mjs';
import { resolveRouterConfig } from '../src/adapters/agent-runtime/router/config.mjs';

// A local AgentRuntime stand-in: records which requests it ran and returns a
// completed local handle.
function fakeLocalRuntime() {
  const ran = [];
  return {
    ran,
    async run(request) {
      ran.push(request.idempotencyKey);
      return {
        runRef: `local:${request.idempotencyKey}`,
        mode: 'local',
        async await() { return { status: 'completed', runtimeMode: 'local' }; },
        async cancel() {},
        async reattach() { return { status: 'completed', runtimeMode: 'local' }; },
      };
    },
  };
}

// A fake app-contract session. `dispatchImpl` lets a test make a dispatch throw
// (hard/transport/4xx); `statusByKey` scripts dispatch_status for reconcile.
function fakeSession({ dispatchImpl, statusByKey = {} } = {}) {
  const dispatched = [];
  const statusCalls = [];
  return {
    dispatched,
    statusCalls,
    async dispatch(payload) {
      dispatched.push(payload);
      if (typeof dispatchImpl === 'function') return dispatchImpl(payload);
      return { app_id: 'adversarial-review', request_id: payload.request_id, launch_request_id: `lrq_${payload.request_id}` };
    },
    async dispatchStatus(requestId) {
      statusCalls.push(requestId);
      return statusByKey[requestId] || { status: 'not_found' };
    },
    async dispatchCancel() {},
  };
}

function reviewerRequest(key, overrides = {}) {
  return {
    role: { id: 'reviewer:claude-code', kind: 'reviewer', model: 'claude-code' },
    promptSet: 'code-pr',
    promptStage: 'first',
    subjectContent: {
      ref: { domainId: 'code-pr', subjectExternalId: 'pr-14', revisionRef: 'abc123' },
      representation: 'diff --git a b',
      observedAt: '2026-07-17T20:00:00.000Z',
    },
    idempotencyKey: key,
    budget: { maxTokens: 500_000, maxWallMs: 600_000 },
    timeoutMs: 600_000,
    ...overrides,
  };
}

function capturingAuditSink() {
  const transitions = [];
  return {
    transitions,
    async recordTransition(t) { transitions.push(t); return { row: t, auditWritten: true, noticeDelivered: true }; },
  };
}

test('classifyDispatchError: 4xx invalid-subject is a request error; 5xx/transport are hard', () => {
  assert.equal(classifyDispatchError({ status: 400 }), 'request');
  assert.equal(classifyDispatchError({ status: 422 }), 'request');
  assert.equal(classifyDispatchError({ status: 404 }), 'request');
  assert.equal(classifyDispatchError({ status: 503 }), 'hard');
  assert.equal(classifyDispatchError({ status: 429 }), 'hard');
  assert.equal(classifyDispatchError({ status: 403 }), 'hard');
  assert.equal(classifyDispatchError({ code: 'ECONNREFUSED' }), 'hard');
  assert.equal(classifyDispatchError({ retryable: true }), 'hard');
  assert.equal(classifyDispatchError({ configurationError: true }), 'hard');
});

test('healthy OS mode routes runs to os-dispatch and tracks them as pending', async () => {
  const local = fakeLocalRuntime();
  const session = fakeSession({ statusByKey: { k1: { status: 'running' } } });
  const router = createHealthRouter({
    localRuntime: local,
    session,
    auditSink: capturingAuditSink(),
    config: resolveRouterConfig({}, { probeFailureThreshold: 3 }),
  });

  const handle = await router.run(reviewerRequest('k1'));
  assert.equal(handle.mode, 'os');
  assert.equal(session.dispatched.length, 1);
  assert.equal(session.dispatched[0].request_id, 'k1');
  assert.equal(local.ran.length, 0);
  assert.deepEqual(router.pendingOsKeys(), ['k1']);
});

test('a hard contract error on a live dispatch fails over and reissues locally (fast path)', async () => {
  const local = fakeLocalRuntime();
  const audit = capturingAuditSink();
  const session = fakeSession({
    dispatchImpl: () => { const e = new Error('service unavailable'); e.status = 503; throw e; },
  });
  const router = createHealthRouter({ localRuntime: local, session, auditSink: audit });

  assert.equal(router.getMode(), 'os');
  const handle = await router.run(reviewerRequest('k1'));

  // The run was reissued on local, and the router flipped to local mode.
  assert.equal(handle.mode, 'local');
  assert.deepEqual(local.ran, ['k1']);
  assert.equal(router.getMode(), 'local');

  // Exactly one failover transition was audited.
  assert.equal(audit.transitions.length, 1);
  assert.equal(audit.transitions[0].kind, 'failover');
  assert.equal(audit.transitions[0].reason, 'hard-contract-error');
});

test('a per-subject 4xx fails only that run and does NOT change router state', async () => {
  const local = fakeLocalRuntime();
  const audit = capturingAuditSink();
  const session = fakeSession({
    dispatchImpl: () => { const e = new Error('invalid subject'); e.status = 422; throw e; },
  });
  const router = createHealthRouter({ localRuntime: local, session, auditSink: audit });

  const handle = await router.run(reviewerRequest('k1'));
  // os-dispatch surfaces the failure as an OS handle; router stays in OS mode.
  assert.equal(handle.mode, 'os');
  const result = await handle.await();
  assert.equal(result.status, 'failed');
  assert.equal(router.getMode(), 'os');
  assert.equal(local.ran.length, 0);
  assert.equal(audit.transitions.length, 0, 'a request-level 4xx must not trigger a transition');
});

test('probe-driven failover then resume reconciles pending OS keys, adopting without duplicating', async () => {
  const local = fakeLocalRuntime();
  const audit = capturingAuditSink();
  let clockMs = 1_000;
  const now = () => clockMs;
  let healthzOk = true;
  // The endpoint still knows the pre-failover dispatch when resume reconciles.
  const session = fakeSession({ statusByKey: { k1: { status: 'running' } } });
  const adoptCalls = [];

  const router = createHealthRouter({
    localRuntime: local,
    session,
    auditSink: audit,
    now,
    checkHealthz: async () => healthzOk,
    adopt: (key) => { adoptCalls.push(key); },
    config: resolveRouterConfig({}, {
      probeFailureThreshold: 3,
      resumeHealthyProbes: 2,
      resumeWindowMs: 10,
    }),
  });

  // Dispatch one OS run so there is a pending key to reconcile on resume.
  await router.run(reviewerRequest('k1'));
  assert.deepEqual(router.pendingOsKeys(), ['k1']);

  // Three failing probes → failover.
  healthzOk = false;
  await router.tick();
  await router.tick();
  const failoverTick = await router.tick();
  assert.equal(failoverTick.transition.kind, 'failover');
  assert.equal(router.getMode(), 'local');

  // A run now goes to local (finishes in the started mode).
  const localHandle = await router.run(reviewerRequest('k2'));
  assert.equal(localHandle.mode, 'local');
  assert.deepEqual(local.ran, ['k2']);

  // Healthy probes spanning the window → resume.
  healthzOk = true;
  clockMs += 20; await router.tick();
  clockMs += 20; const resumeTick = await router.tick();
  assert.equal(resumeTick.transition.kind, 'resume-start');
  assert.equal(router.getMode(), 'os', 'after reconcile the router is back on OS');

  // Reconcile adopted the pending pre-failover key, never re-issued it.
  assert.deepEqual(adoptCalls, ['k1']);
  const st = router.status();
  assert.equal(st.reconciled.adopted, 1);
  assert.equal(st.reconciled.duplicated, 0);

  // Transitions: failover, resume-start, resume-complete — all audited.
  const kinds = audit.transitions.map((t) => t.kind);
  assert.deepEqual(kinds, ['failover', 'resume-start', 'resume-complete']);
  assert.equal(router.getMode(), 'os');
});

test('resume does not retain completed keys when the OS runtime cannot reattach', async () => {
  let clockMs = 1_000;
  let healthzOk = true;
  const osRuntime = {
    async run(request) {
      return {
        runRef: `os:${request.idempotencyKey}`,
        mode: 'os',
        async await() { return { status: 'completed' }; },
        async cancel() {},
        async reattach() {},
      };
    },
  };
  const router = createHealthRouter({
    localRuntime: fakeLocalRuntime(),
    osRuntime,
    dispatchStatus: async () => ({ status: 'succeeded' }),
    auditSink: capturingAuditSink(),
    now: () => clockMs,
    checkHealthz: async () => healthzOk,
    config: resolveRouterConfig({}, {
      probeFailureThreshold: 1,
      resumeHealthyProbes: 2,
      resumeWindowMs: 1,
    }),
  });

  const handle = await router.run(reviewerRequest('completed-before-resume'));
  healthzOk = false;
  await router.tick();
  await handle.await();
  assert.deepEqual(router.pendingOsKeys(), []);

  healthzOk = true;
  clockMs += 1;
  await router.tick();
  clockMs += 1;
  await router.tick();
  assert.deepEqual(router.pendingOsKeys(), []);
});

test('runtime throws still consume a stashed dispatch classification', async () => {
  const taken = [];
  const router = createHealthRouter({
    localRuntime: fakeLocalRuntime(),
    osRuntime: { async run() { throw new Error('runtime crashed'); } },
    takeClassification(key) { taken.push(key); return { kind: 'hard' }; },
    auditSink: capturingAuditSink(),
  });

  await assert.rejects(router.run(reviewerRequest('throwing-key')), /runtime crashed/);
  assert.deepEqual(taken, ['throwing-key']);
});

test('healthz probes time out and feed a failed probe to the state machine', async () => {
  let timeoutDelay = null;
  const router = createHealthRouter({
    localRuntime: fakeLocalRuntime(),
    auditSink: capturingAuditSink(),
    checkHealthz: () => new Promise(() => {}),
    setTimeoutFn(callback, delay) {
      timeoutDelay = delay;
      queueMicrotask(callback);
      return 17;
    },
    clearTimeoutFn() {},
    config: resolveRouterConfig({}, {
      healthzTimeoutMs: 25,
      probeFailureThreshold: 1,
    }),
  });

  const result = await router.tick();
  assert.equal(timeoutDelay, 25);
  assert.equal(result.probe.healthy, false);
  assert.equal(result.probe.components.healthzOk, false);
  assert.equal(result.probe.components.healthzDetail, 'healthz timed out after 25ms');
  assert.equal(result.transition.kind, 'failover');
});

test('interval probing skips overlapping ticks while a probe is in flight', async () => {
  let intervalCallback;
  let healthzCalls = 0;
  let resolveHealthz;
  const healthz = new Promise((resolve) => { resolveHealthz = resolve; });
  const router = createHealthRouter({
    localRuntime: fakeLocalRuntime(),
    auditSink: capturingAuditSink(),
    checkHealthz() {
      healthzCalls += 1;
      return healthz;
    },
    setIntervalFn(callback) {
      intervalCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
    config: resolveRouterConfig({}, { healthzTimeoutMs: 60_000 }),
  });

  router.start();
  intervalCallback();
  intervalCallback();
  assert.equal(healthzCalls, 1);

  resolveHealthz(true);
  await new Promise((resolve) => setImmediate(resolve));
  intervalCallback();
  assert.equal(healthzCalls, 2);
  router.stop();
});

test('with automatic failover disabled, a hard error does not flip modes', async () => {
  const local = fakeLocalRuntime();
  const audit = capturingAuditSink();
  const session = fakeSession({
    dispatchImpl: () => { const e = new Error('down'); e.status = 503; throw e; },
  });
  const router = createHealthRouter({
    localRuntime: local,
    session,
    auditSink: audit,
    config: resolveRouterConfig({}, { enabled: false }),
  });
  const handle = await router.run(reviewerRequest('k1'));
  assert.equal(handle.mode, 'os');
  assert.equal(router.getMode(), 'os');
  assert.equal(audit.transitions.length, 0);
});
