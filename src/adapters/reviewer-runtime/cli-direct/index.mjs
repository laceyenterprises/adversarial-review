import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveProgressTimeoutMs, resolveReviewerTimeoutMs } from '../../../reviewer-timeout.mjs';
import { spawnCapturedProcessGroup } from '../../../process-group-spawn.mjs';
import {
  claimReviewerRunRecord,
  readReviewerRunRecord,
  reviewerRunSideChannelPaths,
  updateReviewerRunRecord,
} from '../run-state.mjs';
import {
  classifyReviewerFailure,
  isReviewerSubprocessTimeout,
} from './classification.mjs';
import {
  CliDirectPreflightError,
  probeReviewerCliOAuth,
} from './discovery.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REVIEWER_PATH = join(__dirname, '..', '..', '..', 'reviewer.mjs');
const DEFAULT_TAIL_BYTES = 8 * 1024;
const DEFAULT_CANCEL_GRACE_MS = 10_000;
const DEFAULT_CANCEL_POLL_MS = 250;
const DEFAULT_REATTACH_POLL_MS = 1_000;
const DEFAULT_FORBIDDEN_FALLBACKS = ['api-key', 'anthropic-api-key'];
const FORBIDDEN_FALLBACK_ENV_ALIASES = new Map([
  ['OPENAI_API_KEY', ['api-key', 'openai-api-key']],
  ['ANTHROPIC_API_KEY', ['api-key', 'anthropic-api-key']],
  ['ANTHROPIC_BASE_URL', ['anthropic-base-url', 'bedrock', 'vertex']],
  ['CLAUDE_CODE_USE_BEDROCK', ['bedrock', 'claude-code-use-bedrock']],
  ['CLAUDE_CODE_USE_VERTEX', ['vertex', 'claude-code-use-vertex']],
  ['AWS_BEARER_TOKEN_BEDROCK', ['bedrock', 'aws-bearer-token-bedrock']],
  ['GOOGLE_API_KEY', ['api-key', 'google-api-key', 'vertex']],
  ['GEMINI_API_KEY', ['api-key', 'gemini-api-key', 'vertex']],
]);

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

