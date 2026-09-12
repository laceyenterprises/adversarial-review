const DEFAULT_HCP_HEALTHZ_URL = 'http://127.0.0.1:8002/v1/healthz';
const DEFAULT_HCP_HEALTHZ_TIMEOUT_MS = 8_000;
const DEFAULT_HCP_HEALTHZ_MAX_ATTEMPTS = 3;
const DEFAULT_HCP_HEALTHZ_RETRY_DELAYS_MS = Object.freeze([100, 250]);

function resolveHcpHealthzUrl(env = process.env) {
  return String(env.AGENT_OS_HCP_HEALTHZ_URL || env.HCP_HEALTHZ_URL || DEFAULT_HCP_HEALTHZ_URL).trim()
    || DEFAULT_HCP_HEALTHZ_URL;
}

async function checkHcpHealthz({
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = DEFAULT_HCP_HEALTHZ_TIMEOUT_MS,
  maxAttempts = DEFAULT_HCP_HEALTHZ_MAX_ATTEMPTS,
  retryDelaysMs = DEFAULT_HCP_HEALTHZ_RETRY_DELAYS_MS,
  delayImpl = delay,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return { ready: false, reason: 'fetch-unavailable', failureClass: 'hcp-unavailable' };
  }
  const url = resolveHcpHealthzUrl(env);
  const attempts = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await checkHcpHealthzOnce({ fetchImpl, timeoutMs, url });
    if (result.ready) {
      return {
        ...result,
        attempts: attempt,
        ...(failures.length ? { recoveredAfterFailure: true, priorFailures: failures } : {}),
      };
    }
    failures.push({
      attempt,
      reason: result.reason,
      failureMessage: result.failureMessage,
    });
    if (attempt < attempts) {
      await delayImpl(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0);
    }
  }
  const last = failures.at(-1) || {};
  return {
    ready: false,
    reason: last.reason || 'unreachable',
    failureClass: 'hcp-unavailable',
    failureMessage: formatHcpHealthzFailureMessage(url, failures),
    attempts,
    failures,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkHcpHealthzOnce({ fetchImpl, timeoutMs, url }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
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
    const aborted = err?.name === 'AbortError' || controller.signal.aborted;
    return {
      ready: false,
      reason: aborted ? 'timeout' : 'unreachable',
      failureClass: 'hcp-unavailable',
      failureMessage: `HCP healthz ${url} failed: ${err?.message || err}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatHcpHealthzFailureMessage(url, failures = []) {
  const last = failures.at(-1);
  if (failures.length <= 1) {
    return last?.failureMessage || `HCP healthz ${url} failed.`;
  }
  const breakdown = failures
    .map((failure) => `attempt ${failure.attempt}: ${failure.reason}`)
    .join('; ');
  return `${last?.failureMessage || `HCP healthz ${url} failed.`} ` +
    `(after ${failures.length} attempts; ${breakdown})`;
}

export {
  DEFAULT_HCP_HEALTHZ_MAX_ATTEMPTS,
  DEFAULT_HCP_HEALTHZ_RETRY_DELAYS_MS,
  DEFAULT_HCP_HEALTHZ_TIMEOUT_MS,
  DEFAULT_HCP_HEALTHZ_URL,
  checkHcpHealthz,
  resolveHcpHealthzUrl,
};
