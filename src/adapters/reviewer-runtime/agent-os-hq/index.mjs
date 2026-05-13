import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { promisify } from 'node:util';
import { writeFileAtomic } from '../../../atomic-write.mjs';
import { resolveReviewerTimeoutMs } from '../../../reviewer-timeout.mjs';
import {
  extractReviewVerdict,
  normalizeReviewVerdict,
  sanitizeCodexReviewPayload,
} from '../../../kernel/verdict.mjs';
import {
  claimReviewerRunRecord,
  readReviewerRunRecord,
  TERMINAL_RUN_STATES,
  updateReviewerRunRecord,
} from '../run-state.mjs';
import { stripForbiddenFallbackEnv } from '../cli-direct/index.mjs';
import { isReviewerSubprocessTimeout } from '../cli-direct/classification.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_FORBIDDEN_FALLBACKS = ['api-key', 'anthropic-api-key'];
const DEFAULT_WORKER_CLASS_BY_MODEL = new Map([
  ['claude', 'claude-code'],
  ['claude-code', 'claude-code'],
  ['codex', 'codex'],
]);
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'superseded']);
const SUCCESS_STATUSES = new Set(['succeeded']);
const ACTIVE_RECORD_STATES = new Set(['spawned', 'heartbeating']);
const DEFAULT_POLL_BASE_MS = 30_000;
const DEFAULT_POLL_JITTER_MS = 5_000;
const LEASE_EXPIRED_GRACE_MS = 60_000;
const MIN_HQ_COMMAND_TIMEOUT_MS = 1_000;
const HQ_COMMAND_TIMEOUT_BUFFER_MS = 15_000;
const OWNER_MISMATCH_RE = /OWNER_MISMATCH|owner mismatch/i;

