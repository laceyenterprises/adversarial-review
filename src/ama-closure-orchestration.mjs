import { operatorLabelInputs } from './ama/operator-label-inputs.mjs';
import { holdForOperatorLabels } from './ama/operator-label-gates.mjs';
import { reconcileHammerResumes, settleHammerResume } from './ama/hammer-resume.mjs';
import { hammerHeadOwnership } from './hammer-head-ownership.mjs';
import { reviewCeilingOwner } from './review-ceiling-owner.mjs';
import { infrastructureOnlyFailures } from './ci-infrastructure.mjs';
import { recoverInfrastructureChecks } from './ci-recovery.mjs';
import { recoverInfrastructureCiStops } from './remediation-ci-infrastructure.mjs';
import { evaluateHammerStopHold } from './ama/hammer-stop-hold.mjs';
import { deriveNextActionSnapshot, hasLiveRemediationJob, isClosureRecoveryDecision, nextAction } from './pr-next-action.mjs';
import { withDaemonMergeReservation } from './ama/merge-lease.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { withClosureEvaluationReadCache } from './closure-evaluation-cache.mjs';
import { resolveHqRoot } from './hq-root.mjs';
import { fleetStopReason } from './fleet-stop.mjs';
import { recordOperatorNoticeCloserOutcome } from './operator-decision-notice.mjs';
import { checkPrimaryChange, fetchPrimaryChange } from './ama/primary-change.mjs';
import { readHammerStopForHead, readHammerStopHoldForHead, isInfrastructureStop, isLegacyReviewHandoffStop } from './ama/hammer-stop-hold.mjs';
import { evaluateHammerRetryCap, readHammerRetryCapLedger, rearmOperatorApprovedCloser } from './ama/hammer-retry-cap.mjs';
import { resolveSharedNextAction } from './pr-next-action-shadow.mjs';
import { createHistoryReader } from './ama/history-reader.mjs';
import { hammerDispatchMismatch, bindClosureNextAction, readClosureNextAction, observeClosureOwnership, closureOwnerFromDecision, hasHammerDispatchIntent, observeClosureResult, observeDaemonGate as reviseDaemonGate, observeDaemonResult, revalidateClosurePr, resolveClosureNextAction, reviseClosureNextAction } from './ama/closure-next-action.mjs';
import { probeOrphanOwnership } from './ama/orphan-watchdog.mjs';
import { observeClosureWait } from './ama/closure-wait.mjs';
import { observeClosureDecisionMismatch, observeClosureRefreshLoop } from './ama/closure-refresh-loop.mjs';
import { closureOwnerShadowEvidence, shadowNextActionLater } from './pr-next-action-consumer.mjs';
import { hostname } from 'node:os';
import { OPERATOR_HOLD_LABELS } from './operator-hold-labels.mjs';
import { isOrphanHeadReviewRequested } from './orphan-head-review-requested.mjs';
import { recoverOrphan, isOrphanRecoveryWait, hasExactHeadReviewDecision, overdueNextAction } from './ama/orphan-watchdog.mjs';
import { observeClosureLag } from './ama/closure-lag.mjs';
// ── AMA closure orchestration: dispatch decision + coexistence + audit ────────
//
// ARC-18: extracted from watcher.mjs. The AMA (autonomous-merge-authority)
// closure-dispatch decision core (`maybeDispatchAmaClosureFor`), its result
// wrapper (`withAmaDispatchMetadata`), the disabled-mode audit writer, and the
// merge-agent coexistence resolver moved here as a leaf. `resolveOrchestrationMode`
// is imported from ./pr-lifecycle-sync.mjs (extracted earlier this batch). ROOT,
// execFileAsync, and the cluster-exclusive merge-authority/mergeability consts are
// re-derived/moved verbatim (pure, derivable from the same inputs).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGateStatusContext } from './adversarial-gate-context.mjs';
import { buildAdversarialGateSnapshot } from './adversarial-gate-status.mjs';
import { writeAmaAuditEntry } from './ama/audit.mjs';
import {
  COEXISTENCE_ACTION,
  decideMergeAgentCoexistence,
  isMergeAgentRequestedScoped,
  mergeAgentDispatchEnvForAction,
} from './ama/coexistence.mjs';
import {
  DAEMON_MERGE_DISPOSITION,
  isDaemonMergeReviewAllowed,
} from './ama/daemon-merge.mjs';
import * as amaDispatchCloser from './ama/dispatch-closer.mjs';
import { companionOnlyStop } from './ama/companion-stop-wait.mjs';
import { deliverAlert } from './alert-delivery.mjs';
import { isEligibleForAmaClosure, SETTLED_SUCCESS_VERDICTS } from './ama/eligibility.mjs';
import { evaluateMergeEligibility } from './ama/merge-eligibility.mjs';
import { resolveHammerAdjudication } from './ama/hammer-adjudication.mjs';
import {
  findMalformedProtectivePredecessorLines,
  isProtectorOpen,
  parseProtectivePredecessorDeclaration,
  PROTECTIVE_PREDECESSOR_HOLD_REASONS,
  protectivePredecessorMergeWindowFinding,
  resolveProtectivePredecessorDeclaration,
} from './ama/protective-predecessor.mjs';
import { isSafetyRecoveryHold, recoverAmaAutomation } from './ama/automated-recovery.mjs';
import { amaRetainLoopCapFor } from './kernel/convergence-budget.mjs';
import { amaAuthoritativeReviewerLoginsForModel } from './ama/reviewer-authority.mjs';
import { resolveRequiredCheckContextsFromCfg } from './ama/required-check-contexts.mjs';
import { loadConfigCached } from './config-loader.mjs';
import { abandonAmaCloserLease, reconcileAndAbandonAmaCloserLease } from './ama/abandoned-closer-lease.mjs';
import { loadDomainConfig } from './domain-config.mjs';
import { resolveMergeAuthorityConfigFromDomain } from './domain-policy.mjs';
import {
  AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS,
  fetchLatestHeadReviewBodiesWithRetry,
  headHasValidatedHamTerminalRemediation,
  runDaemonCleanMergeAttempt,
} from './daemon-clean-merge.mjs';
import {
  clearDaemonMergePark,
  recordDaemonMergePark,
} from './daemon-merge-park-log.mjs';
import {
  clearDaemonRouteDisagreement,
} from './daemon-route-disagreement.mjs';
import {
  findLiveAmaCloserLease,
  isHeldAmaCloserLease,
  readAmaCloserLease,
  rekeyAmaCloserLease,
} from './ama/closer-lease.mjs';
import { requestEligibleHammerWake } from './hammer-wake.mjs';
import {
  closerAuthoredStaleEligible,
  proveCloserAuthoredStaleHead,
  writeCloserAuthoredStaleAudit,
} from './closer-authored-stale.mjs';
import { listFollowUpJobsInDir, resolveRoundBudgetForJob, summarizePRRemediationLedger } from './follow-up-jobs.mjs';
import { findFinalRemediationPushJob } from './comment-only-final-round.mjs';
import { classifyCheckRollup, summarizeChecksConclusion } from './checks-summary.mjs';
import { CI_BLOCKED_HAMMER_RESCUE_PREFIXES } from './reviewer-ci-admission.mjs';
import { summarizeExternalChecks } from './remediation-ci-regression.mjs';
import {
  AMA_HAMMER_BACKGROUND_REASON,
  amaHammerBackgroundProgress,
  amaHammerBackgroundKey,
  amaHammerBackgroundQueue,
  resolveAmaHammerDispatchMode,
} from './ama-hammer-background-dispatch.mjs';
import { execGhWithRetry, isTransientGhError } from './gh-cli.mjs';
import { fetchPullRequestMergeability, fetchReviewBodiesForHead } from './github-api.mjs';
import {
  closureGateMergeability,
  normalizeGithubMergeability,
  resolveMergeabilityWithSampling,
} from './github-mergeability.mjs';
import {
  buildNonReviewableHeadDeltaEvidence,
  fetchHeadCloserVerifiedCommit,
  getHeadCloserCommitSuppression,
} from './head-closer-commit-suppression.mjs';
import { isDismissStaleRequestChangesOnResolvedEnabled } from './merge-agent-dispatch-decision.mjs';
import { resolveOrchestrationMode } from './pr-lifecycle-sync.mjs';
import { dismissSupersededBlockingVerdictAtRemediatedHead } from './superseded-blocking-verdict-dismissal.mjs';
import {
  countCompletedReviewerRereviewRounds,
  reviewCycleExhaustedFromRounds,
} from './review-ceiling-metrics.mjs';

// Rolling process-local diagnostics include acknowledgements from background
// dispatches that settle between ticks. No durable state or merge authority.
const finalReviewHammerLatencies = [];
export function resetFinalReviewHammerLatenciesForTesting() {
  finalReviewHammerLatencies.length = 0;
}

export function recordFinalReviewHammerLatency(latencyMs, at = Date.now()) {
  if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
  finalReviewHammerLatencies.push({ latencyMs, at });
  if (finalReviewHammerLatencies.length > 10000) finalReviewHammerLatencies.shift();
}

export function finalReviewHammerLatencySummary(now = Date.now()) {
  let retained = 0;
  for (const sample of finalReviewHammerLatencies) {
    // Compact once, also handling timestamps reordered by a wall-clock change.
    if (sample.at >= now - 86400000) finalReviewHammerLatencies[retained++] = sample;
  }
  finalReviewHammerLatencies.length = retained;
  const values = finalReviewHammerLatencies.map(s => s.latencyMs).sort((a, b) => a - b);
  return { window_ms: 86400000, samples: values.length,
    p50_ms: values.length ? values[Math.ceil(values.length * 0.5) - 1] : null,
    p95_ms: values.length ? values[Math.ceil(values.length * 0.95) - 1] : null };
}

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The adversarial-review config module. The node watcher normally reads config
// from env vars exported by the shell `agent_os_config_export`, but that shell
// exporter mis-resolves nested overrides (2026-07-16: it emits
// AGENT_OS_CFG_..._LHA_CONSUME_ATTESTATIONS=true even when this file sets it
// false, so the merge-authority daemon kept enforcing head-attestation
// consumption and parked every worker PR worker-identity-unresolved). Loading
// this file as a config MODULE makes the authoritative, reviewed config.yaml win
// for the keys it sets (verified: consume_attestations flips to false while
// env-sourced keys like `enabled` are preserved) — the right posture for the
// security-critical merge-authority read.
const WATCHER_MERGE_AUTHORITY_CONFIG_MODULES = Object.freeze([join(ROOT, 'config.yaml')]);
const {
  maybeDispatchAmaCloser,
  namedAmaNoDispatchReason,
} = amaDispatchCloser;

const PROTECTIVE_DEPENDENT_LOOKUP_CACHE_MS = 60_000;
const mergedProtectiveDependentsCache = new Map();

function githubSearchPhrase(value) {
  const phrase = String(value || '').replace(/"/gu, ' ').replace(/\s+/gu, ' ').trim();
  return `"${phrase}"`;
}

function isGhNotFoundError(err) {
  const detail = [
    err?.code,
    err?.status,
    err?.statusCode,
    err?.stderr,
    err?.stdout,
    err?.message,
  ].filter(Boolean).join('\n').toLowerCase();
  return /\b404\b/.test(detail)
    || detail.includes('not found')
    || detail.includes('could not resolve to a pullrequest')
    || detail.includes('no pull requests found');
}

function protectivePredecessorStateError(reason, err) {
  const error = new Error(err?.message || String(err || reason));
  error.protectivePredecessorReason = reason;
  error.cause = err;
  if (err?.stderr) error.stderr = err.stderr;
  if (err?.stdout) error.stdout = err.stdout;
  if (err?.code) error.code = err.code;
  return error;
}

async function fetchProtectivePredecessorStateForPr({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  logger = console,
} = {}) {
  try {
    const { stdout } = await execGhWithRetryImpl({
      execFileImpl,
      args: [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'state',
      ],
      timeoutMs: loadAwareTimeoutMs(30_000),
      log: logger,
    });
    const parsed = JSON.parse(String(stdout || '{}'));
    const state = String(parsed?.state || '').trim().toUpperCase();
    if (!state) {
      throw protectivePredecessorStateError(
        'protective-predecessor-state-unreadable',
        new Error(`protector #${prNumber} state missing`),
      );
    }
    return {
      state,
      prState: state,
      isOpen: state === 'OPEN',
    };
  } catch (err) {
    if (err?.protectivePredecessorReason) throw err;
    throw protectivePredecessorStateError(
      isGhNotFoundError(err)
        ? 'protective-predecessor-not-found'
        : 'protective-predecessor-state-unreadable',
      err,
    );
  }
}

async function fetchCurrentPrStateForBackgroundDispatch({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  logger = console,
} = {}) {
  const { stdout } = await execGhWithRetryImpl({
    execFileImpl,
    args: [
      'pr', 'view', String(prNumber), '--repo', repo,
      '--json', 'state,headRefOid,isDraft,mergeable,mergeStateStatus,statusCheckRollup,labels',
    ],
    timeoutMs: loadAwareTimeoutMs(30_000),
    log: logger,
  });
  const parsed = JSON.parse(String(stdout || '{}'));
  return {
    state: String(parsed?.state || '').trim().toUpperCase(),
    headSha: String(parsed?.headRefOid || '').trim(),
    isDraft: parsed?.isDraft === true,
    mergeable: String(parsed?.mergeable || '').trim().toUpperCase(),
    mergeStateStatus: String(parsed?.mergeStateStatus || '').trim().toUpperCase(),
    ...(Array.isArray(parsed.statusCheckRollup) ? { statusCheckRollup: parsed.statusCheckRollup } : {}),
    ...(Array.isArray(parsed.labels) ? { labels: parsed.labels.map(label => typeof label === 'string' ? label : label.name) } : {}),
  };
}

export async function fetchMergedProtectiveDependentsForPr({
  repo,
  prNumber,
  execFileImpl = execFileAsync,
  execGhWithRetryImpl = execGhWithRetry,
  logger = console,
  now = () => Date.now(),
  cacheTtlMs = PROTECTIVE_DEPENDENT_LOOKUP_CACHE_MS,
} = {}) {
  const target = Number(prNumber);
  if (!repo || !Number.isInteger(target) || target <= 0) return [];
  const cacheKey = `${repo}#${target}`;
  const nowMs = Number(now());
  const resolvedNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cached = mergedProtectiveDependentsCache.get(cacheKey);
  if (
    cached
    && resolvedNowMs - Number(cached.storedAtMs || 0) < Math.max(0, Number(cacheTtlMs) || 0)
  ) {
    return cached.value;
  }
  const query = [
    `repo:${repo}`,
    'is:pr',
    'is:merged',
    githubSearchPhrase('Protects-Against-Unsafe-Merge-Until-PR'),
    String(target),
  ].join(' ');
  let stdout;
  try {
    ({ stdout } = await execGhWithRetryImpl({
      execFileImpl,
      args: [
        'api',
        `search/issues?q=${encodeURIComponent(query)}&per_page=50`,
      ],
      timeoutMs: loadAwareTimeoutMs(30_000),
      log: logger,
    }));
  } catch (err) {
    logger?.warn?.(
      `[watcher] protective predecessor dependent lookup failed for ${repo}#${target}: ${err?.message || err}`,
    );
    logger?.warn?.(JSON.stringify({
      event: 'ama.protective_predecessor.dependent_lookup_failed',
      repo,
      prNumber: target,
      error: err?.message || String(err),
    }));
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '{}'));
  } catch (err) {
    logger?.warn?.(
      `[watcher] protective predecessor dependent lookup returned invalid JSON for ${repo}#${target}: ${err?.message || err}`,
    );
    return [];
  }
  const value = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((item) => {
      const declaration = parseProtectivePredecessorDeclaration(item?.body || '');
      if (!declaration || !declaration.protectorPrNumbers?.includes(target)) return null;
      return {
        repo,
        prNumber: Number(item?.number),
        state: 'MERGED',
        mergedAt: item?.pull_request?.merged_at || item?.closed_at || null,
        protectivePredecessor: declaration,
      };
    })
    .filter((item) => Number.isInteger(item?.prNumber) && item.prNumber > 0);
  mergedProtectiveDependentsCache.set(cacheKey, { storedAtMs: resolvedNowMs, value });
  return value;
}

async function evaluateProtectivePredecessorHoldForClosure({
  repo,
  prNumber,
  body,
  fetchProtectivePredecessorStateImpl = fetchProtectivePredecessorStateForPr,
  execFileImpl = execFileAsync,
  logger = console,
} = {}) {
  const malformedLines = findMalformedProtectivePredecessorLines(body);
  if (malformedLines.length > 0) {
    const finding = protectivePredecessorMergeWindowFinding({
      repo,
      dependentPrNumber: prNumber,
      protectorPrNumber: 0,
      outcome: 'malformed-trailer',
      detail: { malformedLines },
    });
    return {
      reason: 'protective-predecessor-malformed-trailer',
      finding,
      protectivePredecessor: { malformedLines },
    };
  }

  const declaration = resolveProtectivePredecessorDeclaration({ prBody: body });
  if (!declaration) return null;
  const protectorPrNumbers = Array.isArray(declaration.protectorPrNumbers)
    ? declaration.protectorPrNumbers
    : [declaration.protectorPrNumber];
  for (const protectorPrNumber of protectorPrNumbers) {
    if (Number(protectorPrNumber) === Number(prNumber)) {
      logger?.warn?.(
        `[watcher] protective predecessor self-reference for ${repo}#${prNumber}; ignoring malformed declaration`,
      );
      continue;
    }
    let protectorState = null;
    try {
      protectorState = await fetchProtectivePredecessorStateImpl({
        repo,
        prNumber: protectorPrNumber,
        dependentPrNumber: prNumber,
        execFileImpl,
        logger,
      });
    } catch (err) {
      const reason = err?.protectivePredecessorReason || 'protective-predecessor-state-unreadable';
      const finding = protectivePredecessorMergeWindowFinding({
        repo,
        dependentPrNumber: prNumber,
        protectorPrNumber,
        outcome: reason === 'protective-predecessor-not-found' ? 'not-found' : 'state-unreadable',
        reason: err?.message || null,
      });
      return {
        reason,
        finding,
        protectivePredecessor: { ...declaration, protectorPrNumber },
      };
    }
    const protectorStateText = String(protectorState?.state ?? protectorState?.prState ?? '').trim();
    if (!protectorStateText && protectorState?.isOpen !== true && protectorState?.isOpen !== false) {
      const finding = protectivePredecessorMergeWindowFinding({
        repo,
        dependentPrNumber: prNumber,
        protectorPrNumber,
        outcome: 'state-unreadable',
      });
      return {
        reason: 'protective-predecessor-state-unreadable',
        finding,
        protectivePredecessor: { ...declaration, protectorPrNumber },
      };
    }
    if (isProtectorOpen(protectorState)) {
      const finding = protectivePredecessorMergeWindowFinding({
        repo,
        dependentPrNumber: prNumber,
        protectorPrNumber,
        outcome: 'held-before-merge',
      });
      return {
        reason: 'protective-predecessor-open',
        finding,
        protectivePredecessor: { ...declaration, protectorPrNumber },
      };
    }
  }
  return null;
}

async function emitProtectivePredecessorFindingToLog(logger, finding) {
  logger?.warn?.(JSON.stringify({
    event: 'ama.protective_predecessor.finding',
    ...finding,
  }));
}

export class AmaCoexistenceAbortError extends Error {
  constructor(reason = 'ama-coexistence-aborted') {
    super(reason);
    this.name = 'AmaCoexistenceAbortError';
    this.code = 'AMA_COEXISTENCE_ABORTED';
  }
}

