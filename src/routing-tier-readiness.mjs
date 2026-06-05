// Routing-tier readiness probe: small pre-spawn check against the LiteLLM
// proxy that every Claude/Codex CLI reviewer goes through. When the proxy is
// bouncing (post-reboot RunAtLoad, os-restart, main-catchup classification),
// spawning a reviewer wastes ~30s on a connection that's going to fail with
// `Unable to connect to API (ConnectionRefused)`. The classifier patterns
// (cli-direct/classification.mjs) ensure those failures don't burn the
// per-attempt budget anymore. This probe is the additional optimization
// that avoids the wasted spawn entirely when readiness is known-bad.
//
// Keep this module side-effect-free. Unit tests import it directly so they do
// not initialize watcher.mjs' singleton review-state database in parallel runs.

function resolveRoutingTierReadinessUrl(env = process.env) {
  const raw = env.WATCHER_ROUTING_TIER_READINESS_URL;
  return raw && String(raw).trim().length > 0
    ? String(raw).trim()
    : 'http://127.0.0.1:4000/health/readiness';
}

function resolveRoutingTierReadinessTimeoutMs(env = process.env) {
  const v = Number(env.WATCHER_ROUTING_TIER_READINESS_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 2000;
}

function isRoutingTierReadinessProbeDisabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(env.WATCHER_ROUTING_TIER_READINESS_PROBE_DISABLED || '');
}

function buildRoutingTierReadinessFailure(reason, failureMessage) {
  return {
    ready: false,
    reason,
    failureClass: 'cascade',
    failureMessage,
  };
}

async function probeRoutingTierReadiness({ env = process.env, fetchFn = globalThis.fetch } = {}) {
  if (isRoutingTierReadinessProbeDisabled(env)) {
    return { ready: true, skipped: true };
  }
  const url = resolveRoutingTierReadinessUrl(env);
  const timeoutMs = resolveRoutingTierReadinessTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { signal: controller.signal, method: 'GET' });
    if (!res || typeof res.status !== 'number' || res.status < 200 || res.status >= 300) {
      const status = res?.status ?? 'no_response';
      return buildRoutingTierReadinessFailure(
        `readiness_http_${status}`,
        `Routing-tier readiness probe returned HTTP ${status}.`
      );
    }
    return { ready: true };
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    if (err?.name === 'AbortError') {
      return buildRoutingTierReadinessFailure(
        'readiness_timeout',
        `Routing-tier readiness probe timed out after ${timeoutMs}ms.`
      );
    }
    if (code === 'ECONNREFUSED') {
      return buildRoutingTierReadinessFailure(
        'routing_tier_connection_refused',
        `Routing-tier readiness probe could not connect to ${url}.`
      );
    }
    return buildRoutingTierReadinessFailure(
      `readiness_error_${code || 'unknown'}`,
      `Routing-tier readiness probe failed${code ? ` (${code})` : ''}.`
    );
  } finally {
    clearTimeout(timer);
  }
}

export {
  buildRoutingTierReadinessFailure,
  isRoutingTierReadinessProbeDisabled,
  probeRoutingTierReadiness,
  resolveRoutingTierReadinessTimeoutMs,
  resolveRoutingTierReadinessUrl,
};
