import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { accessSync, constants, statSync } from 'node:fs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';

export const CLI_RESOLUTION_TRANSIENT_FAILURE_CLASS = 'cli-resolution-transient';

export function isReviewCliResolutionFailure(error) {
  return error?.binaryResolution?.status === 'unknown'
    || error?.name === 'ReviewCliResolutionError'
    || error?.cause?.binaryResolution?.status === 'unknown';
}

// Resolve the control command against the service environment, never reviewer PATH.
function resolverCommand(env) {
  const command = env.HQ_BIN || process.env.HQ_BIN || 'hq';
  if (isAbsolute(command) || command.includes('/')) return resolve(command);
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const candidate = resolve(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* try the next service PATH entry */ }
  }
  throw Object.assign(new Error('resolver command unavailable on service PATH'), { code: 'ENOENT' });
}

// HUP-05 owns override, managed-current and review legacy fallback policy.
// Do not duplicate it here, including when the installed command is unavailable.
export function resolveReviewCli(cli, {
  env = process.env,
  execFileSyncImpl = execFileSync,
  timeoutMs = 10_000,
  loadAwareTimeoutMsImpl = loadAwareTimeoutMs,
  log = console,
  now = () => new Date().toISOString(),
} = {}) {
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = execFileSyncImpl(resolverCommand(env), [
        'cli', 'resolve', '--cli', cli, '--consumer', 'review', '--json',
      ], {
        env, encoding: 'utf8', timeout: loadAwareTimeoutMsImpl(timeoutMs), killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      result = parseResolution(cli, raw);
      break;
    } catch (cause) {
      if (attempt === 1 || resolverSpawnFailed(cause)) throw resolutionFailure(cli, cause, { log, now });
    }
  }
  return recordResolution(cli, result, { log, now });
}

function validateResolution(cli, result) {
  const text = (value) => typeof value === 'string' && value.trim().length > 0
    && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
  if (!result || result.schemaVersion !== 1 || result.cli !== cli
    || !['override', 'managed', 'fallback'].includes(result.source)
    || !text(result.selectedPath) || !isAbsolute(result.selectedPath)
    || !text(result.realPath) || !isAbsolute(result.realPath)
    || !text(result.version) || !/^[a-f0-9]{64}$/i.test(result.binarySha256)) {
    throw new Error('invalid resolver protocol v1 response');
  }
  return result;
}

// Preserve pretty-printed protocol output. For line-oriented output, tolerate
// CLI banners and non-object JSON chatter, but never choose between two objects.
function parseResolution(cli, raw) {
  const stdout = String(raw);
  try {
    return validateResolution(cli, JSON.parse(stdout));
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    const lines = stdout.split(/\r?\n/);
    const objects = [];
    let protocolLineCount = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
        objects.push(value);
        try { validateResolution(cli, value); protocolLineCount += 1; } catch { /* invalid protocol */ }
      } catch { /* non-JSON CLI chatter */ }
    }
    if (objects.length === 1 && protocolLineCount === 1) return objects[0];
    const failure = new SyntaxError('invalid resolver JSON response');
    failure.resolutionDiagnostic = Object.freeze({
      stdoutBytes: Buffer.byteLength(stdout),
      stdoutLineCount: lines.length,
      hasProtocolV1Line: protocolLineCount > 0,
    });
    throw failure;
  }
}

function resolverSpawnFailed(cause) {
  return typeof cause?.code === 'string' && /^E(?!RR_)/.test(cause.code) && cause.code !== 'ETIMEDOUT';
}

function resolutionFailure(cli, cause, { log, now }) {
  const failureClass = resolverSpawnFailed(cause) ? 'reviewer-configuration-error' : CLI_RESOLUTION_TRANSIENT_FAILURE_CLASS;
  // Do not echo arbitrary resolver output (or JSON parser excerpts) into logs.
  const evidence = Object.freeze({
    cli, consumer: 'review', status: 'unknown', timestamp: now(), failureClass,
    reason: cause?.code || (cause instanceof SyntaxError ? 'invalid-json' : 'resolver-error'),
    ...(cause?.resolutionDiagnostic ? { diagnostic: cause.resolutionDiagnostic } : {}),
  });
  log.error?.(`[review-cli-resolution] ${JSON.stringify(evidence)}`);
  return Object.assign(new Error(`${failureClass === 'reviewer-configuration-error' ? '[reviewer-configuration-error] ' : ''}review CLI resolution unavailable for ${cli}`, { cause }), {
    name: 'ReviewCliResolutionError',
    failureClass,
    binaryResolution: evidence,
  });
}

function recordResolution(cli, result, { log, now }) {
  const evidence = Object.freeze({
    schemaVersion: 1, cli, consumer: 'review', status: 'resolved',
    source: result.source, selectedPath: result.selectedPath, realPath: result.realPath,
    version: result.version, binarySha256: result.binarySha256, timestamp: now(),
  });
  // Written before auth/helpers/exec; service logs retain this even if exec fails.
  log.error?.(`[review-cli-resolution] ${JSON.stringify(evidence)}`);
  return evidence;
}

export function resolveReviewCliPath(cli, env = process.env) {
  return resolveReviewCli(cli, { env }).realPath;
}

const execFileAsync = promisify(execFile);

export async function resolveReviewCliAsync(cli, {
  env = process.env,
  execFileImpl = execFileAsync,
  timeoutMs = 10_000,
  loadAwareTimeoutMsImpl = loadAwareTimeoutMs,
  log = console,
  now = () => new Date().toISOString(),
} = {}) {
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(resolverCommand(env), [
        'cli', 'resolve', '--cli', cli, '--consumer', 'review', '--json',
      ], {
        env, encoding: 'utf8', timeout: loadAwareTimeoutMsImpl(timeoutMs), killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      result = parseResolution(cli, stdout);
      break;
    } catch (cause) {
      if (attempt === 1 || resolverSpawnFailed(cause)) throw resolutionFailure(cli, cause, { log, now });
    }
  }
  return recordResolution(cli, result, { log, now });
}

export async function resolveReviewCliPathAsync(cli, env = process.env) {
  return (await resolveReviewCliAsync(cli, { env })).realPath;
}
