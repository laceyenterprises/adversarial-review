// Remediation HQ dispatch status/cancel helpers.
//
// Extracted from follow-up-remediation.mjs (ARC-19 wave4). This is a
// self-contained leaf holding the HQ-dispatch transport helpers the
// remediation orchestration depends on:
//   - JSON/status parsers for `hq dispatch status` output;
//   - worker-terminal-event normalization and dispatch-status projection
//     (from the health.worker.terminal.<lrq> app-contract topic);
//   - dispatch-failure classification (transient vs terminal);
//   - HQ worker-workspace resolution (persisted dir or live status probe);
//   - the retryable `hq dispatch cancel` wrapper.
//
// It imports only node: builtins and ./remediation-reply-paths.mjs and MUST
// NOT import ./follow-up-remediation.mjs (that would create a cycle — the
// monolith imports this module, not the other way around). `execFileAsync` is
// a behavior-preserving private copy of the trivial promisify primitive that
// also exists in the monolith, per the established remediation-git-pr-io.mjs /
// fast-merge-processing.mjs precedent.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { resolveHqRoot } from './remediation-reply-paths.mjs';

const execFileAsync = promisify(execFile);

const HQ_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'superseded']);
const HQ_CANCEL_RETRY_DELAYS_MS = [250, 500];
const TRANSIENT_HQ_DISPATCH_CODES = new Set([
  'daemon_bounced',
  'daemon-bounced',
  'daemon_restart',
  'daemon-restart',
  'launch_refused_memory_pressure',
  'launch-refused-memory-pressure',
  'lease_lost',
  'lease-lost',
  'memory_pressure',
  'memory-pressure',
  'supervisor_restart',
  'supervisor-restart',
]);

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function resolveHqBin(env = process.env) {
  const explicit = String(env.HQ_BIN || '').trim();
  if (explicit) {
    return explicit;
  }
  return 'hq';
}

function parseHqJsonObject(text, label) {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error(`${label} produced empty output`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    throw new Error(`${label} did not return JSON`);
  }
}

function normalizeHqWorkspaceDir(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? resolve(normalized) : null;
}

function parseHqWorkerWorkspaceFromPayload(payload) {
  const direct = [
    payload?.workspaceDir,
    payload?.workspacePath,
    payload?.worktreePath,
    payload?.repoPath,
    payload?.cwd,
  ];
  for (const candidate of direct) {
    const resolvedPath = normalizeHqWorkspaceDir(candidate);
    if (resolvedPath) return resolvedPath;
  }
  const nested = payload?.worker;
  if (nested && typeof nested === 'object') {
    return parseHqWorkerWorkspaceFromPayload(nested);
  }
  return null;
}

function parseHqDispatchStatus(stdout) {
  const payload = parseHqJsonObject(stdout, 'hq dispatch status');
  const status = String(payload?.status || '').trim().toLowerCase();
  if (!status) {
    throw new Error('hq dispatch status payload missing status');
  }
  return {
    ...payload,
    status,
    health: String(payload?.health || '').trim().toLowerCase() || null,
  };
}

function normalizeWorkerTerminalEvent(topic, event = {}) {
  const normalizedTopic = String(topic || '').trim();
  const match = normalizedTopic.match(/^health\.worker\.terminal\.([^.\s]+)$/);
  const lrq = String(event?.lrq || event?.launch_request_id || event?.launchRequestId || match?.[1] || '').trim();
  const status = String(event?.status || '').trim().toLowerCase();
  if (!lrq || !status || !HQ_TERMINAL_STATUSES.has(status)) {
    return null;
  }
  return {
    ...event,
    topic: normalizedTopic,
    lrq,
    status,
    health: String(event?.health || '').trim().toLowerCase() || (status === 'succeeded' ? 'healthy' : 'failed'),
  };
}

function workerTerminalEventMatches(worker, terminalEvent) {
  if (!worker || !terminalEvent) return false;
  const workerLrq = String(worker.launchRequestId || worker.launch_request_id || '').trim();
  return Boolean(workerLrq && workerLrq === terminalEvent.lrq);
}

function workerTerminalEventToDispatchStatus(terminalEvent, worker = {}) {
  return {
    status: terminalEvent.status,
    health: terminalEvent.health || (terminalEvent.status === 'succeeded' ? 'healthy' : 'failed'),
    lrq: terminalEvent.lrq,
    launch_request_id: terminalEvent.lrq,
    failureClass: terminalEvent.failureClass || terminalEvent.failure_class || null,
    failureDetail: terminalEvent.failureDetail || terminalEvent.failure_detail || null,
    recoveryAttempt: terminalEvent.recoveryAttempt ?? terminalEvent.recovery_attempt ?? null,
    workspacePath: terminalEvent.workspacePath || terminalEvent.workspaceDir || worker.workspaceDir || null,
    source: 'app-contract-topic',
    topic: terminalEvent.topic,
  };
}

