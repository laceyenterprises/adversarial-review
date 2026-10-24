import { withPostedReviewReadCache, closePostedReviewReadCache } from './posted-review-read-cache.mjs';
import { loadAwareTimeoutMs } from './load-aware-timeout.mjs';
import { createMergeAgentSnapshotPass, fetchMergeAgentCandidateSnapshot } from './merge-agent-candidate-snapshot.mjs';
import { fromLegacyNoProgressLane, fromLegacyPostedReviewOutcome, noteNextActionLegacyLater,
  shadowNextActionLater } from './pr-next-action-consumer.mjs';
import { summarizeChecksConclusion } from './checks-summary.mjs';
import { resolveSettledReviewVerdict } from './adversarial-gate-status.mjs';
import { resolveHqRoot } from './hq-root.mjs';
import { isGitHubRateLimitError } from './rate-limit-throttle.mjs';
import { primaryChangeReadStatus } from './ama/primary-change-store.mjs';
// ── Posted-review row: per-row post-review dispatch hub ───────────────────────
//
// ARC-18: extracted from watcher.mjs. `handlePostedReviewRow` is the per-row
// dispatch hub run once per queued posted-review handoff; its two private
// helpers (`extractReviewBodyFromRow`, `findLatestPostedReviewBody`, used only
// here) move with it. `runQueuedReviewAdoptionPhase` — the once-per-tick phase
// that runs posted-review merge/autowalk/closeout maintenance before launching
// the next reviewer wave — also lives here; `pollOnce` stays in watcher and
// imports both back. ROOT/execFileAsync are re-derived; WATCHER_PRIMARY_DOMAIN_ID
// is threaded (see the `domainId`/`primaryDomainId` defaults).
import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MERGE_AGENT_REQUESTED_LABEL,
  OPERATOR_APPROVED_LABEL,
  legacyLabelEventFromControlResult,
} from './adapters/operator/github-pr-label-controls/index.mjs';
import { reviewBodyHasScopeViolationFinding } from './additive-only-scope.mjs';
import { deliverAlert as defaultDeliverAlert } from './alert-delivery.mjs';
import { finalReviewHammerLatencySummary, resolveMergeAgentCoexistenceForWatcher } from './ama-closure-orchestration.mjs';
import { createLogChangeGate } from './log-change-gate.mjs';
import { COEXISTENCE_ACTION } from './ama/coexistence.mjs';
import { isSafetyRecoveryHold } from './ama/automated-recovery.mjs';
import { withDaemonMergeReservation } from './ama/merge-lease.mjs';
import {
  clearPendingAmaHammerDispatch,
  clearPendingAmaHammerDispatchForTerminalPr,
  readPendingAmaHammerDispatch,
  isAmaCloserLaunching,
} from './ama-hammer-background-dispatch.mjs';
import {
  namedAmaNoDispatchReason,
  readAmaCloserDispatchRecord,
  isDrainDeferredAmaCloserRecord,
  isFreshDrainDeferredAmaCloserRecord,
  retireAmaCloserDrainHint,
} from './ama/dispatch-closer.mjs';
import {
  HAMMER_EVIDENCE_FAILURES,
  HAMMER_EVIDENCE_RECHECK_INTERVAL_MS,
  HAMMER_STOP_HOLD_REASON,
  readHammerStopForHead,
  readHammerStopHoldForHead,
} from './ama/hammer-stop-hold.mjs';
import { ADVERSARIAL_MERGE_REQUESTED_LABEL } from './ama/labels.mjs';
import { maybeFireFleetWideFalseDeferralAlert } from './fleet-wide-false-deferral-detector.mjs';
import {
  buildMergeAgentDispatchJob,
  dispatchMergeAgentForPR,
  fetchMergeAgentCandidate,
} from './follow-up-merge-agent.mjs';
import { maybeFireMergeAgentStuckAlert } from './merge-agent-stuck-alert.mjs';
import { findLatestFollowUpJob } from './operator-retrigger-helpers.mjs';
import {
  resolveOrchestrationMode,
  retryPendingMergeCloseouts,
  syncPRLifecycle,
  buildTriageSubjectRef,
} from './pr-lifecycle-sync.mjs';
import { retryPendingMergeAgentLifecycleCleanups } from './merge-agent-lifecycle-cleanup.mjs';
import { retryPendingCloserCancels } from './ama/closer-terminal-cancel.mjs';
import { retryPendingDagAutowalkOnMerge } from './dag-autowalk-on-merge.mjs';
import { retryPendingTriageSyncs } from './pending-triage-sync.mjs';
import { reportStalledRetriggerOutcomes, retryPendingRetriggerAckComments } from './follow-up-retrigger-label.mjs';
import { retryPendingRetriggerReviewAckComments } from './follow-up-retrigger-review-label.mjs';
import { db, stmtGetLatestPostedReviewBody, stmtGetReviewRow } from './review-state-db.mjs';
import { rereviewWakeBacklog, sweepRereviewWakeQueue } from './rereview-wake.mjs';
import { ensureReviewStateSchema, openReviewStateDb } from './review-state.mjs';
import {
  evaluateNoProgressLane,
  handlerDecisionFingerprint,
  markNoProgressStalledEventEmitted,
  maybeFireOperatorDecisionRequiredAlert,
  maybeMarkNoProgressStalledEvent,
  promoteStarvedNoProgressLaneLedgers,
  readNoProgressLane,
  clearNoProgressLane,
  PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED,
  PROGRESS_CLASS_SELF_RESOLVING,
  chooseNoProgressMissingInput,
  recordNoProgressLaneRun,
  recordNoProgressLaneSkip,
  resolveNoProgressProducerState,
  subjectProgressFingerprint,
} from './watcher-no-progress-lane.mjs';
import {
  POSTED_REVIEW_CONCURRENCY,
  createPostedReviewFairnessState,
  derivePostedReviewExpensiveStepBudgetMs,
  enforcePostedReviewReviewerPressureBudgetFloor,
  resolvePostedReviewHandlerHeadroomMs,
  resolvePostedReviewHandlerTimeoutMs,
  resolvePostedReviewPhaseBudgetMs,
  resolvePostedReviewReviewerPressurePhaseBudgetMs,
  runPostedReviewHandlersFairly,
  postedReviewHandlerKey,
} from './watcher-poll-fairness.mjs';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function extractReviewBodyFromRow(reviewRow) {
  return reviewRow?.reviewBody ?? reviewRow?.review_body ?? reviewRow?.review_text ?? null;
}

function findLatestPostedReviewBody(rootDir = ROOT, { repo, prNumber } = {}) {
  if (rootDir === ROOT) {
    return stmtGetLatestPostedReviewBody.get(repo, prNumber)?.body_md || null;
  }
  const localDb = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(localDb);
    return localDb.prepare(
      `SELECT body_md
         FROM reviewer_passes
        WHERE repo = ?
          AND pr_number = ?
          AND pass_kind IN ('first-pass', 'rereview')
          AND body_md IS NOT NULL
        ORDER BY attempt_number DESC, pass_id DESC
        LIMIT 1`
    ).get(repo, prNumber)?.body_md || null;
  } finally {
    localDb.close();
  }
}

function readCurrentReviewRow(rootDir = ROOT, { repo, prNumber } = {}) {
  if (rootDir === ROOT) {
    return stmtGetReviewRow.get(repo, prNumber) || null;
  }
  const localDb = openReviewStateDb(rootDir);
  try {
    ensureReviewStateSchema(localDb);
    return localDb.prepare(
      'SELECT * FROM reviewed_prs WHERE repo = ? AND pr_number = ?'
    ).get(repo, prNumber) || null;
  } finally {
    localDb.close();
  }
}

function normalizeReviewStatus(row) {
  return String(row?.review_status || row?.reviewStatus || '').trim().toLowerCase();
}

function isExplicitPendingRereviewRow(row) {
  if (!row) return false;
  if (row.rereview_requested_at || row.rereviewRequestedAt) return true;
  const normalized = String(row.rereview_reason ?? row.rereviewReason ?? '').trim().toLowerCase();
  return Boolean(normalized);
}

const postedReviewRowLogGate = createLogChangeGate();

function isTerminalReviewRow(row) {
  const prState = String(row?.pr_state || row?.prState || '').trim().toLowerCase();
  if (['merged', 'closed'].includes(prState)) return true;
  return Boolean(row?.merged_at || row?.mergedAt || row?.closed_at || row?.closedAt);
}

function gateRelevantReviewRowSnapshot(row) {
  return JSON.stringify({
    reviewStatus: row?.review_status ?? row?.reviewStatus ?? null,
    rereviewRequestedAt: row?.rereview_requested_at ?? row?.rereviewRequestedAt ?? null,
    rereviewReason: row?.rereview_reason ?? row?.rereviewReason ?? null,
    reviewerHeadSha: row?.reviewer_head_sha ?? row?.reviewerHeadSha ?? null,
  });
}

function liveCandidateTerminalReason(candidate) {
  const prState = String(candidate?.prState || '').trim().toLowerCase();
  if (candidate?.merged === true || prState === 'merged') return 'merged';
  if (prState === 'closed') return 'closed';
  return null;
}

// RVHAND-03: an abandoned handler cannot report its own timing.
//
// `runWithDeadline` in the fairness loop stops WAITING on a slow handler and lets
// the tick continue; the handler is never told, so any breakdown it would emit at
// the end is never reached. RVHAND-02 established that these timeouts are always a
// single slow handler (13/13 samples start with the phase idle, 2-233ms in) and
// never phase saturation — but it cannot say WHICH step inside the handler is slow,
// precisely because the handler dies before reporting.
//
// So arm a pending-step warning before each await, then clear it when the step
// finishes. A handler that hangs now names the step it is still waiting on; a
// slow step that eventually completes also records the monotonic elapsed time.
const POSTED_REVIEW_STEP_LOG_THRESHOLD_MS = 5000;

