import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { resolveProgressTimeoutMs, resolveReviewerTimeoutMs } from '../../../reviewer-timeout.mjs';
import { spawnCapturedProcessGroup } from '../../../process-group-spawn.mjs';
import {
  claimReviewerRunRecord,
  readReviewerRunRecord,
  updateReviewerRunRecord,
} from '../run-state.mjs';
import {
  classifyReviewerFailure,
  isReviewerSubprocessTimeout,
} from '../cli-direct/classification.mjs';
import {
  CANONICAL_OAUTH_STRIP_ENV,
  stripForbiddenFallbackEnv,
} from '../cli-direct/index.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_TAIL_BYTES = 8 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_OAUTH_PROBE_TIMEOUT_MS = 20_000;

class OAuthProbeError extends Error {
  constructor(layer, reason, { stdout = '', stderr = '' } = {}) {
    super(`[OAuth] codex ${layer} OAuth unavailable: ${reason}`);
    this.name = 'OAuthProbeError';
    this.layer = layer;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function tailText(value, maxBytes = DEFAULT_TAIL_BYTES) {
  const text = String(value || '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start] & 0xC0) === 0x80) {
    start += 1;
  }
  return buffer.subarray(start).toString('utf8');
}

function emptyReviewerResult({
  ok,
  reviewBody = null,
  spawnedAt,
  failureClass = null,
  stderrTail = null,
  stdoutTail = null,
  exitCode = null,
  signal = null,
  pgid = null,
  reattachToken = null,
  error = null,
} = {}) {
  return {
    ok,
    reviewBody,
    failureClass,
    stderrTail,
    stdoutTail,
    exitCode,
    signal,
    pgid,
    spawnedAt,
    reattachToken,
    error,
    stderr: stderrTail,
    stdout: stdoutTail,
  };
}

function emptyRemediatorResult({
  ok,
  remediationBody = null,
  spawnedAt,
  failureClass = null,
  stderrTail = null,
  stdoutTail = null,
  exitCode = null,
  signal = null,
  pgid = null,
  reattachToken = null,
  error = null,
} = {}) {
  return {
    ok,
    remediationBody,
    failureClass,
    stderrTail,
    stdoutTail,
    exitCode,
    signal,
    pgid,
    spawnedAt,
    reattachToken,
    error,
    stderr: stderrTail,
    stdout: stdoutTail,
  };
}

function installHint() {
  return 'Install ACPX or set ACPX_CLI; expected `acpx` on PATH or ~/.openclaw/tools/acpx/node_modules/.bin/acpx';
}

async function resolveAcpxCliPath({
  env = process.env,
  execFileImpl = execFileAsync,
  timeout = DEFAULT_DISCOVERY_TIMEOUT_MS,
} = {}) {
  if (env.ACPX_CLI) {
    const override = String(env.ACPX_CLI).trim();
    if (!override) throw new Error(`ACPX_CLI is empty. ${installHint()}`);
    if (override.includes('/') && !existsSync(override)) {
      throw new Error(`ACPX CLI not found at ACPX_CLI=${override}. ${installHint()}`);
    }
    if (!override.includes('/')) {
      try {
        const { stdout } = await execFileImpl('which', [override], {
          env,
          timeout,
          maxBuffer: 1024 * 1024,
        });
        const resolved = String(stdout || '').trim().split(/\r?\n/)[0];
        if (resolved) return resolved;
      } catch {
        // Fall through to a consistent install-hint error below.
      }
      throw new Error(`ACPX CLI not found at ACPX_CLI=${override}. ${installHint()}`);
    }
    return override;
  }

  try {
    const { stdout } = await execFileImpl('which', ['acpx'], {
      env,
      timeout,
      maxBuffer: 1024 * 1024,
    });
    const found = String(stdout || '').trim().split(/\r?\n/)[0];
    if (found) return found;
  } catch {
    // Fall through to the maintainer-local install path.
  }

  const fallback = join(env.HOME || homedir(), '.openclaw', 'tools', 'acpx', 'node_modules', '.bin', 'acpx');
  if (existsSync(fallback)) return fallback;
  throw new Error(`ACPX CLI not found. ${installHint()}`);
}

function buildAcpxProbeArgs(...args) {
  return ['codex', ...args];
}

function oauthProbeText(err) {
  return [err?.message, err?.stdout, err?.stderr].filter(Boolean).join('\n');
}

function classifyOAuthLayer(err) {
  const text = oauthProbeText(err);
  if (/rmcp::transport::worker/i.test(text) && /TokenRefreshFailed/i.test(text)) {
    return 'mcp';
  }
  if (/auth\.json|not logged in|login required|unauthorized|401|auth_mode|access_token|refresh_token/i.test(text)) {
    return 'cli';
  }
  return 'cli';
}

function domainRequiresMcpOAuth(domainConfig = {}) {
  const candidates = [
    domainConfig.requiresMcpOAuth,
    domainConfig.requiredMcpOAuth,
    domainConfig.mcpOAuth,
    domainConfig.mcpServers,
    domainConfig.requiredMcpServers,
    domainConfig.codexMcpServers,
  ];
  const flattened = [];
  const collect = (value) => {
    if (value == null || value === false) return;
    if (value === true) {
      flattened.push('linear');
      return;
    }
    if (typeof value === 'string') {
      flattened.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        flattened.push(key);
        collect(item);
      }
    }
  };
  for (const value of candidates) collect(value);
  return flattened.some((value) => String(value || '').trim().length > 0);
}

async function assertCodexOAuthLayers({
  env,
  domainConfig,
  execFileImpl = execFileAsync,
  acpxCli = null,
  timeout = DEFAULT_OAUTH_PROBE_TIMEOUT_MS,
} = {}) {
  const probeCommand = acpxCli || 'codex';
  const probeArgs = (...args) => (acpxCli ? buildAcpxProbeArgs(...args) : args);
  try {
    await execFileImpl(probeCommand, probeArgs('sessions', 'list'), {
      env,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (err) {
    const layer = classifyOAuthLayer(err);
    throw new OAuthProbeError(
      layer,
      layer === 'mcp'
        ? `per-MCP-server OAuth token refresh failed during \`codex sessions list\`: ${err.message}`
        : `CLI auth probe \`codex sessions list\` failed; refresh auth.json with \`codex login\`: ${err.message}`,
      { stdout: err?.stdout, stderr: err?.stderr },
    );
  }

  if (!domainRequiresMcpOAuth(domainConfig)) return;

  try {
    await execFileImpl(probeCommand, probeArgs('mcp', 'list'), {
      env,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (err) {
    const layer = classifyOAuthLayer(err);
    throw new OAuthProbeError(
      layer,
      layer === 'mcp'
        ? `per-MCP-server OAuth token refresh failed; run \`codex mcp login <server>\` for the failing Linear/autok server: ${err.message}`
        : `CLI auth probe failed while checking MCP configuration; refresh auth.json with \`codex login\`: ${err.message}`,
      { stdout: err?.stdout, stderr: err?.stderr },
    );
  }
}

function classifyAcpxFailure(stderr, exitCode, errorCode, details = {}) {
  const text = String(stderr || '');
  if (/ACPX CLI not found|ACPX_CLI=.*not found/i.test(text)) {
    return 'bug';
  }
  if (/produced no (review|remediation) body|empty acpx output/i.test(text)) {
    return 'bug';
  }
  if (/acpx[\s\S]*queue[\s_-]*full|queue[\s_-]*back[\s_-]*pressure/i.test(text)) {
    return 'queue-back-pressure';
  }
  if (/zombie codex-acp process(?:es)? detected/i.test(text)) {
    return 'queue-back-pressure';
  }
  return classifyReviewerFailure(stderr, exitCode, errorCode, details);
}

function addAcpxHint(stderrTail) {
  const text = String(stderrTail || '');
  if (/zombie codex-acp process(?:es)? detected/i.test(text) && !/hq codex-acp-reaper sweep/i.test(text)) {
    return `${text}\nHint: run \`hq codex-acp-reaper sweep\` to clear stale codex-acp processes.`;
  }
  return text;
}

function buildAcpxCodexArgs(prompt, outputPath) {
  return ['codex', 'exec', '--ephemeral', '--output-last-message', outputPath, String(prompt || '')];
}

function assertIsolatedPgid(pgid) {
  if (!Number.isInteger(pgid)) {
    throw new Error(`ACPX reviewer process group must be isolated; got invalid pgid ${pgid}`);
  }
  if (pgid === process.pid) {
    throw new Error(`ACPX reviewer process group must be isolated; got parent pid ${process.pid}`);
  }
}

function enrichSubjectContext(req, domainConfig, sessionUuid) {
  return {
    ...(req.subjectContext || {}),
    domainId: req.subjectContext?.domainId || domainConfig.id || 'code-pr',
    reviewerSessionUuid: sessionUuid,
    sessionUuid,
    model: req.model,
  };
}

function createAcpxReviewerRuntimeAdapter({
  rootDir = process.cwd(),
  domainConfig = {},
  spawnCapturedImpl = spawnCapturedProcessGroup,
  execFileImpl = execFileAsync,
  resolveAcpxCliImpl = resolveAcpxCliPath,
  mkdtempImpl = mkdtempSync,
  rmDirImpl = rmSync,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  logger = console,
  now = () => new Date().toISOString(),
} = {}) {
  const activeRuns = new Map();

  async function runCodexThroughAcpx(req, {
    kind,
    makeInitialRecord,
    makeSuccess,
    makeFailure,
  }) {
    const sessionUuid = String(req?.sessionUuid || req?.subjectContext?.reviewerSessionUuid || '').trim();
    if (!sessionUuid) throw new TypeError(`${kind} sessionUuid is required`);

    const spawnedAt = now();
    const initialRecord = makeInitialRecord({ sessionUuid, spawnedAt });
    const claim = claimReviewerRunRecord(rootDir, initialRecord);
    if (!claim.claimed && ['spawned', 'heartbeating'].includes(claim.record?.state)) {
      return makeFailure({
        ok: false,
        spawnedAt: claim.record.spawnedAt || spawnedAt,
        failureClass: 'daemon-bounce',
        stderrTail: `acpx ${kind} run ${sessionUuid} is already active`,
        reattachToken: claim.record.reattachToken || `acpx:${sessionUuid}`,
        error: `acpx ${kind} run ${sessionUuid} is already active`,
      });
    }
    if (!claim.claimed) {
      return makeFailure({
        ok: false,
        spawnedAt: claim.record?.spawnedAt || spawnedAt,
        failureClass: 'bug',
        stderrTail: `acpx ${kind} run ${sessionUuid} already reached terminal state ${claim.record?.state || 'unknown'}; mint a new session UUID before retrying`,
        reattachToken: claim.record?.reattachToken || `acpx:${sessionUuid}`,
        error: `acpx ${kind} run ${sessionUuid} already reached terminal state ${claim.record?.state || 'unknown'}`,
      });
    }

    let record = claim.record || initialRecord;
    const controller = new AbortController();
    const activeRun = { controller, record, cancelled: false, heartbeatTimer: null };
    let tmpDir = null;
    let outputPath = null;

    const heartbeat = () => {
      if (activeRun.cancelled || !activeRuns.has(sessionUuid) || !Number.isInteger(record?.pgid)) return;
      record = updateReviewerRunRecord(rootDir, record, {
        state: 'heartbeating',
        lastHeartbeatAt: now(),
      });
      activeRun.record = record;
    };

    try {
      activeRuns.set(sessionUuid, activeRun);
      tmpDir = mkdtempImpl(join(tmpdir(), `adversarial-review-acpx-${sessionUuid}-`));
      outputPath = join(tmpDir, 'last-message.txt');
      const reviewerEnv = {
        ...process.env,
        REVIEWER_SESSION_UUID: sessionUuid,
      };
      const stripped = stripForbiddenFallbackEnv(reviewerEnv, req.forbiddenFallbacks);
      const acpxCli = await resolveAcpxCliImpl({ env: reviewerEnv, execFileImpl });
      await assertCodexOAuthLayers({ env: reviewerEnv, domainConfig, execFileImpl, acpxCli });

      logger.log?.(`[watcher] Using ACPX reviewer runtime at ${acpxCli}`);

      const { stdout, stderr } = await spawnCapturedImpl(
        acpxCli,
        buildAcpxCodexArgs(req.prompt, outputPath),
        {
          env: reviewerEnv,
          timeout: req.timeoutMs || resolveReviewerTimeoutMs(reviewerEnv),
          progressTimeout: resolveProgressTimeoutMs(reviewerEnv),
          signal: controller.signal,
          onSpawn: ({ pgid }) => {
            assertIsolatedPgid(pgid);
            record = updateReviewerRunRecord(rootDir, record, {
              state: 'heartbeating',
              pgid,
              lastHeartbeatAt: now(),
            });
            activeRun.record = record;
            activeRun.heartbeatTimer = setInterval(heartbeat, heartbeatIntervalMs);
            activeRun.heartbeatTimer.unref?.();
            req.onReviewerPgid?.({ sessionUuid, pgid });
          },
        },
      );

      const body = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
      if (!body.trim()) {
        const err = new Error(`ACPX ${kind} exited 0 but produced no ${kind === 'reviewer' ? 'review' : 'remediation'} body`);
        err.code = 'EMPTY_ACPX_OUTPUT';
        err.stdout = stdout;
        err.stderr = [
          tailText(stderr),
          `ACPX ${kind} exited 0 but produced no ${kind === 'reviewer' ? 'review' : 'remediation'} body at ${outputPath}`,
        ].filter(Boolean).join('\n');
        throw err;
      }
      record = updateReviewerRunRecord(rootDir, record, {
        state: 'completed',
        lastHeartbeatAt: now(),
      });
      activeRun.record = record;
      const stderrTail = stripped.length > 0
        ? [`stripped forbidden fallback env: ${stripped.join(', ')}`, tailText(stderr)].filter(Boolean).join('\n')
        : tailText(stderr);
      return makeSuccess({
        ok: true,
        body,
        spawnedAt: record.spawnedAt,
        stdoutTail: tailText(stdout),
        stderrTail,
        exitCode: 0,
        signal: null,
        pgid: record.pgid,
        reattachToken: record.reattachToken,
      });
    } catch (err) {
      const timedOut = isReviewerSubprocessTimeout(err, { killSignal: 'SIGTERM' });
      const detail = [err.message, err.stdout, err.stderr]
        .filter(Boolean)
        .join('\n')
        .trim()
        .slice(0, 4000);
      const exitCode = Number.isInteger(err?.exitCode)
        ? err.exitCode
        : (Number.isInteger(err?.code) ? err.code : null);
      const errorCode = typeof err?.code === 'string' ? err.code : null;
      const cancelled = activeRun.cancelled || controller.signal.aborted || errorCode === 'ABORT_ERR';
      const stderrSource = err instanceof OAuthProbeError ? detail : (err?.stderr || detail || '');
      const stderrTail = addAcpxHint(tailText(stderrSource));
      const stdoutTail = tailText(err?.stdout || '');
      const failureClass = err instanceof OAuthProbeError
        ? 'oauth-broken'
        : classifyAcpxFailure(
          err?.stderr || detail || '',
          exitCode,
          err?.code,
          {
            killed: err?.killed === true,
            signal: err?.signal,
            code: err?.code,
            timeoutKilled: timedOut,
          },
        );
      record = updateReviewerRunRecord(rootDir, record, {
        state: cancelled || failureClass === 'daemon-bounce' ? 'cancelled' : 'failed',
        lastHeartbeatAt: now(),
      });
      activeRun.record = record;
      return makeFailure({
        ok: false,
        spawnedAt: record.spawnedAt,
        failureClass,
        stderrTail,
        stdoutTail,
        exitCode,
        signal: typeof err?.signal === 'string' ? err.signal : null,
        pgid: record.pgid,
        reattachToken: record.reattachToken,
        error: detail || err.message,
      });
    } finally {
      if (activeRun.heartbeatTimer) clearInterval(activeRun.heartbeatTimer);
      activeRuns.delete(sessionUuid);
      if (tmpDir) rmDirImpl(tmpDir, { recursive: true, force: true });
    }
  }

  async function spawnReviewer(req) {
    return runCodexThroughAcpx(req, {
      kind: 'reviewer',
      makeInitialRecord: ({ sessionUuid, spawnedAt }) => {
        const subjectContext = enrichSubjectContext(req, domainConfig, sessionUuid);
        return {
          sessionUuid,
          domain: subjectContext.domainId,
          runtime: 'acpx',
          state: 'spawned',
          pgid: null,
          spawnedAt,
          lastHeartbeatAt: null,
          reattachToken: `acpx:${sessionUuid}`,
          subjectContext,
        };
      },
      makeSuccess: (result) => emptyReviewerResult({
        ...result,
        reviewBody: result.body,
      }),
      makeFailure: emptyReviewerResult,
    });
  }

  async function spawnRemediator(req) {
    return runCodexThroughAcpx(req, {
      kind: 'remediator',
      makeInitialRecord: ({ sessionUuid, spawnedAt }) => {
        const subjectContext = enrichSubjectContext(req, domainConfig, sessionUuid);
        return {
          sessionUuid,
          domain: subjectContext.domainId,
          runtime: 'acpx',
          state: 'spawned',
          pgid: null,
          spawnedAt,
          lastHeartbeatAt: null,
          reattachToken: `acpx:${sessionUuid}`,
          subjectContext,
        };
      },
      makeSuccess: (result) => emptyRemediatorResult({
        ...result,
        remediationBody: result.body,
      }),
      makeFailure: emptyRemediatorResult,
    });
  }

  async function cancel(sessionUuid) {
    const active = activeRuns.get(sessionUuid);
    if (active) {
      active.cancelled = true;
      active.controller.abort('kernel SIGTERM');
      active.record = updateReviewerRunRecord(rootDir, active.record, {
        state: 'cancelled',
        lastHeartbeatAt: now(),
      });
      return;
    }
    const record = readReviewerRunRecord(rootDir, sessionUuid);
    if (record && ['spawned', 'heartbeating'].includes(record.state)) {
      updateReviewerRunRecord(rootDir, record, {
        state: 'cancelled',
        lastHeartbeatAt: now(),
      });
    }
  }

  async function reattach(record) {
    const normalized = record || {};
    const spawnedAt = normalized.spawnedAt || now();
    if (normalized.sessionUuid) {
      updateReviewerRunRecord(rootDir, normalized, {
        state: 'failed',
        lastHeartbeatAt: now(),
      });
    }
    return emptyReviewerResult({
      ok: false,
      spawnedAt,
      failureClass: 'daemon-bounce',
      stderrTail: 'acpx cannot reattach to a reviewer after kernel daemon bounce',
      pgid: Number.isInteger(normalized.pgid) ? normalized.pgid : null,
      reattachToken: normalized.reattachToken || normalized.sessionUuid || null,
      error: 'acpx cannot reattach to a reviewer after kernel daemon bounce',
    });
  }

  function describe() {
    return {
      id: 'acpx',
      modelFamily: 'local-cli',
      capabilities: {
        processGroupIsolation: true,
        daemonBounceSafe: false,
        heartbeatPersisted: true,
        leaseManaged: false,
        oauthStripEnforced: true,
      },
    };
  }

  return {
    spawnReviewer,
    spawnRemediator,
    cancel,
    reattach,
    describe,
    __activeRuns: activeRuns,
  };
}

export {
  CANONICAL_OAUTH_STRIP_ENV,
  OAuthProbeError,
  assertCodexOAuthLayers,
  buildAcpxCodexArgs,
  classifyAcpxFailure,
  createAcpxReviewerRuntimeAdapter,
  domainRequiresMcpOAuth,
  resolveAcpxCliPath,
};
