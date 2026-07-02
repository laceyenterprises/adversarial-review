/**
 * AMA-03 — Adversarial Merge Authority closer dispatch path.
 *
 * The watcher's settled-success hook calls `maybeDispatchAmaCloser`
 * BEFORE the existing merge-agent dispatch. When AMA is enabled and the
 * canonical eligibility predicate from SPEC §4.2 returns `eligible:true`,
 * this module dispatches a closer worker (`codex` or
 * `cfg.workerClass`) via `hq dispatch` and returns
 * `{ dispatched: true, lrqId, dispatchId }`. The caller skips the
 * merge-agent dispatch on that tick.
 *
 * When `cfg.enabled === false` OR the eligibility predicate fails, this
 * module is a no-op — returns `{ dispatched: false, reason }` and the
 * caller falls through to the existing merge-agent dispatch path
 * (preserved verbatim until AMA-06A/06N flips that around).
 *
 * Default-off discipline (SPEC §4.8):
 *
 *   - With no operator config, `cfg.enabled` is `false` per the
 *     AMA-01 schema defaults. The whole dispatch path is dark.
 *   - There is NO `enabled=true` fallthrough that overrides
 *     eligibility — the predicate is the only gate.
 *
 * @module ama/dispatch-closer
 */

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { writeFileAtomic } from '../atomic-write.mjs';
import { ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE } from '../config-loader.mjs';
import {
  readBuildCompletionProducerEvidence,
  readBuildCompletionSignalForPr,
} from '../session-ledger-read-adapter.mjs';
import {
  beginReviewerPass,
  completeReviewerPass,
  readWorkerRunTokenUsageResult,
} from '../reviewer-pass-tokens.mjs';
import {
  amaAuditFilePath,
  amaAuditTraceRef,
  composeAmaTrailers,
  readAmaAuditEntry,
  writeAmaAuditEntry,
} from './audit.mjs';
import {
  AMA_CLOSER_LEASE_STATUS,
  acquireAmaCloserLease,
  deleteAmaCloserLease,
  readAmaCloserLease,
  updateAmaCloserLease,
} from './closer-lease.mjs';
import { isEligibleForAmaClosure } from './eligibility.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBMODULE_ROOT = resolve(__dirname, '..', '..');

const DEFAULT_HQ_PATH = '/Users/airlock/.local/bin/hq';
const DEFAULT_HQ_ROOT = '/Users/airlock/agent-os-hq';
const DEFAULT_PROJECT = 'adversarial-merge-authority';
const AGENT_OS_TOOLING_REPO = 'agent-os';
const TEMPLATE_PATH = join(SUBMODULE_ROOT, 'templates', 'ama-closer-prompt.md');
const HAMMER_TEMPLATE_PATH = join(SUBMODULE_ROOT, 'templates', 'hammer-prompt.md');
const FINAL_HAMMER_TERMINAL_REMEDIATION_WAIVER_REASONS = new Set([
  'blocking-findings-present',
  'non-blocking-findings-present',
  'blocking-findings-unknown',
  'non-blocking-findings-unknown',
]);

// Auto-hammer (2026-06-19): before the remediation cycle is exhausted, route
// only the eligibility-miss reasons that a hammer TERMINAL remediation pass can
// clear on its own — strict non-blocking churn, mergeability repair, or red CI.
//
// Once the bounded remediation cycle IS exhausted, the contract changes: the
// hammer is the terminal rescue lane. It gets dispatched for any eligibility
// miss, remediates the final adversarial review comments (blocking and
// non-blocking), fixes red CI, posts the audit closeout, and then re-validates
// the exact live head fail-closed before merge. Exhaustion never waives the
// merge predicate by itself; it only routes the work to the hammer.
const HAMMER_AUTO_REMEDIABLE_MISS_REASONS = new Set([
  'non-blocking-findings-present',
  'verdict-not-settled-success', // strict mode emits this alongside the above
  'pr-not-mergeable', // hammer rebases onto main / resolves the conflict, then merges
  'ci-not-green', // hammer fixes the failing required checks (green-main bar), then merges
]);

export function isHammerRemediableEligibilityMiss(reasons, options = {}) {
  if (!Array.isArray(reasons) || reasons.length === 0) return false;
  if (options?.reviewCycleExhausted === true) return true;
  // The hammer must have something it can actually act on: non-blocking findings
  // to remediate, a not-mergeable state (conflict / behind) to rebase+resolve, or
  // red CI to fix.
  const hasActionable =
    reasons.includes('non-blocking-findings-present') ||
    reasons.includes('pr-not-mergeable') ||
    reasons.includes('ci-not-green');
  if (!hasActionable) return false;
  // And EVERY reason must be hammer-remediable — a co-occurring blocking finding,
  // stale head, etc. means NOT auto-hammer (those go through rounds / operator).
  return reasons.every((reason) => HAMMER_AUTO_REMEDIABLE_MISS_REASONS.has(reason));
}

export function namedAmaNoDispatchReason(reason, reasons = []) {
  if (reason === 'not-eligible') {
    const why = Array.isArray(reasons) && reasons.length
      ? String(reasons[0] || '').trim()
      : '';
    return `not-eligible:${why || 'unknown'}`;
  }
  return reason;
}

function noAmaDispatch(result) {
  const reason = String(result?.reason || 'unknown');
  return {
    ...result,
    namedReason: result?.namedReason || namedAmaNoDispatchReason(reason, result?.reasons),
  };
}

function hammerCloserWorkerId(prNumber) {
  const normalized = String(prNumber || '').trim();
  if (!/^[0-9]+$/.test(normalized)) return null;
  return `hammer-ama-pr-${normalized}`;
}

async function cleanupHammerCloserWorker({
  prNumber,
  workerClass,
  existingRecord = null,
  hqPath,
  hqRoot,
  execFileImpl,
  logger = console,
  reason,
}) {
  const effectiveWorkerClass = String(existingRecord?.workerClass || workerClass || '').trim();
  if (effectiveWorkerClass !== 'hammer') return null;
  const workerId = hammerCloserWorkerId(prNumber);
  if (!workerId) return null;
  try {
    await execFileImpl(hqPath, ['worker', 'tear-down', workerId, '--force', '--root', hqRoot], {
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      killSignal: 'SIGTERM',
    });
    logger.info?.(JSON.stringify({
      event: 'ama_closer.hammer_worker_cleanup',
      workerId,
      reason,
      status: 'ok',
    }));
    return { ok: true, workerId, reason };
  } catch (err) {
    const error = String(err?.stderr || err?.message || err);
    logger.warn?.(JSON.stringify({
      event: 'ama_closer.hammer_worker_cleanup',
      workerId,
      reason,
      status: 'failed',
      error,
    }));
    return { ok: false, workerId, reason, error };
  }
}

/**
 * Decide whether the HAM terminal-remediation prompt (`hammer-prompt.md`) is
 * warranted for this closure, given the eligibility verdict.
 *
 * Per AMA SPEC §1.1.1, HAM terminal remediation "may be used only after the
 * final adversarial review for a PR has blocking or non-blocking findings that
 * the HAM worker remediates directly on top of the reviewed head." The
 * terminal-remediation mandate (a non-empty HAM provenance commit plus a
 * `Remediated-Findings` audit comment) is therefore only meaningful when there
 * is actually something to remediate.
 *
 * Selecting `hammer-prompt.md` purely off `workerClass === 'hammer'` — which is
 * now the default — would hand the terminal-remediation mandate to *every*
 * unpinned AMA closure, including clean, finding-free PRs. For those there is
 * nothing to remediate, so the closer would either stall (HAM evidence cannot
 * exist) or be pushed to invent an unreviewed post-review source change just to
 * satisfy the non-empty-diff contract.
 *
 * Terminal remediation is warranted when the eligibility trace shows standing
 * findings (blocking or non-blocking) OR when a closure path explicitly waived
 * a findings gate (validated HAM terminal-remediation evidence, or
 * final-hammer review-cycle exhaustion with a relevant waived findings reason).
 * Otherwise this is an ordinary clean closure and the plain
 * `ama-closer-prompt.md` mandate is the correct one.
 *
 * @param {{ trace?: object }} verdict — result of `isEligibleForAmaClosure`.
 * @returns {boolean}
 */
