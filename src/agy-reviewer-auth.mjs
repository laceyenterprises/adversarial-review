import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AGY_KEYCHAIN_SERVICE = 'Gemini Safe Storage';
const DEFAULT_AGY_AUTH_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_AGY_AUTH_PROBE_MAX_ATTEMPTS = 3;
const DEFAULT_AGY_AUTH_PROBE_RETRY_BACKOFF_MS = 250;
const AGY_KEYCHAIN_REMEDIATION =
  'Antigravity reviewer auth requires launchd-spawned airlock processes to read the per-user keychain item. '
  + 'Known remediation: unlock the airlock keychain before daemon-spawned work runs and grant command-line access with '
  + 'security set-generic-password-partition-list -S apple-tool:,apple: -s "Gemini Safe Storage" -k <keychain-password>.';
const AGY_TRANSIENT_REMEDIATION =
  'Antigravity agy auth preflight hit a transient agy transport failure. Retry after the local agy/network path is healthy; '
  + 'if this persists, run `agy models` under the same launchd user environment and inspect stderr.';

function resolveAgyAuthProbeTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.AGY_AUTH_PROBE_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGY_AUTH_PROBE_TIMEOUT_MS;
}

function resolveAgyAuthProbeMaxAttempts(env = process.env) {
  const parsed = Number.parseInt(env.AGY_AUTH_PROBE_MAX_ATTEMPTS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGY_AUTH_PROBE_MAX_ATTEMPTS;
}

function resolveAgyAuthProbeRetryBackoffMs(env = process.env) {
  const parsed = Number.parseInt(env.AGY_AUTH_PROBE_RETRY_BACKOFF_MS || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AGY_AUTH_PROBE_RETRY_BACKOFF_MS;
}

function isTimeoutError(err) {
  return (err?.killed === true && err?.signal === 'SIGTERM')
    || err?.code === 'ETIMEDOUT'
    || /timed out|timeout/i.test(String(err?.message || ''));
}

function isRetryableAgyModelsProbeError(err) {
  const detail = [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).join('\n').toLowerCase();
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eai_again|enotfound|epipe|eagain|tls)\b/.test(detail)
    || detail.includes('timeout')
    || detail.includes('timed out')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable')
    || detail.includes('socket hang up')
    || detail.includes('network')
    || detail.includes('connection reset')
    || detail.includes('connection refused')
    || detail.includes('service unavailable')
    || detail.includes('503')
    || detail.includes('504');
}

function formatDetail(err) {
  return String(err?.stderr || err?.stdout || err?.message || '').trim();
}

function keychainMissingFromError(err) {
  const detail = formatDetail(err);
  return err?.code === 44
    || /could not be found|specified item could not be found|not found/i.test(detail);
}

function failure(reason, detail = '', remediation = AGY_KEYCHAIN_REMEDIATION) {
  return {
    ok: false,
    reason,
    keychainItem: AGY_KEYCHAIN_SERVICE,
    probe: 'agy models',
    detail,
    remediation,
  };
}

async function runProbe(command, args, { execFileImpl, timeout, env }) {
  return execFileImpl(command, args, {
    env,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

function isRetriableAgyAuthFailure(result) {
  return result?.reason === 'keychain-probe-timeout'
    || result?.reason === 'agy-probe-timeout'
    || result?.reason === 'agy-probe-transient';
}

function withAttemptDetail(result, attempt, maxAttempts) {
  if (!result || result.ok || !isRetriableAgyAuthFailure(result) || maxAttempts <= 1) {
    return result;
  }
  const detail = result.detail
    ? `${result.detail}; attempt ${attempt}/${maxAttempts}`
    : `attempt ${attempt}/${maxAttempts}`;
  return { ...result, detail };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkAgyReviewerAuthOnce({
  agyCli = 'agy',
  env = process.env,
  execFileImpl = execFileAsync,
  timeoutMs = resolveAgyAuthProbeTimeoutMs(env),
  securityCli = 'security',
} = {}) {
  try {
    await runProbe(securityCli, ['find-generic-password', '-s', AGY_KEYCHAIN_SERVICE], {
      execFileImpl,
      timeout: timeoutMs,
      env,
    });
  } catch (err) {
    if (isTimeoutError(err)) return failure('keychain-probe-timeout', 'security keychain probe timed out');
    if (keychainMissingFromError(err)) return failure('keychain-missing', formatDetail(err));
    return failure('keychain-probe-failed', formatDetail(err));
  }

  try {
    const { stdout = '' } = await runProbe(agyCli, ['models'], {
      execFileImpl,
      timeout: timeoutMs,
      env,
    });
    if (!String(stdout || '').trim()) {
      return failure('agy-probe-empty', '`agy models` returned empty stdout');
    }
  } catch (err) {
    if (isTimeoutError(err)) return failure('agy-probe-timeout', '`agy models` timed out');
    if (isRetryableAgyModelsProbeError(err)) {
      return failure('agy-probe-transient', formatDetail(err), AGY_TRANSIENT_REMEDIATION);
    }
    return failure('agy-probe-failed', formatDetail(err));
  }

  return {
    ok: true,
    reason: null,
    keychainItem: AGY_KEYCHAIN_SERVICE,
    probe: 'agy models',
    remediation: AGY_KEYCHAIN_REMEDIATION,
  };
}

async function checkAgyReviewerAuth({
  agyCli = 'agy',
  env = process.env,
  execFileImpl = execFileAsync,
  timeoutMs = resolveAgyAuthProbeTimeoutMs(env),
  securityCli = 'security',
  maxAttempts = resolveAgyAuthProbeMaxAttempts(env),
  retryBackoffMs = resolveAgyAuthProbeRetryBackoffMs(env),
  sleepImpl = sleep,
} = {}) {
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await checkAgyReviewerAuthOnce({
      agyCli,
      env,
      execFileImpl,
      timeoutMs,
      securityCli,
    });
    if (result.ok || !isRetriableAgyAuthFailure(result) || attempt === attempts) {
      return withAttemptDetail(result, attempt, attempts);
    }
    if (retryBackoffMs > 0) {
      await sleepImpl(retryBackoffMs);
    }
  }
}

export {
  DEFAULT_AGY_AUTH_PROBE_MAX_ATTEMPTS,
  DEFAULT_AGY_AUTH_PROBE_RETRY_BACKOFF_MS,
  AGY_KEYCHAIN_SERVICE,
  AGY_KEYCHAIN_REMEDIATION,
  DEFAULT_AGY_AUTH_PROBE_TIMEOUT_MS,
  checkAgyReviewerAuth,
  resolveAgyAuthProbeMaxAttempts,
  resolveAgyAuthProbeRetryBackoffMs,
  resolveAgyAuthProbeTimeoutMs,
};
