import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
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

import {
  DEFAULT_ADVERSARIAL_GATE_CONTEXT,
  resolveGateStatusContext,
} from './adversarial-gate-context.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { fastMergeAuditDir, fastMergeAuditPath } from './fast-merge-audit-storage.mjs';
import {
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_REQUESTED_LABEL,
  MERGE_AGENT_STUCK_LABEL,
  NO_MERGE_HOLD_LABEL,
  OPERATOR_APPROVED_LABEL,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { createGitHubPRCommentsAdapter } from './adapters/comms/github-pr-comments/index.mjs';
import { getFollowUpJobDir, listFollowUpJobsInDir } from './follow-up-jobs.mjs';
import { fetchLatestLabelEvent } from './github-label-events.mjs';
import { buildCodePrSubjectIdentity } from './identity-shapes.mjs';
import {
  getReviewRow,
  openReviewStateDb,
  requestReviewRereview,
} from './review-state.mjs';
import {
  CASCADE_FAILURE_CAP,
  readCascadeState,
} from './reviewer-cascade.mjs';
import { reviewerFailureClassFromStoredRow } from './reviewer-failure-classification.mjs';
import { parseBlockingFindingsSection } from './kernel/remediation-reply.mjs';
import { extractReviewVerdict, normalizeReviewVerdict } from './review-verdict.mjs';

const execFileAsync = promisify(execFile);

const MERGE_AGENT_DISPATCH_SCHEMA_VERSION = 1;
const MERGE_AGENT_LIFECYCLE_CLEANUP_SCHEMA_VERSION = 1;
const OPERATOR_SKIP_LABELS = new Set(['merge-agent-skip', MERGE_AGENT_STUCK_LABEL, 'do-not-merge', NO_MERGE_HOLD_LABEL]);
const DEFAULT_HQ_PATH = 'hq';
const HQ_WORKER_TEAR_DOWN_TIMEOUT_MS = 60_000;
const HQ_DISPATCH_TIMEOUT_MS = 90_000;
const HQ_DISPATCH_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000];
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
const REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER = 'reviewer-timeout-exhausted';
const FINAL_PASS_ON_REQUEST_CHANGES_ENV = 'MERGE_AGENT_FINAL_PASS_ON_REQUEST_CHANGES';
const NORMAL_MERGE_AGENT_DISPATCH_PRIORITY = 'normal';
const CRITICAL_MERGE_AGENT_DISPATCH_PRIORITY = 'critical';
const PHANTOM_HANDOFF_COMMENT_TIMEOUT_MS = 10_000;
const PHANTOM_HANDOFF_COMMENT_MARKER_PREFIX = 'adversarial-review-merge-agent-phantom-handoff';
const FAST_MERGE_VETO_LABEL = 'fast-merge-veto';
const FAST_MERGE_LABEL_PREFIX = 'fast-merge:';
const FAST_MERGE_SKIPPED_STATE = 'fast_merge_skipped';
const FAST_MERGE_MERGED_STATE = 'fast_merge_merged';
const FAST_MERGE_CLOSED_STATE = 'fast_merge_closed';
const FAST_MERGE_BLOCKED_STATE = 'fast_merge_blocked';
const FML_MERGE_AGENT_PER_POLL_CAP_ENV = 'FML_MERGE_AGENT_PER_POLL_CAP';
const DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP = 5;
const FAST_MERGE_GH_RETRY_DELAYS_MS = [250, 1_000];
const FAST_MERGE_GH_TIMEOUT_MS = 30_000;
const FAST_MERGE_FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'fail', 'cancel']);
const FAST_MERGE_PENDING_STATES = new Set(['', 'pending', 'in_progress', 'queued', 'waiting', 'requested', 'expected']);
const FAST_MERGE_SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped', 'pass', 'skipping']);
// Max times the watcher will auto-re-dispatch a merge-agent that died WITHOUT
// handing off (terminal-failed but its own `merge-agent-dispatched` marker is
// still set) for the same head SHA before handing the PR to the operator via
// `merge-agent-stuck`. Bounded on purpose: an unbounded retry on a persistently
// failing worker is exactly the loop shape that caused the 2026-05-24 reap
// storm. A scoped current-head `merge-agent-requested` label is the explicit
// operator recovery action for that stuck state and forces one retry path past
// this bound.
const _WATCHER_REDISPATCH_BOUND = 2;

// Grace window before the watcher treats a terminal-failed dispatch whose
// `merge-agent-dispatched` marker is already cleared as a PHANTOM HANDOFF.
//
// Both the per-tick retry path (dispatchMergeAgentForPR) and the proactive
// scanStuckMergeAgentDispatches treat a cleared `merge-agent-dispatched` marker
// as proof the merge-agent successfully handed off to a recovery worker or to
// the operator (`recovery-first`). That proxy is wrong when the worker clears
// the marker and then fails to establish recovery — e.g. a
// `validation-upstream-failed` classification flattened to `worker_crashed`, so
// merge_agent_failure_recovery never recognized it as baseline-scoped and never
// dispatched a repair worker. The PR then sits invisibly behind
// `skip-already-dispatched` forever (the #969-class orphan). A genuine
// recovery, by contrast, either merges, pushes a new head (which produces a
// fresh per-head record), or — for baseline waits — carries `merge-agent-stuck`
// within this window. So after the grace window with none of those signals, the
// watcher fails loud (applies `merge-agent-stuck` + a one-shot comment). It
// never re-dispatches or merges here, so this cannot revive a CPA-08-class
// premature merge. The window is generous so an in-flight delegated recovery is
// never escalated out from under.
const _PHANTOM_HANDOFF_GRACE_MINUTES = 60;

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

