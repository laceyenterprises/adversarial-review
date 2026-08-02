import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgentRuntimeReviewerRuntimeAdapter,
  createDefaultAgentRuntime,
  createLazyAppContractSession,
  reviewIdempotencyKey,
  toAgentRequest,
} from '../src/adapters/reviewer-runtime/agent-runtime/index.mjs';
import { resolveRouterConfig } from '../src/adapters/agent-runtime/router/config.mjs';
import {
  readReviewerRunRecord,
  writeReviewerRunRecord,
} from '../src/adapters/reviewer-runtime/run-state.mjs';
import { loadDomainConfig } from '../src/domain-config.mjs';
import { readRuntimeStatusSnapshot } from '../src/runtime-status-snapshot.mjs';

function makeRoot() {
  const rootDir = mkdtempSync(join(tmpdir(), 'agent-runtime-reviewer-adapter-'));
  mkdirSync(join(rootDir, 'domains'), { recursive: true });
  mkdirSync(join(rootDir, 'prompts', 'code-pr'), { recursive: true });
  writeFileSync(
    join(rootDir, 'domains', 'code-pr.json'),
    JSON.stringify({ id: 'code-pr', promptSet: 'code-pr' }),
  );
  for (const actor of ['reviewer', 'remediator']) {
    for (const stage of ['first', 'middle', 'last']) {
      writeFileSync(
        join(rootDir, 'prompts', 'code-pr', `${actor}.${stage}.md`),
        `fixture ${actor} ${stage} prompt`,
      );
    }
  }
  return rootDir;
}

function reviewerReq(overrides = {}) {
  return {
    model: 'claude-code',
    prompt: '',
    subjectContext: {
      domainId: 'code-pr',
      repo: 'laceyenterprises/demo',
      prNumber: 42,
      reviewerHeadSha: 'abc123',
      reviewAttemptNumber: 2,
      reviewDbAttemptNumber: 2,
      completedRemediationRounds: 1,
      maxRemediationRounds: 3,
      linearTicketId: 'PRD-01',
    },
    timeoutMs: 600_000,
    sessionUuid: 'watcher-session-1',
    forbiddenFallbacks: ['api-key'],
    ...overrides,
  };
}

function completedRuntime({ calls = [], body = '## Verdict\nComment only' } = {}) {
  return {
    async run(request) {
      calls.push(request);
      return {
        runRef: request.idempotencyKey,
        mode: 'os',
        async await() {
          return {
            status: 'completed',
            artifact: {
              kind: 'review',
              body,
              reattachToken: request.idempotencyKey,
              reviewerRunRef: 'lrq_123',
            },
            failureClass: null,
            usage: { total: 123 },
            runtimeMode: 'os',
          };
        },
        async cancel() {},
        async reattach() {
          throw new Error('live handle reattach should not be used after completion');
        },
      };
    },
    describe() {
      return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
    },
  };
}

function silentLogger() {
  return {
    log() {},
    warn() {},
    error() {},
  };
}

function completedCliDirect({ calls = [] } = {}) {
  return {
    async spawnReviewer(request) {
      calls.push(request);
      return {
        ok: true,
        reviewBody: '## Verdict\nComment only',
        tokenUsage: { total: 7 },
        reattachToken: request.sessionUuid,
      };
    },
    async spawnRemediator(request) {
      calls.push(request);
      return {
        ok: true,
        remediationBody: '{"addressed":[],"pushback":[],"blockers":[],"reReview":false}',
        tokenUsage: { total: 7 },
        reattachToken: request.sessionUuid,
      };
    },
    async cancel() {},
    async reattach() {
      throw new Error('test does not exercise local reattach');
    },
    describe() {
      return { id: 'fixture-cli-direct', capabilities: {} };
    },
  };
}