export function amaClosureNeedsTerminalRemediation(verdict) {
  const trace = verdict?.trace;
  if (!trace) {
    // Conservative fallback: with no trace we cannot prove the closure is
    // clean, so preserve the prior (workerClass-only) behavior and allow the
    // hammer mandate rather than silently downgrading a possibly-dirty close.
    return true;
  }

  const blocking = trace.verdict?.blockingFindings;
  const nonBlocking = trace.verdict?.nonBlockingFindings;
  const blockingPresent = blocking?.known === true && Number(blocking.count) > 0;
  const nonBlockingPresent = nonBlocking?.known === true && Number(nonBlocking.count) > 0;
  if (blockingPresent || nonBlockingPresent) {
    return true;
  }

  // HAM terminal-remediation evidence means a worker already remediated
  // findings, so the HAM mandate remains appropriate even if the live counts
  // now read clean.
  const hamActive = trace.hamTerminalRemediation?.active === true;
  if (hamActive) {
    return true;
  }

  // `finalHammer.active` only means the review cycle is exhausted. A clean
  // exhausted final round must not inherit the HAM remediation mandate unless
  // final-hammer actually waived a finding or unsettled-verdict gate.
  const finalHammerWaivedTerminalGate = trace.finalHammer?.active === true
    && Array.isArray(trace.finalHammer?.waived)
    && trace.finalHammer.waived.some((reason) => (
      FINAL_HAMMER_TERMINAL_REMEDIATION_WAIVER_REASONS.has(reason)
    ));
  if (finalHammerWaivedTerminalGate) {
    return true;
  }

  return false;
}

const AMA_CLOSER_DISPATCH_SCHEMA_VERSION = 1;
const AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS = [1_000, 5_000];
const AMA_CLOSER_HQ_DISPATCH_LAUNCH_WINDOW_MS = 90_000;
const AMA_CLOSER_HQ_DISPATCH_MAX_ATTEMPTS = AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS.length + 1;
const AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS = [500, 1_000, 2_000, 5_000];
const AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS = (
  AMA_CLOSER_HQ_DISPATCH_LAUNCH_WINDOW_MS * AMA_CLOSER_HQ_DISPATCH_MAX_ATTEMPTS
)
  + AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)
  + (
    AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS.reduce((total, delay) => total + delay, 0)
    * AMA_CLOSER_HQ_DISPATCH_MAX_ATTEMPTS
  );
const AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS = [250, 1_000, 5_000];
export const AMA_CLOSER_REDISPATCH_BOUND = 2;
const AMA_CLOSER_BRANCH_HOLDER_BLOCK_BOUND = 3;
const AMA_CLOSER_ACTIVE_STATUSES = new Set(['running', 'starting', 'blocked', 'stalled']);
const AMA_CLOSER_TERMINAL_HOLD_STATUSES = new Set(['succeeded']);
const AMA_CLOSER_RETRYABLE_STATUSES = new Set([
  'failed',
  'cancelled',
  'canceled',
  'superseded',
  'not-found',
  'unverified-terminal-success',
]);
const MERGE_CLASS_ORCHESTRATION_MODES = new Set(ENUM_ROLES_ADVERSARIAL_ORCHESTRATION_MODE);
const AMA_CLOSER_AUDIT_TERMINAL_OUTCOMES = new Set([
  'succeeded',
  'failed-without-merge',
  'deferred',
  'superseded',
]);

/**
 * Detect a dispatch record frozen mid-`hq dispatch` by an external SIGTERM.
 *
 * The canonical case is a main-catchup deploy bounce of the watcher landing in
 * the ~90s window of the closer's `hq dispatch` execFile (the watcher's launchd
 * `kickstart -k` SIGTERMs the whole process group). The record is written
 * `state: 'dispatching'` immediately BEFORE the launch and is only advanced to
 * `dispatched` (on success, with an lrq/dispatchId) or `dispatch-failed` (on a
 * thrown error, with `lastError`) AFTER the call returns or throws. A kill in
 * between leaves it at `dispatching` with no launchRequestId, no dispatchId, and
 * no lastError, plus a `pending` lease that is provably no longer live —
 * distinguishable from a genuine completed attempt and from a healthy watcher
 * still blocked inside the launch.
 *
 * An interruption is NOT a completed attempt: it must not consume the redispatch
 * bound. Otherwise a couple of routine deploy bounces during closer dispatch
 * wedge the PR forever — the closer never launches and the merge-agent fallback
 * is refused (observed 2026-06-14: 10 eligible PRs stuck at retryCount=2,
 * zero autonomous merges for hours).
 */
export function isInterruptedInFlightAmaCloserDispatch(record, lease = null, options = {}) {
  return hasInterruptedInFlightAmaCloserDispatchShape(record)
    && isReclaimablePendingAmaCloserLease(lease, options);
}

function hasInterruptedInFlightAmaCloserDispatchShape(record) {
  return Boolean(
    record
      && record.state === 'dispatching'
      && !record.launchRequestId
      && !record.dispatchId
      && !record.lastError,
  );
}

function parseTimeMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function isPidAlive(pid, processKillImpl = process.kill) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    processKillImpl(numericPid, 0);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    if (err?.code === 'EPERM') return true;
    return true;
  }
}

function isReclaimablePendingAmaCloserLease(lease, { now = null, processKillImpl = process.kill } = {}) {
  if (lease?.status !== AMA_CLOSER_LEASE_STATUS.PENDING) return false;

  const pidAlive = isPidAlive(lease.watcherPid, processKillImpl);
  if (pidAlive === false) return true;

  const acquiredAtMs = parseTimeMs(lease.acquiredAt);
  const nowMs = parseTimeMs(now || new Date().toISOString());
  return acquiredAtMs !== null
    && nowMs !== null
    && nowMs - acquiredAtMs >= AMA_CLOSER_PENDING_LEASE_RECLAIM_AGE_MS;
}

/**
 * @typedef {Object} DispatchResult
 * @property {boolean}  dispatched
 * @property {string=}  reason       — populated when `dispatched=false`.
 * @property {string[]=} reasons     — populated when `reason=not-eligible`.
 * @property {string=}  workerClass  — populated when `dispatched=true`.
 * @property {string=}  dispatchId   — populated when `dispatched=true`.
 * @property {string=}  launchRequestId — populated when `dispatched=true`.
 * @property {string=}  promptPath   — populated when `dispatched=true`.
 * @property {boolean=} skipMergeAgent — populated when AMA owns the
 * merge path for this tick even though no fresh launch occurred.
 */

function amaCloserDispatchDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-dispatches');
}

function amaCloserPromptDir(rootDir) {
  return join(rootDir, 'data', 'follow-up-jobs', 'ama-closer-prompts');
}