function resolveMergeAgentDispatchPriority(trigger = null) {
  return trigger === MERGE_AGENT_REQUESTED_LABEL
    ? CRITICAL_MERGE_AGENT_DISPATCH_PRIORITY
    : NORMAL_MERGE_AGENT_DISPATCH_PRIORITY;
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

function errorDiagnosticLines(err) {
  const primary = [err?.stderr, err?.stdout].filter(Boolean).join('\n');
  const detail = primary || String(err?.message || '');
  return detail
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function isUnsupportedHqPriorityFlagError(err) {
  return errorDiagnosticLines(err).some((line) => {
    if (!line.includes('--priority')) return false;
    return /\b(unrecognized|unknown|no such|unexpected)\b.*\b(argument|option|flag|parameter)s?\b.*--priority\b/i.test(line)
      || /\b(argument|option|flag|parameter)s?\b.*--priority\b.*\b(unrecognized|unknown|no such|unexpected)\b/i.test(line);
  });
}

function isTransientHqDispatchError(err) {
  if (isExecTimeout(err)) return true;
  const detail = [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eagain|epipe)\b/.test(detail)
    || detail.includes('database is locked')
    || detail.includes('sqlite_busy')
    || detail.includes('resource temporarily unavailable')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable');
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
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

function normalizeFollowUpJobStatus(status) {
  const text = String(status ?? '').trim().toLowerCase();
  if (text === 'in_progress') return 'in-progress';
  return text;
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

// Identify a status-rollup item that belongs to the adversarial-review
// pipeline's OWN gate (the commit status the watcher posts via
// adversarial-gate-status.mjs, context `agent-os/adversarial-gate` by default,
// overridable through ADV_GATE_STATUS_CONTEXT).
function adversarialOwnCheckContexts(env = process.env) {
  const contexts = new Set([DEFAULT_ADVERSARIAL_GATE_CONTEXT.toLowerCase()]);
  try {
    contexts.add(String(resolveGateStatusContext(env)).trim().toLowerCase());
  } catch {
    // A malformed ADV_GATE_STATUS_CONTEXT must not break the merge gate; the
    // default constant is already in the set.
  }
  return contexts;
}

function isAdversarialOwnStatusContext(item, excludeContexts) {
  // The watcher currently publishes its own gate as a legacy commit status,
  // surfaced by GitHub GraphQL as `StatusContext.context`. CheckRun names are
  // external CI surface area and must keep gating even if they exactly match
  // the configured context or share an `agent-os/adversarial*` prefix. If the
  // publisher migrates to CheckRun, this predicate and the branch-protection
  // contract must change together.
  if (item?.__typename && item.__typename !== 'StatusContext') {
    return false;
  }
  const ctx = String(item?.context || '').trim().toLowerCase();
  if (!ctx) return false;
  return excludeContexts.has(ctx);
}

// The merge-agent must NOT gate on the adversarial-review pipeline's OWN
// convergence check. It already receives the review verdict directly via
// `job.lastVerdict`, and the merge-agent is the component that converges the
// PR — waiting on the review's own gate-status is circular, and treating a
// `Request changes` gate-status as a hard CI failure double-counts the verdict
// (the verdict gates are handled separately, with the ultra-major/merge-by-
// default contract). Real external CI still gates. (Operator directive
// 2026-05-25.)
function summarizeChecksConclusion(statusCheckRollup, { env = process.env } = {}) {
  if (!Array.isArray(statusCheckRollup)) {
    return null;
  }
  const excludeContexts = adversarialOwnCheckContexts(env);
  const relevant = statusCheckRollup.filter(
    (item) => !isAdversarialOwnStatusContext(item, excludeContexts)
  );
  if (relevant.length === 0) {
    // No checks at all, or only the review pipeline's own gate → nothing
    // external to wait on.
    return 'SUCCESS';
  }

  let sawPending = false;
  for (const item of relevant) {
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

async function isMergeAgentDispatchActiveForHead(rootDir, {
  repo,
  prNumber,
  headSha,
} = {}, {
  execFileImpl = execFileAsync,
  env = process.env,
  logger = console,
  detectAgentOsPresenceImpl = detectAgentOsPresence,
  getRecordedMergeAgentDispatchForHeadImpl = getRecordedMergeAgentDispatchForHead,
  hasPendingDispatchedLabelAddCleanupImpl = hasPendingDispatchedLabelAddCleanup,
  probeDispatchStatusViaHqImpl = probeDispatchStatusViaHq,
} = {}) {
  if (!repo || prNumber == null || !headSha) {
    return { active: false, reason: 'missing-head-context' };
  }

  const recordedDispatch = getRecordedMergeAgentDispatchForHeadImpl(rootDir, {
    repo,
    prNumber,
    headSha,
  });
  const hasPendingLabelAddCleanup = hasPendingDispatchedLabelAddCleanupImpl(
    rootDir,
    { repo, prNumber, headSha },
    { logger }
  );
  if (!recordedDispatch?.launchRequestId && !hasPendingLabelAddCleanup) {
    return { active: false, reason: 'no-current-head-dispatch' };
  }

  const agentOsState = detectAgentOsPresenceImpl({
    env,
    hqPath: env.HQ_BIN || DEFAULT_HQ_PATH,
  });
  const hqPath = agentOsState.present ? (agentOsState.path || env.HQ_BIN || DEFAULT_HQ_PATH) : null;
  if (!hqPath || !recordedDispatch?.launchRequestId) {
    return { active: false, reason: 'dispatch-status-unavailable' };
  }

  const ownerResolution = resolveHqOwner(resolveHqRoot(env));
  const dispatchStatus = await probeDispatchStatusViaHqImpl({
    hqPath,
    lrq: recordedDispatch.launchRequestId,
    asOwner: ownerResolution?.ownerUser || null,
    execFileImpl,
    env,
    logger,
  });
  const status = typeof dispatchStatus?.status === 'string'
    ? dispatchStatus.status.trim().toLowerCase()
    : null;
  const active = status === 'running'
    || status === 'starting'
    || status === 'blocked'
    || status === 'stalled';

  return {
    active,
    reason: active ? `dispatch-${status}` : (status ? `dispatch-${status}` : 'dispatch-status-unavailable'),
    launchRequestId: recordedDispatch.launchRequestId,
    status,
    hasPendingLabelAddCleanup,
  };
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
const _REQUESTED_RETRYABLE_DISPATCH_STATUSES = new Set([
  'failed',
  'cancelled',
  'canceled',
  'superseded',
  // The recorded dispatch's launch request is gone from the ledger (reaped /
  // archived). Because the probe now passes --as-owner, a live cross-account
  // dispatch is visible; a remaining "not-found" therefore means the worker is
  // genuinely no longer there — a safe signal that re-dispatch won't duplicate
  // a live worker.
  'not-found',
]);
const _WATCHER_AUTONOMOUS_RETRYABLE_DISPATCH_STATUSES = new Set([
  'failed',
  'superseded',
  'not-found',
]);

// `hq dispatch status` exits 1 with "no dispatch with id ..." when the id
// resolves to no launch request the caller can see. With --as-owner passed the
// cross-account case is excluded, so this signals the dispatch is genuinely
// gone (reaped/archived) rather than a transient probe failure (timeout, hq
// missing, ledger busy) — only the former is safe to treat as re-dispatchable.
function _isNotFoundDispatchStatusError(err) {
  if (!err) return false;
  const code = err.code ?? err.status ?? null;
  return (code === 1 || code === '1') && /no dispatch with id/i.test(String(err.stderr || ''));
}

function hasAuthoritativeOwnerVisibility(asOwner) {
  return Boolean(String(asOwner || '').trim());
}

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
function _probeDispatchStatusViaHq({ hqPath, lrq, asOwner = null, execFileImpl, env = {}, logger = console } = {}) {
  if (!hqPath || !_isValidLrqId(lrq)) return null;
  // The probe is synchronous (describeStaleDispatch treats the return
  // value as a plain object, not a promise). spawnSync is the right
  // tool — execFileImpl from the outer scope is async.
  // --as-owner: `hq dispatch status` scopes to the calling OS user, but the
  // merge-agent dispatch is owned by the HQ-root owner (e.g. airlock) while the
  // watcher runs as a different account — without it the probe is blind to its
  // own worker. It's a read; HQ filesystem perms already gate cross-account.
  const args = asOwner
    ? ['dispatch', 'status', lrq, '--as-owner', asOwner]
    : ['dispatch', 'status', lrq];
  let result;
  try {
    result = spawnSync(hqPath, args, {
      env: { ...env },
      timeout: 5_000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  if (!result || result.error) return null;
  if (result.status !== 0) {
    const notFound = result.status === 1 && /no dispatch with id/i.test(String(result.stderr || ''));
    if (hasAuthoritativeOwnerVisibility(asOwner) && notFound) {
      return { status: 'not-found' };
    }
    if (notFound && logger && typeof logger.warn === 'function') {
      logger.warn(
        '[follow-up-merge-agent] refusing to classify dispatch status as not-found without a proven HQ owner; duplicate-dispatch protection stays active'
      );
    }
    return null;
  }
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

async function probeDispatchStatusViaHq({
  hqPath,
  lrq,
  asOwner = null,
  execFileImpl = execFileAsync,
  env = {},
  logger = console,
} = {}) {
  if (!hqPath || !_isValidLrqId(lrq)) return null;
  // --as-owner makes the watcher's cross-account dispatch status visible (see
  // _probeDispatchStatusViaHq). Without it the placey watcher gets "no dispatch
  // with id" for its airlock-owned merge-agent and can never see `failed`.
  const args = asOwner
    ? ['dispatch', 'status', lrq, '--as-owner', asOwner]
    : ['dispatch', 'status', lrq];
  try {
    const { stdout } = await execFileImpl(hqPath, args, {
      env: { ...env },
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    });
    const parsed = JSON.parse(String(stdout || '{}'));
    const status = typeof parsed?.status === 'string'
      ? parsed.status.trim().toLowerCase()
      : null;
    return status ? { status } : null;
  } catch (err) {
    if (hasAuthoritativeOwnerVisibility(asOwner) && _isNotFoundDispatchStatusError(err)) {
      return { status: 'not-found' };
    }
    if (_isNotFoundDispatchStatusError(err) && logger && typeof logger.warn === 'function') {
      logger.warn(
        '[follow-up-merge-agent] refusing to classify dispatch status as not-found without a proven HQ owner; duplicate-dispatch protection stays active'
      );
    }
    return null;
  }
}

function isRetryableRecordedDispatchStatus(status) {
  return _REQUESTED_RETRYABLE_DISPATCH_STATUSES.has(String(status || '').trim().toLowerCase());
}

function isWatcherAutonomousRetryableRecordedDispatchStatus(status) {
  return _WATCHER_AUTONOMOUS_RETRYABLE_DISPATCH_STATUSES.has(String(status || '').trim().toLowerCase());
}

// True once a terminal-failed dispatch has been left orphaned (marker cleared,
// no recovery established) longer than the phantom-handoff grace window. The
// grace starts when the watcher first durably observes the handoff gap for this
// head, not when the original merge-agent dispatch was created.
function isPhantomHandoffGraceElapsed(recordedDispatch, now) {
  const graceStartedAtMs = Date.parse(String(recordedDispatch?.phantomHandoffObservedAt || ''));
  if (!Number.isFinite(graceStartedAtMs)) return false;
  const nowMs = Date.parse(String(now || ''));
  const effectiveNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  return effectiveNowMs - graceStartedAtMs >= _PHANTOM_HANDOFF_GRACE_MINUTES * 60_000;
}

function getRecordedMergeAgentLifecycleCleanup(rootDir, { repo, prNumber } = {}) {
  const detail = readJsonFileDetailed(mergeAgentLifecycleCleanupFilePath(rootDir, { repo, prNumber }));
  return detail.ok ? detail.value : null;
}

function getRecordedMergeAgentLifecycleCleanupDetailed(rootDir, { repo, prNumber } = {}, { logger = console } = {}) {
  const filePath = mergeAgentLifecycleCleanupFilePath(rootDir, { repo, prNumber });
  const detail = readJsonFileDetailed(filePath);
  if (detail.ok) return { ok: true, value: detail.value, filePath };
  if (detail.error?.code === 'ENOENT') {
    return { ok: true, value: null, filePath, missing: true };
  }
  logger?.error?.(
    `[follow-up-merge-agent] failed to read merge-agent lifecycle cleanup record for ${repo}#${prNumber} at ${filePath}: ${detail.error?.message || String(detail.error)}`
  );
  mergeAgentLifecycleLog(logger, 'merge_agent.lifecycle_cleanup_read_failed', {
    repo,
    prNumber,
    filePath,
    error: detail.error?.message || String(detail.error),
    code: detail.error?.code || null,
  });
  return { ok: false, error: detail.error, filePath };
}

function hasPendingDispatchedLabelAddCleanup(rootDir, job, { logger = console } = {}) {
  const detail = getRecordedMergeAgentLifecycleCleanupDetailed(rootDir, job, { logger });
  if (!detail.ok) return true;
  const cleanup = detail.value;
  if (!isUnresolvedMergeAgentLifecycleCleanup(cleanup)) return false;
  if (cleanup.transition !== MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION) return false;
  if (cleanup.headSha && job?.headSha && cleanup.headSha !== job.headSha) return false;
  return true;
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
              asOwner: resolveHqOwner(hqRoot)?.ownerUser || null,
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

async function reconcileProactivePhantomHandoffs({
  rootDir,
  repo = null,
  currentPRs = [],
  hqPath = DEFAULT_HQ_PATH,
  runtimeEnv = process.env,
  ghExecFileImpl = execFileAsync,
  execFileImpl = execFileAsync,
  logger = console,
  now = isoNow(),
} = {}) {
  const hqRoot = resolveHqRoot(runtimeEnv);
  if (!hqRoot) return { inspected: 0, graceStarted: 0, escalated: 0 };
  const ownerResolution = resolveHqOwner(hqRoot);
  const statusProbeAsOwner = ownerResolution?.ownerUser || null;
  let inspected = 0;
  let graceStarted = 0;
  let escalated = 0;
  for (const currentPR of currentPRs) {
    if (!currentPR?.repo || currentPR?.prNumber == null || !currentPR?.headSha) continue;
    if (repo && currentPR.repo !== repo) continue;
    const labelNames = normalizeLabelNames(currentPR.labels);
    if (
      labelNames.includes(MERGE_AGENT_DISPATCHED_LABEL)
      || labelNames.includes(MERGE_AGENT_STUCK_LABEL)
      || hasPendingDispatchedLabelAddCleanup(rootDir, currentPR, { logger })
    ) {
      continue;
    }
    const recordedDispatch = getRecordedMergeAgentDispatchForHead(rootDir, currentPR);
    if (!recordedDispatch?.launchRequestId) continue;
    const recordedDispatchStatus = await probeDispatchStatusViaHq({
      hqPath: runtimeEnv.HQ_BIN || hqPath,
      lrq: recordedDispatch.launchRequestId,
      asOwner: statusProbeAsOwner,
      execFileImpl,
      env: runtimeEnv,
    });
    if (!isWatcherAutonomousRetryableRecordedDispatchStatus(recordedDispatchStatus?.status)) continue;
    inspected += 1;
    const beforeObservedAt = recordedDispatch.phantomHandoffObservedAt || null;
    const beforePosted = recordedDispatch.phantomHandoffCommentDelivery?.posted;
    const reconciled = await reconcilePhantomHandoffEscalation({
      rootDir,
      job: currentPR,
      recordedDispatch,
      dispatchStatus: recordedDispatchStatus.status,
      labels: currentPR.labels,
      ghExecFileImpl,
      execFileImpl,
      logger,
      env: runtimeEnv,
      now,
    });
    if (!beforeObservedAt && reconciled?.phantomHandoffObservedAt) {
      graceStarted += 1;
    }
    if (beforePosted !== true && reconciled?.phantomHandoffCommentDelivery?.posted === true) {
      escalated += 1;
    }
  }
  return { inspected, graceStarted, escalated };
}

function findLatestFollowUpJobForPR(rootDir, { repo, prNumber, revisionRef = null, headSha = null }) {
  const keys = ['pending', 'inProgress', 'completed', 'failed', 'stopped'];
  const wantedRevisionRef = String(revisionRef || headSha || '').trim();
  let latest = null;
  let latestTs = '';
  for (const key of keys) {
    for (const entry of listFollowUpJobsInDir(rootDir, key)) {
      const job = entry?.job;
      if (!job) continue;
      if (job.repo !== repo) continue;
      if (Number(job.prNumber) !== Number(prNumber)) continue;
      if (wantedRevisionRef && String(job.revisionRef || '').trim() !== wantedRevisionRef) continue;
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
  // Both automated-convergence triggers get the same triage-and-merge
  // contract: the budget-exhausted final pass (`Request changes` with the
  // round budget consumed) AND a clean verdict (`null` trigger = `Comment
  // only`/approved). They differ only in the final-pass safety-floor framing.
  // Before 2026-05-25 only the final pass carried this block, so a clean
  // verdict reached the merge-agent with NO instructions and the worker
  // defaulted to requesting another review (PR #898). operator-approved and
  // merge-agent-requested are operator-driven and keep their own label-scoped
  // semantics — they do NOT get this block.
  const isAutomatedConvergence = trigger === null
    || trigger === FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER;
  if (isAutomatedConvergence) {
    lines.push('');
    if (trigger === FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER) {
      lines.push('## Mode: final-pass-on-budget-exhausted');
      lines.push('');
      lines.push(
        'The adversarial-review round budget for this PR is consumed and the'
        + ' latest reviewer verdict is still `Request changes`. You are the'
        + ' final automated pass before operator escalation.'
      );
    } else {
      lines.push('## Mode: converge-and-merge');
      lines.push('');
      lines.push(
        'The latest reviewer verdict is non-blocking (`Comment only`/'
        + 'approved). The review pipeline has reached its natural end and this'
        + ' PR is ready to land. Converge it NOW — do not wait for any'
        + ' remaining review or remediation rounds.'
      );
    }
    lines.push('');
    lines.push(
      'Default action: MERGE. Another review round is a rare exception'
      + ' reserved for major in-PR refactors (see step 2) — it is NOT the'
      + ' cautious default. When in doubt, MERGE.'
    );
    lines.push('');
    lines.push('Required behavior:');
    lines.push(
      '1. Run `comment_only_followups.py` (your existing sub-worker triage'
      + ' step) against the latest review body. Apply every actionable'
      + ' in-scope finding inline — including non-blocking and suggested-fix'
      + ' comments. Use `suggestions_unable_to_apply` only'
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
      '2. Default to MERGE. When triage returns `no-followups-needed`, or'
      + ' returns `addressed` after you make the fixes, rebase, force-push the'
      + ' updated head, wait only for real external CI on that pushed head,'
      + ' then MERGE (`gh pr merge --squash --admin`). Do NOT wait on or treat'
      + ' the adversarial-review gate status (`agent-os/adversarial-gate`) as a'
      + ' blocking check — it only mirrors the review verdict you already have,'
      + ' not external CI, and the admin merge lands past it. Do NOT request'
      + ' another'
      + ' review for light, medium, or even substantial-but-bounded fixes —'
      + ' force-push and merge those directly. Set `reReview.requested = true`'
      + ' (exit `awaiting-rereview`) only for major in-PR refactors whose'
      + ' review risk genuinely demands a fresh adversarial pass. That is'
      + ' rare. The following are NEVER major in-PR refactors and MUST merge without'
      + ' re-review — a single- or few-file change; any test or test-fixture'
      + ' edit; a config, doc, or comment tweak; applying reviewer'
      + ' suggestions; renames; small bugfixes; or any change confined to the'
      + ' area the review already covered. When you are weighing whether a'
      + ' change is "major enough" to re-review, it probably is not — MERGE it. If'
      + ' remaining refactor work belongs across modules or future PRs, file'
      + ' the Linear tickets described above and MERGE this PR instead of'
      + ' using `awaiting-rereview` or stopping the PR. A non-empty'
      + ' `blockers_observed` result must hard-refuse the merge.'
    );
    if (trigger === FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER) {
      lines.push(
        '3. Treat this dispatch the same way you would treat an'
        + ' `operator-approved` dispatch for review/remediation state, EXCEPT'
        + ' that the safety floor (no blocker-class merges) is stricter:'
        + ' the operator did not personally vouch for this head.'
      );
    }
    if (trigger === REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER) {
      lines.push(
        '3. This dispatch is a reviewer-timeout exhaustion recovery. A'
        + ' remediation round completed and requested re-review, but the'
        + ' reviewer timed out before posting after the retry budget. Do not'
        + ' treat the missing fresh review as approval. Rebase/resolve the'
        + ' branch, run the relevant validation, address any still-actionable'
        + ' findings from the last posted review if they remain true, and'
        + ' merge only when the PR is clean. If the branch cannot be made'
        + ' mergeable inside this pass, stop with a clear blocker instead of'
        + ' leaving the PR behind a green-ish timeout gate.'
      );
    }
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
  // mergeability/check/verdict gates, the terminal `merge-agent-stuck`
  // handoff marker for the current head, but not closed PRs, active
  // remediation, other hard stop labels, or duplicate-dispatch
  // protection.
  if (String(job?.prState ?? '').trim().toLowerCase() !== 'open' || Boolean(job?.merged)) {
    return { decision: 'skip-pr-not-open', trigger: null };
  }

  const hasUnbypassableSkipLabel = labels.has('merge-agent-skip')
    || labels.has('do-not-merge')
    || labels.has(NO_MERGE_HOLD_LABEL);
  if (hasUnbypassableSkipLabel) {
    return { decision: 'skip-operator-skip', trigger: null };
  }
  const hasMergeAgentStuckLabel = labels.has(MERGE_AGENT_STUCK_LABEL);
  if (hasMergeAgentStuckLabel && hasMergeAgentRequestedLabel && !mergeAgentRequested) {
    return { decision: 'skip-merge-agent-requested-stale', trigger: null };
  }
  if (hasMergeAgentStuckLabel && !mergeAgentRequested) {
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

  const latestFollowUpJobStatus = normalizeFollowUpJobStatus(job?.latestFollowUpJobStatus);
  if (
    latestFollowUpJobStatus === 'in-progress'
    || latestFollowUpJobStatus === 'pending'
  ) {
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

function pickReviewerTimeoutExhaustedMergeGate(job, { operatorApproved = false } = {}) {
  if (String(job?.mergeable ?? '').trim().toUpperCase() !== 'MERGEABLE') {
    return { decision: 'skip-not-mergeable', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }

  const checksConclusion = job?.checksConclusion == null
    ? null
    : String(job.checksConclusion).trim().toUpperCase();
  if (checksConclusion === null || checksConclusion === '') {
    return { decision: 'skip-checks-unknown', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }
  if (checksConclusion === 'PENDING') {
    return { decision: 'skip-checks-pending', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }
  if (checksConclusion !== 'SUCCESS') {
    return { decision: 'skip-checks-failed', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }

  if (!operatorApproved && (Number(job?.blockingFindingCount) || 0) > 0) {
    return { decision: 'skip-blockers-present', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }
  const blockingFindingState = String(job?.blockingFindingState || 'known').trim().toLowerCase();
  if (!operatorApproved && blockingFindingState === 'unknown') {
    return { decision: 'skip-blocking-findings-unknown', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
  }

  return { decision: 'dispatch', trigger: REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER };
}

function shouldUseReviewerTimeoutExhaustedMergeGate(job) {
  return (
    job?.reviewFailureClass === 'reviewer-timeout'
    && job?.reviewFailureExhausted === true
    && normalizeFollowUpJobStatus(job?.latestFollowUpJobStatus) === 'completed'
    && job?.latestFollowUpReReviewRequested === true
  );
}

function pickNormalMergeAgentDispatchDetail({
  job,
  normalizedVerdict,
  operatorApproved,
  hasOperatorApprovedLabel,
  finalPassOnRequestChangesEnabled = false,
}) {
  if (shouldUseReviewerTimeoutExhaustedMergeGate(job)) {
    return pickReviewerTimeoutExhaustedMergeGate(job, { operatorApproved });
  }

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

  if (!operatorApproved && (Number(job?.blockingFindingCount) || 0) > 0) {
    return { decision: 'skip-blockers-present', trigger: null };
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
    // ROOT-CAUSE GATE (PR #901): the final-pass-on-budget-exhausted merge is
    // ONLY for the deadlock case — a `Request changes` verdict driven solely by
    // NON-blocking nitpicks (reviewer.last policy: `Comment only` requires BOTH
    // sections to be `None`, so a non-blocking-only final round still reads
    // `Request changes`). When the `## Blocking issues` section has standing
    // items, auto-merging is NEVER acceptable: that is exactly how #901 shipped
    // two blocking production bugs. The previous design delegated the
    // blocker-refusal to the dispatched worker's prompt/judgment, which is not
    // enforcement — the worker merged anyway. Gate it deterministically here on
    // the reviewer's own categorization. operator-approved is handled earlier
    // (it bypasses this branch), so a human can still force a merge that accepts
    // the blockers.
    const blockingFindingState = String(job?.blockingFindingState || 'known').trim().toLowerCase();
    if (blockingFindingState === 'unknown') {
      return { decision: 'skip-blocking-findings-unknown', trigger: null };
    }
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
  priority = NORMAL_MERGE_AGENT_DISPATCH_PRIORITY,
  priorityFlagSupported = true,
  labelRemoval = null,
  watcherReDispatchCount = 0,
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
    priority,
    priorityFlagSupported,
    labelRemoval,
    // Per-(PR, head SHA) count of watcher-owned re-dispatches of a died-without-
    // handoff worker. Bounds the auto-retry (see _WATCHER_REDISPATCH_BOUND).
    watcherReDispatchCount: Number(watcherReDispatchCount || 0),
    dispatchedAt,
    phantomHandoffObservedAt: null,
    phantomHandoffCommentDelivery: null,
    dispatchId,
    launchRequestId,
    prompt,
  };
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return filePath;
}

function updateRecordedMergeAgentDispatch(rootDir, job, mutate) {
  const filePath = mergeAgentDispatchFilePath(rootDir, job);
  const existing = readJsonFileDetailed(filePath);
  if (!existing.ok) return null;
  const next = mutate({ ...existing.value });
  if (!next) return existing.value;
  writeFileAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function buildPhantomHandoffCommentMarker(recordedDispatch) {
  const key = [
    String(recordedDispatch?.repo || ''),
    String(recordedDispatch?.prNumber || ''),
    String(recordedDispatch?.headSha || ''),
    String(recordedDispatch?.launchRequestId || ''),
  ].join(':');
  const digest = createHash('sha256').update(key).digest('hex');
  return `${PHANTOM_HANDOFF_COMMENT_MARKER_PREFIX}:${digest}`;
}

function buildPhantomHandoffEscalationCommentBody({ recordedDispatch, dispatchStatus } = {}) {
  const lrq = recordedDispatch?.launchRequestId || 'unknown';
  const marker = buildPhantomHandoffCommentMarker(recordedDispatch);
  return [
    `<!-- ${marker} -->`,
    '🛑 **merge-agent escalation — phantom handoff**',
    '',
    `The merge-agent dispatch \`${lrq}\` for this PR is terminal (\`${dispatchStatus}\`), but its`,
    '`merge-agent-dispatched` marker was cleared without a recovery worker taking ownership and',
    'without a `merge-agent-stuck` hand-off. So the automated merge path believed recovery owned',
    'this PR when nothing did, and it would otherwise sit behind `skip-already-dispatched`',
    'indefinitely. It has now been labeled `merge-agent-stuck` so it surfaces for operator action.',
    '',
    'To proceed: clear any standing review blockers, then either remove `merge-agent-stuck` and add',
    '`merge-agent-requested` to retry the merge-agent, or merge manually if the PR is safe.',
  ].join('\n');
}

function buildPendingPhantomHandoffCommentDelivery({ recordedDispatch, dispatchStatus, attemptedAt = null } = {}) {
  const body = buildPhantomHandoffEscalationCommentBody({ recordedDispatch, dispatchStatus });
  return {
    posted: false,
    reason: 'pending',
    attempts: 0,
    marker: buildPhantomHandoffCommentMarker(recordedDispatch),
    body,
    context: {
      repo: recordedDispatch?.repo || null,
      prNumber: Number(recordedDispatch?.prNumber) || null,
      revisionRef: recordedDispatch?.headSha || null,
      launchRequestId: recordedDispatch?.launchRequestId || null,
      dispatchStatus: dispatchStatus || null,
    },
    attemptedAt: attemptedAt || null,
  };
}

function persistPendingPhantomHandoffCommentDelivery({
  rootDir,
  job,
  recordedDispatch,
  dispatchStatus,
  attemptedAt,
} = {}) {
  if (recordedDispatch?.phantomHandoffCommentDelivery) return recordedDispatch;
  return updateRecordedMergeAgentDispatch(rootDir, job, (doc) => ({
    ...doc,
    phantomHandoffCommentDelivery: buildPendingPhantomHandoffCommentDelivery({
      recordedDispatch: doc,
      dispatchStatus,
      attemptedAt,
    }),
  })) || recordedDispatch;
}

async function postPhantomHandoffEscalationComment({
  rootDir,
  recordedDispatch,
  dispatchStatus,
  execFileImpl = execFileAsync,
  env = process.env,
} = {}) {
  const revisionRef = String(recordedDispatch?.headSha || '').trim();
  if (!revisionRef) {
    return {
      posted: false,
      reason: 'missing-revision-ref',
      error: 'cannot post phantom-handoff escalation comment without a revisionRef',
    };
  }
  const subjectIdentity = buildCodePrSubjectIdentity({
    repo: recordedDispatch.repo,
    prNumber: recordedDispatch.prNumber,
    revisionRef,
  });
  const body = buildPhantomHandoffEscalationCommentBody({ recordedDispatch, dispatchStatus });
  const adapter = createGitHubPRCommentsAdapter({
    rootDir,
    execFileImpl,
    env,
    commentTimeoutMs: PHANTOM_HANDOFF_COMMENT_TIMEOUT_MS,
    resolveGhToken: () => ({
      tokenEnvName: 'GITHUB_TOKEN',
      fallbackTokenEnvNames: ['GH_TOKEN'],
      allowGhAuthFallback: true,
    }),
  });
  try {
    const receipt = await adapter.postOperatorNotice(
      {
        type: 'merge-agent-phantom-handoff',
        subjectRef: {
          domainId: subjectIdentity.domainId,
          subjectExternalId: subjectIdentity.subjectExternalId,
          revisionRef: subjectIdentity.revisionRef,
        },
        revisionRef: subjectIdentity.revisionRef,
        eventExternalId: buildPhantomHandoffCommentMarker(recordedDispatch),
        observedAt: new Date().toISOString(),
      },
      body,
      {
        domainId: subjectIdentity.domainId,
        subjectExternalId: subjectIdentity.subjectExternalId,
        revisionRef: subjectIdentity.revisionRef,
        round: 0,
        kind: 'operator-notice',
        noticeRef: buildPhantomHandoffCommentMarker(recordedDispatch),
      }
    );
    return {
      posted: true,
      marker: buildPhantomHandoffCommentMarker(recordedDispatch),
      commentId: receipt.deliveryExternalId,
      body,
    };
  } catch (err) {
    return {
      posted: false,
      reason: err?.killed === true ? 'gh-cli-timeout' : 'gh-cli-failure',
      error: err?.message || String(err),
      marker: buildPhantomHandoffCommentMarker(recordedDispatch),
      body,
    };
  }
}

async function retryPendingPhantomHandoffComment({
  rootDir,
  job,
  recordedDispatch,
  dispatchStatus,
  execFileImpl = execFileAsync,
  env = process.env,
  logger = console,
  now = isoNow(),
} = {}) {
  const delivery = recordedDispatch?.phantomHandoffCommentDelivery;
  if (!delivery || delivery.posted === true) return recordedDispatch;
  const previousAttempts = Number(delivery.attempts || 0);
  const postResult = await postPhantomHandoffEscalationComment({
    rootDir,
    recordedDispatch,
    dispatchStatus: dispatchStatus || delivery?.context?.dispatchStatus || null,
    execFileImpl,
    env,
  });
  if (!postResult.posted) {
    logger?.error?.(
      `[follow-up-merge-agent] failed to post phantom-handoff escalation comment to ${job.repo}#${job.prNumber}: ${postResult.error || postResult.reason || 'unknown'}`
    );
  }
  return updateRecordedMergeAgentDispatch(rootDir, job, (doc) => ({
    ...doc,
    phantomHandoffCommentDelivery: {
      ...delivery,
      body: delivery.body || postResult.body,
      marker: delivery.marker || postResult.marker,
      posted: postResult.posted === true,
      reason: postResult.posted ? null : (postResult.reason || 'unknown'),
      error: postResult.posted ? null : (postResult.error || null),
      commentId: postResult.commentId || delivery.commentId || null,
      attempts: previousAttempts + 1,
      attemptedAt: now,
    },
  })) || recordedDispatch;
}

async function reconcilePhantomHandoffEscalation({
  rootDir,
  job,
  recordedDispatch,
  dispatchStatus,
  labels,
  ghExecFileImpl = execFileAsync,
  logger = console,
  env = process.env,
  now = isoNow(),
} = {}) {
  if (!recordedDispatch || !isWatcherAutonomousRetryableRecordedDispatchStatus(dispatchStatus)) {
    return recordedDispatch;
  }
  const labelNames = normalizeLabelNames(labels);
  if (labelNames.includes(MERGE_AGENT_DISPATCHED_LABEL) || labelNames.includes(MERGE_AGENT_STUCK_LABEL)) {
    return recordedDispatch;
  }
  if (!recordedDispatch.phantomHandoffObservedAt) {
    const observed = updateRecordedMergeAgentDispatch(rootDir, job, (doc) => ({
      ...doc,
      phantomHandoffObservedAt: now,
    })) || recordedDispatch;
    mergeAgentLifecycleLog(logger, 'merge_agent.phantom_handoff_grace_started', {
      repo: job.repo,
      prNumber: job.prNumber,
      launchRequestId: observed.launchRequestId,
      previousStatus: dispatchStatus,
      phantomHandoffObservedAt: now,
      graceMinutes: _PHANTOM_HANDOFF_GRACE_MINUTES,
      at: now,
    });
    return observed;
  }
  if (!isPhantomHandoffGraceElapsed(recordedDispatch, now)) {
    return recordedDispatch;
  }
  mergeAgentLifecycleLog(logger, 'merge_agent.phantom_handoff_escalated', {
    repo: job.repo,
    prNumber: job.prNumber,
    launchRequestId: recordedDispatch.launchRequestId,
    previousStatus: dispatchStatus,
    phantomHandoffObservedAt: recordedDispatch.phantomHandoffObservedAt,
    graceMinutes: _PHANTOM_HANDOFF_GRACE_MINUTES,
    at: now,
  });
  let latestRecordedDispatch = persistPendingPhantomHandoffCommentDelivery({
    rootDir,
    job,
    recordedDispatch,
    dispatchStatus,
    attemptedAt: now,
  });
  const currentLabelNames = normalizeLabelNames(labels);
  const stuckPresent = currentLabelNames.includes(MERGE_AGENT_STUCK_LABEL);
  const appliedStuck = stuckPresent || await applyMergeAgentStuckLabel({
    repo: job.repo,
    prNumber: job.prNumber,
    labels: currentLabelNames,
    ghExecFileImpl,
    logger,
  });
  if (!appliedStuck) return latestRecordedDispatch;
  if (latestRecordedDispatch?.phantomHandoffCommentDelivery?.posted === false) {
    latestRecordedDispatch = await retryPendingPhantomHandoffComment({
      rootDir,
      job,
      recordedDispatch: latestRecordedDispatch,
      dispatchStatus,
      execFileImpl: ghExecFileImpl,
      env,
      logger,
      now,
    });
  }
  return latestRecordedDispatch;
}

function recordMergeAgentSkippedDispatch(rootDir, job, {
  skippedAt = isoNow(),
  decision,
  trigger = null,
  agentOsState = null,
  labelRemoval = null,
  blockingFindingCount = undefined,
  blockingFindingState = undefined,
  reviewerFailureClass = undefined,
  reviewerFailureExhausted = undefined,
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
    ...(blockingFindingCount !== undefined ? { blockingFindingCount } : {}),
    ...(blockingFindingState !== undefined ? { blockingFindingState } : {}),
    ...(reviewerFailureClass !== undefined ? { reviewerFailureClass } : {}),
    ...(reviewerFailureExhausted !== undefined ? { reviewerFailureExhausted } : {}),
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

// Best-effort terminal hand-off: mark the PR `merge-agent-stuck` so it surfaces
// for the operator and OPERATOR_SKIP_LABELS halts further auto-dispatch. Used
// when the watcher's bounded re-dispatch budget is exhausted. Never throws into
// the watcher loop — a failed label add just leaves the PR in its prior state.
async function applyMergeAgentStuckLabel({
  repo,
  prNumber,
  labels = [],
  ghExecFileImpl = execFileAsync,
  logger = console,
} = {}) {
  if (normalizeLabelNames(labels).includes(MERGE_AGENT_STUCK_LABEL)) return false;
  try {
    await ghExecFileImpl('gh', [
      'pr',
      'edit',
      String(prNumber),
      '--repo',
      repo,
      '--add-label',
      MERGE_AGENT_STUCK_LABEL,
    ], { maxBuffer: 5 * 1024 * 1024 });
    return true;
  } catch (err) {
    logger?.error?.(
      `merge-agent: failed to apply ${MERGE_AGENT_STUCK_LABEL} to ${repo}#${prNumber}: ${err?.message || err}`
    );
    return false;
  }
}

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
  latestFollowUpReReviewRequested = false,
  remediationCurrentRound = null,
  remediationMaxRounds = null,
  blockingFindingCount = 0,
  blockingFindingState = 'known',
  reviewFailureClass = null,
  reviewFailureExhausted = false,
  prUpdatedAt = null,
  operatorApproval = null,
  mergeAgentRequest = null,
  execFileImpl = execFileAsync,
  ghExecFileImpl = execFileAsync,
  now = isoNow(),
  hqPath = DEFAULT_HQ_PATH,
  agentOsDetectImpl = detectAgentOsPresence,
  prepareOriginalWorkerImpl = prepareOriginalWorkerForMergeAgent,
  dispatchRetryDelaysMs = HQ_DISPATCH_TRANSIENT_RETRY_DELAYS_MS,
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
    latestFollowUpReReviewRequested,
    remediationCurrentRound,
    remediationMaxRounds,
    blockingFindingCount,
    blockingFindingState,
    reviewFailureClass,
    reviewFailureExhausted,
    prUpdatedAt,
    operatorApproval,
    mergeAgentRequest,
  };
  const recordedDispatch = getRecordedMergeAgentDispatch(rootDir, job);
  let duplicateDispatches = recordedDispatch ? [recordedDispatch] : [];
  const labelNames = normalizeLabelNames(labels);
  const scopedMergeAgentRetryRequested = labelNames.includes(MERGE_AGENT_REQUESTED_LABEL)
    && isScopedMergeAgentRequest(job);
  const ownerResolution = resolveHqOwner(resolveHqRoot(runtimeEnv));
  const statusProbeAsOwner = ownerResolution?.ownerUser || null;
  const hasPendingLabelAddCleanup = hasPendingDispatchedLabelAddCleanup(rootDir, job, { logger });

  // Watcher owns its worker's outcome. Probe the recorded dispatch's REAL status
  // every tick (not only when an operator label is present) so a worker that
  // came back failed doesn't sit forever behind `skip-already-dispatched`. The
  // probe passes --as-owner so the cross-account (HQ-root-owned) status is
  // visible; without it the watcher only ever sees "no dispatch with id" for its
  // own airlock-owned worker. Recovery-first + bounded so this can never become
  // an unbounded re-dispatch loop (cf. the 2026-05-24 reap storm).
  const recordedDispatchStatus = recordedDispatch?.launchRequestId
    ? await probeDispatchStatusViaHq({
        hqPath: runtimeEnv.HQ_BIN || hqPath,
        lrq: recordedDispatch.launchRequestId,
        asOwner: statusProbeAsOwner,
        execFileImpl,
        env: runtimeEnv,
      })
    : null;
  let latestRecordedDispatch = recordedDispatch;
  if (latestRecordedDispatch?.phantomHandoffCommentDelivery?.posted === false) {
    let stuckReady = labelNames.includes(MERGE_AGENT_STUCK_LABEL);
    if (!stuckReady) {
      stuckReady = await applyMergeAgentStuckLabel({
        repo,
        prNumber,
        labels: labelNames,
        ghExecFileImpl,
        logger,
      });
    }
    if (stuckReady) {
      latestRecordedDispatch = await retryPendingPhantomHandoffComment({
        rootDir,
        job,
        recordedDispatch: latestRecordedDispatch,
        dispatchStatus: recordedDispatchStatus?.status || latestRecordedDispatch?.phantomHandoffCommentDelivery?.context?.dispatchStatus || null,
        execFileImpl: ghExecFileImpl,
        env: runtimeEnv,
        logger,
        now,
      });
    }
  }

  // Threaded into recordMergeAgentDispatch so the per-(PR, head SHA) re-dispatch
  // budget survives across watcher ticks.
  let watcherReDispatchCountForRecord = null;
  if (latestRecordedDispatch && isRetryableRecordedDispatchStatus(recordedDispatchStatus?.status)) {
    // The merge-agent clears its own `merge-agent-dispatched` marker when it
    // hands off to a recovery worker or applies `merge-agent-stuck`. So if the
    // marker is STILL set while the dispatch reads terminal-failed, the worker
    // died WITHOUT handing off (the #849-class gap) and the watcher must own the
    // retry. If the marker is already cleared, the merge-agent escalated on its
    // own (recovery owns it, or operator-stuck) — recovery-first means do NOT
    // re-dispatch over that.
    const diedWithoutHandoff = labelNames.includes(MERGE_AGENT_DISPATCHED_LABEL) || hasPendingLabelAddCleanup;
    const priorReDispatches = Number(latestRecordedDispatch.watcherReDispatchCount || 0);
    if (scopedMergeAgentRetryRequested) {
      // Operator escape-hatch: force a re-dispatch regardless of the bound.
      // Does not consume the auto-budget (operator intent is explicit).
      duplicateDispatches = [];
      watcherReDispatchCountForRecord = priorReDispatches;
      mergeAgentLifecycleLog(logger, 'merge_agent.retrying_failed_dispatch', {
        repo,
        prNumber,
        launchRequestId: latestRecordedDispatch.launchRequestId,
        previousStatus: recordedDispatchStatus.status,
        previousTrigger: latestRecordedDispatch.trigger || null,
        retryTrigger: MERGE_AGENT_REQUESTED_LABEL,
        reDispatchCount: priorReDispatches,
        at: now,
      });
    } else if (
      diedWithoutHandoff
      && isWatcherAutonomousRetryableRecordedDispatchStatus(recordedDispatchStatus?.status)
      && priorReDispatches < _WATCHER_REDISPATCH_BOUND
    ) {
      // Auto-own the retry, bounded per head SHA.
      duplicateDispatches = [];
      watcherReDispatchCountForRecord = priorReDispatches + 1;
      mergeAgentLifecycleLog(logger, 'merge_agent.watcher_owned_redispatch', {
        repo,
        prNumber,
        launchRequestId: latestRecordedDispatch.launchRequestId,
        previousStatus: recordedDispatchStatus.status,
        previousTrigger: latestRecordedDispatch.trigger || null,
        reDispatchCount: priorReDispatches + 1,
        bound: _WATCHER_REDISPATCH_BOUND,
        at: now,
      });
    } else if (diedWithoutHandoff && isWatcherAutonomousRetryableRecordedDispatchStatus(recordedDispatchStatus?.status)) {
      // Bound exhausted, still no clean handoff: hand the PR to the operator
      // with a durable terminal marker instead of looping. Best-effort — if the
      // label add fails the dispatch simply stays in skip-already-dispatched
      // (still no loop).
      mergeAgentLifecycleLog(logger, 'merge_agent.watcher_redispatch_exhausted', {
        repo,
        prNumber,
        launchRequestId: latestRecordedDispatch.launchRequestId,
        previousStatus: recordedDispatchStatus.status,
        reDispatchCount: priorReDispatches,
        bound: _WATCHER_REDISPATCH_BOUND,
        at: now,
      });
      await applyMergeAgentStuckLabel({
        repo,
        prNumber,
        labels: labelNames,
        ghExecFileImpl,
        logger,
      });
    } else if (
      !diedWithoutHandoff
      && isWatcherAutonomousRetryableRecordedDispatchStatus(recordedDispatchStatus?.status)
      && !labelNames.includes(MERGE_AGENT_STUCK_LABEL)
    ) {
      // Phantom handoff (#969-class orphan). The `merge-agent-dispatched` marker
      // is cleared — which the branches above and scanStuckMergeAgentDispatches
      // both read as "recovery owns it now" — yet the recorded dispatch is
      // terminal-failed, the PR is still open, there is no `merge-agent-stuck`
      // marker (a genuine baseline-repair wait carries one), and the grace
      // window for a real recovery to merge / push a new head / mark the PR has
      // elapsed. The handoff never established recovery (e.g. a
      // validation-upstream-failed classification was flattened to
      // worker_crashed, so no baseline-repair worker was ever dispatched).
      // Without this branch the PR sits invisibly behind skip-already-dispatched
      // forever and only a hand-merge clears it. Fail loud: mark it
      // merge-agent-stuck so it surfaces in the operator stuck queue, and post a
      // durable explanatory comment. We deliberately do NOT re-dispatch or
      // merge — escalation only — so recovery-first still holds within the grace
      // window and the CPA-08 premature-merge guard stays intact.
      latestRecordedDispatch = await reconcilePhantomHandoffEscalation({
        rootDir,
        job,
        recordedDispatch: latestRecordedDispatch,
        dispatchStatus: recordedDispatchStatus.status,
        labels,
        ghExecFileImpl,
        logger,
        env: runtimeEnv,
        now,
      });
    }
  }
  const recentDispatchesForDecision = duplicateDispatches.length === 0
    ? []
    : (latestRecordedDispatch ? [latestRecordedDispatch] : duplicateDispatches);
  const dispatchDecision = pickMergeAgentDispatchDetail(job, {
    recentDispatches: recentDispatchesForDecision,
    // Honor the merged runtime env so callers can opt-in per-invocation
    // without mutating process.env globally. This keeps the flag consistent
    // with the rest of dispatchMergeAgentForPR (agent-os detection, parent
    // session, project) which already routes through runtimeEnv.
    finalPassOnRequestChangesEnabled: isFinalPassOnRequestChangesEnabled({ env: runtimeEnv }),
  });
  const { decision, trigger } = dispatchDecision;
  if (decision !== 'dispatch') {
    if (decision === 'skip-already-dispatched' && latestRecordedDispatch?.trigger) {
      const labelRemoval = await removeConsumedTriggerLabel({
        repo,
        prNumber,
        labels,
        trigger: latestRecordedDispatch.trigger,
        ghExecFileImpl,
        now,
      });
      if (labelRemoval.attempted) {
        updateMergeAgentDispatchLabelRemoval(rootDir, job, {
          recordedDispatch: latestRecordedDispatch,
          trigger: latestRecordedDispatch.trigger,
          attemptedAt: labelRemoval.labelRemovalAttempt.attemptedAt,
          removed: labelRemoval.labelRemovalAttempt.removed,
          error: labelRemoval.labelRemovalAttempt.error,
        });
      } else if (
        latestRecordedDispatch.labelRemoval?.removed !== true
        && !normalizeLabelNames(labels).includes(latestRecordedDispatch.trigger)
      ) {
        updateMergeAgentDispatchLabelRemoval(rootDir, job, {
          recordedDispatch: latestRecordedDispatch,
          trigger: latestRecordedDispatch.trigger,
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
      const stuckDetail = describeStaleDispatch(latestRecordedDispatch, {
        hqRoot: hqRootForAudit || null,
        now: Date.parse(String(now)) || Date.now(),
        dispatchStateProbe: hqPath && _isValidLrqId(latestRecordedDispatch?.launchRequestId)
          ? (lrqArg) => _probeDispatchStatusViaHq({
              hqPath,
              lrq: lrqArg,
              asOwner: statusProbeAsOwner,
              execFileImpl,
              env: runtimeEnv,
            })
          : null,
      });
      if (stuckDetail) {
        mergeAgentLifecycleLog(logger, 'merge_agent.stuck_pre_spawn', {
          repo,
          prNumber,
          launchRequestId: latestRecordedDispatch.launchRequestId,
          dispatchedAt: latestRecordedDispatch.dispatchedAt,
          trigger: latestRecordedDispatch.trigger,
          stuckForMinutes: stuckDetail.stuckForMinutes,
          refusalCount: stuckDetail.refusalCount,
          primaryReason: stuckDetail.primaryReason,
          lastRefusedAt: stuckDetail.lastRefusedAt,
        });
      }
      return {
        decision,
        trigger: latestRecordedDispatch.trigger,
        labelRemovalRetried: labelRemoval.attempted,
        operatorApprovalLabelRemoved: labelRemoval.operatorApprovalLabelRemoved,
        mergeAgentRequestedLabelRemoved: labelRemoval.mergeAgentRequestedLabelRemoved,
        labelRemovalErrors: labelRemoval.labelRemovalErrors,
        stuckDetail,
      };
    }
    if (decision === 'skip-blockers-present' || decision === 'skip-blocking-findings-unknown') {
      // Standing blocking findings — the pipeline refuses to auto-merge
      // (root-cause gate for #901, shared by final-pass and timeout-exhaustion
      // handoffs). Surface it as a durable,
      // queryable lifecycle event so the operator can see why automation parked
      // this PR. No sticky label is applied: the gate is recomputed every tick
      // and auto-resumes once the blockers clear (verdict → `Comment only`) or
      // the operator applies `operator-approved` to accept them.
      const blockingFindingCount = Number(job?.blockingFindingCount) || 0;
      const blockingFindingState = String(job?.blockingFindingState || 'known').trim().toLowerCase();
      const skippedRecordPath = recordMergeAgentSkippedDispatch(rootDir, job, {
        skippedAt: now,
        decision,
        trigger: trigger || null,
        blockingFindingCount,
        blockingFindingState,
        ...(trigger === REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER
          ? {
              reviewerFailureClass: job?.reviewFailureClass || null,
              reviewerFailureExhausted: Boolean(job?.reviewFailureExhausted),
            }
          : {}),
      });
      mergeAgentLifecycleLog(logger, decision === 'skip-blocking-findings-unknown'
        ? 'merge_agent.blocking_findings_unknown_handoff'
        : 'merge_agent.blockers_present_handoff', {
        repo,
        prNumber,
        headSha: job?.headSha || null,
        trigger: trigger || null,
        blockingFindingCount,
        blockingFindingState,
        skippedRecordPath,
        at: now,
      });
      return {
        decision,
        trigger: trigger || null,
        blockingFindingCount,
        blockingFindingState,
        ...(trigger === REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER
          ? {
              reviewerFailureClass: job?.reviewFailureClass || null,
              reviewerFailureExhausted: Boolean(job?.reviewFailureExhausted),
            }
          : {}),
        skippedRecordPath,
      };
    }
    if (trigger === REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER) {
      const skippedRecordPath = recordMergeAgentSkippedDispatch(rootDir, job, {
        skippedAt: now,
        decision,
        trigger,
        reviewerFailureClass: job?.reviewFailureClass || null,
        reviewerFailureExhausted: Boolean(job?.reviewFailureExhausted),
      });
      mergeAgentLifecycleLog(logger, 'merge_agent.reviewer_timeout_handoff_blocked', {
        repo,
        prNumber,
        headSha: job?.headSha || null,
        decision,
        trigger,
        mergeable: job?.mergeable || null,
        checksConclusion: job?.checksConclusion || null,
        skippedRecordPath,
        at: now,
      });
      return {
        decision,
        trigger,
        reviewerFailureClass: job?.reviewFailureClass || null,
        reviewerFailureExhausted: Boolean(job?.reviewFailureExhausted),
        skippedRecordPath,
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
  const dispatchPriority = resolveMergeAgentDispatchPriority(trigger);

  // `merge-agent-requested` is the explicit stuck-branch escape hatch, so it
  // alone gets the reserved `critical` lane. Everything else stays `normal`:
  // final-pass and clean-verdict merge-agents can run for minutes, push new
  // commits, and wait on checks, so reserving the single memory-pressure-bypass
  // slot for all of them would turn a PR-local delay into fleet-wide critical
  // lane starvation.
  //
  // Observed 2026-05-19: PR #719's merge-agent-requested dispatch was refused
  // for memory pressure across multiple admission ticks and never spawned. The
  // operator-requested stuck-branch path is the load-bearing case that needs
  // bypass semantics; broadening that escape hatch to every merge-agent launch
  // is not.
  const hqDispatchHeadArgs = [
    'dispatch',
    '--worker-class', 'merge-agent',
    '--task-kind', 'merge',
  ];
  const hqDispatchTailArgs = [
    '--repo', repo.split('/')[1] || repo,
    '--pr', String(prNumber),
    '--ticket', `PR-${prNumber}`,
    '--parent-session', parentSession,
    '--project', hqProject,
    '--prompt', promptPath,
  ];
  const args = [...hqDispatchHeadArgs, ...hqDispatchTailArgs];
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
  let priorityFlagSupported = true;
  const argsWithPriority = [
    ...hqDispatchHeadArgs,
    '--priority', dispatchPriority,
    ...hqDispatchTailArgs,
  ];
  let activeArgs = argsWithPriority;
  let transientRetryIndex = 0;
  for (;;) {
    try {
      execResult = await execFileImpl(resolvedHqPath, activeArgs, {
        env: dispatchEnv,
        maxBuffer: 5 * 1024 * 1024,
        timeout: HQ_DISPATCH_TIMEOUT_MS,
        killSignal: 'SIGTERM',
      });
      break;
    } catch (err) {
      if (activeArgs === argsWithPriority && isUnsupportedHqPriorityFlagError(err)) {
        priorityFlagSupported = false;
        activeArgs = args;
        transientRetryIndex = 0;
        continue;
      }
      if (isTransientHqDispatchError(err) && transientRetryIndex < dispatchRetryDelaysMs.length) {
        const delayMs = Number(dispatchRetryDelaysMs[transientRetryIndex]) || 0;
        transientRetryIndex += 1;
        await sleep(delayMs);
        continue;
      }
      throw formatExecFailure('hq dispatch', err);
    }
  }
  const { stdout } = execResult;
  const parsed = parseMergeAgentDispatchOutput(stdout);

  recordMergeAgentDispatch(rootDir, job, {
    dispatchedAt: now,
    prompt,
    dispatchId: parsed?.dispatchId || null,
    launchRequestId: parsed?.lrq || parsed?.launchRequestId || null,
    trigger,
    priority: dispatchPriority,
    priorityFlagSupported,
    // Carry the watcher-owned re-dispatch budget forward (0 for a fresh
    // dispatch). When this dispatch is a watcher-owned retry of a died-without-
    // handoff worker, watcherReDispatchCountForRecord is the incremented count.
    watcherReDispatchCount: watcherReDispatchCountForRecord ?? 0,
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

function resolveFastMergePerPollCap(env = process.env) {
  const raw = env?.[FML_MERGE_AGENT_PER_POLL_CAP_ENV];
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP;
  }
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP;
}

function buildFastMergeCloseAuditEntry({
  action,
  repo,
  prNumber,
  authorizedHeadSha = null,
  currentHeadSha = null,
  mergedHeadSha = null,
  mergeSha = null,
  manualMergeDetected = false,
  closedWithoutMerge = false,
  failureReason = null,
  checkConclusions = null,
  headChanged = false,
  vetoDetected = false,
  labelRemoved = false,
  requeuePath = null,
  requeueResult = null,
  mergeStdout = null,
  mergeStderr = null,
  at = isoNow(),
} = {}) {
  const sessionUuid = `fast-merge-${action}-${randomUUID()}`;
  return {
    kind: 'fast-merge-audit',
    schemaVersion: 1,
    auditType: 'fast-merge-close',
    sessionUuid,
    fast_merge: true,
    action,
    repo,
    pr_number: prNumber,
    authorized_head_sha: authorizedHeadSha,
    fast_merge_authorized_head_sha: authorizedHeadSha,
    current_head_sha: currentHeadSha,
    merged_head_sha: mergedHeadSha,
    merge_sha: mergeSha,
    manual_merge_detected: Boolean(manualMergeDetected),
    closed_without_merge: Boolean(closedWithoutMerge),
    failure_reason: failureReason,
    check_conclusions: checkConclusions,
    head_changed: Boolean(headChanged),
    veto_detected: Boolean(vetoDetected),
    label_removed: Boolean(labelRemoved),
    requeue_path: requeuePath,
    requeue_result: requeueResult,
    merge_stdout: mergeStdout,
    merge_stderr: mergeStderr,
    recorded_at: at,
  };
}

function writeFastMergeCloseAuditEntry(rootDir, entry) {
  mkdirSync(fastMergeAuditDir(rootDir), { recursive: true });
  const filePath = fastMergeAuditPath(rootDir, {
    repo: entry?.repo,
    prNumber: entry?.pr_number,
    action: entry?.action || 'unknown',
    at: entry?.recorded_at,
  });
  writeFileAtomic(filePath, `${JSON.stringify(entry, null, 2)}\n`);
  return filePath;
}

function recordFastMergeCloseAuditPending(db, { repo, prNumber, entry, err } = {}) {
  if (!db || typeof db.prepare !== 'function') return false;
  db.prepare(
    `UPDATE reviewed_prs
        SET fast_merge_audit_status = 'pending',
            fast_merge_audit_payload_json = ?,
            fast_merge_audit_error = ?
      WHERE repo = ?
        AND pr_number = ?`
  ).run(
    JSON.stringify(entry),
    String(err?.message || err || 'unknown audit write failure'),
    repo,
    prNumber
  );
  return true;
}

async function writeFastMergeAudit({
  db = null,
  rootDir,
  auditWriter,
  logger = console,
  entry,
} = {}) {
  try {
    if (typeof auditWriter === 'function') {
      await auditWriter(entry);
      return true;
    }
    writeFastMergeCloseAuditEntry(rootDir, entry);
    return true;
  } catch (err) {
    logger?.error?.(
      `[follow-up-merge-agent] fast-merge audit write failed for ${entry?.repo}#${entry?.pr_number}: ${err?.message || err}`
    );
    recordFastMergeCloseAuditPending(db, {
      repo: entry?.repo,
      prNumber: entry?.pr_number,
      entry,
      err,
    });
    return false;
  }
}

function execFileFromGhClient(ghClient) {
  if (typeof ghClient === 'function') return ghClient;
  if (typeof ghClient?.execFile === 'function') return ghClient.execFile.bind(ghClient);
  if (typeof ghClient?.execFileImpl === 'function') return ghClient.execFileImpl.bind(ghClient);
  return execFileAsync;
}

function isRetryableGhTransportError(err) {
  if (isExecTimeout(err)) return true;
  const detail = [
    err?.code,
    err?.message,
    err?.stderr,
    err?.stdout,
  ].filter(Boolean).join('\n').toLowerCase();
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eai_again|enotfound|epipe|eagain)\b/.test(detail)
    || detail.includes('timeout')
    || detail.includes('timed out')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable')
    || detail.includes('rate limit')
    || detail.includes('secondary rate limit')
    || detail.includes('502 bad gateway')
    || detail.includes('503 service unavailable')
    || detail.includes('504 gateway timeout');
}

async function withGhRetry(operation, {
  retryDelaysMs = FAST_MERGE_GH_RETRY_DELAYS_MS,
  isRetryable = isRetryableGhTransportError,
} = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= retryDelaysMs.length) {
        throw err;
      }
      await sleep(retryDelaysMs[attempt]);
    }
  }
  throw lastErr;
}

function parseGhJson(stdout, fallback = {}) {
  return JSON.parse(String(stdout || '').trim() || JSON.stringify(fallback));
}

function normalizePrView(parsed = {}) {
  const labels = Array.isArray(parsed.labels) ? parsed.labels : [];
  const state = String(parsed.state || '').trim().toUpperCase();
  return {
    state,
    isDraft: Boolean(parsed.isDraft),
    mergedAt: parsed.mergedAt || null,
    closedAt: parsed.closedAt || null,
    headRefOid: parsed.headRefOid || null,
    labels,
  };
}

async function fetchFastMergePrView({ ghClient, repo, prNumber }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  const { stdout } = await withGhRetry(() => execFileImpl('gh', [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'state,isDraft,mergedAt,closedAt,headRefOid,labels',
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: FAST_MERGE_GH_TIMEOUT_MS,
  }));
  return normalizePrView(parseGhJson(stdout));
}

async function fetchFastMergeMergeCommit({ ghClient, repo, prNumber }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  const { stdout } = await withGhRetry(() => execFileImpl('gh', [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repo,
    '--json',
    'mergeCommit',
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: FAST_MERGE_GH_TIMEOUT_MS,
  }));
  const parsed = parseGhJson(stdout, {});
  const oid = parsed?.mergeCommit?.oid;
  return oid ? String(oid) : null;
}

async function fetchFastMergeChecks({ ghClient, repo, prNumber }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  let stdout = '';
  try {
    ({ stdout } = await withGhRetry(() => execFileImpl('gh', [
      'pr',
      'checks',
      String(prNumber),
      '--repo',
      repo,
      '--json',
      'name,state,bucket,workflow,link',
    ], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: FAST_MERGE_GH_TIMEOUT_MS,
    })));
  } catch (err) {
    const code = Number(err?.code);
    if ((code === 1 || code === 8) && typeof err?.stdout === 'string' && err.stdout.trim()) {
      stdout = err.stdout;
    } else if (isNoChecksReportedGhError(err)) {
      stdout = '[]';
    } else {
      throw err;
    }
  }
  const parsed = parseGhJson(stdout, []);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.checks)) return parsed.checks;
  return [];
}

function isNoChecksReportedGhError(err) {
  const detail = [err?.message, err?.stderr, err?.stdout]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return detail.includes('no checks') && detail.includes('reported');
}

async function mergeFastMergePr({ ghClient, repo, prNumber, matchHeadCommit }) {
  const execFileImpl = execFileFromGhClient(ghClient);
  return withGhRetry(() => execFileImpl('gh', [
    'pr',
    'merge',
    String(prNumber),
    '--repo',
    repo,
    '--squash',
    '--admin',
    '--match-head-commit',
    String(matchHeadCommit),
    '--delete-branch',
  ], {
    maxBuffer: 5 * 1024 * 1024,
    timeout: FAST_MERGE_GH_TIMEOUT_MS,
  }));
}

function normalizeFastMergeLabelNames(labels) {
  return normalizeLabelNames(labels);
}

function hasFastMergeVeto(labels) {
  return normalizeFastMergeLabelNames(labels).includes(FAST_MERGE_VETO_LABEL);
}

function hasFastMergeAuthorizationLabel(labels) {
  return normalizeFastMergeLabelNames(labels)
    .some((label) => label.startsWith(FAST_MERGE_LABEL_PREFIX) && label !== FAST_MERGE_VETO_LABEL);
}

function checkIdentity(check, index) {
  return check?.name || check?.workflow || check?.link || `check-${index + 1}`;
}

function summarizeFastMergeChecks(checks) {
  const normalized = (Array.isArray(checks) ? checks : []).map((check, index) => {
    const conclusion = check?.conclusion == null
      ? null
      : String(check.conclusion).trim().toLowerCase();
    const state = check?.state == null
      ? null
      : String(check.state).trim().toLowerCase();
    const bucket = check?.bucket == null
      ? null
      : String(check.bucket).trim().toLowerCase();
    return {
      name: checkIdentity(check, index),
      conclusion,
      state,
      bucket,
    };
  });

  const failed = normalized.filter((check) => (
    FAST_MERGE_FAILURE_CONCLUSIONS.has(check.conclusion)
    || FAST_MERGE_FAILURE_CONCLUSIONS.has(check.state)
    || FAST_MERGE_FAILURE_CONCLUSIONS.has(check.bucket)
  ));
  if (failed.length > 0) {
    return {
      status: 'failed',
      totalCount: normalized.length,
      checkConclusions: normalized,
      failureMessage: `fast-merge CI failed: ${failed.map((check) => `${check.name}:${check.conclusion || check.state || check.bucket}`).join(', ')}`,
    };
  }

  const pending = normalized.filter((check) => {
    if (check.conclusion === null) {
      if (check.state == null) return true;
      if (FAST_MERGE_PENDING_STATES.has(check.state)) return true;
      if (check.bucket != null && FAST_MERGE_PENDING_STATES.has(check.bucket)) return true;
      if (!FAST_MERGE_SUCCESS_CONCLUSIONS.has(check.state) && !FAST_MERGE_SUCCESS_CONCLUSIONS.has(check.bucket)) {
        return true;
      }
    }
    if (check.conclusion != null && FAST_MERGE_PENDING_STATES.has(check.conclusion)) return true;
    if (check.state != null && FAST_MERGE_PENDING_STATES.has(check.state)) return true;
    if (check.bucket != null && FAST_MERGE_PENDING_STATES.has(check.bucket)) return true;
    return false;
  });
  if (pending.length > 0 && normalized.length > 0) {
    return {
      status: 'pending',
      totalCount: normalized.length,
      checkConclusions: normalized,
      failureMessage: null,
    };
  }

  const unexpected = normalized.filter((check) => (
    check.conclusion && !FAST_MERGE_SUCCESS_CONCLUSIONS.has(check.conclusion)
  ));
  if (unexpected.length > 0) {
    return {
      status: 'failed',
      totalCount: normalized.length,
      checkConclusions: normalized,
      failureMessage: `fast-merge CI not successful: ${unexpected.map((check) => `${check.name}:${check.conclusion}`).join(', ')}`,
    };
  }

  return {
    status: 'success',
    totalCount: normalized.length,
    checkConclusions: normalized,
    failureMessage: null,
  };
}

function updateFastMergeTerminalState(db, {
  state,
  repo,
  prNumber,
  at = isoNow(),
  failureMessage = null,
}) {
  if (state === FAST_MERGE_MERGED_STATE) {
    db.prepare(
      `UPDATE reviewed_prs
          SET pr_state = ?,
              review_status = ?,
              merged_at = COALESCE(merged_at, ?),
              failure_message = NULL
        WHERE repo = ?
          AND pr_number = ?
          AND pr_state = ?`
    ).run(state, state, at, repo, prNumber, FAST_MERGE_SKIPPED_STATE);
    return;
  }
  if (state === FAST_MERGE_CLOSED_STATE) {
    db.prepare(
      `UPDATE reviewed_prs
          SET pr_state = ?,
              review_status = ?,
              closed_at = COALESCE(closed_at, ?),
              failure_message = NULL
        WHERE repo = ?
          AND pr_number = ?
          AND pr_state = ?`
    ).run(state, state, at, repo, prNumber, FAST_MERGE_SKIPPED_STATE);
    return;
  }
  if (state === FAST_MERGE_BLOCKED_STATE) {
    db.prepare(
      `UPDATE reviewed_prs
          SET pr_state = ?,
              review_status = ?,
              failed_at = ?,
              failure_message = ?
        WHERE repo = ?
          AND pr_number = ?
          AND pr_state = ?`
    ).run(state, state, at, failureMessage || 'fast-merge blocked', repo, prNumber, FAST_MERGE_SKIPPED_STATE);
  }
}

function requeueFastMergeForNormalReview(db, {
  rootDir,
  repo,
  prNumber,
  reason,
  requestedAt = isoNow(),
}) {
  return requestReviewRereview({
    rootDir,
    repo,
    prNumber,
    requestedAt,
    reason,
    allowFastMergeSkipped: true,
    db,
  });
}

async function auditAndRequeueFastMerge({
  db,
  rootDir,
  ghClient,
  repo,
  prNumber,
  authorizedHeadSha,
  currentHeadSha,
  labels = [],
  reason,
  action,
  headChanged = false,
  vetoDetected = false,
  labelRemoved = false,
  auditWriter,
  logger = console,
}) {
  const requeuedAt = isoNow();
  const requeuePath = 'retrigger_helper';
  const initialEntry = buildFastMergeCloseAuditEntry({
    action,
    repo,
    prNumber,
    authorizedHeadSha,
    currentHeadSha,
    headChanged,
    vetoDetected,
    labelRemoved,
    requeuePath,
    requeueResult: {
      triggered: false,
      status: 'attempting',
      reason,
    },
    at: requeuedAt,
  });
  await writeFastMergeAudit({ db, rootDir, auditWriter, logger, entry: initialEntry });
  const requeueResult = requeueFastMergeForNormalReview(db, {
    rootDir,
    repo,
    prNumber,
    reason,
    requestedAt: requeuedAt,
  });
  const finalEntry = {
    ...initialEntry,
    labels,
    requeue_result: {
      triggered: Boolean(requeueResult?.triggered),
      status: requeueResult?.status || null,
      reason: requeueResult?.reason || null,
    },
    requeueResult: undefined,
  };
  await writeFastMergeAudit({ db, rootDir, auditWriter, logger, entry: finalEntry });
  return {
    status: headChanged ? 'requeued_head_change' : (labelRemoved ? 'requeued_label_removed' : 'requeued_veto'),
    requeueResult,
  };
}

async function fetchAndSummarizeFastMergeChecks({ ghClient, repo, prNumber, logger = console } = {}) {
  try {
    const checks = await fetchFastMergeChecks({ ghClient, repo, prNumber });
    return { ok: true, checks, summary: summarizeFastMergeChecks(checks) };
  } catch (err) {
    logger?.warn?.(
      `[follow-up-merge-agent] fast-merge checks unavailable for ${repo}#${prNumber}; leaving skipped: ${err?.message || err}`
    );
    return { ok: false, reason: 'checks-transport-failed', err };
  }
}

async function processFastMergePR({
  db,
  ghClient = execFileAsync,
  rootDir = process.cwd(),
  repo,
  prNumber,
  authorizedHeadSha,
  auditWriter = null,
  logger = console,
} = {}) {
  const firstView = await fetchFastMergePrView({ ghClient, repo, prNumber });
  if (firstView.state === 'MERGED' || firstView.mergedAt) {
    const at = firstView.mergedAt || isoNow();
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_MERGED_STATE,
      repo,
      prNumber,
      at,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'merged',
        repo,
        prNumber,
        authorizedHeadSha,
        currentHeadSha: firstView.headRefOid,
        mergedHeadSha: firstView.headRefOid,
        manualMergeDetected: true,
        at,
      }),
    });
    return { status: 'merged', manualMergeDetected: true };
  }
  if (firstView.state === 'CLOSED') {
    const at = firstView.closedAt || isoNow();
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_CLOSED_STATE,
      repo,
      prNumber,
      at,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'closed',
        repo,
        prNumber,
        authorizedHeadSha,
        currentHeadSha: firstView.headRefOid,
        closedWithoutMerge: true,
        failureReason: 'PR closed without merge',
        at,
      }),
    });
    return { status: 'closed' };
  }

  if (!authorizedHeadSha || String(firstView.headRefOid || '') !== String(authorizedHeadSha)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha,
      currentHeadSha: firstView.headRefOid || null,
      labels: firstView.labels,
      reason: `fast-merge head changed: authorized ${authorizedHeadSha || 'missing'}; current ${firstView.headRefOid || 'missing'}`,
      action: 'head-changed-requeued',
      headChanged: true,
      auditWriter,
      logger,
    });
  }

  if (hasFastMergeVeto(firstView.labels)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha,
      currentHeadSha: firstView.headRefOid || null,
      labels: firstView.labels,
      reason: 'fast-merge veto label detected; requeueing normal first-pass review',
      action: 'veto-requeued',
      vetoDetected: true,
      auditWriter,
      logger,
    });
  }

  if (!hasFastMergeAuthorizationLabel(firstView.labels)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha,
      currentHeadSha: firstView.headRefOid || null,
      labels: firstView.labels,
      reason: 'fast-merge authorization label absent; requeueing normal first-pass review',
      action: 'label-removed-requeued',
      labelRemoved: true,
      auditWriter,
      logger,
    });
  }

  const initialChecks = await fetchAndSummarizeFastMergeChecks({ ghClient, repo, prNumber, logger });
  if (!initialChecks.ok) return { status: 'skipped_still_pending', reason: initialChecks.reason };
  const checkSummary = initialChecks.summary;
  if (checkSummary.status === 'failed') {
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_BLOCKED_STATE,
      repo,
      prNumber,
      failureMessage: checkSummary.failureMessage,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'blocked',
        repo,
        prNumber,
        authorizedHeadSha,
        currentHeadSha: firstView.headRefOid,
        failureReason: checkSummary.failureMessage,
        checkConclusions: checkSummary.checkConclusions,
      }),
    });
    return { status: 'blocked', reason: 'ci-failed' };
  }
  if (checkSummary.status === 'pending') {
    return { status: 'skipped_still_pending', reason: 'ci-pending' };
  }

  const preMergeView = await fetchFastMergePrView({ ghClient, repo, prNumber });
  if (!authorizedHeadSha || String(preMergeView.headRefOid || '') !== String(authorizedHeadSha)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha,
      currentHeadSha: preMergeView.headRefOid || null,
      labels: preMergeView.labels,
      reason: `fast-merge head changed before merge: authorized ${authorizedHeadSha || 'missing'}; current ${preMergeView.headRefOid || 'missing'}`,
      action: 'head-changed-requeued',
      headChanged: true,
      auditWriter,
      logger,
    });
  }
  if (hasFastMergeVeto(preMergeView.labels)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha,
      currentHeadSha: preMergeView.headRefOid || null,
      labels: preMergeView.labels,
      reason: 'fast-merge veto label detected before merge; requeueing normal first-pass review',
      action: 'veto-requeued',
      vetoDetected: true,
      auditWriter,
      logger,
    });
  }
  if (!hasFastMergeAuthorizationLabel(preMergeView.labels)) {
    return auditAndRequeueFastMerge({
      db,
      rootDir,
      ghClient,
      repo,
      prNumber,
      authorizedHeadSha,
      currentHeadSha: preMergeView.headRefOid || null,
      labels: preMergeView.labels,
      reason: 'fast-merge authorization label absent before merge; requeueing normal first-pass review',
      action: 'label-removed-requeued',
      labelRemoved: true,
      auditWriter,
      logger,
    });
  }

  const preMergeChecks = await fetchAndSummarizeFastMergeChecks({ ghClient, repo, prNumber, logger });
  if (!preMergeChecks.ok) return { status: 'skipped_still_pending', reason: preMergeChecks.reason };
  if (preMergeChecks.summary.status === 'failed') {
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_BLOCKED_STATE,
      repo,
      prNumber,
      failureMessage: preMergeChecks.summary.failureMessage,
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'blocked',
        repo,
        prNumber,
        authorizedHeadSha,
        currentHeadSha: preMergeView.headRefOid,
        failureReason: preMergeChecks.summary.failureMessage,
        checkConclusions: preMergeChecks.summary.checkConclusions,
      }),
    });
    return { status: 'blocked', reason: 'ci-failed-before-merge' };
  }
  if (preMergeChecks.summary.status === 'pending') {
    return { status: 'skipped_still_pending', reason: 'ci-pending-before-merge' };
  }

  let mergeResult;
  try {
    mergeResult = await mergeFastMergePr({
      ghClient,
      repo,
      prNumber,
      matchHeadCommit: authorizedHeadSha,
    });
  } catch (err) {
    if (isRetryableGhTransportError(err)) {
      logger?.warn?.(
        `[follow-up-merge-agent] fast-merge transport failure exhausted for ${repo}#${prNumber}; leaving skipped: ${err?.message || err}`
      );
      return { status: 'skipped_still_pending', reason: 'merge-transport-failed' };
    }
    let postMergeView;
    try {
      postMergeView = await fetchFastMergePrView({ ghClient, repo, prNumber });
    } catch (viewErr) {
      if (isRetryableGhTransportError(viewErr)) {
        logger?.warn?.(
          `[follow-up-merge-agent] fast-merge post-merge verification unavailable for ${repo}#${prNumber}; leaving skipped: ${viewErr?.message || viewErr}`
        );
        return { status: 'skipped_still_pending', reason: 'merge-postcheck-transport-failed' };
      }
      throw viewErr;
    }
    if (postMergeView.state === 'MERGED' || postMergeView.mergedAt) {
      const mergedAt = postMergeView.mergedAt || isoNow();
      let mergeSha = null;
      try {
        mergeSha = await fetchFastMergeMergeCommit({ ghClient, repo, prNumber });
      } catch {}
      updateFastMergeTerminalState(db, {
        state: FAST_MERGE_MERGED_STATE,
        repo,
        prNumber,
        at: mergedAt,
      });
      await writeFastMergeAudit({
        db,
        rootDir,
        auditWriter,
        logger,
        entry: buildFastMergeCloseAuditEntry({
          action: 'merged',
          repo,
          prNumber,
          authorizedHeadSha,
          currentHeadSha: postMergeView.headRefOid || preMergeView.headRefOid,
          mergedHeadSha: postMergeView.headRefOid || authorizedHeadSha,
          mergeSha,
          manualMergeDetected: true,
          checkConclusions: checkSummary.checkConclusions,
          mergeStderr: err?.stderr || null,
          mergeStdout: err?.stdout || null,
          at: mergedAt,
        }),
      });
      return { status: 'merged', manualMergeDetected: true };
    }
    const detail = String(err?.stderr || err?.stdout || err?.message || err).trim();
    updateFastMergeTerminalState(db, {
      state: FAST_MERGE_BLOCKED_STATE,
      repo,
      prNumber,
      failureMessage: detail || 'GitHub refused fast-merge',
    });
    await writeFastMergeAudit({
      db,
      rootDir,
      auditWriter,
      logger,
      entry: buildFastMergeCloseAuditEntry({
        action: 'blocked',
        repo,
        prNumber,
        authorizedHeadSha,
        currentHeadSha: preMergeView.headRefOid,
        failureReason: detail || 'GitHub refused fast-merge',
        checkConclusions: checkSummary.checkConclusions,
        mergeStderr: err?.stderr || null,
        mergeStdout: err?.stdout || null,
      }),
    });
    return { status: 'blocked', reason: 'merge-refused' };
  }

  const mergedAt = isoNow();
  let mergeSha = null;
  try {
    mergeSha = await fetchFastMergeMergeCommit({ ghClient, repo, prNumber });
  } catch {}
  updateFastMergeTerminalState(db, {
    state: FAST_MERGE_MERGED_STATE,
    repo,
    prNumber,
    at: mergedAt,
  });
  await writeFastMergeAudit({
    db,
    rootDir,
    auditWriter,
    logger,
    entry: buildFastMergeCloseAuditEntry({
      action: 'merged',
      repo,
      prNumber,
      authorizedHeadSha,
      currentHeadSha: preMergeView.headRefOid,
      mergedHeadSha: authorizedHeadSha,
      mergeSha,
      checkConclusions: checkSummary.checkConclusions,
      mergeStdout: mergeResult?.stdout || null,
      mergeStderr: mergeResult?.stderr || null,
      at: mergedAt,
    }),
  });
  return { status: 'merged' };
}