export class AmaCoexistenceOperationTimeoutError extends Error {
  constructor(operation, timeoutMs) {
    super(`ama-coexistence operation timed out: ${operation}`);
    this.name = 'AmaCoexistenceOperationTimeoutError';
    this.code = 'AMA_COEXISTENCE_OPERATION_TIMEOUT';
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new AmaCoexistenceAbortError();
}

function abortableSleep(ms, signal) {
  throwIfAborted(signal);
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new AmaCoexistenceAbortError());
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function trackCoexistenceOperation(operationTracker, operation) {
  if (!operationTracker || typeof operationTracker !== 'object') {
    return () => {};
  }
  const previous = operationTracker.current || null;
  const previousStartedMs = operationTracker.currentStartedMs || null;
  operationTracker.current = operation;
  operationTracker.currentStartedMs = performance.now();
  return () => {
    operationTracker.current = previous;
    operationTracker.currentStartedMs = previousStartedMs;
  };
}

// Head-bound read proofs only. Live review/CI reads and side effects are never
// reusable merge authority; those operations still execute on every pass.
export const AMA_REUSABLE_PROOF_OPERATIONS = new Set([
  'closer-only-review-delta', 'stale-head-suppression-proof',
  'head-closer-verified-commit', 'ham-terminal-remediation-evidence',
]);
export function createAmaProofCache({ maxEntries = 256, workTimeoutMs = loadAwareTimeoutMs(180_000),
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  maxEntries = Number.isFinite(Number(maxEntries)) ? Math.max(1, Math.floor(Number(maxEntries))) : 256;
  const entries = new Map();
  return {
    scope({ rootDir, repo, prNumber, reviewedHead, currentHead, evidenceVersion }) {
      const pr = JSON.stringify([rootDir, repo, prNumber]);
      const key = JSON.stringify([rootDir, repo, prNumber, reviewedHead, currentHead]);
      for (const [oldKey, entry] of entries) {
        if (entry.pr === pr && oldKey !== key) { entry.controller.abort(); entries.delete(oldKey); }
      }
      if (!entries.has(key)) {
        entries.set(key, { pr, reads: new Map(), controller: new AbortController(), evidenceVersion });
        while (entries.size > maxEntries) {
          const oldest = entries.keys().next().value;
          entries.get(oldest).controller.abort();
          entries.delete(oldest);
        }
      }
      const entry = entries.get(key);
      // Keep hot proof scopes resident when unrelated proof scopes arrive.
      entries.delete(key);
      entries.set(key, entry);
      if (entry.evidenceVersion !== evidenceVersion) {
        for (const name of entry.reads.keys()) {
          if (name.startsWith('ham-terminal-remediation-evidence')) entry.reads.delete(name);
        }
        entry.evidenceVersion = evidenceVersion;
      }
      const { reads, controller: scopeController } = entry;
      return {
        read(name, fn) {
          if (!reads.has(name)) {
            const controller = new AbortController();
            const signal = AbortSignal.any([scopeController.signal, controller.signal]);
            let timer;
            const deadline = new Promise((_, reject) => {
              timer = setTimeoutFn(() => {
                const error = new AmaCoexistenceOperationTimeoutError(name, workTimeoutMs);
                controller.abort(error);
                reject(error);
              }, workTimeoutMs);
              timer?.unref?.();
            });
            const work = Promise.race([Promise.resolve().then(() => {
              throwIfAborted(signal);
              return fn(signal);
            }), deadline]).finally(() => clearTimeoutFn(timer));
            reads.set(name, work);
            work.catch(() => { if (reads.get(name) === work) reads.delete(name); });
          }
          return reads.get(name);
        },
      };
    },
  };
}
export function runAmaProofOperation(scope, operation, fn, options) {
  return runTimedCoexistenceOperation(operation,
    () => scope.read(options?.cacheKey || operation, proofSignal => fn({ signal: proofSignal })), options);
}
// Injected readers have independent caches, keeping offline fixtures isolated.
const proofCaches = new WeakMap();
function proofCacheFor(reader) {
  if (!proofCaches.has(reader)) proofCaches.set(reader, createAmaProofCache());
  return proofCaches.get(reader);
}

function headProofScope(reader, { rootDir, repoPath, prNumber, reviewStateRow, candidate, currentRevisionRef, dispatchJob }) {
  return proofCacheFor(reader).scope({
    rootDir, repo: repoPath, prNumber, reviewedHead: reviewStateRow?.reviewer_head_sha,
    currentHead: candidate?.headSha || currentRevisionRef,
    evidenceVersion: JSON.stringify([candidate?.prUpdatedAt, reviewStateRow?.review_body, dispatchJob?.reviewBody]),
  });
}

async function runTimedCoexistenceOperation(
  operation,
  fn,
  {
    timeoutMs = null,
    parentSignal = null,
    operationTracker = null,
    logger = null,
    repoPath = null,
    prNumber = null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  throwIfAborted(parentSignal);
  const stopTracking = trackCoexistenceOperation(operationTracker, operation);
  const effectiveTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.max(1, Math.floor(Number(timeoutMs)))
    : null;
  const controller = effectiveTimeoutMs ? new AbortController() : null;
  let timer = null;
  let timedOut = false;
  const childSignal = controller?.signal || parentSignal;
  const onParentAbort = () => {
    controller?.abort(parentSignal?.reason instanceof Error ? parentSignal.reason : new AmaCoexistenceAbortError());
  };
  parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });
  try {
    const work = Promise.resolve().then(() => fn({ signal: childSignal }));
    if (!effectiveTimeoutMs) return await work;
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutFn(() => {
        timedOut = true;
        const err = new AmaCoexistenceOperationTimeoutError(operation, effectiveTimeoutMs);
        controller.abort(err);
        reject(err);
      }, effectiveTimeoutMs);
    });
    return await Promise.race([work, timeout]);
  } catch (err) {
    if (timedOut || err?.code === 'AMA_COEXISTENCE_OPERATION_TIMEOUT') {
      logger?.warn?.(
        `[watcher] AMA coexistence operation timed out for ${repoPath || 'unknown'}#${prNumber || 'unknown'}: ` +
          `operation=${operation} timeout_ms=${effectiveTimeoutMs}`,
      );
    }
    throw err;
  } finally {
    if (timer !== null) clearTimeoutFn(timer);
    parentSignal?.removeEventListener?.('abort', onParentAbort);
    stopTracking();
  }
}

export function normalizeCompletedRoundCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// Transient mergeability sampling window (GitHub returns mergeable=UNKNOWN right
// after a push / base move while it recomputes). Re-sample so an otherwise-eligible
// PR resolves this tick; an UNKNOWN that survives sampling reads as the transient
// `pr-mergeability-unknown` (retried next tick; on its own never hammered or parked,
// and alongside a real remediable miss it does not block that miss's hammer
// fallback), while a real CONFLICTING state reads as hammer-remediable `pr-not-mergeable`.
// Env-overridable.
const MERGEABILITY_SAMPLE_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.ADVERSARIAL_MERGEABILITY_SAMPLE_ATTEMPTS || '', 10) || 3,
);
const MERGEABILITY_SAMPLE_DELAY_MS = Math.max(
  0,
  Number.parseInt(process.env.ADVERSARIAL_MERGEABILITY_SAMPLE_DELAY_MS || '', 10) || 2500,
);
export const DEFAULT_AMA_CLOSURE_OPERATION_TIMEOUT_MS = 5_000;

// DIRTYOWN-02: a bare `reason=not-eligible` does not say which eligibility
// reasons parked the PR, so the background log lines carry the array too.
function formatAmaResultReasons(result) {
  return Array.isArray(result?.reasons) ? ` reasons=[${result.reasons.join(',')}]` : '';
}

function withAmaDispatchMetadata(result, { amaEnabled }) {
  if (!result || typeof result !== 'object') return result;
  const wrapped = {
    ...result,
    amaEnabled: result.amaEnabled === undefined ? amaEnabled : result.amaEnabled,
  };
  if (wrapped.dispatched === false && !wrapped.namedReason) {
    wrapped.namedReason = namedAmaNoDispatchReason(
      wrapped.reason || 'unknown',
      wrapped.reasons,
    );
  }
  return wrapped;
}

export function writeAutonomousMergeDisabledAudit({
  hqRoot,
  repoPath,
  prNumber,
  headSha,
  path,
  eligibilityReasons = [],
  flagState = {},
  reviewStateRow = {},
  reviewState = {},
  writeAuditImpl = writeAmaAuditEntry,
  now = new Date().toISOString(),
  logger = console,
} = {}) {
  if (!hqRoot || !repoPath || !Number.isFinite(Number(prNumber)) || !headSha) {
    return { written: false, reason: 'audit-inputs-missing' };
  }
  const normalizedPath = path === 'hammer-merge' ? 'hammer-merge' : 'daemon-merge';
  const normalizedReasons = Array.isArray(eligibilityReasons) ? eligibilityReasons : [];
  const normalizedFlagState = {
    autonomousMergeExecutionEnabled: flagState.autonomousMergeExecutionEnabled === true,
    strictMode: flagState.strictMode !== false,
  };
  try {
    writeAuditImpl({
      hqRoot,
      repo: repoPath,
      prNumber: Number(prNumber),
      headSha,
      attempt: {
        outcome: 'failed-without-merge',
        path: normalizedPath,
        attemptPhase: 'autonomous-merge-disabled',
        reason: 'autonomous-merge-execution-disabled',
        eligibilityReasons: normalizedReasons,
        preMergeReasons: normalizedReasons,
        flagState: normalizedFlagState,
        validatedHead: headSha,
      },
      metadata: {
        closureAuthority: normalizedPath,
        reviewer: reviewStateRow?.reviewer || '',
        riskClass: reviewState?.riskClass || 'unknown',
        flagState: normalizedFlagState,
      },
      now,
    });
    return { written: true, reason: 'autonomous-merge-execution-disabled' };
  } catch (err) {
    logger?.warn?.(
      `[watcher] autonomous merge disabled audit failed for ${repoPath}#${prNumber}@${headSha}: ` +
        `${err?.message || err}`,
    );
    return { written: false, reason: 'audit-write-failed' };
  }
}

/**
 * Resolve the AMA cfg subtree, build (reviewState, prMetadata)
 * snapshots from the watcher's existing row + candidate data, and
 * call `maybeDispatchAmaCloser`. Returns the dispatch result; the
 * caller checks `.dispatched` and skips merge-agent on `true`.
 *
 * Cheap path: when `cfg.enabled === false` (the default), this
 * function short-circuits in `maybeDispatchAmaCloser` before doing
 * any I/O or fetches. The watcher's hot path pays only the cost of
 * `loadConfigCached().getMergeAuthorityConfig()`, which is cached
 * across ticks.
 *
 * Snapshot mapping is best-effort against the watcher's existing
 * shapes. Fields the watcher doesn't already have (e.g. branch
 * protection's resolved required contexts) are left empty, and the
 * eligibility predicate fails-closed on them — meaning AMA dispatch
 * won't fire in the watcher path until the operator wires those
 * fetches in. That's intentional: AMA-03 lands the dispatch *path*;
 * AMA-06A/06N wire in the full snapshot in the cutover ticket.
 */

export function maybeDispatchAmaClosureFor(args = {}) {
  return withDaemonMergeReservation({ rootDir: args.rootDir || ROOT,
    repo: args.repoPath, base: args.candidate?.baseBranch, pr: args.prNumber,
    head: args.candidate?.headSha || args.currentRevisionRef,
  }, () => maybeDispatchAmaClosureForInner(args));
}

async function maybeDispatchAmaClosureForInner({
  // The rescue dispatch-only contract (agent-os merge-agent rescue) names these.
  orphanRecovery,
  runDaemonCleanMergeAttemptImpl,
  maybeDispatchAmaCloserImpl,
  ...options
} = {}) {
  const stopReason = fleetStopReason({ env: options.env || process.env });
  if (stopReason) return withAmaDispatchMetadata({ dispatched: false,
    skipMergeAgent: true, recoveryWait: true, reason: stopReason }, { amaEnabled: true });
  // STALECLOSER-03: every result for a stale head carries the shared
  // closer-authored-stale decision, so the orphan watchdog and rescue read the
  // closer's own answer.
  const closerAuthoredStaleSink = {};
  const ownerProofFactsSink = {};
  const closureOwnerSink = {};
  const finalRoundSink = {};
  const hammerWakeSink = {};
  const dispatchArgs = { ...options, orphanRecovery, runDaemonCleanMergeAttemptImpl,
    maybeDispatchAmaCloserImpl: (...args) => {
      hammerWakeSink.closerInvoked = true;
      return (maybeDispatchAmaCloserImpl || maybeDispatchAmaCloser)(...args);
    }, closerAuthoredStaleSink, ownerProofFactsSink, closureOwnerSink, finalRoundSink, hammerWakeSink };
  let result = await dispatchAmaClosureFor(dispatchArgs);
  const observeMismatch = result => observeClosureDecisionMismatch({ rootDir: options.rootDir || ROOT,
    repo: options.repoPath, prNumber: options.prNumber, result,
    now: options.now ? options.now() : Date.now(), env: options.env || process.env,
    observeWaitImpl: options.observeClosureWaitImpl || observeClosureWait });
  result = await observeMismatch(result);
  if (result?.reason === 'closure-decision-mismatch' && result.nextActionShared) {
    const mismatch = result.decisionMismatch;
    // Exactly one successor selection uses the executor's complete snapshot,
    // including primaryChange. Do not rebuild it from the older candidate.
    const resolved = await resolveSharedNextAction({ snapshot: result.nextActionShared.snapshot, rootDir: options.rootDir || ROOT });
    if (resolved.decision.action === 'daemon-merge' || hasHammerDispatchIntent(resolved,
      { repo: options.repoPath, prNumber: options.prNumber, headSha: resolved.decision.head })) {
      result = await dispatchAmaClosureFor({ ...dispatchArgs, resolvedNextAction: resolved,
        passSnapshot: resolved.snapshot, priorDaemonCleanMerge: null });
    } else {
      result = { ...result, reason: resolved.decision.reason, nextAction: resolved.decision, nextActionShared: resolved,
        retryAfterMs: 30_000 };
    }
    result = await observeMismatch(result);
    result = { ...result, mismatchReason: 'closure-decision-mismatch',
      decisionMismatch: mismatch, decisionReresolutions: 1 };
  }
  if (hammerWakeSink.value && hammerWakeSink.closerInvoked) {
    try { amaDispatchCloser.settleRefusedHammerWake({ ...hammerWakeSink.value, result }); }
    catch (error) { options.logger?.warn?.(`[watcher] refused hammer wake reconciliation failed: ${error.message}`); }
  }
  if (result && closureOwnerSink.shared) {
    const executorShared = readClosureNextAction(result);
    const { nextActionShared, ...publicResult } = result;
    result = publicResult;
    closureOwnerSink.shared = observeClosureResult(nextActionShared || executorShared || closureOwnerSink.shared,
      (isSafetyRecoveryHold({ ...result, needsOperator: false })
        || (result.needsOperator && !result.primaryChangeRepair && !result.boundedWait?.exhausted
          && !(result.operatorLabelGates?.length && closureOwnerSink.shared.decision.action === 'operator-hold'
            && result.reason === closureOwnerSink.shared.decision.reason)))
        ? { ...result, safetyRefusal: true } : result, options.passSnapshot);
    const selected = closureOwnerSink.shared.decision;
    result = { ...result, nextAction: selected, closureOwner: closureOwnerFromDecision(selected),
      ...(selected.action === 'review' ? { selectedClosureOwner: {
        ...closureOwnerFromDecision(selected), reason: 'exact-head-review',
      } } : {}) };
  }
  try {
    result = await observeClosureRefreshLoop({ rootDir: options.rootDir || ROOT,
      repo: options.repoPath, prNumber: options.prNumber, shared: closureOwnerSink.shared, result,
      now: options.now ? options.now() : Date.now(), env: options.env || process.env,
      observeWaitImpl: options.observeClosureWaitImpl || observeClosureWait });
  } catch (error) { options.logger?.warn?.(`[watcher] snapshot-refresh loop observation failed: ${error.message}`); }
  const finalRoundObservable = finalRoundSink.value
    && result?.reason !== 'hammer-stop-awaiting-companion'
    && !(result?.boundedWait && ['review', 'remediate', 'wait-for-CI'].includes(result.nextAction?.action))
    && !result?.daemonCleanMerge?.reason?.startsWith('fleet-stop-')
    && !(options.labelNames || []).some(label => OPERATOR_HOLD_LABELS.includes(label));
  const observeFinalRound = async (anchorOnly) => {
    try {
      const observationTime = options.now ? options.now() : Date.now();
      if (result?.closerLaunchBoundMs) result = { ...result, ...amaHammerBackgroundProgress({
        state: 'running', startedAtMs: Date.parse(result.closerProgressAt), boundMs: result.closerLaunchBoundMs,
      }, observationTime) };
      const launchAt = Date.parse(result?.closerProgressAt || '');
      const boundedWait = await (options.observeClosureWaitImpl || observeClosureWait)({ ...finalRoundSink.value,
        ...closureWaitProgress(result, finalRoundSink.value.startedAt),
        anchorOnly,
        launchAlive: result?.closerLaunchAlive === true || Boolean(result?.closerLaunchBoundMs),
        reason: result?.nextAction
          ? `action=${result.nextAction.action} actor=${result.nextAction.actor} reason=${result.nextAction.reason} head=${result.nextAction.head} ageMs=${Math.max(0, observationTime - Date.parse(result.nextAction.deadline?.anchoredAt || observationTime))}; ${result?.reasons?.join(', ') || result?.reason || 'closure-pending'}`
          : result?.reasons?.join(', ') || result?.reason || 'closure-pending',
        progress: result?.dispatched === true && !Number.isFinite(launchAt), now: observationTime,
        env: options.env || process.env, waitClass: 'final-round',
        ...(result?.hammerStop?.paged ? { immediate: true, pageImpl: async () => {} } : {}) });
      if (result?.closerLaunchBoundMs) result = { ...result, boundedWait, recoveryWait: true,
        ...(boundedWait.exhausted ? { needsOperator: true } : {}) };
    } catch (error) { options.logger?.warn?.(`[watcher] final-round wait observation failed: ${error.message}`); }
  };
  if (finalRoundObservable && (!isClosureRecoveryDecision(result?.nextAction)
    || result?.closerLaunchAlive === true || result?.closerLaunchBoundMs)) {
    await observeFinalRound(false);
  } else if (finalRoundObservable) {
    // Ownerless recovery keeps its clock; the watchdog owns escalation.
    await observeFinalRound(true);
  }
  // NXA-02 observational shadow of this pass's final legacy owner; no effect.
  if (result?.closureOwner && closureOwnerSink.shadowInput) {
    const { input, autonomousMergeExecutionEnabled } = closureOwnerSink.shadowInput;
    const candidate = options.candidate || {};
    void shadowNextActionLater({ source: 'closure-orchestration', legacy: result.closureOwner,
      passSnapshot: options.passSnapshot || null, repo: options.repoPath, prNumber: options.prNumber,
      rootDir: options.rootDir || ROOT, shared: closureOwnerSink.shared || null,
      evidence: () => closureOwnerShadowEvidence(input, {
        subjectKey: `${options.repoPath}#${options.prNumber}`, autonomousMergeExecutionEnabled,
        rootDir: options.rootDir || ROOT, observedAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
        checksRollup: candidate.statusCheckRollup, candidate, labels: options.labelNames }) });
  }
  if (result && ownerProofFactsSink.value) result = { ...result, ownerProofFacts: ownerProofFactsSink.value };
  try {
    recordOperatorNoticeCloserOutcome(options.rootDir || ROOT, {
      repo: options.repoPath, prNumber: options.prNumber,
      headSha: options.candidate?.headSha || options.currentRevisionRef || null,
    }, result);
  } catch (error) {
    options.logger?.warn?.(`[watcher] operator notice closer observation failed: ${error.message}`);
  }
  const decision = closerAuthoredStaleSink.value?.decision;
  const final = decision && decision !== 'not-applicable' && result && typeof result === 'object'
    && !result.closerAuthoredStale
    ? { ...result, closerAuthoredStale: closerAuthoredStaleSink.value }
    : result;
  return bindClosureNextAction(final, closureOwnerSink.shared);
}

function closureWaitProgress(result, startedAt) {
  const launchAt = Date.parse(result?.closerProgressAt || '');
  if (!Number.isFinite(launchAt)) return {};
  if (result.closerLaunchBoundMs) return { launchWait: { startedAt: launchAt, boundMs: result.closerLaunchBoundMs } };
  return { startedAt: Math.max(launchAt, Number.isFinite(startedAt) ? startedAt : launchAt) };
}

