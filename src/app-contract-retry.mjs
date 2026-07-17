const TRANSIENT_APP_CONTRACT_CODES = new Set([
  'daemon_bounced', 'daemon-bounced', 'daemon_restart', 'daemon-restart',
  'endpoint_restarting', 'endpoint-restarting',
  'endpoint_unavailable', 'endpoint-unavailable',
  'launch_refused_memory_pressure', 'launch-refused-memory-pressure',
  'lease_lost', 'lease-lost', 'memory_pressure', 'memory-pressure',
  'service_unavailable', 'service-unavailable',
  'supervisor_restart', 'supervisor-restart',
]);

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH',
  'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

function isTransientAppContractError(error) {
  if (error?.retryable === true) return true;
  const networkCode = String(error?.cause?.code || error?.code || '').toUpperCase();
  if (TRANSIENT_NETWORK_CODES.has(networkCode)) return true;
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;

  const message = String(error?.message || '');
  if (/timed out|fetch failed|network|connection (?:refused|reset|timed out)/i.test(message)) return true;
  const statusMatch = message.match(/^app-contract (\d{3})\b/);
  if (statusMatch) {
    const messageStatus = Number(statusMatch[1]);
    return messageStatus === 429 || messageStatus >= 500;
  }
  const codeMatch = message.match(/^app-contract ([a-z0-9][a-z0-9_.-]*):/i);
  return Boolean(codeMatch && TRANSIENT_APP_CONTRACT_CODES.has(codeMatch[1].toLowerCase()));
}

async function withAppContractTransientRetry(operation, {
  maxAttempts = 3,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isTransientAppContractError(error)) throw error;
      await sleepImpl(Math.min(250, 50 * attempt));
    }
  }
  throw lastError;
}

export { isTransientAppContractError, withAppContractTransientRetry };
