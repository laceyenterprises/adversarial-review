// merge-agent-original-worker.mjs
//
// Original-review-worker lookup + workspace preparation helpers extracted from
// follow-up-merge-agent.mjs (ARC-19). These resolve the original review
// worker's run-status + workspace so the merge-agent can decide whether the
// original worker is safe to reuse/tear down. This is a LEAF module: it must
// never import from ./follow-up-merge-agent.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readLatestWorkerRunStatusFromLedger } from './session-ledger-read-adapter.mjs';

const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKER_ID_CLASS_PREFIXES = [
  'claude-code',
  'clio-agent',
  'merge-agent',
  'codex',
  'gemini',
  'pi',
  'opencode',
  'hermes',
  'stub',
];
// Must stay aligned with platform/session-ledger/src/session_ledger/models.py
// WORKER_RUN_TERMINAL_STATUSES. Merge-agent preflight may tear down the
// original worker ONLY after the canonical ledger marks the run terminal.
const TERMINAL_WORKER_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const SESSION_LEDGER_LOOKUP_REASON_ALIASES = new Map([
  ['missing-ledger-target', 'missing-ledger-db'],
  ['ledger-read-failed', 'worker-run-lookup-failed'],
  ['psql-not-installed', 'worker-run-lookup-failed'],
]);

function deriveOriginalWorkerIdFromBranch(branch) {
  const normalized = String(branch || '').trim();
  if (!normalized.includes('/')) return null;
  const [workerId] = normalized.split('/');
  return workerId || null;
}

function isRecognizedOriginalWorkerId(workerId) {
  const normalized = String(workerId || '').trim();
  return WORKER_ID_PATTERN.test(normalized)
    && WORKER_ID_CLASS_PREFIXES.some((prefix) => (
      normalized === prefix || normalized.startsWith(`${prefix}-`)
    ));
}

function readJsonFileDetailed(filePath) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function isTerminalWorkerRunStatus(status) {
  const normalized = normalizeWorkerRunStatus(status);
  return Boolean(normalized) && TERMINAL_WORKER_RUN_STATUSES.has(normalized);
}

function readWorkerWorkspace(workerDir) {
  const workspacePath = join(workerDir, 'workspace.json');
  const workspace = readJsonFileDetailed(workspacePath);
  if (workspace.ok) {
    return { found: true, workspace: workspace.value };
  }
  if (workspace.error?.code === 'ENOENT') {
    return { found: false, reason: 'workspace-missing' };
  }
  return {
    found: false,
    reason: 'workspace-read-failed',
    detail: workspace.error?.message || String(workspace.error),
    code: workspace.error?.code || null,
  };
}

function validateWorkerWorkspaceForBranch(workspace, originalWorkerId, branch) {
  const workspaceWorkerId = String(workspace?.workerId || '').trim();
  if (!workspaceWorkerId) {
    return { ok: false, reason: 'workspace-worker-id-missing', workspaceWorkerId: null };
  }
  if (workspaceWorkerId !== originalWorkerId) {
    return { ok: false, reason: 'workspace-worker-id-mismatch', workspaceWorkerId };
  }
  const workspaceBranch = String(workspace?.branch || '').trim();
  if (!workspaceBranch) {
    return { ok: false, reason: 'workspace-branch-missing', workspaceWorkerId, workspaceBranch: null };
  }
  if (branch && workspaceBranch !== branch) {
    return { ok: false, reason: 'workspace-branch-mismatch', workspaceWorkerId, workspaceBranch };
  }
  return { ok: true, workspaceWorkerId, workspaceBranch };
}

function normalizeWorkerRunStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function normalizeDeferredLookupFailureReason(reason) {
  return SESSION_LEDGER_LOOKUP_REASON_ALIASES.get(reason) || reason;
}

async function lookupOriginalWorkerRunStatus({
  workerDir,
  hqRoot,
  env,
  ledgerTarget = null,
  workspace = undefined,
  runRecord = undefined,
  readLatestWorkerRunStatusImpl = readLatestWorkerRunStatusFromLedger,
} = {}) {
  const resolvedWorkspace = workspace === undefined
    ? readWorkerWorkspace(workerDir).workspace || null
    : workspace;
  const resolvedRunRecord = runRecord === undefined
    ? (() => {
      const run = readJsonFileDetailed(join(workerDir, 'run.json'));
      return run.ok ? run.value : null;
    })()
    : runRecord;
  const launchRequestId = resolvedWorkspace?.launchRequestId || resolvedWorkspace?.lrq
    || resolvedRunRecord?.launchRequestId || resolvedRunRecord?.lrq || null;
  const runId = resolvedRunRecord?.runId || null;
  if (!launchRequestId) {
    return { found: false, reason: 'missing-launch-request-id' };
  }

  const result = readLatestWorkerRunStatusImpl({
    launchRequestId,
    ledgerTarget,
    env,
    hqRoot,
    rootDir: null,
  });
  if (!result.ok) {
    return {
      found: false,
      reason: normalizeDeferredLookupFailureReason(result.reason),
      detail: result.detail || null,
      launchRequestId,
      runId,
    };
  }
  return {
    found: true,
    status: normalizeWorkerRunStatus(result.row.status),
    launchRequestId: result.row.launch_request_id || launchRequestId || null,
    runId: result.row.run_id || runId || null,
  };
}

export {
  WORKER_ID_PATTERN,
  WORKER_ID_CLASS_PREFIXES,
  TERMINAL_WORKER_RUN_STATUSES,
  SESSION_LEDGER_LOOKUP_REASON_ALIASES,
  deriveOriginalWorkerIdFromBranch,
  isRecognizedOriginalWorkerId,
  readJsonFileDetailed,
  isTerminalWorkerRunStatus,
  readWorkerWorkspace,
  validateWorkerWorkspaceForBranch,
  normalizeWorkerRunStatus,
  normalizeDeferredLookupFailureReason,
  lookupOriginalWorkerRunStatus,
};
