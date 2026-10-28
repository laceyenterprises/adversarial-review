import { readHostIdentitySync } from './dispatch-files-client.mjs';
// ARC-19 wave9: original-worker teardown preflight for merge-agent dispatch.
//
// Extracted VERBATIM from follow-up-merge-agent.mjs. `prepareOriginalWorkerForMergeAgent`
// is the preflight that decides whether the original PR worker can be torn
// down before the merge-agent is dispatched onto the same branch. It is a
// self-contained decision function (returns a { decision, reason, ... } object;
// its only side effect is a single `hq worker tear-down` exec + lifecycle
// logging), which is why it lifts cleanly out of the dispatch/coexistence core.
//
// The HQ root/owner/timeout resolvers and the lifecycle-log/isoNow primitives
// stay owned by the monolith (they are woven through the DO-NOT-TOUCH
// reconcile/dispatch state machine). This leaf keeps behavior-preserving
// PRIVATE copies of those trivial helpers rather than importing them back,
// which would create a src->monolith circular import. This mirrors the
// established precedent in this codebase: `isoNow`, `resolveHqRoot`, and
// `resolveHqOwner` are already privately duplicated across
// fast-merge-processing.mjs, fast-merge-github-io.mjs, ama/dispatch-closer.mjs,
// remediation-reply-paths.mjs, and others.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadRoleConfig } from './role-config.mjs';
import {
  deriveOriginalWorkerIdFromBranch,
  isRecognizedOriginalWorkerId,
  isTerminalWorkerRunStatus,
  lookupOriginalWorkerRunStatus,
  readWorkerWorkspace,
  validateWorkerWorkspaceForBranch,
} from './merge-agent-original-worker.mjs';
import {
  currentUser,
  formatExecFailure,
  isExecTimeout,
} from './merge-agent-hq-exec.mjs';

const execFileAsync = promisify(execFile);

const HQ_WORKER_TEAR_DOWN_TIMEOUT_MS = 60_000;

// Moved VERBATIM from the monolith: this Set is exclusive to the teardown
// preflight (its only reader is prepareOriginalWorkerForMergeAgent below).
const DEFERRED_LOOKUP_FAILURE_REASONS = new Set([
  'missing-ledger-db',
  'better-sqlite3-unavailable',
  'worker-run-lookup-failed',
  'worker-run-lookup-threw',
  'missing-launch-request-id',
  'dispatch-files-unavailable',
  'unsupported-ledger-backend',
  'malformed-ledger-target',
]);

// Behavior-preserving PRIVATE copies of monolith-owned primitives (see header).
function isoNow() {
  return new Date().toISOString();
}

function mergeAgentLifecycleLog(logger, event, fields = {}) {
  const sink = logger && typeof logger.info === 'function'
    ? logger.info.bind(logger)
    : console.log.bind(console);
  sink(JSON.stringify({ event, ...fields }));
}

function resolveHqRoot(env = {}) {
  const root = String(env.HQ_ROOT || '').trim();
  return root || null;
}

function resolveHqOwner(hqRoot) {
  return readHostIdentitySync({hqRoot});
}