async function pollFastMergeQueue({
  db,
  ghClient = execFileAsync,
  rootDir = process.cwd(),
  perPollCap = resolveFastMergePerPollCap(),
  repos = null,
  auditWriter = null,
  logger = console,
} = {}) {
  const cap = Number.isInteger(perPollCap) && perPollCap > 0
    ? perPollCap
    : DEFAULT_FML_MERGE_AGENT_PER_POLL_CAP;
  const repoSet = Array.isArray(repos) && repos.length > 0
    ? new Set(repos.map((repo) => String(repo)))
    : null;
  const repoFilter = repoSet ? [...repoSet] : [];
  const repoPredicate = repoFilter.length > 0
    ? ` AND repo IN (${repoFilter.map(() => '?').join(', ')})`
    : '';
  const rows = db.prepare(
    `SELECT id AS pass_id, repo, pr_number, fast_merge_authorized_head_sha
      FROM reviewed_prs
      WHERE pr_state = ?${repoPredicate}
      ORDER BY reviewed_at ASC, id ASC
      LIMIT ?`
  ).all(FAST_MERGE_SKIPPED_STATE, ...repoFilter, cap * 5);
  const summary = {
    processed: 0,
    merged: 0,
    blocked: 0,
    requeued_head_change: 0,
    requeued_veto: 0,
    requeued_label_removed: 0,
    skipped_still_pending: 0,
  };
  let terminalProgress = 0;
  for (const row of rows) {
    summary.processed += 1;
    try {
      const result = await processFastMergePR({
        db,
        ghClient,
        rootDir,
        repo: row.repo,
        prNumber: row.pr_number,
        authorizedHeadSha: row.fast_merge_authorized_head_sha,
        auditWriter,
        logger,
      });
      if (result?.status === 'merged') summary.merged += 1;
      else if (result?.status === 'blocked') summary.blocked += 1;
      else if (result?.status === 'requeued_head_change') summary.requeued_head_change += 1;
      else if (result?.status === 'requeued_veto') summary.requeued_veto += 1;
      else if (result?.status === 'requeued_label_removed') summary.requeued_label_removed += 1;
      else if (result?.status === 'skipped_still_pending') summary.skipped_still_pending += 1;
      if (result?.status && result.status !== 'skipped_still_pending') {
        terminalProgress += 1;
      }
    } catch (err) {
      logger?.error?.(
        `[follow-up-merge-agent] fast-merge processing failed for ${row.repo}#${row.pr_number}: ${err?.message || err}`
      );
      summary.skipped_still_pending += 1;
    }
    if (terminalProgress >= cap) break;
  }
  return summary;
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

// Standing blocking-finding state in a review body, used by the merge gate to
// refuse final-pass auto-merge (PR #901). Primary signal is the canonical
// structured parser; fail SAFE when the `## Blocking issues` section is present
// and is NOT the `- None.` sentinel but the structured parse yields nothing
// (e.g. a malformed/incomplete finding card) — treat it as one standing
// blocker so the gate refuses rather than auto-merging an unparseable section.
//
// Legacy `Request changes` reviews that predate the structured issue sections
// are different: blocker presence is unknowable, so the final-pass gate parks
// with `skip-blocking-findings-unknown` until a fresh structured review exists
// or an operator applies a scoped override.
function classifyBlockingFindings(reviewBody, { lastVerdict = null } = {}) {
  const parsed = parseBlockingFindingsSection(reviewBody);
  if (parsed && parsed.length > 0) {
    return { count: parsed.length, state: 'known' };
  }
  const match = String(reviewBody ?? '').match(/##\s+Blocking\s+Issues?\s*\n([\s\S]*?)(?=\n##\s+|$)/i);
  const normalizedVerdict = normalizeReviewVerdict(lastVerdict);
  if (!match) {
    return normalizedVerdict === 'request-changes'
      ? { count: 0, state: 'unknown' }
      : { count: 0, state: 'known' };
  }
  const section = match[1].trim();
  if (!section) return { count: 0, state: 'known' };
  const isNoneSentinelOnly = section
    .split('\n')
    .every((line) => {
      const trimmed = line.trim();
      return trimmed === '' || /^-\s+None\.?$/i.test(trimmed);
    });
  return isNoneSentinelOnly
    ? { count: 0, state: 'known' }
    : { count: 1, state: 'known' };
}

function readMergeAgentReviewFailureState(rootDir, { repo, prNumber } = {}) {
  return readMergeAgentReviewFailureStateWithDb(rootDir, null, { repo, prNumber });
}

function readMergeAgentReviewFailureStateWithDb(rootDir, reviewStateDb, { repo, prNumber } = {}) {
  let db = null;
  try {
    db = reviewStateDb || openReviewStateDb(rootDir);
    const row = getReviewRow(db, { repo, prNumber });
    const reviewStatus = String(row?.review_status || '').trim().toLowerCase();
    const failureClass = (reviewStatus === 'failed' || reviewStatus === 'pending-upstream')
      ? reviewerFailureClassFromStoredRow(row)
      : null;
    const cascadeState = failureClass === 'reviewer-timeout'
      ? readCascadeState(rootDir, { repo, prNumber })
      : null;
    const timeoutFailures = Number(cascadeState?.transientFailureBreakdown?.['reviewer-timeout'] || 0);
    return {
      reviewFailureClass: failureClass || null,
      reviewFailureExhausted: failureClass === 'reviewer-timeout' && timeoutFailures >= CASCADE_FAILURE_CAP,
      reviewStatus: row?.review_status || null,
    };
  } catch {
    return {
      reviewFailureClass: null,
      reviewFailureExhausted: false,
      reviewStatus: null,
    };
  } finally {
    try {
      if (!reviewStateDb) db?.close?.();
    } catch {}
  }
}

function buildMergeAgentDispatchJob(rootDir, candidate, { reviewStateDb = null } = {}) {
  const latestJob = findLatestFollowUpJobForPR(rootDir, {
    repo: candidate.repo,
    prNumber: candidate.prNumber,
    revisionRef: candidate.headSha,
  });
  const lastVerdict = extractReviewVerdict(latestJob?.reviewBody);
  const blockingFindings = classifyBlockingFindings(latestJob?.reviewBody, { lastVerdict });
  const reviewFailureState = readMergeAgentReviewFailureStateWithDb(rootDir, reviewStateDb, {
    repo: candidate.repo,
    prNumber: candidate.prNumber,
  });
  return {
    ...candidate,
    lastVerdict,
    // Count of standing blocking findings in the latest review (`- None.` → 0;
    // malformed non-None section → >=1; legacy Request changes body with no
    // structured section → state unknown). The merge gate refuses final-pass
    // auto-merge when the count is > 0 or the state is unknown (PR #901).
    blockingFindingCount: blockingFindings.count,
    blockingFindingState: blockingFindings.state,
    latestFollowUpJobStatus: normalizeFollowUpJobStatus(latestJob?.status),
    latestFollowUpReReviewRequested: latestJob?.reReview?.requested === true,
    remediationCurrentRound: Number(latestJob?.remediationPlan?.currentRound || 0),
    remediationMaxRounds: Number(latestJob?.remediationPlan?.maxRounds || 0),
    reviewFailureClass: reviewFailureState.reviewFailureClass,
    reviewFailureExhausted: reviewFailureState.reviewFailureExhausted,
    operatorApproval: buildScopedOperatorApproval(candidate, latestJob),
    mergeAgentRequest: buildScopedMergeAgentRequest(candidate),
  };
}

export {
  FINAL_PASS_ON_BUDGET_EXHAUSTED_TRIGGER,
  FINAL_PASS_ON_REQUEST_CHANGES_ENV,
  HQ_DISPATCH_TIMEOUT_MS,
  HQ_WORKER_TEAR_DOWN_TIMEOUT_MS,
  REVIEWER_TIMEOUT_EXHAUSTED_TRIGGER,
  OPERATOR_APPROVED_LABEL,
  MERGE_AGENT_DISPATCHED_LABEL,
  MERGE_AGENT_DISPATCHED_LABEL_ADD_TRANSITION,
  MERGE_AGENT_REQUESTED_LABEL,
  NO_MERGE_HOLD_LABEL,
  OPERATOR_SKIP_LABELS,
  FML_MERGE_AGENT_PER_POLL_CAP_ENV,
  TERMINAL_WORKER_RUN_STATUSES,
  addMergeAgentDispatchedLabel,
  buildFastMergeCloseAuditEntry,
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
  isMergeAgentDispatchActiveForHead,
  listMergeAgentLifecycleCleanups,
  listMergeAgentSkippedDispatches,
  normalizeFollowUpJobStatus,
  normalizeReviewVerdict,
  pickMergeAgentDispatch,
  pickMergeAgentDispatchDetail,
  pollFastMergeQueue,
  processFastMergePR,
  reconcileProactivePhantomHandoffs,
  lookupOriginalWorkerRunStatus,
  prepareOriginalWorkerForMergeAgent,
  resolveFastMergePerPollCap,
  resolveSessionLedgerDbPath,
  recordMergeAgentDispatch,
  updateMergeAgentLifecycleCleanup,
  upsertMergeAgentLifecycleCleanup,
  resolveMergeAgentParentSession,
  resolveMergeAgentProject,
  summarizeChecksConclusion,
  summarizeFastMergeChecks,
  shouldUseReviewerTimeoutExhaustedMergeGate,
  writeFastMergeCloseAuditEntry,
  writeMergeAgentPrompt,
};