function readTailFile(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  let fd = null;
  try {
    const { size } = statSync(filePath);
    if (size <= 0) return '';
    const bytesToRead = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    fd = openSync(filePath, 'r');
    readSync(fd, buffer, 0, bytesToRead, size - bytesToRead);
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) {
      start += 1;
    }
    return buffer.subarray(start).toString('utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return '';
    throw err;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function emptyResult({
  ok,
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
    reviewBody: null,
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

// CANONICAL_OAUTH_STRIP_ENV is the load-bearing set every adapter advertising
// `oauthStripEnforced: true` MUST strip from the reviewer subprocess env.
// Mirrors `ENV_CLEAR` in `modules/worker-pool/lib/adapters/claude-code.sh` and
// `codex.sh`. Partial stripping is a contract violation because downstream
// trusts the capability bit — e.g. `ANTHROPIC_BASE_URL=https://attacker.invalid`
// in a launchd context would otherwise route OAuth bearer traffic through a
// hostile proxy even though `describe()` claimed enforcement.
const CANONICAL_OAUTH_STRIP_ENV = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
];

function stripForbiddenFallbackEnv(env, forbiddenFallbacks = DEFAULT_FORBIDDEN_FALLBACKS) {
  // Adapter advertises `oauthStripEnforced: true`, so the canonical 8-env set
  // is always scrubbed. `forbiddenFallbacks` is treated as an additive opt-in
  // list — extra aliases the caller wants stripped — NOT a filter that can
  // shrink the canonical set. This matches the SPEC §5.4 capability contract.
  const stripped = [];
  for (const envKey of CANONICAL_OAUTH_STRIP_ENV) {
    if (Object.prototype.hasOwnProperty.call(env, envKey)) stripped.push(envKey);
    delete env[envKey];
  }
  // Caller-supplied additive aliases (beyond canonical) also strip their
  // matching envs from the alias map.
  const normalized = new Set((forbiddenFallbacks || []).map((value) => String(value).toLowerCase()));
  for (const [envKey, aliases] of FORBIDDEN_FALLBACK_ENV_ALIASES) {
    if (CANONICAL_OAUTH_STRIP_ENV.includes(envKey)) continue;
    if (!aliases.some((alias) => normalized.has(alias))) continue;
    if (Object.prototype.hasOwnProperty.call(env, envKey)) stripped.push(envKey);
    delete env[envKey];
  }
  return stripped;
}

function buildReviewerProcessArgs(subjectContext = {}) {
  return {
    repo: subjectContext.repo,
    prNumber: subjectContext.prNumber,
    reviewerModel: subjectContext.reviewerModel || subjectContext.model,
    botTokenEnv: subjectContext.botTokenEnv,
    linearTicketId: subjectContext.linearTicketId,
    builderTag: subjectContext.builderTag,
    reviewerHeadSha: subjectContext.reviewerHeadSha,
    reviewAttemptNumber: subjectContext.reviewAttemptNumber,
    completedRemediationRounds: subjectContext.completedRemediationRounds,
    maxRemediationRounds: subjectContext.maxRemediationRounds,
    reviewerSessionUuid: subjectContext.reviewerSessionUuid || subjectContext.sessionUuid,
  };
}

function resolveCodexReviewerEnv(reviewerEnv) {
  const home = reviewerEnv.HOME || process.env.HOME || null;
  if (home) reviewerEnv.HOME = home;
  const sourceDir = reviewerEnv.CODEX_SOURCE_HOME || process.env.CODEX_SOURCE_HOME || (home ? join(home, '.codex') : null);
  if (!sourceDir) {
    throw new CliDirectPreflightError(
      'Cannot resolve Codex OAuth home. Set HOME or CODEX_SOURCE_HOME before using cli-direct Codex reviews.',
      { layer: 'codex-home', command: 'resolve codex home' },
    );
  }
  const sourceAuthPath = join(sourceDir, 'auth.json');

  reviewerEnv.CODEX_AUTH_PATH = reviewerEnv.CODEX_AUTH_PATH || sourceAuthPath;
  reviewerEnv.CODEX_SOURCE_HOME = sourceDir;
  delete reviewerEnv.OPENAI_API_KEY;

  return { authPath: reviewerEnv.CODEX_AUTH_PATH, home: reviewerEnv.HOME || null };
}

function assertForbiddenFallbackEnvStripped(env) {
  const remaining = CANONICAL_OAUTH_STRIP_ENV.filter((name) => Object.prototype.hasOwnProperty.call(env, name));
  if (remaining.length > 0) {
    const err = new Error(`forbidden fallback env-strip violation: ${remaining.join(', ')} remained in reviewer subprocess env`);
    err.failureClass = 'forbidden-fallback';
    err.stderr = err.message;
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPgidAlive(pgid, processKillImpl = process.kill) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    processKillImpl(-pgid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    throw err;
  }
}

async function waitForPgidExit(pgid, {
  timeoutMs,
  pollIntervalMs,
  processKillImpl,
  sleepImpl,
} = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs || 0);
  while (isPgidAlive(pgid, processKillImpl)) {
    if (timeoutMs > 0 && Date.now() >= deadline) return false;
    await sleepImpl(Math.max(1, pollIntervalMs || DEFAULT_REATTACH_POLL_MS));
  }
  return true;
}

async function terminateProcessGroup(pgid, {
  processKillImpl,
  sleepImpl,
  graceMs = DEFAULT_CANCEL_GRACE_MS,
  pollIntervalMs = DEFAULT_CANCEL_POLL_MS,
} = {}) {
  if (!Number.isInteger(pgid) || pgid <= 0) {
    throw new Error(`Cannot cancel reviewer run without a valid pgid (got ${pgid ?? 'null'})`);
  }
  if (!isPgidAlive(pgid, processKillImpl)) return;
  processKillImpl(-pgid, 'SIGTERM');
  const exited = await waitForPgidExit(pgid, {
    timeoutMs: graceMs,
    pollIntervalMs,
    processKillImpl,
    sleepImpl,
  });
  if (exited) return;
  processKillImpl(-pgid, 'SIGKILL');
  const killed = await waitForPgidExit(pgid, {
    timeoutMs: Math.max(1_000, pollIntervalMs),
    pollIntervalMs,
    processKillImpl,
    sleepImpl,
  });
  if (!killed) {
    throw new Error(`Reviewer process group ${pgid} survived SIGKILL`);
  }
}

function readSideChannelTails(rootDir, sessionUuid) {
  const { stdoutPath, stderrPath } = reviewerRunSideChannelPaths(rootDir, sessionUuid);
  return {
    stdoutTail: readTailFile(stdoutPath),
    stderrTail: readTailFile(stderrPath),
  };
}

function readSideChannelTailsBestEffort(rootDir, sessionUuid) {
  try {
    return readSideChannelTails(rootDir, sessionUuid);
  } catch (err) {
    return {
      stdoutTail: '',
      stderrTail: `unable to read reviewer side-channel tails: ${err?.message || err}`,
    };
  }
}

function createCliDirectReviewerRuntimeAdapter({
  rootDir = process.cwd(),
  reviewerProcessPath = DEFAULT_REVIEWER_PATH,
  spawnCapturedImpl = spawnCapturedProcessGroup,
  preflightImpl = probeReviewerCliOAuth,
  processKillImpl = process.kill,
  sleepImpl = sleep,
  cancelGraceMs = DEFAULT_CANCEL_GRACE_MS,
  cancelPollIntervalMs = DEFAULT_CANCEL_POLL_MS,
  reattachPollIntervalMs = DEFAULT_REATTACH_POLL_MS,
  logger = console,
  now = () => new Date().toISOString(),
} = {}) {
  const activeRuns = new Map();

  async function spawnReviewer(req) {
    const sessionUuid = String(req?.sessionUuid || req?.subjectContext?.reviewerSessionUuid || '').trim();
    if (!sessionUuid) {
      throw new TypeError('ReviewerRunRequest.sessionUuid is required');
    }

    const spawnedAt = now();
    const reviewerEnv = {
      ...process.env,
      REVIEWER_SESSION_UUID: sessionUuid,
    };
    let stripped = [];
    let preflightResult = null;
    try {
      if (String(req.model || '').toLowerCase().includes('codex')) {
        const { authPath, home } = resolveCodexReviewerEnv(reviewerEnv);
        logger.log?.(`[watcher] Using Codex auth for reviewer at ${authPath} with HOME=${home || '<unset>'}`);
      }
      stripped = stripForbiddenFallbackEnv(reviewerEnv, req.forbiddenFallbacks);
      assertForbiddenFallbackEnvStripped(reviewerEnv);
      if (typeof preflightImpl === 'function') {
        preflightResult = await preflightImpl({
          model: req.model,
          env: reviewerEnv,
          cwd: rootDir,
          timeout: req.preflightTimeoutMs || 30_000,
        });
        if (preflightResult?.claudeCli) reviewerEnv.CLAUDE_CLI = preflightResult.claudeCli;
        if (preflightResult?.codexCli) reviewerEnv.CODEX_CLI = preflightResult.codexCli;
      }
    } catch (err) {
      const detail = [err.message, err.stdout, err.stderr].filter(Boolean).join('\n').trim();
      const failureClass = err?.failureClass || classifyReviewerFailure(err?.stderr || detail, null, err?.code);
      return emptyResult({
        ok: false,
        spawnedAt,
        failureClass,
        stderrTail: tailText(detail),
        error: detail || err.message,
      });
    }

    const subjectContext = {
      ...(req.subjectContext || {}),
      domainId: req.subjectContext?.domainId || 'code-pr',
      reviewerSessionUuid: sessionUuid,
      sessionUuid,
      model: req.model,
    };
    const initialRecord = {
      sessionUuid,
      domain: subjectContext.domainId,
      runtime: 'cli-direct',
      state: 'spawned',
      pgid: null,
      spawnedAt,
      lastHeartbeatAt: null,
      reattachToken: sessionUuid,
      subjectContext,
    };
    const claim = claimReviewerRunRecord(rootDir, initialRecord);
    if (!claim.claimed && ['spawned', 'heartbeating'].includes(claim.record?.state)) {
      return emptyResult({
        ok: false,
        spawnedAt: claim.record.spawnedAt || spawnedAt,
        failureClass: 'daemon-bounce',
        stderrTail: `reviewer run ${sessionUuid} is already active`,
        reattachToken: claim.record.reattachToken || sessionUuid,
        error: `reviewer run ${sessionUuid} is already active`,
      });
    }
    if (!claim.claimed) {
      return emptyResult({
        ok: false,
        spawnedAt: claim.record?.spawnedAt || spawnedAt,
        failureClass: 'bug',
        stderrTail: `reviewer run ${sessionUuid} already reached terminal state ${claim.record?.state || 'unknown'}; mint a new session UUID before retrying`,
        reattachToken: claim.record?.reattachToken || sessionUuid,
        error: `reviewer run ${sessionUuid} already reached terminal state ${claim.record?.state || 'unknown'}`,
      });
    }

    let record = claim.record || initialRecord;
    const controller = new AbortController();
    const activeRun = { controller, record, cancelled: false };
    activeRuns.set(sessionUuid, activeRun);

    try {
      const reviewerArgs = buildReviewerProcessArgs(subjectContext);
      const sideChannels = reviewerRunSideChannelPaths(rootDir, sessionUuid);
      const { stdout, stderr } = await spawnCapturedImpl(
        process.execPath,
        [reviewerProcessPath, JSON.stringify(reviewerArgs)],
        {
          env: reviewerEnv,
          timeout: req.timeoutMs || resolveReviewerTimeoutMs(reviewerEnv),
          progressTimeout: resolveProgressTimeoutMs(reviewerEnv),
          signal: controller.signal,
          stdoutPath: sideChannels.stdoutPath,
          stderrPath: sideChannels.stderrPath,
          onSpawn: ({ pgid }) => {
            record = updateReviewerRunRecord(rootDir, record, {
              state: 'heartbeating',
              pgid,
              lastHeartbeatAt: now(),
            });
            activeRun.record = record;
            activeRuns.set(sessionUuid, activeRun);
            req.onReviewerPgid?.({ sessionUuid, pgid });
          },
        }
      );

      record = updateReviewerRunRecord(rootDir, record, {
        state: 'completed',
        lastHeartbeatAt: now(),
      });
      activeRun.record = record;
      return emptyResult({
        ok: true,
        spawnedAt: record.spawnedAt,
        stdoutTail: tailText(stdout),
        stderrTail: stripped.length > 0
          ? [`stripped forbidden fallback env: ${stripped.join(', ')}`, tailText(stderr)].filter(Boolean).join('\n')
          : tailText(stderr),
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
      const stderrTail = tailText(err?.stderr || detail || '');
      const stdoutTail = tailText(err?.stdout || '');
      const cancelled = activeRun.cancelled || controller.signal.aborted || errorCode === 'ABORT_ERR';
      const failureClass = classifyReviewerFailure(
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
      return emptyResult({
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
      activeRuns.delete(sessionUuid);
    }
  }

  async function spawnRemediator(req = {}) {
    const spawnedAt = now();
    return {
      ok: false,
      remediationBody: null,
      failureClass: 'bug',
      stderrTail: 'cli-direct remediator runtime is still owned by follow-up-remediation.mjs until LAC-564',
      stdoutTail: null,
      exitCode: null,
      signal: null,
      pgid: null,
      spawnedAt,
      reattachToken: req.sessionUuid || null,
    };
  }

  async function cancel(sessionUuid) {
    const active = activeRuns.get(sessionUuid);
    if (active) {
      active.cancelled = true;
      if (Number.isInteger(active.record?.pgid)) {
        await terminateProcessGroup(active.record.pgid, {
          processKillImpl,
          sleepImpl,
          graceMs: cancelGraceMs,
          pollIntervalMs: cancelPollIntervalMs,
        });
      } else {
        active.controller.abort('kernel SIGTERM');
      }
      active.record = updateReviewerRunRecord(rootDir, active.record, {
        state: 'cancelled',
        lastHeartbeatAt: now(),
      });
      return;
    }
    const record = readReviewerRunRecord(rootDir, sessionUuid);
    if (!record) {
      throw new Error(`Cannot cancel unknown reviewer run ${sessionUuid}`);
    }
    if (['spawned', 'heartbeating'].includes(record.state) && Number.isInteger(record.pgid)) {
      await terminateProcessGroup(record.pgid, {
        processKillImpl,
        sleepImpl,
        graceMs: cancelGraceMs,
        pollIntervalMs: cancelPollIntervalMs,
      });
    }
    updateReviewerRunRecord(rootDir, record, {
      state: 'cancelled',
      lastHeartbeatAt: now(),
    });
  }

  async function reattach(record) {
    const normalized = record || {};
    const spawnedAt = normalized.spawnedAt || now();
    const pgid = Number.isInteger(normalized.pgid) ? normalized.pgid : null;
    if (normalized.sessionUuid && pgid && isPgidAlive(pgid, processKillImpl)) {
      const tails = readSideChannelTailsBestEffort(rootDir, normalized.sessionUuid);
      const refusal = `cli-direct refuses to reattach live process group ${pgid} without reviewer identity verification`;
      let reaperFailure = null;
      try {
        await terminateProcessGroup(pgid, {
          processKillImpl,
          sleepImpl,
          graceMs: cancelGraceMs,
          pollIntervalMs: cancelPollIntervalMs,
        });
      } catch (err) {
        reaperFailure = `failed to terminate live reviewer process group ${pgid}: ${err?.message || err}`;
      }
      const failedRecord = updateReviewerRunRecord(rootDir, normalized, {
        state: 'failed',
        lastHeartbeatAt: now(),
      });
      return emptyResult({
        ok: false,
        spawnedAt: failedRecord.spawnedAt,
        failureClass: 'daemon-bounce',
        stderrTail: [refusal, reaperFailure, tails.stderrTail].filter(Boolean).join('\n'),
        stdoutTail: tails.stdoutTail,
        pgid,
        reattachToken: failedRecord.reattachToken,
        error: refusal,
      });
    }
    const tails = normalized.sessionUuid ? readSideChannelTailsBestEffort(rootDir, normalized.sessionUuid) : {};
    if (normalized.sessionUuid) {
      updateReviewerRunRecord(rootDir, normalized, {
        state: 'failed',
        lastHeartbeatAt: now(),
      });
    }
    return emptyResult({
      ok: false,
      spawnedAt,
      failureClass: 'daemon-bounce',
      stderrTail: tails.stderrTail || 'cli-direct reviewer process group is no longer alive after kernel daemon bounce',
      stdoutTail: tails.stdoutTail || null,
      pgid,
      reattachToken: normalized.reattachToken || normalized.sessionUuid || null,
      error: 'cli-direct reviewer process group is no longer alive after kernel daemon bounce',
    });
  }

  function describe() {
    return {
      id: 'cli-direct',
      modelFamily: 'local-cli',
      capabilities: {
        processGroupIsolation: true,
        daemonBounceSafe: false,
        heartbeatPersisted: false,
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
  classifyReviewerFailure,
  createCliDirectReviewerRuntimeAdapter,
  isReviewerSubprocessTimeout,
  stripForbiddenFallbackEnv,
};
