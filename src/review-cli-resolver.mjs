import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';

// HUP-05 owns override, managed-current and review legacy fallback policy.
// Do not duplicate it here, including when the installed command is unavailable.
export function resolveReviewCli(cli, {
  env = process.env,
  execFileSyncImpl = execFileSync,
  timeoutMs = 10_000,
  log = console,
  now = () => new Date().toISOString(),
} = {}) {
  const command = env.HQ_BIN || process.env.HQ_BIN || 'hq';
  let result;
  try {
    const raw = execFileSyncImpl(command, [
      'cli', 'resolve', '--cli', cli, '--consumer', 'review', '--json',
    ], {
      env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = parseResolution(cli, raw);
  } catch (cause) {
    throw resolutionFailure(cli, cause, { log, now });
  }
  return recordResolution(cli, result, { log, now });
}

function parseResolution(cli, raw) {
  const result = JSON.parse(raw);
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

function resolutionFailure(cli, cause, { log, now }) {
  // Do not echo arbitrary resolver output (or JSON parser excerpts) into logs.
  const evidence = Object.freeze({
    cli, consumer: 'review', status: 'unknown', timestamp: now(),
    reason: cause?.code || (cause instanceof SyntaxError ? 'invalid-json' : 'resolver-error'),
  });
  log.error?.(`[review-cli-resolution] ${JSON.stringify(evidence)}`);
  return Object.assign(new Error(`review CLI resolution unavailable for ${cli}`, { cause }), {
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
  log = console,
  now = () => new Date().toISOString(),
} = {}) {
  const command = env.HQ_BIN || process.env.HQ_BIN || 'hq';
  let result;
  try {
    const { stdout } = await execFileImpl(command, [
      'cli', 'resolve', '--cli', cli, '--consumer', 'review', '--json',
    ], {
      env, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    result = parseResolution(cli, stdout);
  } catch (cause) {
    throw resolutionFailure(cli, cause, { log, now });
  }
  return recordResolution(cli, result, { log, now });
}

export async function resolveReviewCliPathAsync(cli, env = process.env) {
  return (await resolveReviewCliAsync(cli, { env })).realPath;
}