export class PostedReviewStepDeadlineError extends Error {
  constructor(label, key, deadlineMs) {
    super(`posted-review step ${label} exceeded ${deadlineMs}ms for ${key}`);
    this.name = 'PostedReviewStepDeadlineError';
    this.code = 'POSTED_REVIEW_STEP_DEADLINE_EXCEEDED';
    this.label = label;
    this.key = key;
    this.deadlineMs = deadlineMs;
  }
}

function parsePositiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveNominalMergeAgentCoexistenceStepDeadlineMs(
  env = process.env,
  {
    handlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs(env),
    headroomMs = resolvePostedReviewHandlerHeadroomMs(env),
  } = {},
) {
  const derivedDeadlineMs = derivePostedReviewExpensiveStepBudgetMs(handlerTimeoutMs, { headroomMs });
  const overrideDeadlineMs = parsePositiveMs(
    env?.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_DEADLINE_MS,
    derivedDeadlineMs,
  );
  return Math.min(overrideDeadlineMs, derivedDeadlineMs);
}

export function resolveMergeAgentCoexistenceStepDeadlineMs(env = process.env, opts = {}) {
  return loadAwareTimeoutMs(resolveNominalMergeAgentCoexistenceStepDeadlineMs(env, opts));
}

export function resolveMergeAgentCoexistenceOperationTimeoutMs(
  env = process.env,
  { stepDeadlineMs = resolveMergeAgentCoexistenceStepDeadlineMs(env) } = {},
) {
  const resolvedStepDeadlineMs = parsePositiveMs(stepDeadlineMs, resolveMergeAgentCoexistenceStepDeadlineMs(env));
  const headroomMs = Math.min(5_000, Math.max(1, Math.floor(resolvedStepDeadlineMs * 0.2)));
  const derivedTimeoutMs = Math.max(1, Math.min(loadAwareTimeoutMs(60_000), resolvedStepDeadlineMs - headroomMs));
  const overrideTimeoutMs = parsePositiveMs(
    env?.ADVERSARIAL_WATCHER_RESOLVE_MERGE_AGENT_COEXISTENCE_OPERATION_TIMEOUT_MS,
    null,
  );
  return Math.max(1, Math.min(
    overrideTimeoutMs === null ? derivedTimeoutMs : loadAwareTimeoutMs(overrideTimeoutMs),
    Math.max(1, resolvedStepDeadlineMs - 1),
  ));
}

export async function timePostedReviewStep(
  label,
  key,
  logger,
  fn,
  thresholdMs = POSTED_REVIEW_STEP_LOG_THRESHOLD_MS,
  {
    deadlineMs = null,
    abortOnDeadline = true,
    getInFlightOperation = null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = {},
) {
  const startedMs = performance.now();
  let warned = false;
  let timedOut = false;
  const controller = deadlineMs ? new AbortController() : null;
  const timer = setTimeoutFn(() => {
    warned = true;
    logger?.warn?.(
      `[watcher] posted-review step still running for ${key}: ${label} exceeded ${thresholdMs}ms`,
    );
  }, thresholdMs);
  timer.unref?.();
  let deadlineTimer = null;
  const effectiveDeadlineMs = deadlineMs === null || deadlineMs === undefined
    ? null
    : parsePositiveMs(deadlineMs, null);
  const deadline = effectiveDeadlineMs
    ? new Promise((_, reject) => {
        deadlineTimer = setTimeoutFn(() => {
          timedOut = true;
          const err = new PostedReviewStepDeadlineError(label, key, effectiveDeadlineMs);
          if (abortOnDeadline) controller?.abort(err);
          reject(err);
        }, effectiveDeadlineMs);
      })
    : null;
  const work = Promise.resolve()
    .then(() => fn({ signal: controller?.signal || null }))
    .catch((err) => {
      if (timedOut) {
        const detail = `${label} stopped with ${err?.message || err}`;
        if (abortOnDeadline) {
          logger?.warn?.(
            `[watcher] posted-review step aborted after deadline for ${key}: ${detail}`,
          );
        } else {
          logger?.error?.(
            `[watcher] posted-review step failed in background after deadline for ${key}: ${detail}`,
          );
        }
      }
      throw err;
    });
  try {
    return await (deadline ? Promise.race([work, deadline]) : work);
  } finally {
    clearTimeoutFn(timer);
    if (deadlineTimer !== null) clearTimeoutFn(deadlineTimer);
    if (warned && !timedOut) {
      const elapsedMs = Math.round(performance.now() - startedMs);
      logger?.warn?.(
        `[watcher] posted-review step completed for ${key}: ${label} took ${elapsedMs}ms`,
      );
    }
    if (timedOut) {
      const elapsedMs = Math.round(performance.now() - startedMs);
      const inFlight = typeof getInFlightOperation === 'function' ? getInFlightOperation() : null;
      const inFlightDetail = inFlight?.name
        ? ` in_flight_operation=${inFlight.name}` +
          (Number.isFinite(inFlight.elapsedMs)
            ? ` in_flight_elapsed_ms=${Math.round(inFlight.elapsedMs)}`
            : '')
        : '';
      logger?.error?.(
        `[watcher] posted-review step deadline exceeded for ${key}: ` +
          `${label} deadline_ms=${effectiveDeadlineMs} elapsed_ms=${elapsedMs}${inFlightDetail}`,
      );
    }
  }
}

// A soft deadline releases the caller, not the PR's reservation ownership.
// Exclude newer passes (including moved heads) until both scopes have settled.
const postedReviewAttempts = new Map();

export async function handlePostedReviewRow(options = {}) {
  if (typeof options.repoPath !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repoPath)) {
    throw new TypeError('handlePostedReviewRow requires repoPath in owner/repo form');
  }
  if (!['number', 'string'].includes(typeof options.prNumber)
    || !/^\d+$/.test(String(options.prNumber))
    || !Number.isSafeInteger(Number(options.prNumber)) || Number(options.prNumber) <= 0) {
    throw new TypeError('handlePostedReviewRow requires a positive safe-integer prNumber');
  }
  const key = JSON.stringify([resolve(options.rootDir || ROOT), options.repoPath, Number(options.prNumber)]);
  if (postedReviewAttempts.has(key)) {
    return { handled: true, outcome: 'posted-review-in-flight' };
  }
  const snapshotPass = createMergeAgentSnapshotPass({ now: options.now });
  const attempt = { handlerActive: true, coexistenceActive: false,
    release() {
      if (!this.handlerActive && !this.coexistenceActive) postedReviewAttempts.delete(key);
    } };
  postedReviewAttempts.set(key, attempt);
  try {
    return await withPostedReviewReadCache({ repo: options.repoPath, prNumber: options.prNumber,
      headSha: options.currentRevisionRef }, () => handlePostedReviewRowWithinReadCache({ ...options, snapshotPass, attempt }));
  } finally {
    snapshotPass.close();
    attempt.handlerActive = false;
    attempt.release();
  }
}

