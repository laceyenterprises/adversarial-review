import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const AGY_KEYCHAIN_SERVICE = 'Gemini Safe Storage';
const DEFAULT_AGY_AUTH_PROBE_TIMEOUT_MS = 2_000;
const AGY_KEYCHAIN_REMEDIATION =
  'Antigravity reviewer auth requires launchd-spawned airlock processes to read the per-user keychain item. '
  + 'Known remediation: unlock the airlock keychain before daemon-spawned work runs and grant command-line access with '
  + 'security set-generic-password-partition-list -S apple-tool:,apple: -s "Gemini Safe Storage" -k <keychain-password>.';

function resolveAgyAuthProbeTimeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.AGY_AUTH_PROBE_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGY_AUTH_PROBE_TIMEOUT_MS;
}

function isTimeoutError(err) {
  return err?.killed === true
    || err?.signal === 'SIGTERM'
    || err?.code === 'ETIMEDOUT'
    || /timed out|timeout/i.test(String(err?.message || ''));
}

function formatDetail(err) {
  return String(err?.stderr || err?.stdout || err?.message || '').trim();
}

function keychainMissingFromError(err) {
  const detail = formatDetail(err);
  return err?.code === 44
    || /could not be found|specified item could not be found|not found/i.test(detail);
}

function failure(reason, detail = '') {
  return {
    ok: false,
    reason,
    keychainItem: AGY_KEYCHAIN_SERVICE,
    probe: 'agy models',
    detail,
    remediation: AGY_KEYCHAIN_REMEDIATION,
  };
}

async function runProbe(command, args, { execFileImpl, timeout, env }) {
  return execFileImpl(command, args, {
    env,
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

async function checkAgyReviewerAuth({
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
    if (isTimeoutError(err)) return failure('keychain-probe-failed', 'security keychain probe timed out');
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

export {
  AGY_KEYCHAIN_SERVICE,
  AGY_KEYCHAIN_REMEDIATION,
  DEFAULT_AGY_AUTH_PROBE_TIMEOUT_MS,
  checkAgyReviewerAuth,
  resolveAgyAuthProbeTimeoutMs,
};