function tailText(value, maxBytes = 8 * 1024) {
  const text = String(value || '');
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  let start = buffer.byteLength - maxBytes;
  while (start < buffer.byteLength && (buffer[start] & 0xC0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

function result({
  ok,
  reviewBody = null,
  failureClass = null,
  stderrTail = null,
  stdoutTail = null,
  exitCode = null,
  signal = null,
  pgid = null,
  spawnedAt,
  reattachToken = null,
  error = null,
  configurationError = false,
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
    configurationError,
    stderr: stderrTail,
    stdout: stdoutTail,
  };
}

function currentUsername(env = process.env) {
  return env.USER || env.LOGNAME || userInfo().username;
}

function makeConfigurationError(message) {
  const err = new Error(message);
  err.configurationError = true;
  return err;
}

function findOnPath(binaryName, pathValue = '') {
  for (const dir of String(pathValue || '').split(':').filter(Boolean)) {
    const candidate = join(dir, binaryName);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function resolveHqBin(env = process.env) {
  const explicit = env.HQ_BIN;
  if (explicit) {
    try {
      accessSync(explicit, constants.X_OK);
      return explicit;
    } catch {
      throw makeConfigurationError(`hq binary not executable at HQ_BIN=${explicit}`);
    }
  }
  const fromPath = findOnPath('hq', env.PATH);
  if (fromPath) return fromPath;
  throw makeConfigurationError('hq binary not found on PATH; set HQ_BIN or use cli-direct/acpx');
}

function resolveHqRoot(env = process.env) {
  const hqRoot = String(env.HQ_ROOT || '').trim();
  if (!hqRoot) {
    throw makeConfigurationError('HQ_ROOT is required for agent-os-hq reviewer runtime; set HQ_ROOT or use cli-direct/acpx');
  }
  if (!existsSync(join(hqRoot, '.hq', 'config.json'))) {
    throw makeConfigurationError(`HQ_ROOT is not initialized at ${hqRoot}; set HQ_ROOT to an Agent OS HQ root or use cli-direct/acpx`);
  }
  return hqRoot;
}

function requireEnvValue(env, key, message) {
  const value = String(env[key] || '').trim();
  if (!value) throw makeConfigurationError(message);
  return value;
}

function readHqOwnerUser(hqRoot) {
  const configPath = join(hqRoot, '.hq', 'config.json');
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  const ownerUser = String(parsed.ownerUser || parsed.owner_user || '').trim();
  if (!ownerUser) {
    throw new Error(`HQ config at ${configPath} is missing ownerUser`);
  }
  return ownerUser;
}

function assertOwnerMatches({ hqRoot, env }) {
  const ownerUser = readHqOwnerUser(hqRoot);
  const actual = currentUsername(env);
  if (actual !== ownerUser) {
    const err = new Error(
      `HQ owner mismatch: kernel is running as '${actual}' but HQ ownerUser is '${ownerUser}'. Re-run the kernel under the HQ owner; agent-os-hq runtime will not sudo across users.`
    );
    err.configurationError = true;
    throw err;
  }
  return ownerUser;
}

function resolveWorkerClass(model, explicitWorkerClass) {
  if (explicitWorkerClass) return explicitWorkerClass;
  const normalized = String(model || '').trim().toLowerCase();
  const resolved = DEFAULT_WORKER_CLASS_BY_MODEL.get(normalized);
  if (resolved) return resolved;
  throw makeConfigurationError(`agent-os-hq reviewer runtime does not know how to map model '${model}' to an HQ worker class`);
}

function parseJsonObject(text, label) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error(`${label} produced empty output`);
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error(`${label} did not produce JSON: ${tailText(raw, 1000)}`);
  }
}

function parseDispatchTicket(stdout) {
  const payload = parseJsonObject(stdout, 'hq dispatch');
  const launchRequestId = String(payload.launchRequestId || payload.dispatchId || '').trim();
  if (!launchRequestId) throw new Error('hq dispatch ticket missing launchRequestId/dispatchId');
  return { ...payload, launchRequestId };
}

function normalizeStatusPayload(stdout) {
  const payload = parseJsonObject(stdout, 'hq dispatch status');
  const status = String(payload.status || '').trim();
  if (!status) throw new Error('hq dispatch status payload missing status');
  return payload;
}

function hqArtifactDir(rootDir) {
  return join(rootDir, 'data', 'reviewer-runs');
}

function hqPromptPath(rootDir, sessionUuid) {
  return join(hqArtifactDir(rootDir), `${sessionUuid}.agent-os-hq.prompt.md`);
}

function hqReviewArtifactPath(rootDir, sessionUuid) {
  return join(hqArtifactDir(rootDir), `${sessionUuid}.agent-os-hq.review.md`);
}

function buildReviewerPrompt(req, artifactPath) {
  const subjectContext = req.subjectContext || {};
  const repo = subjectContext.repo || subjectContext.subjectExternalId || 'unknown-repo';
  const prNumber = subjectContext.prNumber ? `#${subjectContext.prNumber}` : '';
  return [
    '# Adversarial Review Runtime',
    '',
    `You are the reviewer for ${repo}${prNumber ? ` PR ${prNumber}` : ''}.`,
    'Produce only the adversarial-review verdict artifact requested by the kernel.',
    '',
    'Requirements:',
    '- Do not open a PR, push a branch, or post comments.',
    '- Write the final review markdown to the artifact path below.',
    '- Use the existing adversarial-review verdict shape: `## Summary` and `## Verdict` are required.',
    '- The verdict line must be one of: `Request changes`, `Comment only`, or `Approved`.',
    '',
    `Artifact path: ${artifactPath}`,
    '',
    'Original reviewer prompt:',
    '',
    req.prompt || '',
    '',
  ].join('\n');
}

function validateReviewArtifact(markdown) {
  const sanitized = sanitizeCodexReviewPayload(markdown);
  const verdict = normalizeReviewVerdict(extractReviewVerdict(sanitized));
  if (!['request-changes', 'comment-only', 'approved'].includes(verdict)) {
    throw new Error('review artifact missing recognized Verdict value');
  }
  return sanitized;
}

function readValidatedArtifact(artifactPath) {
  if (!existsSync(artifactPath)) {
    throw new Error(`review artifact missing at ${artifactPath}`);
  }
  return validateReviewArtifact(readFileSync(artifactPath, 'utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultJitter(maxMs) {
  return Math.floor(Math.random() * Math.max(0, maxMs + 1));
}

function buildDispatchArgs({
  ticketRef,
  workerClass,
  promptPath,
  parentSession,
  project,
  tokenBudget,
  taskKind,
  hqRoot,
}) {
  const args = [
    'dispatch',
    '--ticket', ticketRef,
    '--worker-class', workerClass,
    '--prompt', promptPath,
    '--completion-shape', 'artifact',
    '--parent-session', parentSession,
    '--project', project,
  ];
  if (taskKind) args.push('--task-kind', taskKind);
  if (tokenBudget !== null && tokenBudget !== undefined && tokenBudget !== '') {
    const normalized = String(tokenBudget);
    if (!/^[0-9]+$/.test(normalized)) {
      throw new Error(`tokenBudget must be a non-negative integer token count (got '${tokenBudget}')`);
    }
    args.push('--token-budget', normalized);
  }
  args.push('--root', hqRoot);
  return args;
}

function makeProgressKey(statusPayload) {
  return [
    statusPayload.status || '',
    statusPayload.health || '',
    statusPayload.phase || '',
    statusPayload.lastProgressAt || '',
    statusPayload.lastProgressSummary || '',
  ].join('\n');
}

function createAgentOsHqReviewerRuntimeAdapter({
  rootDir = process.cwd(),
  env = process.env,
  hqBin = null,
  hqRoot = null,
  workerClass = null,
  taskKind = 'analysis',
  execFileImpl = execFileAsync,
  sleepImpl = sleep,
  jitterImpl = defaultJitter,
  pollBaseMs = DEFAULT_POLL_BASE_MS,
  pollJitterMs = DEFAULT_POLL_JITTER_MS,
  leaseExpiredGraceMs = LEASE_EXPIRED_GRACE_MS,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
} = {}) {
  const activeRuns = new Map();

  function resolveRuntimeConfig(forbiddenFallbacks = DEFAULT_FORBIDDEN_FALLBACKS) {
    const runtimeEnv = { ...env };
    if (hqRoot) runtimeEnv.HQ_ROOT = hqRoot;
    if (hqBin) runtimeEnv.HQ_BIN = hqBin;
    const resolvedHqRoot = resolveHqRoot(runtimeEnv);
    const resolvedHqBin = hqBin || resolveHqBin(runtimeEnv);
    const parentSession = requireEnvValue(
      runtimeEnv,
      'HQ_PARENT_SESSION',
      'agent-os-hq reviewer runtime requires HQ_PARENT_SESSION; export it (e.g. via `hq self`) before invoking the reviewer.'
    );
    const project = requireEnvValue(
      runtimeEnv,
      'HQ_PROJECT',
      'agent-os-hq reviewer runtime requires HQ_PROJECT; register a project with `hq project register <name>` and export HQ_PROJECT.'
    );
    runtimeEnv.HQ_PARENT_SESSION = parentSession;
    runtimeEnv.HQ_PROJECT = project;
    const ownerUser = assertOwnerMatches({ hqRoot: resolvedHqRoot, env: runtimeEnv });
    const stripped = stripForbiddenFallbackEnv(runtimeEnv, forbiddenFallbacks);
    return {
      env: runtimeEnv,
      hqRoot: resolvedHqRoot,
      hqBin: resolvedHqBin,
      ownerUser,
      parentSession,
      project,
      stripped,
    };
  }

  function resolveDeadline(timeoutMs, startMs = nowMs()) {
    const normalized = Number(timeoutMs);
    if (!Number.isFinite(normalized) || normalized <= 0) return null;
    return startMs + normalized;
  }

  function remainingUntilDeadline(deadlineMs, referenceMs = nowMs()) {
    if (!Number.isFinite(deadlineMs)) return null;
    return deadlineMs - referenceMs;
  }

  function resolveHqCommandTimeoutMs(deadlineMs) {
    const remainingMs = remainingUntilDeadline(deadlineMs);
    if (remainingMs === null) {
      return pollBaseMs + pollJitterMs + HQ_COMMAND_TIMEOUT_BUFFER_MS;
    }
    return Math.max(MIN_HQ_COMMAND_TIMEOUT_MS, remainingMs);
  }

  async function cancelDispatch({ command, hqRoot: resolvedHqRoot, runtimeEnv, dispatchId, deadlineMs }) {
    try {
      await runHq(command, ['dispatch', 'cancel', dispatchId, '--root', resolvedHqRoot], {
        env: { ...runtimeEnv, HQ_ROOT: resolvedHqRoot },
        timeout: resolveHqCommandTimeoutMs(deadlineMs),
      });
    } catch {}
  }

  async function runHq(command, args, options = {}) {
    try {
      return await execFileImpl(command, args, options);
    } catch (err) {
      const detail = [err.message, err.stdout, err.stderr].filter(Boolean).join('\n');
      if (OWNER_MISMATCH_RE.test(detail)) {
        err.configurationError = true;
      }
      throw err;
    }
  }

  function classifyHqFailure(err) {
    if (isReviewerSubprocessTimeout(err, { killSignal: 'SIGTERM' }) || /timed out/i.test(String(err?.message || ''))) {
      return 'reviewer-timeout';
    }
    return err?.configurationError ? 'bug' : 'unknown';
  }

  async function pollUntilTerminal({
    hqBin: command,
    hqRoot: resolvedHqRoot,
    runtimeEnv,
    dispatchId,
    spawnedAt,
    artifactPath,
    record,
    timeoutMs,
  }) {
    let firstLeaseExpiredAt = null;
    let leaseExpiredProgressKey = null;
    const deadlineMs = resolveDeadline(timeoutMs);

    while (true) {
      if (remainingUntilDeadline(deadlineMs) !== null && remainingUntilDeadline(deadlineMs) <= 0) {
        await cancelDispatch({ command, hqRoot: resolvedHqRoot, runtimeEnv, dispatchId, deadlineMs });
        record = updateReviewerRunRecord(rootDir, record, {
          state: 'failed',
          lastHeartbeatAt: now(),
        });
        return result({
          ok: false,
          spawnedAt,
          failureClass: 'reviewer-timeout',
          stderrTail: `hq dispatch ${dispatchId} exceeded reviewer timeout of ${timeoutMs}ms and was canceled`,
          reattachToken: dispatchId,
          error: `reviewer timeout exceeded for ${dispatchId}`,
        });
      }
      const { stdout } = await runHq(command, ['dispatch', 'status', dispatchId, '--root', resolvedHqRoot], {
        env: { ...runtimeEnv, HQ_ROOT: resolvedHqRoot },
        timeout: resolveHqCommandTimeoutMs(deadlineMs),
      });
      const statusPayload = normalizeStatusPayload(stdout);
      const status = String(statusPayload.status || '');
      const progressKey = makeProgressKey(statusPayload);

      if (statusPayload.lastProgressAt && statusPayload.lastProgressAt !== record.lastHeartbeatAt) {
        record = updateReviewerRunRecord(rootDir, record, {
          state: 'heartbeating',
          lastHeartbeatAt: statusPayload.lastProgressAt,
        });
      }

      if (String(statusPayload.health || '').toLowerCase() === 'lease_expired') {
        if (leaseExpiredProgressKey !== progressKey) {
          leaseExpiredProgressKey = progressKey;
          firstLeaseExpiredAt = nowMs();
        } else if (firstLeaseExpiredAt !== null && nowMs() - firstLeaseExpiredAt >= leaseExpiredGraceMs) {
          record = updateReviewerRunRecord(rootDir, record, {
            state: 'failed',
            lastHeartbeatAt: now(),
          });
          return result({
            ok: false,
            spawnedAt,
            failureClass: 'lease-expired',
            stderrTail: `hq dispatch ${dispatchId} has reported lease_expired for more than ${Math.round(leaseExpiredGraceMs / 1000)}s with no progress; inspect: hq dispatch trace ${dispatchId}`,
            stdoutTail: tailText(stdout),
            reattachToken: dispatchId,
            error: `lease_expired without progress for ${dispatchId}`,
          });
        }
      } else {
        firstLeaseExpiredAt = null;
        leaseExpiredProgressKey = null;
      }

      if (TERMINAL_STATUSES.has(status)) {
        if (SUCCESS_STATUSES.has(status)) {
          try {
            const reviewBody = readValidatedArtifact(artifactPath);
            record = updateReviewerRunRecord(rootDir, record, {
              state: 'completed',
              lastHeartbeatAt: now(),
            });
            return result({
              ok: true,
              reviewBody,
              stdoutTail: tailText(stdout),
              exitCode: 0,
              spawnedAt,
              reattachToken: dispatchId,
            });
          } catch (err) {
            record = updateReviewerRunRecord(rootDir, record, {
              state: 'failed',
              lastHeartbeatAt: now(),
            });
            return result({
              ok: false,
              spawnedAt,
              failureClass: 'reviewer-output',
              stderrTail: err.message,
              stdoutTail: tailText(stdout),
              reattachToken: dispatchId,
              error: err.message,
            });
          }
        }
        record = updateReviewerRunRecord(rootDir, record, {
          state: status === 'canceled' || status === 'cancelled' ? 'cancelled' : 'failed',
          lastHeartbeatAt: now(),
        });
        return result({
          ok: false,
          spawnedAt,
          failureClass: statusPayload.failureClass || 'unknown',
          stderrTail: statusPayload.failureDetail || `hq dispatch ${dispatchId} ended with status ${status}`,
          stdoutTail: tailText(stdout),
          exitCode: Number.isInteger(statusPayload.exitCode) ? statusPayload.exitCode : null,
          reattachToken: dispatchId,
          error: statusPayload.failureDetail || `hq dispatch ${dispatchId} ended with status ${status}`,
        });
      }

      const waitMs = pollBaseMs + jitterImpl(pollJitterMs);
      await sleepImpl(waitMs);
    }
  }

  async function spawnReviewer(req) {
    const sessionUuid = String(req?.sessionUuid || req?.subjectContext?.reviewerSessionUuid || '').trim();
    if (!sessionUuid) throw new TypeError('ReviewerRunRequest.sessionUuid is required');
    const spawnedAt = now();
    const subjectContext = {
      ...(req.subjectContext || {}),
      domainId: req.subjectContext?.domainId || 'code-pr',
      reviewerSessionUuid: sessionUuid,
      sessionUuid,
      model: req.model,
      timeoutMs: req.timeoutMs,
    };
    const artifactPath = hqReviewArtifactPath(rootDir, sessionUuid);
    const promptPath = hqPromptPath(rootDir, sessionUuid);
    subjectContext.agentOsHq = {
      artifactPath,
      promptPath,
      workerClass: null,
    };
    const initialRecord = {
      sessionUuid,
      domain: subjectContext.domainId,
      runtime: 'agent-os-hq',
      state: 'spawned',
      pgid: null,
      spawnedAt,
      lastHeartbeatAt: null,
      reattachToken: sessionUuid,
      subjectContext,
    };
    const claim = claimReviewerRunRecord(rootDir, initialRecord);
    if (!claim.claimed && ACTIVE_RECORD_STATES.has(claim.record?.state)) {
      return result({
        ok: false,
        spawnedAt: claim.record.spawnedAt || spawnedAt,
        failureClass: 'daemon-bounce',
        stderrTail: `reviewer run ${sessionUuid} is already active`,
        reattachToken: claim.record.reattachToken || sessionUuid,
        error: `reviewer run ${sessionUuid} is already active`,
      });
    }
    if (!claim.claimed) {
      return result({
        ok: false,
        spawnedAt: claim.record?.spawnedAt || spawnedAt,
        failureClass: 'bug',
        stderrTail: `reviewer run ${sessionUuid} already reached terminal state ${claim.record?.state || 'unknown'}; mint a new session UUID before retrying`,
        reattachToken: claim.record?.reattachToken || sessionUuid,
        error: `reviewer run ${sessionUuid} already reached terminal state ${claim.record?.state || 'unknown'}`,
      });
    }

    let record = claim.record || initialRecord;
    activeRuns.set(sessionUuid, { record, dispatchId: null });

    try {
      const effectiveForbiddenFallbacks = req.forbiddenFallbacks || DEFAULT_FORBIDDEN_FALLBACKS;
      const runtime = resolveRuntimeConfig(effectiveForbiddenFallbacks);
      const dispatchEnv = {
        ...runtime.env,
        HQ_ROOT: runtime.hqRoot,
        HQ_PARENT_SESSION: runtime.parentSession,
        HQ_PROJECT: runtime.project,
      };
      const reviewerPrompt = buildReviewerPrompt(req, artifactPath);
      writeFileAtomic(promptPath, reviewerPrompt);

      const ticketRef = String(
        req.subjectContext?.linearTicketId
        || req.subjectContext?.subjectExternalId
        || ''
      ).trim();
      if (!ticketRef) {
        throw makeConfigurationError(
          'agent-os-hq reviewer runtime requires subjectContext.linearTicketId or subjectContext.subjectExternalId'
        );
      }
      const selectedWorkerClass = resolveWorkerClass(req.model, req.workerClass || workerClass);
      subjectContext.agentOsHq.workerClass = selectedWorkerClass;
      const dispatchArgs = buildDispatchArgs({
        ticketRef,
        workerClass: selectedWorkerClass,
        promptPath,
        parentSession: runtime.parentSession,
        project: runtime.project,
        tokenBudget: req.tokenBudget,
        taskKind,
        hqRoot: runtime.hqRoot,
      });
      const { stdout, stderr } = await runHq(runtime.hqBin, dispatchArgs, {
        env: dispatchEnv,
        timeout: resolveHqCommandTimeoutMs(resolveDeadline(req.timeoutMs)),
      });
      const ticket = parseDispatchTicket(stdout);
      const dispatchId = ticket.launchRequestId;
      record = updateReviewerRunRecord(rootDir, record, {
        state: 'heartbeating',
        lastHeartbeatAt: now(),
        reattachToken: dispatchId,
        subjectContext: {
          ...subjectContext,
          agentOsHq: {
            ...subjectContext.agentOsHq,
            dispatchId,
            hqRoot: runtime.hqRoot,
            hqBin: runtime.hqBin,
            parentSession: runtime.parentSession,
            project: runtime.project,
            forbiddenFallbacks: Array.isArray(effectiveForbiddenFallbacks)
              ? [...effectiveForbiddenFallbacks]
              : effectiveForbiddenFallbacks,
          },
        },
      });
      activeRuns.set(sessionUuid, { record, dispatchId });

      const polled = await pollUntilTerminal({
        hqBin: runtime.hqBin,
        hqRoot: runtime.hqRoot,
        runtimeEnv: runtime.env,
        dispatchId,
        spawnedAt: record.spawnedAt,
        artifactPath,
        record,
        timeoutMs: req.timeoutMs,
      });
      if (runtime.stripped.length > 0 && !polled.ok) {
        polled.stderrTail = polled.stderrTail
          ? [`stripped forbidden fallback env before hq dispatch: ${runtime.stripped.join(', ')}`, polled.stderrTail].join('\n')
          : `stripped forbidden fallback env before hq dispatch: ${runtime.stripped.join(', ')}`;
      }
      if (stderr && !polled.stderrTail) polled.stderrTail = tailText(stderr);
      return polled;
    } catch (err) {
      const exitCode = Number.isInteger(err?.code) ? err.code : null;
      const detail = [err.message, err.stdout, err.stderr].filter(Boolean).join('\n').trim();
      record = updateReviewerRunRecord(rootDir, record, {
        state: 'failed',
        lastHeartbeatAt: now(),
      });
      return result({
        ok: false,
        spawnedAt: record.spawnedAt,
        failureClass: classifyHqFailure(err),
        stderrTail: tailText(err?.stderr || detail),
        stdoutTail: tailText(err?.stdout || ''),
        exitCode,
        signal: typeof err?.signal === 'string' ? err.signal : null,
        reattachToken: record.reattachToken,
        error: detail || err.message,
        configurationError: err?.configurationError === true,
      });
    } finally {
      activeRuns.delete(sessionUuid);
    }
  }

  async function spawnRemediator(req = {}) {
    return result({
      ok: false,
      failureClass: 'bug',
      stderrTail: 'agent-os-hq remediator runtime is not implemented for LAC-566',
      spawnedAt: now(),
      reattachToken: req.sessionUuid || null,
    });
  }

  async function cancel(sessionUuid) {
    const active = activeRuns.get(sessionUuid);
    const record = active?.record || readReviewerRunRecord(rootDir, sessionUuid);
    if (!record || TERMINAL_RUN_STATES.has(record.state)) return;
    const dispatchId = active?.dispatchId || record?.reattachToken;
    if (!dispatchId || dispatchId === sessionUuid) return;
    try {
      const runtime = resolveRuntimeConfig();
      await cancelDispatch({
        command: runtime.hqBin,
        hqRoot: runtime.hqRoot,
        runtimeEnv: runtime.env,
        dispatchId,
      });
    } finally {
      updateReviewerRunRecord(rootDir, record, {
        state: 'cancelled',
        lastHeartbeatAt: now(),
      });
    }
  }

  async function reattach(record) {
    const normalized = record || {};
    const spawnedAt = normalized.spawnedAt || now();
    const dispatchId = String(normalized.reattachToken || '').trim();
    const hqContext = normalized.subjectContext?.agentOsHq || {};
    if (!dispatchId || dispatchId === normalized.sessionUuid) {
      return result({
        ok: false,
        spawnedAt,
        failureClass: 'daemon-bounce',
        stderrTail: 'agent-os-hq reviewer run record has no launch request id to reattach after daemon bounce',
        reattachToken: dispatchId || null,
        error: 'agent-os-hq reviewer run record has no launch request id to reattach after daemon bounce',
      });
    }
    try {
      const runtime = resolveRuntimeConfig();
      const artifactPath = hqContext.artifactPath || hqReviewArtifactPath(rootDir, normalized.sessionUuid);
      const reattachTimeoutMs = Number(normalized.subjectContext?.timeoutMs);
      return await pollUntilTerminal({
        hqBin: hqContext.hqBin || runtime.hqBin,
        hqRoot: hqContext.hqRoot || runtime.hqRoot,
        runtimeEnv: runtime.env,
        dispatchId,
        spawnedAt,
        artifactPath,
        record: normalized,
        timeoutMs: Number.isFinite(reattachTimeoutMs) && reattachTimeoutMs > 0
          ? Math.floor(reattachTimeoutMs)
          : resolveReviewerTimeoutMs(runtime.env),
      });
    } catch (err) {
      const detail = [err.message, err.stdout, err.stderr].filter(Boolean).join('\n').trim();
      if (normalized.sessionUuid) {
        updateReviewerRunRecord(rootDir, normalized, {
          state: 'failed',
          lastHeartbeatAt: now(),
        });
      }
      return result({
        ok: false,
        spawnedAt,
        failureClass: classifyHqFailure(err),
        stderrTail: tailText(err?.stderr || detail),
        stdoutTail: tailText(err?.stdout || ''),
        exitCode: Number.isInteger(err?.code) ? err.code : null,
        reattachToken: dispatchId,
        error: detail || err.message,
        configurationError: err?.configurationError === true,
      });
    }
  }

  function describe() {
    return {
      id: 'agent-os-hq',
      modelFamily: 'agent-os-worker-pool',
      deployment: 'Agent OS HQ only; requires HQ_ROOT, HQ_PARENT_SESSION, HQ_PROJECT, and hq on PATH or HQ_BIN.',
      authContract: {
        forbiddenFallbacks: DEFAULT_FORBIDDEN_FALLBACKS,
        promptTransport: 'file',
        completionShape: 'artifact',
      },
      capabilities: {
        processGroupIsolation: true,
        daemonBounceSafe: true,
        heartbeatPersisted: true,
        leaseManaged: true,
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
  DEFAULT_FORBIDDEN_FALLBACKS,
  buildDispatchArgs,
  createAgentOsHqReviewerRuntimeAdapter,
  validateReviewArtifact,
};