function sanitizeDispatchPathSegment(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

export function amaCloserDispatchFilePath(rootDir, { repo, prNumber, headSha } = {}) {
  const safeRepo = sanitizeDispatchPathSegment(String(repo ?? '').replace(/\//g, '__'));
  const safeSha = sanitizeDispatchPathSegment(String(headSha || 'no-sha'));
  return join(
    amaCloserDispatchDir(rootDir),
    `${safeRepo}-pr-${Number(prNumber)}-${safeSha}.json`
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function readAmaCloserDispatchRecord(rootDir, identity) {
  return readJsonFile(amaCloserDispatchFilePath(rootDir, identity));
}

function writeAmaCloserDispatchRecord(rootDir, identity, doc) {
  mkdirSync(amaCloserDispatchDir(rootDir), { recursive: true });
  const filePath = amaCloserDispatchFilePath(rootDir, identity);
  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  return filePath;
}

function logAmaCloserDispatchEvent(logger, event, fields = {}) {
  const sink = logger && typeof logger.info === 'function'
    ? logger.info.bind(logger)
    : console.log.bind(console);
  sink(JSON.stringify({ event, ...fields }));
}

function resolveMergeClassDispatchRoute({
  orchestrationMode = null,
  logger = console,
  repo = null,
  prNumber = null,
  workerClass = null,
  completionShape = null,
} = {}) {
  const normalized = orchestrationMode == null
    ? 'native'
    : String(orchestrationMode).trim().toLowerCase();
  if (!MERGE_CLASS_ORCHESTRATION_MODES.has(normalized)) {
    throw new Error(
      `[ama-closer] unsupported orchestration_mode=${JSON.stringify(orchestrationMode)} `
      + '(expected native or agentos for merge-class dispatch invariance)',
    );
  }
  const route = 'hq-dispatch';
  logAmaCloserDispatchEvent(logger, 'ama_closer.orchestration_mode_noop', {
    orchestrationMode: normalized,
    route,
    repo,
    prNumber: prNumber == null ? null : Number(prNumber),
    workerClass,
    completionShape,
  });
  return route;
}

export function updateAmaCloserDispatchRecord(rootDir, identity, mutate) {
  const existing = readAmaCloserDispatchRecord(rootDir, identity);
  const next = mutate(existing ? { ...existing } : null);
  if (!next) return existing;
  writeAmaCloserDispatchRecord(rootDir, identity, next);
  return next;
}

function errorDiagnosticLines(err) {
  return [err?.message, err?.stderr, err?.stdout]
    .filter(Boolean)
    .flatMap((value) => String(value).split('\n'))
    .map(line => line.trim())
    .filter(Boolean);
}

function buildBootstrapEligibilityReasons({ reviewState, prMetadata, verdict, dispatchContext }) {
  const reasons = [];
  if (verdict?.eligible) reasons.push('latest_review_settled_success');
  if (dispatchContext?.reviewedBy) reasons.push('reviewer_family_recorded');
  if (reviewState?.riskClass) reasons.push(`risk_class_${reviewState.riskClass}_permitted`);
  if (reviewState?.headSha && prMetadata?.headSha && reviewState.headSha === prMetadata.headSha) {
    reasons.push('head_sha_matches_review');
  }
  if (verdict?.trace?.ciGreen?.green) reasons.push('ci_all_green');
  if (Array.isArray(verdict?.trace?.blockLabels) && verdict.trace.blockLabels.length === 0) {
    reasons.push('no_blocking_labels');
  }
  const branchProtection = verdict?.trace?.branchProtection;
  if (branchProtection?.ok && branchProtection?.required === true) {
    reasons.push('configured_gate_context_required');
  } else if (branchProtection?.ok && branchProtection?.required === false) {
    reasons.push('branch_protection_requirement_waived');
  }
  return reasons;
}

function summarizeEligibilityReason(reasons) {
  const summary = Array.isArray(reasons)
    ? reasons.map(reason => String(reason || '').trim()).filter(Boolean).join(', ')
    : '';
  return summary || 'eligibility predicate satisfied';
}

function isExecTimeout(err) {
  return err?.code === 'ETIMEDOUT'
    || err?.killed === true
    || String(err?.message || '').toLowerCase().includes('timed out');
}

function errDetailText(errOrText) {
  if (typeof errOrText === 'string') return errOrText.toLowerCase();
  return [
    ['code', errOrText?.code],
    ['status', errOrText?.status],
    ['statusCode', errOrText?.statusCode],
    ['message', errOrText?.message],
    ['stderr', errOrText?.stderr],
    ['stdout', errOrText?.stdout],
  ]
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n')
    .toLowerCase();
}

// GitHub primary/secondary rate-limit + HTTP 429 + OAuth-broker 503 signals.
// These are TRANSIENT: the bot token is valid and authorized — the request was
// merely throttled (or the broker that mints the token is briefly unavailable).
// GitHub returns the *primary* rate limit as HTTP 403, so a naive 403/exit-65
// check misreads a throttle as a terminal auth failure and permanently grounds
// the AMA closer, so autonomous merges never run (observed during the macOS
// upgrade + os-restart storm that exhausted merge-agent-lacey's rate limit).
//
// This mirrors the rate-limit clauses of `_TRANSIENT_GH_ERROR_RE` in
// cwp_dispatch/dag_reconcile.py and `hq_entitlement_gh_identity_error_is_rate_limit`
// in modules/worker-pool/lib/hq-gh.sh so classification is consistent across
// the worker-pool entitlement path and this dispatch path.
export function isGithubRateLimitOrBrokerThrottle(errOrText) {
  const detail = errDetailText(errOrText);
  if (!detail) return false;
  return detail.includes('rate limit')
    || detail.includes('rate-limit')
    || detail.includes('ratelimit')
    || detail.includes('secondary rate')
    || detail.includes('abuse detection')
    || detail.includes('submitted too quickly')
    || detail.includes('retry your request')
    || detail.includes('too many requests')
    || detail.includes('http 429')
    || /\b(?:status|statuscode|status_code|code)\s*[:=]?\s*429\b/.test(detail)
    // OAuth-broker unavailability while it fetches/refreshes the bot token.
    || detail.includes('http 503')
    || detail.includes('broker fetch')
    || detail.includes('broker unavailable')
    || detail.includes('service unavailable');
}

export function isTransientHqDispatchError(err) {
  if (isExecTimeout(err)) return true;
  // A throttle / broker outage is transient, never terminal — classify it
  // first so the retry loop and retry-budget guard both treat it as retryable.
  if (isGithubRateLimitOrBrokerThrottle(err)) return true;
  const detail = errDetailText(err);
  return /\b(etimedout|econnreset|econnrefused|ehostunreach|eagain|epipe)\b/.test(detail)
    || detail.includes('database is locked')
    || detail.includes('sqlite_busy')
    || detail.includes('resource temporarily unavailable')
    || detail.includes('temporary failure')
    || detail.includes('temporarily unavailable');
}

function isProvisionBranchHolderBlocked(errOrText) {
  const detail = typeof errOrText === 'string'
    ? errOrText
    : [
      errOrText?.code,
      errOrText?.message,
      errOrText?.stderr,
      errOrText?.stdout,
    ].filter(Boolean).join('\n');
  const normalized = detail
    .split(/\r?\n/)
    .map(line => line.toLowerCase())
    .filter(line => {
      if (line.includes('targeted worktree fallback could not find admin entry')) return false;
      if (line.includes('force-reclaimed stale own merge worktree')) return false;
      return !(line.includes('provision cleanup')
        && (
          line.includes('releasing worktree mutation lock')
          || line.includes('was incomplete; continuing')
        ));
    })
    .join('\n');
  if (!normalized) return false;
  if (/\b(branch[-_]holder[-_](blocked|collision|worktree)|worktree[-_]branch[-_]holder[-_]blocked)\b/.test(normalized)) {
    return true;
  }
  const hasWorktreeCollision = (
    normalized.includes('already used by worktree') ||
    normalized.includes('already checked out in worktree') ||
    (normalized.includes('worktree') && normalized.includes('already') && normalized.includes('branch'))
  );
  const hasBranchHolderContext = (
    normalized.includes('branch holder') ||
    normalized.includes('branch-holder') ||
    normalized.includes('git worktree holder') ||
    normalized.includes('worker provision failed') ||
    normalized.includes('refusing grace-waived git worktree holder drop') ||
    normalized.includes('holder has unrecovered local state') ||
    normalized.includes('could not be safely inspected') ||
    normalized.includes('auto-tear-down')
  );
  return hasWorktreeCollision && hasBranchHolderContext;
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function resolveHqOwner(hqRoot) {
  if (!hqRoot) return null;
  const config = readJsonFile(join(hqRoot, '.hq', 'config.json'));
  const ownerUser = String(config?.ownerUser || '').trim();
  return ownerUser || null;
}

function currentUserName() {
  try {
    return String(userInfo().username || '').trim() || null;
  } catch {
    return null;
  }
}

export function assertAmaAuditOwner({ hqRoot, ownerUser, currentUser = currentUserName() } = {}) {
  const expected = String(ownerUser || '').trim();
  if (!expected) {
    throw new Error(
      `AMA audit bootstrap refused: HQ ownerUser is unavailable for ${hqRoot || 'unknown HQ root'}`,
    );
  }
  const actual = String(currentUser || '').trim();
  if (!actual) {
    throw new Error('AMA audit bootstrap refused: current runtime user is unavailable');
  }
  if (actual !== expected) {
    throw new Error(
      `AMA audit bootstrap refused: current user '${actual}' does not match ` +
      `HQ ownerUser '${expected}' for ${hqRoot}`,
    );
  }
  return expected;
}

function hasAuthoritativeOwnerVisibility(asOwner) {
  return Boolean(String(asOwner || '').trim());
}

function isNotFoundDispatchStatusError(err) {
  if (!err) return false;
  const code = err.code ?? err.status ?? null;
  return (code === 1 || code === '1') && /no dispatch with id/i.test(String(err.stderr || ''));
}

function parseAmaCloserDispatchStatusOutput(stdout) {
  const parsed = parseAmaCloserDispatchOutput(stdout);
  const status = typeof parsed?.status === 'string'
    ? parsed.status.trim().toLowerCase()
    : null;
  return status ? { status } : null;
}

async function probeAmaCloserDispatchStatus({
  hqPath,
  launchRequestId,
  asOwner = null,
  execFileImpl = execFileAsync,
  env = {},
} = {}) {
  if (!hqPath || !launchRequestId) return null;
  const args = asOwner
    ? ['dispatch', 'status', launchRequestId, '--as-owner', asOwner]
    : ['dispatch', 'status', launchRequestId];
  for (let attempt = 0; attempt <= AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const { stdout } = await execFileImpl(hqPath, args, {
        env: { ...env },
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      });
      const parsed = parseAmaCloserDispatchStatusOutput(stdout);
      if (parsed) return parsed;
      if (attempt < AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length) {
        await sleep(AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { status: 'unknown', degraded: true };
    } catch (err) {
      if (hasAuthoritativeOwnerVisibility(asOwner) && isNotFoundDispatchStatusError(err)) {
        return { status: 'not-found' };
      }
      if (isTransientHqDispatchError(err) && attempt < AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS.length) {
        await sleep(AMA_CLOSER_STATUS_TRANSIENT_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      return { status: 'unknown', degraded: true, error: err?.message || String(err) };
    }
  }
  return { status: 'unknown', degraded: true };
}

function parseAmaCloserDispatchOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;

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

  let dispatchId = null;
  let launchRequestId = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const dispatchMatch = /^dispatchId=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (dispatchMatch) dispatchId = dispatchMatch[1];
    const lrqMatch = /^(?:launchRequestId|lrq)=([A-Za-z0-9_-]+)/.exec(trimmed);
    if (lrqMatch) launchRequestId = lrqMatch[1];
  }
  return (dispatchId || launchRequestId) ? { dispatchId, launchRequestId } : null;
}

function normalizeDispatchIdentifiers(payload) {
  if (!payload || typeof payload !== 'object') return { dispatchId: null, launchRequestId: null };
  return {
    dispatchId: String(payload.dispatchId || '').trim() || null,
    launchRequestId: String(payload.launchRequestId || payload.lrq || payload.dispatchId || '').trim() || null,
  };
}

function readAmaAuditTerminalOutcome(hqRoot, { repo, prNumber, headSha } = {}) {
  const status = String(readAmaAuditEntry(hqRoot, repo, prNumber, headSha)?.status || '')
    .trim()
    .toLowerCase();
  return AMA_CLOSER_AUDIT_TERMINAL_OUTCOMES.has(status) ? status : null;
}

function readMergedBuildCompletionSignal({
  repo,
  prNumber,
  headSha,
  hqRoot,
  rootDir,
  env = process.env,
  readBuildCompletionProducerEvidenceImpl = readBuildCompletionProducerEvidence,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
} = {}) {
  const result = readBuildCompletionSignalForPrImpl({
    repo,
    prNumber,
    signalKind: 'merged',
    hqRoot,
    rootDir,
    env,
  });
  if (!result) return { ok: false, reason: 'ledger-read-failed' };
  if (result.ok) {
    const producerHeadSha = String(result.row?.head_sha || '').trim() || null;
    const reviewedHeadSha = String(headSha || '').trim() || null;
    return {
      ...result,
      producerHeadSha,
      reviewedHeadSha,
      headShaMatchesReviewed: producerHeadSha && reviewedHeadSha ? producerHeadSha === reviewedHeadSha : null,
    };
  }
  if (isCleanMissingMergedSignal(result)) {
    const producerEvidence = readBuildCompletionProducerEvidenceImpl({
      repo,
      signalKind: 'merged',
      hqRoot,
      rootDir,
      env,
    });
    if (producerEvidence?.ok) {
      return {
        ...result,
        producerEvidence: producerEvidence.row,
        producerEvidenceTarget: producerEvidence.target || null,
      };
    }
    return {
      ...(producerEvidence || { ok: false, reason: 'missing-build-completion-producer-evidence' }),
      producerEvidence: producerEvidence || null,
      prSignal: result,
    };
  }
  return result;
}

function isCleanMissingMergedSignal(result) {
  return result?.ok === false && result.reason === 'missing-build-completion-signal';
}

function isUnknownMergedSignal(result) {
  return result?.ok === false && !isCleanMissingMergedSignal(result);
}

function retainExistingAmaCloserDispatch(existingRecord, workerClass, status) {
  return noAmaDispatch({
    dispatched: false,
    skipMergeAgent: true,
    reason: `existing-dispatch-${status || 'unknown'}`,
    workerClass: existingRecord.workerClass || workerClass,
    dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
    launchRequestId: existingRecord.launchRequestId || null,
    promptPath: existingRecord.promptPath || null,
  });
}

function closerReviewerPassStatusForDispatchStatus(status, { merged = false } = {}) {
  if (merged) return 'completed';
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'succeeded' || normalized === 'unverified-terminal-success') return 'completed';
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'superseded') return 'cancelled';
  return 'failed';
}

function usageHasTokenFigure(usage) {
  if (!usage) return false;
  return usage.input !== null && usage.input !== undefined
    || usage.output !== null && usage.output !== undefined
    || usage.cacheRead !== null && usage.cacheRead !== undefined
    || usage.cacheWrite !== null && usage.cacheWrite !== undefined
    || usage.total !== null && usage.total !== undefined
    || usage.costUSD !== null && usage.costUSD !== undefined;
}

async function readCloserWorkerRunUsageAfterRollup({
  rootDir,
  hqRoot,
  workerRunId = null,
  launchRequestId = null,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  pollDelaysMs = AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS,
} = {}) {
  const attempts = [0, ...pollDelaysMs];
  for (const delayMs of attempts) {
    if (delayMs > 0) await sleep(delayMs);
    const result = readWorkerRunTokenUsageResult({
      workerRunId,
      launchRequestId,
      ledgerTarget,
      ledgerDbPath,
      env,
      rootDir,
      hqRoot,
    });
    if (!result?.ok) {
      if (result?.reason === 'missing-worker-run-row') continue;
      return null;
    }
    const usage = result.usage;
    if (usageHasTokenFigure(usage)) return usage;
  }
  return null;
}

async function recordAmaCloserReviewerPassTokens({
  rootDir,
  hqRoot,
  repo,
  prNumber,
  record,
  status,
  merged = false,
  observedAt,
  ledgerTarget = null,
  ledgerDbPath = null,
  env = process.env,
  pollDelaysMs = AMA_CLOSER_TOKEN_ROLLUP_POLL_DELAYS_MS,
  logger = console,
} = {}) {
  if (!record?.launchRequestId && !record?.dispatchId) return null;
  const attemptNumber = normalizeCloserAttemptNumber(record);
  const launchRequestId = record.launchRequestId || record.dispatchId || null;
  const usage = await readCloserWorkerRunUsageAfterRollup({
    rootDir,
    hqRoot,
    workerRunId: record.workerRunId || null,
    launchRequestId,
    ledgerTarget,
    ledgerDbPath,
    env,
    pollDelaysMs,
  });
  const missingUsage = !usage;
  if (!usage) {
    logger.warn?.(
      `[ama-closer] token rollup not ready for ${repo}#${prNumber} ` +
      `attempt=${attemptNumber} launchRequestId=${launchRequestId || 'unknown'}; ` +
      'recording closer pass without token usage so dispatch state can advance'
    );
  }
  const startedAt = record.dispatchedAt || record.lastAttemptedAt || observedAt || new Date().toISOString();
  const endedAt = observedAt || record.lastObservedAt || new Date().toISOString();
  const workerRunId = usage?.workerRunId || record.workerRunId || null;
  const metadata = {
    amaCloser: true,
    headSha: record.headSha || null,
    dispatchId: record.dispatchId || null,
    launchRequestId,
    terminalStatus: status || null,
    merged,
    ...(missingUsage ? { tokenUsageUnavailable: true } : {}),
  };
  beginReviewerPass(rootDir, {
    repo,
    prNumber,
    attemptNumber,
    reviewerClass: record.workerClass || 'codex',
    reviewerModel: record.workerClass || 'codex',
    passKind: 'closer',
    workerRunId,
    workspacePath: record.workspacePath || null,
    startedAt,
    metadata,
  });
  return completeReviewerPass(rootDir, {
    repo,
    prNumber,
    attemptNumber,
    passKind: 'closer',
    status: closerReviewerPassStatusForDispatchStatus(status, { merged }),
    endedAt,
    workerRunId,
    tokenUsage: usage || null,
    tokenSource: usage?.source || null,
    metadata,
  });
}

function normalizeCloserAttemptNumber(record) {
  const parsed = Number(record?.retryCount);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return 1;
}

/**
 * Substitute `<<PLACEHOLDER>>` markers in the template body.
 *
 * Pure string substitution — no escaping logic (the template author
 * controls the markup). The substituted values come from validated
 * inputs (PR number is numeric, reviewedSha is a Git SHA, etc.) so
 * the surface area for injection is bounded.
 *
 * @param {string} body
 * @param {Object<string, string|number>} substitutions
 * @returns {string}
 */
export function substituteTemplate(body, substitutions) {
  let out = body;
  for (const [key, value] of Object.entries(substitutions)) {
    const placeholder = new RegExp(`<<${key}>>`, 'g');
    out = out.replace(placeholder, String(value));
  }
  return out;
}

/**
 * Compose the closer worker prompt body from the substitutions the
 * dispatch site provides. Exported for the golden-snapshot test.
 *
 * @param {Object} args
 * @param {string} args.prUrl
 * @param {string} args.repo            — owner/name
 * @param {number} args.prNumber
 * @param {string} args.reviewedSha
 * @param {string} args.riskClass
 * @param {string} args.mergeMethod     — 'squash' | 'merge'
 * @param {string} args.requiredGateContext
 * @param {string} args.auditPath       — absolute path inside HQ_ROOT, used only inside the closer
 * @param {string} args.hqRoot          — HQ root path (closer passes to `ama-audit append --hq-root`)
 * @param {string} args.rootDir         — adversarial-review checkout root for ama-check ledger probes
 * @param {string} args.hqOwnerUser     — HQ owner user required for direct audit writes
 * @param {string} args.reviewedBy
 * @param {string} args.reviewer
 * @param {string} args.dispatchedAt    — ISO 8601 UTC
 * @param {string} args.amaTrailers     — provenance trailer block passed to `gh pr merge`
 * @param {string} args.templateBody    — raw template content
 * @returns {string}
 */
export function composeCloserPrompt({
  prUrl,
  repo,
  prNumber,
  reviewedSha,
  riskClass,
  mergeMethod,
  requiredGateContext,
  auditPath,
  hqRoot,
  rootDir = SUBMODULE_ROOT,
  hqOwnerUser,
  reviewedBy,
  reviewer,
  dispatchedAt,
  amaTrailers,
  templateBody,
  reviewCycleExhausted = false,
}) {
  return substituteTemplate(templateBody, {
    PR_URL: prUrl,
    REPO: repo,
    PR_NUMBER: prNumber,
    REVIEWED_SHA: reviewedSha,
    RISK_CLASS: riskClass,
    MERGE_METHOD: mergeMethod,
    REQUIRED_GATE_CONTEXT: requiredGateContext,
    AUDIT_PATH: auditPath,
    HQ_ROOT: hqRoot,
    ROOT_DIR: rootDir,
    HQ_OWNER: hqOwnerUser,
    REVIEWED_BY: reviewedBy,
    REVIEWER: reviewer,
    DISPATCHED_AT: dispatchedAt,
    AMA_TRAILERS: amaTrailers,
    // Dispatch-time final-hammer observation forwarded only as audit context;
    // ama-check recomputes the durable ledger state before applying waivers.
    REVIEW_CYCLE_EXHAUSTED: reviewCycleExhausted === true ? 'true' : 'false',
  });
}

/**
 * Watcher's settled-success hook calls this BEFORE its existing
 * merge-agent dispatch. Returns `{ dispatched: true }` when AMA owns
 * the close; the caller skips merge-agent on that tick. Returns
 * `{ dispatched: false }` with a structured reason otherwise; the
 * caller falls through to the existing merge-agent dispatch path.
 *
 * @param {Object} args
 * @param {Object} args.reviewState
 * @param {Object} args.prMetadata
 * @param {Object} args.cfg              — resolved AMA cfg subtree (camelCase)
 * @param {Object=} args.options         — passed to the eligibility predicate
 * @param {Object} args.dispatchContext  — operator-controlled values
 * @param {string} args.dispatchContext.repo           owner/name (e.g. `acme/myrepo`)
 * @param {string} args.dispatchContext.prUrl          PR URL (e.g. `https://github.com/acme/myrepo/pull/123`)
 * @param {string} args.dispatchContext.reviewedSha    PR head SHA the watcher authorized
 * @param {string} args.dispatchContext.riskClass      resolved risk class
 * @param {string} args.dispatchContext.requiredGateContext
 * @param {string} args.dispatchContext.reviewedBy
 * @param {string} args.dispatchContext.parentSession
 * @param {string=} args.dispatchContext.hqProject
 * @param {string=} args.dispatchContext.hqPath
 * @param {string=} args.dispatchContext.hqRoot
 * @param {string=} args.dispatchContext.templatePath
 * @param {string=} args.dispatchContext.dispatchedAt  ISO 8601 UTC (caller-provided to keep the function deterministic for tests)
 * @param {Object=} args.execFileImpl    — DI for tests
 * @param {Object=} args.processKillImpl  — DI for tests
 * @param {Object=} args.readTemplateImpl — DI for tests
 * @param {Object=} args.writeFileImpl   — DI for tests
 * @returns {Promise<DispatchResult>}
 */
export async function maybeDispatchAmaCloser({
  reviewState,
  prMetadata,
  cfg,
  options,
  dispatchContext,
  execFileImpl = execFileAsync,
  processKillImpl = process.kill,
  readTemplateImpl = null,
  writeFileImpl = null,
  readBuildCompletionProducerEvidenceImpl = readBuildCompletionProducerEvidence,
  readBuildCompletionSignalForPrImpl = readBuildCompletionSignalForPr,
  logger = console,
}) {
  // The master gate. With no operator config, this is `false` per
  // AMA-01 schema defaults and the entire path is a no-op.
  if (!cfg?.enabled) {
    return noAmaDispatch({
      dispatched: false,
      reason: 'ama-disabled',
    });
  }

  // The eligibility predicate is the second gate.
  const verdict = isEligibleForAmaClosure(reviewState, prMetadata, cfg, options);
  let forceHammerTerminalRemediationPrompt = false;
  if (!verdict.eligible) {
    // Auto-hammer fall-through (gated by
    // roles.adversarial.merge_authority.auto_hammer_on_eligibility_miss): before
    // cycle exhaustion this covers narrow hammer-owned repairs (non-blocking
    // findings, mergeability, red CI). At cycle exhaustion it is the terminal
    // rescue handoff for any final review comments. The hammer-prompt commits,
    // writes the audit comment, then re-runs the eligibility predicate with
    // --ham-terminal-remediation evidence, which is validated strictly and
    // fails closed if the findings/checks were not actually addressed.
    const workerClassForMiss = String(cfg.workerClass || 'hammer');
    const reviewCycleExhausted =
      reviewState?.reviewCycleExhausted === true ||
      verdict?.trace?.finalHammer?.active === true;
    const autoHammer =
      cfg?.autoHammerOnEligibilityMiss === true
      && workerClassForMiss === 'hammer'
      && isHammerRemediableEligibilityMiss(verdict.reasons, { reviewCycleExhausted });
    if (!autoHammer) {
      return noAmaDispatch({
        dispatched: false,
        reason: 'not-eligible',
        reasons: verdict.reasons,
      });
    }
    forceHammerTerminalRemediationPrompt = true;
    logger.log?.(
      `[ama-closer] auto-hammer: dispatching terminal remediation for ineligible ` +
      `PR (reasons: ${(verdict.reasons || []).join(',')}) — hammer will remediate ` +
      `final findings/checks then re-validate the gate fail-closed`
    );
    // fall through to the dispatch below (hammer template, remediation mode)
  }

  // Compose the prompt body. Template loaded from disk via DI so
  // tests can pass a literal.
  const workerClass = String(cfg.workerClass || 'hammer');
  // SPEC §1.1.1: the HAM terminal-remediation prompt is reserved for closures
  // that actually have findings to remediate. With `hammer` now the default
  // worker class, gating purely on `workerClass === 'hammer'` would route every
  // clean closure through the terminal-remediation mandate. Require both the
  // hammer worker class AND a closure that genuinely needs terminal remediation;
  // otherwise a hammer worker performs an ordinary clean close. Auto-hammer
  // eligibility misses force the terminal prompt because that worker is being
  // launched to repair findings, mergeability, or CI before merge.
  const useHammerTerminalRemediationPrompt =
    workerClass === 'hammer' && (
      forceHammerTerminalRemediationPrompt ||
      amaClosureNeedsTerminalRemediation(verdict)
    );
  const templatePath = dispatchContext.templatePath || (
    useHammerTerminalRemediationPrompt ? HAMMER_TEMPLATE_PATH : TEMPLATE_PATH
  );
  const templateBody = readTemplateImpl
    ? readTemplateImpl(templatePath)
    : readFileSync(templatePath, 'utf8');

  const repo = dispatchContext.repo;
  const prNumber = Number(prMetadata?.prNumber);
  const reviewedSha = dispatchContext.reviewedSha;
  const mergeMethod = String(cfg.mergeMethod || 'squash').toLowerCase();
  const rootDir = dispatchContext.rootDir || SUBMODULE_ROOT;

  const leaseIdentity = { repo, prNumber, headSha: reviewedSha };
  const hqRoot = dispatchContext.hqRoot || DEFAULT_HQ_ROOT;
  const promptDir = dispatchContext.promptDir || amaCloserPromptDir(rootDir);
  const ownerUser = dispatchContext.hqOwnerUser || resolveHqOwner(hqRoot);
  const auditPath = amaAuditFilePath(hqRoot, repo, prNumber, reviewedSha);
  const auditRef = amaAuditTraceRef(repo, prNumber, reviewedSha);
  const bootstrapEligibilityReasons = buildBootstrapEligibilityReasons({
    reviewState,
    prMetadata,
    verdict,
    dispatchContext,
  });
  const amaTrailers = composeAmaTrailers({
    workerClass,
    reviewerFamily: dispatchContext.reviewedBy,
    riskClass: dispatchContext.riskClass,
    eligibilityReason: summarizeEligibilityReason(bootstrapEligibilityReasons),
    auditRef,
    closedBy: workerClass === 'hammer' && !useHammerTerminalRemediationPrompt
      ? 'hammer-closer'
      : undefined,
  });
  const prompt = composeCloserPrompt({
    prUrl: dispatchContext.prUrl,
    repo,
    prNumber,
    reviewedSha,
    riskClass: dispatchContext.riskClass,
    mergeMethod,
    requiredGateContext: dispatchContext.requiredGateContext,
    auditPath,
    hqRoot,
    rootDir,
    hqOwnerUser: ownerUser || 'unknown',
    reviewedBy: dispatchContext.reviewedBy,
    reviewer: dispatchContext.reviewer,
    dispatchedAt: dispatchContext.dispatchedAt,
    amaTrailers,
    templateBody,
    // Forward the dispatch-time final-hammer observation only as context; the
    // closer's ama-check invocation recomputes exhaustion from the current
    // follow-up ledger before it honors any waiver.
    reviewCycleExhausted: reviewState?.reviewCycleExhausted === true,
  });

  const dispatchIdentity = { repo, prNumber, headSha: reviewedSha };
  const hqPath = dispatchContext.hqPath || process.env.HQ_BIN || DEFAULT_HQ_PATH;
  const hqProject = dispatchContext.hqProject || DEFAULT_PROJECT;
  const existingRecord = readAmaCloserDispatchRecord(rootDir, dispatchIdentity);
  const existingLeaseBeforeDispatch = readAmaCloserLease(rootDir, leaseIdentity);
  const auditTerminalOutcome = readAmaAuditTerminalOutcome(hqRoot, dispatchIdentity);
  const mergedSignal = readMergedBuildCompletionSignal({
    repo,
    prNumber,
    headSha: reviewedSha,
    hqRoot,
    rootDir,
    env: process.env,
    readBuildCompletionProducerEvidenceImpl,
    readBuildCompletionSignalForPrImpl,
  });
  if (mergedSignal?.ok) {
    const hammerCleanup = await cleanupHammerCloserWorker({
      prNumber,
      workerClass,
      existingRecord,
      hqPath,
      hqRoot,
      execFileImpl,
      logger,
      reason: 'merged-signal-present',
    });
    if (existingRecord?.launchRequestId || existingRecord?.dispatchId) {
      await recordAmaCloserReviewerPassTokens({
        rootDir,
        hqRoot,
        repo,
        prNumber,
        record: existingRecord,
        status: existingRecord.lastObservedStatus || 'succeeded',
        merged: true,
        observedAt: dispatchContext.dispatchedAt,
        ledgerTarget: dispatchContext.ledgerTarget || null,
        ledgerDbPath: dispatchContext.ledgerDbPath || null,
        env: process.env,
        pollDelaysMs: dispatchContext.closerTokenRollupPollDelaysMs || undefined,
        logger,
      });
    }
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'merged-signal-present',
      workerClass: existingRecord?.workerClass || workerClass,
      dispatchId: existingRecord?.dispatchId || existingRecord?.launchRequestId || null,
      launchRequestId: existingRecord?.launchRequestId || null,
      promptPath: existingRecord?.promptPath || null,
      mergedSignal: mergedSignal.row,
      mergedSignalHeadShaMatchesReviewed: mergedSignal.headShaMatchesReviewed,
      mergedSignalProducerHeadSha: mergedSignal.producerHeadSha,
      ...(hammerCleanup ? { hammerCleanup } : {}),
    });
  }
  const mergedSignalUnknown = isUnknownMergedSignal(mergedSignal);
  const existingRecordIsReclaimableInterruption = isInterruptedInFlightAmaCloserDispatch(
    existingRecord,
    existingLeaseBeforeDispatch,
    { now: dispatchContext.dispatchedAt, processKillImpl },
  );
  const existingRecordHasLivePendingInterruption = hasInterruptedInFlightAmaCloserDispatchShape(existingRecord)
    && existingLeaseBeforeDispatch?.status === AMA_CLOSER_LEASE_STATUS.PENDING
    && !existingRecordIsReclaimableInterruption;
  const existingRecordIsBranchHolderBlocked = isProvisionBranchHolderBlocked(existingRecord?.lastError || '');
  const existingBranchHolderBlockCount = Number(existingRecord?.branchHolderBlockCount || 0);
  let existingDispatchStatus = null;
  if (existingRecord?.launchRequestId) {
    let releaseUnprovenTerminalHold = false;
    let releaseUnprovenTerminalHoldError = null;
    const statusProbe = await probeAmaCloserDispatchStatus({
      hqPath,
      launchRequestId: existingRecord.launchRequestId,
      asOwner: ownerUser,
      execFileImpl,
      env: process.env,
    });
    const status = statusProbe?.status || null;
    existingDispatchStatus = status;
    if (AMA_CLOSER_ACTIVE_STATUSES.has(status) || AMA_CLOSER_TERMINAL_HOLD_STATUSES.has(status)) {
      if (
        mergedSignalUnknown
        && (auditTerminalOutcome === 'succeeded' || AMA_CLOSER_TERMINAL_HOLD_STATUSES.has(status))
      ) {
        updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
          ...(current || existingRecord),
          lastObservedStatus: status,
          lastObservedAt: dispatchContext.dispatchedAt,
          lastError: `merged-signal-read-${mergedSignal.reason || 'unknown'}`,
        }));
        return retainExistingAmaCloserDispatch(existingRecord, workerClass, status);
      }
      if (auditTerminalOutcome === 'succeeded') {
        existingDispatchStatus = 'unverified-terminal-success';
        releaseUnprovenTerminalHold = true;
        releaseUnprovenTerminalHoldError = 'audit-succeeded-without-merged-signal';
      } else if (
        auditTerminalOutcome
        && auditTerminalOutcome !== 'succeeded'
        && !AMA_CLOSER_ACTIVE_STATUSES.has(status)
      ) {
        existingDispatchStatus = 'failed';
        releaseUnprovenTerminalHold = true;
        releaseUnprovenTerminalHoldError = statusProbe?.error || null;
      } else if (AMA_CLOSER_TERMINAL_HOLD_STATUSES.has(status)) {
        existingDispatchStatus = 'unverified-terminal-success';
        releaseUnprovenTerminalHold = true;
        releaseUnprovenTerminalHoldError = 'terminal-success-status-without-audit-or-merged-signal';
      } else {
        updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
          ...(current || existingRecord),
          lastObservedStatus: status,
          lastObservedAt: dispatchContext.dispatchedAt,
          lastError: statusProbe?.error || null,
        }));
        return {
          dispatched: false,
          skipMergeAgent: true,
          reason: `existing-dispatch-${status}`,
          workerClass: existingRecord.workerClass || workerClass,
          dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
          launchRequestId: existingRecord.launchRequestId || null,
          promptPath: existingRecord.promptPath || null,
        };
      }
    }
    if (releaseUnprovenTerminalHold) {
      const tokenRecord = {
        ...existingRecord,
        lastObservedStatus: existingDispatchStatus || status,
        lastObservedAt: dispatchContext.dispatchedAt,
      };
      await recordAmaCloserReviewerPassTokens({
        rootDir,
        hqRoot,
        repo,
        prNumber,
        record: tokenRecord,
        status: existingDispatchStatus || status,
        merged: auditTerminalOutcome === 'succeeded',
        observedAt: dispatchContext.dispatchedAt,
        ledgerTarget: dispatchContext.ledgerTarget || null,
        ledgerDbPath: dispatchContext.ledgerDbPath || null,
        env: process.env,
        pollDelaysMs: dispatchContext.closerTokenRollupPollDelaysMs || undefined,
        logger,
      });
      updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
        ...(current || existingRecord),
        lastObservedStatus: status,
        lastObservedAt: dispatchContext.dispatchedAt,
        lastError: releaseUnprovenTerminalHoldError,
      }));
    }
    if (status === 'unknown') {
      updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
        ...(current || existingRecord),
        lastObservedStatus: status,
        lastObservedAt: dispatchContext.dispatchedAt,
        lastError: statusProbe?.error || null,
      }));
      return noAmaDispatch({
        dispatched: false,
        skipMergeAgent: true,
        reason: 'dispatch-status-unknown',
        workerClass: existingRecord.workerClass || workerClass,
        dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
        launchRequestId: existingRecord.launchRequestId || null,
        promptPath: existingRecord.promptPath || null,
      });
    }
    if (AMA_CLOSER_RETRYABLE_STATUSES.has(status)) {
      await recordAmaCloserReviewerPassTokens({
        rootDir,
        hqRoot,
        repo,
        prNumber,
        record: {
          ...existingRecord,
          lastObservedStatus: status,
          lastObservedAt: dispatchContext.dispatchedAt,
        },
        status,
        merged: false,
        observedAt: dispatchContext.dispatchedAt,
        ledgerTarget: dispatchContext.ledgerTarget || null,
        ledgerDbPath: dispatchContext.ledgerDbPath || null,
        env: process.env,
        pollDelaysMs: dispatchContext.closerTokenRollupPollDelaysMs || undefined,
        logger,
      });
      await cleanupHammerCloserWorker({
        prNumber,
        workerClass,
        existingRecord,
        hqPath,
        hqRoot,
        execFileImpl,
        logger,
        reason: `terminal-status-${status}`,
      });
    }
    if (!releaseUnprovenTerminalHold && !AMA_CLOSER_RETRYABLE_STATUSES.has(status)) {
      return noAmaDispatch({ dispatched: false, reason: `dispatch-status-${status || 'unknown'}` });
    }
  } else if (existingRecordHasLivePendingInterruption) {
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'lease-held',
      existingLease: existingLeaseBeforeDispatch,
    });
  } else if (
    existingRecord
    && Number(existingRecord.retryCount || 0) >= AMA_CLOSER_REDISPATCH_BOUND
    && !existingRecordIsReclaimableInterruption
    && !existingRecordIsBranchHolderBlocked
  ) {
    // Genuine completed failures are bounded; an interrupted in-flight dispatch
    // (watcher SIGTERM'd mid-launch, e.g. a deploy bounce) is reclaimed below
    // only after the stale `pending` lease it left behind proves the owner died
    // or outlived the full hq dispatch retry loop.
    return noAmaDispatch({ dispatched: false, reason: 'dispatch-retry-exhausted' });
  } else if (
    existingRecordIsBranchHolderBlocked
    && existingBranchHolderBlockCount >= AMA_CLOSER_BRANCH_HOLDER_BLOCK_BOUND
  ) {
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'dispatch-branch-holder-block-exhausted',
      workerClass: existingRecord.workerClass || workerClass,
      dispatchId: existingRecord.dispatchId || existingRecord.launchRequestId || null,
      launchRequestId: existingRecord.launchRequestId || null,
      promptPath: existingRecord.promptPath || null,
    });
  }

  assertAmaAuditOwner({
    hqRoot,
    ownerUser,
    currentUser: dispatchContext.currentUser,
  });
  writeAmaAuditEntry({
    hqRoot,
    repo,
    prNumber,
    headSha: reviewedSha,
    now: dispatchContext.dispatchedAt,
    attempt: {
      outcome: 'in_progress',
      reviewedBy: dispatchContext.reviewedBy || null,
      requiredGateContext: dispatchContext.requiredGateContext || null,
      eligibilityTrace: verdict.trace,
      operatorApprovedEvidence: reviewState.operatorApprovedEvidence || null,
      adversarialMergeRequestedEvidence: options?.adversarialMergeRequested || null,
    },
    metadata: {
      reviewedBy: dispatchContext.reviewedBy || null,
      reviewSha: reviewedSha,
      riskClass: dispatchContext.riskClass || null,
      requiredGateContexts: dispatchContext.requiredGateContext
        ? [dispatchContext.requiredGateContext]
        : [],
      eligibilityReasons: bootstrapEligibilityReasons,
      mergeMethod,
      reconciliation: {
        needsRepair: false,
        lastVerifiedAt: dispatchContext.dispatchedAt || null,
      },
      operatorApprovedEvidence: reviewState.operatorApprovedEvidence || null,
      adversarialMergeRequestedEvidence: options?.adversarialMergeRequested || null,
    },
  });

  // Persist the prompt under watcher-owned repo state and pass that path
  // to `hq dispatch --prompt`. This avoids cross-user writes into HQ_ROOT.
  const promptPath = join(
    promptDir,
    `${repo.replace('/', '-')}-pr-${prNumber}-${reviewedSha}.md`,
  );
  if (writeFileImpl) {
    writeFileImpl(promptDir, promptPath, prompt);
  } else {
    mkdirSync(promptDir, { recursive: true });
    writeFileSync(promptPath, prompt, { encoding: 'utf8' });
  }

  // An interrupted in-flight dispatch already bumped retryCount before it was
  // killed without completing an attempt. Roll that phantom increment back so
  // the redispatch bound reflects only genuine completed failures and does not
  // inflate across repeated deploy-bounce interruptions.
  const priorRetryCount = existingRecordIsReclaimableInterruption
    ? Math.max(0, Number(existingRecord?.retryCount || 1) - 1)
    : Number(existingRecord?.retryCount || 0);
  // AOM-04: the orchestration switch is a deliberate no-op for merge-class
  // dispatch. Native and agentos both stay on `hq dispatch` because no bare
  // merge orchestration exists to fall back to.
  const mergeDispatchRoute = resolveMergeClassDispatchRoute({
    orchestrationMode: dispatchContext?.orchestrationMode ?? null,
    logger,
    repo,
    prNumber,
    workerClass,
    completionShape: 'decision-only',
  });
  if (mergeDispatchRoute !== 'hq-dispatch') {
    throw new Error(
      `[ama-closer] unsupported merge dispatch route=${JSON.stringify(mergeDispatchRoute)}`,
    );
  }
  writeAmaCloserDispatchRecord(rootDir, dispatchIdentity, {
    schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
    repo,
    prNumber,
    headSha: reviewedSha,
    workerClass,
    promptPath,
    promptDir,
    hqRoot,
    lastAttemptedAt: dispatchContext.dispatchedAt,
    dispatchedAt: null,
    dispatchId: existingRecord?.dispatchId || null,
    launchRequestId: existingRecord?.launchRequestId || null,
    retryCount: priorRetryCount + 1,
    branchHolderBlockCount: existingBranchHolderBlockCount,
    state: 'dispatching',
    lastObservedStatus: existingRecord?.lastObservedStatus || null,
    lastObservedAt: existingRecord?.lastObservedAt || null,
    lastError: null,
  });

  // AMA-07 — acquire the duplicate-dispatch lease immediately before
  // the hq launch, after every watcher-local preflight that can fail
  // without creating a live closer. This keeps transient local write
  // failures from leaving a permanent `pending` lease behind.
  let leaseResult = acquireAmaCloserLease({
    rootDir,
    ...leaseIdentity,
    watcherPid: typeof process !== 'undefined' ? process.pid : null,
    now: dispatchContext.dispatchedAt,
  });
  if (!leaseResult.acquired) {
    const existingLease = leaseResult.existingLease || readAmaCloserLease(rootDir, leaseIdentity);
    if (auditTerminalOutcome && auditTerminalOutcome !== 'succeeded') {
      deleteAmaCloserLease(rootDir, leaseIdentity);
      leaseResult = acquireAmaCloserLease({
        rootDir,
        ...leaseIdentity,
        watcherPid: typeof process !== 'undefined' ? process.pid : null,
        now: dispatchContext.dispatchedAt,
      });
    } else if (
      AMA_CLOSER_RETRYABLE_STATUSES.has(existingDispatchStatus || '')
      || (
        !existingRecord?.launchRequestId
        && isReclaimablePendingAmaCloserLease(existingLease, {
          now: dispatchContext.dispatchedAt,
          processKillImpl,
        })
      )
    ) {
      deleteAmaCloserLease(rootDir, leaseIdentity);
      leaseResult = acquireAmaCloserLease({
        rootDir,
        ...leaseIdentity,
        watcherPid: typeof process !== 'undefined' ? process.pid : null,
        now: dispatchContext.dispatchedAt,
      });
    }
  }
  if (!leaseResult.acquired) {
    return noAmaDispatch({
      dispatched: false,
      skipMergeAgent: true,
      reason: 'lease-held',
      existingLease: leaseResult.existingLease,
    });
  }

  // `hq dispatch` args mirror the existing merge-agent dispatch (see
  // src/follow-up-merge-agent.mjs around line 3866). Differences:
  //
  //   - `--worker-class` reads from cfg (default `hammer`); merge-agent
  //     uses the `merge-agent` resolver.
  //   - `--task-kind merge` matches merge-agent.
  //   - `--completion-shape decision-only` because the closer worker
  //     writes the audit JSON artifact; it does NOT open a PR. This
  //     prevents the dispatcher from injecting the default `pr`
  //     close-out (CLAUDE.md §"_apply_prompt_closeouts").
  //   - `--project adversarial-merge-authority` to keep audit + token
  //     accounting separate from the merge-agent stream.
  //   - `--ticket AMA-PR-<n>` so the launch is traceable per-PR.
  const repoBasename = repo.split('/')[1] || repo;
  const args = [
    'dispatch',
    '--worker-class', workerClass,
    '--task-kind', 'merge',
    '--completion-shape', 'decision-only',
    '--project', hqProject,
    '--repo', repoBasename,
    '--pr', String(prNumber),
    '--ticket', `AMA-PR-${prNumber}`,
    '--parent-session', dispatchContext.parentSession,
    '--prompt', promptPath,
    '--root', hqRoot,
  ];
  if (repoBasename !== AGENT_OS_TOOLING_REPO) {
    args.push('--additional-repo', AGENT_OS_TOOLING_REPO);
  }

  let execResult;
  let transientRetryIndex = 0;
  for (;;) {
    try {
      execResult = await execFileImpl(hqPath, args, {
        env: process.env,
        maxBuffer: 5 * 1024 * 1024,
        // CFG-knobbed (roles.adversarial.merge_authority.dispatch_timeout_ms,
        // default 300s). The old hardcoded 90s was below the merge-worker
        // provision time (~57s baseline, slower under contention), so the
        // watcher SIGTERM'd healthy dispatches before they returned an lrq ->
        // dispatch-failed -> the hammer never closed.
        timeout: Number(cfg?.dispatchTimeoutMs) > 0 ? Number(cfg.dispatchTimeoutMs) : 300_000,
        killSignal: 'SIGTERM',
      });
      break;
    } catch (err) {
      if (isTransientHqDispatchError(err) && transientRetryIndex < AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS.length) {
        const delayMs = Number(AMA_CLOSER_DISPATCH_TRANSIENT_RETRY_DELAYS_MS[transientRetryIndex]) || 0;
        transientRetryIndex += 1;
        await sleep(delayMs);
        continue;
      }
      const parsedFailure = normalizeDispatchIdentifiers(parseAmaCloserDispatchOutput(err?.stdout || ''));
      const ambiguousLaunch = Boolean(parsedFailure.launchRequestId || parsedFailure.dispatchId);
      const branchHolderBlocked = !ambiguousLaunch && isProvisionBranchHolderBlocked(err);
      // A throttle / OAuth-broker outage / host-offline window is TRANSIENT: the
      // dispatch did not fail on its merits, GitHub or the broker was merely
      // unavailable. Treat it like a branch-holder block for budget purposes —
      // do NOT decrement the persisted redispatch budget toward
      // `dispatch-retry-exhausted`. Otherwise a transient rate-limit storm
      // permanently grounds the closer for a PR even after the limit resets,
      // which is exactly the cascade observed in the macOS-upgrade incident.
      const transientFailure = !ambiguousLaunch
        && !branchHolderBlocked
        && isTransientHqDispatchError(err);
      const budgetPreservingFailure = branchHolderBlocked || transientFailure;
      const updatedDispatchRecord = updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => {
        const branchHolderBlockCount = branchHolderBlocked
          ? Number(current?.branchHolderBlockCount || existingBranchHolderBlockCount) + 1
          : Number(current?.branchHolderBlockCount || existingBranchHolderBlockCount);
        return {
          ...(current || {}),
          schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
          repo,
          prNumber,
          headSha: reviewedSha,
          workerClass,
          promptPath,
          promptDir,
          hqRoot,
          lastAttemptedAt: dispatchContext.dispatchedAt,
          dispatchedAt: ambiguousLaunch ? dispatchContext.dispatchedAt : null,
          dispatchId: parsedFailure.dispatchId,
          launchRequestId: parsedFailure.launchRequestId,
          retryCount: budgetPreservingFailure
            ? priorRetryCount
            : Number(current?.retryCount || priorRetryCount + 1),
          branchHolderBlockCount,
          state: ambiguousLaunch ? 'dispatched' : (
            branchHolderBlocked && branchHolderBlockCount >= AMA_CLOSER_BRANCH_HOLDER_BLOCK_BOUND
              ? 'dispatch-branch-holder-block-exhausted'
              : (branchHolderBlocked
                ? 'dispatch-blocked-branch-holder'
                : (transientFailure ? 'dispatch-deferred-transient' : 'dispatch-failed'))
          ),
          lastObservedStatus: ambiguousLaunch ? 'unknown' : (branchHolderBlocked ? 'blocked' : null),
          lastObservedAt: ambiguousLaunch || branchHolderBlocked ? dispatchContext.dispatchedAt : null,
          lastFailureTransient: transientFailure,
          lastError: String(err?.stderr || err?.message || err),
        };
      });
      const branchHolderBlockExhausted = branchHolderBlocked
        && Number(updatedDispatchRecord?.branchHolderBlockCount || 0) >= AMA_CLOSER_BRANCH_HOLDER_BLOCK_BOUND;
      return noAmaDispatch({
        dispatched: false,
        // Transient failures keep the merge-agent fallback suppressed so the
        // closer (not merge-agent) re-dispatches once the throttle/broker
        // clears, since the budget was preserved above and re-dispatch is
        // guaranteed to be retry-eligible on the next tick.
        skipMergeAgent: branchHolderBlocked || ambiguousLaunch || transientFailure,
        reason: ambiguousLaunch ? 'dispatch-response-ambiguous' : (
          branchHolderBlocked ? (
            branchHolderBlockExhausted
              ? 'dispatch-branch-holder-block-exhausted'
              : 'dispatch-branch-holder-blocked'
          ) : (
            transientFailure ? 'dispatch-deferred-transient' : 'dispatch-failed'
          )
        ),
        error: String(err?.stderr || err?.message || err),
        workerClass,
        dispatchId: parsedFailure.dispatchId || null,
        launchRequestId: parsedFailure.launchRequestId || null,
        promptPath,
      });
    }
  }

  const parsed = normalizeDispatchIdentifiers(parseAmaCloserDispatchOutput(execResult?.stdout || ''));
  updateAmaCloserDispatchRecord(rootDir, dispatchIdentity, (current) => ({
    ...(current || {}),
    schemaVersion: AMA_CLOSER_DISPATCH_SCHEMA_VERSION,
    repo,
    prNumber,
    headSha: reviewedSha,
    workerClass,
    promptPath,
    promptDir,
    hqRoot,
    lastAttemptedAt: dispatchContext.dispatchedAt,
    dispatchedAt: dispatchContext.dispatchedAt,
    dispatchId: parsed.dispatchId,
    launchRequestId: parsed.launchRequestId,
    retryCount: Number(current?.retryCount || priorRetryCount + 1),
    branchHolderBlockCount: 0,
    state: 'dispatched',
    lastObservedStatus: 'starting',
    lastObservedAt: dispatchContext.dispatchedAt,
    lastError: null,
  }));

  // AMA-07 — promote the lease from `pending` to `dispatched` now
  // that hq accepted the launch request. Failure here is best-effort:
  // log via the result but do NOT undo the dispatch (the closer worker
  // is already running). The next watcher tick will reconcile.
  let leaseUpdateError = null;
  try {
    updateAmaCloserLease({
      rootDir,
      ...leaseIdentity,
      status: AMA_CLOSER_LEASE_STATUS.DISPATCHED,
      lrqId: parsed.launchRequestId || parsed.dispatchId || 'unknown',
      now: dispatchContext.dispatchedAt,
    });
  } catch (err) {
    leaseUpdateError = String(err?.message || err);
  }

  return {
    dispatched: true,
    workerClass,
    dispatchId: parsed.dispatchId || parsed.launchRequestId || null,
    launchRequestId: parsed.launchRequestId || null,
    promptPath,
    eligibilityReasons: verdict.trace,
    leasePath: leaseResult.leasePath,
    ...(leaseUpdateError ? { leaseUpdateError } : {}),
  };
}
