import { execFile, spawnSync } from 'node:child_process';
import {
  constants as fsConstants,
  accessSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic-write.mjs';
import {
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { getFollowUpJobDir, listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';
import { extractReviewVerdict, normalizeReviewVerdict } from './review-verdict.mjs';

const execFileAsync = promisify(execFile);

const MERGE_AGENT_DISPATCH_SCHEMA_VERSION = 1;
const MERGE_AGENT_LIFECYCLE_CLEANUP_SCHEMA_VERSION = 1;
const OPERATOR_SKIP_LABELS = new Set(['merge-agent-skip', 'merge-agent-stuck', 'do-not-merge']);
const DEFAULT_HQ_PATH = 'hq';
const HQ_WORKER_TEAR_DOWN_TIMEOUT_MS = 60_000;
const HQ_DISPATCH_TIMEOUT_MS = 90_000;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKER_ID_CLASS_PREFIXES = [
  'claude-code',
  'clio-agent',
  'merge-agent',
  'codex',
  'gemini',
  'pi',
  'stub',
];
// Must stay aligned with platform/session-ledger/src/session_ledger/models.py
// WORKER_RUN_TERMINAL_STATUSES. Merge-agent preflight may tear down the
// original worker ONLY after the canonical ledger marks the run terminal.
const TERMINAL_WORKER_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const DEFERRED_LOOKUP_FAILURE_REASONS = new Set([
  'missing-ledger-db',
  'better-sqlite3-unavailable',
  'worker-run-lookup-failed',
  'worker-run-lookup-threw',
  'missing-launch-request-id',
]);
// `operator-approved` is a mobile-friendly override the operator can
// apply from the GitHub iOS/Android app (or the web UI) to say
// "I approve merging this current PR head now; do not wait for the
// adversarial-review/remediation loop to converge." This is the
// escape valve when automation is still reviewing, pending, or
// overcautious but the operator has decided manually.
//
// The label overrides review/remediation-state gates. It does NOT
// override:
//   - `not-mergeable` (force-merging a conflicted PR is ~always wrong)
//   - `checks-failed` / `checks-pending` (CI is a hard gate)
//   - `merge-agent-skip` / `merge-agent-stuck` / `do-not-merge`
//     (those signal "do not dispatch merge-agent now"; if both are
//     present, skip wins)
//   - `pr-not-open` / `merged` (trivially N/A)
const DEFAULT_MERGE_AGENT_PARENT_SESSION = 'session:adversarial-review:watcher';
const DEFAULT_MERGE_AGENT_PROJECT = 'pr-merge-orchestration';
const SUCCESSFUL_CHECK_STATES = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_CHECK_STATES = new Set(['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', 'REQUESTED']);

// Final-pass-on-request-changes is the opt-in escape valve for the
// convergence-loop deadlock observed on 2026-05-14: when the reviewer
// keeps returning Request changes and the round budget exhausts before
// any verdict turns clean, every PR halts and waits for the operator.
// With this flag enabled, the merge-agent is dispatched anyway once
// remediationCurrentRound >= remediationMaxRounds, on the explicit
// design assumption that the merge-agent's own comment_only_followups
// sub-worker is the right place to triage final reviewer findings
// (apply if trivial, defer if non-trivial, refuse to merge if a
// blocker-class issue is still standing).
//
// DEFAULT: ON. The legacy "halt at max-rounds-reached + Request changes"
// behavior strands every PR at the operator's desk and grinds the
// pipeline to a halt — see operator reports on PRs #426 (2026-05-14) and
// #504 (2026-05-16). The remediation worker's job is to remediate, not
// to be the gate that decides whether a PR can merge; the merge-agent +
// comment_only_followups sub-worker are the right place for the final
// substance triage, with the universal hard gates (failing CI,
// non-mergeable state, blocker-class findings, hard-skip labels) still
// applying as the safety floor.
//
// The env var stays as an explicit off-switch for operators who want
// the legacy halt behavior (e.g., OSS deployments without a configured
// merge-agent backend). Set MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES=0
// to disable.
const FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER = 'final-pass-on-budget-exhausted';
const FINAL_PASS_ON_REQUEST_CHANGES_ENV = 'MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES';

function isFinalPassOnRequestChangesEnabled({
  env = process.env,
  logger = console,
} = {}) {
  const raw = env?.[FINAL_PASS_ON_REQUEST_CHANGES_ENV];
  if (raw == null) return true; // unset → default ON
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === '') return true; // empty → default ON
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  // Unknown value: fail-CLOSED. A typo'd env should not silently broaden
  // merge authority. Operators see a hard-log line they can grep for
  // when triaging unexpected halt behavior.
  if (logger && typeof logger.warn === 'function') {
    logger.warn(
      `[merge-agent] ${FINAL_PASS_ON_REQUEST_CHANGES_ENV}=${JSON.stringify(raw)} `
      + 'is not a recognized boolean (use 1/true/yes or 0/false/no); '
      + 'falling back to OFF (legacy halt-at-max-rounds-reached behavior). '
      + 'Unset the env var to use the default-ON behavior.'
    );
  }
  return false;
}

function isoNow() {
  return new Date().toISOString();
}

function mergeAgentLifecycleLog(logger, event, fields = {}) {
  const sink = logger && typeof logger.info === 'function'
    ? logger.info.bind(logger)
    : console.log.bind(console);
  sink(JSON.stringify({ event, ...fields }));
}

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

function resolveHqRoot(env = {}) {
  const root = String(env.HQ_ROOT || '').trim();
  return root || null;
}

function resolveHqOwner(hqRoot) {
  if (!hqRoot) return null;
  const config = readJsonFileDetailed(join(hqRoot, '.hq', 'config.json'));
  if (!config.ok) {
    return {
      ownerUser: null,
      reason: 'hq-owner-unknown',
      detail: config.error?.message || String(config.error),
      code: config.error?.code || null,
    };
  }
  const ownerUser = String(config.value?.ownerUser || '').trim();
  if (!ownerUser) {
    return {
      ownerUser: null,
      reason: 'hq-owner-unknown',
      detail: 'ownerUser missing from .hq/config.json',
      code: null,
    };
  }
  return {
    ownerUser,
    reason: null,
    detail: null,
    code: null,
  };
}

function currentUser(env = process.env) {
  const explicit = String(env.USER || env.LOGNAME || '').trim();
  if (explicit) return explicit;
  try {
    return userInfo().username;
  } catch {
    return null;
  }
}

function isTerminalWorkerRunStatus(status) {
  const normalized = normalizeWorkerRunStatus(status);
  return Boolean(normalized) && TERMINAL_WORKER_RUN_STATUSES.has(normalized);
}

function formatExecFailure(command, err) {
  const stderrText = String(err?.stderr ?? '').trim();
  const stdoutText = String(err?.stdout ?? '').trim();
  const augmented = new Error(
    `${command} failed (exit code ${err?.code ?? 'unknown'}): ${err?.message || 'no message'}` +
    (stderrText ? `\n  stderr:\n${stderrText.split('\n').map(l => `    ${l}`).join('\n')}` : '') +
    (stdoutText ? `\n  stdout:\n${stdoutText.split('\n').map(l => `    ${l}`).join('\n')}` : '')
  );
  augmented.code = err?.code;
  augmented.stderr = err?.stderr;
  augmented.stdout = err?.stdout;
  augmented.cause = err;
  return augmented;
}

function isExecTimeout(err) {
  return err?.code === 'ETIMEDOUT'
    || err?.killed === true
    || String(err?.message || '').toLowerCase().includes('timed out');
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

function resolveSessionLedgerDbPath({ hqRoot, env = {} } = {}) {
  if (env.AGENT_OS_SESSION_LEDGER_DB_PATH) {
    return String(env.AGENT_OS_SESSION_LEDGER_DB_PATH);
  }
  const config = readJsonFileDetailed(join(hqRoot, '.hq', 'config.json'));
  if (config.ok && config.value?.ledgerDbPath) {
    return String(config.value.ledgerDbPath);
  }
  // The dispatch daemon (cwp_dispatch.daemon) writes worker_runs into the
  // REPO-ROOTED DB under the deploy checkout
  // (<deploy>/.agent-os/session-ledger/ledger.db). The MANAGED-SERVICE-ROOT
  // DB at $HOME/.agent-os/session-ledger/ledger.db is updated by a separate
  // service-refresh loop and lags (or stops entirely if that LaunchAgent
  // wedges). The merge-agent MUST read from the deploy-checkout DB, otherwise
  // a stale snapshot causes false `original-worker-run-row-missing-but-
  // worktree-present` deferrals for every newly-provisioned worker.
  // See CLAUDE.md §"Session Ledger — Data paths — two roots, on purpose".
  const candidates = [];
  const hqRootOwnerHome = String(hqRoot || '').match(/^\/Users\/([^/]+)/)?.[1];
  const deployCheckoutEnv = String(env.AGENT_OS_DEPLOY_CHECKOUT || '').trim();
  if (deployCheckoutEnv) {
    candidates.push(join(deployCheckoutEnv, '.agent-os', 'session-ledger', 'ledger.db'));
  }
  if (hqRootOwnerHome) {
    // Convention: the deploy checkout is the sibling of agent-os-hq under
    // the hq owner's home (/Users/<owner>/agent-os/). This is the daemon's
    // canonical write target.
    candidates.push(join('/Users', hqRootOwnerHome, 'agent-os', '.agent-os', 'session-ledger', 'ledger.db'));
  }
  if (hqRootOwnerHome) {
    // Fallback: managed-service-root DB. Kept for back-compat but lower
    // priority than the deploy-checkout DB above for the reasons above.
    candidates.push(join('/Users', hqRootOwnerHome, '.agent-os', 'session-ledger', 'ledger.db'));
  }
  const runtimeHome = String(env.HOME || '').trim();
  if (runtimeHome) {
    candidates.push(join(runtimeHome, '.agent-os', 'session-ledger', 'ledger.db'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function normalizeWorkerRunStatus(status) {
  return String(status || '').trim().toLowerCase();
}

async function lookupOriginalWorkerRunStatus({
  workerDir,
  hqRoot,
  env,
  workspace = undefined,
  runRecord = undefined,
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

  const dbPath = resolveSessionLedgerDbPath({ hqRoot, env });
  if (!dbPath || !existsSync(dbPath)) {
    return { found: false, reason: 'missing-ledger-db', launchRequestId, runId };
  }

  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch (err) {
    return {
      found: false,
      reason: 'better-sqlite3-unavailable',
      detail: err?.message || String(err),
      launchRequestId,
      runId,
    };
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`
      SELECT run_id, launch_request_id, status
      FROM worker_runs
      WHERE launch_request_id = @launchRequestId
      ORDER BY rowid DESC
      LIMIT 1
    `).get({ launchRequestId });
    if (!row) {
      return { found: false, reason: 'missing-worker-run-row', launchRequestId, runId };
    }
    return {
      found: true,
      status: normalizeWorkerRunStatus(row.status),
      launchRequestId: row.launch_request_id || launchRequestId || null,
      runId: row.run_id || runId || null,
    };
  } catch (err) {
    return {
      found: false,
      reason: 'worker-run-lookup-failed',
      detail: err?.message || String(err),
      launchRequestId,
      runId,
    };
  } finally {
    if (db) db.close();
  }
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
  const workerDir = join(hqRoot, 'workers', originalWorkerId);
  const workspaceState = readWorkerWorkspace(workerDir);
  const workspace = workspaceState.workspace || null;
  const workspacePath = workspace?.workspacePath || workspace?.worktreePath || null;
  const run = readJsonFileDetailed(join(workerDir, 'run.json'));
  const runRecord = run.ok ? run.value : null;

  if (!existsSync(workerDir) || (workspaceState.found && workspacePath && !existsSync(workspacePath))) {
    return {
      decision: 'ready',
      reason: 'original-worker-already-torn-down',
      originalWorkerId,
      hqRoot,
    };
  }
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
      workerDir,
      hqRoot,
      env,
      job,
      originalWorkerId,
      workspace,
      runRecord,
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
  try {
    await execFileImpl(hqPath, args, {
      env,
      maxBuffer: 5 * 1024 * 1024,
      timeout: HQ_WORKER_TEAR_DOWN_TIMEOUT_MS,
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
      timeout_ms: timedOut ? HQ_WORKER_TEAR_DOWN_TIMEOUT_MS : null,
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

// Detect whether agent-os (the host OS that provides the `hq` worker-pool
// CLI + the merge-agent adapter) is present on this machine. The
// follow-up-merge-agent dispatch path is the only flow in adversarial-review
// that requires agent-os; everything else (watcher, reviewer, remediation)
// works standalone. So when agent-os is missing — OSS installs, fresh
// clones, CI sandboxes — we cleanly skip the merge-agent dispatch instead
// of blowing up on an ENOENT from `hq`.
//
// Detection order:
//   1. Explicit operator opt-out via `ADV_REVIEW_MERGE_AGENT_DISABLED=1`
//      (lets the operator force OSS mode even on a machine that has hq).
//   2. Explicit operator opt-in via `ADV_REVIEW_MERGE_AGENT_AGENT_OS=1`
//      (escape hatch for environments where detection misfires).
//   3. Explicit `hqPath` argument, when it is not the default `'hq'`.
//   4. `HQ_BIN` env var points to an existing file.
//   5. `hqPath` (defaults to `'hq'`) resolves on PATH.
// We resolve PATH in-process instead of spawning hq itself because hq can be
// slow to cold-start and we run this on every watcher tick.
function isExecutableFile(candidatePath, {
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  if (!candidatePath) return false;
  const stat = fsImpl.statSync;
  if (typeof stat === 'function') {
    try {
      if (!stat(candidatePath).isFile()) return false;
    } catch {
      return false;
    }
  }
  if (typeof fsImpl.accessSync === 'function') {
    try {
      fsImpl.accessSync(candidatePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return Boolean(fsImpl.existsSync?.(candidatePath));
}

function resolveExecutableOnPath(command, {
  env = process.env,
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return isExecutableFile(trimmed, { fsImpl }) ? trimmed : null;
  }
  const pathEntries = String(env.PATH ?? '').split(delimiter);
  for (const entry of pathEntries) {
    if (!entry) continue;
    const candidate = join(entry, trimmed);
    if (isExecutableFile(candidate, { fsImpl })) {
      return candidate;
    }
  }
  return null;
}

function detectAgentOsPresence({
  env = process.env,
  hqPath = DEFAULT_HQ_PATH,
  fsImpl = { accessSync, existsSync, statSync },
} = {}) {
  if (String(env.ADV_REVIEW_MERGE_AGENT_DISABLED ?? '').trim() === '1') {
    return { present: false, source: 'operator-disabled' };
  }
  if (String(env.ADV_REVIEW_MERGE_AGENT_AGENT_OS ?? '').trim() === '1') {
    return { present: true, source: 'operator-enabled' };
  }
  const trimmedHqPath = String(hqPath ?? '').trim();
  if (trimmedHqPath && trimmedHqPath !== DEFAULT_HQ_PATH) {
    const resolved = resolveExecutableOnPath(trimmedHqPath, { env, fsImpl });
    if (resolved) {
      return { present: true, source: 'arg:hqPath', path: resolved };
    }
    return { present: false, source: 'not-found' };
  }
  const hqBin = String(env.HQ_BIN ?? '').trim();
  if (hqBin && isExecutableFile(hqBin, { fsImpl })) {
    return { present: true, source: 'env:HQ_BIN', path: hqBin };
  }
  const resolved = resolveExecutableOnPath(trimmedHqPath || DEFAULT_HQ_PATH, { env, fsImpl });
  if (resolved) {
    return { present: true, source: 'path', path: resolved };
  }
  return { present: false, source: 'not-found' };
}

function resolveMergeAgentParentSession(env = process.env) {
  return (
    env.MERGE_AGENT_PARENT_SESSION ||
    env.HQ_PARENT_SESSION ||
    env.AGENT_SESSION_REF ||
    DEFAULT_MERGE_AGENT_PARENT_SESSION
  );
}

function resolveMergeAgentProject(env = process.env) {
  return (
    env.MERGE_AGENT_HQ_PROJECT ||
    env.HQ_PROJECT ||
    DEFAULT_MERGE_AGENT_PROJECT
  );
}

function normalizeLabelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label) => {
      if (typeof label === 'string') return label.trim().toLowerCase();
      if (typeof label?.name === 'string') return label.name.trim().toLowerCase();
      return '';
    })
    .filter(Boolean);
}

function normalizeLogin(value) {
  return String(value ?? '').trim().toLowerCase();
}

function extractOperatorNotes(prBody) {
  const text = String(prBody ?? '').trim();
  if (!text) return null;
  return [
    'BEGIN UNTRUSTED PR BODY NOTES',
    text.slice(0, 2_000),
    'END UNTRUSTED PR BODY NOTES',
  ].join('\n');
}

function summarizeChecksConclusion(statusCheckRollup) {
  if (!Array.isArray(statusCheckRollup)) {
    return null;
  }
  if (statusCheckRollup.length === 0) {
    return 'SUCCESS';
  }

  let sawPending = false;
  for (const item of statusCheckRollup) {
    const rawState = String(
      item?.conclusion
      || item?.status
      || item?.state
      || item?.statusCheckRollup?.state
      || ''
    ).trim().toUpperCase();
    if (!rawState) {
      sawPending = true;
      continue;
    }
    if (PENDING_CHECK_STATES.has(rawState)) {
      sawPending = true;
      continue;
    }
    if (SUCCESSFUL_CHECK_STATES.has(rawState)) {
      continue;
    }
    return rawState;
  }

  return sawPending ? 'PENDING' : 'SUCCESS';
}

function mergeAgentDispatchDir(rootDir) {
  return join(getFollowUpJobDir(rootDir, 'pending'), '..', 'merge-agent-dispatches');
}

function mergeAgentSkippedDispatchDir(rootDir) {
  return join(getFollowUpJobDir(rootDir, 'pending'), '..', 'merge-agent-skips');
}

function mergeAgentPromptDir(rootDir) {
  return join(getFollowUpJobDir(rootDir, 'pending'), '..', 'merge-agent-prompts');
}

function mergeAgentLifecycleCleanupDir(rootDir) {
  return join(getFollowUpJobDir(rootDir, 'pending'), '..', 'merge-agent-lifecycle-cleanups');
}

function sanitizeDispatchPathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

function mergeAgentDispatchFilePath(rootDir, job) {
  const safeRepo = sanitizeDispatchPathSegment(String(job?.repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(job?.headSha || 'no-sha'));
  return join(
    mergeAgentDispatchDir(rootDir),
    `${safeRepo}-pr-${Number(job?.prNumber)}-${safeSha}.json`
  );
}

function mergeAgentSkippedDispatchFilePath(rootDir, job) {
  const safeRepo = sanitizeDispatchPathSegment(String(job?.repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(job?.headSha || 'no-sha'));
  return join(
    mergeAgentSkippedDispatchDir(rootDir),
    `${safeRepo}-pr-${Number(job?.prNumber)}-${safeSha}.json`
  );
}

function mergeAgentLifecycleCleanupFilePath(rootDir, { repo, prNumber } = {}) {
  const safeRepo = sanitizeDispatchPathSegment(String(repo ?? '').replace(/\//g, '__'));
  return join(
    mergeAgentLifecycleCleanupDir(rootDir),
    `${safeRepo}-pr-${Number(prNumber)}.json`
  );
}

function dispatchMatchesFilter(dispatch, { repo = null, prNumber = null } = {}) {
  if (repo && dispatch?.repo !== repo) return false;
  if (prNumber != null && Number(dispatch?.prNumber) !== Number(prNumber)) return false;
  return true;
}

function listMergeAgentDispatches(rootDir, filter = {}) {
  const dir = mergeAgentDispatchDir(rootDir);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, name), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((dispatch) => dispatchMatchesFilter(dispatch, filter));
  } catch {
    return [];
  }
}

function listMergeAgentSkippedDispatches(rootDir) {
  const dir = mergeAgentSkippedDispatchDir(rootDir);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, name), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listMergeAgentLifecycleCleanups(rootDir) {
  const dir = mergeAgentLifecycleCleanupDir(rootDir);
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(join(dir, name), 'utf8'));
        } catch (err) {
          console.warn(
            `[follow-up-merge-agent] malformed merge-agent lifecycle cleanup record ignored: ${join(dir, name)}: ${err?.message || err}`
          );
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isUnresolvedMergeAgentLifecycleCleanup(cleanup) {
  if (!cleanup) return false;
  if (cleanup.completedAt) return false;
  if (cleanup.lastResult?.cleanupComplete === true) return false;
  return true;
}

function getRecordedMergeAgentDispatch(rootDir, job) {
  try {
    return JSON.parse(readFileSync(mergeAgentDispatchFilePath(rootDir, job), 'utf8'));
  } catch {
    return null;
  }
}

function getRecordedMergeAgentDispatchForHead(rootDir, {
  repo,
  prNumber,
  headSha,
} = {}) {
  if (!repo || prNumber == null || !headSha) return null;
  return getRecordedMergeAgentDispatch(rootDir, { repo, prNumber, headSha });
}

// LRQ identifiers come from the agent-os dispatch daemon and have the
// shape `lrq_<8>-<4>-<4>-<4>-<12>` (UUID after the prefix). The watcher
// runs as a long-lived operator daemon with broad fs access, so we
// MUST regex-validate any LRQ before interpolating it into a path —
// otherwise a malformed or attacker-controlled launchRequestId in a
// dispatch record would let the watcher act as an arbitrary file
// reader. Pattern is intentionally narrow: lowercase hex segments only.
const LRQ_ID_PATTERN = /^lrq_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function _isValidLrqId(value) {
  return typeof value === 'string' && LRQ_ID_PATTERN.test(value);
}

// Threshold below which a recorded dispatch is considered "still
// reasonably booting" — under this we don't classify it as stuck even
// if its LRQ shows pre-spawn. Tuned with operator (2026-05-18) at 10
// minutes; codex workers + warm starts can take a few minutes legitimately,
// so a tighter threshold would false-positive.
const STUCK_DISPATCH_MIN_AGE_MINUTES = 10;
// Minimum count of audit refusals before we classify as stuck. Under
// this and we treat the dispatch as in-flight (the daemon may have
// admitted it on first try; the LRQ status read could just be lagging).
const STUCK_DISPATCH_MIN_REFUSALS = 3;

// EXPORT THESE for ad-hoc operator tooling + tests. They are intentional
// public knobs.
const STUCK_DISPATCH_DEFAULTS = Object.freeze({
  minAgeMinutes: STUCK_DISPATCH_MIN_AGE_MINUTES,
  minRefusals: STUCK_DISPATCH_MIN_REFUSALS,
});

function _safeReadJsonLines(path, fsImpl) {
  try {
    const text = fsImpl.readFileSync(path, 'utf8');
    return text.split('\n').filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

function _utcDateString(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Classifies a recorded merge-agent dispatch as "stuck pre-spawn" when
 * the dispatch daemon has been refusing to admit it for long enough
 * that an operator should know.
 *
 * Returns null when:
 *   - hqRoot is not provided / not readable (OSS standalone case;
 *     this is intentional — outside the agent-os bundled environment
 *     we cannot observe the dispatch daemon's audit log, so we MUST
 *     fail closed and never claim stuck.)
 *   - recorded dispatch is younger than minAgeMinutes (still booting)
 *   - fewer than minRefusals audit-recorded admit refusals (in-flight)
 *   - audit files missing (treated as no signal — caller can act on
 *     other surfaces but we don't fabricate a classification)
 *
 * Returns { stuckForMinutes, refusalCount, primaryReason, lastRefusedAt }
 * when the signals indicate the spawn never happened.
 *
 * Pure-ish: optional `fsImpl` / `now` make this fully testable without
 * touching the real filesystem or clock.
 */
// Authoritative HQ status tokens that mean the dispatch has reached a
// terminal state OR is actively running. If the dispatch reports any
// of these, refusal history is irrelevant — the LRQ was admitted at
// some point, refusals are just earlier-in-history attempts. Without
// this check the helper would mislabel healthy in-flight dispatches
// as BLOCKED forever once historical refusals exist in the audit log.
const _NON_STUCK_DISPATCH_STATUSES = new Set([
  // terminal — request finished one way or the other
  'succeeded',
  'failed',
  'cancelled',
  'canceled',
  'superseded',
  // actively progressing — admission already happened
  'running',
  'starting',
  // intentional non-progress, but admission did happen
  'blocked',
  'stalled',
]);

// Synchronous probe of `hq dispatch status <lrq>` — returns
// `{status: <string>}` or `null` on any failure (no hqPath, non-zero
// exit, malformed JSON, timeout). Used by the caller in
// dispatchMergeAgentForPR to wire describeStaleDispatch's
// dispatchStateProbe so the round-2 reviewer's blocking finding is
// closed: historical refusal audit rows must NOT promote to BLOCKED
// when the same LRQ is currently running / succeeded.
//
// Returning null on any failure is intentional: describeStaleDispatch
// falls through to refusal-count-only classification (the OSS-safe
// behavior); a probe failure should not change the OSS contract.
//
// Timeout: 5 seconds. `hq dispatch status` should be <200ms in a
// healthy state; a long wait usually means the daemon is wedged on
// the very SQLite lock we're trying to diagnose. We do NOT want this
// probe to block the watcher loop on the daemon's recovery — cap and
// fall through.
function _probeDispatchStatusViaHq({ hqPath, lrq, execFileImpl, env = {} } = {}) {
  if (!hqPath || !_isValidLrqId(lrq)) return null;
  // The probe is synchronous (describeStaleDispatch treats the return
  // value as a plain object, not a promise). spawnSync is the right
  // tool — execFileImpl from the outer scope is async.
  let result;
  try {
    result = spawnSync(hqPath, ['dispatch', 'status', lrq], {
      env: { ...env },
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0) return null;
  const stdout = String(result.stdout || '').trim();
  if (!stdout) return null;
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const status = typeof parsed.status === 'string' ? parsed.status : null;
  return status ? { status } : null;
}

function describeStaleDispatch(recordedDispatch, {
  hqRoot = null,
  now = Date.now(),
  fsImpl = { readFileSync },
  minAgeMinutes = STUCK_DISPATCH_MIN_AGE_MINUTES,
  minRefusals = STUCK_DISPATCH_MIN_REFUSALS,
  // Optional caller-supplied probe of current dispatch state. When
  // provided AND the returned status is in _NON_STUCK_DISPATCH_STATUSES,
  // we return null (the request was admitted at some point — refusal
  // history is just earlier attempts). When omitted, we fall back to
  // refusal-count-only classification (safe for OSS standalone where
  // no probe is available, but in agent-os contexts callers SHOULD
  // pass the probe to avoid false-positive BLOCKED on healthy dispatches).
  dispatchStateProbe = null,
} = {}) {
  if (!recordedDispatch || !recordedDispatch.dispatchedAt) return null;
  if (!hqRoot) return null;
  const dispatchedAtMs = Date.parse(String(recordedDispatch.dispatchedAt));
  if (!Number.isFinite(dispatchedAtMs)) return null;
  const ageMinutes = (now - dispatchedAtMs) / 60_000;
  if (ageMinutes < minAgeMinutes) return null;
  const lrq = recordedDispatch.launchRequestId;
  if (!_isValidLrqId(lrq)) return null;

  // Live-state check (round-1 reviewer's blocking finding): if a probe
  // is available AND the dispatch is in a non-stuck state, return null
  // immediately. Refusal history alone is not authoritative because
  // earlier refusals can predate a successful later admit.
  if (typeof dispatchStateProbe === 'function') {
    let probed = null;
    try { probed = dispatchStateProbe(lrq); } catch { probed = null; }
    const probedStatus = typeof probed?.status === 'string' ? probed.status.toLowerCase() : null;
    if (probedStatus && _NON_STUCK_DISPATCH_STATUSES.has(probedStatus)) {
      return null;
    }
  }

  // Audit logs are UTC-keyed (see modules/worker-pool .../daemon.py
  // _append_dispatch_audit_jsonl, and the 2026-05-18 incident docs).
  // A dispatch could have started yesterday-UTC and still be queued
  // today-UTC, so scan both. Don't use $(date +%Y-%m-%d) — local time
  // misses events at the day boundary; this trap previously hid 1621
  // memory-pressure events from operator visibility.
  const todayUtc = _utcDateString(now);
  const yesterdayUtc = _utcDateString(now - 86_400_000);
  const dates = todayUtc === yesterdayUtc ? [todayUtc] : [yesterdayUtc, todayUtc];

  const refusals = [];
  for (const date of dates) {
    const path = join(hqRoot, 'dispatch', 'audit', date, `${lrq}.jsonl`);
    const lines = _safeReadJsonLines(path, fsImpl);
    if (!lines) continue;
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (typeof event?.decision === 'string' && event.decision.startsWith('refuse_')) {
          refusals.push(event);
        }
      } catch {
        // Skip malformed lines silently — audit log integrity is
        // tracked elsewhere; we don't want to crash the watcher loop
        // over one corrupt line.
      }
    }
  }
  if (refusals.length < minRefusals) return null;

  // Reason-code histogram: which refusal cause is dominating?
  const counts = new Map();
  for (const event of refusals) {
    const structured = Array.isArray(event?.structuredReasons) ? event.structuredReasons : [];
    for (const r of structured) {
      const code = (r && typeof r.reasonCode === 'string') ? r.reasonCode : 'unknown';
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  let primaryReason = null;
  let primaryCount = -1;
  for (const [code, n] of counts) {
    if (n > primaryCount) {
      primaryReason = code;
      primaryCount = n;
    }
  }

  return {
    // Include the LRQ so the Sentinel alert path in watcher.mjs can
    // key on it directly. Round-2 review finding: the alert was
    // reaching back through `dispatched.recordedDispatch.launchRequestId`
    // / `dispatched.launchRequestId`, neither of which the dispatch
    // result carried — so the alert payload had `launchRequestId: null`
    // and the debounce key collapsed to a `repo-pr-no-lrq` slot.
    // Surfacing the LRQ on stuckDetail itself is the single source of
    // truth — alert + log + debounce all read from one place.
    launchRequestId: lrq,
    stuckForMinutes: Math.round(ageMinutes),
    refusalCount: refusals.length,
    primaryReason,
    lastRefusedAt: refusals[refusals.length - 1]?.createdAt || null,
  };
}

// Proactive stuck-merge-agent scan — independent of PR revisit timing.
//
// Background: the existing stuck-detection (describeStaleDispatch + the
// 30-min Sentinel alert in watcher.mjs::maybeFireMergeAgentStuckAlert)
// only runs when the watcher polls a PR AND the dispatch path returns
// `decision: 'skip-already-dispatched'`. If the watcher misses a tick
// window (e.g., the PR was visited at T+25min, and the next visit is
// at T+40min but the LRQ admitted at T+33min), the alert window closes
// without firing.
//
// PR #719 hit exactly this: 33-minute admit delay due to memory pressure,
// no stuck-alert ever logged, operator only discovered it via manual
// review of `data/follow-up-jobs/merge-agent-dispatches/`. CLAUDE.md
// memory `LAC-648` covers the related rate-limit cascade.
//
// This scan classifies only PRs still active in the merge-agent
// lifecycle: ones whose current GitHub snapshot still carries the
// watcher-owned `merge-agent-dispatched` label, plus any durable
// lifecycle-cleanup records that have not converged yet. Historical
// dispatch records for unrelated/completed PRs are ignored even if they
// still carry old refusal audit rows.
//
// We intentionally do NOT live-probe `hq dispatch status` here. The
// proactive path runs inside the watcher loop, so serial `spawnSync`
// fan-out would turn a degraded HQ/SQLite state into minutes of blocked
// event-loop time. This path therefore relies only on the durable audit
// log for a bounded set of known-active PRs.
function scanStuckMergeAgentDispatches({
  rootDir,
  repo = null,
  hqRoot = resolveHqRoot(process.env),
  activePRs = [],
  now = Date.now(),
  minAgeMinutes = STUCK_DISPATCH_MIN_AGE_MINUTES,
  minRefusals = STUCK_DISPATCH_MIN_REFUSALS,
  hqPath = null,
  runtimeEnv = process.env,
  dispatchStateProbe = null,
  listLifecycleCleanupsImpl = listMergeAgentLifecycleCleanups,
} = {}) {
  if (!hqRoot) return [];
  const eligibleHeadsByKey = new Map();
  for (const activePR of activePRs) {
    if (!activePR?.repo || activePR?.prNumber == null || !activePR?.headSha) continue;
    if (repo && activePR.repo !== repo) continue;
    eligibleHeadsByKey.set(
      `${activePR.repo}#${Number(activePR.prNumber)}`,
      {
        repo: activePR.repo,
        prNumber: Number(activePR.prNumber),
        headSha: activePR.headSha,
      }
    );
  }
  let lifecycleCleanups = [];
  try {
    lifecycleCleanups = listLifecycleCleanupsImpl(rootDir);
  } catch {
    lifecycleCleanups = [];
  }
  for (const cleanup of lifecycleCleanups) {
    if (!isUnresolvedMergeAgentLifecycleCleanup(cleanup)) continue;
    if (!cleanup?.repo || cleanup?.prNumber == null || !cleanup?.headSha) continue;
    if (repo && cleanup.repo !== repo) continue;
    const key = `${cleanup.repo}#${Number(cleanup.prNumber)}`;
    if (!eligibleHeadsByKey.has(key)) {
      eligibleHeadsByKey.set(key, {
        repo: cleanup.repo,
        prNumber: Number(cleanup.prNumber),
        headSha: cleanup.headSha,
      });
    }
  }
  if (eligibleHeadsByKey.size === 0) return [];
  const stuckReports = [];
  for (const eligible of eligibleHeadsByKey.values()) {
    const recordedDispatch = getRecordedMergeAgentDispatchForHead(rootDir, eligible);
    if (!recordedDispatch || !recordedDispatch.launchRequestId) continue;
    const stuck = describeStaleDispatch(recordedDispatch, {
      hqRoot,
      now,
      minAgeMinutes,
      minRefusals,
      dispatchStateProbe: dispatchStateProbe || (
        hqPath && _isValidLrqId(recordedDispatch.launchRequestId)
          ? (lrqArg) => _probeDispatchStatusViaHq({
              hqPath,
              lrq: lrqArg,
              env: runtimeEnv,
            })
          : null
      ),
    });
    if (!stuck) continue;
    stuckReports.push({
      repo: recordedDispatch.repo,
      prNumber: recordedDispatch.prNumber,
      launchRequestId: recordedDispatch.launchRequestId,
      dispatchedAt: recordedDispatch.dispatchedAt,
      trigger: recordedDispatch.trigger,
      stuckDetail: stuck,
    });
  }
  return stuckReports;
}

function findLatestFollowUpJobForPR(rootDir, { repo, prNumber }) {
  const keys = ['pending', 'inProgress', 'completed', 'failed', 'stopped'];
  let latest = null;
  let latestTs = '';
  for (const key of keys) {
    for (const entry of listFollowUpJobsInDir(rootDir, key)) {
      const job = entry?.job;
      if (!job) continue;
      if (job.repo !== repo) continue;
      if (Number(job.prNumber) !== Number(prNumber)) continue;
      const ts = job.completedAt || job.failedAt || job.stoppedAt || job.claimedAt || job.createdAt || '';
      if (ts > latestTs) {
        latestTs = ts;
        latest = job;
      }
    }
  }
  return latest;
}

function buildMergeAgentPrompt(job, { trigger = null } = {}) {
  const lines = [
    '# Merge-Agent Dispatch',
    '',
    '## Preamble: abort if PR is no longer open',
    '',
    `Before doing ANY other work, run \`gh pr view ${job.prNumber} --repo ${job.repo} --json state,mergedAt,closedAt\` and inspect the result.`,
    '',
    '- If `state` is `"MERGED"` (operator-merged ahead of you) OR `state` is `"CLOSED"` (operator abandoned the PR): **abort this session immediately**. Do not check out the branch, do not run remediation, do not push commits, do not call `hq` adjudicate. Exit cleanly with a short stdout note like `merge-agent abort: PR state=<X> at session start; no work performed`.',
    '- If `state` is `"OPEN"`: proceed normally with the dispatch below.',
    '',
    'Rationale: the watcher applies the `merge-agent-dispatched` label when it dispatches you and removes it on cancel-on-merge. If you started before the watcher could cancel you (the cancel path is best-effort), this preamble is the second line of defense against wasting budget on a closed PR.',
    '',
    `- Repo: ${job.repo}`,
    `- PR: #${job.prNumber}`,
    `- Branch: ${job.branch}`,
    `- Base: ${job.baseBranch}`,
  ];
  if (job.headSha) {
    lines.push(`- Head SHA: ${job.headSha}`);
  }
  if (trigger) {
    lines.push(`- Dispatch trigger: ${trigger}`);
  }
  if (trigger === FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER) {
    lines.push('');
    lines.push('## Mode: final-pass-on-budget-exhausted');
    lines.push('');
    lines.push(
      'The adversarial-review round budget for this PR is consumed and the'
      + ' latest reviewer verdict is still `Request changes`. You are the'
      + ' final automated pass before operator escalation.'
    );
    lines.push('');
    lines.push('Required behavior:');
    lines.push(
      '1. Run `comment_only_followups.py` (your existing sub-worker triage'
      + ' step) against the latest review body. Apply every actionable'
      + ' in-scope finding inline. Use `suggestions_unable_to_apply` only'
      + ' for findings that genuinely should not be completed inside this'
      + ' PR (multi-PR scope, cross-module refactors, or conflicts with PR'
      + ' intent). For each such follow-up, file a Linear ticket before'
      + ' proceeding; do not leave the work only as prose in a PR comment'
      + ' and do not stop the PR merely because follow-up work exists.'
      + ' Refuse to merge if any blocker-class finding remains (data'
      + ' corruption, secret leakage, security regression, broken external'
      + ' contract). For non-empty'
      + ' `blockers_observed`, the refusal receipt/log summary must include'
      + ' only the blocker count plus normalized blocker kinds. Keep detailed'
      + ' blocker payloads exclusively in the workspace-local'
      + ' `.adversarial-follow-up/followups-reply.json` artifact; never copy'
      + ' blocker summaries, reasoning, quoted secrets, or sample payloads'
      + ' into PR comments, stdout/stderr summaries, or merge receipts.'
    );
    lines.push(
      '2. Proceed to rebase + merge when triage returns'
      + ' `no-followups-needed`, or when triage returns `addressed` after'
      + ' making light-to-medium code/config fixes. For light-to-medium'
      + ' fixes, force-push the updated head, wait for the required checks'
      + ' on that pushed head, then merge; do not request another review.'
      + ' Exit `awaiting-rereview` only when the in-PR fix is a major'
      + ' refactor whose review risk deserves another adversarial pass.'
      + ' If the remaining refactor work belongs across modules or future'
      + ' PRs, file the Linear tickets described above and proceed with this'
      + ' merge instead of using `awaiting-rereview` or stopping the PR.'
      + ' A non-empty `blockers_observed` result must hard-refuse the merge.'
    );
    lines.push(
      '3. Treat this dispatch the same way you would treat an'
      + ' `operator-approved` dispatch for review/remediation state, EXCEPT'
      + ' that the safety floor (no blocker-class merges) is stricter:'
      + ' the operator did not personally vouch for this head.'
    );
  }
  if (job.operatorNotes) {
    lines.push('- Operator notes from PR body:');
    lines.push(job.operatorNotes);
  } else {
    lines.push('- Operator notes from PR body: none');
  }
  return `${lines.join('\n')}\n`;
}

function pickMergeAgentDispatch(job, {
  recentDispatches = [],
  finalPassOnRequestChangesEnabled = isFinalPassOnRequestChangesEnabled(),
} = {}) {
  return pickMergeAgentDispatchDetail(job, {
    recentDispatches,
    finalPassOnRequestChangesEnabled,
  }).decision;
}

function pickMergeAgentDispatchDetail(job, {
  recentDispatches = [],
  finalPassOnRequestChangesEnabled = isFinalPassOnRequestChangesEnabled(),
} = {}) {
  const normalizedVerdict = normalizeReviewVerdict(job?.lastVerdict);
  const labels = new Set(normalizeLabelNames(job?.labels));
  const hasMergeAgentRequestedLabel = labels.has(MERGE_AGENT_REQUESTED_LABEL);
  const mergeAgentRequested = hasMergeAgentRequestedLabel && isScopedMergeAgentRequest(job);
  const hasOperatorApprovedLabel = labels.has(OPERATOR_APPROVED_LABEL);
  const operatorApproved = hasOperatorApprovedLabel && isScopedOperatorApproval(job);
  const alreadyDispatched = recentDispatches.some((entry) => (
    String(entry?.repo ?? '') === String(job?.repo ?? '')
    && Number(entry?.prNumber) === Number(job?.prNumber)
    && String(entry?.headSha ?? '') === String(job?.headSha ?? '')
  ));

  // Hard skips that even an operator override does NOT bypass include
  // closed/merged PRs and explicit do-not-merge labels.
  // `operator-approved` also keeps mergeability/checks as hard gates,
  // but bypasses review/remediation-state gates for the current head.
  // `merge-agent-requested` is different: it asks the merge-agent to
  // clean/rebase the branch, so it can bypass current
  // mergeability/check/verdict gates, but not hard stop labels, active
  // remediation, or duplicate-dispatch protection.
  if (String(job?.prState ?? '').trim().toLowerCase() !== 'open' || Boolean(job?.merged)) {
    return { decision: 'skip-pr-not-open', trigger: null };
  }

  if ([...OPERATOR_SKIP_LABELS].some((label) => labels.has(label))) {
    // Skip-labels win even when approval/request labels are also present.
    return { decision: 'skip-operator-skip', trigger: null };
  }

  if (operatorApproved) {
    const hardGateDecision = pickOperatorApprovedMergeGate(job);
    if (hardGateDecision.decision !== 'dispatch') {
      return hardGateDecision;
    }
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : { decision: 'dispatch', trigger: OPERATOR_APPROVED_LABEL };
  }

  const latestFollowUpJobStatus = String(job?.latestFollowUpJobStatus ?? '').trim().toLowerCase();
  if (latestFollowUpJobStatus === 'pending' || latestFollowUpJobStatus === 'in-progress') {
    return { decision: 'skip-remediation-active', trigger: null };
  }

  const normalDecision = pickNormalMergeAgentDispatchDetail({
    job,
    normalizedVerdict,
    operatorApproved,
    hasOperatorApprovedLabel,
    finalPassOnRequestChangesEnabled,
  });
  if (normalDecision.decision === 'dispatch') {
    const dispatchDecision = !normalDecision.trigger && mergeAgentRequested
      ? { decision: 'dispatch', trigger: MERGE_AGENT_REQUESTED_LABEL }
      : normalDecision;
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : dispatchDecision;
  }

  if (hasMergeAgentRequestedLabel) {
    if (!mergeAgentRequested) {
      return { decision: 'skip-merge-agent-requested-stale', trigger: null };
    }
    return alreadyDispatched
      ? { decision: 'skip-already-dispatched', trigger: null }
      : { decision: 'dispatch', trigger: MERGE_AGENT_REQUESTED_LABEL };
  }

  if (hasOperatorApprovedLabel && !operatorApproved) {
    return { decision: 'skip-operator-approval-stale', trigger: null };
  }

  return normalDecision;
}

function pickOperatorApprovedMergeGate(job) {
  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return { decision: 'skip-not-mergeable', trigger: null };
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === null) {
    return { decision: 'skip-checks-unknown', trigger: null };
  }
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: null };
  }
  if (checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: null };
  }

  return { decision: 'dispatch', trigger: OPERATOR_APPROVED_LABEL };
}

function pickNormalMergeAgentDispatchDetail({
  job,
  normalizedVerdict,
  operatorApproved,
  hasOperatorApprovedLabel,
  finalPassOnRequestChangesEnabled = false,
}) {
  if (normalizedVerdict === null) {
    return { decision: 'skip-no-verdict', trigger: null };
  }
  if (normalizedVerdict === 'unknown') {
    return { decision: 'skip-unknown-verdict', trigger: null };
  }

  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return { decision: 'skip-not-mergeable', trigger: null };
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === null) {
    return { decision: 'skip-checks-unknown', trigger: null };
  }
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: null };
  }
  if (checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: null };
  }

  const remediationCurrentRound = Number(job?.remediationCurrentRound);
  const remediationMaxRounds = Number(job?.remediationMaxRounds);
  if (!Number.isFinite(remediationCurrentRound) || !Number.isFinite(remediationMaxRounds) || remediationMaxRounds <= 0) {
    return { decision: 'skip-remediation-state-unknown', trigger: null };
  } else if (
    remediationCurrentRound < remediationMaxRounds
    && normalizedVerdict === 'request-changes'
  ) {
    // request-changes verdict with budget left → let the remediation
    // loop continue. Merge-agent racing an in-flight remediation cycle
    // would either fight the remediation worker or merge a state the
    // reviewer asked to change.
    //
    // For a comment-only verdict we DO NOT wait for the round cap to
    // exhaust. Clean verdict = nothing to remediate = the pipeline has
    // reached its natural end and merge-agent should pick up now.
    // Previously this gate fired regardless of verdict, which forced
    // unnecessary review passes when round 1 was already clean and
    // contributed to PR #90's stuck state.
    return { decision: 'skip-remediation-claimable', trigger: null };
  }

  // Reaching this point means remediationCurrentRound >= remediationMaxRounds.
  // Verdict is one of: 'comment-only', 'request-changes', plus any normalized
  // verdict the kernel knows about. The legacy behavior was: refuse to
  // dispatch on Request changes once the budget is exhausted unless an
  // operator-approved label was applied. In practice the reviewer almost
  // always returns Request changes on the final round (see follow-up-jobs.mjs
  // notes near LEGACY_DEFAULT_MAX_REMEDIATION_ROUNDS), which means every PR
  // converged to "operator must admin-merge" — the daemon never auto-merged
  // a single PR in the observed window leading up to 2026-05-14.
  //
  // With FINAL_PASS_ON_BUDGET_EXHAUSTED enabled, we let merge-agent take the
  // final pass: it owns the comment_only_followups sub-worker path, which is
  // already designed to triage non-blocking findings (apply if trivial,
  // defer if non-trivial) and refuse to merge when a blocker-class issue
  // is still standing. The trigger value lets the dispatch record and the
  // merge-agent prompt distinguish this from an operator-approved override.
  // Stale or unverifiable operator-approved label always hard-stops,
  // BEFORE the final-pass branch can fire. The label's presence is an
  // operator signal that this PR needed manual review; we will not
  // override that with automation just because the budget is
  // exhausted. The label must be removed/reapplied with valid
  // current-head scope to clear this state. Distinct from
  // skip-request-changes (no label at all) so operators can tell the
  // two failure modes apart in logs.
  if (
    normalizedVerdict === 'request-changes'
    && !operatorApproved
    && hasOperatorApprovedLabel
  ) {
    return { decision: 'skip-operator-approval-stale', trigger: null };
  }

  if (
    normalizedVerdict === 'request-changes'
    && !operatorApproved
    && finalPassOnRequestChangesEnabled
  ) {
    return {
      decision: 'dispatch',
      trigger: FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
    };
  }

  if (normalizedVerdict === 'request-changes' && !operatorApproved) {
    return {
      decision: 'skip-request-changes',
      trigger: null,
    };
  }

  return {
    decision: 'dispatch',
    trigger: normalizedVerdict === 'request-changes' && operatorApproved
      ? OPERATOR_APPROVED_LABEL
      : null,
  };
}

function isScopedOperatorApproval(job) {
  const approval = job?.operatorApproval;
  if (!approval) return false;
  if (!approval.actor || String(approval.actor).trim().toLowerCase() === 'unknown') return false;
  // Self-approval check intentionally removed at single-operator scale; see
  // buildScopedOperatorApproval for the design note. Re-introduce the
  // distinct-actor rule when there is a second human reviewer.
  if (!approval.labelEventId && !approval.labelEventNodeId) return false;
  if (!approval.createdAt) return false;
  if (String(approval.headSha || '') !== String(job?.headSha || '')) return false;
  return true;
}

function isScopedMergeAgentRequest(job) {
  const request = job?.mergeAgentRequest;
  if (!request) return false;
  if (!request.actor || String(request.actor).trim().toLowerCase() === 'unknown') return false;
  if (!request.labelEventId && !request.labelEventNodeId) return false;
  if (!request.createdAt) return false;
  if (String(request.headSha || '') !== String(job?.headSha || '')) return false;
  const prUpdatedAt = request.prUpdatedAt || job?.prUpdatedAt || null;
  if (prUpdatedAt && !isoAtOrAfter(request.createdAt, prUpdatedAt)) return false;
  return true;
}

function isoAtOrAfter(candidate, floor) {
  if (!candidate || !floor) return false;
  const candidateEpoch = Date.parse(candidate);
  const floorEpoch = Date.parse(floor);
  if (Number.isNaN(candidateEpoch) || Number.isNaN(floorEpoch)) return false;
  return candidateEpoch >= floorEpoch;
}

function buildScopedOperatorApproval(candidate, latestJob) {
  const event = candidate?.operatorApprovalEvent;
  if (!event) return null;
  if (!candidate?.headSha) return null;
  // Self-approval check intentionally removed at single-operator scale: every
  // PR is authored by the operator's gh CLI identity (workers push under the
  // operator's GitHub account), so requiring a distinct actor was a 100%
  // false-positive rule and made `operator-approved` non-functional. The
  // headSha + codeScopedAt + commit-timing checks below remain as the real
  // freshness gates. Re-introduce a distinct-actor check when there is a
  // second human reviewer.
  if (String(event.headSha || '') !== String(candidate.headSha || '')) return null;
  if (!event.codeScopedAt || !isoAtOrAfter(event.createdAt, event.codeScopedAt)) return null;
  return {
    actor: event.actor || null,
    createdAt: event.createdAt || null,
    labelEventId: event.id || null,
    labelEventNodeId: event.nodeId || null,
    headSha: event.headSha || null,
    codeScopedAt: event.codeScopedAt || null,
    codeScopeEventId: event.codeScopeEventId || null,
    codeScopeEventKind: event.codeScopeEventKind || null,
  };
}

function buildScopedMergeAgentRequest(candidate) {
  const event = candidate?.mergeAgentRequestEvent;
  if (!event) return null;
  if (!candidate?.headSha) return null;
  if (candidate?.prUpdatedAt && !isoAtOrAfter(event.createdAt, candidate.prUpdatedAt)) return null;
  return {
    actor: event.actor || null,
    createdAt: event.createdAt || null,
    labelEventId: event.id || null,
    labelEventNodeId: event.nodeId || null,
    headSha: candidate.headSha,
    prUpdatedAt: candidate.prUpdatedAt || null,
  };
}

function recordMergeAgentDispatch(rootDir, job, {
  dispatchedAt = isoNow(),
  prompt,
  dispatchId = null,
  launchRequestId = null,
  trigger = null,
  labelRemoval = null,
} = {}) {
  const dir = mergeAgentDispatchDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const filePath = mergeAgentDispatchFilePath(rootDir, job);
  const doc = {
    schemaVersion: MERGE_AGENT_DISPATCH_SCHEMA_VERSION,
    repo: job.repo,
    prNumber: Number(job.prNumber),
    branch: job.branch,
    baseBranch: job.baseBranch,
    headSha: job.headSha || null,
    operatorApproval: job.operatorApproval || null,
    mergeAgentRequest: job.mergeAgentRequest || null,
    trigger,
    labelRemoval,
    dispatchedAt,
    dispatchId,
    launchRequestId,
    prompt,
  };
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return filePath;
}

function recordMergeAgentSkippedDispatch(rootDir, job, {
  skippedAt = isoNow(),
  decision,
  trigger = null,
  agentOsState = null,
  labelRemoval = null,
} = {}) {
  const dir = mergeAgentSkippedDispatchDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const filePath = mergeAgentSkippedDispatchFilePath(rootDir, job);
  const doc = {
    schemaVersion: MERGE_AGENT_DISPATCH_SCHEMA_VERSION,
    repo: job.repo,
    prNumber: Number(job.prNumber),
    branch: job.branch,
    baseBranch: job.baseBranch,
    headSha: job.headSha || null,
    operatorApproval: job.operatorApproval || null,
    mergeAgentRequest: job.mergeAgentRequest || null,
    trigger,
    labelRemoval,
    skippedAt,
    decision,
    agentOsDetectionSource: agentOsState?.source || null,
  };
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return filePath;
}

function updateMergeAgentDispatchLabelRemoval(rootDir, job, {
  recordedDispatch = null,
  trigger,
  attemptedAt,
  removed,
  error = null,
  observedExternally = false,
} = {}) {
  const filePath = mergeAgentDispatchFilePath(rootDir, job);
  const existing = recordedDispatch || getRecordedMergeAgentDispatch(rootDir, job);
  if (!existing) return null;

  const previousAttempts = Array.isArray(existing.labelRemoval?.attempts)
    ? existing.labelRemoval.attempts
    : [];
  const labelRemoval = {
    label: trigger,
    removed: Boolean(removed),
    lastAttemptAt: attemptedAt,
    lastError: removed ? null : error,
    observedExternally: Boolean(observedExternally),
    attempts: [
      ...previousAttempts,
      {
        attemptedAt,
        label: trigger,
        removed: Boolean(removed),
        error: removed ? null : error,
        observedExternally: Boolean(observedExternally),
      },
    ],
  };

  const next = {
    ...existing,
    trigger: existing.trigger || trigger || null,
    labelRemoval,
  };
  writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return filePath;
}

function upsertMergeAgentLifecycleCleanup(rootDir, {
  repo,
  prNumber,
  transition,
  headSha = null,
  queuedAt = isoNow(),
} = {}) {
  const dir = mergeAgentLifecycleCleanupDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const filePath = mergeAgentLifecycleCleanupFilePath(rootDir, { repo, prNumber });
  const existing = readJsonFileDetailed(filePath);
  const previous = existing.ok ? existing.value : null;
  const doc = {
    schemaVersion: MERGE_AGENT_LIFECYCLE_CLEANUP_SCHEMA_VERSION,
    repo,
    prNumber: Number(prNumber),
    transition,
    headSha,
    queuedAt: previous?.queuedAt || queuedAt,
    lastAttemptAt: previous?.lastAttemptAt || null,
    completedAt: previous?.completedAt || null,
    lastResult: previous?.lastResult || null,
  };
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

function updateMergeAgentLifecycleCleanup(rootDir, {
  repo,
  prNumber,
  result,
  attemptedAt = isoNow(),
} = {}) {
  const filePath = mergeAgentLifecycleCleanupFilePath(rootDir, { repo, prNumber });
  const existing = readJsonFileDetailed(filePath);
  const previous = existing.ok ? existing.value : {
    schemaVersion: MERGE_AGENT_LIFECYCLE_CLEANUP_SCHEMA_VERSION,
    repo,
    prNumber: Number(prNumber),
    transition: null,
    headSha: null,
    queuedAt: attemptedAt,
  };
  const next = {
    ...previous,
    lastAttemptAt: attemptedAt,
    completedAt: result?.cleanupComplete ? attemptedAt : null,
    lastResult: result || null,
  };
  writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function clearMergeAgentLifecycleCleanup(rootDir, { repo, prNumber } = {}) {
  const filePath = mergeAgentLifecycleCleanupFilePath(rootDir, { repo, prNumber });
  try {
    rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isTerminalMergeAgentCancelError(detail) {
  // `hq dispatch cancel` emits structured JSON on stdout (not stderr) on
  // already-terminal LRQs:
  //   {"ok":false,"reason":"already terminal (status=failed)","currentStatus":"failed"}
  // The watcher historically only saw err.message ("Command failed: hq
  // dispatch cancel <lrq>") and the regex below did not match "already
  // terminal", so every such cancel attempt logged retryable=true and the
  // operator saw an endless "best-effort cancel … failed" retry loop.
  //
  // Broadening: also match "already terminal" + a few related shapes the
  // hq cancel path can emit. Callers that capture stdout separately should
  // use isTerminalMergeAgentCancelDetail (below) to read the structured
  // JSON path — this regex covers the path where only the wrapped
  // err.message is available.
  return /\balready terminated\b|\balready cancelled\b|\balready terminal\b|\bnot found\b|\bno such\b|\bcurrentStatus":"(failed|succeeded|cancelled|canceled|superseded)"/i
    .test(String(detail || ''));
}

// Structured classifier: when the caller captured stdout from
// `hq dispatch cancel` (cancelStdout on the cancel-result), inspect it
// for the `{ok: false, reason: "already terminal …"}` contract. This is
// the canonical signal — far more reliable than regex-matching err.message.
function isTerminalMergeAgentCancelDetail({ cancelStdout, cancelError } = {}) {
  if (cancelStdout) {
    try {
      const parsed = JSON.parse(String(cancelStdout));
      if (parsed && parsed.ok === false) {
        const reason = String(parsed.reason || '').toLowerCase();
        const currentStatus = String(parsed.currentStatus || '').toLowerCase();
        if (
          /\balready (terminal|terminated|cancelled|canceled|superseded)\b/.test(reason)
          || /\b(failed|succeeded|cancelled|canceled|superseded)\b/.test(currentStatus)
        ) {
          return true;
        }
      }
    } catch {
      // Fall through to regex-based fallback below — stdout wasn't JSON.
    }
  }
  return isTerminalMergeAgentCancelError(cancelError);
}

function isTerminalMergeAgentLabelRemovalError(detail) {
  return /\bHTTP 422\b|\bnot found\b|\bdoes not exist\b/i.test(String(detail || ''));
}

const MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION = 'dispatched-label-add';

async function removeConsumedTriggerLabel({
  repo,
  prNumber,
  labels,
  trigger,
  ghExecFileImpl,
  now,
} = {}) {
  const normalizedLabels = normalizeLabelNames(labels);
  const result = {
    attempted: false,
    operatorApprovalLabelRemoved: false,
    mergeAgentRequestedLabelRemoved: false,
    labelRemovalErrors: [],
  };

  if (!trigger || !normalizedLabels.includes(trigger)) {
    return result;
  }

  result.attempted = true;
  try {
    await ghExecFileImpl('gh', [
      'pr',
      'edit',
      String(prNumber),
      '--repo',
      repo,
      '--remove-label',
      trigger,
    ], { maxBuffer: 5 * 1024 * 1024 });
    if (trigger === OPERATOR_APPROVED_LABEL) {
      result.operatorApprovalLabelRemoved = true;
    }
    if (trigger === MERGE_AGENT_REQUESTED_LABEL) {
      result.mergeAgentRequestedLabelRemoved = true;
    }
  } catch (err) {
    const detail = err?.message || String(err);
    result.labelRemovalErrors.push({ label: trigger, error: detail });
    console.warn(
      `[follow-up-merge-agent] failed to remove consumed label '${trigger}' from ${repo}#${prNumber}: ${detail}`
    );
  }

  result.labelRemovalAttempt = {
    trigger,
    attemptedAt: now,
    removed: result.labelRemovalErrors.length === 0,
    error: result.labelRemovalErrors[0]?.error || null,
  };
  return result;
}

// Best-effort: apply the merge-agent-dispatched label after a successful
// `hq dispatch`. Two purposes: (1) visibility for operators, and (2) the
// watcher uses presence of this label as the lookup key for the cancel-
// on-merge path. A failed add is logged but does not throw — the
// dispatch already happened and we don\'t want to roll it back over a
// transient gh failure.
async function addMergeAgentDispatchedLabel({
  repo,
  prNumber,
  ghExecFileImpl,
  now = isoNow(),
} = {}) {
  const result = {
    attempted: true,
    label: MERGE_AGENT_DISPATCHED_LABEL,
    attemptedAt: now,
    added: false,
    error: null,
  };
  try {
    await ghExecFileImpl('gh', [
      'pr',
      'edit',
      String(prNumber),
      '--repo',
      repo,
      '--add-label',
      MERGE_AGENT_DISPATCHED_LABEL,
    ], { maxBuffer: 5 * 1024 * 1024 });
    result.added = true;
  } catch (err) {
    result.error = err?.message || String(err);
    console.warn(
      `[follow-up-merge-agent] failed to add '${MERGE_AGENT_DISPATCHED_LABEL}' label to ${repo}#${prNumber}: ${result.error}`
    );
  }
  return result;
}

// Best-effort: when the watcher sees a PR has been closed/merged while
// the `merge-agent-dispatched` label is still set, look up the most
// recent merge-agent dispatch record for that PR, call `hq dispatch
// cancel <lrq>` on the in-flight pool worker, and remove the label.
//
// "Best-effort" means: every failure mode is logged but non-fatal — a
// missed cancel just means the worker runs to completion and discovers
// the closed PR via the prompt preamble. Non-terminal cancel/label
// failures are intentionally retryable: the watcher persists cleanup
// work on disk and replays it on later ticks even after the PR leaves
// the open-set query.
async function cancelMergeAgentDispatchOnMerge({
  rootDir,
  repo,
  prNumber,
  hqPath,
  ghExecFileImpl,
  hqExecFileImpl = ghExecFileImpl,
  now = isoNow(),
  listImpl = listMergeAgentDispatches,
} = {}) {
  const result = {
    attempted: true,
    repo,
    prNumber,
    attemptedAt: now,
    launchRequestId: null,
    cancelled: false,
    cancelError: null,
    labelRemoved: false,
    labelRemovalError: null,
    cleanupComplete: false,
    retryable: false,
  };

  // Find the most recent merge-agent dispatch record for this PR. If
  // there\'s none, nothing to cancel — but we still try to remove the
  // label so the durable cleanup record can converge to the desired
  // "no running worker / no marker label" state.
  let dispatches = [];
  try {
    dispatches = listImpl(rootDir, { repo, prNumber });
  } catch (err) {
    result.cancelError = `dispatch lookup failed: ${err?.message || err}`;
  }
  const latest = dispatches
    .filter((d) => d?.launchRequestId)
    .sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')))
    .at(0);
  if (latest) {
    result.launchRequestId = latest.launchRequestId;
    if (hqPath) {
      try {
        await hqExecFileImpl(hqPath, [
          'dispatch',
          'cancel',
          latest.launchRequestId,
        ], { maxBuffer: 5 * 1024 * 1024 });
        result.cancelled = true;
      } catch (err) {
        // Use formatExecFailure so stderr+stdout surface in the
        // log. Without it, every cancel failure logged as the bare
        // exec wrapper text — "Command failed: hq dispatch cancel
        // lrq_…" — with the actual cause invisible. Concrete
        // 2026-05-19 incident: `hq dispatch cancel` for an
        // already-terminal LRQ exits non-zero with the explanation
        // {"ok":false,"reason":"already terminal (status=failed)"}
        // on STDOUT (not stderr). The watcher's retry-loop log then
        // claimed retryable=true indefinitely because the actual
        // contract was never surfaced. Also stash structured
        // stderr/stdout on the result so the terminal-classifier
        // below can read structured output, not just message text.
        const formatted = formatExecFailure('hq dispatch cancel', err);
        result.cancelError = formatted.message;
        result.cancelStderr = err?.stderr ? String(err.stderr) : null;
        result.cancelStdout = err?.stdout ? String(err.stdout) : null;
        console.warn(
          `[follow-up-merge-agent] best-effort cancel of merge-agent dispatch ${latest.launchRequestId} for ${repo}#${prNumber} failed: ${result.cancelError}`
        );
      }
    } else {
      result.cancelError = 'no hqPath provided; skipped cancel';
    }
  }

  const cancelReachedTerminalOutcome = (
    !result.launchRequestId
    || result.cancelled
    || isTerminalMergeAgentCancelDetail({
      cancelStdout: result.cancelStdout,
      cancelError: result.cancelError,
    })
  );

  if (cancelReachedTerminalOutcome) {
    try {
      await ghExecFileImpl('gh', [
        'pr',
        'edit',
        String(prNumber),
        '--repo',
        repo,
        '--remove-label',
        MERGE_AGENT_DISPATCHED_LABEL,
      ], { maxBuffer: 5 * 1024 * 1024 });
      result.labelRemoved = true;
    } catch (err) {
      result.labelRemovalError = err?.message || String(err);
      if (isTerminalMergeAgentLabelRemovalError(result.labelRemovalError)) {
        result.labelRemoved = true;
      } else {
        console.warn(
          `[follow-up-merge-agent] failed to remove '${MERGE_AGENT_DISPATCHED_LABEL}' from ${repo}#${prNumber} after close: ${result.labelRemovalError}`
        );
      }
    }
  }

  result.cleanupComplete = cancelReachedTerminalOutcome && result.labelRemoved;
  result.retryable = !result.cleanupComplete;

  return result;
}

function writeMergeAgentPrompt(rootDir, job, prompt, { dispatchedAt = isoNow() } = {}) {
  const dir = mergeAgentPromptDir(rootDir);
  mkdirSync(dir, { recursive: true });
  const safeRepo = sanitizeDispatchPathSegment(String(job.repo).replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(job.headSha || 'no-sha'));
  const safeTs = sanitizeDispatchPathSegment(String(dispatchedAt));
  const filePath = join(dir, `${safeRepo}-pr-${job.prNumber}-${safeSha}-${safeTs}.md`);
  writeFileSync(filePath, prompt, 'utf8');
  return filePath;
}

function parseMergeAgentDispatchOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) {
    throw new Error('hq dispatch returned empty stdout');
  }

  try {
    return JSON.parse(text);
  } catch {}

  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('{')) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error('hq dispatch did not return machine-readable JSON');
}

async function dispatchMergeAgentForPR({
  rootDir,
  repo,
  prNumber,
  branch,
  baseBranch,
  headSha,
  mergeable,
  checksConclusion,
  labels,
  operatorNotes,
  lastVerdict,
  prState = 'open',
  merged = false,
  prAuthor = null,
  latestFollowUpJobStatus = null,
  remediationCurrentRound = null,
  remediationMaxRounds = null,
  prUpdatedAt = null,
  operatorApproval = null,
  mergeAgentRequest = null,
  execFileImpl = execFileAsync,
  ghExecFileImpl = execFileAsync,
  now = isoNow(),
  hqPath = DEFAULT_HQ_PATH,
  agentOsDetectImpl = detectAgentOsPresence,
  prepareOriginalWorkerImpl = prepareOriginalWorkerForMergeAgent,
  logger = console,
  env = process.env,
} = {}) {
  const runtimeEnv = { ...process.env, ...env };
  const job = {
    repo,
    prNumber,
    branch,
    baseBranch,
    headSha,
    mergeable,
    checksConclusion,
    labels,
    operatorNotes,
    lastVerdict,
    prState,
    merged,
    prAuthor,
    latestFollowUpJobStatus,
    remediationCurrentRound,
    remediationMaxRounds,
    prUpdatedAt,
    operatorApproval,
    mergeAgentRequest,
  };
  const recordedDispatch = getRecordedMergeAgentDispatch(rootDir, job);
  const dispatchDecision = pickMergeAgentDispatchDetail(job, {
    recentDispatches: recordedDispatch ? [recordedDispatch] : [],
    // Honor the merged runtime env so callers can opt-in per-invocation
    // without mutating process.env globally. This keeps the flag consistent
    // with the rest of dispatchMergeAgentForPR (agent-os detection, parent
    // session, project) which already routes through runtimeEnv.
    finalPassOnRequestChangesEnabled: isFinalPassOnRequestChangesEnabled({ env: runtimeEnv }),
  });
  const { decision, trigger } = dispatchDecision;
  if (decision !== 'dispatch') {
    if (decision === 'skip-already-dispatched' && recordedDispatch?.trigger) {
      const labelRemoval = await removeConsumedTriggerLabel({
        repo,
        prNumber,
        labels,
        trigger: recordedDispatch.trigger,
        ghExecFileImpl,
        now,
      });
      if (labelRemoval.attempted) {
        updateMergeAgentDispatchLabelRemoval(rootDir, job, {
          recordedDispatch,
          trigger: recordedDispatch.trigger,
          attemptedAt: labelRemoval.labelRemovalAttempt.attemptedAt,
          removed: labelRemoval.labelRemovalAttempt.removed,
          error: labelRemoval.labelRemovalAttempt.error,
        });
      } else if (
        recordedDispatch.labelRemoval?.removed !== true
        && !normalizeLabelNames(labels).includes(recordedDispatch.trigger)
      ) {
        updateMergeAgentDispatchLabelRemoval(rootDir, job, {
          recordedDispatch,
          trigger: recordedDispatch.trigger,
          attemptedAt: now,
          removed: true,
          observedExternally: true,
        });
      }
      // Probe whether the dispatch is stuck pre-spawn (the daemon has
      // been refusing admission long enough that operator should know).
      // Returns null silently when:
      //   - hqRoot is missing (OSS standalone — no audit log to read)
      //   - dispatch is younger than the min-age threshold (booting)
      //   - audit log shows fewer than min refusals (in-flight)
      //   - live-state probe says the LRQ is now running/succeeded
      // i.e. fails closed for the OSS path, surfaces signal only when
      // operator action is genuinely warranted.
      //
      // ROUND-2 review fixes:
      //
      // (1) hqRoot was being set from `hqPath` which is the `hq`
      //     EXECUTABLE path resolved by detectAgentOsPresence — not
      //     the HQ ROOT directory. Audit logs live at
      //     `${HQ_ROOT}/dispatch/audit/...`. Resolve via runtimeEnv's
      //     HQ_ROOT instead.
      //
      // (2) describeStaleDispatch accepts a `dispatchStateProbe` arg
      //     that suppresses false-positive BLOCKED when historical
      //     refusals predate a successful later admit, but the caller
      //     wasn't passing one. Wire `hq dispatch status <lrq>` as the
      //     probe — shell out, parse JSON, return `{status: ...}`. Any
      //     probe failure falls through to refusal-count-only
      //     classification (the OSS-safe behavior).
      const hqRootForAudit = resolveHqRoot(runtimeEnv);
      const stuckDetail = describeStaleDispatch(recordedDispatch, {
        hqRoot: hqRootForAudit || null,
        now: Date.parse(String(now)) || Date.now(),
        dispatchStateProbe: hqPath && _isValidLrqId(recordedDispatch?.launchRequestId)
          ? (lrqArg) => _probeDispatchStatusViaHq({
              hqPath,
              lrq: lrqArg,
              execFileImpl,
              env: runtimeEnv,
            })
          : null,
      });
      if (stuckDetail) {
        mergeAgentLifecycleLog(logger, 'merge_agent.stuck_pre_spawn', {
          repo,
          prNumber,
          launchRequestId: recordedDispatch.launchRequestId,
          dispatchedAt: recordedDispatch.dispatchedAt,
          trigger: recordedDispatch.trigger,
          stuckForMinutes: stuckDetail.stuckForMinutes,
          refusalCount: stuckDetail.refusalCount,
          primaryReason: stuckDetail.primaryReason,
          lastRefusedAt: stuckDetail.lastRefusedAt,
        });
      }
      return {
        decision,
        trigger: recordedDispatch.trigger,
        labelRemovalRetried: labelRemoval.attempted,
        operatorApprovalLabelRemoved: labelRemoval.operatorApprovalLabelRemoved,
        mergeAgentRequestedLabelRemoved: labelRemoval.mergeAgentRequestedLabelRemoved,
        labelRemovalErrors: labelRemoval.labelRemovalErrors,
        stuckDetail,
      };
    }
    return { decision };
  }

  // OSS guard. If agent-os (hq + merge-agent adapter) is not present on
  // this host, skip only brand-new merge-agent launches. Existing dispatch
  // records still flow through the idempotent label-reconciliation path
  // above, so consumed trigger labels keep converging after a host mode
  // change or temporary hq outage.
  const agentOsState = agentOsDetectImpl({ env: runtimeEnv, hqPath });
  if (!agentOsState.present) {
    const labelRemoval = await removeConsumedTriggerLabel({
      repo,
      prNumber,
      labels,
      trigger,
      ghExecFileImpl,
      now,
    });
    const skippedRecordPath = recordMergeAgentSkippedDispatch(rootDir, job, {
      skippedAt: now,
      decision: 'skip-no-agent-os',
      trigger,
      agentOsState,
      labelRemoval: labelRemoval.labelRemovalAttempt || null,
    });
    return {
      decision: 'skip-no-agent-os',
      agentOsDetectionSource: agentOsState.source,
      trigger,
      skippedRecordPath,
      operatorApprovalLabelRemoved: labelRemoval.operatorApprovalLabelRemoved,
      mergeAgentRequestedLabelRemoved: labelRemoval.mergeAgentRequestedLabelRemoved,
      labelRemovalErrors: labelRemoval.labelRemovalErrors,
    };
  }
  const resolvedHqPath = agentOsState.path || hqPath;
  const parentSession = resolveMergeAgentParentSession(runtimeEnv);
  const hqProject = resolveMergeAgentProject(runtimeEnv);

  const originalWorkerPrep = await prepareOriginalWorkerImpl({
    job,
    trigger,
    hqPath: resolvedHqPath,
    execFileImpl,
    env: runtimeEnv,
    now,
    logger,
  });
  if (originalWorkerPrep?.decision === 'deferred') {
    return {
      decision: 'dispatch-deferred',
      reason: originalWorkerPrep.reason || 'original-worker-not-terminal',
      originalWorkerId: originalWorkerPrep.originalWorkerId || null,
      workerStatus: originalWorkerPrep.workerStatus || null,
      launchRequestId: originalWorkerPrep.launchRequestId || null,
    };
  }
  if (originalWorkerPrep?.decision === 'skip') {
    const skippedRecordPath = recordMergeAgentSkippedDispatch(rootDir, job, {
      skippedAt: now,
      decision: `skip-${originalWorkerPrep.reason || 'original-worker-preflight'}`,
      trigger,
    });
    return {
      decision: 'dispatch-skipped',
      reason: originalWorkerPrep.reason || 'original-worker-preflight',
      originalWorkerId: originalWorkerPrep.originalWorkerId || null,
      launchRequestId: originalWorkerPrep.launchRequestId || null,
      skippedRecordPath,
    };
  }

  const prompt = buildMergeAgentPrompt(job, { trigger });
  const promptPath = writeMergeAgentPrompt(rootDir, job, prompt, { dispatchedAt: now });

  const args = [
    'dispatch',
    '--worker-class', 'merge-agent',
    '--task-kind', 'merge',
    '--repo', repo.split('/')[1] || repo,
    '--pr', String(prNumber),
    '--ticket', `PR-${prNumber}`,
    '--parent-session', parentSession,
    '--project', hqProject,
    '--prompt', promptPath,
  ];
  // Machine-readable trigger for the worker. The prompt also carries it
  // for human/agent readability, but adapters that branch on dispatch mode
  // should read the env var rather than parsing markdown.
  const dispatchEnv = trigger
    ? { ...runtimeEnv, MERGE_AGENT_DISPATCH_TRIGGER: trigger }
    : runtimeEnv;
  // Capture stderr + stdout on failure so callers can surface the
  // actionable diagnostic in their log. Without this, watcher.mjs's
  // catch block only sees `err.message = "Command failed: hq dispatch …"`
  // and the real cause (e.g. `auto-tear-down of 'codex-lac-611'
  // reported success but branch is still held`) is invisible until an
  // operator manually re-runs the dispatch. Observed 2026-05-16T23:31Z
  // for PR #552 — 4 dispatch failures all looked identical from the
  // watcher's log; only by running hq dispatch by hand did the real
  // error surface.
  let execResult;
  try {
    execResult = await execFileImpl(resolvedHqPath, args, {
      env: dispatchEnv,
      maxBuffer: 5 * 1024 * 1024,
      timeout: HQ_DISPATCH_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });
  } catch (err) {
    throw formatExecFailure('hq dispatch', err);
  }
  const { stdout } = execResult;
  const parsed = parseMergeAgentDispatchOutput(stdout);

  recordMergeAgentDispatch(rootDir, job, {
    dispatchedAt: now,
    prompt,
    dispatchId: parsed?.dispatchId || null,
    launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
    trigger,
  });

  const labelRemoval = await removeConsumedTriggerLabel({
    repo,
    prNumber,
    labels,
    trigger,
    ghExecFileImpl,
    now,
  });
  if (labelRemoval.attempted) {
    updateMergeAgentDispatchLabelRemoval(rootDir, job, {
      trigger,
      attemptedAt: labelRemoval.labelRemovalAttempt.attemptedAt,
      removed: labelRemoval.labelRemovalAttempt.removed,
      error: labelRemoval.labelRemovalAttempt.error,
    });
  }

  // Apply the merge-agent-dispatched marker label so operators (and the
  // watcher\'s cancel-on-merge path) can see at a glance that a merge-
  // agent worker is out for this PR. Best-effort: a failed add is
  // logged but does not roll back the dispatch we just completed.
  const dispatchedLabel = await addMergeAgentDispatchedLabel({
    repo,
    prNumber,
    ghExecFileImpl,
    now,
  });
  if (!dispatchedLabel.added) {
    upsertMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      transition: MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
      headSha,
      queuedAt: now,
    });
    updateMergeAgentLifecycleCleanup(rootDir, {
      repo,
      prNumber,
      result: {
        attempted: true,
        repo,
        prNumber,
        attemptedAt: dispatchedLabel.attemptedAt,
        transition: MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
        labelAdded: false,
        labelAddError: dispatchedLabel.error,
        cleanupComplete: false,
        retryable: true,
      },
      attemptedAt: dispatchedLabel.attemptedAt,
    });
  }

  return {
    decision,
    trigger,
    prompt,
    dispatchId: parsed?.dispatchId || null,
    launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
    operatorApprovalLabelRemoved: labelRemoval.operatorApprovalLabelRemoved,
    mergeAgentRequestedLabelRemoved: labelRemoval.mergeAgentRequestedLabelRemoved,
    labelRemovalErrors: labelRemoval.labelRemovalErrors,
    dispatchedLabelAdded: dispatchedLabel.added,
    dispatchedLabelError: dispatchedLabel.error,
  };
}

async function fetchMergeAgentCandidate(repo, prNumber, {
  execFileImpl = execFileAsync,
  operatorApprovalEvent = undefined,
  mergeAgentRequestEvent = undefined,
} = {}) {
  const { stdout } = await execFileImpl(
    'gh',
    [
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'mergeable,headRefName,baseRefName,headRefOid,body,labels,statusCheckRollup,state,mergedAt,closedAt,updatedAt,author',
    ],
    { maxBuffer: 5 * 1024 * 1024 }
  );
  const parsed = JSON.parse(String(stdout || '{}'));
  const labels = parsed.labels || [];
  const normalizedLabels = normalizeLabelNames(labels);
  const hasOperatorApproved = normalizedLabels.includes(OPERATOR_APPROVED_LABEL);
  const hasMergeAgentRequested = normalizedLabels.includes(MERGE_AGENT_REQUESTED_LABEL);
  const [resolvedOperatorApprovalEvent, resolvedMergeAgentRequestEvent] = await Promise.all([
    hasOperatorApproved && operatorApprovalEvent === undefined
      ? fetchLatestLabelEvent(repo, prNumber, OPERATOR_APPROVED_LABEL, { execFileImpl })
      : operatorApprovalEvent ?? null,
    hasMergeAgentRequested && mergeAgentRequestEvent === undefined
      ? fetchLatestLabelEvent(repo, prNumber, MERGE_AGENT_REQUESTED_LABEL, { execFileImpl })
      : mergeAgentRequestEvent ?? null,
  ]);
  return {
    repo,
    prNumber,
    branch: parsed.headRefName,
    baseBranch: parsed.baseRefName,
    headSha: parsed.headRefOid || null,
    mergeable: parsed.mergeable || 'UNKNOWN',
    checksConclusion: summarizeChecksConclusion(parsed.statusCheckRollup),
    labels,
    operatorNotes: extractOperatorNotes(parsed.body),
    prState: parsed.mergedAt ? 'merged' : String(parsed.state || 'unknown').trim().toLowerCase(),
    merged: Boolean(parsed.mergedAt),
    prAuthor: parsed.author?.login || null,
    closedAt: parsed.closedAt || null,
    mergedAt: parsed.mergedAt || null,
    prUpdatedAt: parsed.updatedAt || null,
    operatorApprovalEvent: resolvedOperatorApprovalEvent,
    mergeAgentRequestEvent: resolvedMergeAgentRequestEvent,
  };
}

function buildMergeAgentDispatchJob(rootDir, candidate) {
  const latestJob = findLatestFollowUpJobForPR(rootDir, {
    repo: candidate.repo,
    prNumber: candidate.prNumber,
  });
  return {
    ...candidate,
    lastVerdict: extractReviewVerdict(latestJob?.reviewBody),
    latestFollowUpJobStatus: latestJob?.status || null,
    remediationCurrentRound: Number(latestJob?.remediationPlan?.currentRound || 0),
    remediationMaxRounds: Number(latestJob?.remediationPlan?.maxRounds || 0),
    operatorApproval: buildScopedOperatorApproval(candidate, latestJob),
    mergeAgentRequest: buildScopedMergeAgentRequest(candidate),
  };
}

export {
  FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  FINAL_PASS_ON_REQUEST_CHANGES_ENV,
  HQ_DISPATCH_TIMEOUT_MS,
  HQ_WORKER_TEAR_DOWN_TIMEOUT_MS,
  OPERATOR_APPROVED_LABEL,
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_SKIP_LABELS,
  TERMINAL_WORKER_RUN_STATUSES,
  addMergeAgentDispatchedLabel,
  buildMergeAgentDispatchJob,
  buildMergeAgentPrompt,
  cancelMergeAgentDispatchOnMerge,
  clearMergeAgentLifecycleCleanup,
  buildScopedOperatorApproval,
  buildScopedMergeAgentRequest,
  describeStaleDispatch,
  scanStuckMergeAgentDispatches,
  isTerminalMergeAgentCancelDetail,
  STUCK_DISPATCH_DEFAULTS,
  detectAgentOsPresence,
  dispatchMergeAgentForPR,
  extractOperatorNotes,
  extractReviewVerdict,
  fetchMergeAgentCandidate,
  findLatestFollowUpJobForPR,
  isFinalPassOnRequestChangesEnabled,
  isScopedOperatorApproval,
  isScopedMergeAgentRequest,
  listMergeAgentDispatches,
  listMergeAgentLifecycleCleanups,
  listMergeAgentSkippedDispatches,
  normalizeReviewVerdict,
  pickMergeAgentDispatch,
  pickMergeAgentDispatchDetail,
  lookupOriginalWorkerRunStatus,
  prepareOriginalWorkerForMergeAgent,
  resolveSessionLedgerDbPath,
  recordMergeAgentDispatch,
  updateMergeAgentLifecycleCleanup,
  upsertMergeAgentLifecycleCleanup,
  resolveMergeAgentParentSession,
  resolveMergeAgentProject,
  summarizeChecksConclusion,
  writeMergeAgentPrompt,
};