async function handlePostedReviewRowWithinReadCache({
  rootDir = ROOT,
  repoPath,
  prNumber,
  existing,
  subjectRef,
  currentRevisionRef,
  labelNames = [],
  projectGateStatusSafe,
  execFileImpl = execFileAsync,
  preparedCandidate = null,
  reviewStateDb = rootDir === ROOT ? db : null,
  fetchMergeAgentCandidateImpl = fetchMergeAgentCandidate,
  branchProtectionCache = null,
  buildMergeAgentDispatchJobImpl = buildMergeAgentDispatchJob,
  dispatchMergeAgentForPRImpl = dispatchMergeAgentForPR,
  resolveMergeAgentCoexistenceForWatcherImpl = resolveMergeAgentCoexistenceForWatcher,
  latestFollowUpJobFinder = findLatestFollowUpJob,
  latestPostedReviewBodyFinder = findLatestPostedReviewBody,
  reviewBodyHasScopeViolationFindingImpl = reviewBodyHasScopeViolationFinding,
  currentReviewRowReader = readCurrentReviewRow,
  operatorSurface = null,
  domainId = null, // ARC-18: WATCHER_PRIMARY_DOMAIN_ID stays in watcher; threaded by callers (pollOnce passes domainId). Default is never read (only used when operatorSurface is set, and every such caller passes domainId).
  logGate = postedReviewRowLogGate,
  logger = console,
  snapshotPass,
  attempt,
} = {}) {
  const stepKey = `${repoPath}#${prNumber}`;
  const retireTerminalHammerIntent = () => {
    try {
      clearPendingAmaHammerDispatchForTerminalPr(rootDir, { repo: repoPath, prNumber });
    } catch (error) {
      logger?.warn?.(`[watcher] pending hammer terminal cleanup failed: ${error.message}`);
    }
  };
  const rereadPostedReviewRow = (stage, { allowPending = false } = {}) => {
    let currentRow;
    try {
      currentRow = currentReviewRowReader(rootDir, { repo: repoPath, prNumber }) || null;
    } catch (err) {
      logger?.error?.(
        `[watcher] posted-review handler skipped for ${repoPath}#${prNumber}: ` +
          `review row reread failed before ${stage} (${err?.message || err})`,
      );
      return {
        ok: false,
        result: {
          handled: true,
          outcome: 'review-row-reread-failed',
          reason: 'review-row-reread-failed',
          stage,
        },
      };
    }

    const reviewStatus = normalizeReviewStatus(currentRow);
    const pendingAllowed = allowPending
      && reviewStatus === 'pending'
      && isExplicitPendingRereviewRow(currentRow);
    if (reviewStatus !== 'posted' && !pendingAllowed) {
      const statusHint = reviewStatus || 'missing';
      logger?.log?.(
        `[watcher] posted-review handler skipped for ${repoPath}#${prNumber}: ` +
          `snapshot no longer current before ${stage} (review_status=${statusHint})`,
      );
      return {
        ok: false,
        result: {
          handled: true,
          outcome: 'stale-posted-review-snapshot',
          reason: `review-status-${statusHint}`,
          stage,
        },
      };
    }
    return { ok: true, row: currentRow };
  };

  const initialReviewState = rereadPostedReviewRow('projectGateStatusSafe', { allowPending: true });
  if (!initialReviewState.ok) return initialReviewState.result;
  existing = initialReviewState.row;
  let reviewRowSnapshot = gateRelevantReviewRowSnapshot(existing);
  let pendingAllowed = normalizeReviewStatus(existing) === 'pending'
    && isExplicitPendingRereviewRow(existing);

  const gateProjection = await timePostedReviewStep(
    'projectGateStatusSafe', stepKey, logger, () => projectGateStatusSafe(existing),
  );
  let gateDecision = gateProjection?.decision || null;

  const gateBlocksMergeAction = (decision) =>
    decision?.state && decision.state !== 'success';
  if (pendingAllowed && gateBlocksMergeAction(gateDecision)) {
    logger?.log?.(
      `[watcher] posted-review handler held for ${repoPath}#${prNumber}: ` +
        `adversarial gate is ${gateDecision.state} (${gateDecision.reason || 'unknown'})`,
    );
    return {
      handled: true,
      outcome: 'adversarial-gate-not-satisfied',
      reason: gateDecision.reason || 'adversarial-gate-not-satisfied',
      gateDecision,
      amaClosureResult: {
        dispatched: false,
        skipMergeAgent: true,
        reason: gateDecision.reason || 'adversarial-gate-not-satisfied',
        namedReason: gateDecision.reason || 'adversarial-gate-not-satisfied',
      },
    };
  }

  try {
    const latestPostedReviewBody = latestPostedReviewBodyFinder(rootDir, { repo: repoPath, prNumber });
    const latestFollowUp = latestFollowUpJobFinder(rootDir, { repo: repoPath, prNumber });
    const reviewBodiesToCheck = [
      latestPostedReviewBody,
      extractReviewBodyFromRow(existing),
      latestFollowUp?.job?.reviewBody,
    ];
    if (reviewBodiesToCheck.some((body) => reviewBodyHasScopeViolationFindingImpl(body))) {
      logger.log(
        `[watcher] automated dispatch suppressed for ${repoPath}#${prNumber}: scope-violation finding present`
      );
      return { handled: true, outcome: 'scope-violation', gateDecision: gateProjection?.decision || null };
    }

    let operatorApprovalEvent;
    let mergeAgentRequestEvent;
    let adversarialMergeRequestedEvent;
    if (operatorSurface) {
      const controlSubjectRef = subjectRef || {
        domainId,
        subjectExternalId: `${repoPath}#${prNumber}`,
        revisionRef: currentRevisionRef || null,
      };
      const revisionRef = currentRevisionRef || controlSubjectRef.revisionRef || null;
      // Label snapshots can be older than a hammer/operator wake. Leave missing
      // events unresolved so the live candidate fetch can use fresh PR labels.
      const [operatorApproval, mergeAgentRequest, adversarialMergeRequest] = await Promise.all([
        labelNames.includes(OPERATOR_APPROVED_LABEL) &&
          typeof operatorSurface.observeOperatorApproved === 'function'
          ? operatorSurface.observeOperatorApproved(controlSubjectRef, revisionRef)
          : undefined,
        labelNames.includes(MERGE_AGENT_REQUESTED_LABEL) &&
          typeof operatorSurface.observeMergeAgentOverride === 'function'
          ? operatorSurface.observeMergeAgentOverride(controlSubjectRef, revisionRef)
          : undefined,
        labelNames.includes(ADVERSARIAL_MERGE_REQUESTED_LABEL) &&
          typeof operatorSurface.observeLabelControl === 'function'
          ? operatorSurface.observeLabelControl(
              controlSubjectRef,
              revisionRef,
              ADVERSARIAL_MERGE_REQUESTED_LABEL,
            )
          : undefined,
      ]);
      operatorApprovalEvent = operatorApproval === undefined
        ? undefined
        : legacyLabelEventFromControlResult(operatorApproval, OPERATOR_APPROVED_LABEL);
      mergeAgentRequestEvent = mergeAgentRequest === undefined
        ? undefined
        : legacyLabelEventFromControlResult(mergeAgentRequest, MERGE_AGENT_REQUESTED_LABEL);
      adversarialMergeRequestedEvent = adversarialMergeRequest === undefined
        ? undefined
        : legacyLabelEventFromControlResult(
            adversarialMergeRequest,
            ADVERSARIAL_MERGE_REQUESTED_LABEL,
          );
    }
    // Candidate evaluation uses this tick's live read or a recent same-head
    // snapshot, rather than the previous lifecycle mirror. Guard actions still
    // execute here; downstream dispatch and merge retain their live checks.
    const candidateDeadlineMs = resolveMergeAgentCoexistenceStepDeadlineMs();
    let candidate;
    try {
      // Preparation is scheduling evidence, never merge authority. Reuse only
      // a recent same-PR/head snapshot; downstream live/lease checks still run.
      const preparedAgeMs = Date.now() - Number(preparedCandidate?.fetchedAt);
      const preparedSnapshot = preparedAgeMs >= 0 && preparedAgeMs < 10_000
        && preparedCandidate?.repoPath === repoPath && preparedCandidate?.prNumber === prNumber
        && preparedCandidate.value?.headRefOid === currentRevisionRef
        ? preparedCandidate.value : null;
      candidate = await timePostedReviewStep(
        'fetchMergeAgentCandidate', stepKey, logger, ({ signal }) =>
          fetchMergeAgentCandidateImpl(repoPath, prNumber, {
            rootDir,
            execFileImpl,
            operatorApprovalEvent,
            mergeAgentRequestEvent,
            signal,
            branchProtectionCache,
            preparedSnapshot,
          }),
        undefined,
        { deadlineMs: candidateDeadlineMs },
      );
    } catch (err) {
      if (err?.code !== 'POSTED_REVIEW_STEP_DEADLINE_EXCEEDED') throw err;
      const reason = 'fetch-merge-agent-candidate-deadline-exceeded';
      logger?.error?.(
        `[watcher] merge-agent candidate fetch deadline exceeded for ${repoPath}#${prNumber}; ` +
          `reason=${reason} deadline_ms=${candidateDeadlineMs}. ` +
          'Skipping merge action for this PR on this tick so the posted-review phase can continue.',
      );
      return {
        handled: true,
        outcome: 'candidate-fetch-deadline',
        gateDecision: gateProjection?.decision || null,
        amaClosureResult: {
          dispatched: false,
          skipMergeAgent: true,
          reason,
          namedReason: reason,
          deadlineMs: candidateDeadlineMs,
        },
      };
    }
    // Own reservation cleanup outside closure dispatch: operator holds and
    // terminal/head changes can prevent the next daemon acquire entirely.
    const reservationBase = candidate?.baseBranch || existing?.base_ref || existing?.baseBranch;
    return await withDaemonMergeReservation({ rootDir, repo: repoPath, pr: prNumber,
      base: reservationBase, head: candidate?.headSha || currentRevisionRef,
      isAttemptActive: () => attempt.coexistenceActive,
    }, async () => {
    // End advisory reuse before any closure, lease or dispatch freshness read.
    closePostedReviewReadCache();
    const postCandidateReviewState = rereadPostedReviewRow('resolveMergeAgentCoexistence', {
      allowPending: true,
    });
    if (!postCandidateReviewState.ok) {
      return { ...postCandidateReviewState.result, gateDecision: gateProjection?.decision || null };
    }
    existing = postCandidateReviewState.row;
    const nextReviewRowSnapshot = gateRelevantReviewRowSnapshot(existing);
    pendingAllowed = normalizeReviewStatus(existing) === 'pending'
      && isExplicitPendingRereviewRow(existing);
    if (nextReviewRowSnapshot !== reviewRowSnapshot) {
      const refreshedGateProjection = await timePostedReviewStep(
        'projectGateStatusSafe-after-candidate',
        stepKey,
        logger,
        () => projectGateStatusSafe(existing),
      );
      gateDecision = refreshedGateProjection?.decision || gateDecision;
      reviewRowSnapshot = nextReviewRowSnapshot;
    }
    if (pendingAllowed && gateBlocksMergeAction(gateDecision)) {
      logger?.log?.(
        `[watcher] posted-review handler held for ${repoPath}#${prNumber}: ` +
          `adversarial gate changed to ${gateDecision.state} (${gateDecision.reason || 'unknown'})`,
      );
      return {
        handled: true,
        outcome: 'adversarial-gate-not-satisfied',
        reason: gateDecision.reason || 'adversarial-gate-not-satisfied',
        gateDecision,
        amaClosureResult: {
          dispatched: false,
          skipMergeAgent: true,
          reason: gateDecision.reason || 'adversarial-gate-not-satisfied',
          namedReason: gateDecision.reason || 'adversarial-gate-not-satisfied',
        },
      };
    }
    operatorApprovalEvent = operatorApprovalEvent ?? candidate?.operatorApprovalEvent ?? null;
    mergeAgentRequestEvent = mergeAgentRequestEvent ?? candidate?.mergeAgentRequestEvent ?? null;
    // Observational handoff only. Both consumers receive this same immutable
    // generation; their legacy inputs and mutation-time freshness checks remain.
    const source = (sourceRef, value) => ({ sourceRef, read: () => value });
    const passSnapshot = await snapshotPass.collect({ subjectKey: stepKey, head: candidate?.headSha,
      anchors: { reviewerStartedAt: existing?.reviewer_started_at ?? null, postedAt: existing?.posted_at ?? null },
      sources: {
        pr: source('candidate-evaluation', { headSha: candidate?.headSha, baseSha: candidate?.baseSha,
          state: candidate?.prState, mergedAt: candidate?.mergedAt, closedAt: candidate?.closedAt,
          isDraft: candidate?.isDraft,
          mergeable: candidate?.mergeable, mergeStateStatus: candidate?.mergeStateStatus }),
        candidate: source('candidate-evaluation', candidate),
        checks: source('candidate-evaluation', { rollup: candidate?.statusCheckRollup,
          branchProtection: candidate?.branchProtection }),
        reviews: source('review-row', existing),
        remediation: source('follow-up-job', latestFollowUp),
        controls: source('posted-review-controls', { gateDecision, operatorApprovalEvent,
          mergeAgentRequestEvent, adversarialMergeRequestedEvent }),
      } });
    const dispatchJob = buildMergeAgentDispatchJobImpl(rootDir, candidate, { reviewStateDb, passSnapshot });
    // Keep this generation current through coexistence; the owner's finally
    // closes the pass. Executing consumers retain live exact-head/effect checks.

    if (gateDecision?.reason === 'operator-skip-label') {
      const terminalReason = liveCandidateTerminalReason(candidate);
      if (terminalReason) {
        retireTerminalHammerIntent();
        logger.log(
          `[watcher] AMA/merge-agent skipped for ${repoPath}#${prNumber}: PR already ` +
          `${terminalReason} under operator-skip-label — dropping ownership`
        );
        clearNoProgressLane(rootDir, { repo: repoPath, prNumber }, { logger });
        void shadowNextActionLater({ source: 'posted-review', legacy: () => fromLegacyPostedReviewOutcome({ prTerminal: true, terminalReason }),
          passSnapshot, repo: repoPath, prNumber, rootDir });
        return {
          handled: true,
          dispatchJob,
          prTerminal: true,
          gateDecision,
          amaClosureResult: null,
        };
      }
      logger.log(
        `[watcher] posted-review handler held for ${repoPath}#${prNumber}: ` +
          'operator-skip-label blocks merge/hammer closeout for this tick',
      );
      void shadowNextActionLater({ source: 'posted-review', legacy: () => fromLegacyPostedReviewOutcome({ outcome: 'operator-skip-label' }),
        passSnapshot, repo: repoPath, prNumber, rootDir });
      return {
        handled: true,
        outcome: 'operator-skip-label',
        reason: 'skip-operator-skip',
        dispatchJob,
        gateDecision,
        amaClosureResult: {
          dispatched: false,
          skipMergeAgent: true,
          reason: 'skip-operator-skip',
          namedReason: 'skip-operator-skip',
        },
      };
    }

    // MSM-04: AMA-enabled posted-review rows have one autonomous merge route:
    // clean PRs are handled by the daemon, and dirty/conflicted/red-CI PRs are
    // handled by one hammer under the launch lease. A separate merge-clicking
    // agent is no longer a valid outcome.
    const coexistenceDeadlineMs = resolveMergeAgentCoexistenceStepDeadlineMs();
    const coexistenceOperationTimeoutMs = resolveMergeAgentCoexistenceOperationTimeoutMs(
      process.env,
      { stepDeadlineMs: coexistenceDeadlineMs },
    );
    const coexistenceOperationTracker = { current: null, currentStartedMs: null };
    let coexistenceDecision;
    try {
      coexistenceDecision = await timePostedReviewStep(
        'resolveMergeAgentCoexistence', stepKey, logger, async ({ signal }) => {
          attempt.coexistenceActive = true;
          // This scope follows the concrete promise past a soft deadline,
          // including terminal/stacked exits that never enter closure dispatch.
          // Keep this inner boundary even though the candidate scope also prunes:
          // the outer scope can exit at its soft deadline while this work lives on.
          // Each scope must independently settle its reservation ownership.
          try { return await withDaemonMergeReservation({ rootDir, repo: repoPath,
            base: reservationBase, pr: prNumber,
            head: candidate?.headSha || currentRevisionRef,
          }, () => resolveMergeAgentCoexistenceForWatcherImpl({
            rootDir,
            reviewStateRow: existing,
            reviewStateDb,
            dispatchJob,
            candidate,
            passSnapshot,
            labelNames,
            operatorApprovalEvent,
            mergeAgentRequestEvent,
            adversarialMergeRequestedEvent,
            repoPath,
            prNumber,
            currentRevisionRef,
            domainId,
            logger,
            signal,
            operationTimeoutMs: coexistenceOperationTimeoutMs,
            operationTracker: coexistenceOperationTracker,
          })); } finally {
            attempt.coexistenceActive = false;
            attempt.release();
          }
        },
        undefined,
        {
          deadlineMs: coexistenceDeadlineMs,
          abortOnDeadline: false,
          getInFlightOperation: () => {
            if (!coexistenceOperationTracker.current) return null;
            return {
              name: coexistenceOperationTracker.current,
              elapsedMs: performance.now() - coexistenceOperationTracker.currentStartedMs,
            };
          },
        },
      );
    } catch (err) {
      if (err?.code !== 'POSTED_REVIEW_STEP_DEADLINE_EXCEEDED') throw err;
      const reason = 'resolve-merge-agent-coexistence-deadline-exceeded';
      const inFlight = coexistenceOperationTracker.current
        ? ` in_flight_operation=${coexistenceOperationTracker.current}` +
          (Number.isFinite(coexistenceOperationTracker.currentStartedMs)
            ? ` in_flight_elapsed_ms=${Math.round(performance.now() - coexistenceOperationTracker.currentStartedMs)}`
            : '')
        : '';
      logger?.error?.(
        `[watcher] AMA/merge-agent coexistence deadline exceeded for ${repoPath}#${prNumber}; ` +
          `reason=${reason} deadline_ms=${coexistenceDeadlineMs}${inFlight}. ` +
          'Leaving any in-flight HAM launch to settle under its own lease and dispatch timeout; ' +
          'skipping merge action for this PR on this tick so the posted-review phase can continue.',
      );
      return {
        handled: true,
        outcome: 'coexistence-deadline',
        gateDecision: gateProjection?.decision || null,
        amaClosureResult: {
          dispatched: false,
          skipMergeAgent: true,
          reason,
          namedReason: reason,
          deadlineMs: coexistenceDeadlineMs,
        },
      };
    }
    // NXA-02 shadow: same pass decision as closure orchestration; no effect.
    void shadowNextActionLater({ source: 'posted-review', passSnapshot, repo: repoPath, prNumber, rootDir,
      legacy: () => fromLegacyPostedReviewOutcome(coexistenceDecision, { includeClosureOwner: false }) });
    const leaseWaitMessage = coexistenceDecision.amaClosureResult?.reason === 'daemon-deferred'
      && coexistenceDecision.amaClosureResult?.daemonCleanMerge?.reason === 'lease-contended'
      ? coexistenceDecision.amaClosureResult.daemonCleanMerge.waitMessage
        || 'waiting for the merge lease, position unknown' : null;
    if (coexistenceDecision.outcome === 'ama-dispatched'
      || coexistenceDecision.amaClosureResult?.reason === 'ama-closer-launch-in-progress') {
      // Reconciliation can find the old process's launch without submitting to
      // this process's queue. The launch ledger now owns recovery, not intent.
      try {
        clearPendingAmaHammerDispatch(rootDir, {
          repo: repoPath, prNumber, headSha: currentRevisionRef,
        }, { logger });
      } catch (error) {
        logger?.warn?.(`[watcher] pending hammer launch cleanup failed: ${error.message}`);
      }
    }
    if (coexistenceDecision.outcome === 'pr-terminal') {
      retireTerminalHammerIntent();
      // BUG-1: the live candidate read shows the PR already merged. No
      // AMA/merge-agent action is possible — drop ownership instead of retaining
      // it and re-evaluating (and re-failing the daemon merge) every tick.
      logger.log(
        `[watcher] AMA/merge-agent skipped for ${repoPath}#${prNumber}: PR already ` +
        `${coexistenceDecision.terminalReason} — dropping ownership`
      );
      clearNoProgressLane(rootDir, { repo: repoPath, prNumber }, { logger });
      return {
        handled: true,
        dispatchJob,
        prTerminal: true,
        amaClosureResult: coexistenceDecision.amaClosureResult || null,
        gateDecision: gateProjection?.decision || null,
      };
    }
    if (coexistenceDecision.outcome === 'ama-dispatched') {
      const { amaClosureResult } = coexistenceDecision;
      logger.log(
        `[watcher] AMA hammer dispatched for ${repoPath}#${prNumber}: ` +
        `lrq=${amaClosureResult.dispatchId || 'unknown'} workerClass=${amaClosureResult.workerClass}`
      );
      return { handled: true, outcome: 'ama-dispatched',
        ...(gateProjection?.decision?.operatorDecisionRequired === true ? { hammerRouteActive: true } : {}),
        gateDecision: gateProjection?.decision || null };
    }
    if (coexistenceDecision.outcome === 'ama-pending') {
      const { amaClosureResult } = coexistenceDecision;
      const operatorHoldReason = isSafetyRecoveryHold(amaClosureResult)
        || amaClosureResult?.reason === HAMMER_STOP_HOLD_REASON
        ? amaClosureResult?.operatorReason || amaClosureResult?.reason || 'ama-operator-hold' : null;
      // Log-feed noise control: this route retains ownership and re-polls a
      // stuck PR every tick. Log once per retained-worker state transition
      // instead of every poll; a new head/reason/worker identity still logs.
      const retainGateKey = `${repoPath}#${prNumber}`;
      const retainSignature =
        `${currentRevisionRef || ''}#${leaseWaitMessage || amaClosureResult.reason || 'ama-dispatch-pending'}` +
        `#${amaClosureResult.launchRequestId || ''}#${amaClosureResult.dispatchId || ''}` +
        `#${amaClosureResult.workerClass || ''}`;
      const retainDecision = logGate.note(retainGateKey, retainSignature);
      if (retainDecision.changed) {
        const suppressedNote = retainDecision.suppressedSincePrevious > 0
          ? ` (after ${retainDecision.suppressedSincePrevious} suppressed identical polls)`
          : '';
        logger.log(
          `[watcher] AMA hammer route retained ownership for ${repoPath}#${prNumber}: ` +
          `${leaseWaitMessage || amaClosureResult.reason || 'ama-dispatch-pending'} ` +
          (isAmaCloserLaunching(amaClosureResult) ? 'closer is launching; ' : '') +
          `lrq=${amaClosureResult.launchRequestId || amaClosureResult.dispatchId || 'unknown'} ` +
          `workerClass=${amaClosureResult.workerClass || 'unknown'}${suppressedNote}`
        );
      }
      return { handled: true, outcome: 'ama-pending', urgent: coexistenceDecision.urgent === true,
        ...(operatorHoldReason || amaClosureResult?.reason === 'deferred-by-drain'
          || leaseWaitMessage
          ? { amaClosureResult } : {}),
        ...(operatorHoldReason ? { operatorHoldReason } : {}),
        ...(gateProjection?.decision?.operatorDecisionRequired === true
          && !operatorHoldReason ? { hammerRouteActive: true } : {}),
        gateDecision: gateProjection?.decision || null };
    }

    // Shared AMA recovery owns transient/finding misses. Only safety holds
    // arrive here as await-operator; exhausted recovery must not fall through.
    if (coexistenceDecision.outcome === 'recovery-exhausted') {
      return { handled: true, outcome: 'recovery-exhausted',
        amaClosureResult: coexistenceDecision.amaClosureResult };
    }
    if (coexistenceDecision.outcome === 'await-operator') {
      const { amaClosureResult } = coexistenceDecision;
      const reasonsHint = Array.isArray(amaClosureResult?.reasons)
        ? amaClosureResult.reasons.slice(0, 8).join(',')
        : amaClosureResult?.reason || 'unknown';
      const namedReason = amaClosureResult?.namedReason || namedAmaNoDispatchReason(
        amaClosureResult?.reason || 'unknown',
        amaClosureResult?.reasons,
      );
      const recoveryHint = ['primary-change-needs-operator', 'primary-change-repair-required'].includes(amaClosureResult?.reason)
        ? "(inspect the primary-change evidence; use current-head 'merge-agent-requested' for the operator-fallback lane; see RUNBOOK-ama-closure)"
        : '(inspect and resolve the named safety hold under its existing approval policy; see RUNBOOK-ama-closure)';
      logger.log(
        `[watcher] AMA enabled but not eligible for ${repoPath}#${prNumber} ` +
        `(${namedReason}; reasons: ${reasonsHint}` +
        `${amaClosureResult?.missingEvidence?.summary ? `; missing evidence: ${amaClosureResult.missingEvidence.summary}` : ''}` +
        (leaseWaitMessage
          ? `); ${leaseWaitMessage}`
          : isAmaCloserLaunching(amaClosureResult)
          ? '); closer is launching; awaiting dispatch outcome'
          : '); safety hold requires operator action ' + recoveryHint)
      );
      return {
        handled: true,
        outcome: 'await-operator',
        gateDecision: gateProjection?.decision || null,
        amaClosureResult,
      };
    }

    const orchestrationMode = resolveOrchestrationMode({
      logger,
      context: 'merge-agent dispatch',
    });
    const { coexistence, dispatchEnv } = coexistenceDecision;
    // AMA-06N: when the operator-fallback lane is selected, override
    // the dispatch trigger to 'merge-agent-requested' so the critical-
    // lane priority + consumed-label cleanup at
    // follow-up-merge-agent.mjs:3768-3783 + :3060-3069 fire correctly.
    // An env overlay alone leaves the trigger on the normal lane,
    // recreating the memory-pressure outage class this label exists
    // to bypass.
    const operatorFallbackTriggerOverride =
      coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK
        ? 'merge-agent-requested'
        : null;
    if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_OPERATOR_FALLBACK) {
      logger.log(
        `[watcher] merge-agent operator-fallback lane for ${repoPath}#${prNumber}: ` +
        `setting AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true + trigger=merge-agent-requested (AMA-06N → AMA-06A admit-gate bypass)`
      );
    } else if (coexistence?.action === COEXISTENCE_ACTION.MERGE_AGENT_RECOVERY_FALLBACK) {
      logger.log(
        `[watcher] AMA hammer recovery fallback for ${repoPath}#${prNumber}: ` +
        `${coexistenceDecision?.amaClosureResult?.reason || 'ama-dispatch-failure'}; ` +
        `dispatching merge-agent with AMA_OPERATOR_MERGE_AGENT_OVERRIDE=true`
      );
    }
    const dispatched = await dispatchMergeAgentForPRImpl({
      rootDir,
      ...dispatchJob,
      // AMA validated the hammer's terminal remediation from ground truth but
      // could not dispatch its own closer. Hand that proof to the merge-agent so it
      // can close on the certification instead of waiting for a verdict that
      // closer-commit suppression guarantees will never be posted.
      hamTerminalRemediationValidated:
        coexistenceDecision?.amaClosureResult?.hamTerminalRemediationValidated === true,
      orchestrationMode,
      ...(dispatchEnv ? { env: { ...process.env, ...dispatchEnv } } : {}),
      ...(operatorFallbackTriggerOverride ? { triggerOverride: operatorFallbackTriggerOverride } : {}),
    });
    // Enrich the decision log line when the dispatch is stuck pre-spawn
    // (recorded, daemon refusing admission). Surfaces what
    // `skip-already-dispatched` alone hides — see PR #649 for the on-
    // demand diagnostic of the same gap. Fails closed: when the helper
    // returns null (OSS standalone, hqRoot missing, audit dir empty,
    // dispatch still booting) the message is unchanged.
    const stuck = dispatched?.stuckDetail || null;
    const stuckSuffix = stuck
      ? ` BLOCKED stuck=${stuck.stuckForMinutes}min refusals=${stuck.refusalCount} primary=${stuck.primaryReason || 'unknown'}`
      : '';
    logger.log(
      `[watcher] merge-agent decision for ${repoPath}#${prNumber}: ${dispatched.decision}${stuckSuffix}`
    );
    // Escalate to a Sentinel alert at the operator-confirmed 30-min
    // threshold. Debounced: don't refire the same alert within an hour.
    // Wrapped in try/catch so missing ALERT_TO / unreachable hooks
    // endpoint never crashes the watcher loop (matches the OSS-friendly
    // shape of health-probe.mjs::sendTransitionAlert).
    if (stuck && stuck.stuckForMinutes >= 30) {
      try {
        await maybeFireMergeAgentStuckAlert({
          rootDir,
          repoPath,
          prNumber,
          dispatched,
          deliverAlertFn: defaultDeliverAlert,
          logger,
        });
      } catch (alertErr) {
        logger?.error?.(
          `[watcher] stuck-dispatch alert delivery failed: ${alertErr?.message || alertErr}`
        );
      }
    }
    // Fleet-wide false-deferral alert — defense-in-depth against the
    // 2026-05-18 session-ledger DB-path bug class. See helper above.
    try {
      await maybeFireFleetWideFalseDeferralAlert({
        dispatched,
        repoPath,
        prNumber,
        deliverAlertFn: defaultDeliverAlert,
        logger,
      });
    } catch (alertErr) {
      logger?.error?.(
        `[watcher] fleet-wide false-deferral detector failed: ${alertErr?.message || alertErr}`
      );
    }
    return {
      handled: true,
      outcome: 'merge-agent-dispatched',
      dispatchJob,
      dispatched,
      gateDecision,
      amaClosureResult: coexistenceDecision?.amaClosureResult || null,
    };
    });
  } catch (err) {
    // The augmented error from `dispatchMergeAgentForPR` already
    // inlines stderr+stdout into `err.message`, so just dumping
    // `err.message` here surfaces the full diagnostic chain (rather
    // than the bare "Command failed: hq dispatch …" the watcher used
    // to log). For non-augmented errors (anything throwing from the
    // outer try block that doesn't pass through the augment shim),
    // also try `.stderr` / `.stdout` as a defense-in-depth fallback.
    const errMessage = err?.message || String(err);
    const errStderr = err?.stderr ? String(err.stderr).trim() : '';
    const errStdout = err?.stdout ? String(err.stdout).trim() : '';
    let detail = errMessage;
    if (errStderr && !errMessage.includes('stderr:')) {
      detail += `\n  stderr:\n${errStderr.split('\n').map(l => `    ${l}`).join('\n')}`;
    }
    if (errStdout && !errMessage.includes('stdout:')) {
      detail += `\n  stdout:\n${errStdout.split('\n').map(l => `    ${l}`).join('\n')}`;
    }
    logger.error(
      `[watcher] merge-agent dispatch check failed for ${repoPath}#${prNumber}:\n${detail}`
    );
  }
}