test('lazy app-contract session reattaches active SSE subscriptions after close reconnect', async () => {
  const sessions = [];
  const lazy = createLazyAppContractSession({
    connectImpl: async () => {
      const listeners = [];
      const session = {
        listeners,
        dispatchCalls: 0,
        closeCalls: 0,
        async dispatch() {
          this.dispatchCalls += 1;
          return { ok: true };
        },
        on(topic, cb) {
          const listener = { topic, cb, active: true };
          listeners.push(listener);
          return () => {
            listener.active = false;
          };
        },
        close() {
          this.closeCalls += 1;
        },
      };
      sessions.push(session);
      return session;
    },
    logger: silentLogger(),
  });

  const dispose = lazy.on('health.worker.*', () => {});
  await lazy.dispatch({ requestId: 'first' });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].listeners.length, 1);

  lazy.close();
  await lazy.dispatch({ requestId: 'second' });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].closeCalls, 1);
  assert.equal(sessions[1].listeners.length, 1);
  assert.equal(sessions[1].listeners[0].topic, 'health.worker.*');

  dispose();
  assert.equal(sessions[1].listeners[0].active, false);
});

test('lazy app-contract session closes an in-flight connection after caller close', async () => {
  let resolveConnect;
  const sessions = [];
  const lazy = createLazyAppContractSession({
    connectImpl: async () => new Promise((resolve) => {
      resolveConnect = resolve;
    }),
    logger: silentLogger(),
  });

  const pending = lazy.dispatch({ requestId: 'closing' });
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  lazy.close();
  const session = {
    closeCalls: 0,
    async dispatch() {
      throw new Error('stale closed session must not dispatch');
    },
    close() {
      this.closeCalls += 1;
    },
  };
  sessions.push(session);
  resolveConnect(session);

  await assert.rejects(pending, /closed while connection was pending/);
  assert.equal(session.closeCalls, 1);
});

test('lazy app-contract session closes and unwires a partially wired connection failure', async () => {
  const sessions = [];
  let failSecondListener = true;
  const lazy = createLazyAppContractSession({
    connectImpl: async () => {
      const listeners = [];
      const session = {
        listeners,
        closeCalls: 0,
        async dispatch() {
          return { ok: true };
        },
        on(topic, cb) {
          if (failSecondListener && topic === 'token.*') {
            throw new Error('subscription wiring failed');
          }
          const listener = { topic, cb, active: true };
          listeners.push(listener);
          return () => {
            listener.active = false;
          };
        },
        close() {
          this.closeCalls += 1;
        },
      };
      sessions.push(session);
      return session;
    },
    logger: silentLogger(),
  });

  lazy.on('health.worker.*', () => {});
  lazy.on('token.*', () => {});

  await assert.rejects(lazy.dispatch({ requestId: 'first' }), /subscription wiring failed/);
  assert.equal(sessions[0].closeCalls, 1);
  assert.equal(sessions[0].listeners.length, 1);
  assert.equal(sessions[0].listeners[0].active, false);

  failSecondListener = false;
  await lazy.dispatch({ requestId: 'second' });

  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions[1].listeners.map((listener) => listener.topic),
    ['health.worker.*', 'token.*'],
  );
});

