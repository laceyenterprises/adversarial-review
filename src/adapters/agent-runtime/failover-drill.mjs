// Failover drill (ARC-09, SPEC §3 ARC-09 / §6 Risks "Resume double-dispatch").
// A disaster-recovery mechanism you never rehearse is a mechanism you don't
// have. This drill exercises the REAL ARC-07 health router end to end inside a
// SANDBOXED fixture harness — an in-memory fake app-contract session whose
// connectivity the drill toggles, a fake local runtime, and the real router +
// disk-writing audit sink. It:
//
//   1. dispatches a run while healthy (OS mode, pending key tracked);
//   2. KILLS OS connectivity (healthz down + dispatch throws transport) and
//      asserts the router fails over to the local lifeline after k probes;
//   3. asserts new work runs locally during the outage (no OS dispatch);
//   4. RESTORES connectivity and asserts the router resumes to OS after the
//      hysteresis window;
//   5. asserts resume RECONCILED the pre-failover key by adopting it via
//      dispatch_status — ZERO duplicate dispatches — then dispatches fresh.
//
// It NEVER touches a live OS endpoint: the only session is the in-memory fake,
// so it is safe to run in CI. The drill leaves behind a real audit trail and a
// status snapshot, so `runtime status --root <drill-root>` renders the very
// failover/resume cycle it just exercised.

import { createHealthRouter } from './router/index.mjs';
import { createRouterAuditSink } from './router/audit.mjs';
import { resolveRouterConfig } from './router/config.mjs';
import { persistRouterStatus } from '../../runtime-status-snapshot.mjs';