// ── Poll loop: once-per-tick post-review adoption + maintenance phase ─────────

// Probe only lane-due, locally settled current-head reviews. The bounded probe wave
// avoids serial GitHub reads before the scheduler can prioritize ready work.
// Probe faults affect ordering only; the normal handler retries its own reads.
export async function preparePostedReviewHandlers(handlers, {
  rootDir = ROOT, logger = console, execFileImpl = execFileAsync,
  readReviewRow = handler => readCurrentReviewRow(rootDir, { repo: handler.repoPath, prNumber: handler.prNumber }),
  resolveSettled = resolveSettledReviewVerdict,
  fetchSnapshot = fetchMergeAgentCandidateSnapshot,
  laneGate = null,
  now = Date.now,
  deadlineAt = Infinity,
} = {}) {
  let cursor = 0;
  const prepared = [...handlers];
  const worker = async () => {
    while (cursor < handlers.length && now() < deadlineAt) {
      const index = cursor++;
      const handler = handlers[index];
      try {
        // Preview without advancing the ledger: the scheduler owns the one
        // skip/run accounting decision, including wakes and the idle floor.
        if (laneGate?.evaluate?.(handler, { recordSkip: false })?.run === false) continue;
        const row = readReviewRow(handler);
        if (row?.review_status !== 'posted' || !handler.headSha || row.reviewer_head_sha !== handler.headSha) continue;
        const settled = resolveSettled(rootDir, { repo: handler.repoPath, prNumber: handler.prNumber,
          reviewRow: row, currentHeadSha: handler.headSha, logger });
        if (!['approved', 'comment-only'].includes(settled.verdict) || settled.remediationPending !== false) continue;
        const value = await timePostedReviewStep('prepare-merge-ready', postedReviewHandlerKey(handler), logger,
          ({ signal }) => fetchSnapshot(handler.repoPath, handler.prNumber, { execFileImpl, signal }),
          undefined, { deadlineMs: Math.max(1, Math.min(loadAwareTimeoutMs(10_000), deadlineAt - now())) });
        if (value?.headRefOid !== handler.headSha) continue;
        const candidate = { value, fetchedAt: now(), repoPath: handler.repoPath, prNumber: handler.prNumber };
        prepared[index] = { ...handler, mergeReady: String(value.state).toUpperCase() === 'OPEN' && !value.mergedAt
            && summarizeChecksConclusion(value.statusCheckRollup) === 'SUCCESS',
          run: () => handler.run({ preparedCandidate: candidate }) };
      } catch (error) {
        logger?.warn?.(`[watcher] merge-ready priority probe failed; normal handler retained: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(POSTED_REVIEW_CONCURRENCY, handlers.length) }, worker));
  return prepared;
}

// WPS-01: cross-tick fairness state for the posted-review phase. Process-scoped
// so a handler the per-tick budget cut off is promoted to the front of the NEXT
// tick instead of being cut off in the same position forever.
const postedReviewFairnessState = createPostedReviewFairnessState();
const postedReviewStartupRecoveryRoots = new Set();

/**
 * Bind the no-progress lane to real review-state rows.
 *
 * `evaluate` decides whether a queued posted-review handler runs this tick;
 * `{ recordSkip: false }` previews that decision before readiness probes without
 * advancing the skip counter. The scheduler alone accounts for skipped ticks;
 * `record` compares the post-run state fingerprint with the previous tick's to
 * decide whether the tick achieved anything for that PR. Both are kept here (and
 * out of the scheduler) so `runPostedReviewHandlersFairly` stays a pure,
 * SQLite-free ordering/budget decision.
 *
 * A handler that TIMED OUT is recorded as no-progress on purpose: an abandoned
 * handler is the strongest possible evidence that this PR cannot be advanced by
 * re-walking it, and it is the single most expensive thing the tick can carry.
 */
export function createNoProgressLaneGate({
  rootDir = ROOT,
  hqRoot = resolveHqRoot(),
  readReviewRow = (repo, prNumber) => stmtGetReviewRow.get(repo, prNumber),
  now = () => new Date().toISOString(),
  deliverAlertFn = defaultDeliverAlert,
  emitStalledEventFn = null,
  logger = console,
} = {}) {
  const freshDrainHint = (identity, observedAt) => {
    const record = readAmaCloserDispatchRecord(rootDir, identity);
    const fresh = isFreshDrainDeferredAmaCloserRecord(record, observedAt);
    if (!fresh && isDrainDeferredAmaCloserRecord(record)) retireAmaCloserDrainHint(rootDir, identity, { logger });
    return fresh;
  };
  return {
    evaluate(handler, { recordSkip = true } = {}) {
      const identity = { repo: handler.repoPath, prNumber: handler.prNumber };
      const ledger = readNoProgressLane(rootDir, identity, { logger });
      const observedAt = now();
      const drainDeferred = freshDrainHint({ ...identity, headSha: handler.headSha }, observedAt);
      // Consult durable intent BEFORE the lane: an interrupted background call
      // must reach normal live-head/lease/retry/dedup guards on the first tick.
      const pending = readPendingAmaHammerDispatch(rootDir, { ...identity, headSha: handler.headSha }, { logger });
      let decision = pending
        ? { lane: 'active', due: true, reason: 'hammer-dispatch-recovery', backoffTicks: 0 }
        : evaluateNoProgressLane(ledger, { headSha: handler.headSha || null, drainDeferred });
      let reviewedSha = null;
      try {
        reviewedSha = readReviewRow(handler.repoPath, handler.prNumber)?.reviewer_head_sha ?? null;
      } catch (err) {
        logger?.warn?.(
          `[watcher] no-progress lane: review-row read failed for ` +
            `${handler.repoPath}#${handler.prNumber} (${err?.message || err}); evaluating by head`,
        );
      }
      // Evidence can recover without a review-row mutation or a wake event.
      // Only unresolved, unpaged stops use the shorter cadence. Historical
      // audit records must not keep released/paged stops outside normal backoff.
      const stop = readHammerStopForHead({
        hqRoot, ...identity, headSha: handler.headSha,
        reviewedSha,
        logger,
      });
      if (HAMMER_EVIDENCE_FAILURES.has(stop?.predicate)) {
        const hold = readHammerStopHoldForHead({ rootDir, ...identity,
          headSha: handler.headSha, stopKey: stop.stopKey });
        if (!hold?.releasedAt && !hold?.pagedAt) {
          const lastRunAt = ledger?.lastRunAt !== undefined ? ledger.lastRunAt : ledger?.updatedAt;
          const lastRunMs = ledger?.headSha === handler.headSha
            ? Date.parse(lastRunAt ?? '') : NaN;
          const elapsedMs = Date.parse(observedAt) - lastRunMs;
          const due = !Number.isFinite(elapsedMs) || elapsedMs >= HAMMER_EVIDENCE_RECHECK_INTERVAL_MS;
          decision = { ...decision, due, reason: due ? 'hammer-evidence-due' : 'hammer-evidence-wait',
            retryAfterMs: due ? 0 : HAMMER_EVIDENCE_RECHECK_INTERVAL_MS - elapsedMs };
        }
      }
      if (!decision.due && recordSkip) {
        recordNoProgressLaneSkip(rootDir, identity, {
          headSha: handler.headSha || null,
          now: observedAt,
          logger,
        });
      }
      noteNextActionLegacyLater({ source: 'no-progress-lane', subjectKey: `${handler.repoPath}#${handler.prNumber}`,
        head: handler.headSha, legacy: () => fromLegacyNoProgressLane(decision) });
      return { run: decision.due, ...decision };
    },
    async record(handler, { timedOut = false, error = null, value = null, laneAdmission = null } = {}) {
      // The scheduler already excludes resource-limited handler outcomes. Its
      // parent poll may have seen an unrelated credential fail earlier.
      if (isGitHubRateLimitError(error) || value?.rateLimited) return null;
      // Without a head there is no series to key on; skip the row read too.
      if (!handler.headSha) return null;
      const identity = { repo: handler.repoPath, prNumber: handler.prNumber };
      if (!timedOut && !error && value?.outcome !== 'await-operator'
        && !value?.operatorHoldReason && !value?.amaClosureResult?.needsOperator
        && !isSafetyRecoveryHold(value?.amaClosureResult)
        && (value?.amaClosureResult?.reason === 'deferred-by-drain'
        || freshDrainHint({ ...identity, headSha: handler.headSha }, now()))) return null;
      let row = null;
      if (!timedOut) {
        try {
          row = readReviewRow(handler.repoPath, handler.prNumber) || null;
        } catch (err) {
          logger?.warn?.(
            `[watcher] no-progress lane: review-row read failed for ` +
              `${handler.repoPath}#${handler.prNumber} (${err?.message || err})`,
          );
          // Unknown post-state is not evidence of no progress; leave the series
          // alone rather than demoting on a read fault.
          return null;
        }
      }
      const fingerprint = timedOut
        ? 'timed-out'
        : subjectProgressFingerprint(row, { headSha: handler.headSha || null });
      // The final review's generic operator flag does not describe closure
      // ownership. A retained hammer route must run each tick, including while
      // dispatch is queued; a named safety/operator refusal still wins.
      const selectedNextAction = value?.amaClosureResult?.nextAction || value?.nextAction;
      const operatorHold = selectedNextAction ? selectedNextAction.action === 'operator-hold'
        : Boolean(value?.operatorHoldReason) || isSafetyRecoveryHold(value?.amaClosureResult)
          || value?.outcome === 'await-operator';
      const hammerRouteActive = !timedOut && value?.hammerRouteActive === true && !operatorHold;
      const progressClass = !hammerRouteActive && (value?.gateDecision?.operatorDecisionRequired === true
        || operatorHold)
        ? PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED
        : PROGRESS_CLASS_SELF_RESOLVING;
      if (operatorHold) {
        try {
          clearPendingAmaHammerDispatch(rootDir, { ...identity, headSha: handler.headSha }, { logger });
        } catch (error) {
          // Cleanup failure must never suppress the operator's durable lane or
          // page. The old intent remains safe: retries still enter live guards.
          logger?.warn?.(`[watcher] pending hammer hold cleanup failed: ${error.message}`);
        }
      }
      const observedAt = now();
      // LANESTARVE-01. A timed-out handler reported no decision at all, so it
      // carries no decision fingerprint — its `'timed-out'` row fingerprint is
      // the whole signal, exactly as before.
      const decisionFingerprint = timedOut ? null : handlerDecisionFingerprint(value);
      const outcome = recordNoProgressLaneRun(rootDir, identity, {
        headSha: handler.headSha || null,
        fingerprint,
        decisionFingerprint,
        progressClass,
        operatorHold,
        hammerRouteActive,
        nextAction: timedOut ? null : value?.amaClosureResult?.nextAction || value?.nextAction || null,
        operatorReason: value?.operatorHoldReason || value?.amaClosureResult?.operatorReason || null,
        // HAMUNKNOWN-01: GitHub can finish computing without any review-row
        // change. Recovery bounds urgency to its tolerated cycle budget.
        urgent: value?.urgent === true,
        // A starvation-floor admission is a walk the lane did not schedule.
        // Recording it as escalating would charge the PR for a look it never
        // asked for and push its next real walk twice as far away — the exact
        // self-reinforcement this lane was accused of.
        escalate: laneAdmission !== 'starvation-floor',
        now: observedAt,
        logger,
      });
      if (outcome?.decisionReset) {
        logger?.log?.(
          `[watcher] no-progress lane: ${handler.repoPath}#${handler.prNumber} handler decision ` +
            `changed on head ${(handler.headSha || 'unknown').slice(0, 12)} with the review row ` +
            'unchanged; restarting the no-progress series (the blocker moved even though the row ' +
            `did not) — decision_resets=${outcome.decisionResets}`,
        );
      }
      if (outcome?.demoted) {
        logger?.warn?.(
          `[watcher] no-progress lane: ${handler.repoPath}#${handler.prNumber} demoted to the ` +
            `slow lane after ${outcome.noProgressTicks} consecutive ticks with no state change ` +
            `on head ${(handler.headSha || 'unknown').slice(0, 12)}; it will now be re-walked ` +
            `every ${outcome.backoffTicks} tick(s) instead of every tick. It is NOT dropped — ` +
            'nothing about its eligibility, findings, or merge gating has changed.',
        );
      }
      if (outcome?.progressed === false && !isTerminalReviewRow(row)) {
        const missingInput = primaryChangeReadStatus({ rootDir, repo: handler.repoPath, prNumber: handler.prNumber, headSha: handler.headSha }) || chooseNoProgressMissingInput({
          value,
        });
        const producer = resolveNoProgressProducerState({
          missingInput,
          producerHints: handler.stalledProducerHints || null,
        });
        const stalledEvent = maybeMarkNoProgressStalledEvent(rootDir, identity, {
          headSha: handler.headSha || null,
          fingerprint,
          noProgressTicks: outcome.noProgressTicks,
          firstNoProgressAt: outcome.firstNoProgressAt || null,
          missingInput,
          producer,
          now: observedAt,
          logger,
        });
        if (stalledEvent) {
          logger?.warn?.(
            `[watcher] STALLED ${handler.repoPath}#${handler.prNumber} for ` +
              `${stalledEvent.noProgressTicks} ticks: needs ${stalledEvent.missingInput} ` +
              `at head ${(handler.headSha || 'unknown').slice(0, 12)}. ` +
              `Producer exists: ${stalledEvent.producer.exists === true ? 'yes' : stalledEvent.producer.exists === false ? 'no' : 'unknown'}` +
              (stalledEvent.producer.reason ? ` (${stalledEvent.producer.reason})` : ''),
          );
          logger?.log?.(JSON.stringify(stalledEvent));
          try {
            if (typeof emitStalledEventFn === 'function') {
              await emitStalledEventFn(stalledEvent);
            }
            markNoProgressStalledEventEmitted(rootDir, identity, stalledEvent, {
              emittedAt: now(),
              fingerprint,
              logger,
            });
          } catch (err) {
            logger?.warn?.(
              `[watcher] no-progress lane: stalled-event delivery failed for ` +
                `${handler.repoPath}#${handler.prNumber} (${err?.message || err})`,
            );
          }
        }
      }
      if (outcome?.progressClass === PROGRESS_CLASS_OPERATOR_DECISION_REQUIRED) {
        try {
          const alerted = await maybeFireOperatorDecisionRequiredAlert({
            rootDir,
            identity,
            headSha: handler.headSha || null,
            operatorReason: value?.operatorHoldReason || value?.amaClosureResult?.operatorReason || null,
            fingerprint,
            noProgressTicks: outcome.noProgressTicks,
            firstNoProgressAt: outcome.firstNoProgressAt || null,
            deliverAlertFn,
            logger,
            now: Date.parse(observedAt),
          });
          if (alerted) {
            logger?.warn?.(
              `[watcher] no-progress lane: operator decision alert fired for ` +
                `${handler.repoPath}#${handler.prNumber} after ${outcome.noProgressTicks} ` +
                `unchanged tick(s) on head ${(handler.headSha || 'unknown').slice(0, 12)}`,
            );
          }
        } catch (err) {
          logger?.error?.(
            `[watcher] no-progress lane: operator decision alert delivery failed for ` +
              `${handler.repoPath}#${handler.prNumber} (${err?.message || err})`,
          );
        }
      }
      return outcome;
    },
  };
}

