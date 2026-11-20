const GIT_TRANSIENT_MAX_ATTEMPTS = 3;
const GIT_TRANSIENT_BASE_DELAY_MS = 100;
const TRANSIENT_GIT_ERROR_CODES = new Set([
  'EAGAIN',
  'EBUSY',
  'ECONNABORTED',
  'ECONNRESET',
  'EIO',
  'EMFILE',
  'ENFILE',
  'ETIMEDOUT',
]);
const TRANSIENT_GIT_ERROR_PATTERNS = [
  /\bEIO\b/i,
  /Input\/output error/i,
  /Operation timed out/i,
  /TLS|SSL|HTTP (?:500|502|503|504)/i,
  /Resource temporarily unavailable/i,
  /Connection reset/i,
  /early EOF/i,
  /RPC failed/i,
  /remote end hung up unexpectedly/i,
  /fatal: unable to access/i,
  /(?:could not|unable to) (?:create|lock).*\.lock/i,
  /index\.lock/i,
];

function gitErrorText(err) {
  return [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).map(String).join('\n');
}

function isTransientGitError(err) {
  if (err?.killed && err?.signal === 'SIGTERM') return true;
  if (TRANSIENT_GIT_ERROR_CODES.has(String(err?.code || ''))) return true;
  const text = gitErrorText(err);
  return TRANSIENT_GIT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

async function sleep(ms) {
  await new Promise((resolvePromise) => { setTimeout(resolvePromise, ms); });
}

export async function withTransientGitRetries(operation, label) {
  let lastErr = null;
  for (let attempt = 1; attempt <= GIT_TRANSIENT_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (attempt >= GIT_TRANSIENT_MAX_ATTEMPTS || !isTransientGitError(err)) throw err;
      await sleep(GIT_TRANSIENT_BASE_DELAY_MS * attempt);
    }
  }
  throw new Error(`${label} failed after ${GIT_TRANSIENT_MAX_ATTEMPTS} attempts`, { cause: lastErr });
}