// A fake local AgentRuntime that records which requests it ran and settles
// immediately as completed-local.
function createDrillLocalRuntime() {
  const ran = [];
  return {
    ran,
    async run(request) {
      ran.push(String(request.idempotencyKey));
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

// A fake app-contract session whose connectivity the drill controls via
// `state.connected`. While disconnected, dispatch throws a transport error and
// dispatch_status throws too — a genuinely dark endpoint. `statusByKey` scripts
// the reconcile lookups performed once connectivity is restored.
function createDrillSession({ statusByKey = {} } = {}) {
  const state = { connected: true };
  const dispatched = [];
  const statusCalls = [];
  function transportDown(op) {
    const err = new Error(`os endpoint unreachable during ${op} (drill outage)`);
    err.code = 'ECONNREFUSED';
    err.retryable = true;
    return err;
  }
  return {
    state,
    dispatched,
    statusCalls,
    kill() { state.connected = false; },
    restore() { state.connected = true; },
    async dispatch(payload) {
      if (!state.connected) throw transportDown('dispatch');
      dispatched.push(payload);
      return {
        app_id: 'adversarial-review',
        request_id: payload.request_id,
        launch_request_id: `lrq_${payload.request_id}`,
      };
    },
    async dispatchStatus(requestId) {
      if (!state.connected) throw transportDown('dispatch_status');
      statusCalls.push(requestId);
      return statusByKey[requestId] || { status: 'not_found' };
    },
    async dispatchCancel() {},
  };
}

function reviewerRequest(key, { domainId = 'code-pr' } = {}) {
  return {
    role: { id: 'reviewer:claude-code', kind: 'reviewer', model: 'claude-code' },
    promptSet: domainId,
    promptStage: 'first',
    subjectContent: {
      ref: { domainId, subjectExternalId: 'drill-subject', revisionRef: `rev-${key}` },
      representation: 'diff --git a b',
      observedAt: '2026-07-17T20:00:00.000Z',
    },
    idempotencyKey: key,
    budget: { maxTokens: 200_000, maxWallMs: 600_000 },
    timeoutMs: 600_000,
  };
}

// Run the full failover/resume drill. Returns a structured report; the caller
// (script/test) decides how to render/assert it. Every assertion is captured as
// a phase result rather than thrown, so a failing drill reports WHICH invariant
// broke instead of dying on the first assert.
async function runFailoverDrill({
  rootDir,
  now = () => new Date(),
  probeFailureThreshold = 3,
  resumeHealthyProbes = 2,
  resumeWindowMs = 10,
  logger = console,
} = {}) {
  if (!rootDir) throw new TypeError('runFailoverDrill requires a sandbox rootDir');

  const preFailoverKey = 'drill-k1-prefailover';
  const outageKey = 'drill-k2-outage';
  const postResumeKey = 'drill-k3-postresume';

  const local = createDrillLocalRuntime();
  const session = createDrillSession({ statusByKey: { [preFailoverKey]: { status: 'running' } } });

  // Real disk-writing audit sink, but notices are swallowed — a drill must never
  // page the operator. Telemetry is left unset (best-effort, no-op).
  const auditSink = createRouterAuditSink({
    rootDir,
    deliverNoticeFn: async () => {},
    logger,
  });

  // Manual clock so the resume hysteresis window is crossed deterministically.
  let clockMs = 1_000;
  const nowMs = () => clockMs;
  let healthzOk = true;
  const adoptCalls = [];

  const router = createHealthRouter({
    rootDir,
    localRuntime: local,
    session,
    auditSink,
    now: nowMs,
    checkHealthz: async () => healthzOk && session.state.connected,
    adopt: (key) => { adoptCalls.push(key); },
    config: resolveRouterConfig({}, { probeFailureThreshold, resumeHealthyProbes, resumeWindowMs }),
  });

  const phases = [];
  let aborted = false;
  async function phase(name, fn) {
    if (aborted) {
      phases.push({ name, ok: false, detail: 'skipped (a prior phase failed)' });
      return;
    }
    try {
      const detail = await fn();
      phases.push({ name, ok: true, detail: detail || 'ok' });
    } catch (err) {
      aborted = true;
      phases.push({ name, ok: false, detail: err?.message || String(err) });
    }
  }

  function expect(condition, message) {
    if (!condition) throw new Error(message);
  }

  await phase('healthy-dispatch', async () => {
    expect(router.getMode() === 'os', `expected initial mode os, got ${router.getMode()}`);
    const handle = await router.run(reviewerRequest(preFailoverKey));
    expect(handle.mode === 'os', `expected OS handle, got ${handle.mode}`);
    expect(session.dispatched.length === 1, `expected 1 OS dispatch, got ${session.dispatched.length}`);
    expect(session.dispatched[0].request_id === preFailoverKey, 'pre-failover dispatch used wrong request_id');
    expect(router.pendingOsKeys().includes(preFailoverKey), 'pre-failover key not tracked as pending');
    return `dispatched ${preFailoverKey} to OS; pending=[${router.pendingOsKeys().join(',')}]`;
  });

  await phase('kill-os-and-failover', async () => {
    session.kill();
    healthzOk = false;
    let transition = null;
    for (let i = 0; i < probeFailureThreshold; i += 1) {
      const tick = await router.tick();
      transition = tick.transition || transition;
    }
    expect(transition && transition.kind === 'failover', 'expected a failover transition after k failed probes');
    expect(router.getMode() === 'local', `expected local mode after failover, got ${router.getMode()}`);
    return `failover after ${probeFailureThreshold} failed probes; mode=${router.getMode()}`;
  });

  await phase('local-serves-during-outage', async () => {
    const dispatchesBefore = session.dispatched.length;
    const handle = await router.run(reviewerRequest(outageKey));
    expect(handle.mode === 'local', `outage run should be local, got ${handle.mode}`);
    expect(local.ran.includes(outageKey), 'outage run was not served by the local runtime');
    expect(
      session.dispatched.length === dispatchesBefore,
      'a run during the outage must NOT reach the OS endpoint',
    );
    return `local runtime served ${outageKey}; OS dispatch count unchanged at ${session.dispatched.length}`;
  });

  await phase('restore-and-resume', async () => {
    session.restore();
    healthzOk = true;
    let resumeComplete = null;
    // Healthy probes must span >= resumeWindowMs; advance the clock each tick.
    for (let i = 0; i < resumeHealthyProbes + 2 && !resumeComplete; i += 1) {
      clockMs += resumeWindowMs;
      await router.tick();
      const last = router.machine.getLastTransition();
      if (last && last.kind === 'resume-complete') resumeComplete = last;
    }
    expect(resumeComplete, 'router did not resume to OS after connectivity was restored');
    expect(router.getMode() === 'os', `expected OS mode after resume, got ${router.getMode()}`);
    return `resumed to OS after hysteresis (${resumeHealthyProbes} healthy probes / ${resumeWindowMs}ms window)`;
  });

  await phase('reconcile-zero-duplicate', async () => {
    const st = router.status();
    expect(st.reconciled, 'no reconcile summary recorded on resume');
    expect(st.reconciled.adopted === 1, `expected 1 adopted key, got ${st.reconciled.adopted}`);
    expect(st.reconciled.duplicated === 0, `expected 0 duplicated dispatches, got ${st.reconciled.duplicated}`);
    expect(adoptCalls.length === 1 && adoptCalls[0] === preFailoverKey,
      `reconcile must adopt exactly the pre-failover key, adopted=[${adoptCalls.join(',')}]`);
    expect(session.statusCalls.includes(preFailoverKey),
      'reconcile must observe the pre-failover key via dispatch_status');
    // The strongest guarantee: the adopted key was dispatched EXACTLY once, ever.
    const dispatchesOfKey = session.dispatched.filter((d) => d.request_id === preFailoverKey).length;
    expect(dispatchesOfKey === 1, `pre-failover key must be dispatched exactly once, was ${dispatchesOfKey}`);
    return `adopted ${preFailoverKey} via dispatch_status; 0 duplicated; dispatched-once=${dispatchesOfKey === 1}`;
  });

  await phase('fresh-dispatch-after-resume', async () => {
    const dispatchesBefore = session.dispatched.length;
    const handle = await router.run(reviewerRequest(postResumeKey));
    expect(handle.mode === 'os', `post-resume run should be OS, got ${handle.mode}`);
    expect(session.dispatched.length === dispatchesBefore + 1, 'post-resume OS run did not dispatch');
    expect(session.dispatched[session.dispatched.length - 1].request_id === postResumeKey,
      'post-resume dispatch used wrong request_id');
    return `fresh OS dispatch ${postResumeKey} accepted; total OS dispatches=${session.dispatched.length}`;
  });

  // Persist the final router status so `runtime status` renders the drill.
  let snapshotWritten = false;
  try {
    persistRouterStatus(rootDir, router, { now });
    snapshotWritten = true;
  } catch (err) {
    logger?.warn?.('[failover-drill] failed to persist status snapshot', {
      error: err?.message || String(err),
    });
  }

  const transitions = router.machine.getHistory().map((t) => t.kind);
  const ok = phases.every((p) => p.ok);
  return {
    ok,
    at: now().toISOString(),
    phases,
    metrics: {
      osDispatchCount: session.dispatched.length,
      distinctOsKeysDispatched: new Set(session.dispatched.map((d) => d.request_id)).size,
      localRunCount: local.ran.length,
      adopted: router.status().reconciled?.adopted ?? 0,
      duplicated: router.status().reconciled?.duplicated ?? 0,
      dispatchStatusCalls: session.statusCalls.length,
      transitions,
    },
    snapshotWritten,
  };
}

export {
  createDrillLocalRuntime,
  createDrillSession,
  runFailoverDrill,
};