async function dispatchAmaClosureFor({
  hammerWakeSink = null,
  resolvedNextAction = null,
  passSnapshot = null,
  finalRoundSink = null,
  closerAuthoredStaleSink = null,
  ownerProofFactsSink = null,
  automatedRecovery = false,
  orphanRecovery = null,
  priorDaemonCleanMerge = null,
  rootDir = ROOT,
  reviewStateRow,
  reviewStateDb = null,
  dispatchJob,
  candidate,
  labelNames,
  operatorApprovalEvent,
  mergeAgentRequestEvent,
  adversarialMergeRequestedEvent,
  repoPath,
  prNumber,
  currentRevisionRef,
  domainId = 'code-pr',
  logger,
  loadConfigImpl = loadConfigCached,
  maybeDispatchAmaCloserImpl = maybeDispatchAmaCloser,
  resolveAmaHammerDispatchModeImpl = resolveAmaHammerDispatchMode,
  amaHammerBackgroundQueueImpl = amaHammerBackgroundQueue,
  fetchCurrentPrStateImpl = fetchCurrentPrStateForBackgroundDispatch,
  fetchLatestHeadReviewBodiesImpl = (repo, pr, head, options = {}) =>
    fetchReviewBodiesForHead(execFileAsync, repo, pr, head, options),
  liveReviewRetryDelaysMs = AMA_LIVE_REVIEW_LOOKUP_RETRY_DELAYS_MS,
  resolveReviewCycleExhaustionImpl = null,
  runDaemonCleanMergeAttemptImpl = runDaemonCleanMergeAttempt,
  fetchPrimaryChangeImpl = fetchPrimaryChange,
  headHasValidatedHamTerminalRemediationImpl = headHasValidatedHamTerminalRemediation,
  resolveHeadCloserCommitSuppressionImpl = null,
  fetchHeadCloserVerifiedCommitImpl = fetchHeadCloserVerifiedCommit,
  resolveHamTerminalRemediationEvidenceImpl =
    amaDispatchCloser.resolveHamTerminalRemediationEvidence || null,
  dismissSupersededBlockingVerdictAtRemediatedHeadImpl =
    dismissSupersededBlockingVerdictAtRemediatedHead,
  writeAutonomousMergeDisabledAuditImpl = writeAutonomousMergeDisabledAudit,
  requestEligibleHammerWakeImpl = requestEligibleHammerWake,
  fetchMergedProtectiveDependentsImpl = fetchMergedProtectiveDependentsForPr,
  fetchProtectivePredecessorStateImpl = fetchProtectivePredecessorStateForPr,
  emitProtectivePredecessorFindingImpl = null,
  proveCloserAuthoredStaleHeadImpl = proveCloserAuthoredStaleHead,
  // STALECLOSER-03: return the shared closer-authored-stale decision before any
  // side effect (lease rekey, audits, wakes, dispatch). merge-agent rescue reads it.
  probeCloserAuthoredStale = false,
  closureOwnerSink = null,
  probeClosureOwnershipImpl = probeOrphanOwnership,
  closerLeaseLivenessOptions = {},
  preReceiptIntentOptions = {},
  observeClosureWaitImpl = observeClosureWait,
  readHammerStopForHeadImpl = readHammerStopForHead,
  evaluateHammerStopHoldImpl = evaluateHammerStopHold,
  deliverAlertImpl = deliverAlert,
  recoverInfrastructureChecksImpl = recoverInfrastructureChecks,
  fetchPullRequestMergeabilityImpl = fetchPullRequestMergeability,
  mergeabilitySampleDelayMs = MERGEABILITY_SAMPLE_DELAY_MS,
  now = () => Date.now(),
  env = process.env,
  signal = null,
  operationTimeoutMs = null,
  operationTracker = null,
}) {
  const snapshotObservedAt = Date.parse(passSnapshot?.observedAt || '');
  const closureLagObservedAt = Number.isFinite(snapshotObservedAt) ? snapshotObservedAt : now();
  throwIfAborted(signal);
  let proofScope;
  // Ordinary current-head evaluations must not evict useful proofs by filling
  // the bounded cache with scopes that never perform a proof read.
  const getProofScope = () => proofScope ||= headProofScope(proveCloserAuthoredStaleHeadImpl, {
    rootDir, repoPath, prNumber, reviewStateRow, candidate, currentRevisionRef, dispatchJob,
  });
  const runCoexistenceOperation = (operation, fn, options) =>
    AMA_REUSABLE_PROOF_OPERATIONS.has(operation)
      ? runAmaProofOperation(getProofScope(), operation, fn, options)
      : runTimedCoexistenceOperation(operation, fn, options);
  let cfg;
  let loadedConfig;
  let orchestrationMode;
  try {
    // Load the adversarial config.yaml as a module so merge-authority values
    // (notably lha.consume_attestations, which gates autonomous merge) come from
    // the reviewed file, not the shell env export that mis-resolves nested keys.
    loadedConfig = loadConfigImpl({ modulePaths: WATCHER_MERGE_AUTHORITY_CONFIG_MODULES });
    cfg = resolveMergeAuthorityConfigFromDomain(
      loadDomainConfig(rootDir, domainId || 'code-pr'),
      loadedConfig.getMergeAuthorityConfig(),
      { fallbackSources: loadedConfig.sources || {} },
    );
    cfg = {
      ...cfg,
      amaCloserMaxConcurrentLaunches: loadedConfig.get?.('watcher.ama_closer_max_concurrent_launches', 3) ?? 3,
    };
    orchestrationMode = resolveOrchestrationMode({
      loadedConfig,
      logger,
      context: 'AMA closure dispatch',
    });
  } catch (err) {
    // CFG load failure isn't an AMA problem; let the existing
    // merge-agent path handle the tick.
    logger?.warn?.(`[watcher] AMA cfg load failed: ${err?.message || err}`);
    return withAmaDispatchMetadata(
      { dispatched: false, reason: 'cfg-load-failed' },
      { amaEnabled: false },
    );
  }

  if (!cfg?.enabled) {
    amaDispatchCloser.retireAmaCloserDrainHint(rootDir, {
      repo: repoPath, prNumber, headSha: candidate?.headSha || currentRevisionRef || reviewStateRow?.revision_ref,
    }, { logger });
    // AMA-06N — surface `amaEnabled` so the watcher's coexistence
    // decision (the call site of this helper) can branch on it. With
    // AMA off, the default `merge-agent-default` action falls through
    // to the existing merge-agent dispatch without any override env.
    return withAmaDispatchMetadata(
      { dispatched: false, reason: 'ama-disabled' },
      { amaEnabled: false },
    );
  }

  if (candidate?.stackedBaseHold) return withAmaDispatchMetadata(candidate.stackedBaseHold, { amaEnabled: true });

  throwIfAborted(signal);
  if (candidate?.headSha && String(candidate.prState).toLowerCase() === 'open') {
    const summary = summarizeExternalChecks(candidate.statusCheckRollup, { env, cfg: loadedConfig });
    if (cfg.autonomousMergeExecutionEnabled !== false && infrastructureOnlyFailures(summary.failedChecks)) {
      try {
        await recoverInfrastructureChecksImpl({ rootDir, repo: repoPath, prNumber, headSha: candidate.headSha,
          failedChecks: summary.failedChecks, pendingChecks: summary.pendingChecks, env, signal, execFileImpl: execFileAsync });
      } catch (error) { logger?.warn?.(`[watcher] Infrastructure CI recovery unavailable: ${error.message}`); }
    }
    await recoverInfrastructureCiStops({ rootDir, repo: repoPath, prNumber, headSha: candidate.headSha,
      ciGate: { ...summary, rollup: candidate.statusCheckRollup, headSha: candidate.headSha,
        state: summary.conclusion === 'SUCCESS' ? 'green' : 'pending' }, now: new Date(now()).toISOString(), execFileImpl: execFileAsync });
  }
  // AMA "final hammer" signal: the review cycle is EXHAUSTED once the PR has
  // consumed its full remediation round budget. At that point the adversarial
  // verdict can loop on `Request changes` forever, so AMA must land the PR
  // (eligibility.mjs waives the soft convergence gates, keeps the hard ones).
  // Mirrors evaluateRoundBudgetForReview's budget resolution. Fail-safe: any
  // error leaves the signal false (AMA keeps its normal strict gates).
  let reviewCycleExhausted = false;
  let finalRoundCompletedAt = null;
  let completedRemediationRoundsForPR = null;
  let completedRereviewRoundsForPR = null;
  let completedRemediationRevisionRefsForPR = [];
  let commentOnlyFinalRoundRevisionRefs = [];
  let commentOnlyFinalRoundPushedHeads = [];
  // Resolve the PR's risk class from the remediation ledger (which defaults to
  // DEFAULT_RISK_CLASS) so AMA eligibility uses the SAME risk class the
  // round-budget path below already computes. Without this, the eligibility
  // riskClass fell back to 'unknown' for EVERY PR — fetchMergeAgentCandidate
  // does not populate candidate.riskClass and reviewed_prs has no risk_class
  // column — and 'unknown' is always-two-key, so AMA could never auto-close any
  // PR (closed 0 ever). Hoisted out of the try so it survives a round-budget
  // probe failure.
  let ledgerRiskClass = null;
  try {
    if (typeof resolveReviewCycleExhaustionImpl === 'function') {
      const resolved = resolveReviewCycleExhaustionImpl({
        rootDir,
        repoPath,
        prNumber,
      }) || {};
      reviewCycleExhausted = resolved.reviewCycleExhausted === true;
      ledgerRiskClass = resolved.ledgerRiskClass || resolved.riskClass || null;
      completedRemediationRevisionRefsForPR = Array.isArray(resolved.completedRemediationRevisionRefs)
        ? resolved.completedRemediationRevisionRefs
        : [];
      commentOnlyFinalRoundRevisionRefs = Array.isArray(resolved.commentOnlyFinalRoundRevisionRefs)
        ? resolved.commentOnlyFinalRoundRevisionRefs
        : [];
      commentOnlyFinalRoundPushedHeads = Array.isArray(resolved.commentOnlyFinalRoundPushedHeads)
        ? resolved.commentOnlyFinalRoundPushedHeads
        : [];
    } else {
      const remLedger = summarizePRRemediationLedger(rootDir, { repo: repoPath, prNumber });
      ledgerRiskClass = remLedger?.latestRiskClass || null;
      finalRoundCompletedAt = (remLedger.completedRoundTimestamps || [])
        .map(entry => Date.parse(entry.terminalAt)).filter(Number.isFinite).sort((a, b) => b - a)[0] || null;
      const rbResolution = resolveRoundBudgetForJob(
        { riskClass: remLedger.latestRiskClass },
        { rootDir },
      );
      const latestMaxRounds = Number(remLedger.latestMaxRounds);
      const effectiveRoundBudget =
        Number.isInteger(latestMaxRounds) && latestMaxRounds > rbResolution.roundBudget
          ? latestMaxRounds
          : rbResolution.roundBudget;
      // Re-review rounds count toward the shared "cycle exhausted" signal so
      // comment-only clean PRs do not park after reviewers hit budget. The
      // closer also receives the raw remediation/rereview counters below so its
      // terminal Hammer arming gate can require evidence that Codex/remediator
      // had a turn.
      completedRemediationRoundsForPR = normalizeCompletedRoundCount(
        remLedger.completedRoundsForPR,
      );
      completedRemediationRevisionRefsForPR = Array.isArray(remLedger.completedRemediationRevisionRefs)
        ? remLedger.completedRemediationRevisionRefs
        : [];
      commentOnlyFinalRoundRevisionRefs = Array.isArray(remLedger.commentOnlyFinalRoundRevisionRefs)
        ? remLedger.commentOnlyFinalRoundRevisionRefs
        : [];
      commentOnlyFinalRoundPushedHeads = Array.isArray(remLedger.commentOnlyFinalRoundPushedHeads)
        ? remLedger.commentOnlyFinalRoundPushedHeads
        : [];
      completedRereviewRoundsForPR = 0;
      try {
        completedRereviewRoundsForPR = normalizeCompletedRoundCount(
          countCompletedReviewerRereviewRounds({ db: reviewStateDb, rootDir, repoPath, prNumber }),
        );
      } catch (rereviewErr) {
        console.warn(
          `[watcher] AMA final-hammer re-review-round probe failed for ${repoPath}#${prNumber}; ` +
            `falling back to remediation-round exhaustion only: ${rereviewErr?.message || rereviewErr}`,
        );
      }
      reviewCycleExhausted = reviewCycleExhaustedFromRounds({
        effectiveRoundBudget,
        completedRemediationRounds: completedRemediationRoundsForPR,
        completedRereviewRounds: completedRereviewRoundsForPR,
      });
    }
  } catch (err) {
    console.warn(
      `[watcher] AMA final-hammer round-budget probe failed for ${repoPath}#${prNumber}; ` +
        `treating cycle as NOT exhausted: ${err?.message || err}`,
    );
  }
  if ((dispatchJob?.remediationStopCode || dispatchJob?.remediationPlan?.stop?.code) === 'max-rounds-reached') {
    reviewCycleExhausted = true;
  }
  // CYCLECAPHAM-01: the watcher's review-cycle-cap hand-off. The cap stops
  // review-then-remediate cycles, so the capped PR is a final-hammer close.
  const remediationHandoff = findFinalRemediationPushJob(rootDir, {
    repo: repoPath, prNumber, headSha: candidate?.headSha || currentRevisionRef });
  const reviewCycleCapReached = Boolean(remediationHandoff) || dispatchJob?.reviewCycleCapReached === true
    || reviewStateRow?.rereview_reason === 'system-review-ceiling-closure';
  // CIBLOCKHAM-01: the same final-hammer close for a red-CI head with no
  // remediation job left to fix it.
  // Historical stop evidence is not enough: rescue must observe failed external
  // checks on the current candidate head, and carry their names into the prompt.
  const requiredCiContexts = new Set(resolveRequiredCheckContextsFromCfg(cfg)
    .map(context => String(context).trim().toLowerCase()).filter(Boolean));
  const finalRoundKnown = commentOnlyFinalRoundRevisionRefs.length > 0;
  const derivedCiFailedChecks = (reviewCycleExhausted || finalRoundKnown) && candidate?.headSha
    && reviewStateRow?.review_status === 'ci-blocked'
    && CI_BLOCKED_HAMMER_RESCUE_PREFIXES.some(prefix => String(reviewStateRow?.failure_message || '').startsWith(prefix))
    ? summarizeExternalChecks(candidate.statusCheckRollup, { env, cfg: loadedConfig }).failedChecks
      .filter(check => requiredCiContexts.size === 0 || requiredCiContexts.has(String(check?.name || '').toLowerCase())) : [];
  const ciBlockedHammerOwner = dispatchJob?.ciBlockedHammerOwner === true
    || derivedCiFailedChecks.length > 0;
  if (reviewCycleCapReached || ciBlockedHammerOwner) reviewCycleExhausted = true;

  const finalHead = candidate?.headSha || currentRevisionRef || null;
  const finalPush = commentOnlyFinalRoundPushedHeads.find(entry => entry.workerPushedHeadSha === finalHead);
  // Final-round ownership survives a later hammer push. This is dispatch
  // admission only; neither the historical verdict nor the new head is merge authority.
  if ((reviewCycleExhausted || finalPush || finalRoundKnown) && cfg.autonomousMergeExecutionEnabled !== false && finalRoundSink) {
    finalRoundSink.value = { rootDir, repo: repoPath, prNumber, headSha: finalHead,
      startedAt: Date.parse(finalPush?.completedAt || '') || finalRoundCompletedAt
        || Date.parse(reviewStateRow?.posted_at || '') };
  }
  const observeWait = args => observeClosureWaitImpl({
    ...(finalRoundSink?.value && args.immediate !== true
      ? { waitClass: 'final-round', startedAt: finalRoundSink.value.startedAt } : {}),
    ...args,
  });
  const settledReviewHeadSha = candidate?.headSha || currentRevisionRef || null;
  // GitHub returns mergeable=UNKNOWN transiently right after a push or when the
  // base branch moves (a steady merge stream keeps `main` moving). The
  // eligibility predicate maps an unresolved UNKNOWN to the transient
  // `pr-mergeability-unknown` and every other non-MERGEABLE state to
  // `pr-not-mergeable`, so resolving it here decides this tick's route. Only
  // re-sample the actually-unresolved states; BLOCKED/BEHIND/false are already
  // classified enough for this tick and sleeping on them just consumes the
  // posted-review handler budget. Classify as the closure gate does, so a raw
  // UNKNOWN beside a stale `CLEAN` is re-sampled rather than read once.
  let mergeabilityForGate = candidate;
  const initialMergeability = closureGateMergeability(candidate || {});
  if (!initialMergeability || initialMergeability === 'UNKNOWN') {
    throwIfAborted(signal);
    const sampled = await runCoexistenceOperation(
      'mergeability-sampling',
      async ({ signal: operationSignal }) => resolveMergeabilityWithSampling(
        candidate || {},
        async () => {
          throwIfAborted(operationSignal);
          return fetchPullRequestMergeabilityImpl(repoPath, prNumber, {
            execFileImpl: execFileAsync,
            signal: operationSignal,
          });
        },
        {
          attempts: MERGEABILITY_SAMPLE_ATTEMPTS,
          delayMs: mergeabilitySampleDelayMs,
          sleepImpl: (ms) => abortableSleep(ms, operationSignal),
          classify: closureGateMergeability,
        },
      ),
      {
        timeoutMs: operationTimeoutMs,
        parentSignal: signal,
        operationTracker,
        logger,
        repoPath,
        prNumber,
      },
    );
    throwIfAborted(signal);
    mergeabilityForGate = {
      ...(candidate || {}),
      mergeable: sampled.mergeable,
      mergeStateStatus: sampled.mergeStateStatus,
    };
    if (!sampled.resolved) {
      console.warn(
        `[watcher] mergeability still UNKNOWN for ${repoPath}#${prNumber} after ` +
          `${sampled.samples} sample(s); treating as not-yet-mergeable this tick`,
      );
    }
  }
  throwIfAborted(signal);
  // HAMCIWAKE-01: resolve review evidence at its original identity only when
  // every intervening commit is the closer's own. All PR/CI inputs stay live.
  const originalReviewedHead = reviewStateRow?.reviewer_head_sha;
  // Share immutable commit evidence across the ancestry walk, stale-head
  // resume and later passes for this reviewed/current head pair.
  const cachedSuppression = options => getProofScope().read(`suppression:${options.headSha}`,
    proofSignal => (resolveHeadCloserCommitSuppressionImpl || getHeadCloserCommitSuppression)({ ...options, signal: proofSignal }));
  const cachedCommit = options => getProofScope().read(`commit:${options.headSha}:${Boolean(options.includePrimaryChange)}`,
    proofSignal => fetchHeadCloserVerifiedCommitImpl({ ...options, signal: proofSignal }));
  // Warm independent reads together. A serial timeout must not prevent the
  // other immutable proofs from making progress before the next watcher pass.
  // Speculation belongs only to the CI-blocked hammer route; ordinary review
  // and final-round CI handoffs must not start reads they would never reach.
  if (ciBlockedHammerOwner && originalReviewedHead && settledReviewHeadSha
    && originalReviewedHead !== settledReviewHeadSha
    && !(isOrphanHeadReviewRequested(reviewStateRow, settledReviewHeadSha)
      && ['pending', 'reviewing'].includes(reviewStateRow?.review_status))) {
    cachedSuppression({ repoPath, prNumber, headSha: settledReviewHeadSha, logger })
      .then(suppression => {
        // A certificate read depends on recognized closer provenance. Warm it
        // after that proof, without performing unrelated reads on foreign heads.
        if (suppression?.suppressed !== true
          || !['closer-commit-trailer', 'hammer-validated-head'].includes(suppression.reason)
          || (suppression.reason !== 'hammer-validated-head'
            && amaAuthoritativeReviewerLoginsForModel(reviewStateRow?.reviewer).length === 0)
          || typeof resolveHamTerminalRemediationEvidenceImpl !== 'function') return;
        return getProofScope().read(`ham-terminal-remediation-evidence:${originalReviewedHead}`, proofSignal =>
          resolveHamTerminalRemediationEvidenceImpl({
            reviewState: { headSha: originalReviewedHead },
            prMetadata: { headSha: settledReviewHeadSha },
            repoPath, prNumber, execFileImpl: execFileAsync, rootDir, logger,
            closerCommitSuppression: suppression,
            fetchHeadCloserVerifiedCommitImpl: cachedCommit, signal: proofSignal,
          }));
      }).catch(() => {});
  }
  // HAMROUNDEDGE-01: the shared proof bridges daemon-owned completed rounds
  // into authenticated hammer edges; plain worker anchor heads confer nothing.
  let closerHeadProof = { proven: false, reason: 'not-stale' };
  if (originalReviewedHead && settledReviewHeadSha && originalReviewedHead !== settledReviewHeadSha) {
    try {
      closerHeadProof = await runCoexistenceOperation(
        'closer-only-review-delta',
        ({ signal: operationSignal }) => proveCloserAuthoredStaleHeadImpl({
          reviewedHead: originalReviewedHead, currentHead: settledReviewHeadSha,
          rootDir, repoPath, prNumber, env, logger, signal: operationSignal,
          suppressionImpl: cachedSuppression,
          fetchCommitImpl: cachedCommit,
        }),
        { timeoutMs: operationTimeoutMs, parentSignal: signal, operationTracker, logger, repoPath, prNumber },
      );
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code === 'AMA_COEXISTENCE_OPERATION_TIMEOUT') throw error;
      logger?.warn?.(`Closer-only review delta proof failed: ${error.message || error}`);
      closerHeadProof = { proven: false, reviewedHead: originalReviewedHead, currentHead: settledReviewHeadSha,
        closerCommits: [], reason: 'closer-proof-failed' };
    }
  }
  let closerOnlyHeadDelta = closerHeadProof?.proven === true;
  let closerHeadHasLiveReview = false;
  // CEILINGPUSH-01: preserve the last review's findings as terminal-remediation
  // input for a moved head. This grants no closer-only carry-forward proof:
  // candidate/validated heads still differ and every merge gate stays intact.
  const ceilingMovedHead = (Boolean(remediationHandoff) || reviewStateRow?.rereview_reason === 'system-review-ceiling-closure')
    && originalReviewedHead && settledReviewHeadSha && originalReviewedHead !== settledReviewHeadSha;
  let evidenceHeadSha = closerOnlyHeadDelta ? closerHeadProof.anchorHead
    : ceilingMovedHead ? originalReviewedHead : settledReviewHeadSha;
  let gateSnapshot = await buildAdversarialGateSnapshot(rootDir, {
    repo: repoPath,
    prNumber,
    reviewRow: reviewStateRow,
    headSha: evidenceHeadSha,
    mergeability: mergeabilityForGate,
    labels: labelNames,
    prUpdatedAt: candidate?.prUpdatedAt || dispatchJob?.prUpdatedAt || null,
    prAuthor: candidate?.prAuthor || null,
    operatorApprovalEvent,
    includeSettledReview: true,
    commentOnlyFinalRoundPushes: commentOnlyFinalRoundPushedHeads,
  });
  // FAIL-OPEN GUARD (#1824 / #1816): the stored follow-up-job / review-row body
  // resolved above can be STALE relative to a fresh review on the SAME head — a
  // completed remediation job's comment-only body is not updated when a later
  // adversarial pass posts `Request changes`, so the closer fail-open merged
  // PRs whose live verdict was `Request changes`. ONLY when the stored body
  // already reads settled-success (the sole case a stale body could cause a
  // fail-open merge) do we reconcile against the LIVE latest review on the head;
  // this bounds the extra GitHub call to apparently-mergeable PRs. A fresh
  // `Request changes` then wins, and a lookup failure fails closed.
  const authoritativeReviewerLogins = amaAuthoritativeReviewerLoginsForModel(reviewStateRow?.reviewer);
  // COMMENTCLOSE-01: a verdict resolved through a recorded final-round push came
  // from the REVIEWED head, so its live reconcile reads that head's reviews.
  let liveReviewHeadSha = closerOnlyHeadDelta || ceilingMovedHead || gateSnapshot.settledReview?.commentOnlyFinalRoundPush === true
    ? gateSnapshot.reviewedHeadSha
    : settledReviewHeadSha;
  if (
    settledReviewHeadSha &&
    gateSnapshot.settledReview?.remediationPending === false &&
    SETTLED_SUCCESS_VERDICTS.has(gateSnapshot.settledReview?.verdict)
  ) {
    let liveHeadReview;
    // Resolve the authoritative reviewer login(s) from the REAL `reviewer` model
    // field (e.g. 'codex'/'claude'), NOT a `reviewer_login` column — that column
    // does NOT exist on reviewed_prs, so the prior `reviewStateRow?.reviewer_login`
    // was ALWAYS empty and the reconcile fail-CLOSED on every legit settled-success
    // PR (#1834 stuck despite `Comment only`). We accept BOTH observed reviewer-bot
    // login forms (the live `lacey-<model>-reviewer` account AND the legacy
    // `<model>-reviewer-lacey` config form) so the anti-spoof filter is robust to
    // the known naming discrepancy without mutating the globally-used
    // REVIEWER_BOT_LOGINS map (which review-body-capture / closeout-scraper rely on).
    try {
      // A review on the live closer head supersedes historical evidence. Never
      // substitute H0 over a fresh blocking review on H1 (or a failed lookup).
      if (closerOnlyHeadDelta || ceilingMovedHead) {
        const currentBodies = await runCoexistenceOperation(
          'closer-head-live-review',
          ({ signal: operationSignal }) => fetchLatestHeadReviewBodiesWithRetry({
            repoPath, prNumber, headSha: settledReviewHeadSha,
            authoritativeReviewerLogins, fetchLatestHeadReviewBodiesImpl,
            retryDelaysMs: liveReviewRetryDelaysMs, logger, signal: operationSignal,
          }),
          { timeoutMs: operationTimeoutMs, parentSignal: signal, operationTracker, logger, repoPath, prNumber },
        );
        if (currentBodies.length > 0) {
          closerHeadHasLiveReview = true;
          closerOnlyHeadDelta = false;
          evidenceHeadSha = settledReviewHeadSha;
          liveReviewHeadSha = settledReviewHeadSha;
        }
      }
      const bodies = authoritativeReviewerLogins.length
        ? await runCoexistenceOperation(
            'live-review-reconcile',
            ({ signal: operationSignal }) => fetchLatestHeadReviewBodiesWithRetry({
              repoPath,
              prNumber,
              headSha: liveReviewHeadSha,
              authoritativeReviewerLogins,
              fetchLatestHeadReviewBodiesImpl,
              retryDelaysMs: liveReviewRetryDelaysMs,
              logger,
              signal: operationSignal,
            }),
            {
              timeoutMs: operationTimeoutMs,
              parentSignal: signal,
              operationTracker,
              logger,
              repoPath,
              prNumber,
            },
          )
        : [];
      throwIfAborted(signal);
      if (!authoritativeReviewerLogins.length) {
        logger?.warn?.(
          `[watcher] AMA live-review reconcile could not resolve an authoritative reviewer ` +
            `login from reviewer='${reviewStateRow?.reviewer ?? ''}' for ` +
            `${repoPath}#${prNumber}@${liveReviewHeadSha}; failing closed`,
        );
      }
      liveHeadReview = { resolved: true, bodies: Array.isArray(bodies) ? bodies : [] };
    } catch (err) {
      throwIfAborted(signal);
      if (err?.code === 'AMA_COEXISTENCE_OPERATION_TIMEOUT') {
        throw err;
      }
      logger?.warn?.(
        `[watcher] AMA live-review reconcile failed for ${repoPath}#${prNumber}@${liveReviewHeadSha}; ` +
          `failing closed: ${err?.message || err}`,
      );
      liveHeadReview = { resolved: false };
    }
    gateSnapshot = await buildAdversarialGateSnapshot(rootDir, {
      repo: repoPath,
      prNumber,
      reviewRow: reviewStateRow,
      headSha: evidenceHeadSha,
      mergeability: mergeabilityForGate,
      labels: labelNames,
      prUpdatedAt: candidate?.prUpdatedAt || dispatchJob?.prUpdatedAt || null,
      prAuthor: candidate?.prAuthor || null,
      operatorApprovalEvent,
      includeSettledReview: true,
      liveHeadReview,
      commentOnlyFinalRoundPushes: commentOnlyFinalRoundPushedHeads,
    });
  }
  throwIfAborted(signal);
  const currentPrHeadSha = candidate?.headSha || currentRevisionRef || null;

  let hammerResume = reconcileHammerResumes({ hqRoot: resolveHqRoot(env), repo: repoPath, prNumber,
    headSha: currentPrHeadSha, prState: candidate?.prState, readOnly: probeCloserAuthoredStale,
    checks: classifyCheckRollup(candidate?.statusCheckRollup, {
      requiredContexts: [...resolveRequiredCheckContextsFromCfg(cfg), ...(candidate?.branchProtection?.requiredContexts || [])],
    }), now: new Date(now()).toISOString() });

  // Resolve dispatch ownership independently of the stronger carry-forward
  // proof. Rescue's read-only probe and the watcher consume this same fact.
  const recordedTerminalReview = headHasValidatedHamTerminalRemediationImpl({ hqRoot: resolveHqRoot(env),
    repo: repoPath, prNumber, headSha: currentPrHeadSha });
  let ownedHeadSuppression = null;
  if (recordedTerminalReview) {
    ownedHeadSuppression = { suppressed: true, reason: 'hammer-validated-head', headSha: currentPrHeadSha };
  } else if (originalReviewedHead && originalReviewedHead !== currentPrHeadSha) {
    try {
      ownedHeadSuppression = await runCoexistenceOperation('hammer-head-ownership',
        () => cachedSuppression({ repoPath, prNumber, headSha: currentPrHeadSha, logger }),
        { timeoutMs: operationTimeoutMs, parentSignal: signal, operationTracker, logger, repoPath, prNumber });
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code === 'AMA_COEXISTENCE_OPERATION_TIMEOUT') throw error;
      logger?.warn?.(`Hammer head ownership proof failed: ${error.message || error}`);
    }
  }
  const hammerHead = !closerHeadHasLiveReview && !(isOrphanHeadReviewRequested(reviewStateRow, currentPrHeadSha)
    && ['pending', 'reviewing'].includes(reviewStateRow?.review_status))
    ? hammerHeadOwnership(ownedHeadSuppression, currentPrHeadSha) : null;

  // STALECLOSER-03: the ONE closer-authored-stale rule. A live review on the
  // closer head (which reset `closerOnlyHeadDelta` above) supersedes it.
  const closerAuthoredStale = closerAuthoredStaleEligible({
    hammerHead,
    headProof: closerOnlyHeadDelta || closerHeadProof?.proven !== true
      ? closerHeadProof
      : { ...closerHeadProof, proven: false, reason: 'closer-head-reviewed' },
    verdict: SETTLED_SUCCESS_VERDICTS.has(gateSnapshot?.settledReview?.verdict)
      ? 'settled-success'
      : String(gateSnapshot?.settledReview?.verdict || ''),
    blockingFindingState: gateSnapshot?.settledReview?.blockingFindingState,
    blockingFindingCount: gateSnapshot?.settledReview?.blockingFindingCount,
    checksConclusion: classifyCheckRollup(candidate?.statusCheckRollup, {
      requiredContexts: resolveRequiredCheckContextsFromCfg(cfg),
    }),
    mergeability: closureGateMergeability(mergeabilityForGate || {}),
  });
  if (closerAuthoredStaleSink) closerAuthoredStaleSink.value = closerAuthoredStale;
  if (probeCloserAuthoredStale) {
    return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true, probe: true,
      reason: 'closer-authored-stale-probe', closerAuthoredStale }, { amaEnabled: true });
  }

  // CLR-01 — carry a live closer lease forward when the head it is keyed to is no
  // longer the PR head.
  //
  // The lease is keyed by `(repo, prNumber, headSha)`, so a head advanced by the
  // closer that owns the lease orphans that lease: the file remains under a SHA no
  // longer on the branch, nothing can finalize it, and `selectReleasableCloserLeases`
  // refuses to reap it while its `watcherPid` is the LIVE watcher — which it always
  // is, because the live watcher is what acquired it. The lease becomes immortal and
  // the PR spins `review-queued -> skip-re-review (terminal closer commit) -> release
  // claim` forever with CI green and the review clean.
  //
  // `rekeyAmaCloserLease` was written for exactly this on 2026-08-12 (#828, after
  // #825) and shipped with tests — but nothing ever called it. On 2026-08-23
  // laceyenterprises/foundry#35 reproduced the identical deadlock: the hammer
  // succeeded at 02:23:45Z, its lease stayed `dispatched` on the pre-remediation
  // head, and the PR sat unmergeable. This is the missing call site.
  //
  // Safety lives in the helper: it refuses when the source lease is absent, when an
  // UNRELATED lease already holds the destination head, and when the lease is already
  // terminal. It preserves `acquiredAt`/`lrqId`/`watcherPid`, so ownership stays one
  // continuous audited chain, and stamps `rekeyedFromHeadSha`/`supersededHeads`.
  if (currentPrHeadSha) {
    try {
      const liveLease = findLiveAmaCloserLease(rootDir, { repo: repoPath, prNumber });
      if (liveLease && liveLease.headSha && liveLease.headSha !== currentPrHeadSha) {
        const rekey = rekeyAmaCloserLease({
          rootDir,
          repo: repoPath,
          prNumber,
          fromHeadSha: liveLease.headSha,
          toHeadSha: currentPrHeadSha,
          now: new Date().toISOString(),
        });
        logger?.log?.(
          `[watcher] AMA closer lease ${rekey.rekeyed ? 'rekeyed' : 'rekey declined'} for `
            + `${repoPath}#${prNumber}: ${String(liveLease.headSha).slice(0, 12)} -> `
            + `${String(currentPrHeadSha).slice(0, 12)}`
            + (rekey.rekeyed ? '' : ` (${rekey.reason})`),
        );
      }
    } catch (err) {
      // Lease reconciliation is a repair, not a gate: a failure here must never
      // stop the closure evaluation that follows.
      logger?.warn?.(
        `[watcher] AMA closer lease rekey failed for ${repoPath}#${prNumber}: ${err?.message || err}`,
      );
    }
  }

  throwIfAborted(signal);
  const reviewState = {
    operatorLabelFindings: gateSnapshot.settledReview?.operatorLabelFindings || null,
    // A same-head review edit is new evidence even when verdict/counts agree.
    refusalReviewVersion: gateSnapshot.settledReview?.evidenceVersion || null,
    // STOPHOLDREVIEW-01: the row's posting receipt proves a review arrived on
    // this head; never borrow its timestamp for a different settled head.
    postedAt: reviewStateRow?.review_status === 'posted'
      && reviewStateRow?.reviewer_head_sha === gateSnapshot.reviewedHeadSha
      ? reviewStateRow.posted_at || null : null,
    reviewCurrency: gateSnapshot.reviewCurrency || null,
    verdict: gateSnapshot.settledReview?.verdict || '',
    // `headSha` remains the reviewed evidence identity. Ordinary MSM-04 dispatch
    // uses it as the stable budget key; proven closer-only continuations use the
    // live closer head's budget, with repeated pushes bounded by the lifetime cap.
    // An unreviewed human push cannot inherit that continuation authority.
    headSha: gateSnapshot.reviewedHeadSha,
    riskClass: String(candidate?.riskClass || reviewStateRow?.risk_class || ledgerRiskClass || 'unknown').toLowerCase(),
    remediationPending: gateSnapshot.settledReview?.remediationPending,
    reviewCycleExhausted,
    completedRemediationRounds: Number.isFinite(completedRemediationRoundsForPR)
      ? completedRemediationRoundsForPR
      : null,
    completedRereviewRounds: Number.isFinite(completedRereviewRoundsForPR)
      ? completedRereviewRoundsForPR
      : null,
    completedRemediationRevisionRefs: completedRemediationRevisionRefsForPR,
    // Blocking/non-blocking findings classification MUST come from the same
    // authoritative current-head body that `gateSnapshot.settledReview` resolved
    // the verdict from (live head body when reconciled, else the stored job/row
    // body). Reading the dispatchJob body instead defaults to 'unknown' for a
    // clean `comment-only` review with no remediation job and makes the closer
    // fail `blocking-findings-unknown` and never merge (live on agent-os#1856).
    // `gateSnapshot.settledReview` always carries these keys; fall back to
    // 'unknown' only if absent (fail-closed). The non-blocking pair is the
    // HAM-STRICT strict-remediation gate input (read from the same source).
    blockingFindingCount: Number(gateSnapshot.settledReview?.blockingFindingCount ?? 0),
    blockingFindingState: String(gateSnapshot.settledReview?.blockingFindingState || 'unknown').trim().toLowerCase(),
    nonBlockingFindingCount: Number(gateSnapshot.settledReview?.nonBlockingFindingCount ?? 0),
    commentOnlyFinalRoundPush: gateSnapshot.settledReview?.commentOnlyFinalRoundPush === true,
    nonBlockingFindingState: String(gateSnapshot.settledReview?.nonBlockingFindingState || 'unknown').trim().toLowerCase(),
    // Per-finding non-blocking identities (normalized titles) from the same
    // authoritative body the verdict/counts came from. Drives the HAM
    // non-blocking waiver coverage gate: AMA waives non-blocking only when the
    // HAM addressed-findings cover EVERY current identity. `null`/absent →
    // identities unknown → fail closed (no waiver).
    nonBlockingFindingIdentities: Array.isArray(gateSnapshot.settledReview?.nonBlockingFindingIdentities)
      ? gateSnapshot.settledReview.nonBlockingFindingIdentities
      : null,
    // HAMFINAL-01 ("Hammers judgement is final"): blocking identities from the
    // same body, plus the hammer's `withdrawn-by-hammer` adjudications. A review
    // whose every blocking finding was withdrawn settles here instead of
    // skipping the hammer wake as `verdict-not-eligible` (agent-os PR 7987).
    blockingFindingIdentities: Array.isArray(gateSnapshot.settledReview?.blockingFindingIdentities)
      ? gateSnapshot.settledReview.blockingFindingIdentities
      : null,
    hammerWithdrawnFindings: Array.isArray(gateSnapshot.hammerWithdrawals) ? gateSnapshot.hammerWithdrawals : [],
    reviewBodySha256: gateSnapshot.settledReview?.reviewBodySha256 || null,
    operatorApprovedEvidence: operatorApprovalEvent
      ? {
          applied: true,
          observedRevisionRef: operatorApprovalEvent.headSha || operatorApprovalEvent.head_sha || null,
          actor: operatorApprovalEvent.actor || null,
          eventId: operatorApprovalEvent.id || operatorApprovalEvent.nodeId || null,
          observedAt: operatorApprovalEvent.createdAt || operatorApprovalEvent.created_at || null,
        }
      : null,
    prAuthor: candidate?.prAuthor || null,
  };
  const prMetadata = {
    prNumber,
    headSha: currentPrHeadSha,
    isOpen: String(candidate?.prState || 'open').toLowerCase() === 'open',
    isDraft: Boolean(candidate?.isDraft),
    // DIRTYOWN-01: classify UNKNOWN exactly as the daemon's
    // `evaluateMergeEligibility` does (raw `mergeable`), so an UNKNOWN+CLEAN
    // read waits a tick on both sides instead of the closer answering
    // `daemon-clean-route` for a head the daemon declines.
    mergeableState: closureGateMergeability(mergeabilityForGate || {}),
    // The diagnostic stuck marker cannot veto its recorded final-round owner.
    labels: Array.isArray(labelNames) ? labelNames.filter((label) =>
      label !== 'merge-agent-stuck' ||
      !(gateSnapshot.settledReview?.commentOnlyFinalRoundPush === true || closerOnlyHeadDelta)) : undefined,
    statusCheckRollup: Array.isArray(candidate?.statusCheckRollup) ? candidate.statusCheckRollup : [],
    baseSha: candidate?.baseSha || null,
    branchProtection: { requiredContexts: candidate?.branchProtection?.requiredContexts || [] },
    author: candidate?.prAuthor || null,
    title: String(candidate?.title ?? ''),
    body: String(candidate?.body ?? candidate?.prBody ?? ''),
  };

  if (ownerProofFactsSink) ownerProofFactsSink.value = {
    headSha: currentPrHeadSha, reviewedHeadSha: gateSnapshot?.reviewedHeadSha,
    verdict: gateSnapshot?.settledReview?.verdict || null,
    reviewCycleExhausted, commentOnlyFinalRoundCompleted: finalRoundKnown,
    checks: prMetadata.statusCheckRollup, mergeable: prMetadata.mergeableState,
  };
  const strictMode = cfg?.strictMode !== false;
  const autonomousMergeExecutionEnabled = cfg?.autonomousMergeExecutionEnabled !== false;
  const branchProtectionRequired = cfg?.branchProtection?.required !== false;
  const requiredGateContext = resolveGateStatusContext(env);
  const branchProtectionRequiredContexts = Array.isArray(candidate?.branchProtection?.requiredContexts)
    ? candidate.branchProtection.requiredContexts
    : [];
  const autonomousFlagState = {
    autonomousMergeExecutionEnabled,
    strictMode,
  };
  const hammerSettled = gateSnapshot?.settledReview?.verdict === 'request-changes'
    && resolveHammerAdjudication({ ...reviewState, reviewedHead: reviewState.headSha, currentHead: currentPrHeadSha },
      reviewState.hammerWithdrawnFindings).allBlockingWithdrawn;
  const settledVerdict = SETTLED_SUCCESS_VERDICTS.has(gateSnapshot?.settledReview?.verdict) || hammerSettled
    ? 'settled-success'
    : String(gateSnapshot?.settledReview?.verdict || '');
  let handoffLease = currentPrHeadSha && readAmaCloserLease(rootDir, {
    repo: repoPath, prNumber, headSha: currentPrHeadSha,
  });
  if (autonomousMergeExecutionEnabled && !(labelNames || []).some(label =>
    [...OPERATOR_HOLD_LABELS, 'duplicate-family-hold', 'adversarial-merge-blocked'].includes(label))) {
    handoffLease = await reconcileAndAbandonAmaCloserLease(rootDir, handoffLease, {
      ...closerLeaseLivenessOptions, ...preReceiptIntentOptions,
      now: now(), prMetadata, env, signal, logger,
      // Settle launches adopted by intent recovery before reclaiming ownership.
      reconcileDispatched: () => amaDispatchCloser.reconcileAmaCloserLeaseAsync({
        ...closerLeaseLivenessOptions, rootDir, repo: repoPath, prNumber,
        hqRoot: resolveHqRoot(env), now: new Date(now()).toISOString(), env, signal, logger,
      }),
    });
  }
  let recordedStop = readHammerStopForHeadImpl({ hqRoot: resolveHqRoot(env), repo: repoPath,
    prNumber, headSha: currentPrHeadSha, reviewedSha: reviewState.headSha, logger });
  if (autonomousMergeExecutionEnabled && prMetadata.isOpen
    && operatorLabelInputs(recordedStop?.refusal || recordedStop).length) {
    try {
      rearmOperatorApprovedCloser(rootDir, { repo: repoPath, prNumber }, {
        jobKey: reviewState.headSha, headSha: currentPrHeadSha, stop: recordedStop,
        prMetadata, now: new Date(now()).toISOString(), lifetimeDispatchCeiling: cfg.hammerLifetimeDispatchCeiling,
      });
    } catch (error) {
      logger?.warn?.(`[ama-closer] operator approval re-arm deferred for ${repoPath}#${prNumber}: ${error?.message || error}`);
    }
    const wait = await evaluateHammerStopHoldImpl({ rootDir, hqRoot: resolveHqRoot(env), repo: repoPath, prNumber,
      headSha: currentPrHeadSha, reviewedSha: reviewState.headSha, prMetadata, reviewState,
      excludeContexts: [requiredGateContext], requiredCheckContexts: resolveRequiredCheckContextsFromCfg(cfg),
      logger, deliverAlertImpl, now: new Date(now()).toISOString() });
    if (wait.action === 'release') recordedStop = null;
  }
  if (autonomousMergeExecutionEnabled && prMetadata.isOpen && companionOnlyStop(recordedStop)) {
    const wait = await evaluateHammerStopHoldImpl({ rootDir, hqRoot: resolveHqRoot(env), repo: repoPath, prNumber,
      headSha: currentPrHeadSha, reviewedSha: reviewState.headSha, prMetadata,
      logger, deliverAlertImpl, now: new Date(now()).toISOString() });
    if (wait.action === 'hold') return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true,
      recoveryWait: true, reason: 'hammer-stop-awaiting-companion', hammerStop: wait.hammerStop }, { amaEnabled: true });
    if (wait.action === 'release') recordedStop = null;
  }
  let infrastructureOwnerReleased = false;
  if (isInfrastructureStop(recordedStop)) {
    const evaluatedStop = await evaluateHammerStopHold({ rootDir, hqRoot: resolveHqRoot(env), repo: repoPath, prNumber,
      headSha: currentPrHeadSha, reviewedSha: reviewState.headSha, prMetadata,
      excludeContexts: [requiredGateContext], requiredCheckContexts: resolveRequiredCheckContextsFromCfg(cfg),
      logger, now: new Date(now()).toISOString() });
    recordedStop = evaluatedStop.infrastructureStop || recordedStop;
    if (evaluatedStop.action === 'release' && autonomousMergeExecutionEnabled && prMetadata.isOpen) {
      infrastructureOwnerReleased = await amaDispatchCloser.releaseRecoveredCiInfrastructureOwner({
        rootDir, hqRoot: resolveHqRoot(env), repo: repoPath, prNumber, prMetadata, reviewedSha: reviewState.headSha,
        excludeContexts: [requiredGateContext], requiredCheckContexts: resolveRequiredCheckContextsFromCfg(cfg),
        now: new Date(now()).toISOString(), logger, env, signal });
      if (infrastructureOwnerReleased) handoffLease = readAmaCloserLease(rootDir, {
        repo: repoPath, prNumber, headSha: currentPrHeadSha });
    }
  }
  const ownerCap = evaluateHammerRetryCap(readHammerRetryCapLedger(rootDir, { repo: repoPath, prNumber }), {
    jobKey: reviewState.headSha, headSha: currentPrHeadSha,
    lifetimeDispatchCeiling: cfg.hammerLifetimeDispatchCeiling,
  });
  if (hammerResume && ownerCap.capExhausted) {
    settleHammerResume({ hqRoot: resolveHqRoot(env), repo: repoPath, prNumber, resume: hammerResume,
      reason: 'budget-exhausted', now: new Date(now()).toISOString() });
    hammerResume = null;
  }
  const releasedStop = recordedStop && readHammerStopHoldForHead({ rootDir, repo: repoPath,
    prNumber, headSha: currentPrHeadSha, stopKey: recordedStop.stopKey })?.releasedAt;
  const closureOwnerInput = { hammerStop: recordedStop && (!recordedStop.refusal || !releasedStop) && !isInfrastructureStop(recordedStop) ? recordedStop : null,
    ...(recordedTerminalReview ? { terminalReview: { validated: true,
      headSha: currentPrHeadSha, reviewedHeadSha: reviewState.headSha } } : {}),
    rootDir, reviewState, reviewAdmissionRow: reviewStateRow,
    currentHead: currentPrHeadSha, strictMode, closerAuthoredStale, hammerHead, hammerResume,
    operatorLogins: cfg?.operatorLogins, operatorLabelActorEnforcement: cfg?.operatorLabelActorEnforcement,
    strictNonBlockingRemediation: cfg?.strictNonBlockingRemediation !== false,
    retryExhausted: ownerCap.capExhausted, lifetimeExhausted: ownerCap.lifetimeCapExhausted,
    hammerCapRecordedAt: ownerCap.recordedAt,
    operatorApprovalApplied: ownerCap.operatorApprovalApplied === true,
    lease: handoffLease,
    launchRecord: amaDispatchCloser.readAmaCloserDispatchRecord(rootDir, { repo: repoPath, prNumber,
      headSha: handoffLease?.rekeyedFromHeadSha || currentPrHeadSha }),
    mergeable: closureGateMergeability(mergeabilityForGate || {}),
    checks: summarizeChecksConclusion(candidate?.statusCheckRollup, { env, cfg }),
    // Read the queue, not the dispatch projection: a clean review can leave a
    // terminal job, while the next posted finding may still await job creation.
    // Reuse the gate's PR-scoped, case-insensitive live owner. Do not scan
    // growing terminal directories again while a live job already owns the PR.
    followUpJob: gateSnapshot.activeFollowUpJob || ['completed', 'failed', 'stopped']
      .flatMap(key => listFollowUpJobsInDir(rootDir, key, { repo: repoPath, prNumber, caseInsensitiveRepo: true }))
      .map(entry => entry.job)
      .filter(job => String(job.repo || '').toLowerCase() === repoPath.toLowerCase()
        && Number(job.prNumber) === Number(prNumber)
        && (job.headSha || job.revisionRef) === currentPrHeadSha)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null,
    // A legacy review handoff remains Hammer responsibility even though it is
    // no longer a deterministic refusal. Route it through release, not remediation.
    roundsLeft: !isLegacyReviewHandoffStop(recordedStop) && !reviewCycleExhausted && !finalPush
      && gateSnapshot.settledReview?.commentOnlyFinalRoundPush !== true, ciBlockedHammerOwner,
    finalPush: remediationHandoff ? { headSha: currentPrHeadSha, suppressed: true } : null,
    reviewCeilingReached: reviewCycleCapReached
      || (dispatchJob?.reviewFailureExhausted === true && dispatchJob?.reviewFailureClass === 'reviewer-timeout') };
  const resolveOwner = () => resolveClosureNextAction({ input: closureOwnerInput, passSnapshot,
    subjectKey: `${repoPath}#${prNumber}`, autonomousMergeExecutionEnabled,
    rootDir, observedAt: new Date(now()).toISOString(),
    anchors: { postedAt: reviewState.postedAt || reviewStateRow?.posted_at || null, finalRoundCompletedAt },
    checksRollup: candidate?.statusCheckRollup,
    candidate: { ...candidate, ...mergeabilityForGate }, labels: prMetadata.labels });
  let shared = (ownerCap.operatorApprovalApplied || infrastructureOwnerReleased ? null : resolvedNextAction) || await resolveOwner();
  if (resolvedNextAction) shared = reviseClosureNextAction(shared, { progress: {
    ...shared.snapshot.observations.progress?.value, hammerResume,
  } }, passSnapshot);
  // Scheduling failures are observations, not durable head-independent truth.
  // Re-read even on the same head: finding authorization/evidence may improve.
  let refreshedPrimaryChange;
  if (autonomousMergeExecutionEnabled && prMetadata.isOpen
    && shared.snapshot.observations.progress?.value?.primaryChange?.ok === false) {
    refreshedPrimaryChange = await runCoexistenceOperation('closure-primary-change-refresh',
      ({ signal: operationSignal }) => fetchPrimaryChangeImpl({ repo: repoPath, prNumber,
        headSha: currentPrHeadSha, rootDir,
        get: createHistoryReader({ env, signal: operationSignal }) }),
      { timeoutMs: operationTimeoutMs, parentSignal: signal, operationTracker, logger, repoPath, prNumber });
    const primary = checkPrimaryChange(refreshedPrimaryChange, currentPrHeadSha,
      { strictNonBlockingRemediation: cfg?.strictNonBlockingRemediation !== false });
    shared = reviseClosureNextAction(shared, { progress: {
      ...(shared.snapshot.observations.progress?.value ?? shared.snapshot.observations.progress),
      primaryChange: { ...primary, headSha: currentPrHeadSha },
    } }, passSnapshot);
  }
  let closureOwner = closureOwnerFromDecision(shared.decision);
  if (closureOwnerSink) closureOwnerSink.shared = shared;
  if (closureOwnerSink) closureOwnerSink.value = closureOwner;
  if (closureOwnerSink) closureOwnerSink.shadowInput = { input: closureOwnerInput, autonomousMergeExecutionEnabled };
  if (shared.decision.action === 'done') {
    return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true, prTerminal: true,
      reason: shared.decision.reason }, { amaEnabled: true });
  }
  if (shared.decision.action === 'operator-hold' && autonomousMergeExecutionEnabled) {
    if (reviewState.operatorLabelFindings?.allGated
      && shared.decision.reason === reviewState.operatorLabelFindings.gated[0]?.reason) {
      return withAmaDispatchMetadata(await holdForOperatorLabels({ rootDir, repo: repoPath, prNumber,
        headSha: currentPrHeadSha,
        gates: reviewState.operatorLabelFindings.gated.map(({ check, label, reason }) => ({ check, label, reason })),
        deliverAlertImpl, logger }), { amaEnabled: true });
    }
    return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true,
      reason: shared.decision.reason }, { amaEnabled: true });
  }
  const wouldUseDaemonPath = isDaemonMergeReviewAllowed(reviewState, { strictMode });
  const disabledEligibility = evaluateMergeEligibility({
    verdict: settledVerdict,
    operatorApprovedEvidence: reviewState.operatorApprovedEvidence,
    operatorLogins: cfg?.operatorLogins,
    operatorLabelActorEnforcement: cfg?.operatorLabelActorEnforcement,
    leaseHeld: true,
    requiredChecks: prMetadata.statusCheckRollup,
    mergeable: mergeabilityForGate?.mergeable,
    mergeStateStatus: mergeabilityForGate?.mergeStateStatus,
    prState: String(candidate?.prState || 'open').toUpperCase(),
    branchProtectionRequired,
    requiredGateContext,
    branchProtectionRequiredContexts,
    requiredCheckContexts: resolveRequiredCheckContextsFromCfg(cfg),
    // The diagnostic stuck marker cannot veto its recorded final-round owner.
    labels: Array.isArray(labelNames) ? labelNames.filter((label) =>
      label !== 'merge-agent-stuck' ||
      !(gateSnapshot.settledReview?.commentOnlyFinalRoundPush === true || closerOnlyHeadDelta)) : undefined,
    candidateHead: currentPrHeadSha || candidate?.headSha || '',
    validatedHead: closerOnlyHeadDelta && closerAuthoredStale.carryForward
      ? currentPrHeadSha : reviewState.headSha,
  });
  if (!autonomousMergeExecutionEnabled) {
    amaDispatchCloser.retireAmaCloserDrainHint(rootDir, {
      repo: repoPath, prNumber, headSha: currentPrHeadSha || reviewState?.headSha,
    }, { logger });
    const hqRoot = resolveHqRoot(env);
    const disabledAudit = writeAutonomousMergeDisabledAuditImpl({
      hqRoot,
      repoPath,
      prNumber,
      headSha: reviewState.headSha,
      path: wouldUseDaemonPath ? 'daemon-merge' : 'hammer-merge',
      eligibilityReasons: disabledEligibility.reasons,
      flagState: autonomousFlagState,
      reviewStateRow,
      reviewState,
      logger,
    });
    logger?.warn?.(
      `[watcher] autonomous merge execution disabled for ${repoPath}#${prNumber}` +
        `@${String(reviewState.headSha || '').slice(0, 12)}; ` +
        `would_path=${wouldUseDaemonPath ? 'daemon-merge' : 'hammer-merge'} ` +
        `audit=${disabledAudit?.written ? 'written' : disabledAudit?.reason || 'not-written'}`,
    );
    return withAmaDispatchMetadata(
      {
        dispatched: false,
        skipMergeAgent: true,
        reason: 'autonomous-merge-execution-disabled',
        autonomousMergeDisabled: {
          path: wouldUseDaemonPath ? 'daemon-merge' : 'hammer-merge',
          eligibilityReasons: disabledEligibility.reasons,
          flagState: autonomousFlagState,
          auditWritten: Boolean(disabledAudit?.written),
        },
      },
      { amaEnabled: true },
    );
  }

  if (handoffLease?.status === 'handed-to-review' && closureOwner.owner === 'review') {
    // A later proof appearing cannot steal an explicitly transferred review.
    const boundedWait = await observeWait({ rootDir, repo: repoPath, prNumber,
      headSha: currentPrHeadSha, reason: `handed-to-review:${currentPrHeadSha}`, env });
    return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true, recoveryWait: true,
      reason: 'handed-to-review', retryAfterMs: boundedWait.retryAfterMs, boundedWait,
      ...(boundedWait.exhausted ? { needsOperator: true } : {}) }, { amaEnabled: true });
  }

  if (['owned', 'reconcile'].includes(shared.decision.queue.intent) && handoffLease && ['pending', 'dispatched'].includes(handoffLease.status)
    && !(labelNames || []).some(label =>
    [...OPERATOR_HOLD_LABELS, 'duplicate-family-hold', 'adversarial-merge-blocked'].includes(label))) {
    const ownLease = handoffLease.watcherPid === process.pid
      && (!handoffLease.holderHost || handoffLease.holderHost === hostname());
    const flight = handoffLease && ['pending', 'dispatched'].includes(handoffLease.status);
    const ownership = flight ? await probeClosureOwnershipImpl({ rootDir, repo: repoPath, prNumber,
      headSha: currentPrHeadSha, labels: labelNames || [], signal, timeoutMs: loadAwareTimeoutMs(5000), logger }) : null;
    // A yielded ownership read cannot carry an uncertain pending lease across
    // its deadline. Recompute routing from the recorded terminal transition.
    const abandoned = await abandonAmaCloserLease(rootDir, handoffLease,
      { ...closerLeaseLivenessOptions, now: now(), logger, reconcileIntent: false });
    if (abandoned) {
      handoffLease = abandoned;
      closureOwnerInput.lease = abandoned;
      shared = await resolveOwner();
      closureOwner = closureOwnerFromDecision(shared.decision);
      if (closureOwnerSink) {
        closureOwnerSink.shared = shared;
        closureOwnerSink.value = closureOwner;
      }
    }
    const background = resolveAmaHammerDispatchModeImpl({ cfg: loadedConfig, logger }) === 'background'
      ? amaHammerBackgroundQueueImpl({ maxConcurrent: cfg.amaCloserMaxConcurrentLaunches }).get?.(
        amaHammerBackgroundKey({ repo: repoPath, prNumber, headSha: currentPrHeadSha })) : null;
    const launchProgress = ownLease ? amaHammerBackgroundProgress(background, now()) : {};
    // Apply the actual outcome below instead of hiding a refusal behind the
    // pending lease left by that completed dispatch.
    if (!abandoned && !(ownLease && background?.state === 'settled')
      && (launchProgress.closerProgressAt || !flight || ownership?.owned !== false || ownership?.uncertain === true)) {
      // A confirmed closer or this process's running dispatch gets a fixed
      // progress window. Other pending/uncertain ownership keeps its stall clock.
      const closerProgressAt = launchProgress.closerProgressAt || (handoffLease.status === 'dispatched'
        && ownership?.owned === true && ownership?.uncertain !== true
        ? handoffLease.updatedAt || handoffLease.acquiredAt || null : null);
      const reason = launchProgress.reason || `in-flight:${handoffLease.lrqId || handoffLease.watcherPid || 'closer-lease'}`;
      const boundedWait = await observeWait({ rootDir, repo: repoPath, prNumber,
        headSha: currentPrHeadSha, reason, env,
        launchAlive: Boolean(launchProgress.closerProgressAt) || (ownership?.owned === true && ownership?.uncertain !== true
          && Array.isArray(ownership?.launchIds) && ownership.launchIds.length > 0),
        ...(finalRoundSink?.value
          ? closureWaitProgress({ ...launchProgress, closerProgressAt }, finalRoundSink.value.startedAt) : {}) });
      return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true, recoveryWait: true,
        ...launchProgress, closerLaunchAlive: ownership?.owned === true && ownership?.uncertain !== true
          && Array.isArray(ownership?.launchIds) && ownership.launchIds.length > 0, reason, retryAfterMs: boundedWait.retryAfterMs,
        ...(closerProgressAt ? { closerProgressAt } : {}),
        ...(boundedWait.exhausted ? { needsOperator: true } : {}), boundedWait }, { amaEnabled: true });
    }
  }

  const protectiveHold = await evaluateProtectivePredecessorHoldForClosure({
    repo: repoPath,
    prNumber,
    body: prMetadata.body,
    fetchProtectivePredecessorStateImpl,
    execFileImpl: execFileAsync,
    logger,
  });
  if (protectiveHold) {
    const daemonHeadShort = String(gateSnapshot?.reviewedHeadSha || '').slice(0, 12);
    logger?.warn?.(
      `[watcher] AMA protective predecessor hold before closeout routing for ` +
        `${repoPath}#${prNumber}@${daemonHeadShort}: ${protectiveHold.reason}`,
    );
    recordDaemonMergePark({
      rootDir,
      repo: repoPath,
      prNumber,
      headSha: gateSnapshot?.reviewedHeadSha || null,
      reason: protectiveHold.reason,
    });
    if (typeof emitProtectivePredecessorFindingImpl === 'function' && protectiveHold.finding) {
      try {
        await emitProtectivePredecessorFindingImpl(protectiveHold.finding);
      } catch (err) {
        logger?.warn?.(
          `[watcher] protective predecessor finding emit failed for ${repoPath}#${prNumber}: ` +
            `${err?.message || err}`,
        );
      }
    } else if (protectiveHold.finding) {
      await emitProtectivePredecessorFindingToLog(logger, protectiveHold.finding);
    }
    return withAmaDispatchMetadata(
      {
        dispatched: false,
        skipMergeAgent: true,
        reason: protectiveHold.reason,
        protectivePredecessor: protectiveHold.protectivePredecessor,
      },
      { amaEnabled: true },
    );
  }

  // RPL-05: wake only after the full policy snapshot has cleared, including
  // the explicit protective-predecessor/gate-keeper hold above. This is an
  // edge-trigger into the existing watcher AMA route, not merge authority.
  // STALECLOSER-03: a closer-authored stale head wakes under its own reason the
  // tick the shared predicate turns eligible (CI went green, mergeability resolved).
  if (closerAuthoredStale.eligible) {
    writeCloserAuthoredStaleAudit(rootDir, {
      repo: repoPath, prNumber, eligibility: closerAuthoredStale, verdict: reviewState.verdict,
      blockingFindingCount: reviewState.blockingFindingCount,
      nonBlockingFindingCount: reviewState.nonBlockingFindingCount, logger,
    });
  }
  try {
    // Routing and wake share the same immutable decision; logging is observational.
    throwIfAborted(signal);
    let identity = { repo: repoPath, prNumber, headSha: currentPrHeadSha };
    let intent = ciBlockedHammerOwner
      ? amaDispatchCloser.readAmaCloserDispatchRecord(rootDir, identity) : null;
    if (ciBlockedHammerOwner && !intent && reviewState.headSha && reviewState.headSha !== currentPrHeadSha) {
      const reviewedIdentity = { ...identity, headSha: reviewState.headSha };
      const reviewedIntent = amaDispatchCloser.readAmaCloserDispatchRecord(rootDir, reviewedIdentity);
      if (reviewedIntent) { identity = reviewedIdentity; intent = reviewedIntent; }
    }
    const wake = requestEligibleHammerWakeImpl({
      rootDir,
      reviewStateDb,
      repo: repoPath,
      prNumber,
      headSha: currentPrHeadSha || candidate?.headSha || '',
      reviewedHeadSha: reviewState.headSha,
      shared,
      log: logger,
    });
    if (hammerWakeSink && ciBlockedHammerOwner && orchestrationMode === 'native') {
      hammerWakeSink.value = { rootDir, identity, intent, wake };
    }
  } catch (err) {
    logger?.warn?.(
      `[watcher] eligible hammer wake failed for ${repoPath}#${prNumber}; continuing AMA closure: ` +
      `${err?.message || err}`,
    );
  }

  // The closeout's final-push evidence must not turn a pending-check decision
  // into a ceiling-repair dispatch. Reuse the shared decision and ordinary
  // bounded observer; an overdue report never consumes another round or refuses
  // later work. Every settled-head launch still runs the existing gates below.
  if (shared.decision.action === 'wait-for-CI'
    && !(wouldUseDaemonPath && reviewState.headSha === currentPrHeadSha
      && String(candidate?.prState || '').toUpperCase() === 'OPEN')) {
    const decision = shared.decision;
    closureOwner = closureOwnerFromDecision(decision);
    if (closureOwnerSink) closureOwnerSink.value = closureOwner;
    let boundedWait = null;
    try {
      const observedNow = now();
      const anchoredAt = Date.parse(decision.deadline?.anchoredAt || '');
      boundedWait = await observeWait({ rootDir, repo: repoPath, prNumber, headSha: decision.head, env,
        now: observedNow, startedAt: anchoredAt,
        reason: `action=${decision.action} actor=${decision.actor} reason=${decision.reason} head=${decision.head} ageMs=${Math.max(0, observedNow - anchoredAt)}` });
    } catch (error) {
      logger?.warn?.(`[watcher] closeout observer delivery failed: ${error?.message || error}`);
    }
    return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true, recoveryWait: true,
      reason: closerOnlyHeadDelta && closerAuthoredStale.decision === 'retry'
        ? closerAuthoredStale.reasons.includes('ci-pending') ? 'closer-head-ci-not-green' : 'closer-head-mergeability-unknown'
        : decision.reason === 'mergeability-unknown' ? 'pending-mergeability' : 'pending-required-checks',
      ...(closerOnlyHeadDelta && closerAuthoredStale.decision === 'retry' ? { reasons: disabledEligibility.reasons } : {}),
      nextAction: decision, boundedWait, retryAfterMs: boundedWait?.retryAfterMs || 30_000 }, { amaEnabled: true });
  }

  let allowStaleReviewHeadHammerResume = Boolean(hammerResume);
  // NOOWNER-01: a closer tip suppresses ordinary automatic review refresh;
  // ownerless, uncertified heads return to hammer validation.
  let liveHeadCloserAuthored = false;
  let hamTerminalRemediationEvidenceOptions = null;
  let hamTerminalRemediationValidated = false;
  let nonReviewableHeadDeltaEvidence = null;
  const reviewedHeadIsStale = Boolean(
    reviewState.headSha &&
      currentPrHeadSha &&
      reviewState.headSha !== currentPrHeadSha,
  );
  // FIX (stale-review-head spin, #5053): run the own-commit suppression proof for
  // ANY stale reviewed head, NOT only the review-cycle-exhausted case. A hammer
  // remediation on a comment-only / non-blocking (settled but non-exhausted)
  // review also advances the head -> `stale-review-head` -> the eligibility miss
  // was never self-certifiable, so the no-dispatch "retain" tick spun unbounded (a
  // live 50-min stall). Dropping the `reviewCycleExhausted &&` guard lets the
  // own-commit proof arm for that case too. A head without closer trailers or
  // linked closer/HAM author provenance stays reviewable. Resume requires a
  // closer-only chain proof or an authoritative live-review probe; unknown
  // reviewer identity without a chain leaves the head for exact-head review.
  // A recognized closer-trailer tip can arm HAM resume even when a rebase broke
  // the closer-only chain. That flag admits a repair attempt; merge authority
  // still requires the exact-head terminal-remediation validator, including its
  // reviewed-head binding. An uncertified closer head needs hammer validation.
  if (!orphanRecovery?.ownerProof && reviewedHeadIsStale && !(isOrphanHeadReviewRequested(reviewStateRow, currentPrHeadSha)
    && ['pending', 'reviewing'].includes(reviewStateRow?.review_status))) {
    try {
      throwIfAborted(signal);
      const closerCommitSuppression = await runCoexistenceOperation(
        'stale-head-suppression-proof',
        ({ signal: operationSignal }) => cachedSuppression({
          repoPath, prNumber, headSha: currentPrHeadSha, logger, signal: operationSignal,
        }),
        {
          timeoutMs: operationTimeoutMs,
          parentSignal: signal,
          operationTracker,
          logger,
          repoPath,
          prNumber,
        },
      );
      throwIfAborted(signal);
      liveHeadCloserAuthored = closerCommitSuppression?.suppressed === true
        && ['closer-commit-trailer', 'hammer-validated-head'].includes(closerCommitSuppression?.reason);
      if (ownerProofFactsSink?.value) ownerProofFactsSink.value.liveHeadCloserAuthored = liveHeadCloserAuthored;
      if (liveHeadCloserAuthored && !closerOnlyHeadDelta && !closerHeadHasLiveReview
        && authoritativeReviewerLogins.length > 0) {
        const currentBodies = await runCoexistenceOperation(
          'rebased-closer-head-live-review',
          ({ signal: operationSignal }) => fetchLatestHeadReviewBodiesWithRetry({
            repoPath, prNumber, headSha: currentPrHeadSha, authoritativeReviewerLogins,
            fetchLatestHeadReviewBodiesImpl, retryDelaysMs: liveReviewRetryDelaysMs,
            logger, signal: operationSignal,
          }),
          { timeoutMs: operationTimeoutMs, parentSignal: signal, operationTracker, logger, repoPath, prNumber },
        );
        closerHeadHasLiveReview = currentBodies.length > 0;
      }
      // A HAM rebase can break the chain to the reviewed SHA. Its exact-head
      // ground-truth certificate below remains authoritative independently.
      allowStaleReviewHeadHammerResume = Boolean(hammerResume) || (liveHeadCloserAuthored && !closerHeadHasLiveReview
        && (Boolean(hammerHead) || closerOnlyHeadDelta || authoritativeReviewerLogins.length > 0));
      if (
        allowStaleReviewHeadHammerResume &&
        closerCommitSuppression?.reason === 'closer-commit-trailer'
      ) {
        const verifiedCommit = await runCoexistenceOperation(
          'head-closer-verified-commit',
          ({ signal: operationSignal }) => cachedCommit({
            repoPath,
            prNumber,
            headSha: currentPrHeadSha,
            env,
            execFileImpl: execFileAsync,
            logger,
            signal: operationSignal,
          }),
          {
            timeoutMs: operationTimeoutMs,
            parentSignal: signal,
            operationTracker,
            logger,
            repoPath,
            prNumber,
          },
        );
        throwIfAborted(signal);
        nonReviewableHeadDeltaEvidence = buildNonReviewableHeadDeltaEvidence({
          reviewedHead: reviewState.headSha,
          currentHead: currentPrHeadSha,
          verifiedCommit,
          suppression: closerCommitSuppression,
        });
      }
      if (
        (allowStaleReviewHeadHammerResume || closerCommitSuppression?.reason === 'hammer-validated-head') &&
        typeof resolveHamTerminalRemediationEvidenceImpl === 'function'
      ) {
        const resolvedHamEvidence = await runCoexistenceOperation(
          'ham-terminal-remediation-evidence',
          ({ signal: operationSignal }) => resolveHamTerminalRemediationEvidenceImpl({
            reviewState,
            prMetadata,
            repoPath,
            prNumber,
            execFileImpl: execFileAsync,
            closerCommitSuppression,
            fetchHeadCloserVerifiedCommitImpl: cachedCommit,
            rootDir,
            logger,
            signal: operationSignal,
          }),
          {
            cacheKey: `ham-terminal-remediation-evidence:${reviewState.headSha}`,
            timeoutMs: operationTimeoutMs,
            parentSignal: signal,
            operationTracker,
            logger,
            repoPath,
            prNumber,
          },
        );
        throwIfAborted(signal);
        if (
          resolvedHamEvidence?.hamTerminalRemediation &&
          resolvedHamEvidence?.hamTerminalRemediationGroundTruth
        ) {
          hamTerminalRemediationEvidenceOptions = resolvedHamEvidence;
          const hamEligibility = isEligibleForAmaClosure(reviewState, prMetadata, cfg, {
            env,
            hamTerminalRemediation: resolvedHamEvidence.hamTerminalRemediation,
            hamTerminalRemediationGroundTruth:
              resolvedHamEvidence.hamTerminalRemediationGroundTruth,
          });
          hamTerminalRemediationValidated =
            hamEligibility?.trace?.hamTerminalRemediation?.ok === true;
          if (hamTerminalRemediationValidated) {
            allowStaleReviewHeadHammerResume = true;
            liveHeadCloserAuthored = true;
          }
        }
      }
    } catch (err) {
      throwIfAborted(signal);
      if (err?.code === 'AMA_COEXISTENCE_OPERATION_TIMEOUT') {
        throw err;
      }
      if (isTransientGhError(err)) {
        throw err;
      }
      logger?.warn?.(
        `[watcher] HAM stale-head resume proof failed for ${repoPath}#${prNumber} ` +
          `head=${String(currentPrHeadSha || '').slice(0, 12)}; not allowing hammer resume: ` +
          `${err?.message || err}`,
      );
    }
  }

  // SVD-02 — THIRD stale-verdict dismissal trigger (SEV
  // `docs/postmortems/SEV-stale-blocking-verdict-is-structurally-undismissable-2026-08-26.md`).
  //
  // The other two dismissal paths are both gated on a state that a standing
  // blocking verdict itself prevents: the reviewer-side one needs a NEW clean
  // `comment-only` review (policy says the final HAM remediation is FINAL — none
  // follows), and the daemon-owned one lives INSIDE the clean-merge attempt below,
  // past its live eligibility gate. So a PR whose final remediation resolved the
  // blocking finding parked at `CHANGES_REQUESTED` against a head no reviewer ever
  // judged, until an operator dismissed it by hand (#5918: 4.5h at MERGEABLE/CLEAN
  // with every required check green; #5811 earlier).
  //
  // This fires BEFORE the daemon clean path, on the one signal present in exactly
  // that case: a VALIDATED HAM terminal remediation at the current head, proven by
  // the same already-trusted primitives the merge path uses
  // (`resolveHamTerminalRemediationEvidence` ground truth above, or the durable
  // per-head `ham_terminal_remediation_validated` AMA audit marker). It grants NO
  // merge authority — the daemon attempt below still enforces every one of its own
  // gates. It only clears an obsolete verdict so that existing authority can act.
  //
  // HARD INVARIANT: a verdict whose `commit_id` EQUALS `currentPrHeadSha` is a LIVE
  // finding and is NEVER dismissed. Only a STRICTLY superseded head qualifies.
  const dismissStaleRequestChangesOnResolved =
    isDismissStaleRequestChangesOnResolvedEnabled({ env, logger });
  const standingBlockingFindingCount = Number(
    dispatchJob?.blockingFindingCount ?? reviewState.blockingFindingCount,
  ) || 0;
  if (
    dismissStaleRequestChangesOnResolved &&
    standingBlockingFindingCount > 0
  ) {
    throwIfAborted(signal);
    await runCoexistenceOperation(
      'dismiss-superseded-blocking-verdict',
      ({ signal: operationSignal }) => dismissSupersededBlockingVerdictAtRemediatedHeadImpl({
        repo: repoPath,
        prNumber,
        currentHeadSha: currentPrHeadSha || candidate?.headSha || null,
        hamTerminalRemediationValidated,
        authoritativeReviewerLogins,
        env,
        logger,
        signal: operationSignal,
      }),
      {
        timeoutMs: operationTimeoutMs,
        parentSignal: signal,
        operationTracker,
        logger,
        repoPath,
        prNumber,
      },
    );
  }

  if (hamTerminalRemediationValidated && !closureOwnerInput.attested) {
    const evidence = closureOwnerShadowEvidence({ ...closureOwnerInput, attested: true });
    shared = reviseClosureNextAction(shared, { progress: {
      ...shared.snapshot.observations.progress?.value, ...evidence.observations.progress,
      terminalReview: { validated: true, headSha: currentPrHeadSha, reviewedHeadSha: reviewState.headSha },
    } }, passSnapshot);
    if (closureOwnerSink) closureOwnerSink.shared = shared;
  }
  closureOwner = closureOwnerFromDecision(shared.decision);
  if (closureOwnerSink) closureOwnerSink.value = closureOwner;
  if (closureOwnerSink) closureOwnerSink.shadowInput = { input: { ...closureOwnerInput, attested: hamTerminalRemediationValidated },
    autonomousMergeExecutionEnabled };

  const terminalEvidenceProbe = liveHeadCloserAuthored && allowStaleReviewHeadHammerResume
    && reviewState.blockingFindingState === 'known' && reviewState.blockingFindingCount === 0
    && shared.decision.queue.intent === 'dispatch'
    && ['review', 'hammer'].includes(shared.decision.action)
    && reviewState.attestation !== 'invalid';
  if (['review', 'remediate'].includes(shared.decision.action) && !terminalEvidenceProbe) {
    const decision = shared.decision;
    let boundedWait = null;
    try {
      boundedWait = await observeWait({ rootDir, repo: repoPath, prNumber,
        headSha: decision.head, env, now: now(), startedAt: Date.parse(decision.deadline?.anchoredAt),
        reason: `action=${decision.action} actor=${decision.actor} reason=${decision.reason} head=${decision.head}` });
    } catch (error) { logger?.warn?.(`[watcher] next-action observation failed: ${error.message}`); }
    return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true, recoveryWait: true,
      reason: decision.action === 'review' ? 'handed-to-review'
        : hasLiveRemediationJob(shared.snapshot) ? 'active-remediation-job' : 'remediation-job-missing',
      nextAction: decision, boundedWait, retryAfterMs: boundedWait?.retryAfterMs || 30_000 }, { amaEnabled: true });
  }

  // CI-SETTLEMENT MODEL — read this before hunting for a wait loop; there is
  // no blocking wait for CI anywhere in this tick, by design. When required
  // checks are PENDING (or not yet registered) on the candidate head:
  //   - the eligibility predicate reads `ci-not-green` (SPEC §4.2 #5), and
  //   - the daemon clean-path below returns disposition `not-taken`
  //     (its shared MSM-02 predicate requires COMPLETED+SUCCESS checks),
  // and the tick simply ends for this PR. The "settle loop" IS the watcher
  // poll loop (`config.pollIntervalMs`, default 300000 ms in config.json):
  // each tick re-fetches the rollup and re-runs this same function until the
  // checks settle one way or the other. The one place that DOES wait on CI is
  // the hammer worker itself — `ci-not-green` is a hammer-remediable miss, so
  // a hammer may be dispatched while checks are still pending, and its prompt
  // (templates/hammer-prompt.md, HAM remote-CI window) owns the bounded
  // remote-CI wait on the exact post-remediation head. Do not add an inline
  // CI wait here: a single tick must stay bounded or one slow PR head-blocks
  // every other PR in the poll.
  //
  // MSM-03 — daemon clean-path merge ("Path B"). A fully clean settled review,
  // or a current-head operator-approved override, may enter this lane when
  // GitHub reports green checks and mergeability. The daemon re-reads the live
  // label and head before merging under its lease. Without the override, strict
  // mode declines findings and falls through to the hammer (MSM-04).
  // Dispositions other than `not-taken` normally own this tick:
  //   - merged        → PR landed, `daemon-merge` audit written, lease released.
  //   - failed-closed → audit written and lease released; hammer-remediable
  //                     eligibility gates hand off to the capped hammer.
  //   - deferred      → lease contention / audit bootstrap failure; retry next
  //                     tick with no double-merge.
  throwIfAborted(signal);
  try {
    if (!priorDaemonCleanMerge && !wouldUseDaemonPath) await observeClosureLag({ rootDir, repo: repoPath, prNumber, headSha: currentPrHeadSha,
      open: String(candidate?.prState || '').toUpperCase() === 'OPEN', observedAt: closureLagObservedAt,
      eligible: !wouldUseDaemonPath && isEligibleForAmaClosure(reviewState, prMetadata, cfg).eligible,
      sloMs: cfg.closureLagSloMs, logger });
  } catch (error) { logger?.warn?.(`AMA closure-lag observation failed: ${error.message}`); }
  const observeDaemonGate = (live, observed = null) => {
    shared = observed || reviseDaemonGate(shared, live, passSnapshot);
    if (closureOwnerSink) closureOwnerSink.shared = shared;
  };
  const daemonSelected = (shared.decision.action === 'daemon-merge' && shared.decision.actor === 'daemon')
    || shared.decision.action === 'wait-for-CI' || terminalEvidenceProbe;
  const daemonCleanMerge = !daemonSelected
    ? { disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN, reason: shared.decision.reason }
    : orphanRecovery?.ownerProof
    ? { disposition: DAEMON_MERGE_DISPOSITION.NOT_TAKEN, reason: 'ownerless-hammer-recovery' }
    : priorDaemonCleanMerge && priorDaemonCleanMerge.disposition !== DAEMON_MERGE_DISPOSITION.DEFERRED
    ? priorDaemonCleanMerge : await runCoexistenceOperation(
    'daemon-clean-merge-attempt',
    ({ signal: operationSignal }) => runDaemonCleanMergeAttemptImpl({
      rootDir,
      cfg,
      repoPath,
      prNumber,
      candidate,
      gateSnapshot,
      mergeabilityForGate,
      reviewState,
      reviewStateRow,
      currentPrHeadSha,
      // Deliverable 1 — the head-scoped operator labels that substitute for an
      // unresolved worker identity so a clean un-attributed PR closes under an
      // operator-accountable lease instead of parking `worker-identity-unresolved`.
      operatorApprovalEvent,
      mergeAgentRequestEvent,
      logger,
      env,
      authoritativeReviewerLogins,
      dismissStaleRequestChangesOnResolved,
      hamTerminalRemediationValidated,
      sharedNextAction: shared,
      passSnapshot,
      onGateSnapshot: observeDaemonGate,
      emitProtectivePredecessorFindingImpl: emitProtectivePredecessorFindingImpl
        || ((finding) => emitProtectivePredecessorFindingToLog(logger, finding)),
      signal: operationSignal,
    }),
    {
      timeoutMs: operationTimeoutMs,
      parentSignal: signal,
      operationTracker,
      logger,
      repoPath,
      prNumber,
    },
  );
  throwIfAborted(signal);
  // Adopt the adapter's generation before folding returned live facts. The
  // result may carry a gate newer than its last onGateSnapshot callback.
  if (daemonSelected && !orphanRecovery?.ownerProof && daemonCleanMerge?.nextActionShared) {
    shared = daemonCleanMerge.nextActionShared;
  }
  if (daemonCleanMerge?.liveGate) observeDaemonGate(daemonCleanMerge.liveGate);
  if (daemonSelected && !orphanRecovery?.ownerProof) {
    shared = observeDaemonResult(shared, daemonCleanMerge, passSnapshot);
  }
  if (closureOwnerSink) closureOwnerSink.shared = shared;
  if (['stacked-base-merged', 'stacked-base-read-failed'].includes(daemonCleanMerge?.reason)) {
    return withAmaDispatchMetadata({ ...daemonCleanMerge, dispatched: false, skipMergeAgent: true }, { amaEnabled: true });
  }
  if (!priorDaemonCleanMerge && daemonCleanMerge?.reason === 'not-eligible') {
    try { await observeClosureLag({ rootDir, repo: repoPath, prNumber, headSha: currentPrHeadSha,
      eligible: false, observedAt: closureLagObservedAt, reason: daemonCleanMerge.reason, logger }); }
    catch (error) { logger?.warn?.(`AMA closure-lag observation failed: ${error.message}`); }
  }
  if (daemonCleanMerge?.needsOperator === true && daemonCleanMerge.reason === 'primary-change-needs-operator') {
    recordDaemonMergePark({ rootDir, repo: repoPath, prNumber,
      headSha: currentPrHeadSha || null,
      reason: daemonCleanMerge.reasons?.find((reason) => reason.startsWith('primary-change-'))
        || daemonCleanMerge.reason });
    const missingEvidence = daemonCleanMerge.eligibilityTrace?.trace?.primaryChange?.missingEvidence
      || checkPrimaryChange(daemonCleanMerge.liveGate?.primaryChange, currentPrHeadSha, { strictNonBlockingRemediation: cfg?.strictNonBlockingRemediation !== false }).missingEvidence;
    try {
      await observeWait({ rootDir, repo: repoPath, prNumber,
        headSha: currentPrHeadSha, immediate: true, env,
        reason: `primary-change-needs-operator: ${missingEvidence?.path || 'unknown file'}: ${missingEvidence?.summary || daemonCleanMerge.reasons?.join(', ')}` });
    } catch (error) {
      logger?.warn?.(`[watcher] primary-change page delivery failed for ${repoPath} PR ${prNumber}: ${error.message}`);
    }
    if (closureOwnerSink) closureOwnerSink.value = { owner: 'page', reason: 'primary-change-needs-operator' };
    return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true,
      reason: daemonCleanMerge.reason, reasons: daemonCleanMerge.reasons,
      needsOperator: true, missingEvidence, daemonCleanMerge,
      primaryChangeRepair: hasHammerDispatchIntent(shared, { repo: repoPath, prNumber, headSha: currentPrHeadSha }),
    }, { amaEnabled: true });
  }

  if (!orphanRecovery?.ownerProof && daemonCleanMerge?.disposition && daemonCleanMerge.disposition !== DAEMON_MERGE_DISPOSITION.NOT_TAKEN) {
    const daemonHeadShort = String(gateSnapshot?.reviewedHeadSha || '').slice(0, 12);
    logger?.log?.(
      `[watcher] AMA daemon clean-merge ${daemonCleanMerge.disposition} for ${repoPath}#${prNumber}` +
        `@${daemonHeadShort}: ${daemonCleanMerge.reason}` +
        (daemonCleanMerge.attempts ? ` (attempts=${daemonCleanMerge.attempts})` : ''),
    );

    // Persist the park reason so `review-pipeline-health` can name it. Without
    // this the reason lives only in watcher stdout, and a parked PR surfaces as
    // a generic `terminal_but_unmerged` that lists candidate causes instead of
    // the one that applied (foundry#35, 8.8h on `worker-identity-unresolved`).
    // Diagnostics only — nothing reads these records to decide a merge.
    if (daemonCleanMerge.disposition === DAEMON_MERGE_DISPOSITION.MERGED) {
      try { await observeClosureLag({ rootDir, repo: repoPath, prNumber, headSha: currentPrHeadSha,
        merged: true, mergedAt: daemonCleanMerge.mergedAt, logger }); }
      catch (error) { logger?.warn?.(`AMA closure-lag observation failed: ${error.message}`); }
      clearDaemonMergePark({ rootDir, repo: repoPath, prNumber });
      clearDaemonRouteDisagreement(rootDir, { repo: repoPath, prNumber });
    } else {
      recordDaemonMergePark({
        rootDir,
        repo: repoPath,
        prNumber,
        headSha: gateSnapshot?.reviewedHeadSha || null,
        reason: daemonCleanMerge.reason || 'failed-closed',
      });
    }
    // The common decision owns handoff after live execution observations.
    // Safety refusals and unreadable evidence cannot be repair shortcuts.
    const hammerRemediableFallback = hasHammerDispatchIntent(shared, {
      repo: repoPath, prNumber, headSha: currentPrHeadSha,
    });
    if (hammerRemediableFallback) {
      clearDaemonMergePark({ rootDir, repo: repoPath, prNumber });
      const fallbackReasons = Array.isArray(daemonCleanMerge.reasons) ? daemonCleanMerge.reasons : [];
      logger?.log?.(JSON.stringify({
        schemaVersion: 1,
        event: 'ama.daemon_clean_fail_closed.hammer_fallback',
        repo: repoPath,
        pr: prNumber,
        headSha: gateSnapshot?.reviewedHeadSha || null,
        reason: daemonCleanMerge.reason,
        reasons: fallbackReasons,
        attempts: daemonCleanMerge.attempts || 0,
        hammerFallback: true,
      }));
      logger?.log?.(
        `[watcher] AMA daemon clean-merge fail-closed on a hammer-remediable gate for ` +
          `${repoPath}#${prNumber}@${daemonHeadShort} (${daemonCleanMerge.reason}` +
          (fallbackReasons.length ? `; gates=${fallbackReasons.join(',')}` : '') +
          `); routing to the capped hammer (re-validates the gate at head + merges ` +
          `under its own lease) instead of parking for manual close`,
      );
      // Fall through to the hammer dispatch below. Do NOT return here.
    } else {
      logger?.log?.(
        `[watcher] AMA daemon deferred ${repoPath}#${prNumber}: ${daemonCleanMerge.waitMessage || daemonCleanMerge.reason}; ` +
          'the shared recovery router will retry or report SEV1 exhaustion',
      );
      // Daemon owns this tick — skip BOTH the hammer dispatch and the merge-agent
      // path. `skipMergeAgent` routes the coexistence decision to `ama-pending`
      // so the watcher returns without dispatching anything.
      const boundedWait = daemonCleanMerge.disposition === DAEMON_MERGE_DISPOSITION.DEFERRED
        && !daemonCleanMerge.reason?.startsWith('fleet-stop-')
        ? await observeWait({ rootDir, repo: repoPath, prNumber, headSha: currentPrHeadSha,
          reason: daemonCleanMerge.waitMessage || daemonCleanMerge.reason, env }) : null;
      return withAmaDispatchMetadata(
        {
          dispatched: false,
          skipMergeAgent: true,
          ...(boundedWait ? { recoveryWait: true, retryAfterMs: boundedWait.retryAfterMs,
            boundedWait, ...(boundedWait.exhausted ? { needsOperator: true } : {}) } : {}),
          reason: `daemon-${daemonCleanMerge.disposition}`,
          daemonCleanMerge,
        },
        { amaEnabled: true },
      );
    }
  }
  if (
    daemonCleanMerge?.disposition === DAEMON_MERGE_DISPOSITION.NOT_TAKEN &&
    (
      PROTECTIVE_PREDECESSOR_HOLD_REASONS.has(daemonCleanMerge.reason) ||
      daemonCleanMerge.reason === 'operator-approval-no-longer-current'
    )
  ) {
    const daemonHeadShort = String(gateSnapshot?.reviewedHeadSha || '').slice(0, 12);
    logger?.warn?.(
      `[watcher] AMA protective predecessor hold for ${repoPath}#${prNumber}` +
        `@${daemonHeadShort}: ${daemonCleanMerge.reason}`,
    );
    if (daemonCleanMerge.reason !== 'operator-approval-no-longer-current') {
      recordDaemonMergePark({
        rootDir,
        repo: repoPath,
        prNumber,
        headSha: gateSnapshot?.reviewedHeadSha || null,
        reason: daemonCleanMerge.reason,
      });
    }
    return {
      dispatched: false,
      skipMergeAgent: true,
      reason: daemonCleanMerge.reason,
      daemonCleanMerge,
    };
  }

  const [owner, name] = repoPath.split('/');
  if (['review', 'remediate', 'wait-for-CI'].includes(shared.decision.action)) {
    const decision = shared.decision;
    let boundedWait = null;
    try {
      boundedWait = await observeWait({ rootDir, repo: repoPath, prNumber, headSha: decision.head,
        env, now: now(), startedAt: Date.parse(decision.deadline?.anchoredAt),
        reason: `action=${decision.action} actor=${decision.actor} reason=${decision.reason} head=${decision.head}` });
    } catch (error) { logger?.warn?.(`[watcher] next-action observation failed: ${error.message}`); }
    return withAmaDispatchMetadata({ dispatched: false, skipMergeAgent: true, recoveryWait: true,
      reason: decision.action === 'review' ? 'handed-to-review' : decision.action === 'remediate'
        ? hasLiveRemediationJob(shared.snapshot) ? 'active-remediation-job' : 'remediation-job-missing'
        : 'pending-required-checks', nextAction: decision,
      boundedWait, retryAfterMs: boundedWait?.retryAfterMs || 30_000 }, { amaEnabled: true });
  }
  // Final-push provenance was collected into the shared snapshot above. Its
  // successor and pending-check ownership cannot be selected a second time.
  const commentOnlyFinalRoundProven = Boolean(remediationHandoff);
  const commentOnlyFinalRoundAwaitingCi = shared.decision.action === 'wait-for-CI'
    && shared.decision.actor === 'ci';
  const shouldLookupMergedProtectiveDependents =
    reviewCycleExhausted ||
    hamTerminalRemediationValidated ||
    Number(reviewState.blockingFindingCount || 0) > 0 ||
    Number(reviewState.nonBlockingFindingCount || 0) > 0;
  const mergedProtectiveDependents = shouldLookupMergedProtectiveDependents
    ? await fetchMergedProtectiveDependentsImpl({
        repo: repoPath,
        prNumber,
        execFileImpl: execFileAsync,
        logger,
      })
    : [];

  const dispatchContext = {
    orphanRecovery,
    automatedRecovery,
    daemonFailureReasons: Array.isArray(daemonCleanMerge?.reasons)
      ? daemonCleanMerge.reasons
      : [daemonCleanMerge?.reason].filter(Boolean),
    rootDir,
    repo: repoPath,
    prUrl: `https://github.com/${owner}/${name}/pull/${prNumber}`,
    reviewedSha: reviewState.headSha,
    targetRemediationSha: currentPrHeadSha || reviewState.headSha,
    dispatchRecordHeadSha: closerOnlyHeadDelta ? currentPrHeadSha : reviewState.headSha,
    closerOnlyHeadDelta,
    closerAuthoredStale,
    dispatchReason: reviewCycleExhausted || commentOnlyFinalRoundProven ? 'exhausted-final-hammer' : null,
    reviewCycleCapReached,
    reviewCycleCap: reviewCycleCapReached ? dispatchJob?.reviewCycleCap ?? null : null,
    reviewCycleHistory: reviewCycleCapReached && Array.isArray(dispatchJob?.reviewCycleHistory)
      ? dispatchJob.reviewCycleHistory : [],
    ciBlockedHammerOwner,
    ciFailedChecks: ciBlockedHammerOwner && Array.isArray(dispatchJob?.ciFailedChecks)
      ? dispatchJob.ciFailedChecks : derivedCiFailedChecks,
    allowStaleReviewHeadHammerResume,
    liveHeadCloserAuthored,
    baseBranch: candidate?.baseBranch || candidate?.baseRefName || null,
    defaultBranch: candidate?.defaultBranch || null,
    riskClass: reviewState.riskClass,
    requiredGateContext,
    reviewedBy: reviewStateRow?.reviewer_login || '',
    reviewer: reviewStateRow?.reviewer || '',
    authoritativeReviewerLogins,
    dismissStaleRequestChangesOnResolved: isDismissStaleRequestChangesOnResolvedEnabled({ env, logger }),
    mergedProtectiveDependents,
    parentSession: process.env.HQ_PARENT_SESSION || 'session:unknown:airlock+watcher',
    dispatchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    orchestrationMode,
  };

  // HAMASYNC-01: the closer arguments are built once so the inline and the
  // background paths hand `maybeDispatchAmaCloser` byte-identical inputs.
  const closerArgs = {
    sharedNextAction: shared,
    reviewState,
    prMetadata,
    cfg,
    options: {
      env: process.env,
      ...(refreshedPrimaryChange ? { primaryChange: refreshedPrimaryChange } : {}),
      ...(nonReviewableHeadDeltaEvidence
        ? { nonReviewableHeadDelta: nonReviewableHeadDeltaEvidence }
        : {}),
      ...(hamTerminalRemediationEvidenceOptions || {}),
      adversarialMergeRequested: adversarialMergeRequestedEvent
        ? {
            applied: true,
            observedRevisionRef:
              adversarialMergeRequestedEvent.headSha ||
              adversarialMergeRequestedEvent.head_sha ||
              null,
            actor: adversarialMergeRequestedEvent.actor || null,
            eventId:
              adversarialMergeRequestedEvent.id ||
              adversarialMergeRequestedEvent.nodeId ||
              null,
            observedAt:
              adversarialMergeRequestedEvent.createdAt ||
              adversarialMergeRequestedEvent.created_at ||
              null,
          }
        : null,
    },
    dispatchContext,
    logger,
  };
  const recordHammerLaunch = (launchResult) => {
    if (hammerResume && launchResult?.dispatched === true) {
      try {
        settleHammerResume({ hqRoot: resolveHqRoot(env), repo: repoPath, prNumber, resume: hammerResume,
          reason: 'dispatched', now: new Date(now()).toISOString(),
          launchRequestId: launchResult.launchRequestId || launchResult.dispatchId || null });
      } catch (error) { logger?.warn?.(`[watcher] hammer resume audit failed: ${error.message}`); }
    }
    if (!reviewCycleExhausted || launchResult?.dispatched !== true) return;
    const postedMs = Date.parse(reviewStateRow?.posted_at || '');
    const confirmedMs = now();
    if (!Number.isFinite(postedMs) || !Number.isFinite(confirmedMs) || confirmedMs < postedMs) return;
    // Measure at the successful hq dispatch acknowledgement, not submission.
    // A background result is logged here when it settles, never again when the
    // next tick consumes it. Telemetry cannot change dispatch authority.
    try {
      recordFinalReviewHammerLatency(confirmedMs - postedMs, confirmedMs);
      logger?.log?.(JSON.stringify({
        event: 'ama.final_review_to_hammer_launch', repo: repoPath, prNumber,
        headSha: dispatchContext.targetRemediationSha || reviewState?.headSha || dispatchContext.reviewedSha || null,
        reviewedHeadSha: reviewState?.headSha ?? null,
        postedAt: reviewStateRow.posted_at, launchConfirmedAt: new Date(confirmedMs).toISOString(),
        latencyMs: confirmedMs - postedMs,
        launchRequestId: launchResult.launchRequestId || launchResult.dispatchId || null,
      }));
    } catch { /* A telemetry sink failure must not turn a successful launch into a refusal. */ }
  };
  throwIfAborted(signal);
  // HAMASYNC-01: in background mode a PR@head alternates between submitting a
  // closer run and applying that run's settled outcome. The outcome goes through
  // the same result handling as an inline call below, so a terminal rejection
  // from the closer's own gates (retry cap, ineligibility) still reaches the
  // merge-agent fallback and alerting, one tick later.
  let backgroundSettled = null;
  if (!orphanRecovery && resolveAmaHammerDispatchModeImpl({ cfg: loadedConfig, logger }) === 'background') {
    const backgroundKey = amaHammerBackgroundKey({
      repo: repoPath,
      prNumber,
      headSha: dispatchContext.targetRemediationSha,
    });
    const backgroundQueue = amaHammerBackgroundQueueImpl({
      maxConcurrent: cfg.amaCloserMaxConcurrentLaunches,
    });
    backgroundSettled = backgroundQueue.takeSettled?.(backgroundKey) || null;
    // A settled classification wait is not a refusal. Submit fresh work in
    // this pass instead of spending a whole pass consuming the wait.
    if (backgroundSettled?.ok && ['operator-label-classification-pending',
      'background-pr-state-unavailable', 'deferred-by-drain'].includes(backgroundSettled.result?.reason)) {
      // Preserve the completed attempt's wait debt before starting its retry.
      // A new background submission must not hide the settled blocker.
      if (finalRoundSink?.value) await observeWait({ rootDir, repo: repoPath, prNumber,
        headSha: dispatchContext.targetRemediationSha,
        reason: backgroundSettled.result.reasons?.join(', ') || backgroundSettled.result.reason, env });
      backgroundSettled = null;
    }
    // A scoped request must observe the closer's gates before taking ownership.
    // Skipping a fresh run here would erase a consumed safety refusal on the
    // next tick, letting the same label bypass risk policy or a dispatch cap.
    if (!backgroundSettled) {
      let mergeabilitySamples = 0;
      let mergeabilityElapsedMs = 0;
      const submission = backgroundQueue.submit({
        key: backgroundKey,
        sharedNextAction: shared,
        timeoutMs: Number(cfg.dispatchTimeoutMs) > 0 ? loadAwareTimeoutMs(cfg.dispatchTimeoutMs) : undefined,
        pendingDispatch: { rootDir, repo: repoPath, prNumber, headSha: dispatchContext.targetRemediationSha },
        // Detached from this step's deadline on purpose: the whole point is that
        // the posted-review phase stops waiting. `hq dispatch` stays bounded by the
        // closer's own dispatch timeout (resolveAmaDispatchTimeoutMs). The
        // signal belongs to this queue entry, not the step deadline.
        run: async (backgroundSignal, updateSharedNextAction) => {
          // A saturated queue can hold this closure across several watcher
          // ticks. Recheck live state at launch, after it gets a queue slot.
          let live;
          try {
            for (let attempt = 0; ; attempt++) {
              throwIfAborted(backgroundSignal);
              try {
                live = await fetchCurrentPrStateImpl({ repo: repoPath, prNumber, logger });
                break;
              } catch (error) {
                if (attempt >= 2 || !isOrphanRecoveryWait(error)) throw error;
                await abortableSleep((attempt + 1) * 1000, backgroundSignal);
              }
            }
          } catch (err) {
            logger?.warn?.(
              `[watcher] AMA hammer background pre-dispatch PR probe failed for ${backgroundKey}: ` +
                `${err?.message || err}`,
            );
            return { dispatched: false, reason: 'background-pr-state-unavailable' };
          }
          mergeabilitySamples = 1;
          const mergeabilityStartedAt = Date.now();
          if (normalizeGithubMergeability(live || {}) === 'UNKNOWN') {
            await resolveMergeabilityWithSampling(live, async () => {
              throwIfAborted(backgroundSignal);
              mergeabilitySamples += 1;
              const sampled = await fetchCurrentPrStateImpl({ repo: repoPath, prNumber, logger });
              if (sampled && typeof sampled === 'object') live = sampled;
              return sampled;
            }, {
              attempts: MERGEABILITY_SAMPLE_ATTEMPTS,
              delayMs: mergeabilitySampleDelayMs,
              sleepImpl: (ms) => abortableSleep(ms, backgroundSignal),
              // Stop sampling immediately on a safety refusal. Check it below
              // before allowing any dispatch, including after the final read.
              classify: (state) => state?.state !== 'OPEN'
                || state?.headSha !== dispatchContext.targetRemediationSha || state?.isDraft
                ? 'CONFLICTING' : normalizeGithubMergeability(state),
            });
            throwIfAborted(backgroundSignal);
          }
          mergeabilityElapsedMs = Date.now() - mergeabilityStartedAt;
          // COMMENTCLOSE-01: name what blocked. A draft or an unmergeable PR is not
          // a state change; agent-os#7311 (a worker-opened draft) spent four hammer
          // attempts reported only as `background-pr-state-changed`.
          const launchShared = revalidateClosurePr(shared, live, {
            checksConclusion: Array.isArray(live?.statusCheckRollup)
              ? summarizeChecksConclusion(live.statusCheckRollup, { env, cfg }) : undefined,
          });
          updateSharedNextAction(launchShared);
          const changedDecision = { nextActionShared: launchShared };
          if (live?.state !== 'OPEN' || live?.headSha !== dispatchContext.targetRemediationSha) {
            return { dispatched: false, reason: 'background-pr-state-changed', ...changedDecision };
          }
          if (live?.isDraft) return { dispatched: false, reason: 'background-pr-draft', ...changedDecision };
          const launchMismatch = hammerDispatchMismatch(shared, launchShared,
            { repo: repoPath, prNumber, headSha: live.headSha });
          if (launchMismatch || !hasHammerDispatchIntent(launchShared, { repo: repoPath, prNumber, headSha: live.headSha })) {
            return { ...(launchMismatch
              || { dispatched: false, reason: 'closure-decision-mismatch', ...changedDecision }), retryAfterMs: 30_000 };
          }
          const launched = await maybeDispatchAmaCloserImpl({ ...closerArgs, sharedNextAction: launchShared, signal: backgroundSignal,
            operatorLabelClassificationRetryDelaysMs: [20_000, 40_000] });
          const settledShared = launched?.nextActionShared || readClosureNextAction(launched) || launchShared;
          updateSharedNextAction(settledShared);
          return { ...launched, nextActionShared: settledShared };
        },
        onSettled: ({ ok, result: settledResult, error, elapsedMs }) => {
          if (ok && hammerWakeSink?.value && hammerWakeSink.closerInvoked) {
            try { amaDispatchCloser.settleRefusedHammerWake({ ...hammerWakeSink.value, result: settledResult }); }
            catch (error) { logger?.warn?.(`[watcher] refused hammer wake reconciliation failed: ${error.message}`); }
          }
          if (ok) recordHammerLaunch(settledResult);
          if (ok && settledResult?.closureBlocker) {
            logger?.info?.(JSON.stringify({ event: 'ama.closure_blocker', repo: repoPath, pr: prNumber,
              reason: settledResult.closureBlocker }));
          }
          logger?.log?.(
            `[watcher] AMA hammer background dispatch settled for ${backgroundKey}: ` +
              (ok
                ? `dispatched=${Boolean(settledResult?.dispatched)} reason=${settledResult?.reason || 'none'}` +
                  formatAmaResultReasons(settledResult)
                : `error=${error?.message || error}`) +
              ` elapsed_ms=${elapsedMs} mergeability_samples=${mergeabilitySamples} mergeability_elapsed_ms=${mergeabilityElapsedMs}`,
          );
        },
      });
      logger?.log?.(
        `[watcher] AMA hammer dispatch ${submission.state} in background for ${backgroundKey}; ` +
          `posted-review phase continues`,
      );
      return withAmaDispatchMetadata(
        {
          dispatched: false,
          skipMergeAgent: true,
          reason: AMA_HAMMER_BACKGROUND_REASON,
          ...amaHammerBackgroundProgress(submission, now()),
          backgroundDispatch: { key: backgroundKey, state: submission.state },
          ...(hamTerminalRemediationValidated ? { hamTerminalRemediationValidated: true } : {}),
        },
        { amaEnabled: true },
      );
    }
  }

  let result;
  try {
    throwIfAborted(signal);
    if (backgroundSettled) {
      logger?.log?.(
        `[watcher] AMA hammer background outcome applied for ${repoPath}#${prNumber}: ` +
          (backgroundSettled.ok
            ? `dispatched=${Boolean(backgroundSettled.result?.dispatched)} ` +
              `reason=${backgroundSettled.result?.reason || 'none'}` +
              formatAmaResultReasons(backgroundSettled.result)
            : `error=${backgroundSettled.error?.message || backgroundSettled.error}`),
      );
      if (!backgroundSettled.ok) {
        throw backgroundSettled.error instanceof Error
          ? backgroundSettled.error
          : new Error(String(backgroundSettled.error || 'background AMA dispatch failed'));
      }
      result = backgroundSettled.result;
      if (
        result?.reason === 'background-pr-state-changed'
      ) {
        result = { ...result, skipMergeAgent: true, retryAfterMs: 30_000 };
      } else if (result?.reason === 'background-pr-draft') {
        // Nothing in the pipeline marks a PR ready for review, so a draft waits
        // for a person: route it to the operator-blocked lane, named as a draft.
        result = { ...result, skipMergeAgent: true, needsOperator: true, operatorReason: 'pr-is-draft' };
      }
    } else {
      const stopTracking = trackCoexistenceOperation(operationTracker, 'ama-hammer-dispatch');
      try {
        result = await maybeDispatchAmaCloserImpl({ ...closerArgs, signal });
        recordHammerLaunch(result);
      } finally {
        stopTracking();
      }
    }
    throwIfAborted(signal);
  } catch (err) {
    throwIfAborted(signal);
    if (err?.code === 'AMA_COEXISTENCE_OPERATION_TIMEOUT') {
      throw err;
    }
    logger?.warn?.(`[watcher] AMA dispatch failed: ${err?.message || err}`);
    // Carry the ground-truth HAM proof into the failure result. AMA can fail to
    // dispatch its own closer for reasons unrelated to the remediation's validity
    // -- agent-os#6059 died on `refusing to reuse terminal reviewer_passes row
    // (closer, failed)` AFTER the hammer had landed a correct, fully-certified
    // remediation. Without this the merge-agent fallback sees no verdict
    // (auto-refresh is suppressed for a closer-authored head move), returns
    // `skip-no-verdict`, and the PR stalls until an operator hand-merges: 12.7h
    // on #6059.
    return withAmaDispatchMetadata(
      {
        dispatched: false,
        reason: 'ama-dispatch-failed',
        // Only present when the proof validated, so every existing result-shape
        // assertion keeps its exact object.
        ...(hamTerminalRemediationValidated ? { hamTerminalRemediationValidated: true } : {}),
      },
      { amaEnabled: Boolean(cfg?.enabled) },
    );
  }
  if (result?.needsOperator && result?.reason === 'primary-change-repair-required') {
    try {
      await observeWait({ rootDir, repo: repoPath, prNumber, headSha: currentPrHeadSha,
        immediate: true, env, reason: `${result.reason}: ${result.missingEvidence?.path || 'unknown file'}: ${result.missingEvidence?.summary || result.reasons?.join(', ')}` });
    } catch (error) { logger?.warn?.(`[watcher] primary-change page delivery failed: ${error.message}`); }
    if (closureOwnerSink) closureOwnerSink.value = { owner: 'page', reason: result.reason };
    return withAmaDispatchMetadata(result, { amaEnabled: true });
  }

  // AMA-06N — expose `amaEnabled` so the watcher's coexistence
  // decision (downstream of this helper) can branch on it. The
  // upstream code paths (`cfg-load-failed`, `ama-disabled`) already
  // include the flag; this wraps the maybeDispatchAmaCloser return.
  return withAmaDispatchMetadata(
    {
      ...result,
      ...(result?.reason === 'not-eligible' && !result?.needsOperator
        ? { retryAfterMs: 30_000,
            ...(commentOnlyFinalRoundAwaitingCi ? { commentOnlyFinalRoundAwaitingCi: true } : {}) }
        : {}),
      ...(hamTerminalRemediationValidated ? { hamTerminalRemediationValidated: true } : {}),
    },
    { amaEnabled: true },
  );
}

