// The health probe (v2 app architecture §6.2). A probe is healthy iff ALL of:
//   healthz(app-contract endpoint) ok
//   ∧ rolling dispatch-acceptance p95 ≤ threshold
//   ∧ SSE stream liveness (last event within the liveness timeout).
// Each signal is injected so the probe is pure and unit-testable; the router
// wires real implementations (a healthz fetch, the shared latency window, an
// SSE last-event tracker). Missing signals fail open — a quiet system with no
// dispatch samples or no SSE subscription is not spuriously failed over.

function coerceOk(value) {
  return value !== false && value !== null && value !== undefined;
}

async function probeOnce({
  checkHealthz,
  dispatchP95Ms,
  sseLive,
  config,
  now = () => Date.now(),
} = {}) {
  const at = now();

  let healthzOk = true;
  let healthzDetail = null;
  if (typeof checkHealthz === 'function') {
    try {
      healthzOk = coerceOk(await checkHealthz());
    } catch (err) {
      healthzOk = false;
      healthzDetail = err?.message || String(err);
    }
  }

  const p95 = typeof dispatchP95Ms === 'function' ? dispatchP95Ms() : dispatchP95Ms;
  const dispatchP95Ok = p95 == null || p95 <= config.dispatchP95ThresholdMs;

  const sseOk = typeof sseLive === 'function' ? coerceOk(sseLive()) : coerceOk(sseLive);

  const healthy = healthzOk && dispatchP95Ok && sseOk;
  const components = {
    healthzOk,
    healthzDetail,
    dispatchP95Ms: p95 == null ? null : p95,
    dispatchP95Ok,
    sseLive: sseOk,
  };

  return {
    healthy,
    at,
    components,
    detail: healthy ? null : describeUnhealthy(components, config),
  };
}

function describeUnhealthy(components, config) {
  const reasons = [];
  if (!components.healthzOk) {
    reasons.push(`healthz${components.healthzDetail ? ` (${components.healthzDetail})` : ' failed'}`);
  }
  if (!components.dispatchP95Ok) {
    reasons.push(`dispatch p95 ${components.dispatchP95Ms}ms > ${config.dispatchP95ThresholdMs}ms`);
  }
  if (!components.sseLive) reasons.push('sse not live');
  return reasons.join('; ');
}

// A last-event-timestamp tracker for SSE liveness. `mark()` is called from an
// `os.on(topic, …)` subscription; `live()` returns whether the last event is
// within the configured liveness timeout. Before the first event it fails open.
function createSseLivenessTracker({ config, now = () => Date.now() } = {}) {
  let lastEventAtMs = null;
  return {
    mark(atMs = now()) {
      lastEventAtMs = Number.isFinite(atMs) ? atMs : now();
    },
    live() {
      if (lastEventAtMs == null) return true; // no subscription/events yet → fail open
      return (now() - lastEventAtMs) <= config.sseLivenessTimeoutMs;
    },
    lastEventAtMs: () => lastEventAtMs,
  };
}

export {
  createSseLivenessTracker,
  describeUnhealthy,
  probeOnce,
};
