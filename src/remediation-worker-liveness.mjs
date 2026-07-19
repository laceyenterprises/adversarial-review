import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import {
  HQ_TERMINAL_STATUSES,
  parseHqDispatchStatus,
  resolveHqBin,
  workerTerminalEventMatches,
  workerTerminalEventToDispatchStatus,
} from './remediation-hq-dispatch.mjs';
import { resolveHqRoot } from './remediation-reply-paths.mjs';

// Worker-process liveness primitives for remediation reconcile. Answers
// "is this remediation worker still alive, or has it exited/terminated?"
// for both same-host detached workers (PID / process-group probes) and
// HQ-dispatched workers (dispatch-status probe). Extracted verbatim from
// follow-up-remediation.mjs (ARC-19 wave-4) so the reconcile orchestrator
// depends on a small, self-contained liveness surface.

const execFileAsync = promisify(execFile);

const RECONCILIATION_MAX_ACTIVE_MS = 6 * 60 * 60 * 1000;

function isWorkerProcessRunning(processId) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }

  try {
    process.kill(processId, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') {
      return false;
    }
    if (err?.code === 'EPERM') {
      return true;
    }
    throw err;
  }
}

function killDetachedWorkerProcessGroup(processId, signal = 'SIGKILL') {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  if (processId === process.pid) {
    console.error(
      `[follow-up-remediation] refusing to kill daemon-owned process group for pid=${processId}`
    );
    return false;
  }

  try {
    process.kill(-processId, signal);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') {
      return false;
    }
    try {
      process.kill(processId, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function parseIsoTime(value) {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function assessWorkerLiveness(job, { now = () => new Date().toISOString(), isWorkerRunning = isWorkerProcessRunning } = {}) {
  const worker = job?.remediationWorker || {};
  const nowAt = parseIsoTime(now());
  const spawnedAt = parseIsoTime(worker.spawnedAt);
  const ageMs = nowAt !== null && spawnedAt !== null ? nowAt - spawnedAt : null;
  const processRunning = isWorkerRunning(worker.processId);

  if (processRunning) {
    if (ageMs !== null && ageMs > RECONCILIATION_MAX_ACTIVE_MS) {
      return { state: 'manual-inspection', reason: 'pid-active-beyond-runtime-cap', ageMs };
    }
    return { state: 'active', reason: 'worker-still-running', ageMs };
  }

  return { state: 'exited', reason: 'worker-not-running', ageMs };
}

async function assessWorkerLivenessDetailed(job, {
  now = () => new Date().toISOString(),
  isWorkerRunning = isWorkerProcessRunning,
  execFileImpl = execFileAsync,
  env = process.env,
  workerTerminalEvent = null,
  workerTerminalReplyPath = null,
} = {}) {
  const worker = job?.remediationWorker || {};
  if (
    workerTerminalEvent?.status === 'succeeded'
    && workerTerminalEventMatches(worker, workerTerminalEvent)
    && workerTerminalReplyPath
    && existsSync(workerTerminalReplyPath)
  ) {
    const nowAt = parseIsoTime(now());
    const spawnedAt = parseIsoTime(worker.spawnedAt);
    const ageMs = nowAt !== null && spawnedAt !== null ? nowAt - spawnedAt : null;
    return {
      state: 'exited',
      reason: `health-worker-terminal-${workerTerminalEvent.status}`,
      ageMs,
      dispatchStatus: workerTerminalEventToDispatchStatus(workerTerminalEvent, worker),
    };
  }
  if (!worker?.dispatchId || worker?.dispatchMode !== 'hq') {
    return assessWorkerLiveness(job, { now, isWorkerRunning });
  }

  const nowAt = parseIsoTime(now());
  const spawnedAt = parseIsoTime(worker.spawnedAt);
  const ageMs = nowAt !== null && spawnedAt !== null ? nowAt - spawnedAt : null;
  const hqRoot = worker.hqRoot || resolveHqRoot(env, { requireExists: false });
  const hqBin = resolveHqBin(env);

  try {
    const { stdout } = await execFileImpl(hqBin, [
      'dispatch',
      'status',
      worker.dispatchId,
      '--root',
      hqRoot,
    ], {
      env: {
        ...env,
        HQ_ROOT: hqRoot,
      },
      maxBuffer: 5 * 1024 * 1024,
    });
    const statusPayload = parseHqDispatchStatus(stdout);
    if (HQ_TERMINAL_STATUSES.has(statusPayload.status)) {
      return {
        state: 'exited',
        reason: `hq-dispatch-${statusPayload.status}`,
        ageMs,
        dispatchStatus: statusPayload,
      };
    }
    return {
      state: 'active',
      reason: `hq-dispatch-${statusPayload.status}`,
      ageMs,
      dispatchStatus: statusPayload,
    };
  } catch (err) {
    const detail = [err?.message, err?.stdout, err?.stderr].filter(Boolean).join('\n');
    if (/no dispatch with id|not found/i.test(detail)) {
      return {
        state: 'exited',
        reason: 'hq-dispatch-not-found',
        ageMs,
        dispatchStatus: {
          status: 'not-found',
          failureDetail: detail,
        },
      };
    }
    return {
      state: 'active',
      reason: 'hq-dispatch-status-unavailable',
      ageMs,
      dispatchStatus: {
        status: 'unknown',
        failureDetail: detail || err?.message || 'status probe failed',
      },
    };
  }
}

export {
  isWorkerProcessRunning,
  killDetachedWorkerProcessGroup,
  assessWorkerLiveness,
  assessWorkerLivenessDetailed,
};