export function resolveMergeAgentCoexistenceForWatcher(options) {
  return withClosureEvaluationReadCache(() => resolveMergeAgentCoexistenceWithinEvaluation(options));
}

// Diagnose impossible ownership through the existing durable closure wait.
// This never authorizes a review or a merge, and must run before the watchdog
// can turn a refused review into another request/backoff cycle.
async function observeReviewAdmissionContract({ rootDir, repo, prNumber, headSha, reviewStateRow,
  result, logger, now, env, observeWaitImpl }) {
  const decision = result?.nextAction;
  if (decision?.action !== 'review' || decision.actor !== 'reviewer' || decision.head !== headSha
    || decision.queue?.intent === 'owned'
    || reviewCeilingOwner({ row: reviewStateRow, headSha }) !== 'hammer') return null;
  const contractViolation = { actor: decision.actor, headSha, admissionReason: 'review-ceiling' };
  const boundedWait = await observeWaitImpl({ rootDir, repo, prNumber, headSha, now, env,
    waitClass: 'actor-admission', reason: `next-action-contract-violation: actor=${decision.actor} head=${headSha} admission=review-ceiling` });
  if (boundedWait.firstObserved) logger?.warn?.(JSON.stringify({
    event: 'ama.next_action.contract_violation', repo, prNumber, ...contractViolation,
  }));
  const amaClosureResult = { ...result, reason: 'next-action-contract-violation',
    closureBlocker: 'next-action-contract-violation', contractViolation, boundedWait,
    recoveryWait: true, skipMergeAgent: true, retryAfterMs: boundedWait.retryAfterMs,
    ...(boundedWait.exhausted ? { needsOperator: true } : {}) };
  return { outcome: boundedWait.exhausted ? 'await-operator' : 'ama-pending',
    urgent: !boundedWait.exhausted, amaClosureResult };
}