test('default agent runtime removes injected session health listener on stop', () => {
  const rootDir = makeRoot();
  const listeners = [];
  try {
    const runtime = createDefaultAgentRuntime({
      rootDir,
      domainConfig: { id: 'code-pr', promptSet: 'code-pr' },
      logger: silentLogger(),
      localRuntimeOptions: {
        cliDirect: completedCliDirect(),
        admissionImpl: async () => ({
          admit: true,
          budget: { requestedTokens: 500, requestedWallMs: 30_000 },
        }),
      },
      osRuntimeOptions: {
        session: {
          async dispatch() {
            return { ok: true };
          },
          async dispatchStatus() {
            return { status: 'not_found' };
          },
          on(topic, cb) {
            const listener = { topic, cb, active: true };
            listeners.push(listener);
            return () => {
              listener.active = false;
            };
          },
          sseLive() {
            return true;
          },
        },
      },
      routerOptions: { autoStart: false },
    });

    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].topic, 'health.worker.*');
    runtime.stop();
    runtime.stop();
    assert.equal(listeners[0].active, false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('default agent runtime closes owned lazy app-contract session on stop', async () => {
  const rootDir = makeRoot();
  const listeners = [];
  const sessions = [];
  try {
    const runtime = createDefaultAgentRuntime({
      rootDir,
      domainConfig: { id: 'code-pr', promptSet: 'code-pr' },
      logger: silentLogger(),
      localRuntimeOptions: {
        cliDirect: completedCliDirect(),
        admissionImpl: async () => ({
          admit: true,
          budget: { requestedTokens: 500, requestedWallMs: 30_000 },
        }),
      },
      osRuntimeOptions: {
        connectImpl: async () => {
          const session = {
            closeCalls: 0,
            async dispatch() {
              return { ok: true };
            },
            async dispatchStatus() {
              return { status: 'not_found' };
            },
            on(topic, cb) {
              const listener = { topic, cb, active: true };
              listeners.push(listener);
              return () => {
                listener.active = false;
              };
            },
            sseLive() {
              return true;
            },
            close() {
              this.closeCalls += 1;
            },
          };
          sessions.push(session);
          return session;
        },
      },
      routerOptions: { autoStart: false },
    });
    const request = toAgentRequest(reviewerReq(), {
      kind: 'reviewer',
      rootDir,
      domainConfig: loadDomainConfig(rootDir, 'code-pr'),
    });

    await runtime.run(request);
    assert.equal(sessions.length, 1);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].topic, 'health.worker.*');

    runtime.stop();
    runtime.stop();

    assert.equal(listeners[0].active, false);
    assert.equal(sessions[0].closeCalls, 1);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('default agent runtime falls back from empty endpoint URL to default healthz URL', async () => {
  const rootDir = makeRoot();
  const urls = [];
  try {
    const runtime = createDefaultAgentRuntime({
      rootDir,
      domainConfig: { id: 'code-pr', promptSet: 'code-pr' },
      logger: silentLogger(),
      localRuntimeOptions: {
        cliDirect: completedCliDirect(),
        admissionImpl: async () => ({
          admit: true,
          budget: { requestedTokens: 500, requestedWallMs: 30_000 },
        }),
      },
      osRuntimeOptions: {
        session: {
          async dispatch() {
            return { ok: true };
          },
          async dispatchStatus() {
            return { status: 'not_found' };
          },
          on() {
            return () => {};
          },
          sseLive() {
            return true;
          },
        },
        connectOptions: { endpoint_url: '' },
        fetchImpl: async (url) => {
          urls.push(url);
          return {
            ok: true,
            async text() {
              return '';
            },
          };
        },
      },
      routerOptions: { autoStart: false },
    });

    await runtime.tick();

    assert.equal(urls[0], 'http://127.0.0.1:8003/healthz');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter returns the legacy spawnReviewer result shape', async () => {
  const rootDir = makeRoot();
  const calls = [];
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: completedRuntime({ calls }),
      now: () => new Date('2026-07-26T10:00:00.000Z'),
    });
    const req = reviewerReq();
    const result = await adapter.spawnReviewer(req);

    assert.equal(result.ok, true);
    assert.equal(result.reviewBody, '## Verdict\nComment only');
    assert.equal(result.failureClass, null);
    assert.equal(result.reattachToken, calls[0].idempotencyKey);
    assert.equal(result.launchRequestId, 'lrq_123');
    assert.equal(result.tokenUsage.total, 123);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].role.kind, 'reviewer');
    assert.equal(calls[0].role.model, 'claude-code');
    assert.equal(calls[0].promptSet, 'code-pr');
    assert.equal(calls[0].promptStage, 'middle');
    assert.equal(calls[0].subjectContent.representation, 'fixture reviewer middle prompt');
    assert.equal(calls[0].subjectContent.ref.subjectExternalId, 'laceyenterprises/demo#42');
    assert.equal(
      calls[0].idempotencyKey,
      reviewIdempotencyKey(req, { roleId: 'reviewer:claude-code' }),
    );

    const record = readReviewerRunRecord(rootDir, 'watcher-session-1');
    assert.equal(record.state, 'completed');
    assert.equal(record.runtime, 'agent-runtime');
    assert.equal(record.reattachToken, calls[0].idempotencyKey);
    assert.equal(record.subjectContext.agentRuntimeMode, 'os');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('default agent runtime fails over app-contract hard dispatch errors to local and snapshots status', async () => {
  const rootDir = makeRoot();
  const localCalls = [];
  const transitions = [];
  const dispatchAttempts = [];
  try {
    const runtime = createDefaultAgentRuntime({
      rootDir,
      domainConfig: { id: 'code-pr', promptSet: 'code-pr' },
      logger: silentLogger(),
      localRuntimeOptions: {
        cliDirect: completedCliDirect({ calls: localCalls }),
        admissionImpl: async () => ({
          admit: true,
          budget: { requestedTokens: 500, requestedWallMs: 30_000 },
        }),
      },
      osRuntimeOptions: {
        connectImpl: async () => ({
          async dispatch(payload) {
            dispatchAttempts.push(payload.request_id);
            throw new Error('app-contract 503: unavailable');
          },
          async dispatchStatus() {
            return { status: 'not_found' };
          },
          on() {
            return () => {};
          },
          sseLive() {
            return true;
          },
          close() {},
        }),
        sleepImpl: async () => {},
      },
      routerOptions: {
        autoStart: false,
        auditSink: {
          async recordTransition(transition) {
            transitions.push(transition);
            return { auditWritten: true, noticeDelivered: true };
          },
        },
      },
    });
    const request = toAgentRequest(reviewerReq(), {
      kind: 'reviewer',
      rootDir,
      domainConfig: loadDomainConfig(rootDir, 'code-pr'),
    });

    const handle = await runtime.run(request);
    const result = await handle.await();

    assert.equal(handle.mode, 'local');
    assert.equal(result.status, 'completed');
    assert.equal(runtime.getMode(), 'local');
    assert.equal(localCalls.length, 1);
    assert.ok(dispatchAttempts.length >= 1, 'OS dispatch should be attempted before failover');
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, 'failover');
    assert.equal(transitions[0].reason, 'hard-contract-error');
    const snapshot = readRuntimeStatusSnapshot(rootDir);
    assert.equal(snapshot?.status?.mode, 'local');
    assert.equal(snapshot?.status?.lastFailover?.reason, 'hard-contract-error');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('default agent runtime probe-down tick fails over and emits the failover event', async () => {
  const rootDir = makeRoot();
  const transitions = [];
  try {
    const runtime = createDefaultAgentRuntime({
      rootDir,
      domainConfig: { id: 'code-pr', promptSet: 'code-pr' },
      logger: silentLogger(),
      localRuntimeOptions: {
        cliDirect: completedCliDirect(),
        admissionImpl: async () => ({
          admit: true,
          budget: { requestedTokens: 500, requestedWallMs: 30_000 },
        }),
      },
      osRuntimeOptions: {
        session: {
          async dispatch() {
            return { ok: true };
          },
          async dispatchStatus() {
            return { status: 'not_found' };
          },
          on() {
            return () => {};
          },
          sseLive() {
            return true;
          },
        },
      },
      routerOptions: {
        autoStart: false,
        checkHealthz: async () => false,
        config: resolveRouterConfig({}, { probeFailureThreshold: 1 }),
        auditSink: {
          async recordTransition(transition) {
            transitions.push(transition);
            return {
              event: 'runtime.router.failover',
              auditWritten: true,
              noticeDelivered: true,
              telemetryEmitted: true,
            };
          },
        },
      },
    });

    const result = await runtime.tick();

    assert.equal(result.transition?.kind, 'failover');
    assert.equal(runtime.getMode(), 'local');
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].kind, 'failover');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('default agent runtime stays on SDK path when healthz is up and no hard error occurs', async () => {
  const rootDir = makeRoot();
  const transitions = [];
  const dispatchAttempts = [];
  try {
    const runtime = createDefaultAgentRuntime({
      rootDir,
      domainConfig: { id: 'code-pr', promptSet: 'code-pr' },
      logger: silentLogger(),
      localRuntimeOptions: {
        cliDirect: completedCliDirect(),
        admissionImpl: async () => ({
          admit: true,
          budget: { requestedTokens: 500, requestedWallMs: 30_000 },
        }),
      },
      osRuntimeOptions: {
        session: {
          async dispatch(payload) {
            dispatchAttempts.push(payload.request_id);
            return {
              app_id: 'adversarial-review',
              request_id: payload.request_id,
              launch_request_id: `lrq_${payload.request_id}`,
            };
          },
          async dispatchStatus() {
            return { status: 'running' };
          },
          on() {
            return () => {};
          },
          sseLive() {
            return true;
          },
        },
      },
      routerOptions: {
        autoStart: false,
        checkHealthz: async () => true,
        config: resolveRouterConfig({}, { probeFailureThreshold: 1 }),
        auditSink: {
          async recordTransition(transition) {
            transitions.push(transition);
            return { auditWritten: true, noticeDelivered: true };
          },
        },
      },
    });
    const request = toAgentRequest(reviewerReq(), {
      kind: 'reviewer',
      rootDir,
      domainConfig: loadDomainConfig(rootDir, 'code-pr'),
    });

    await runtime.run(request);
    runtime.markSseEvent();
    const tickResult = await runtime.tick();

    assert.equal(runtime.getMode(), 'os');
    assert.equal(dispatchAttempts.length, 1);
    assert.equal(tickResult.transition, null);
    assert.equal(transitions.length, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('default agent runtime status reports live-wired classification and healthz hooks', () => {
  const rootDir = makeRoot();
  try {
    const runtime = createDefaultAgentRuntime({
      rootDir,
      domainConfig: { id: 'code-pr', promptSet: 'code-pr' },
      logger: silentLogger(),
      localRuntimeOptions: {
        cliDirect: completedCliDirect(),
        admissionImpl: async () => ({
          admit: true,
          budget: { requestedTokens: 500, requestedWallMs: 30_000 },
        }),
      },
      osRuntimeOptions: {
        session: {
          async dispatch() {
            return { ok: true };
          },
          async dispatchStatus() {
            return { status: 'not_found' };
          },
          on() {
            return () => {};
          },
          sseLive() {
            return true;
          },
        },
      },
      routerOptions: { autoStart: false },
    });

    const status = runtime.status();

    assert.equal(status.wiring.takeClassification, true);
    assert.equal(status.wiring.checkHealthz, true);
    assert.equal(status.wiring.dispatchStatus, true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter preserves an explicit caller prompt', async () => {
  const rootDir = makeRoot();
  const calls = [];
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: completedRuntime({ calls }),
    });

    const result = await adapter.spawnReviewer(reviewerReq({
      prompt: 'explicit reviewer prompt',
      sessionUuid: 'watcher-session-explicit-prompt',
    }));

    assert.equal(result.ok, true);
    assert.equal(calls[0].subjectContent.representation, 'explicit reviewer prompt');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer request falls back to a non-empty app-contract prompt without a rootDir', () => {
  const agentRequest = toAgentRequest(reviewerReq(), { kind: 'reviewer' });

  assert.match(agentRequest.subjectContent.representation, /^Agent OS reviewer dispatch/);
  assert.match(agentRequest.subjectContent.representation, /Subject: laceyenterprises\/demo#42/);
});

test('agent-runtime reviewer idempotency keys include flat request revisions', () => {
  const base = {
    model: 'claude-code',
    repo: 'laceyenterprises/demo',
    prNumber: 42,
    reviewAttemptNumber: 1,
  };

  const first = reviewIdempotencyKey(
    { ...base, reviewerHeadSha: 'head-one' },
    { roleId: 'reviewer:claude-code' },
  );
  const second = reviewIdempotencyKey(
    { ...base, reviewerHeadSha: 'head-two' },
    { roleId: 'reviewer:claude-code' },
  );

  assert.match(first, /:head-one:/);
  assert.match(second, /:head-two:/);
  assert.notEqual(first, second);
});

test('agent-runtime reviewer idempotency keys advance with physical retry attempts', () => {
  const base = {
    model: 'gemini',
    repo: 'laceyenterprises/podium',
    prNumber: 11,
    reviewerHeadSha: '2ba80c216ebb81150ecb7926adb5d1486f7f95c4',
    reviewAttemptNumber: 1,
  };

  const first = reviewIdempotencyKey(
    { ...base, reviewDbAttemptNumber: 1 },
    { roleId: 'reviewer:gemini' },
  );
  const retry = reviewIdempotencyKey(
    { ...base, reviewDbAttemptNumber: 2 },
    { roleId: 'reviewer:gemini' },
  );

  assert.equal(
    first,
    'code-pr:laceyenterprises/podium#11:2ba80c216ebb81150ecb7926adb5d1486f7f95c4:review:reviewer:gemini:1',
  );
  assert.equal(
    retry,
    'code-pr:laceyenterprises/podium#11:2ba80c216ebb81150ecb7926adb5d1486f7f95c4:review:reviewer:gemini:2',
  );
  assert.notEqual(first, retry);
});

test('agent-runtime reviewer adapter reattaches an in-flight dispatch without issuing a duplicate run', async () => {
  const rootDir = makeRoot();
  const calls = { run: 0, reattach: 0 };
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: {
        async run() {
          calls.run += 1;
          throw new Error('reattach must not dispatch a new run');
        },
        async reattach(record) {
          calls.reattach += 1;
          assert.equal(record.reattachToken, 'code-pr:laceyenterprises/demo#42:abc123:review:reviewer:claude-code:2');
          return {
            status: 'completed',
            artifact: { kind: 'review', body: '## Verdict\nApprove' },
            failureClass: null,
            usage: null,
            runtimeMode: 'os',
          };
        },
        describe() {
          return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
        },
      },
    });
    const record = {
      sessionUuid: 'watcher-session-2',
      domain: 'code-pr',
      runtime: 'agent-runtime',
      state: 'heartbeating',
      pgid: null,
      spawnedAt: '2026-07-26T10:00:00.000Z',
      lastHeartbeatAt: '2026-07-26T10:01:00.000Z',
      reattachToken: 'code-pr:laceyenterprises/demo#42:abc123:review:reviewer:claude-code:2',
      subjectContext: {
        agentRoleKind: 'reviewer',
        reviewerModel: 'claude-code',
        agentRuntimeMode: 'os',
      },
    };

    const result = await adapter.reattach(record);
    assert.equal(result.ok, true);
    assert.equal(result.reviewBody, '## Verdict\nApprove');
    assert.deepEqual(calls, { run: 0, reattach: 1 });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter reattaches a held active lease instead of dispatching again', async () => {
  const rootDir = makeRoot();
  const calls = { run: 0, reattach: 0 };
  const req = reviewerReq({ sessionUuid: 'watcher-session-held' });
  const idempotencyKey = reviewIdempotencyKey(req, { roleId: 'reviewer:claude-code' });
  try {
    writeReviewerRunRecord(rootDir, {
      sessionUuid: req.sessionUuid,
      domain: 'code-pr',
      runtime: 'agent-runtime',
      state: 'heartbeating',
      pgid: null,
      spawnedAt: '2026-07-26T10:00:00.000Z',
      lastHeartbeatAt: '2026-07-26T10:01:00.000Z',
      reattachToken: idempotencyKey,
      subjectContext: {
        agentRoleKind: 'reviewer',
        reviewerModel: 'claude-code',
        agentRuntimeMode: 'os',
      },
    });

    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: {
        async run() {
          calls.run += 1;
          throw new Error('held lease must not dispatch a duplicate run');
        },
        async reattach(record) {
          calls.reattach += 1;
          assert.equal(record.sessionUuid, 'watcher-session-held');
          assert.equal(record.reattachToken, idempotencyKey);
          return {
            status: 'completed',
            artifact: { kind: 'review', body: '## Verdict\nComment only' },
            failureClass: null,
            usage: null,
            runtimeMode: 'os',
          };
        },
        describe() {
          return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
        },
      },
    });

    const result = await adapter.spawnReviewer(req);
    assert.equal(result.ok, true);
    assert.equal(result.reviewBody, '## Verdict\nComment only');
    assert.deepEqual(calls, { run: 0, reattach: 1 });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter settles failed when runtime run throws', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: {
        async run() {
          throw new Error('spawn failed before handle');
        },
        describe() {
          return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
        },
      },
    });

    await assert.rejects(
      adapter.spawnReviewer(reviewerReq({ sessionUuid: 'watcher-session-run-throws' })),
      /spawn failed before handle/,
    );
    assert.equal(readReviewerRunRecord(rootDir, 'watcher-session-run-throws').state, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter settles failed when handle await throws', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: {
        async run(request) {
          return {
            runRef: request.idempotencyKey,
            mode: 'os',
            async await() {
              throw new Error('await failed after spawn');
            },
            async cancel() {},
            async reattach() {
              throw new Error('reattach should not be used');
            },
          };
        },
        describe() {
          return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
        },
      },
    });

    await assert.rejects(
      adapter.spawnReviewer(reviewerReq({ sessionUuid: 'watcher-session-await-throws' })),
      /await failed after spawn/,
    );
    assert.equal(readReviewerRunRecord(rootDir, 'watcher-session-await-throws').state, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter fails closed when a completed run has no review body', async () => {
  const rootDir = makeRoot();
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: completedRuntime({ body: '' }),
    });

    const result = await adapter.spawnReviewer(reviewerReq({ sessionUuid: 'watcher-session-empty' }));
    assert.equal(result.ok, false);
    assert.equal(result.reviewBody, null);
    assert.equal(result.failureClass, 'reviewer-output');
    assert.equal(readReviewerRunRecord(rootDir, 'watcher-session-empty').state, 'failed');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime reviewer adapter settles cancelled even when handle cancel throws', async () => {
  const rootDir = makeRoot();
  const logger = { warn() {} };
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      logger,
      agentRuntime: {
        async run(request) {
          return {
            runRef: request.idempotencyKey,
            mode: 'os',
            async await() {
              return new Promise(() => {});
            },
            async cancel() {
              throw new Error('cancel transport failed');
            },
            async reattach() {
              throw new Error('reattach should not be used');
            },
          };
        },
        describe() {
          return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
        },
      },
    });

    const pending = adapter.spawnReviewer(
      reviewerReq({ sessionUuid: 'watcher-session-cancel-throws' }),
    );
    pending.catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.cancel('watcher-session-cancel-throws');
    assert.equal(readReviewerRunRecord(rootDir, 'watcher-session-cancel-throws').state, 'cancelled');
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('agent-runtime remediator request uses the next remediation round when omitted', () => {
  const req = {
    model: 'codex',
    prompt: 'fix it',
    repo: 'laceyenterprises/demo',
    prNumber: 42,
    reviewerHeadSha: 'def456',
    completedRemediationRounds: 1,
    maxRemediationRounds: 3,
    sessionUuid: 'remediator-session-1',
  };

  const agentRequest = toAgentRequest(req, { kind: 'remediator' });

  assert.equal(
    agentRequest.idempotencyKey,
    'code-pr:laceyenterprises/demo#42:def456:remediation:remediator:codex:2',
  );
  assert.equal(agentRequest.promptStage, 'middle');
  assert.equal(agentRequest.subjectContent.ref.subjectExternalId, 'laceyenterprises/demo#42');
});

test('agent-runtime reviewer adapter cancels spawned handle when run-state update fails', async () => {
  const rootDir = makeRoot();
  const calls = { cancel: 0, await: 0 };
  try {
    const adapter = createAgentRuntimeReviewerRuntimeAdapter({
      rootDir,
      domainConfig: { id: 'code-pr' },
      agentRuntime: {
        async run(request) {
          const stateDir = join(rootDir, 'data', 'reviewer-runs');
          rmSync(stateDir, { recursive: true, force: true });
          writeFileSync(stateDir, 'not a directory');
          return {
            runRef: request.idempotencyKey,
            mode: 'os',
            async await() {
              calls.await += 1;
              throw new Error('leaked handle should not be awaited');
            },
            async cancel() {
              calls.cancel += 1;
            },
            async reattach() {
              throw new Error('reattach should not be used');
            },
          };
        },
        describe() {
          return { id: 'fixture-agent-runtime', mode: 'os', capabilities: {} };
        },
      },
    });

    await assert.rejects(
      adapter.spawnReviewer(reviewerReq({ sessionUuid: 'watcher-session-update-fails' })),
      { code: 'EEXIST' },
    );
    assert.deepEqual(calls, { cancel: 1, await: 0 });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('production code-pr domain declares the settle-proven agent-runtime reviewer path', () => {
  const config = loadDomainConfig(process.cwd(), 'code-pr');
  assert.equal(config.reviewerRuntime, 'agent-runtime');
});

test('production code-pr-security domain declares the settle-proven agent-runtime reviewer path', () => {
  const config = loadDomainConfig(process.cwd(), 'code-pr-security');
  assert.equal(config.reviewerRuntime, 'agent-runtime');
});
