import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { accessSync, closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';

export const CLI_RESOLUTION_TRANSIENT_FAILURE_CLASS = 'cli-resolution-transient';
export const CLI_LAUNCHER_CONFIGURATION_FAILURE_CLASS = 'reviewer-configuration-error';

// Protocol route identifiers, shared with the producer's reviewer launchers.
const REVIEWER_ROUTE_KEYS = ['CLAUDE_CLI', 'CLAUDE_CODE_CLI_PATH'];

function validateLauncher(launcher) {
  let fd;
  try {
    if (!launcher || typeof launcher !== 'object' || Array.isArray(launcher)
      || typeof launcher.path !== 'string' || !isAbsolute(launcher.path)
      || launcher.path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(launcher.path)
      || typeof launcher.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(launcher.sha256)
      || !REVIEWER_ROUTE_KEYS.includes(launcher.routeKey)) throw new Error('invalid launcher');
    // Refuse links and hash the opened regular file, never a symlink target.
    fd = openSync(launcher.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('invalid launcher file');
    accessSync(launcher.path, constants.X_OK);
    const digest = createHash('sha256').update(readFileSync(fd)).digest('hex');
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs) throw new Error('launcher file modified concurrently');
    if (digest !== launcher.sha256.toLowerCase()) throw new Error('launcher digest mismatch');
    return Object.freeze({ path: launcher.path, sha256: launcher.sha256, routeKey: launcher.routeKey });
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isReviewCliResolutionFailure(error) {
  return error?.binaryResolution?.status === 'unknown'
    || error?.name === 'ReviewCliResolutionError'
    || error?.cause?.binaryResolution?.status === 'unknown';
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
  const command = env.HQ_BIN || process.env.HQ_BIN || 'hq';
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = execFileSyncImpl(command, [
        'cli', 'resolve', '--cli', cli, '--consumer', 'review', '--json',
      ], {
        env, encoding: 'utf8', timeout: loadAwareTimeoutMsImpl(timeoutMs), killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      result = parseResolution(cli, raw);
      break;
    } catch (cause) {
      if (attempt === 1) throw resolutionFailure(cli, cause, { log, now });
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

function resolutionFailure(cli, cause, { log, now }, configuration = false) {
  // Do not echo arbitrary resolver output (or JSON parser excerpts) into logs.
  const evidence = Object.freeze({
    cli, consumer: 'review', status: 'unknown', timestamp: now(),
    reason: cause?.code || (cause instanceof SyntaxError ? 'invalid-json' : 'resolver-error'),
    ...(configuration ? { failureClass: CLI_LAUNCHER_CONFIGURATION_FAILURE_CLASS } : {}),
    ...(cause?.resolutionDiagnostic ? { diagnostic: cause.resolutionDiagnostic } : {}),
  });
  log.error?.(`[review-cli-resolution] ${JSON.stringify(evidence)}`);
  const message = configuration
    ? `[${CLI_LAUNCHER_CONFIGURATION_FAILURE_CLASS}] invalid review CLI launcher for ${cli}`
    : `review CLI resolution unavailable for ${cli}`;
  return Object.assign(new Error(message, { cause }), {
    name: 'ReviewCliResolutionError',
    failureClass: configuration ? CLI_LAUNCHER_CONFIGURATION_FAILURE_CLASS : CLI_RESOLUTION_TRANSIENT_FAILURE_CLASS,
    binaryResolution: evidence,
  });
}

function recordResolution(cli, result, { log, now }) {
  let launcher;
  if (Object.hasOwn(result, 'launcher') && result.launcher != null) {
    try { launcher = validateLauncher(result.launcher); }
    catch (cause) { throw resolutionFailure(cli, cause, { log, now }, true); }
  }
  const evidence = Object.freeze({
    schemaVersion: 1, cli, consumer: 'review', status: 'resolved',
    source: result.source, selectedPath: result.selectedPath, realPath: result.realPath,
    version: result.version, binarySha256: result.binarySha256, timestamp: now(),
    ...(launcher ? { launcher } : {}),
  });
  // Written before auth/helpers/exec; service logs retain this even if exec fails.
  log.error?.(`[review-cli-resolution] ${JSON.stringify(evidence)}`);
  return evidence;
}

export function resolveReviewCliPath(cli, env = process.env) {
  const result = resolveReviewCli(cli, { env });
  return result.launcher?.path ?? result.realPath;
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
  const command = env.HQ_BIN || process.env.HQ_BIN || 'hq';
  let result;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(command, [
        'cli', 'resolve', '--cli', cli, '--consumer', 'review', '--json',
      ], {
        env, encoding: 'utf8', timeout: loadAwareTimeoutMsImpl(timeoutMs), killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
      result = parseResolution(cli, stdout);
      break;
    } catch (cause) {
      if (attempt === 1) throw resolutionFailure(cli, cause, { log, now });
    }
  }
  return recordResolution(cli, result, { log, now });
}

export async function resolveReviewCliPathAsync(cli, env = process.env) {
  const result = await resolveReviewCliAsync(cli, { env });
  return result.launcher?.path ?? result.realPath;
}
