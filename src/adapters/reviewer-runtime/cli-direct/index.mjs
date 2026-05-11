import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
} from './classification.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REVIEWER_PATH = join(__dirname, '..', '..', '..', 'reviewer.mjs');
const DEFAULT_TAIL_BYTES = 8 * 1024;
const DEFAULT_FORBIDDEN_FALLBACKS = ['api-key', 'anthropic-api-key'];

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

function stripForbiddenFallbackEnv(env, forbiddenFallbacks = DEFAULT_FORBIDDEN_FALLBACKS) {
  const normalized = new Set((forbiddenFallbacks || []).map((value) => String(value).toLowerCase()));
  const stripped = [];
  if (normalized.has('api-key') || normalized.has('openai-api-key')) {
    if (Object.prototype.hasOwnProperty.call(env, 'OPENAI_API_KEY')) stripped.push('OPENAI_API_KEY');
    delete env.OPENAI_API_KEY;
  }
  if (normalized.has('api-key') || normalized.has('anthropic-api-key')) {
    if (Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY')) stripped.push('ANTHROPIC_API_KEY');
    delete env.ANTHROPIC_API_KEY;
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
  const sourceDir = process.env.CODEX_SOURCE_HOME || '/Users/placey/.codex';
  const sourceAuthPath = join(sourceDir, 'auth.json');

  reviewerEnv.HOME = reviewerEnv.HOME || '/Users/airlock';
  reviewerEnv.CODEX_AUTH_PATH = sourceAuthPath;
  reviewerEnv.CODEX_SOURCE_HOME = sourceDir;
  delete reviewerEnv.OPENAI_API_KEY;

  return { authPath: sourceAuthPath, home: reviewerEnv.HOME };
}

function createCliDirectReviewerRuntimeAdapter({
  rootDir = process.cwd(),
  reviewerProcessPath = DEFAULT_REVIEWER_PATH,
  spawnCapturedImpl = spawnCapturedProcessGroup,
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
      const reviewerEnv = {
        ...process.env,
        REVIEWER_SESSION_UUID: sessionUuid,
      };
      const stripped = stripForbiddenFallbackEnv(reviewerEnv, req.forbiddenFallbacks);

      if (String(req.model || '').toLowerCase().includes('codex')) {
        const { authPath, home } = resolveCodexReviewerEnv(reviewerEnv);
        logger.log?.(`[watcher] Using Codex auth for reviewer at ${authPath} with HOME=${home}`);
      }

      const reviewerArgs = buildReviewerProcessArgs(subjectContext);
      const { stdout, stderr } = await spawnCapturedImpl(
        process.execPath,
        [reviewerProcessPath, JSON.stringify(reviewerArgs)],
        {
          env: reviewerEnv,
          timeout: req.timeoutMs || resolveReviewerTimeoutMs(reviewerEnv),
          progressTimeout: resolveProgressTimeoutMs(reviewerEnv),
          signal: controller.signal,
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
    return emptyResult({
      ok: false,
      spawnedAt,
      failureClass: 'daemon-bounce',
      stderrTail: 'cli-direct cannot reattach to a reviewer after kernel daemon bounce',
      pgid: Number.isInteger(normalized.pgid) ? normalized.pgid : null,
      reattachToken: normalized.reattachToken || normalized.sessionUuid || null,
      error: 'cli-direct cannot reattach to a reviewer after kernel daemon bounce',
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
  classifyReviewerFailure,
  createCliDirectReviewerRuntimeAdapter,
  isReviewerSubprocessTimeout,
  stripForbiddenFallbackEnv,
};
