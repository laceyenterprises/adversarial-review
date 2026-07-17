// The health-router state machine (v2 app architecture §6.2). Pure w.r.t. an
// injected clock: the router feeds it probe outcomes and hard-dispatch errors,
// and it returns transition descriptors. All IO — notices, audit rows,
// telemetry, reconcile — is the router's job, not this module's.
//
//   OS-HEALTHY  --k consecutive probe failures OR one hard contract error-->  LOCAL-FALLBACK
//   LOCAL-FALLBACK --m healthy probes across >= w minutes (hysteresis)-->     OS-RESUMING
//   OS-RESUMING --reconcile complete-->                                       OS-HEALTHY
//   OS-RESUMING --probe failure / hard error-->                              LOCAL-FALLBACK
//
// Runs never migrate mode mid-flight (§6.3): the router selects a runtime from
// `getMode()` at run() time and the run finishes there. `getMode()` reports
// 'local' for both LOCAL-FALLBACK and OS-RESUMING so no new work is dispatched
// to the OS until reconcile completes and the machine reaches OS-HEALTHY.

const ROUTER_STATES = Object.freeze({
  OS_HEALTHY: 'os-healthy',
  LOCAL_FALLBACK: 'local-fallback',
  OS_RESUMING: 'os-resuming',
});

const TRANSITION_KINDS = Object.freeze({
  FAILOVER: 'failover',
  RESUME_START: 'resume-start',
  RESUME_COMPLETE: 'resume-complete',
  RESUME_ABORTED: 'resume-aborted',
});

const MAX_HISTORY_LENGTH = 100;

function modeForState(state) {
  // Only OS-HEALTHY dispatches to the OS. OS-RESUMING is treated as local so the
  // reconcile can adopt in-flight OS runs before any fresh OS dispatch races it.
  return state === ROUTER_STATES.OS_HEALTHY ? 'os' : 'local';
}

function createRouterStateMachine({
  config,
  now = () => Date.now(),
  initialState = ROUTER_STATES.OS_HEALTHY,
} = {}) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('createRouterStateMachine requires a resolved config');
  }
  const k = config.probeFailureThreshold;
  const m = config.resumeHealthyProbes;
  const wMs = config.resumeWindowMs;

  let state = initialState;
  let consecutiveFailures = 0;
  let consecutiveHealthy = 0;
  let healthyWindowStartMs = null;
  let lastTransition = null;
  const history = [];

  function nowMs() {
    return now();
  }

  function transition(to, kind, reason, extra = {}) {
    const from = state;
    const fromMode = modeForState(from);
    state = to;
    const atMs = nowMs();
    const descriptor = {
      kind,
      reason,
      from,
      to,
      fromMode,
      toMode: modeForState(to),
      atMs,
      at: new Date(atMs).toISOString(),
      ...extra,
    };
    lastTransition = descriptor;
    history.push(descriptor);
    if (history.length > MAX_HISTORY_LENGTH) history.shift();
    return descriptor;
  }

  function enterFallback(reason, extra = {}, kind = TRANSITION_KINDS.FAILOVER) {
    consecutiveFailures = 0;
    consecutiveHealthy = 0;
    healthyWindowStartMs = null;
    return transition(ROUTER_STATES.LOCAL_FALLBACK, kind, reason, extra);
  }

  // A probe outcome: { healthy: boolean, at?: epochMs, detail?, components? }.
  // Returns a transition descriptor when the outcome moves the machine, else null.
  function recordProbe(probe = {}) {
    const healthy = probe.healthy === true;
    const atMs = Number.isFinite(probe.at) ? probe.at : nowMs();

    if (state === ROUTER_STATES.OS_HEALTHY) {
      if (healthy) {
        consecutiveFailures = 0;
        return null;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= k) {
        return enterFallback('probe-failures', {
          probeFailures: consecutiveFailures,
          detail: probe.detail ?? null,
          components: probe.components ?? null,
        });
      }
      return null;
    }

    if (state === ROUTER_STATES.LOCAL_FALLBACK) {
      if (!healthy) {
        // Any failed probe resets the hysteresis streak — this is the flap guard.
        consecutiveHealthy = 0;
        healthyWindowStartMs = null;
        return null;
      }
      if (consecutiveHealthy === 0) healthyWindowStartMs = atMs;
      consecutiveHealthy += 1;
      const spanMs = atMs - healthyWindowStartMs;
      if (consecutiveHealthy >= m && spanMs >= wMs) {
        consecutiveFailures = 0;
        return transition(ROUTER_STATES.OS_RESUMING, TRANSITION_KINDS.RESUME_START, 'resume-hysteresis-met', {
          healthyProbes: consecutiveHealthy,
          spanMs,
          requiresReconcile: true,
        });
      }
      return null;
    }

    if (state === ROUTER_STATES.OS_RESUMING) {
      // A regression during the (brief) resume window kicks straight back to
      // local before any OS dispatch resumes.
      if (!healthy) {
        return enterFallback('resume-aborted-probe-failure', {
          detail: probe.detail ?? null,
          components: probe.components ?? null,
        }, TRANSITION_KINDS.RESUME_ABORTED);
      }
      return null;
    }

    return null;
  }

  // Fast path: a single fail-closed server-side or transport dispatch rejection
  // on a live dispatch fails the whole system over immediately, bypassing the
  // probe-failure counter (§6.2). Request-level 4xx errors do NOT reach here.
  function recordHardError({ detail = null, requestId = null } = {}) {
    if (state === ROUTER_STATES.LOCAL_FALLBACK) return null; // already local
    // A hard error mid-resume is an aborted resume, not a fresh failover —
    // emit the truthful transition kind so the audit trail is not a
    // misleading resume_start→failover pair (review finding on #620).
    const kind = state === ROUTER_STATES.OS_RESUMING
      ? TRANSITION_KINDS.RESUME_ABORTED
      : TRANSITION_KINDS.FAILOVER;
    return enterFallback('hard-contract-error', { detail, requestId }, kind);
  }

  // Advance OS-RESUMING -> OS-HEALTHY once the router has finished reconciling
  // idempotency keys. The reconcile summary rides on the transition so the
  // operator notice can report "N adopted, 0 duplicated".
  function completeResume(reconcileSummary = null) {
    if (state !== ROUTER_STATES.OS_RESUMING) return null;
    consecutiveFailures = 0;
    consecutiveHealthy = 0;
    healthyWindowStartMs = null;
    return transition(ROUTER_STATES.OS_HEALTHY, TRANSITION_KINDS.RESUME_COMPLETE, 'resume-complete', {
      reconcile: reconcileSummary,
    });
  }

  return {
    recordProbe,
    recordHardError,
    completeResume,
    getState: () => state,
    getMode: () => modeForState(state),
    getLastTransition: () => lastTransition,
    getHistory: () => history.slice(),
    snapshot: () => ({
      state,
      mode: modeForState(state),
      consecutiveFailures,
      consecutiveHealthy,
      healthyWindowStartMs,
      thresholds: { k, m, resumeWindowMs: wMs },
    }),
  };
}

export {
  ROUTER_STATES,
  TRANSITION_KINDS,
  createRouterStateMachine,
  modeForState,
};