async function resolveMergeAgentCoexistenceWithinEvaluation({
  rootDir = ROOT,
  reviewStateRow,
  reviewStateDb = null,
  dispatchJob,
  candidate,
  labelNames,
  operatorApprovalEvent,
  mergeAgentRequestEvent,
  adversarialMergeRequestedEvent,
  repoPath,
  prNumber,
  currentRevisionRef,
  domainId = 'code-pr',
  logger,
  maybeDispatchAmaClosureForImpl = maybeDispatchAmaClosureFor,
  recoverAmaAutomationImpl = recoverAmaAutomation,
  amaHammerBackgroundQueueImpl = amaHammerBackgroundQueue,
  recoveryOptions = {},
  recoverOrphanImpl = recoverOrphan,
  orphanOptions = {},
  signal = null,
  operationTimeoutMs = loadAwareTimeoutMs(DEFAULT_AMA_CLOSURE_OPERATION_TIMEOUT_MS),
  operationTracker = null,
  passSnapshot = null,
}) {
  throwIfAborted(signal);
  // BUG-1 dispatch-time terminal guard. `candidate` is the live PR read for
  // this tick (fetchMergeAgentCandidate). An already-MERGED PR needs no
  // AMA/merge-agent action. Without this, it flows into maybeDispatchAmaClosureFor
  // → the daemon clean-merge attempt fails closed (cannot merge an already-merged
  // PR) → `skipMergeAgent` → outcome `ama-pending`, so the watcher logs
  // "AMA hammer route retained ownership ... daemon-failed-closed" every tick
  // forever (observed on merged #639/#640/#642/#643/#3945). Drop ownership.
  // A live CLOSED read also suppresses dispatch on this tick. Reopened PRs
  // return through the next live OPEN candidate; the claim CAS is unchanged.
  const liveMerged =
    candidate?.merged === true || String(candidate?.prState || '').toLowerCase() === 'merged';
  if (liveMerged || String(candidate?.prState || '').toLowerCase() === 'closed') {
    try { await observeClosureLag({ rootDir, repo: repoPath, prNumber, merged: liveMerged,
      closed: !liveMerged, mergedAt: candidate?.mergedAt, logger }); }
    catch (error) { logger?.warn?.(`AMA closure-lag observation failed: ${error.message}`); }
    return { outcome: 'pr-terminal', terminalReason: liveMerged ? 'merged' : 'closed' };
  }
  if (candidate?.stackedBaseHold) {
    return { outcome: candidate.stackedBaseHold.needsOperator ? 'await-operator' : 'ama-pending',
      amaClosureResult: candidate.stackedBaseHold };
  }
  let amaClosureResult;
  try {
    amaClosureResult = await maybeDispatchAmaClosureForImpl({
      rootDir,
      reviewStateRow,
      reviewStateDb,
      dispatchJob,
      candidate,
      labelNames,
      operatorApprovalEvent,
      // Deliverable 1 — thread the operator merge-agent-requested label event into
      // the closure dispatch so the daemon path can substitute it for an unresolved
      // worker identity (head-scoped) instead of parking.
      mergeAgentRequestEvent,
      adversarialMergeRequestedEvent,
      repoPath,
      prNumber,
      currentRevisionRef,
      domainId,
      logger,
      signal,
      operationTimeoutMs,
      operationTracker,
      // NXA-01 pass snapshot, observational only (NXA-02 shadow).
      ...(passSnapshot ? { passSnapshot } : {}),
    });
  } catch (err) {
    throwIfAborted(signal);
    if (err?.code !== 'AMA_COEXISTENCE_OPERATION_TIMEOUT') throw err;
    const operation = err.operation || operationTracker?.current || 'unknown';
    logger?.warn?.(
      `[watcher] AMA/merge-agent coexistence internal timeout for ${repoPath}#${prNumber}: ` +
        `operation=${operation} timeout_ms=${err.timeoutMs || operationTimeoutMs || 'unknown'}. ` +
        'Skipping merge action for this PR on this tick so the posted-review phase can continue.',
    );
    amaClosureResult = withAmaDispatchMetadata({
      dispatched: false, skipMergeAgent: true,
      reason: 'ama-coexistence-operation-timeout',
      namedReason: `ama-coexistence-operation-timeout:${operation}`,
      timedOutOperation: operation,
      timeoutMs: err.timeoutMs || operationTimeoutMs || null,
    }, { amaEnabled: true });
  }
  // Partial executor results still project the shared policy. Missing decision
  // evidence is an owned refresh/reconciliation, never proof of launch absence.
  if (amaClosureResult?.amaEnabled && !amaClosureResult.nextAction) {
    const head = currentRevisionRef || candidate?.headSha || dispatchJob?.headSha || null;
    let anchor = reviewStateRow?.posted_at || reviewStateRow?.reviewed_at || null;
    try {
      const wait = await observeClosureWait({ rootDir, repo: repoPath, prNumber, headSha: head, anchorOnly: true });
      anchor ||= new Date(wait.startedAt).toISOString();
    } catch { /* Diagnostic persistence cannot refuse a workflow. */ }
    const snapshot = deriveNextActionSnapshot({ base: passSnapshot,
      subjectKey: `${repoPath}#${prNumber}`, head, observedAt: new Date().toISOString(),
      anchors: { firstActionableAt: anchor }, observations: {
        pr: { headSha: head, state: candidate?.prState, isDraft: candidate?.isDraft, labels: labelNames },
      } });
    const shared = Object.freeze({ snapshot, decision: nextAction(snapshot) });
    amaClosureResult = bindClosureNextAction({ ...amaClosureResult, nextAction: shared.decision,
      closureOwner: closureOwnerFromDecision(shared.decision) }, shared);
  }
  throwIfAborted(signal);
  logger?.info?.(JSON.stringify({ event: 'ama.closure_blocker', repo: repoPath, pr: prNumber,
    reason: amaClosureResult?.dispatched ? 'hammer-running'
      : amaClosureResult?.closureBlocker || amaClosureResult?.daemonCleanMerge?.reason || amaClosureResult?.reason || 'closure-pending' }));
  if (amaClosureResult?.dispatched) {
    return { outcome: 'ama-dispatched', amaClosureResult };
  }
  // A merge completed during closure makes this tick's OPEN candidate stale.
  // Settle before the ownerless watchdog can retain or redrive that PR.
  if (amaClosureResult?.nextAction?.action === 'done') {
    return { outcome: 'pr-terminal', terminalReason: amaClosureResult.nextAction.reason, amaClosureResult };
  }
  if (amaClosureResult?.reason === 'daemon-merged') {
    return amaClosureResult.daemonCleanMerge?.remoteMergedConfirmed === true
      ? { outcome: 'pr-terminal', terminalReason: 'merged', amaClosureResult }
      : { outcome: 'ama-pending', amaClosureResult };
  }
  const admissionDisagreement = await observeReviewAdmissionContract({ rootDir, repo: repoPath, prNumber,
    headSha: candidate?.headSha || currentRevisionRef, reviewStateRow, result: amaClosureResult, logger,
    now: typeof orphanOptions.now === 'number' ? orphanOptions.now
      : orphanOptions.now ? Date.parse(orphanOptions.now) : Date.now(), env: orphanOptions.env || process.env,
    observeWaitImpl: orphanOptions.observeClosureWaitImpl || observeClosureWait });
  if (admissionDisagreement) return admissionDisagreement;
  const mergeAgentRequestedScoped = !labelNames?.some((label) =>
    [...OPERATOR_HOLD_LABELS, 'adversarial-merge-blocked',
      'merge-agent-stuck', 'duplicate-family-hold'].includes(label))
    && !reviewStateRow?.remediation_pending
    && labelNames?.includes('merge-agent-requested')
    && isMergeAgentRequestedScoped(mergeAgentRequestEvent, {
      headSha: currentRevisionRef || candidate?.headSha || dispatchJob?.headSha || null,
      prUpdatedAt: candidate?.prUpdatedAt || dispatchJob?.prUpdatedAt || null,
    });
  // HAMATTEST-03: execute a head-bound review decision before a closure wait
  // can hide it. The watchdog still proves absence of live/uncertain owners and
  // reserves the existing once-per-head request; this grants no merge authority.
  const recoverOwnerless = async () => {
    const orphan = await recoverOrphanImpl({
      rootDir, repo: repoPath, prNumber,
      headSha: candidate?.headSha || currentRevisionRef || dispatchJob?.headSha || '',
      candidate, labels: labelNames, result: amaClosureResult, reviewStateRow, dispatchJob, logger, signal,
      dispatchHammer: (orphanRecovery) => maybeDispatchAmaClosureForImpl({
        rootDir, reviewStateRow, reviewStateDb, dispatchJob, candidate, labelNames,
        operatorApprovalEvent, mergeAgentRequestEvent, adversarialMergeRequestedEvent,
        repoPath, prNumber, currentRevisionRef, domainId, logger, signal,
        operationTimeoutMs, operationTracker, orphanRecovery,
        priorDaemonCleanMerge: amaClosureResult?.daemonCleanMerge,
      }),
      ownershipOperation: (fn) => runTimedCoexistenceOperation(
        'orphan-ownership', fn, { timeoutMs: operationTimeoutMs, parentSignal: signal,
          operationTracker, logger, repoPath, prNumber }),
      ownershipTimeoutMs: operationTimeoutMs,
      onOwnershipObserved: owner => {
        const observed = observeClosureOwnership(readClosureNextAction(amaClosureResult), owner, passSnapshot);
        if (observed) {
          Object.assign(amaClosureResult, { nextAction: observed.decision,
            closureOwner: closureOwnerFromDecision(observed.decision) });
          bindClosureNextAction(amaClosureResult, observed);
        }
      },
      ...orphanOptions,
    });
    if (orphan?.amaClosureResult?.reviewRequest?.triggered === true) {
      return { ...orphan, amaClosureResult: { ...orphan.amaClosureResult,
        reason: 'exact-head-review-queued', closureOwner: amaClosureResult?.nextAction
          ? closureOwnerFromDecision(amaClosureResult.nextAction) : { owner: 'review', reason: 'exact-head-review' } } };
    }
    return orphan;
  };
  // Ordinary scoped operator requests have an executor below. Recovery expiry
  // must still dispatch or report its blocker; all safety/lease gates apply.
  if ((!mergeAgentRequestedScoped || isClosureRecoveryDecision(amaClosureResult?.nextAction))
    && overdueNextAction(amaClosureResult?.nextAction, candidate?.headSha || currentRevisionRef,
    orphanOptions.now, orphanOptions.env)) {
    const orphan = await recoverOwnerless();
    if (orphan) return orphan;
    // A proven live owner ended the overdue probe. Do not enter another
    // recovery route after that observation replaced the shared generation.
    return { outcome: 'ama-pending', amaClosureResult };
  }
  if (!mergeAgentRequestedScoped && hasExactHeadReviewDecision(amaClosureResult, candidate?.headSha || currentRevisionRef, reviewStateRow)
    && !isSafetyRecoveryHold(amaClosureResult)) {
    const orphan = await recoverOwnerless();
    if (orphan) return orphan;
    return { outcome: 'ama-pending', amaClosureResult };
  }
  if (['remediate', 'wait-for-CI'].includes(amaClosureResult?.nextAction?.action)) {
    return { outcome: 'ama-pending', amaClosureResult };
  }
  if (amaClosureResult?.nextAction?.action === 'operator-hold') {
    return { outcome: 'await-operator', amaClosureResult };
  }
  if (amaClosureResult?.boundedWait) {
    // This route already owns its bounded wait and its one page. Do not let
    // orphan/recovery accounting create a second owner or a second alert.
    return { outcome: amaClosureResult.nextAction?.action === 'operator-hold' ? 'await-operator' : 'ama-pending',
      urgent: !amaClosureResult.boundedWait.exhausted, amaClosureResult };
  }
  const amaEnabled = Boolean(amaClosureResult?.amaEnabled);
  const amaClosureEligibilityMiss = amaClosureResult?.eligibilityRejected === true;
  const safetyHold = isSafetyRecoveryHold(amaClosureResult);
  // The scoped operator lane is an executor of the selected repair workflow.
  // Identity, ownership and physical safety checks still apply; reason text
  // cannot turn a recovery observation into dispatch authority.
  const amaClosureOperatorPreemptable = amaClosureResult?.primaryChangeRepair === true
    && hasHammerDispatchIntent(readClosureNextAction(amaClosureResult), {
      repo: repoPath, prNumber,
      headSha: currentRevisionRef || candidate?.headSha || dispatchJob?.headSha,
    });
  // Scan leases only before taking over a settled primary-change refusal.
  // Terminal results and other safety holds keep their normal recovery routing.
  const liveLease = amaEnabled && mergeAgentRequestedScoped && amaClosureOperatorPreemptable
    && findLiveAmaCloserLease(rootDir, { repo: repoPath, prNumber });
  const amaCloserLeaseHeld = Boolean(liveLease && isHeldAmaCloserLease(rootDir, {
    repo: repoPath, prNumber, headSha: liveLease.headSha,
  }));
  const coexistence = decideMergeAgentCoexistence({
    amaEnabled,
    amaClosureDispatched: false,
    amaClosurePending: Boolean(amaClosureResult?.skipMergeAgent) || safetyHold
      || ['owned', 'reconcile', 'observe'].includes(amaClosureResult?.nextAction?.queue?.intent),
    amaCloserLeaseHeld,
    amaClosureOperatorPreemptable,
    amaClosureEligibilityMiss,
    amaClosureRecoverableFailure: amaEnabled && !amaClosureResult?.skipMergeAgent
      && !safetyHold && !amaClosureEligibilityMiss,
    mergeAgentRequestedScoped,
  });

  if (amaCloserLeaseHeld && mergeAgentRequestedScoped) return { outcome: 'ama-pending', amaClosureResult, coexistence };
  if (coexistence.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK
    && amaClosureOperatorPreemptable) {
    amaHammerBackgroundQueueImpl().abort?.(amaHammerBackgroundKey({
      repo: repoPath, prNumber,
      headSha: currentRevisionRef || candidate?.headSha || dispatchJob?.headSha,
    }));
    logger?.log?.(JSON.stringify({ event: 'ama.primary_change.operator_fallback',
      repo: repoPath, pr: prNumber, headSha: currentRevisionRef || candidate?.headSha,
      actor: mergeAgentRequestEvent.actor, eventId: mergeAgentRequestEvent.id,
      nextAction: amaClosureResult.nextAction }));
    return { outcome: 'dispatch-merge-agent', amaClosureResult, coexistence,
      dispatchEnv: mergeAgentDispatchEnvForAction(coexistence.action) };
  }
  if (!mergeAgentRequestedScoped) {
    const orphan = await recoverOwnerless();
    if (orphan) return orphan;
  }
  if (isOrphanRecoveryWait(amaClosureResult)) return { outcome: 'ama-pending', amaClosureResult };
  if (amaClosureResult?.commentOnlyFinalRoundAwaitingCi === true) {
    logger?.log?.(`[watcher] AMA holding ${repoPath}#${prNumber} for PR-head CI on a proven comment-only final-round head; not counted toward the retain-loop cap`);
    return { outcome: 'ama-pending', amaClosureResult };
  }
  if (amaClosureResult?.amaEnabled && (safetyHold || amaClosureResult?.skipMergeAgent || (amaClosureEligibilityMiss
    && !mergeAgentRequestedScoped))) {
    return recoverAmaAutomationImpl({
      rootDir, repo: repoPath, prNumber,
      headSha: currentRevisionRef || candidate?.headSha || dispatchJob?.headSha || null,
      result: amaClosureResult, reviewStateRow, logger, signal,
      maxAttempts: amaRetainLoopCapFor(dispatchJob?.remediationPlan?.maxRounds),
      dispatchHammer: () => maybeDispatchAmaClosureForImpl({
        rootDir, reviewStateRow, reviewStateDb, dispatchJob, candidate, labelNames,
        operatorApprovalEvent, mergeAgentRequestEvent, adversarialMergeRequestedEvent,
        repoPath, prNumber, currentRevisionRef, domainId, logger, signal,
        operationTimeoutMs, operationTracker, automatedRecovery: true,
        priorDaemonCleanMerge: amaClosureResult?.daemonCleanMerge,
      }),
      ...recoveryOptions,
    });
  }
  if (amaClosureResult?.skipMergeAgent) return { outcome: 'ama-pending', amaClosureResult };

  if (coexistence.action === COEXISTENCE_ACTION.AWAIT_OPERATOR_ACTION) {
    return { outcome: 'await-operator', amaClosureResult, coexistence };
  }
  return {
    outcome: 'dispatch-merge-agent',
    amaClosureResult,
    coexistence,
    dispatchEnv: mergeAgentDispatchEnvForAction(coexistence.action),
  };
}
