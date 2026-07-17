// The hybrid health router (v2 app architecture §6.2–6.5). It sits in front of
// the two AgentRuntime implementations and routes each run to the mode the
// state machine is currently in — `os` (os-dispatch) when healthy, `local`
// (the outage lifeline) after failover. It:
//   - selects the runtime at run() time so a run finishes in the mode it started
//     (no mid-flight migration, §6.3);
//   - instruments OS dispatches to feed the probe's rolling p95 and to classify
//     a hard contract error (fail-closed / transport) for the failover fast path;
//   - runs a periodic probe (healthz ∧ p95 ∧ SSE liveness) driving the machine;
//   - reconciles idempotency keys on resume — adopting accepted-but-unobserved
//     dispatches, never re-issuing them;
//   - emits an operator notice + audit row + best-effort telemetry per transition.

import { createOsDispatchAgentRuntime } from '../os-dispatch/index.mjs';
import { resolveRouterConfig } from './config.mjs';
import { createRouterStateMachine, TRANSITION_KINDS } from './state-machine.mjs';
import { createLatencyWindow } from './latency-window.mjs';
import { createRouterAuditSink } from './audit.mjs';
import { createSseLivenessTracker, probeOnce } from './probe.mjs';
import { reconcileDispatches } from './reconcile.mjs';
import { classifyDispatchError } from './dispatch-error.mjs';

// Wrap an app-contract session so every dispatch feeds the router's signals:
// successful acceptances record their latency into the rolling window; failures
// are classified (hard vs request) and stashed by request_id for the run path to
// read. `dispatchStatus`/`dispatchCancel`/`on` pass straight through.
function instrumentSession(session, { latencyWindow, classify = classifyDispatchError, now = () => Date.now() }) {
  const classifications = new Map();
  const wrapped = {
    async dispatch(payload) {
      const key = payload?.request_id;
      const startedAt = now();
      try {
        const result = await session.dispatch(payload);
        latencyWindow.record(now() - startedAt);
        if (key != null) classifications.delete(key);
        return result;
      } catch (err) {
        if (key != null) {
          classifications.set(key, {
            kind: classify(err),
            detail: err?.message || String(err),
            at: now(),
          });
        }
        throw err;
      }
    },
    dispatchStatus: (requestId) => session.dispatchStatus(requestId),
    takeClassification(key) {
      const found = classifications.get(key) || null;
      if (found) classifications.delete(key);
      return found;
    },
  };
  if (typeof session.dispatchCancel === 'function') {
    wrapped.dispatchCancel = (requestId) => session.dispatchCancel(requestId);
  }
  if (typeof session.on === 'function') {
    wrapped.on = (topic, cb) => session.on(topic, cb);
  }
  if (typeof session.emitTopic === 'function') {
    wrapped.emitTopic = (topic, event) => session.emitTopic(topic, event);
  }
  return wrapped;
}

