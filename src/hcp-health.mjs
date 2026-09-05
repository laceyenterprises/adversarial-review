const DEFAULT_HCP_HEALTHZ_URL = 'http://127.0.0.1:8002/v1/healthz';
const DEFAULT_HCP_HEALTHZ_TIMEOUT_MS = 8_000;

function resolveHcpHealthzUrl(env = process.env) {
  return String(env.AGENT_OS_HCP_HEALTHZ_URL || env.HCP_HEALTHZ_URL || DEFAULT_HCP_HEALTHZ_URL).trim()
    || DEFAULT_HCP_HEALTHZ_URL;
}

async function checkHcpHealthz({
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = DEFAULT_HCP_HEALTHZ_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ready: false, reason: 'fetch-unavailable', failureClass: 'hcp-unavailable' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const url = resolveHcpHealthzUrl(env);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response?.ok) {
      return {
        ready: false,
        reason: `http-${response?.status || 'unknown'}`,
        failureClass: 'hcp-unavailable',
        failureMessage: `HCP healthz ${url} returned HTTP ${response?.status || 'unknown'}.`,
      };
    }
    return { ready: true, reason: 'ok', url };
  } catch (err) {
    return {
      ready: false,
      reason: err?.name === 'AbortError' ? 'timeout' : 'unreachable',
      failureClass: 'hcp-unavailable',
      failureMessage: `HCP healthz ${url} failed: ${err?.message || err}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export {
  DEFAULT_HCP_HEALTHZ_TIMEOUT_MS,
  DEFAULT_HCP_HEALTHZ_URL,
  checkHcpHealthz,
  resolveHcpHealthzUrl,
};