function parseHqDispatchWorkspaceStatus(stdout) {
  const payload = parseHqDispatchStatus(stdout);
  const workspaceDir = parseHqWorkerWorkspaceFromPayload(payload);
  if (!workspaceDir) {
    throw new Error('hq dispatch status payload missing workspaceDir/workspacePath/worktreePath');
  }
  return {
    ...payload,
    workspaceDir,
  };
}

function classifyHqDispatchFailure(dispatchStatus = {}) {
  const structuredValues = [
    dispatchStatus?.failureClass,
    dispatchStatus?.failureCode,
    dispatchStatus?.failure_class,
    dispatchStatus?.failure_code,
    dispatchStatus?.code,
    dispatchStatus?.reasonCode,
    dispatchStatus?.statusCode,
    dispatchStatus?.status,
    dispatchStatus?.health,
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean);

  if (structuredValues.some((value) => TRANSIENT_HQ_DISPATCH_CODES.has(value))) return 'transient';

  const detail = String(dispatchStatus?.failureDetail || '').trim().toLowerCase();
  if (!detail && structuredValues.length === 0) return 'terminal';
  if (
    /\bmemory pressure\b/.test(detail)
    || /\blaunch[_ -]refused[_ -]memory[_ -]pressure\b/.test(detail)
    || /\blease lost\b|\blost lease\b/.test(detail)
  ) {
    return 'transient';
  }
  return 'terminal';
}

async function resolveHqWorkerWorkspace({
  worker,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const persistedWorkspaceDir = normalizeHqWorkspaceDir(worker?.workspaceDir);
  if (persistedWorkspaceDir && existsSync(join(persistedWorkspaceDir, '.git'))) {
    return persistedWorkspaceDir;
  }
  const dispatchId = String(worker?.dispatchId || '').trim();
  const hqRoot = worker?.hqRoot || resolveHqRoot(env, { requireExists: false });
  if (!dispatchId || !hqRoot) {
    return null;
  }
  const hqBin = resolveHqBin(env);
  const { stdout } = await execFileImpl(hqBin, [
    'dispatch',
    'status',
    dispatchId,
    '--root',
    hqRoot,
  ], {
    env: {
      ...env,
      HQ_ROOT: hqRoot,
    },
    maxBuffer: 5 * 1024 * 1024,
  });
  return parseHqDispatchWorkspaceStatus(stdout).workspaceDir;
}

function isHqCancelRetryable(err) {
  const detail = [err?.message, err?.stdout, err?.stderr].filter(Boolean).join('\n');
  return /(?:^|[\s:])(EIO)(?:$|[\s:])|timed out|timeout/i.test(detail);
}

async function cancelHqDispatch({
  worker,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const dispatchId = String(worker?.dispatchId || '').trim();
  const hqRoot = worker?.hqRoot || resolveHqRoot(env, { requireExists: false });
  if (!dispatchId || !hqRoot) {
    return {
      cancelled: false,
      skipped: true,
      reason: 'missing-hq-dispatch-handle',
      attempts: 0,
    };
  }

  const hqBin = resolveHqBin(env);
  const retryDelaysMs = [0, ...HQ_CANCEL_RETRY_DELAYS_MS];
  let lastError = null;
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    if (retryDelaysMs[attempt] > 0) {
      await sleep(retryDelaysMs[attempt]);
    }
    try {
      const result = await execFileImpl(hqBin, ['dispatch', 'cancel', dispatchId, '--root', hqRoot], {
        env: {
          ...env,
          HQ_ROOT: hqRoot,
        },
        maxBuffer: 5 * 1024 * 1024,
      });
      return {
        cancelled: true,
        attempts: attempt + 1,
        exitCode: 0,
        stdout: String(result?.stdout || '').trim() || null,
        stderr: String(result?.stderr || '').trim() || null,
      };
    } catch (err) {
      lastError = err;
      if (!isHqCancelRetryable(err) || attempt === retryDelaysMs.length - 1) {
        break;
      }
    }
  }

  return {
    cancelled: false,
    attempts: retryDelaysMs.length,
    exitCode: Number.isInteger(lastError?.code) ? lastError.code : null,
    stdout: String(lastError?.stdout || '').trim() || null,
    stderr: String(lastError?.stderr || '').trim() || null,
    error: lastError?.message || 'hq dispatch cancel failed',
    retryable: isHqCancelRetryable(lastError),
  };
}

export {
  HQ_TERMINAL_STATUSES,
  HQ_CANCEL_RETRY_DELAYS_MS,
  TRANSIENT_HQ_DISPATCH_CODES,
  resolveHqBin,
  parseHqJsonObject,
  normalizeHqWorkspaceDir,
  parseHqWorkerWorkspaceFromPayload,
  parseHqDispatchStatus,
  normalizeWorkerTerminalEvent,
  workerTerminalEventMatches,
  workerTerminalEventToDispatchStatus,
  parseHqDispatchWorkspaceStatus,
  classifyHqDispatchFailure,
  resolveHqWorkerWorkspace,
  isHqCancelRetryable,
  cancelHqDispatch,
};