function createHealthRouter({
  rootDir = process.cwd(),
  config = resolveRouterConfig(),
  session = null,
  osRuntime = null,
  localRuntime,
  latencyWindow = createLatencyWindow({ size: config.dispatchLatencyWindowSize }),
  takeClassification = null,
  dispatchStatus = null,
  auditSink = null,
  machine = null,
  now = () => Date.now(),
  clock = () => new Date(),
  checkHealthz = null,
  sseTracker = null,
  adopt = null,
  emitTelemetryFn = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  if (!localRuntime || typeof localRuntime.run !== 'function') {
    throw new TypeError('createHealthRouter requires a local AgentRuntime');
  }

  // Build the OS runtime over an instrumented session when one wasn't injected.
  if (!osRuntime && session) {
    const instrumented = instrumentSession(session, { latencyWindow, now });
    osRuntime = createOsDispatchAgentRuntime({ session: instrumented, logger });
    takeClassification = instrumented.takeClassification;
    dispatchStatus = dispatchStatus || ((key) => instrumented.dispatchStatus(key));
  } else if (session && !dispatchStatus && typeof session.dispatchStatus === 'function') {
    dispatchStatus = (key) => session.dispatchStatus(key);
  }

  const stateMachine = machine || createRouterStateMachine({ config, now });
  const sse = sseTracker || createSseLivenessTracker({ config, now });
  const sink = auditSink || createRouterAuditSink({
    rootDir,
    now: clock,
    emitTelemetryFn,
    logger,
  });

  const pendingOsKeys = new Set();
  let reconcileCandidates = new Set();
  const startedAt = clock().toISOString();
  let lastProbe = null;
  let lastFailover = null;
  let lastResume = null;
  let lastReconcile = null;
  let lastTransitionAt = startedAt;
  let probeTimer = null;
  let isTicking = false;

  function defaultAdopt(key) {
    // Re-observe the accepted dispatch in the background rather than re-issuing.
    // The artifact-handoff active-run compare-and-set (§6.3) discards a late
    // completion for a superseded key, so best-effort re-poll is safe.
    pendingOsKeys.add(key);
    if (osRuntime && typeof osRuntime.reattach === 'function') {
      Promise.resolve()
        .then(() => osRuntime.reattach({ idempotencyKey: key }))
        .catch((err) => logger?.warn?.('[health-router] background adopt re-poll failed', {
          key, error: err?.message || String(err),
        }))
        .finally(() => pendingOsKeys.delete(key));
    }
  }

  async function runReconcile() {
    if (typeof dispatchStatus !== 'function') {
      logger?.warn?.('[health-router] resume reconcile skipped: no dispatch_status source');
      return { adopted: [], notFound: [], unknown: [], adoptedCount: 0, notFoundCount: 0, unknownCount: 0, duplicatedCount: 0 };
    }
    const keys = [...reconcileCandidates];
    return reconcileDispatches({
      keys,
      dispatchStatus,
      adopt: adopt || defaultAdopt,
      logger,
    });
  }

  async function handleTransition(transition) {
    if (!transition) return;
    lastTransitionAt = transition.at;

    if (transition.kind === TRANSITION_KINDS.FAILOVER) {
      // Snapshot the keys possibly handed to the OS but not yet observed — these
      // are what resume must reconcile.
      reconcileCandidates = new Set(pendingOsKeys);
      lastFailover = transition;
    } else if (transition.kind === TRANSITION_KINDS.RESUME_ABORTED) {
      lastFailover = transition;
    }

    await sink.recordTransition(transition);

    if (transition.kind === TRANSITION_KINDS.RESUME_START) {
      const summary = await runReconcile();
      lastReconcile = summary;
      const completed = stateMachine.completeResume(summary);
      if (completed) await handleTransition(completed);
    } else if (transition.kind === TRANSITION_KINDS.RESUME_COMPLETE) {
      lastResume = transition;
      reconcileCandidates = new Set(); // consumed by the reconcile above
    }
  }

  function trackedOsHandle(handle, key) {
    const untrack = () => pendingOsKeys.delete(key);
    return {
      runRef: handle.runRef,
      mode: handle.mode,
      async await() {
        try {
          return await handle.await();
        } finally {
          untrack();
        }
      },
      async cancel() {
        try {
          return await handle.cancel();
        } finally {
          untrack();
        }
      },
      async reattach() {
        return handle.reattach();
      },
    };
  }

  async function runOs(request) {
    if (!osRuntime || typeof osRuntime.run !== 'function') {
      throw new Error('health router selected OS mode but has no OS runtime configured');
    }
    const key = String(request.idempotencyKey);
    const handle = await osRuntime.run(request);
    const classification = typeof takeClassification === 'function' ? takeClassification(key) : null;
    if (config.enabled && classification && classification.kind === 'hard') {
      const transition = stateMachine.recordHardError({ detail: classification.detail, requestId: key });
      if (transition) await handleTransition(transition);
      // The endpoint rejected the dispatch, so the OS never accepted it —
      // reissuing on local is not a mid-flight migration.
      return localRuntime.run(request);
    }
    pendingOsKeys.add(key);
    return trackedOsHandle(handle, key);
  }

  async function run(request) {
    return stateMachine.getMode() === 'os' ? runOs(request) : localRuntime.run(request);
  }

  // One probe cycle: sample the three signals, feed the machine, react to any
  // transition. Exposed for deterministic tests as well as the interval loop.
  async function tick() {
    const probe = await probeOnce({
      checkHealthz,
      dispatchP95Ms: () => latencyWindow.p95(),
      sseLive: () => sse.live(),
      config,
      now,
      setTimeoutFn,
      clearTimeoutFn,
    });
    lastProbe = probe;
    const transition = stateMachine.recordProbe(probe);
    if (transition) await handleTransition(transition);
    return { probe, transition };
  }

  function start() {
    if (!config.enabled || probeTimer) return probeTimer;
    probeTimer = setIntervalFn(() => {
      if (isTicking) return;
      isTicking = true;
      tick()
        .catch((err) => logger?.error?.('[health-router] probe tick failed', {
          error: err?.message || String(err),
        }))
        .finally(() => { isTicking = false; });
    }, config.probeCadenceMs);
    if (probeTimer && typeof probeTimer.unref === 'function') probeTimer.unref();
    return probeTimer;
  }

  function stop() {
    if (probeTimer) {
      clearIntervalFn(probeTimer);
      probeTimer = null;
    }
  }

  function summarizeTransition(transition) {
    if (!transition) return null;
    return {
      at: transition.at,
      reason: transition.reason,
      toMode: transition.toMode,
      probeFailures: transition.probeFailures ?? null,
      healthyProbes: transition.healthyProbes ?? null,
      spanMs: transition.spanMs ?? null,
    };
  }

  function status() {
    const snap = stateMachine.snapshot();
    return {
      mode: snap.mode,
      state: snap.state,
      since: lastTransitionAt,
      startedAt,
      probe: lastProbe
        ? { healthy: lastProbe.healthy, components: lastProbe.components, detail: lastProbe.detail }
        : null,
      lastFailover: summarizeTransition(lastFailover),
      lastResume: summarizeTransition(lastResume),
      reconciled: lastReconcile
        ? {
          adopted: lastReconcile.adoptedCount,
          duplicated: lastReconcile.duplicatedCount,
          notFound: lastReconcile.notFoundCount,
          unknown: lastReconcile.unknownCount,
        }
        : null,
      pendingOsRuns: pendingOsKeys.size,
      config: {
        enabled: config.enabled,
        probeFailureThreshold: config.probeFailureThreshold,
        resumeHealthyProbes: config.resumeHealthyProbes,
        resumeWindowMs: config.resumeWindowMs,
        dispatchP95ThresholdMs: config.dispatchP95ThresholdMs,
      },
    };
  }

  function describe() {
    return {
      id: 'health-router',
      mode: stateMachine.getMode(),
      capabilities: {
        processGroupIsolation: true,
        daemonBounceSafe: true,
        heartbeatPersisted: true,
        leaseManaged: true,
        oauthStripEnforced: true,
      },
    };
  }

  return {
    run,
    tick,
    start,
    stop,
    status,
    describe,
    // Signals the OS runtime / SSE subscription feed into the router.
    recordDispatchLatency: (ms) => latencyWindow.record(ms),
    markSseEvent: (atMs) => sse.mark(atMs),
    // Introspection seams for tests and the ARC-09 `runtime status` CLI.
    getMode: () => stateMachine.getMode(),
    getState: () => stateMachine.getState(),
    pendingOsKeys: () => [...pendingOsKeys],
    machine: stateMachine,
    latencyWindow,
    sseTracker: sse,
  };
}

export {
  createHealthRouter,
  instrumentSession,
};