export async function runQueuedReviewAdoptionPhase({
  drainReviewerDispatchCandidates,
  postedReviewHandlers = [],
  postReviewMaintenanceHandlers = [],
  octokit,
  operatorSurface,
  // ARC-18: WATCHER_PRIMARY_DOMAIN_ID stays in watcher; threaded through to
  // syncPRLifecycle as the domain fallback. pollOnce passes it; the `null`
  // default is only reached by a caller that omits it (e.g. a test overriding
  // syncPRLifecycleImpl) and is not exercised in production.
  primaryDomainId = null,
  retryPendingMergeAgentLifecycleCleanupsImpl = retryPendingMergeAgentLifecycleCleanups,
  syncPRLifecycleImpl = syncPRLifecycle,
  retryPendingDagAutowalkOnMergeImpl = retryPendingDagAutowalkOnMerge,
  retryPendingTriageSyncsImpl = retryPendingTriageSyncs,
  retryPendingMergeCloseoutsImpl = retryPendingMergeCloseouts,
  retryPendingRetriggerAckCommentsImpl = retryPendingRetriggerAckComments,
  reportStalledRetriggerOutcomesImpl = reportStalledRetriggerOutcomes,
  retryPendingRetriggerReviewAckCommentsImpl = retryPendingRetriggerReviewAckComments,
  rootDir = ROOT,
  execFileImpl = execFileAsync,
  logger = console,
  // WPS-01 seams. Defaults reproduce production wiring; tests override them to
  // drive the budget/lane without a clock or a database.
  postedReviewFairness = postedReviewFairnessState,
  recoveryRoots = postedReviewStartupRecoveryRoots,
  postedReviewPhaseBudgetMs = resolvePostedReviewPhaseBudgetMs(),
  postedReviewReviewerPressurePhaseBudgetMs = resolvePostedReviewReviewerPressurePhaseBudgetMs(),
  postedReviewHandlerTimeoutMs = resolvePostedReviewHandlerTimeoutMs(),
  // Admission is a share of the fixed phase budget, not a child wait timeout.
  minimumHandlerStartBudgetMs = resolveNominalMergeAgentCoexistenceStepDeadlineMs(
    process.env,
    { handlerTimeoutMs: postedReviewHandlerTimeoutMs },
  ),
  noProgressLaneGate = createNoProgressLaneGate({ rootDir, logger }),
  preparePostedReviewHandlersImpl = preparePostedReviewHandlers,
  runPostedReviewHandlersFairlyImpl = runPostedReviewHandlersFairly,
  postedReviewPriorityTargets = [],
  sweepRereviewWakeQueueImpl = sweepRereviewWakeQueue,
  retryPendingCloserCancelsImpl = retryPendingCloserCancels,
  rereviewWakeBacklogImpl = rereviewWakeBacklog,
} = {}) {
  if (typeof drainReviewerDispatchCandidates !== 'function') {
    throw new TypeError('runQueuedReviewAdoptionPhase requires drainReviewerDispatchCandidates');
  }

  await retryPendingMergeAgentLifecycleCleanupsImpl();

  // Lifecycle sync is the authoritative "is this PR still open?" guard for the
  // health surface. It must not sit behind a single slow posted-review handler:
  // one 300s handler timeout was enough to leave the mirror stale for hours and
  // make queue-starvation/terminal-but-unmerged findings untrustworthy.
  await syncPRLifecycleImpl(octokit, operatorSurface, primaryDomainId);
  try {
    await retryPendingCloserCancelsImpl({ rootDir, logger });
  } catch (err) {
    logger.error?.('[watcher] AMA closer cancel drain failed; continuing adoption:', err?.message || err);
  }

  // Reviewer candidates were collected during the PR discovery sweep. Launch
  // them before the posted-review/hammer lane so a slow closer cannot hold every
  // first-pass or re-review claim until the tail of the tick.
  const reviewerDrainResult = await drainReviewerDispatchCandidates('posted-review handlers');
  const reviewerDispatchCount = Number(reviewerDrainResult?.dispatched || 0);
  const reviewerDeferredCount = Number(reviewerDrainResult?.deferred || 0);
  const reviewerPressure = reviewerDispatchCount > 0 || reviewerDeferredCount > 0;

  // RPL-04 backstop. The admission lane settles rereview wakes for the PRs it
  // visits; this sweep covers the ones it cannot reach — a PR that dropped out
  // of the open listing, a repo removed from the watch set, a request written
  // for a PR this watcher has never seen. Without it those records would sit in
  // the backlog until retention age and make the operator backlog number
  // meaningless.
  //
  // Placement is deliberate: AFTER the lifecycle sync above, so the mirrored
  // `pr_state` it classifies against is this tick's truth rather than the
  // previous tick's (a merged PR whose mirror still read 'open' would be held
  // instead of retired); and AFTER the reviewer drain, so a filesystem scan can
  // never sit in front of a reviewer launch. Bounded per tick and fail-open — a
  // sweep fault must never stop the adoption phase.
  try {
    const wakeSweep = sweepRereviewWakeQueueImpl({
      rootDir,
      lookupReviewRow: (repo, prNumber) => stmtGetReviewRow.get(repo, prNumber) || null,
      log: logger,
    });
    const backlog = rereviewWakeBacklogImpl({ rootDir });
    if (wakeSweep.scanned > 0 || backlog.pending > 0) {
      logger?.log?.(
        `[watcher] rereview-wake queue: pending=${backlog.pending} `
        + `unclaimed=${backlog.unclaimed} oldest_age_ms=${backlog.oldestAgeMs ?? 'none'} `
        + `swept=${wakeSweep.scanned} completed=${wakeSweep.completed} skipped=${wakeSweep.skipped} `
        + `held=${wakeSweep.held}`
      );
    }
  } catch (err) {
    logger?.error?.(`[watcher] rereview wake backlog sweep raised: ${err?.message || err}`);
  }
  const boundedReviewerPressurePhaseBudgetMs = reviewerPressure
    ? Math.min(
        postedReviewPhaseBudgetMs,
        postedReviewReviewerPressurePhaseBudgetMs < postedReviewPhaseBudgetMs
          ? enforcePostedReviewReviewerPressureBudgetFloor({
              pressureBudgetMs: postedReviewReviewerPressurePhaseBudgetMs,
              handlerTimeoutMs: postedReviewHandlerTimeoutMs,
              minimumHandlerStartBudgetMs,
              logger,
            })
          : postedReviewReviewerPressurePhaseBudgetMs,
      )
    : postedReviewPhaseBudgetMs;
  const effectivePostedReviewPhaseBudgetMs = reviewerPressure
    ? Math.min(postedReviewPhaseBudgetMs, boundedReviewerPressurePhaseBudgetMs)
    : postedReviewPhaseBudgetMs;
  if (reviewerPressure && effectivePostedReviewPhaseBudgetMs < postedReviewPhaseBudgetMs) {
    logger?.warn?.(
      `[watcher] posted-review phase budget capped under reviewer pressure: ` +
        `dispatched=${reviewerDispatchCount} deferred=${reviewerDeferredCount} ` +
        `budget_ms=${effectivePostedReviewPhaseBudgetMs} ` +
        `normal_budget_ms=${postedReviewPhaseBudgetMs}`,
    );
  }

  // WPS-01/RVHAND-01: this loop used to be unbounded — every queued handler, to
  // completion, every tick. When the queue filled with PRs that could not
  // advance, the tick stopped finishing and pollOnce never returned to phase 1,
  // so brand-new PRs were never discovered at all. The scheduler bounds the
  // phase (wall-clock budget + per-handler deadline) and consults the
  // no-progress lane, which is what stops the same unadvanceable set from
  // re-consuming the budget on every tick. It now runs after lifecycle sync, so
  // stale terminal rows are cleaned before any per-PR hammer path can wait.
  await promoteStarvedNoProgressLaneLedgers(rootDir, { logger });

  // Only the first adoption phase gets restart priority. Ordinary in-process
  // submissions also persist intent and must not masquerade as restarts.
  const pendingHammerTargets = recoveryRoots.has(rootDir) ? []
    : postedReviewHandlers.filter((handler) => readPendingAmaHammerDispatch(
      rootDir, { repo: handler.repoPath, prNumber: handler.prNumber, headSha: handler.headSha }, { logger },
    ));
  recoveryRoots.add(rootDir);
  for (const handler of pendingHammerTargets) {
    logger?.log?.(`[watcher] recovering pending AMA hammer dispatch for ${handler.repoPath}#${handler.prNumber}@${handler.headSha} through normal guards`);
  }

  const phaseStartedMs = Date.now();
  const preparedHandlers = await preparePostedReviewHandlersImpl(postedReviewHandlers, {
    rootDir, logger, execFileImpl, laneGate: noProgressLaneGate,
    deadlineAt: phaseStartedMs + Math.min(loadAwareTimeoutMs(30_000), effectivePostedReviewPhaseBudgetMs / 2),
  });
  const postedReviewSummary = await runPostedReviewHandlersFairlyImpl({
    handlers: preparedHandlers,
    phaseStartedMs,
    state: postedReviewFairness,
    budgetMs: effectivePostedReviewPhaseBudgetMs,
    handlerTimeoutMs: postedReviewHandlerTimeoutMs,
    minimumHandlerStartBudgetMs,
    laneGate: noProgressLaneGate,
    priorityTargets: [
      ...(Array.isArray(postedReviewPriorityTargets) ? postedReviewPriorityTargets
        : postedReviewPriorityTargets ? [postedReviewPriorityTargets] : []),
      ...pendingHammerTargets,
    ],
    logger,
  });

  try {
    logger?.log?.(JSON.stringify({ event: 'ama.final_review_to_hammer_launch.summary',
      merge_ready_handled: postedReviewSummary?.mergeReadyHandled || 0,
      ...finalReviewHammerLatencySummary() }));
  } catch { /* Telemetry cannot interrupt closure maintenance. */ }

  // TREC-01: drains the Linear triage syncs owed by terminal transitions. This
  // is what lets syncPRLifecycle record a merge/close immediately instead of
  // holding the row `pr_state=open` as the retry vehicle -- the behaviour that
  // made review:queue_starvation and review:terminal_but_unmerged fire forever
  // on already-terminal PRs.
  try {
    const triageDrain = await retryPendingTriageSyncsImpl({
      rootDir,
      operatorSurface,
      buildSubjectRef: buildTriageSubjectRef,
      logger,
    });
    if (triageDrain.attempted > 0) {
      logger.log(
        `[watcher] triage sync retry: attempted=${triageDrain.attempted} `
        + `synced=${triageDrain.synced} pending=${triageDrain.pending}`
      );
    }
  } catch (err) {
    logger.error('[watcher] triage sync retry failed:', err?.message || err);
  }
  await retryPendingDagAutowalkOnMergeImpl();
  await retryPendingMergeCloseoutsImpl({ octokit });

  try {
    const ackRetry = await retryPendingRetriggerAckCommentsImpl({
      rootDir,
      execFileImpl,
    });
    if (ackRetry.attempted > 0) {
      logger.log(
        `[watcher] retrigger-remediation ack retry: attempted=${ackRetry.attempted} posted=${ackRetry.posted}`
      );
    }
  } catch (err) {
    logger.error('[watcher] retrigger-remediation ack retry failed:', err?.message || err);
  }

  // REMCONFLICT-01: an accepted retrigger that has not started a worker within
  // the outcome timeout gets one comment naming the refusal.
  try {
    const outcomes = await reportStalledRetriggerOutcomesImpl({ rootDir, execFileImpl, logger });
    if (outcomes.checked > 0) {
      logger.log(
        `[watcher] retrigger-remediation outcome watch: checked=${outcomes.checked} `
        + `spawned=${outcomes.spawned} reported=${outcomes.reported}`
      );
    }
  } catch (err) {
    logger.error('[watcher] retrigger-remediation outcome watch failed:', err?.message || err);
  }

  try {
    const reviewAckRetry = await retryPendingRetriggerReviewAckCommentsImpl({
      rootDir,
      execFileImpl,
    });
    if (reviewAckRetry.attempted > 0) {
      logger.log(
        `[watcher] retrigger-review ack retry: attempted=${reviewAckRetry.attempted} posted=${reviewAckRetry.posted}`
      );
    }
  } catch (err) {
    logger.error('[watcher] retrigger-review ack retry failed:', err?.message || err);
  }

  for (const postReviewMaintenanceHandler of postReviewMaintenanceHandlers) {
    try {
      await postReviewMaintenanceHandler.run();
    } catch (err) {
      logger.error(
        `[watcher] post-review maintenance failed for ${postReviewMaintenanceHandler.repoPath}:`,
        err?.message || err
      );
    }
  }

}
