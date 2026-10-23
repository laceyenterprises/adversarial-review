import { execFileSync } from 'node:child_process';

const ENTITLED_VARS = ['HAMMER_LACEY_GH_TOKEN', 'MERGE_AGENT_GH_TOKEN'];

function credentialRejected(error) {
  const detail = [error?.message, error?.stderr, error?.stdout].join('\n');
  return error?.status === 401 || error?.response?.status === 401
    || /\bbad credentials\b|\bHTTP(?:\/\S+)?\s+401\b|\b401\s+Unauthorized\b|\bauthentication (?:failed|required)\b|could not read (?:Username|Password)|\brequires authentication\b|\btoken (?:has )?expired\b|\bunauthorized\b[^\n]*\b401\b/i.test(detail);
}

// Launch refresh commands (`hq github-token refresh`) print one
// `export NAME=VALUE` line per variable, each VALUE quoted as Python's
// shlex.quote does: bare safe characters, or single-quoted runs joined by "'".
// A single bare token line remains accepted. Anything else is rejected, and the
// output never reaches an error: it holds every minted value.
const TOKEN_SHAPE = /^[\w.~+/-]+$/;
const EXPORT_LINE = /^export ([A-Za-z_][A-Za-z0-9_]*)=((?:[\w@%+=:,./-]+|'[^']*'|"'")+)$/;
function shellValue(quoted) {
  return quoted.replace(/'([^']*)'|"'"/g, (_match, single) => single ?? "'");
}
function parseRefreshOutput(output, names) {
  const text = output.trim();
  if (TOKEN_SHAPE.test(text)) return { token: text, values: [text] };
  const exports = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const match = EXPORT_LINE.exec(line.replace(/\r$/, ''));
    if (!match) return null;
    exports.set(match[1], shellValue(match[2]));
  }
  const name = names.find(key => exports.has(key));
  const token = name && exports.get(name);
  if (!TOKEN_SHAPE.test(token || '')) return null;
  const values = [...exports].filter(([key, value]) => value && !key.endsWith('_EXPIRES_AT')).map(([, value]) => value);
  return { token, values, expiresAt: exports.get(`${name}_EXPIRES_AT`) || exports.get('GH_TOKEN_EXPIRES_AT') };
}

// A proactive refresh may be skipped while the held token's known expiry is
// comfortably ahead; a rejected call still forces one refresh.
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;
function expiresLater(expiresAt, now = Date.now()) {
  const at = /^\d{4}-\d{2}-\d{2}T/.test(expiresAt || '') ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(at) && at - now > EXPIRY_MARGIN_MS;
}

let warnedProactiveFailure = false;
// Retain the latest successful refresh across per-call sessions without
// changing ambient process credentials. Never share it across environments or
// a changed launch identity, refresh command, token or expiry.
const refreshedCredentials = new WeakMap();
function warnProactiveFailure(outcome) {
  if (warnedProactiveFailure) return;
  warnedProactiveFailure = true;
  process.stderr.write(`hammer-token: warning: proactive entitled token refresh ${outcome}; continuing with the held token\n`);
}

// Launch commands are trusted environment inputs, never PR content. Refresh
// before each call unless the held token is known to outlive it: each shell
// phase may resume after an arbitrarily long CI wait. A failed proactive
// refresh keeps a held token; only the refresh after a rejection must succeed.
function tokenContext(options) {
  const { credentialEnv = options.env || process.env, hammerToken = false, ...childOptions } = options;
  const variable = ENTITLED_VARS.find(key => credentialEnv[key] || credentialEnv[`${key}_REFRESH_COMMAND`])
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
  const launchToken = variable && credentialEnv[variable];
  const launchExpiry = variable && credentialEnv[`${variable}_EXPIRES_AT`];
  const cached = refreshedCredentials.get(credentialEnv);
  const current = cached && cached.variable === variable && cached.command === command
    && cached.launchToken === launchToken && cached.launchExpiry === launchExpiry ? cached : null;
  const secrets = new Set(['GH_TOKEN', 'GITHUB_TOKEN', ...ENTITLED_VARS]
    .map(key => credentialEnv[key]).filter(Boolean).concat(current?.values || []));
  let token = current ? current.token : launchToken;
  // Only an entitled variable or a completed refresh holds the closer identity;
  // an ambient GH_TOKEN is always replaced, never kept or trusted to expire late.
  let held = Boolean(current || (token && ENTITLED_VARS.includes(variable)));
  let expiresAt = current ? current.expiresAt : held ? launchExpiry : undefined;
  let retried = false;
  let forced = false;

  function failure(outcome) {
    const error = new Error(`GitHub credential rejected or unavailable; entitled token refresh ${outcome}`);
    error.refreshOutcome = outcome;
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
    const parsed = parseRefreshOutput(output, [variable, 'GH_TOKEN'].filter(Boolean));
    if (!parsed) throw failure('failed (empty or invalid output)');
    for (const value of parsed.values) secrets.add(value);
    token = parsed.token;
    held = true;
    expiresAt = parsed.expiresAt;
    refreshedCredentials.set(credentialEnv, { ...parsed, variable, command, launchToken, launchExpiry });
    warnedProactiveFailure = false;
  }
  // Redaction returns the same object, minus secrets: callers route retries and
  // failures from its code, signal and status. A spawn-level child error (a
  // timeout or missing binary) is its own `.error`, so visited objects are
  // never walked twice.
  function redact(value, seen = new WeakSet()) {
    if (Buffer.isBuffer(value)) {
      let clean = value;
      for (const secret of secrets) {
        const needle = Buffer.from(secret);
        const chunks = [];
        let start = 0;
        let index;
        while ((index = clean.indexOf(needle, start)) !== -1) {
          chunks.push(clean.subarray(start, index), Buffer.from('[redacted]'));
          start = index + needle.length;
        }
        if (start) clean = Buffer.concat([...chunks, clean.subarray(start)]);
      }
      return clean;
    }
    if (typeof value === 'string') {
      let clean = value;
      for (const secret of secrets) clean = clean.replaceAll(secret, '[redacted]');
      return clean;
    }
    if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const key of ['stdout', 'stderr', 'message', 'stack']) {
        if (value[key] !== undefined) value[key] = redact(value[key], seen);
      }
      if (value.error) redact(value.error, seen);
      if (Array.isArray(value.output)) value.output = value.output.map(item => redact(item, seen));
    }
    return value;
  }
  return {
    managed,
    prepare() {
      if (!managed) return childOptions;
      if (forced) {
        forced = false;
        refresh();
      } else if (!held || !expiresLater(expiresAt)) {
        try { refresh(); } catch (error) {
          if (!held) throw error;
          warnProactiveFailure(error.refreshOutcome);
        }
      }
      return { ...childOptions, env: { ...(childOptions.env || process.env), GH_TOKEN: token, GITHUB_TOKEN: token } };
    },
    retry(error) {
      if (!managed) throw error;
      if (!credentialRejected(error)) throw redact(error);
      if (retried) throw failure('succeeded, but GitHub rejected the retried call');
      if (!command) throw failure('unavailable (no launch refresh command)');
      retried = true;
      forced = true;
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
