import { execFileSync } from 'node:child_process';

const ENTITLED_VARS = ['HAMMER_LACEY_GH_TOKEN', 'MERGE_AGENT_GH_TOKEN'];

function credentialRejected(error) {
  const detail = [error?.message, error?.stderr, error?.stdout].join('\n');
  return error?.status === 401 || error?.response?.status === 401
    || /\bbad credentials\b|\bHTTP(?:\/\S+)?\s+401\b|\b401\s+Unauthorized\b|\bauthentication (?:failed|required)\b|could not read (?:Username|Password)|\brequires authentication\b|\btoken (?:has )?expired\b|\bunauthorized\b[^\n]*\b401\b/i.test(detail);
}

// Launch commands are trusted environment inputs, never PR content. Refresh on
// every call: each shell phase may resume after an arbitrarily long CI wait.
function tokenContext(options) {
  const { credentialEnv = options.env || process.env, hammerToken = false, ...childOptions } = options;
  const variable = ENTITLED_VARS.find(key => credentialEnv[key])
    || ENTITLED_VARS.find(key => credentialEnv[`${key}_REFRESH_COMMAND`])
    || ['GH_TOKEN', 'GITHUB_TOKEN'].find(key => credentialEnv[key]);
  const command = (variable && credentialEnv[`${variable}_REFRESH_COMMAND`])
    || credentialEnv.HQ_ENTITLEMENT_GH_TOKEN_REFRESH_COMMAND;
  const entitled = ENTITLED_VARS.some(key => credentialEnv[key] || credentialEnv[`${key}_REFRESH_COMMAND`]);
  const managed = Boolean(hammerToken || (credentialEnv.HAM_ROOT_DIR && entitled))
    && (entitled || Boolean(command));
  return { credentialEnv, childOptions, variable, command, managed };
}

// Scope Git's credential helper to this child, preserving other inline config.
// No token appears in argv or persistent git config, and host helpers cannot
// select an ambient worker identity ahead of the entitled gh credential.
export function hammerGitOptions(options) {
  const env = { ...(options.env || process.env) };
  const count = Number(env.GIT_CONFIG_COUNT || 0);
  env.GIT_CONFIG_COUNT = String(count + 2);
  env[`GIT_CONFIG_KEY_${count}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${count}`] = '';
  env[`GIT_CONFIG_KEY_${count + 1}`] = 'credential.helper';
  env[`GIT_CONFIG_VALUE_${count + 1}`] = '!gh auth git-credential';
  return { ...options, env, stdio: 'pipe' };
}

export function hammerTokenSession(options = {}) {
  const { credentialEnv, childOptions, variable, command, managed } = tokenContext(options);
  const secrets = new Set(['GH_TOKEN', 'GITHUB_TOKEN', ...ENTITLED_VARS]
    .map(key => credentialEnv[key]).filter(Boolean));
  let token = variable && credentialEnv[variable];
  let retried = false;

  function failure(outcome) {
    const error = new Error(`GitHub credential rejected or unavailable; entitled token refresh ${outcome}`);
    error.hammerAuthHandled = true;
    error.authOutage = true;
    error.stderr = error.message;
    return error;
  }
  function refresh() {
    if (!command) return;
    let output;
    try {
      output = execFileSync('/bin/sh', ['-c', command], {
        env: credentialEnv, encoding: 'utf8', timeout: 10_000,
        killSignal: 'SIGKILL', maxBuffer: 16 * 1024, stdio: 'pipe',
      });
    } catch (error) {
      // Command text, stdout, stderr and child error messages can hold secrets.
      throw failure(error.signal || error.code === 'ETIMEDOUT' ? 'failed (timeout or signal)' : 'failed (command error)');
    }
    const fresh = output.trim();
    if (!fresh || /\s/.test(fresh)) throw failure('failed (empty or invalid output)');
    token = fresh;
    secrets.add(token);
  }
  function redact(value) {
    if (typeof value === 'string' || Buffer.isBuffer(value)) {
      let clean = String(value);
      for (const secret of secrets) clean = clean.replaceAll(secret, '[redacted]');
      return Buffer.isBuffer(value) ? Buffer.from(clean) : clean;
    }
    if (value && typeof value === 'object') {
      for (const key of ['stdout', 'stderr', 'message', 'stack']) {
        if (value[key] !== undefined) value[key] = redact(value[key]);
      }
      if (value.error) redact(value.error);
      if (Array.isArray(value.output)) value.output = value.output.map(redact);
    }
    return value;
  }
  return {
    managed,
    prepare() {
      if (!managed) return childOptions;
      refresh();
      return { ...childOptions, env: { ...(childOptions.env || process.env), GH_TOKEN: token, GITHUB_TOKEN: token } };
    },
    retry(error) {
      if (!managed) throw error;
      if (!credentialRejected(error)) throw redact(error);
      if (retried) throw failure('succeeded, but GitHub rejected the retried call');
      if (!command) throw failure('unavailable (no launch refresh command)');
      retried = true;
      // prepare() performs the one forced refresh immediately before retry.
    },
    redact: value => managed ? redact(value) : value,
  };
}

export async function withHammerToken(execute, options) {
  const session = hammerTokenSession(options);
  while (true) {
    const active = session.prepare();
    try { return session.redact(await execute(active, session)); }
    catch (error) { session.retry(error); }
  }
}

export function withHammerTokenSync(execute, options) {
  const session = hammerTokenSession(options);
  while (true) {
    const active = session.prepare();
    let result;
    try { result = execute(active, session); }
    catch (error) { session.retry(error); continue; }
    if (session.managed && result && typeof result === 'object' && Number(result.status) > 0 && credentialRejected(result)) {
      session.retry(result);
      continue;
    }
    return session.redact(result);
  }
}