function resolveHqWorkerTearDownTimeoutMs(env = process.env, options = {}) {
  const cfgValue = loadRoleConfig({
    env,
    topPath: options.topPath,
    modulePaths: options.modulePaths,
    loaderImpl: options.loaderImpl,
    contextKey: 'follow_up.hq_worker_tear_down_subprocess_timeout_ms',
  }).get('follow_up.hq_worker_tear_down_subprocess_timeout_ms', HQ_WORKER_TEAR_DOWN_TIMEOUT_MS);
  const parsed = Number(cfgValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : HQ_WORKER_TEAR_DOWN_TIMEOUT_MS;
}

async function prepareOriginalWorkerForMergeAgent({
  job,
  trigger = null,
  hqPath,
  execFileImpl = execFileAsync,
  env = process.env,
  now = isoNow(),
  logger = console,
  lookupRunStatusImpl = lookupOriginalWorkerRunStatus,
  runtimeUserImpl = currentUser,
} = {}) {
  const originalWorkerId = deriveOriginalWorkerIdFromBranch(job?.branch);
  if (!originalWorkerId) {
    return { decision: 'ready', reason: 'no-derived-worker-id' };
  }
  if (!isRecognizedOriginalWorkerId(originalWorkerId)) {
    mergeAgentLifecycleLog(logger, 'merge_agent.tear_down_skipped', {
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: 'unrecognized-worker-id-shape',
      at: now,
    });
    return {
      decision: 'ready',
      reason: 'unrecognized-worker-id-shape',
      originalWorkerId,
    };
  }

  const hqRoot = resolveHqRoot(env);
  if (!hqRoot) {
    mergeAgentLifecycleLog(logger, 'merge_agent.tear_down_skipped', {
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: 'hq-root-unset',
      at: now,
    });
    return {
      decision: 'ready',
      reason: 'hq-root-unset',
      originalWorkerId,
      hqRoot: null,
    };
  }
  const workspaceState = await readWorkerWorkspace(originalWorkerId, {env, hqRoot});
  const workspace = workspaceState.workspace || null;
  const runRecord = workspaceState.runRecord || null;
  if (!workspaceState.found) {
    const event = workspaceState.reason === 'workspace-missing'
      ? 'merge_agent.workspace_missing'
      : 'merge_agent.workspace_read_failed';
    mergeAgentLifecycleLog(logger, event, {
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: workspaceState.reason || 'workspace-read-failed',
      detail: workspaceState.detail || null,
      code: workspaceState.code || null,
      at: now,
    });
    const reason = workspaceState.reason === 'workspace-missing'
      ? 'workspace-json-missing-but-worker-dir-present'
      : workspaceState.reason || 'workspace-read-failed';
    return {
      decision: 'deferred',
      reason,
      originalWorkerId,
      hqRoot,
    };
  }
  if (workspace?.present === false) {
    let observed;
    try { observed = await lookupRunStatusImpl({workerId: originalWorkerId, hqRoot, env,
      workspace, runRecord, launchRequestId: workspaceState.launchRequestId, runId: workspaceState.runId}); }
    catch { return {decision: 'deferred', reason: 'worker-run-lookup-failed', originalWorkerId}; }
    return observed?.found && isTerminalWorkerRunStatus(observed.status)
      ? {decision: 'ready', reason: 'original-worker-already-torn-down', originalWorkerId, hqRoot}
      : {decision: 'deferred', reason: observed?.found ? `worker-run-status-${observed.status}` : 'worker-run-lookup-failed', originalWorkerId, hqRoot};
  }
  const workspaceValidation = validateWorkerWorkspaceForBranch(workspace, originalWorkerId, job?.branch);
  if (!workspaceValidation.ok) {
    mergeAgentLifecycleLog(logger, 'merge_agent.tear_down_skipped', {
      original_worker_id: originalWorkerId,
      workspace_worker_id: workspaceValidation.workspaceWorkerId || null,
      workspace_branch: workspaceValidation.workspaceBranch || null,
      pr_number: job?.prNumber ?? null,
      reason: workspaceValidation.reason,
      at: now,
    });
    return {
      decision: 'ready',
      reason: workspaceValidation.reason,
      originalWorkerId,
      hqRoot,
    };
  }

  let runStatus;
  try {
    runStatus = await lookupRunStatusImpl({
      workerId: originalWorkerId,
      hqRoot,
      env,
      job,
      originalWorkerId,
      workspace,
      runRecord,
      launchRequestId: workspaceState.launchRequestId,
      runId: workspaceState.runId,
    });
  } catch (err) {
    runStatus = {
      found: false,
      reason: 'worker-run-lookup-threw',
      detail: err?.message || String(err),
    };
  }
  if (!runStatus.found && DEFERRED_LOOKUP_FAILURE_REASONS.has(runStatus.reason)) {
    mergeAgentLifecycleLog(logger, 'merge_agent.tear_down_skipped', {
      lrq: runStatus.launchRequestId || null,
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: runStatus.reason,
      detail: runStatus.detail || null,
      at: now,
    });
    if (runStatus.reason === 'better-sqlite3-unavailable' && logger && typeof logger.error === 'function') {
      logger.error(
        `[merge-agent] worker-run lookup dependency unavailable for ${originalWorkerId}; `
        + 'install/rebuild better-sqlite3 in tools/adversarial-review to restore teardown preflight.'
      );
    }
    return {
      decision: 'skip',
      reason: runStatus.reason,
      originalWorkerId,
      launchRequestId: runStatus.launchRequestId || null,
      detail: runStatus.detail || null,
    };
  }
  if (!runStatus.found && runStatus.reason === 'missing-worker-run-row') {
    mergeAgentLifecycleLog(logger, 'merge_agent.dispatch_deferred', {
      lrq: runStatus.launchRequestId || null,
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: 'original-worker-run-row-missing-but-worktree-present',
      worker_status: null,
      at: now,
    });
    return {
      decision: 'deferred',
      reason: 'original-worker-run-row-missing-but-worktree-present',
      originalWorkerId,
      hqRoot,
      launchRequestId: runStatus.launchRequestId || null,
    };
  }
  const mayTearDown = runStatus.found && isTerminalWorkerRunStatus(runStatus.status);

  if (!mayTearDown) {
    const reason = runStatus.found
      ? `worker-run-status-${runStatus.status || 'unknown'}`
      : runStatus.reason || 'worker-run-status-unknown';
    mergeAgentLifecycleLog(logger, 'merge_agent.dispatch_deferred', {
      lrq: runStatus.launchRequestId || null,
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason,
      worker_status: runStatus.status || null,
      at: now,
    });
    return {
      decision: 'deferred',
      reason,
      originalWorkerId,
      workerStatus: runStatus.status || null,
      launchRequestId: runStatus.launchRequestId || null,
    };
  }

  const ownerResolution = resolveHqOwner(hqRoot);
  const ownerUser = ownerResolution?.ownerUser || null;
  const runtimeUser = runtimeUserImpl(env);
  if (!ownerUser) {
    mergeAgentLifecycleLog(logger, 'merge_agent.tear_down_skipped', {
      lrq: runStatus.launchRequestId || null,
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: ownerResolution?.reason || 'hq-owner-unknown',
      hq_root: hqRoot,
      detail: ownerResolution?.detail || null,
      code: ownerResolution?.code || null,
      at: now,
    });
    return {
      decision: 'deferred',
      reason: ownerResolution?.reason || 'hq-owner-unknown',
      originalWorkerId,
      workerStatus: runStatus.status || null,
      launchRequestId: runStatus.launchRequestId || null,
    };
  }
  if (!runtimeUser) {
    mergeAgentLifecycleLog(logger, 'merge_agent.tear_down_skipped', {
      lrq: runStatus.launchRequestId || null,
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: 'hq-runtime-user-unknown',
      hq_root: hqRoot,
      hq_owner_user: ownerUser,
      at: now,
    });
    return {
      decision: 'deferred',
      reason: 'hq-runtime-user-unknown',
      originalWorkerId,
      workerStatus: runStatus.status || null,
      launchRequestId: runStatus.launchRequestId || null,
    };
  }
  if (ownerUser !== runtimeUser) {
    mergeAgentLifecycleLog(logger, 'merge_agent.tear_down_skipped', {
      lrq: runStatus.launchRequestId || null,
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: 'hq-owner-mismatch',
      hq_root: hqRoot,
      hq_owner_user: ownerUser,
      runtime_user: runtimeUser,
      at: now,
    });
    return {
      decision: 'deferred',
      reason: 'hq-owner-mismatch',
      originalWorkerId,
      workerStatus: runStatus.status || null,
      launchRequestId: runStatus.launchRequestId || null,
    };
  }

  const args = ['worker', 'tear-down', originalWorkerId, '--force', '--root', hqRoot];
  const tearDownTimeoutMs = resolveHqWorkerTearDownTimeoutMs(env);
  try {
    await execFileImpl(hqPath, args, {
      env,
      maxBuffer: 5 * 1024 * 1024,
      timeout: tearDownTimeoutMs,
      killSignal: 'SIGTERM',
    });
  } catch (err) {
    const timedOut = isExecTimeout(err);
    mergeAgentLifecycleLog(logger, timedOut ? 'merge_agent.tear_down_timeout' : 'merge_agent.tear_down_failed', {
      lrq: runStatus.launchRequestId || null,
      original_worker_id: originalWorkerId,
      pr_number: job?.prNumber ?? null,
      reason: timedOut ? 'tear-down-timeout' : 'tear-down-command-failed',
      worker_status: runStatus.status || null,
      stderr: String(err?.stderr ?? '').trim() || null,
      stdout: String(err?.stdout ?? '').trim() || null,
      timeout_ms: timedOut ? tearDownTimeoutMs : null,
      at: now,
    });
    throw formatExecFailure('hq worker tear-down', err);
  }
  mergeAgentLifecycleLog(logger, 'merge_agent.original_worker_torn_down', {
    lrq: runStatus.launchRequestId || null,
    original_worker_id: originalWorkerId,
    pr_number: job?.prNumber ?? null,
    worker_status: runStatus.status || null,
    at: now,
  });
  return {
    decision: 'torn-down',
    originalWorkerId,
    workerStatus: runStatus.status || null,
    launchRequestId: runStatus.launchRequestId || null,
  };
}

export {
  prepareOriginalWorkerForMergeAgent,
};
