import { execFile } from 'node:child_process';
import { readFileSync as fsReadFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { injectEnvSecrets } from './env.mjs';
import { parseDotenv } from './dotenv.mjs';

const execFileAsync = promisify(execFile);

const OP_TOKEN_VAR = 'OP_SERVICE_ACCOUNT_TOKEN';
const TOKEN_FILE_ENV = 'ADV_OP_TOKEN_FILE';
const TOKEN_ENV_FILE_ENV = 'ADV_OP_TOKEN_ENV_FILE';
const SECRETS_ROOT_ENV = 'ADV_SECRETS_ROOT';
const AGENT_OS_ROOT_ENV = 'AGENT_OS_ROOT';
const TOKEN_FILE_BASENAME = 'op-service-account.token';
const DEFAULT_SECRETS_ROOT_REL = ['.config', 'adversarial-review', 'secrets'];
const LEGACY_ENV_FILE_BASENAME = 'op-service-account.env';
const LEGACY_ENV_FILE_REL = ['agents', 'clio', 'credentials', 'local', LEGACY_ENV_FILE_BASENAME];

function defaultSecretsRoot(env, homedirImpl) {
  const home = env.HOME || homedirImpl();
  return join(home, ...DEFAULT_SECRETS_ROOT_REL);
}

function defaultTokenFile(env, homedirImpl) {
  const root = env[SECRETS_ROOT_ENV];
  if (typeof root === 'string' && root.trim()) {
    return { path: join(root.trim(), TOKEN_FILE_BASENAME), rootSource: SECRETS_ROOT_ENV };
  }
  return { path: join(defaultSecretsRoot(env, homedirImpl), TOKEN_FILE_BASENAME), rootSource: 'HOME' };
}

function legacyTokenEnvCandidates(env, homedirImpl) {
  const candidates = [];
  const seen = new Set();
  const roots = [];
  const agentOsRoot = trimOrEmpty(env[AGENT_OS_ROOT_ENV]);
  if (agentOsRoot) {
    roots.push({ root: agentOsRoot, source: `$${AGENT_OS_ROOT_ENV}` });
  }
  roots.push({ root: join(env.HOME || homedirImpl(), 'agent-os'), source: '$HOME/agent-os' });
  for (const entry of roots) {
    const path = join(entry.root, ...LEGACY_ENV_FILE_REL);
    if (seen.has(path)) continue;
    seen.add(path);
    candidates.push({ path, source: `${entry.source}/${LEGACY_ENV_FILE_REL.join('/')}` });
  }
  return candidates;
}

function trimOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readFileTrimmedSafe(path, readFileSyncImpl) {
  try {
    return { ok: true, value: trimOrEmpty(readFileSyncImpl(path, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function describeReadError(err) {
  if (!err) return 'read failed';
  if (err.code === 'ENOENT') return 'file does not exist';
  if (err.code === 'EACCES') return 'permission denied';
  return `read failed: ${err.message || err.code || 'unknown error'}`;
}

function readTokenFromEnvFile(path, readFileSyncImpl) {
  const result = readFileTrimmedSafe(path, readFileSyncImpl);
  if (!result.ok) return { ok: false, status: describeReadError(result.error) };
  let parsed;
  try {
    parsed = parseDotenv(result.value);
  } catch (err) {
    return { ok: false, status: `parse failed: ${err.message || 'unknown error'}` };
  }
  const fromFile = trimOrEmpty(parsed[OP_TOKEN_VAR]);
  if (!fromFile) {
    return { ok: false, status: `parsed but ${OP_TOKEN_VAR} key missing or empty` };
  }
  return { ok: true, token: fromFile };
}

function resolveOpToken({
  env = process.env,
  readFileSyncImpl = fsReadFileSync,
  homedirImpl = osHomedir,
} = {}) {
  const checked = [];

  const envValue = trimOrEmpty(env[OP_TOKEN_VAR]);
  if (envValue) {
    checked.push({ source: `env:${OP_TOKEN_VAR}`, status: 'used' });
    return { ok: true, token: envValue, source: `env:${OP_TOKEN_VAR}`, checked };
  }
  checked.push({ source: `env:${OP_TOKEN_VAR}`, status: 'not set' });

  const tokenFilePath = trimOrEmpty(env[TOKEN_FILE_ENV]);
  if (tokenFilePath) {
    const result = readFileTrimmedSafe(tokenFilePath, readFileSyncImpl);
    if (result.ok && result.value) {
      checked.push({ source: `${TOKEN_FILE_ENV}=${tokenFilePath}`, status: 'used' });
      return { ok: true, token: result.value, source: TOKEN_FILE_ENV, path: tokenFilePath, checked };
    }
    if (result.ok && !result.value) {
      checked.push({ source: `${TOKEN_FILE_ENV}=${tokenFilePath}`, status: 'file empty after trim' });
    } else {
      checked.push({ source: `${TOKEN_FILE_ENV}=${tokenFilePath}`, status: describeReadError(result.error) });
    }
  } else {
    checked.push({ source: `env:${TOKEN_FILE_ENV}`, status: 'not set' });
  }

  const tokenEnvFilePath = trimOrEmpty(env[TOKEN_ENV_FILE_ENV]);
  if (tokenEnvFilePath) {
    const envFileResult = readTokenFromEnvFile(tokenEnvFilePath, readFileSyncImpl);
    if (envFileResult.ok) {
      checked.push({ source: `${TOKEN_ENV_FILE_ENV}=${tokenEnvFilePath}`, status: 'used' });
      return {
        ok: true,
        token: envFileResult.token,
        source: TOKEN_ENV_FILE_ENV,
        path: tokenEnvFilePath,
        checked,
      };
    }
    checked.push({
      source: `${TOKEN_ENV_FILE_ENV}=${tokenEnvFilePath}`,
      status: envFileResult.status,
    });
  } else {
    checked.push({ source: `env:${TOKEN_ENV_FILE_ENV}`, status: 'not set' });
  }

  for (const candidate of legacyTokenEnvCandidates(env, homedirImpl)) {
    const envFileResult = readTokenFromEnvFile(candidate.path, readFileSyncImpl);
    if (envFileResult.ok) {
      checked.push({ source: `legacy env file (${candidate.source}) = ${candidate.path}`, status: 'used' });
      return {
        ok: true,
        token: envFileResult.token,
        source: 'legacy-env-file',
        path: candidate.path,
        checked,
      };
    }
    checked.push({
      source: `legacy env file (${candidate.source}) = ${candidate.path}`,
      status: envFileResult.status,
    });
  }

  const fallback = defaultTokenFile(env, homedirImpl);
  const fallbackLabel = fallback.rootSource === SECRETS_ROOT_ENV
    ? `default token file ($${SECRETS_ROOT_ENV}/${TOKEN_FILE_BASENAME}) = ${fallback.path}`
    : `default token file ($HOME/${DEFAULT_SECRETS_ROOT_REL.join('/')}/${TOKEN_FILE_BASENAME}) = ${fallback.path}`;
  const fallbackRead = readFileTrimmedSafe(fallback.path, readFileSyncImpl);
  if (fallbackRead.ok && fallbackRead.value) {
    checked.push({ source: fallbackLabel, status: 'used' });
    return { ok: true, token: fallbackRead.value, source: 'default', path: fallback.path, checked };
  }
  if (fallbackRead.ok) {
    checked.push({ source: fallbackLabel, status: 'file empty after trim' });
  } else {
    checked.push({ source: fallbackLabel, status: describeReadError(fallbackRead.error) });
  }

  return { ok: false, error: 'OP_SERVICE_ACCOUNT_TOKEN could not be resolved', checked, fallback };
}

function formatResolveOpTokenDiagnostic(result, { tag = 'secret-source' } = {}) {
  const lines = [];
  lines.push(`[${tag}] FATAL: could not resolve ${OP_TOKEN_VAR}`);
  lines.push('');
  lines.push('Sources checked, in declared precedence:');
  result.checked.forEach((entry, idx) => {
    lines.push(`  ${idx + 1}. ${entry.source} — ${entry.status}`);
  });
  lines.push('');
  lines.push('Recommended fix (pick one, listed in declared precedence order):');
  lines.push(`  • Export ${OP_TOKEN_VAR} in the process environment.`);
  lines.push(`  • Write the token to a file and point ${TOKEN_FILE_ENV} at it:`);
  lines.push(`      printf '%s\\n' "$YOUR_OP_SERVICE_ACCOUNT_TOKEN" > /path/to/${TOKEN_FILE_BASENAME}`);
  lines.push(`      chmod 600 /path/to/${TOKEN_FILE_BASENAME}`);
  lines.push(`      export ${TOKEN_FILE_ENV}=/path/to/${TOKEN_FILE_BASENAME}`);
  lines.push(`  • Or write a shell-style env file (${OP_TOKEN_VAR}=... or export ${OP_TOKEN_VAR}=...) and point ${TOKEN_ENV_FILE_ENV} at it.`);
  lines.push(`  • Or keep using the legacy compatibility file: $HOME/agent-os/${LEGACY_ENV_FILE_REL.join('/')}`);
  if (result.fallback) {
    lines.push(`  • Or place the token at the default path: ${result.fallback.path}`);
    lines.push(`      mkdir -p "$(dirname "${result.fallback.path}")"`);
    lines.push(`      printf '%s\\n' "$YOUR_OP_SERVICE_ACCOUNT_TOKEN" > "${result.fallback.path}"`);
    lines.push(`      chmod 600 "${result.fallback.path}"`);
  }
  lines.push('');
  lines.push('Full contract: tools/adversarial-review/DEPS.md §"OP_SERVICE_ACCOUNT_TOKEN resolution".');
  return lines.join('\n');
}

async function readOpSecret(ref, {
  opBin = process.env.OP_CLI || 'op',
  execFileImpl = execFileAsync,
} = {}) {
  const { stdout } = await execFileImpl(opBin, ['read', ref], {
    maxBuffer: 1024 * 1024,
  });
  return String(stdout || '').trim();
}

async function injectOpSecrets({
  refs = {},
  env = process.env,
  opBin = process.env.OP_CLI || 'op',
  execFileImpl = execFileAsync,
} = {}) {
  const values = {};
  for (const [name, ref] of Object.entries(refs)) {
    if (!ref) continue;
    values[name] = await readOpSecret(ref, { opBin, execFileImpl });
  }
  return {
    ...injectEnvSecrets({ env, values }),
    source: 'op',
  };
}

async function runWithOp({
  command,
  args = [],
  env = process.env,
  opBin = process.env.OP_CLI || 'op',
  execFileImpl = execFileAsync,
} = {}) {
  if (!command) {
    throw new Error('runWithOp requires command');
  }
  const injected = injectEnvSecrets({ env });
  return execFileImpl(opBin, ['run', '--', command, ...args], {
    env: injected.env,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export {
  OP_TOKEN_VAR,
  TOKEN_FILE_ENV,
  TOKEN_ENV_FILE_ENV,
  SECRETS_ROOT_ENV,
  formatResolveOpTokenDiagnostic,
  injectOpSecrets,
  readOpSecret,
  resolveOpToken,
  runWithOp,
};
