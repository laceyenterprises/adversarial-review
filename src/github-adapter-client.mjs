import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';

const ADAPTER_MAX_BUFFER = 25 * 1024 * 1024;
const ADAPTER_TIMEOUT_MS = 30_000;

function nonEmptyString(value) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

async function defaultCanExecute(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveGitHubAdapterBin({
  env = process.env,
  cwd = process.cwd(),
  canExecute = defaultCanExecute,
} = {}) {
  for (const key of ['GHA_ADAPTER_BIN', 'AGENT_OS_GITHUB_ADAPTER_BIN']) {
    const configured = nonEmptyString(env?.[key]);
    if (configured) return configured;
  }

  const candidate = resolve(cwd, 'modules/github-adapter/bin/github-adapter');
  return await canExecute(candidate) ? candidate : null;
}

function parseJsonPayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error('GitHub adapter returned empty output');
  }
  return JSON.parse(text);
}

function unwrapAdapterEnvelope(payload) {
  if (payload && typeof payload === 'object' && Object.hasOwn(payload, 'ok')) {
    if (payload.ok === false) {
      const message = payload.error?.message || payload.error || 'GitHub adapter returned ok=false';
      throw new Error(String(message));
    }
    if (Object.hasOwn(payload, 'data')) return payload.data;
    if (Object.hasOwn(payload, 'result')) return payload.result;
  }
  return payload;
}

function pushFlag(args, flag, value) {
  if (value === undefined || value === null) return;
  args.push(flag, String(value));
}

function adapterArgs(command, params = {}) {
  const args = [command];
  pushFlag(args, '--repo', params.repo);
  pushFlag(args, '--pr', params.prNumber);
  pushFlag(args, '--head-sha', params.headSha);
  pushFlag(args, '--label', params.labelName);
  pushFlag(args, '--limit', params.limit);
  if (params.withLabels === false) args.push('--no-labels');
  return args;
}

async function callGitHubAdapter(command, params = {}, {
  execFileImpl,
  env = process.env,
  cwd = process.cwd(),
  canExecute,
  timeoutMs = ADAPTER_TIMEOUT_MS,
} = {}) {
  if (typeof execFileImpl !== 'function') return { available: false, reason: 'missing-exec' };
  const bin = await resolveGitHubAdapterBin({ env, cwd, canExecute });
  if (!bin) return { available: false, reason: 'missing-bin' };

  const { stdout } = await execFileImpl(bin, adapterArgs(command, params), {
    maxBuffer: ADAPTER_MAX_BUFFER,
    timeout: timeoutMs,
    env,
  });
  return {
    available: true,
    data: unwrapAdapterEnvelope(parseJsonPayload(stdout)),
  };
}

function normalizeAdapterArray(value, fieldName) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value[fieldName])) return value[fieldName];
  throw new Error(`GitHub adapter payload missing ${fieldName} array`);
}

export {
  adapterArgs,
  callGitHubAdapter,
  normalizeAdapterArray,
  resolveGitHubAdapterBin,
};
